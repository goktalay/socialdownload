'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

// Bellek içi kimlik deposu (@napi-rs/keyring Entry ile aynı arayüz)
function memoryKeyring() {
  let value = null;
  return { get: () => value, set: (v) => { value = String(v); }, del: () => { value = null; }, peek: () => value };
}

function tmpDir(prefix = 'sd-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

// Sahte süreç başlatıcı: her çağrıda script(args) → { stdout: [satır], stderr: [satır], code, delay, hang } döner.
// hang: süreç kendiliğinden bitmez (kill ile biter) — duraklat/iptal sınamaları için.
function fakeSpawn(script) {
  const calls = [];
  const spawn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4242 + calls.length;
    child.exitCode = null;
    const plan = script(args, bin) || {};
    calls.push({ bin, args, env: opts && opts.env, child });
    let killed = false;
    child.kill = () => {
      if (killed || child.exitCode !== null) return;
      killed = true;
      setTimeout(() => { child.stdout.end(); child.stderr.end(); child.exitCode = 1; child.emit('close', null, 'SIGTERM'); }, 2);
    };
    const lines = [...(plan.stdout || []).map((l) => ['out', l]), ...(plan.stderr || []).map((l) => ['err', l])];
    let i = 0;
    const step = () => {
      if (killed) return;
      if (i < lines.length) {
        const [ch, l] = lines[i++];
        (ch === 'out' ? child.stdout : child.stderr).write(l + '\n');
        setTimeout(step, plan.delay || 1);
        return;
      }
      if (plan.hang) return;
      if (plan.json !== undefined) child.stdout.write(typeof plan.json === 'string' ? plan.json : JSON.stringify(plan.json));
      if (plan.onExit) plan.onExit();
      child.stdout.end();
      child.stderr.end();
      child.exitCode = plan.code || 0;
      setTimeout(() => child.emit('close', plan.code || 0), 1);
    };
    setTimeout(step, 1);
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

// --- Test imzacısı: kendi RSA anahtarımızla v4 OpenPGP açık anahtar + ayrık imza (src/openpgp.js doğrulaması için) ---
function mpi(buf) {
  let b = Buffer.from(buf);
  while (b.length > 1 && b[0] === 0) b = b.subarray(1);
  const bits = (b.length - 1) * 8 + (32 - Math.clz32(b[0]));
  const h = Buffer.alloc(2);
  h.writeUInt16BE(bits);
  return Buffer.concat([h, b]);
}
function packet(tag, body) {
  // yeni biçim, 2 baytlık uzunluk (192–8383) ya da 5 baytlık
  const len = body.length;
  let head;
  if (len < 192) head = Buffer.from([0xc0 | tag, len]);
  else if (len < 8384) head = Buffer.from([0xc0 | tag, ((len - 192) >> 8) + 192, (len - 192) & 0xff]);
  else { head = Buffer.alloc(6); head[0] = 0xc0 | tag; head[1] = 255; head.writeUInt32BE(len, 2); }
  return Buffer.concat([head, body]);
}
function testSigner() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const n = Buffer.from(jwk.n, 'base64url');
  const e = Buffer.from(jwk.e, 'base64url');
  const body = Buffer.concat([Buffer.from([4]), Buffer.from([0, 0, 0, 0]), Buffer.from([1]), mpi(n), mpi(e)]);
  const fh = Buffer.alloc(3);
  fh[0] = 0x99;
  fh.writeUInt16BE(body.length, 1);
  const fpr = crypto.createHash('sha1').update(fh).update(body).digest();
  const armored = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${packet(6, body).toString('base64').replace(/.{64}/g, '$&\n')}\n-----END PGP PUBLIC KEY BLOCK-----\n`;
  function sign(data) {
    const sub33 = Buffer.concat([Buffer.from([22, 33, 4]), fpr]);
    const sub2 = Buffer.from([5, 2, 0, 0, 0, 1]);
    const hashedSub = Buffer.concat([sub33, sub2]);
    const hl = Buffer.alloc(2);
    hl.writeUInt16BE(hashedSub.length);
    const hashed = Buffer.concat([Buffer.from([4, 0x00, 1, 10]), hl, hashedSub]);
    const trailer = Buffer.alloc(6);
    trailer[0] = 4; trailer[1] = 0xff;
    trailer.writeUInt32BE(hashed.length, 2);
    const signed = Buffer.concat([Buffer.from(data), hashed, trailer]);
    const digest = crypto.createHash('sha512').update(signed).digest();
    const s = crypto.sign('sha512', signed, { key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING });
    const unhashed = Buffer.from([0, 0]);
    return packet(2, Buffer.concat([hashed, unhashed, digest.subarray(0, 2), mpi(s)]));
  }
  return { armored, fingerprint: fpr.toString('hex').toUpperCase(), sign };
}

// fetch taklidi: { url: Buffer|object|status }
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) return { ok: false, status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    if (typeof r === 'number') return { ok: false, status: r, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) };
    const buf = Buffer.isBuffer(r) ? r : Buffer.from(typeof r === 'string' ? r : JSON.stringify(r));
    return { ok: true, status: 200, headers: { get: (h) => (h === 'content-length' ? String(buf.length) : null) }, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) };
  };
  fn.calls = calls;
  return fn;
}

module.exports = { memoryKeyring, tmpDir, fixture, fakeSpawn, testSigner, fakeFetch };
