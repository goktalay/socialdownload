'use strict';
// Ana sürecin yüklenebilirliği: electron sahte modülle değiştirilir, main.js çalıştırılır; IPC kanallarının preload.js ile
// uyumu, depo oluşturma, giriş penceresinin açılması ve girişsiz/uyarısız analiz yapılmaması doğrulanır.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const path = require('path');
const { tmpDir } = require('./helpers');

test('main.js sahte electron ile yüklenir, IPC kanallarını kaydeder ve giriş penceresini açar', async () => {
  const userData = tmpDir('sd-main-');
  const handles = new Map();
  const ons = new Map();
  const windows = [];
  let whenReadyResolve;
  const ready = new Promise((r) => (whenReadyResolve = r));

  class FakeWindow {
    constructor(opts) { this.opts = opts; this.webContents = { send() {}, reload() {}, id: windows.length }; windows.push(this); this.events = {}; }
    setMenuBarVisibility() {}
    loadFile(file) { this.file = file; }
    on(ev, cb) { this.events[ev] = cb; }
    once() {}
    isDestroyed() { return false; }
    isMinimized() { return false; }
    isFocused() { return false; }
    show() {} focus() {} hide() {} destroy() {} restore() {}
    static getAllWindows() { return windows; }
    static fromWebContents() { return windows[0]; }
  }
  const electron = {
    app: {
      requestSingleInstanceLock: () => true, on: () => {}, exit() {}, quit() {},
      getPath: (k) => (k === 'userData' ? userData : path.join(userData, k)), getLocale: () => 'tr-TR', getVersion: () => '1.0.0',
      isPackaged: false, setAppUserModelId() {}, setLoginItemSettings() {}, getLoginItemSettings: () => ({ openAtLogin: false }),
      whenReady: () => ready,
    },
    BrowserWindow: FakeWindow,
    ipcMain: { handle: (ch, fn) => handles.set(ch, fn), on: (ch, fn) => ons.set(ch, fn) },
    safeStorage: { isEncryptionAvailable: () => false },
    shell: { openExternal() {}, openPath: async () => '', showItemInFolder() {} },
    dialog: {}, clipboard: { writeText() {}, readText: () => 'bak: https://youtu.be/aqz-KE-bpKQ?si=x ve https://open.spotify.com/track/1' },
    nativeTheme: { themeSource: 'system', shouldUseDarkColors: true },
    Tray: class { setToolTip() {} setContextMenu() {} on() {} destroy() {} },
    Menu: { buildFromTemplate: (t) => t },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    Notification: { isSupported: () => false },
  };
  // Motor yok (vendor/engine olsa bile): testte gerçek yt-dlp / ağ çağrılmaz
  process.env.SD_ENGINE_DIR = tmpDir('sd-noengine-');
  delete process.env.SD_YTDLP;
  const origLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return electron;
    if (request === '@napi-rs/keyring') throw new Error('keyring yok (test)');
    return origLoad.call(this, request, ...rest);
  };
  try {
    require('../src/main.js');
    whenReadyResolve();
    await new Promise((r) => setTimeout(r, 80));
  } finally {
    Module._load = origLoad;
  }
  // preload.js'teki her invoke kanalı ana süreçte kayıtlı
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const invoked = [...preload.matchAll(/invoke\('([\w:]+)'/g)].map((m) => m[1]);
  assert.ok(invoked.length >= 35, String(invoked.length));
  for (const ch of invoked) assert.ok(handles.has(ch), ch);
  assert.ok(ons.has('app:lang') && ons.has('app:version'));
  // Girişsiz başlangıç: giriş penceresi açıldı (ana pencere ve kuyruk yok)
  assert.equal(windows.length, 1);
  assert.ok(windows[0].file.endsWith(path.join('renderer', 'login.html')));
  assert.deepEqual([windows[0].opts.width, windows[0].opts.height], [440, 640]);
  assert.equal(windows[0].opts.webPreferences.sandbox, true);
  assert.deepEqual(await handles.get('queue:get')(), []);

  // Hukuki uyarı onaylanmadan analiz yapılmaz
  assert.deepEqual(await handles.get('analyze:run')({}, { text: 'https://youtu.be/aqz-KE-bpKQ' }), { ok: false, code: 'notice' });
  await handles.get('app:acceptNotice')();
  // DRM servisi analiz edilmeden reddedilir; motor yoksa açık hata
  const drm = await handles.get('analyze:run')({}, { text: 'https://www.netflix.com/watch/1' });
  assert.deepEqual([drm.ok, drm.code], [false, 'drm']);
  const noEngine = await handles.get('analyze:run')({}, { text: 'https://youtu.be/aqz-KE-bpKQ' });
  assert.deepEqual([noEngine.ok, noEngine.code], [false, 'engine_missing']);

  // Ayarlar: geçersiz değerler temizlenir, eşzamanlılık 1–4, şablon doğrulanır
  const s = await handles.get('settings:set')({}, { download: { concurrency: 9, template: '../x', height: 777, limitRate: -5, gapSec: 99 }, appTheme: 'zebra', downloadDir: 'goreli/yol', hack: 1 });
  assert.equal(s.ok, true);
  const st = await handles.get('store:get')();
  assert.deepEqual([st.settings.download.concurrency, st.settings.download.template, st.settings.download.height, st.settings.download.limitRate, st.settings.download.gapSec], [4, '{title}', 0, 0, 30]);
  assert.equal(st.settings.appTheme, 'system');
  assert.equal(st.settings.downloadDir, path.join(userData, 'downloads', 'Social Download')); // göreli yol kabul edilmez → varsayılan
  assert.equal(st.settings.hack, undefined);
  assert.equal(st.platforms.find((p) => p.id === 'youtube').name, 'YouTube');
  assert.deepEqual(st.limits.ladder.slice(0, 3), [4320, 2160, 1440]);

  // Pano: bağlantılar ayıklanır, DRM reddedilir
  const clip = await handles.get('clip:read')();
  assert.deepEqual(clip.urls.map((u) => u.url), ['https://youtu.be/aqz-KE-bpKQ']);
  assert.deepEqual(clip.rejected.map((r) => r.code), ['drm']);
  // Şablon denetimi örnek çıktı verir
  const tpl = await handles.get('template:check')({}, '{index} {title}');
  assert.deepEqual([tpl.ok, tpl.sample], [true, '03 %(title)s.%(ext)s']);
  // Küçük resim: yalnız https ve yerel olmayan adres
  assert.equal(await handles.get('thumb:get')({}, 'http://ornek.com/a.jpg'), null);
  assert.equal(await handles.get('thumb:get')({}, 'https://192.168.1.1/a.jpg'), null);
  // Kaynağı açma: yalnız geçerli herkese açık bağlantı
  assert.deepEqual(await handles.get('app:openSource')({}, 'file:///etc/passwd'), { ok: false });
  const about = await handles.get('app:about')();
  assert.equal(about.version, '1.0.0');
  assert.ok(about.engine && 'ytdlpPath' in about.engine);
});
