'use strict';

// En küçük OpenPGP imza doğrulayıcısı (RFC 4880, sürüm 4 imzalar, RSA anahtarlar). Yalnız tek bir işi yapar: yt-dlp'nin
// yayınladığı SHA2-256SUMS dosyasının, uygulamaya gömülü yt-dlp imza anahtarıyla (parmak izi sabit) imzalandığını
// denetlemek. Böylece motor güncellemesi hem imza hem sha256 ile doğrulanır. Dış kütüphane yoktur; RSA doğrulaması
// Node'un crypto modülüyle yapılır.

const crypto = require('crypto');

const HASHES = { 2: 'sha1', 8: 'sha256', 9: 'sha384', 10: 'sha512', 11: 'sha224' };

// ASCII zırhını çözer (-----BEGIN PGP … ----- … =CRC … -----END …)
function dearmor(text) {
  const s = String(text);
  if (!/-----BEGIN PGP/.test(s)) return Buffer.from(s, 'binary');
  const body = s.split(/\r?\n/);
  const start = body.findIndex((l) => /^-----BEGIN PGP/.test(l));
  let i = start + 1;
  while (i < body.length && body[i].trim() !== '') i++; // başlık satırları (Version: …)
  const b64 = [];
  for (i++; i < body.length; i++) {
    const l = body[i].trim();
    if (/^-----END PGP/.test(l) || l.startsWith('=')) break;
    b64.push(l);
  }
  return Buffer.from(b64.join(''), 'base64');
}

// Paketler: [{ tag, body }] (eski ve yeni biçim başlıkları)
function readPackets(buf) {
  const out = [];
  let p = 0;
  while (p < buf.length) {
    const ctb = buf[p++];
    if (!(ctb & 0x80)) throw new Error('bad_packet');
    let tag;
    let len;
    if (ctb & 0x40) {
      tag = ctb & 0x3f;
      const o = buf[p++];
      if (o < 192) len = o;
      else if (o < 224) len = ((o - 192) << 8) + buf[p++] + 192;
      else if (o === 255) { len = buf.readUInt32BE(p); p += 4; } else throw new Error('partial_length');
    } else {
      tag = (ctb >> 2) & 0x0f;
      const lt = ctb & 3;
      if (lt === 0) len = buf[p++];
      else if (lt === 1) { len = buf.readUInt16BE(p); p += 2; } else if (lt === 2) { len = buf.readUInt32BE(p); p += 4; } else len = buf.length - p;
    }
    if (p + len > buf.length) throw new Error('truncated');
    out.push({ tag, body: buf.subarray(p, p + len) });
    p += len;
  }
  return out;
}

function readMpi(buf, p) {
  const bits = buf.readUInt16BE(p);
  const n = Math.ceil(bits / 8);
  return { value: buf.subarray(p + 2, p + 2 + n), next: p + 2 + n };
}

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Açık anahtar ve alt anahtarlar (sürüm 4, RSA): [{ fingerprint, keyId, key: KeyObject, bits }]
function readPublicKeys(armored) {
  const keys = [];
  for (const pk of readPackets(dearmor(armored))) {
    if (pk.tag !== 6 && pk.tag !== 14) continue;
    const b = pk.body;
    if (b[0] !== 4) continue;
    const alg = b[5];
    if (alg !== 1 && alg !== 3) continue; // yalnız RSA
    const n = readMpi(b, 6);
    const e = readMpi(b, n.next);
    const head = Buffer.alloc(3);
    head[0] = 0x99;
    head.writeUInt16BE(b.length, 1);
    const fingerprint = crypto.createHash('sha1').update(head).update(b).digest('hex').toUpperCase();
    const key = crypto.createPublicKey({ key: { kty: 'RSA', n: b64url(n.value), e: b64url(e.value) }, format: 'jwk' });
    keys.push({ fingerprint, keyId: fingerprint.slice(-16), key, bits: n.value.length * 8, primary: pk.tag === 6 });
  }
  return keys;
}

function readSignature(sigBuf) {
  const pk = readPackets(Buffer.isBuffer(sigBuf) ? (sigBuf[0] === 0x2d ? dearmor(sigBuf.toString('utf8')) : sigBuf) : dearmor(sigBuf)).find((x) => x.tag === 2);
  if (!pk) throw new Error('no_signature');
  const b = pk.body;
  if (b[0] !== 4) throw new Error('unsupported_version');
  const sigType = b[1];
  const pubAlg = b[2];
  const hashAlg = b[3];
  const hashedLen = b.readUInt16BE(4);
  const hashedEnd = 6 + hashedLen;
  const unhashedLen = b.readUInt16BE(hashedEnd);
  const unhashedEnd = hashedEnd + 2 + unhashedLen;
  // Alt paketlerden veren anahtar (33: parmak izi, 16: anahtar kimliği)
  const issuers = [];
  const scan = (from, to) => {
    let p = from;
    while (p < to) {
      let len = b[p++];
      if (len >= 192 && len < 255) { len = ((len - 192) << 8) + b[p++] + 192; } else if (len === 255) { len = b.readUInt32BE(p); p += 4; }
      const type = b[p] & 0x7f;
      const data = b.subarray(p + 1, p + len);
      if (type === 33 && data[0] === 4) issuers.push(data.subarray(1).toString('hex').toUpperCase());
      if (type === 16) issuers.push(data.toString('hex').toUpperCase());
      p += len;
    }
  };
  scan(6, hashedEnd);
  scan(hashedEnd + 2, unhashedEnd);
  const left16 = b.subarray(unhashedEnd, unhashedEnd + 2);
  const mpi = readMpi(b, unhashedEnd + 2).value;
  return { sigType, pubAlg, hashAlg, hashed: b.subarray(0, hashedEnd), issuers, left16, mpi };
}

// data imzası geçerli mi? fingerprint verilirse yalnız o anahtar (ya da onun alt anahtarı) kabul edilir.
function verifyDetached(data, sigBuf, armoredKey, { fingerprint } = {}) {
  const sig = readSignature(sigBuf);
  const hash = HASHES[sig.hashAlg];
  if (!hash || hash === 'sha1') return { ok: false, code: 'weak_hash' };
  if (sig.sigType !== 0x00 && sig.sigType !== 0x01) return { ok: false, code: 'bad_sig_type' };
  if (sig.pubAlg !== 1 && sig.pubAlg !== 3) return { ok: false, code: 'unsupported_alg' };
  const keys = readPublicKeys(armoredKey);
  if (fingerprint && !keys.some((k) => k.primary && k.fingerprint === fingerprint.toUpperCase().replace(/\s+/g, ''))) return { ok: false, code: 'wrong_key' };
  const cands = keys.filter((k) => sig.issuers.some((i) => k.fingerprint.endsWith(i)));
  const pool = cands.length ? cands : keys;
  // Metin imzası (0x01) satır sonlarını CRLF'ye çevirerek hesaplanır
  const doc = sig.sigType === 0x01 ? Buffer.from(Buffer.from(data).toString('utf8').replace(/\r?\n/g, '\r\n'), 'utf8') : Buffer.from(data);
  const trailer = Buffer.alloc(6);
  trailer[0] = 0x04; trailer[1] = 0xff;
  trailer.writeUInt32BE(sig.hashed.length, 2);
  const signed = Buffer.concat([doc, sig.hashed, trailer]);
  const digest = crypto.createHash(hash).update(signed).digest();
  if (!digest.subarray(0, 2).equals(sig.left16)) return { ok: false, code: 'bad_signature' };
  for (const k of pool) {
    const len = Math.ceil(k.bits / 8);
    const s = sig.mpi.length < len ? Buffer.concat([Buffer.alloc(len - sig.mpi.length), sig.mpi]) : sig.mpi;
    if (crypto.verify(hash, signed, { key: k.key, padding: crypto.constants.RSA_PKCS1_PADDING }, s)) return { ok: true, fingerprint: k.fingerprint };
  }
  return { ok: false, code: 'bad_signature' };
}

module.exports = { dearmor, readPackets, readPublicKeys, readSignature, verifyDetached };
