'use strict';

// Motor dosyaları: uygulamayla gelen yt-dlp + ffmpeg (resources/engine) ve uygulama içinden güncellenen yt-dlp
// (userData/engine). Siteler sık değiştiği için yt-dlp kullanıcı tarafından "Motoru güncelle" ile yenilenebilir:
//   1. GitHub'daki yt-dlp/yt-dlp son sürümünün etiketi okunur (yalnız bu depo, yalnız https).
//   2. SHA2-256SUMS ve SHA2-256SUMS.sig indirilir; imza, uygulamaya gömülü yt-dlp imza anahtarıyla (parmak izi
//      AC0CBBE6848D6A873464AF4E57CF65933B5A7581) doğrulanır — doğrulanmazsa güncelleme yapılmaz.
//   3. İkili indirilir, sha256'sı imzalı listedekiyle karşılaştırılır; ardından "--version" çalıştırılıp sürüm etiketle
//      aynı mı denetlenir; ancak bundan sonra eskisinin yerine konur (eski kopya .old olarak bir sürüm saklanır).
// ffmpeg uygulamayla birlikte güncellenir (uygulama sürümü); uygulama içinden indirilmez.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PGP = require('./openpgp');

const YTDLP_REPO = 'yt-dlp/yt-dlp';
const SIGNING_FPR = 'AC0CBBE6848D6A873464AF4E57CF65933B5A7581';
const SIGNING_KEY_FILE = path.join(__dirname, 'keys', 'yt-dlp-signing-key.asc');
const MAX_BIN_BYTES = 120 * 1024 * 1024;
const TAG_RE = /^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$/;

const exe = (name, platform = process.platform) => (platform === 'win32' ? `${name}.exe` : name);
// yt-dlp sürüm listesindeki ikili adı (Windows x64 / Linux x64 / macOS)
const assetName = (platform = process.platform) => (platform === 'win32' ? 'yt-dlp.exe' : platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux');

// "2026.10.21" ↔ "2026.10.21.1" karşılaştırması
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}

// "sha256  dosya" satırları → { dosya: sha256 }
function parseSums(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(\S.*)$/i.exec(line.trim());
    if (m) out[m[2].trim()] = m[1].toLowerCase();
  }
  return out;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function createEngineFiles(deps) {
  // deps: { resourcesDir: string|null (paketli: process.resourcesPath/engine), userDir, platform?, env?, fetch?, run(bin,args)→Promise<string>,
  //         signingKey?, signingFpr? (yalnız testler: kendi anahtarlarıyla imzalı sahte sürüm) }
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const userEngine = path.join(deps.userDir, 'engine');
  const stateFile = path.join(userEngine, 'engine.json');
  const bundledInfo = () => {
    try { return JSON.parse(fs.readFileSync(path.join(deps.resourcesDir, 'engine.json'), 'utf8')); } catch { return {}; }
  };
  const userState = () => {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
  };
  const exists = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

  // Geliştirmede/Linux'ta ortam değişkenleri (SD_YTDLP, SD_FFMPEG_DIR) paketli dosyaların yerine geçer
  function bundledYtdlp() {
    if (env.SD_YTDLP && exists(env.SD_YTDLP)) return env.SD_YTDLP;
    const p = deps.resourcesDir && path.join(deps.resourcesDir, exe('yt-dlp', platform));
    return p && exists(p) ? p : null;
  }

  function ytdlpPath() {
    const u = path.join(userEngine, exe('yt-dlp', platform));
    const st = userState();
    const b = bundledYtdlp();
    // Güncellenmiş kopya yalnız paketli sürümden yeniyse kullanılır (uygulama güncellenince paketli yeni olabilir)
    if (exists(u) && st.version && (!b || compareVersions(st.version, bundledInfo().ytdlp || '0') > 0)) return u;
    return b;
  }

  function ffmpegDir() {
    if (env.SD_FFMPEG_DIR && exists(path.join(env.SD_FFMPEG_DIR, exe('ffmpeg', platform)))) return env.SD_FFMPEG_DIR;
    const d = deps.resourcesDir && path.join(deps.resourcesDir, 'ffmpeg');
    return d && exists(path.join(d, exe('ffmpeg', platform))) ? d : null;
  }

  function info() {
    const st = userState();
    const b = bundledInfo();
    const p = ytdlpPath();
    const updated = !!(p && p.startsWith(userEngine));
    return {
      ytdlpPath: p, ytdlpVersion: updated ? st.version : b.ytdlp || null, updated, updatedAt: updated ? st.installedAt || null : null,
      bundledYtdlp: b.ytdlp || null, ffmpegDir: ffmpegDir(), ffmpegVersion: b.ffmpeg || null, lastCheck: st.lastCheck || null, latest: st.latest || null,
    };
  }

  function writeState(patch) {
    fs.mkdirSync(userEngine, { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...userState(), ...patch }, null, 2));
  }

  const doFetch = deps.fetch || ((u, o) => fetch(u, o));
  async function get(url, { json = false, max = 1024 * 1024, timeout = 60000 } = {}) {
    if (!/^https:\/\/(?:api\.github\.com\/repos\/yt-dlp\/yt-dlp\/|github\.com\/yt-dlp\/yt-dlp\/releases\/download\/)/.test(url)) {
      throw Object.assign(new Error('blocked_url'), { code: 'blocked_url' });
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await doFetch(url, { headers: { 'User-Agent': 'SocialDownload (Mastertool)', Accept: json ? 'application/vnd.github+json' : '*/*' }, signal: ctl.signal, redirect: 'follow' });
      if (!res.ok) throw Object.assign(new Error(`http_${res.status}`), { code: res.status === 403 || res.status === 429 ? 'rate_limited' : 'http_error' });
      const len = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
      if (len > max) throw Object.assign(new Error('too_large'), { code: 'too_large' });
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > max) throw Object.assign(new Error('too_large'), { code: 'too_large' });
      return json ? JSON.parse(buf.toString('utf8')) : buf;
    } catch (e) {
      if (e.code) throw e;
      throw Object.assign(new Error(e.message), { code: 'offline' });
    } finally {
      clearTimeout(timer);
    }
  }

  // Son sürüm etiketi (ağ): { latest, current, newer }
  async function check() {
    const rel = await get(`https://api.github.com/repos/${YTDLP_REPO}/releases/latest`, { json: true });
    const tag = String((rel && rel.tag_name) || '');
    if (!TAG_RE.test(tag)) throw Object.assign(new Error('bad_tag'), { code: 'bad_tag' });
    const current = info().ytdlpVersion;
    writeState({ lastCheck: Date.now(), latest: tag });
    return { latest: tag, current, newer: !current || compareVersions(tag, current) > 0 };
  }

  // İmza + sha256 doğrulamalı güncelleme. onStep('check'|'signature'|'download'|'verify'|'install')
  async function update({ onStep = () => {}, force = false } = {}) {
    onStep('check');
    const c = await check();
    if (!c.newer && !force) return { ok: true, updated: false, version: c.current };
    const base = `https://github.com/${YTDLP_REPO}/releases/download/${c.latest}`;
    onStep('signature');
    const sums = await get(`${base}/SHA2-256SUMS`, { max: 64 * 1024 });
    const sig = await get(`${base}/SHA2-256SUMS.sig`, { max: 16 * 1024 });
    const v = PGP.verifyDetached(sums, sig, deps.signingKey || fs.readFileSync(SIGNING_KEY_FILE, 'utf8'), { fingerprint: deps.signingFpr || SIGNING_FPR });
    if (!v.ok) throw Object.assign(new Error(`signature ${v.code}`), { code: 'bad_signature' });
    const want = parseSums(sums.toString('utf8'))[assetName(platform)];
    if (!want) throw Object.assign(new Error('asset missing'), { code: 'asset_missing' });
    onStep('download');
    const bin = await get(`${base}/${assetName(platform)}`, { max: MAX_BIN_BYTES, timeout: 10 * 60 * 1000 });
    onStep('verify');
    if (sha256(bin) !== want) throw Object.assign(new Error('sha256 mismatch'), { code: 'bad_checksum' });
    fs.mkdirSync(userEngine, { recursive: true });
    const target = path.join(userEngine, exe('yt-dlp', platform));
    const tmp = path.join(userEngine, exe('yt-dlp.new', platform));
    fs.writeFileSync(tmp, bin, { mode: 0o755 });
    let ver = '';
    try { ver = String(await deps.run(tmp, ['--version'])).trim().split(/\s+/)[0]; } catch (e) { ver = ''; }
    if (ver !== c.latest) { try { fs.unlinkSync(tmp); } catch { /* yok */ } throw Object.assign(new Error(`version ${ver}`), { code: 'bad_binary' }); }
    onStep('install');
    if (exists(target)) { try { fs.renameSync(target, path.join(userEngine, exe('yt-dlp.old', platform))); } catch { /* kullanımda */ } }
    fs.renameSync(tmp, target);
    writeState({ version: c.latest, installedAt: Date.now(), sha256: want });
    return { ok: true, updated: true, version: c.latest };
  }

  // Uygulamayla gelen motora dön
  function reset() {
    for (const n of [exe('yt-dlp', platform), exe('yt-dlp.old', platform), exe('yt-dlp.new', platform)]) { try { fs.unlinkSync(path.join(userEngine, n)); } catch { /* yok */ } }
    writeState({ version: null, installedAt: null, sha256: null });
    return info();
  }

  return { ytdlpPath, ffmpegDir, info, check, update, reset };
}

module.exports = { createEngineFiles, compareVersions, parseSums, assetName, sha256, SIGNING_FPR, SIGNING_KEY_FILE, TAG_RE };
