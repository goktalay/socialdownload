// Uçtan uca: gerçek Electron ana süreciyle uygulamayı çalıştırır. Sahte bir hesap sunucusu (/api/sd: prelogin, login, me,
// library, releases) girişi karşılar; giriş penceresine CDP üzerinden e-posta / şifre yazılır, hukuki uyarı onaylanır,
// bağlantı çubuğuna bağlantı yapıştırılıp analiz edilir, en düşük çözünürlük seçilip kuyruğa alınır ve indirme bitene dek
// izlenir; duraklat / sürdür, DRM reddi ve sayfa hataları denetlenir, ekran görüntüleri alınır.
// Motor: vendor/engine/linux64 (npm run engine:linux) ya da SD_YTDLP / SD_FFMPEG_DIR. Ağ gerekir.
// Kullanım: DISPLAY=:93 node scripts/e2e-electron.js [bağlantı]
//   varsayılan bağlantı: Big Buck Bunny (Blender Foundation, CC BY 3.0)
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const URL_ = process.argv[2] || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
const OUT = path.join(os.tmpdir(), 'sd-e2e');

const KDF = { alg: 'PBKDF2-SHA256', iter: 1000, salt: crypto.randomBytes(16).toString('base64') };
let library = null;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    const send = (s, j) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(j)); };
    const u = req.url.split('?')[0];
    if (u === '/api/sd/auth/prelogin') return send(200, { kdf: KDF });
    if (u === '/api/sd/auth/login') return send(200, { token: 'e2e-token', user: { id: 1, email: body.email, name: 'E2E' }, sync_enabled: true, kdf: KDF });
    if (u === '/api/sd/me') return send(200, { user: { id: 1, email: 'e2e@example.com' }, sync_enabled: true, kdf: KDF });
    if (u === '/api/sd/library' && req.method === 'GET') return send(200, library || { version: null });
    if (u === '/api/sd/library' && req.method === 'PUT') { library = { version: (library?.version || 0) + 1, blob: body.blob }; return send(200, { version: library.version }); }
    if (u === '/api/sd/releases/latest') return send(200, { version: '1.0.0' });
    if (u === '/api/sd/auth/sso') return send(401, { code: 'sso_invalid' });
    return send(404, { code: 'not_found' });
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${server.address().port}`;
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-e2e-ud-'));
  fs.rmSync(OUT, { recursive: true, force: true });
  // İndirme klasörü baştan: ayar dosyası ilk açılışta yazılır
  fs.writeFileSync(path.join(ud, 'store.json'), JSON.stringify({ settings: { downloadDir: OUT, language: process.env.SD_LANG || 'tr', checkEngine: false } }));
  const port = 9300 + Math.floor(Math.random() * 600);
  const cmd = path.join(ROOT, 'node_modules', '.bin', 'electron');
  const proc = spawn(cmd, [ROOT, `--user-data-dir=${ud}`, `--remote-debugging-port=${port}`, '--no-sandbox'], { env: { ...process.env, SD_API: api }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  const fail = (m) => { console.error('×', m); console.error(log.split('\n').filter((l) => !/bus\.cc|viz_main|gles2_cmd|GroupMarker|dbus/.test(l)).slice(-25).join('\n')); proc.kill(); server.close(); process.exit(1); };
  let browser = null;
  for (let i = 0; i < 60 && !browser; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { /* henüz yok */ }
  }
  if (!browser) fail('CDP bağlanamadı');
  const findPage = async (re, ms = 30000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      for (const c of browser.contexts()) for (const p of c.pages()) if (re.test(p.url())) return p;
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  };
  const ok = (m) => console.log('✓', m);
  const login = await findPage(/login\.html$/);
  if (!login) fail('giriş penceresi açılmadı');
  ok(`giriş penceresi: ${path.basename(login.url())}`);
  await login.fill('#email', 'e2e@example.com');
  await login.fill('#password', 'Test1234!');
  await login.click('#submit');
  const main = await findPage(/index\.html$/);
  if (!main) fail('ana pencere açılmadı');
  const errors = [];
  main.on('pageerror', (e) => errors.push(e.message));
  main.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await main.setViewportSize({ width: 1400, height: 900 }).catch(() => {});
  ok('ana pencere açıldı');

  // Hukuki uyarı
  await main.waitForSelector('.modal .notice-body', { timeout: 10000 }).catch(() => fail('hukuki uyarı gösterilmedi'));
  ok(`uyarı: ${(await main.textContent('.modal .notice-body b')).slice(0, 60)}…`);
  await main.click('.modal footer .btn.primary');
  await main.waitForSelector('.modal-backdrop', { state: 'detached' });

  // DRM servisi analiz edilmeden reddedilir
  await main.fill('#url', 'https://www.netflix.com/watch/80100172');
  await main.click('#btnAnalyze');
  await main.waitForSelector('.toast.err', { timeout: 5000 }).catch(() => fail('DRM uyarısı yok'));
  ok(`DRM reddi: ${(await main.textContent('.toast.err .t-title')).slice(0, 70)}…`);

  // Analiz (gerçek motor + ağ)
  await main.fill('#url', URL_);
  const t0 = Date.now();
  await main.click('#btnAnalyze');
  await main.waitForSelector('.media h3, .a-error', { timeout: 120000 }).catch(() => fail('analiz bitmedi'));
  if (await main.$('.a-error')) fail(`analiz hatası: ${await main.textContent('.a-error')}`);
  ok(`analiz (${((Date.now() - t0) / 1000).toFixed(1)} sn): ${await main.textContent('.media h3')}`);
  const chips = await main.$$eval('.res-chip', (els) => els.map((e) => `${e.textContent}${e.classList.contains('na') ? '(yok)' : ''}`));
  ok(`çözünürlükler: ${chips.join(' ')}`);
  await main.waitForTimeout(1200); // küçük resim
  fs.mkdirSync(OUT, { recursive: true });
  await main.screenshot({ path: path.join(os.tmpdir(), 'sd-e2e-analiz.png') });
  // En düşük çözünürlük (144p) + MP4
  await main.click('.res-chip[data-h="144"]');
  ok(`not: ${await main.textContent('.fmt-note')}`);
  await main.keyboard.press('Control+Enter');
  await main.waitForSelector('.q-item', { timeout: 10000 }).catch(() => fail('kuyruğa eklenmedi'));
  ok('kuyruğa eklendi');
  // İlerlemeyi gör, duraklat → sürdür
  await main.waitForFunction(() => /%/.test((document.querySelector('.q-item .q-status') || {}).textContent || '') || document.querySelector('.q-item.s-done'), null, { timeout: 60000 }).catch(() => {});
  const st1 = await main.textContent('.q-item .q-status');
  ok(`ilerleme: ${st1.trim()}`);
  if (await main.$('.q-item.s-running')) {
    await main.click('.q-item [data-act="pause"]');
    await main.waitForSelector('.q-item.s-paused', { timeout: 10000 }).catch(() => fail('duraklatılamadı'));
    ok(`duraklatıldı: ${(await main.textContent('.q-item .q-status')).trim()}`);
    await main.click('.q-item [data-act="resume"]');
    ok('sürdürüldü');
  }
  await main.waitForSelector('.q-item.s-done, .q-item.s-error', { timeout: 300000 }).catch(() => fail('indirme bitmedi'));
  if (await main.$('.q-item.s-error')) fail(`indirme hatası: ${await main.textContent('.q-item .q-status')}`);
  ok(`tamamlandı: ${(await main.textContent('.q-item .q-status')).trim()}`);
  await main.screenshot({ path: path.join(os.tmpdir(), 'sd-e2e-kuyruk.png') });
  const files = fs.readdirSync(OUT).filter((f) => !f.startsWith('.'));
  ok(`dosya: ${files.join(', ')} (${files.map((f) => fs.statSync(path.join(OUT, f)).size).join(', ')} bayt)`);
  // Geçmiş sekmesi ve senkron
  await main.keyboard.press('Control+2');
  await main.waitForSelector('.h-item', { timeout: 5000 }).catch(() => fail('geçmişte yok'));
  ok('geçmişte görünüyor');
  await main.waitForTimeout(4500);
  ok(library && library.blob ? `şifreli senkron yüklendi (v${library.version}, ${library.blob.length} karakter)` : 'senkron henüz yok');
  // Kuyruk kalıcılığı
  const q = JSON.parse(fs.readFileSync(path.join(ud, 'queue.json'), 'utf8'));
  ok(`queue.json: ${q.items.map((x) => x.state).join(',')}`);
  const csp = await main.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]').content);
  console.log(csp.includes("default-src 'self'") ? '✓ CSP' : '× CSP yok', '·', errors.length ? `sayfa hataları: ${errors.slice(0, 5).join(' | ')}` : 'sayfa hatası yok');
  await browser.close().catch(() => {});
  proc.kill();
  server.close();
  fs.rmSync(ud, { recursive: true, force: true });
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
