// Motoru (yt-dlp + ffmpeg) resmi sürümlerden indirir, doğrular ve uygulamaya gömülecek klasöre koyar:
//   vendor/engine/<hedef>/yt-dlp(.exe), ffmpeg/{ffmpeg,ffprobe}(.exe) + paylaşılan kitaplıklar, licenses/, engine.json
// İndirilenler önce boş bir indirme klasörüne (vendor/engine/download-<hedef>) alınır; sha256 eşleşmeyen dosya kullanılmaz.
//   - yt-dlp: SHA2-256SUMS dosyasının imzası gömülü yt-dlp anahtarıyla doğrulanır, ikilinin sha256'sı hem bu listeyle
//     hem scripts/engine-manifest.json'daki sabit değerle karşılaştırılır.
//   - ffmpeg: manifestteki sabit sha256. Sabit derleme yayıncıdan kaldırılmışsa (BtbN günlük derlemeleri bir süre sonra
//     siler) aynı dalın "latest" derlemesi alınır ve yayıncının checksums.sha256 dosyasıyla doğrulanır (uyarı yazılır).
// Kullanım: node scripts/fetch-engine.js [win64|linux64]   (varsayılan win64)
//           node scripts/fetch-engine.js --pin              (manifesti son sürümlere günceller; imza/sha doğrulamalı)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const PGP = require('../src/openpgp');
const { parseSums, SIGNING_FPR, SIGNING_KEY_FILE } = require('../src/engine');

const ROOT = path.join(__dirname, '..');
const MANIFEST = path.join(__dirname, 'engine-manifest.json');
const man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const args = process.argv.slice(2);
const PIN = args.includes('--pin');
const TARGET = args.find((a) => a === 'win64' || a === 'linux64') || 'win64';
const OUT = path.join(ROOT, 'vendor', 'engine', TARGET);
const DL = path.join(ROOT, 'vendor', 'engine', `download-${TARGET}`);
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function get(url, { max = 400 * 1024 * 1024, json = false } = {}) {
  if (!/^https:\/\/(?:github\.com|api\.github\.com|raw\.githubusercontent\.com)\//.test(url)) throw new Error(`izin verilmeyen adres: ${url}`);
  const headers = { 'User-Agent': 'socialdownload-build' };
  if (process.env.GITHUB_TOKEN && /api\.github\.com/.test(url)) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}: ${url}`); e.status = res.status; throw e; }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > max) throw new Error(`çok büyük: ${url}`);
  return json ? JSON.parse(buf.toString('utf8')) : buf;
}

async function verifiedYtdlpSums(version) {
  const base = `https://github.com/${man.ytdlp.repo}/releases/download/${version}`;
  const sums = await get(`${base}/SHA2-256SUMS`);
  const sig = await get(`${base}/SHA2-256SUMS.sig`);
  const v = PGP.verifyDetached(sums, sig, fs.readFileSync(SIGNING_KEY_FILE, 'utf8'), { fingerprint: SIGNING_FPR });
  if (!v.ok) throw new Error(`yt-dlp SHA2-256SUMS imzası doğrulanamadı (${v.code})`);
  return parseSums(sums.toString('utf8'));
}

async function fetchYtdlp() {
  const a = man.ytdlp.assets[TARGET];
  const base = `https://github.com/${man.ytdlp.repo}/releases/download/${man.ytdlp.version}`;
  const sums = await verifiedYtdlpSums(man.ytdlp.version);
  if (sums[a.name] !== a.sha256) throw new Error(`yt-dlp: imzalı listedeki sha256 manifestle uyuşmuyor (${a.name})`);
  const bin = await get(`${base}/${a.name}`);
  fs.writeFileSync(path.join(DL, a.name), bin);
  if (sha256(bin) !== a.sha256) throw new Error(`yt-dlp: sha256 uyuşmuyor (${a.name})`);
  const name = TARGET === 'win64' ? 'yt-dlp.exe' : 'yt-dlp';
  fs.writeFileSync(path.join(OUT, name), bin, { mode: 0o755 });
  // Lisans: yt-dlp Unlicense; tek dosyalı ikilinin içindeki üçüncü taraf bileşenlerin lisansları ayrıca
  const raw = `https://raw.githubusercontent.com/${man.ytdlp.repo}/${man.ytdlp.version}`;
  fs.writeFileSync(path.join(OUT, 'licenses', 'yt-dlp-LICENSE.txt'), await get(`${raw}/LICENSE`, { max: 1024 * 1024 }));
  try { fs.writeFileSync(path.join(OUT, 'licenses', 'yt-dlp-THIRD_PARTY_LICENSES.txt'), await get(`${raw}/THIRD_PARTY_LICENSES.txt`, { max: 4 * 1024 * 1024 })); } catch { /* eski sürümlerde yok */ }
  console.log(`✓ yt-dlp ${man.ytdlp.version} (${a.name}, imza + sha256)`);
}

async function fetchFfmpeg() {
  const a = man.ffmpeg.assets[TARGET];
  let file = a.name;
  let buf;
  try {
    buf = await get(`https://github.com/${man.ffmpeg.repo}/releases/download/${man.ffmpeg.tag}/${a.name}`);
    if (sha256(buf) !== a.sha256) throw new Error(`ffmpeg: sha256 uyuşmuyor (${a.name})`);
    console.log(`✓ ffmpeg ${man.ffmpeg.version} (${a.name}, sabit sha256)`);
  } catch (e) {
    if (e.status !== 404) throw e;
    // Sabit derleme kaldırılmış: aynı dalın son derlemesi, yayıncının özet dosyasıyla
    console.warn(`! ${man.ffmpeg.tag} artık yok; ${a.fallback} yayıncının checksums.sha256 dosyasıyla doğrulanarak alınıyor (manifesti "npm run engine:pin" ile güncelleyin)`);
    const base = `https://github.com/${man.ffmpeg.repo}/releases/download/latest`;
    const sums = parseSums((await get(`${base}/checksums.sha256`)).toString('utf8'));
    file = a.fallback;
    buf = await get(`${base}/${file}`);
    if (!sums[file] || sums[file] !== sha256(buf)) throw new Error(`ffmpeg: sha256 uyuşmuyor (${file})`);
  }
  const archive = path.join(DL, file);
  fs.writeFileSync(archive, buf);
  const dest = path.join(OUT, 'ffmpeg');
  fs.mkdirSync(dest, { recursive: true });
  if (file.endsWith('.zip')) {
    const { unzipSync } = require('fflate');
    // Yalnız bin/ altındaki ffmpeg, ffprobe ve DLL'ler + lisans; ffplay, başlık/kitaplık geliştirme dosyaları alınmaz
    const files = unzipSync(new Uint8Array(buf), { filter: (f) => /\/bin\/(?:ffmpeg\.exe|ffprobe\.exe|[\w.-]+\.dll)$|\/LICENSE\.txt$/i.test(f.name) });
    for (const [name, data] of Object.entries(files)) {
      const base = path.basename(name);
      fs.writeFileSync(base === 'LICENSE.txt' ? path.join(OUT, 'licenses', 'ffmpeg-LICENSE.txt') : path.join(dest, base), Buffer.from(data));
    }
  } else {
    const tmp = path.join(DL, 'x');
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    execFileSync('tar', ['-xJf', archive, '-C', tmp]);
    const top = path.join(tmp, fs.readdirSync(tmp)[0]);
    for (const n of ['ffmpeg', 'ffprobe']) fs.copyFileSync(path.join(top, 'bin', n), path.join(dest, n));
    fs.cpSync(path.join(top, 'lib'), path.join(OUT, 'lib'), { recursive: true, verbatimSymlinks: true, filter: (s) => !/\/(?:pkgconfig|cmake)(?:\/|$)|\.a$/.test(s) });
    fs.copyFileSync(path.join(top, 'LICENSE.txt'), path.join(OUT, 'licenses', 'ffmpeg-LICENSE.txt'));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(OUT, 'licenses', 'ffmpeg-SOURCE.txt'),
    `FFmpeg ${man.ffmpeg.version} — LGPL-2.1-or-later derlemesi (${man.ffmpeg.repo}, ${file}).\n` +
    `Kaynak kodu / source code: ${man.ffmpeg.source}\nDerleme betikleri / build scripts: https://github.com/${man.ffmpeg.repo}\n` +
    'FFmpeg paylaşılan kitaplıklar (DLL) olarak dağıtılır; kitaplıkları kendi derlemenizle değiştirebilirsiniz.\n' +
    'FFmpeg is distributed as shared libraries (DLLs) under the LGPL; you may replace them with your own build.\n');
  const exeName = TARGET === 'win64' ? 'ffmpeg.exe' : 'ffmpeg';
  if (!fs.existsSync(path.join(dest, exeName))) throw new Error('ffmpeg arşivinde beklenen dosyalar yok');
  return file;
}

async function pin() {
  // yt-dlp: son sürüm, imzalı özet listesinden sha256'lar
  const rel = await get(`https://api.github.com/repos/${man.ytdlp.repo}/releases/latest`, { json: true });
  const sums = await verifiedYtdlpSums(rel.tag_name);
  man.ytdlp.version = rel.tag_name;
  for (const t of Object.keys(man.ytdlp.assets)) man.ytdlp.assets[t].sha256 = sums[man.ytdlp.assets[t].name];
  // ffmpeg: aynı ana daldaki (n9.0) en yeni günlük derleme; sha256 yayıncının özet dosyasından + indirip hesaplayarak
  const list = await get(`https://api.github.com/repos/${man.ffmpeg.repo}/releases?per_page=5`, { json: true });
  const branch = /-(\d+\.\d+)\.(?:zip|tar\.xz)$/.exec(man.ffmpeg.assets.win64.name)[1];
  const r = list.find((x) => x.tag_name.startsWith('autobuild-') && x.assets.some((y) => y.name.endsWith(`-win64-lgpl-shared-${branch}.zip`)));
  const csum = parseSums((await get(`https://github.com/${man.ffmpeg.repo}/releases/download/${r.tag_name}/checksums.sha256`)).toString('utf8'));
  man.ffmpeg.tag = r.tag_name;
  for (const t of Object.keys(man.ffmpeg.assets)) {
    const re = new RegExp(`-${t}-lgpl-shared-${branch.replace('.', '\\.')}\\.(?:zip|tar\\.xz)$`);
    const asset = r.assets.find((y) => re.test(y.name));
    man.ffmpeg.assets[t].name = asset.name;
    man.ffmpeg.assets[t].sha256 = csum[asset.name];
  }
  const ver = /^ffmpeg-(n[\d.]+-\d+-g([0-9a-f]+))-/.exec(man.ffmpeg.assets.win64.name);
  man.ffmpeg.version = ver[1];
  man.ffmpeg.source = `https://github.com/FFmpeg/FFmpeg/tree/${ver[2]}`;
  fs.writeFileSync(MANIFEST, JSON.stringify(man, null, 2) + '\n');
  console.log(`manifest: yt-dlp ${man.ytdlp.version}, ffmpeg ${man.ffmpeg.version} (${man.ffmpeg.tag})`);
}

(async () => {
  if (PIN) return pin();
  fs.rmSync(DL, { recursive: true, force: true });
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(DL, { recursive: true });
  fs.mkdirSync(path.join(OUT, 'licenses'), { recursive: true });
  await fetchYtdlp();
  const ffFile = await fetchFfmpeg();
  fs.writeFileSync(path.join(OUT, 'engine.json'), JSON.stringify({ ytdlp: man.ytdlp.version, ffmpeg: man.ffmpeg.version, ffmpegAsset: ffFile, target: TARGET, fetchedAt: new Date().toISOString() }, null, 2));
  fs.rmSync(DL, { recursive: true, force: true });
  console.log(`motor hazır: ${path.relative(ROOT, OUT)}`);
})().catch((e) => { console.error('×', e.message); process.exit(1); });
