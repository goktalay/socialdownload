'use strict';

// Social Download — ana süreç. Herkese açık bağlantıları motorla (yt-dlp + ffmpeg) analiz eder, seçilen çözünürlük/biçimle
// indirme kuyruğuna alır. İndirilen dosyalar yalnız bu bilgisayarda kalır; Mastertool hesabıyla yalnız ayarlar ve
// (isteğe bağlı) indirme geçmişi uçtan uca şifreli senkronlanır. Tasarım sınırları: docs/site-teknik.md › Bilinen sınırlar.

const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog, clipboard, nativeTheme, Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const I18N = require('./i18n');
const URLS = require('./urls');
const FORMATS = require('./formats');
const YT = require('./ytdlp');
const { createQueue, clampConcurrency, MAX_CONCURRENCY } = require('./queue');
const { createEngineFiles } = require('./engine');
const { createAccount, API_BASE } = require('./account');
const { createSso } = require('./sso');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const APP_NAME = 'Social Download';
const APP_CODE = 'sd';
const HISTORY_MAX = 200;
const THUMB_MAX_BYTES = 2 * 1024 * 1024;
const ANALYZE_MAX = 25; // tek seferde analiz edilen bağlantı (fazlası için uyarı)

// Tek örnek: ikinci çalıştırma açık pencereyi öne getirir
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => showMainWindow());
  main();
}

function main() {
  let t = I18N.createT('en');
  const currentLang = () => (store && store.settings.language) || I18N.resolveLanguage(app.getLocale());
  function applyLanguage() { t = I18N.createT(currentLang()); }

  // -------------------------------------------------------------------------
  // Kalıcı depo (userData/store.json): ayarlar + geçmiş; kuyruk ayrı (userData/queue.json, yalnız bu cihaz)
  // -------------------------------------------------------------------------
  const storePath = () => path.join(app.getPath('userData'), 'store.json');
  const queuePath = () => path.join(app.getPath('userData'), 'queue.json');
  const partialRoot = () => path.join(app.getPath('userData'), 'partial');
  const thumbsDir = () => path.join(app.getPath('userData'), 'thumbs');
  const defaultDir = () => path.join(app.getPath('downloads'), APP_NAME);

  const defaultDownload = () => ({
    ...FORMATS.DEFAULTS, template: YT.DEFAULT_TEMPLATE, concurrency: 2, limitRate: 0, gapSec: 2, playlistFolder: true, embedMetadata: true,
  });

  const defaultStore = () => ({
    syncMeta: {},
    history: [], // { id, url, title, platform, uploader, duration, label, finishedAt }
    settings: {
      appTheme: 'system',
      language: null,
      download: defaultDownload(),
      syncHistory: true,
      // cihaza özgü (senkronlanmaz)
      downloadDir: null,
      clipboardWatch: false,
      resumeOnStart: true,
      notifyDone: true,
      openAtLogin: false,
      minimizeToTray: false,
      closeToTray: false,
      checkUpdates: true,
      checkEngine: true,
      noticeAccepted: false, // "Yalnız indirme hakkınız olan içerikleri indirin" onayı
      trayHintShown: false,
    },
  });

  let store = null;

  function sanitizeDownload(d) {
    const v = d && typeof d === 'object' ? d : {};
    const o = FORMATS.sanitizeOpts(v);
    return {
      ...o,
      template: YT.validateTemplate(v.template).ok ? String(v.template).trim() : YT.DEFAULT_TEMPLATE,
      concurrency: clampConcurrency(v.concurrency ?? 2),
      limitRate: Math.min(100000, Math.max(0, Math.round(Number(v.limitRate) || 0))), // KB/sn, 0 = sınırsız
      gapSec: Math.min(30, Math.max(0, Number(v.gapSec ?? 2) || 0)),
      playlistFolder: v.playlistFolder !== false,
      embedMetadata: v.embedMetadata !== false,
    };
  }

  const sanitizeHistory = (h) => ({
    id: String(h.id || crypto.randomUUID()).slice(0, 64), url: String(h.url || '').slice(0, 2048), title: String(h.title || '').slice(0, 300),
    platform: URLS.platformById(String(h.platform || '')).id, uploader: h.uploader ? String(h.uploader).slice(0, 200) : null,
    duration: Number(h.duration) || null, label: String(h.label || '').slice(0, 60), finishedAt: Number(h.finishedAt) || Date.now(),
  });
  const sortHistory = (list) => list.sort((a, b) => b.finishedAt - a.finishedAt).slice(0, HISTORY_MAX);

  function loadStore() {
    try {
      store = { ...defaultStore(), ...JSON.parse(fs.readFileSync(storePath(), 'utf8')) };
      store.settings = { ...defaultStore().settings, ...(store.settings || {}) };
      if (!store.syncMeta) store.syncMeta = {};
    } catch {
      store = defaultStore();
    }
    store.history = sortHistory((Array.isArray(store.history) ? store.history : []).filter((h) => h && h.url).map(sanitizeHistory));
    store.settings.download = sanitizeDownload(store.settings.download);
    applyAppTheme();
    applyLanguage();
  }

  let saveTimer = null;
  function saveStore({ sync = true } = {}) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(writeStore, 150);
    if (sync && account) account.onLocalChange();
  }
  function writeStore() {
    clearTimeout(saveTimer);
    saveTimer = null;
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
  }

  function applyAppTheme() {
    const v = store.settings.appTheme;
    nativeTheme.themeSource = v === 'dark' || v === 'light' ? v : 'system';
  }
  const windowBg = () => (nativeTheme.shouldUseDarkColors ? '#0b0f17' : '#eef2f7');

  function encrypt(text) {
    if (!text) return '';
    if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(text).toString('base64');
    return 'b64:' + Buffer.from(text, 'utf8').toString('base64');
  }
  function decrypt(value) {
    if (!value) return '';
    if (value.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    if (value.startsWith('b64:')) return Buffer.from(value.slice(4), 'base64').toString('utf8');
    return value;
  }

  const downloadDir = () => store.settings.downloadDir || defaultDir();

  function publicSettings() {
    const { trayHintShown, ...rest } = store.settings;
    return { ...rest, downloadDir: downloadDir(), language: store.settings.language || currentLang() };
  }

  function publicStore() {
    return {
      settings: publicSettings(), history: store.history,
      limits: { maxConcurrency: MAX_CONCURRENCY, ladder: FORMATS.LADDER, containers: FORMATS.CONTAINERS, audioFormats: FORMATS.AUDIO_FORMATS, audioQualities: FORMATS.AUDIO_QUALITIES, tokens: Object.keys(YT.TOKENS) },
      platforms: URLS.PLATFORMS.map(({ id, name, color }) => ({ id, name, color })),
    };
  }

  const send = (ch, data) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(ch, data); };
  function broadcastStore() {
    send('store:changed', publicStore());
    if (tray) tray.setContextMenu(buildTrayMenu());
  }

  const exePath = () => process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  const isPortable = () => !!process.env.PORTABLE_EXECUTABLE_FILE;
  const LOGIN_ITEM = 'MastertoolSocialDownload';
  function applyOpenAtLogin() {
    if (!app.isPackaged || process.platform !== 'win32') return;
    app.setLoginItemSettings({ openAtLogin: !!store.settings.openAtLogin, path: exePath(), args: ['--hidden'], name: LOGIN_ITEM });
  }
  const openAtLoginState = () => (app.isPackaged && process.platform === 'win32'
    ? app.getLoginItemSettings({ path: exePath(), args: ['--hidden'] }).openAtLogin
    : !!store.settings.openAtLogin);

  // -------------------------------------------------------------------------
  // Motor: uygulamayla gelen yt-dlp + ffmpeg (resources/engine), güncellenen yt-dlp userData/engine'de
  // -------------------------------------------------------------------------
  let engineFiles = null;
  let engine = null;
  function initEngine() {
    // SD_ENGINE_DIR: geliştirme / test için motor klasörü (yoksa paketli resources/engine ya da vendor/engine/<hedef>)
    const resourcesDir = process.env.SD_ENGINE_DIR
      || (app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.join(__dirname, '..', 'vendor', 'engine', process.platform === 'win32' ? 'win64' : 'linux64'));
    engineFiles = createEngineFiles({
      resourcesDir, userDir: app.getPath('userData'),
      run: (bin, args) => new Promise((resolve, reject) => execFile(bin, args, { timeout: 60000, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(out)))),
    });
    engine = YT.createEngine({
      spawn,
      ytdlpPath: () => engineFiles.ytdlpPath(),
      ffmpegDir: () => engineFiles.ffmpegDir(),
      // Linux'ta paylaşılan ffmpeg kitaplıkları (geliştirme): ffmpeg/../lib
      extraEnv: () => {
        const d = engineFiles.ffmpegDir();
        if (!d || process.platform === 'win32') return {};
        const lib = path.join(d, '..', 'lib');
        return fs.existsSync(lib) ? { LD_LIBRARY_PATH: [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') } : {};
      },
    });
  }

  // -------------------------------------------------------------------------
  // Kuyruk
  // -------------------------------------------------------------------------
  let queue = null;
  const partialDir = (id) => path.join(partialRoot(), String(id).replace(/[^\w-]/g, ''));
  const PUBLIC_ITEM = ['id', 'url', 'title', 'platform', 'uploader', 'duration', 'thumbnail', 'opts', 'label', 'dir', 'playlist', 'state', 'progress', 'speed', 'error', 'file', 'size', 'createdAt', 'startedAt', 'finishedAt', 'attempts'];
  const publicItem = (it) => { const o = {}; for (const k of PUBLIC_ITEM) o[k] = it[k] ?? null; return o; };
  const publicQueue = () => queue.list().map(publicItem);

  let queueSaveTimer = null;
  let lastQueueSave = 0;
  function saveQueue(now = false) {
    clearTimeout(queueSaveTimer);
    const write = () => {
      queueSaveTimer = null;
      lastQueueSave = Date.now();
      try {
        fs.mkdirSync(path.dirname(queuePath()), { recursive: true });
        fs.writeFileSync(queuePath(), JSON.stringify({ v: 1, items: queue.snapshot().map(publicItem) }), 'utf8');
      } catch { /* disk */ }
    };
    if (now) return write();
    queueSaveTimer = setTimeout(write, 300);
  }

  function addHistory(item) {
    store.history.unshift(sanitizeHistory({ id: item.id, url: item.url, title: item.title, platform: item.platform, uploader: item.uploader, duration: item.duration, label: item.label, finishedAt: item.finishedAt }));
    store.history = sortHistory(store.history.filter((h, i, a) => a.findIndex((x) => x.id === h.id) === i));
    saveStore();
    send('history:changed', store.history);
  }

  let doneBatch = 0;
  let doneTimer = null;
  function notifyDone(item) {
    if (!store.settings.notifyDone || !Notification.isSupported()) return;
    if (mainWindow && mainWindow.isFocused()) return;
    doneBatch++;
    clearTimeout(doneTimer);
    // Oynatma listesi indirilirken her dosya için ayrı bildirim olmasın: 2 sn içinde bitenler tek bildirimde
    doneTimer = setTimeout(() => {
      const n = doneBatch;
      doneBatch = 0;
      const notif = new Notification({ title: n > 1 ? t('notify.doneMany', { n }) : t('notify.done'), body: n > 1 ? '' : item.title || item.url, icon: ICON, silent: false });
      notif.on('click', showMainWindow);
      notif.show();
    }, 2000);
  }

  function initQueue() {
    const d = store.settings.download;
    queue = createQueue({
      concurrency: d.concurrency,
      gapMs: d.gapSec * 1000,
      runner: (item, ctx) => engine.download(item, {
        outDir: item.dir || downloadDir(), tempDir: partialDir(item.id), template: item.template || store.settings.download.template,
        limitRate: store.settings.download.limitRate, retries: 3, embedMetadata: store.settings.download.embedMetadata,
      }, ctx),
      cleanup: (item) => fs.promises.rm(partialDir(item.id), { recursive: true, force: true }),
      onChange: (kind, item) => {
        if (kind === 'progress') {
          send('queue:progress', { id: item.id, progress: item.progress, speed: item.speed });
          if (Date.now() - lastQueueSave > 5000) saveQueue();
          return;
        }
        if (kind === 'complete' && item) { addHistory(item); notifyDone(item); }
        send('queue:changed', publicQueue());
        saveQueue();
        if (tray) tray.setContextMenu(buildTrayMenu());
      },
    });
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(queuePath(), 'utf8')).items || []; } catch { /* ilk açılış */ }
    queue.restore(saved, { resume: store.settings.resumeOnStart });
  }

  // -------------------------------------------------------------------------
  // Küçük resimler: ana süreç indirir (yalnız https, görüntü, ≤ 2 MB), önbellekten data: adresi olarak verilir
  // -------------------------------------------------------------------------
  const thumbFile = (url) => path.join(thumbsDir(), crypto.createHash('sha1').update(url).digest('hex'));
  const thumbInflight = new Map();
  async function getThumb(url) {
    const u = String(url || '');
    if (!/^https:\/\//i.test(u)) return null;
    let host = '';
    try { host = new URL(u).hostname; } catch { return null; }
    if (URLS.classify(`https://${host}/`).code === 'private_host') return null;
    const f = thumbFile(u);
    try { const b = fs.readFileSync(f); const nl = b.indexOf(10); return `data:${b.subarray(0, nl).toString()};base64,${b.subarray(nl + 1).toString('base64')}`; } catch { /* yok */ }
    if (thumbInflight.has(u)) return thumbInflight.get(u);
    const p = (async () => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15000);
      try {
        const res = await fetch(u, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const type = String(res.headers.get('content-type') || '').split(';')[0].trim();
        if (!res.ok || !/^image\/(?:jpeg|png|webp|gif|avif)$/.test(type)) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > THUMB_MAX_BYTES) return null;
        fs.mkdirSync(thumbsDir(), { recursive: true });
        fs.writeFileSync(f, Buffer.concat([Buffer.from(type + '\n'), buf]));
        return `data:${type};base64,${buf.toString('base64')}`;
      } catch { return null; } finally { clearTimeout(timer); thumbInflight.delete(u); }
    })();
    thumbInflight.set(u, p);
    return p;
  }
  // Önbellek 30 günden eski dosyaları açılışta temizler
  function pruneThumbs() {
    try {
      const now = Date.now();
      for (const n of fs.readdirSync(thumbsDir())) {
        const p = path.join(thumbsDir(), n);
        if (now - fs.statSync(p).mtimeMs > 30 * 86400000) fs.unlinkSync(p);
      }
    } catch { /* yok */ }
  }

  // -------------------------------------------------------------------------
  // Mastertool hesabı (mastertool.download, /api/sd)
  // -------------------------------------------------------------------------
  let account = null;
  let loginWindow = null;
  let mainWindow = null;
  let loginNotice = null;
  let updateInfo = null;

  function initSso() {
    try { return createSso({ stateDir: path.join(app.getPath('appData'), 'Mastertool') }); } catch { return null; }
  }

  function initAccount() {
    account = createAccount({
      sso: initSso(),
      onSharedSignIn: () => enterApp(),
      onSharedSignOut: (code) => showLogin(code === 'app_disabled' ? t('auth.errAppDisabled') : null),
      userDataDir: app.getPath('userData'),
      appVersion: app.getVersion(),
      encrypt,
      decrypt,
      getStore: () => store,
      // Senkrondan gelen ayarlar ve geçmiş (yeni senkron tetiklemeden)
      replaceLibrary: ({ settings, history, syncMeta }) => {
        const prevLang = currentLang();
        store.syncMeta = syncMeta;
        Object.assign(store.settings, settings);
        store.settings.download = sanitizeDownload(store.settings.download);
        // Geçmiş senkronu kapalıysa bu cihazın geçmişi korunur
        if (store.settings.syncHistory !== false) store.history = sortHistory(history.map(sanitizeHistory));
        writeStore();
        applyAppTheme();
        applyLanguage();
        if (queue) { queue.setConcurrency(store.settings.download.concurrency); queue.setGap(store.settings.download.gapSec * 1000); }
        if (currentLang() !== prevLang) onLanguageChanged();
        else { broadcastStore(); send('history:changed', store.history); }
      },
      persistStore: writeStore,
      resetSyncMeta: () => { store.syncMeta = {}; writeStore(); },
      onStatus: (st) => send('account:status', st),
      onSessionExpired: (code) =>
        showLogin(t(code === 'app_disabled' ? 'auth.errAppDisabled' : code === 'wrong_app' ? 'auth.errWrongApp' : 'auth.errSessionExpired')),
      onUpdate: (info) => {
        updateInfo = info;
        notifyUpdate(info);
        send('app:update', info);
      },
    });
  }

  function notifyUpdate(info) {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title: t('update.available', { version: info.version }), body: t('update.hint'), icon: ICON, silent: true });
    n.on('click', () => openWeb('account'));
    n.show();
  }

  function afterStart() {
    account.start().then(() => store.settings.checkUpdates && account.checkUpdate()).catch(() => {});
    // Motor güncellemesi denetimi (yalnız bildirim; güncelleme kullanıcı onayıyla)
    if (store.settings.checkEngine && engineFiles.ytdlpPath()) {
      const last = (engineFiles.info().lastCheck) || 0;
      if (Date.now() - last > 24 * 3600 * 1000) engineFiles.check().then((r) => send('engine:status', { ...engineFiles.info(), newer: r.newer })).catch(() => {});
    }
  }

  function enterApp() {
    loginNotice = null;
    if (!mainWindow) createMainWindow();
    if (loginWindow) loginWindow.destroy();
    if (!queue) initQueue();
    afterStart();
  }

  const webPreferences = { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true };

  function createLoginWindow() {
    loginWindow = new BrowserWindow({
      width: 440, height: 640, resizable: false, maximizable: false,
      backgroundColor: windowBg(), title: APP_NAME, icon: ICON, autoHideMenuBar: true, webPreferences,
    });
    loginWindow.setMenuBarVisibility(false);
    loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
    loginWindow.on('closed', () => {
      loginWindow = null;
      if (!account || !account.isLoggedIn()) quit();
    });
  }

  function showLogin(notice) {
    loginNotice = notice || null;
    if (queue) queue.pauseAll(); // oturum düştü: indirmeler duraklatılır (kuyruk korunur)
    destroyTray();
    if (!loginWindow) createLoginWindow();
    else {
      loginWindow.webContents.reload();
      if (loginWindow.isMinimized()) loginWindow.restore();
      loginWindow.show();
      loginWindow.focus();
    }
    for (const w of BrowserWindow.getAllWindows()) if (w !== loginWindow) w.destroy();
    mainWindow = null;
  }

  // -------------------------------------------------------------------------
  // Ana pencere ve tepsi
  // -------------------------------------------------------------------------
  let tray = null;
  let isQuitting = false;
  let lastClip = '';

  function createMainWindow() {
    mainWindow = new BrowserWindow({
      width: 1320, height: 840, minWidth: 980, minHeight: 600,
      backgroundColor: windowBg(), title: APP_NAME, icon: ICON, autoHideMenuBar: true, webPreferences,
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    mainWindow.on('minimize', (e) => {
      if (!store.settings.minimizeToTray) return;
      e.preventDefault();
      hideToTray();
    });
    mainWindow.on('close', (e) => {
      if (store.settings.closeToTray && !isQuitting) {
        e.preventDefault();
        hideToTray();
      }
    });
    mainWindow.on('show', destroyTray);
    // Pano algılama (isteğe bağlı, varsayılan kapalı): pencere öne gelince panodaki YENİ bağlantı önerilir
    mainWindow.on('focus', () => {
      if (!store.settings.clipboardWatch) return;
      const text = clipboard.readText().slice(0, 20000);
      if (!text || text === lastClip) return;
      lastClip = text;
      const { urls } = URLS.extract(text);
      if (urls.length) mainWindow.webContents.send('clip:offer', { urls: urls.slice(0, 50) });
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    return mainWindow;
  }

  function showMainWindow() {
    if (!account || !account.isLoggedIn()) {
      if (!loginWindow) { showLogin(); return; }
      if (loginWindow.isMinimized()) loginWindow.restore();
      loginWindow.show();
      loginWindow.focus();
      return;
    }
    if (!mainWindow) createMainWindow();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }

  function hideToTray() {
    ensureTray();
    if (mainWindow) mainWindow.hide();
    if (!store.settings.trayHintShown && tray) {
      store.settings.trayHintShown = true;
      saveStore({ sync: false });
      if (tray.displayBalloon) tray.displayBalloon({ title: APP_NAME, content: t('tray.hiddenHint'), icon: ICON });
    }
  }

  function buildTrayMenu() {
    const c = queue ? queue.counts() : { running: 0, queued: 0, paused: 0 };
    return Menu.buildFromTemplate([
      { label: t('tray.show'), click: showMainWindow },
      { type: 'separator' },
      { label: t('tray.status', { running: c.running, queued: c.queued }), enabled: false },
      { label: t('queue.pauseAll'), enabled: !!(c.running || c.queued), click: () => queue && queue.pauseAll() },
      { label: t('queue.resumeAll'), enabled: !!c.paused, click: () => queue && queue.resumeAll() },
      { type: 'separator' },
      { label: t('tray.quit'), click: quit },
    ]);
  }

  function ensureTray() {
    if (tray) { tray.setContextMenu(buildTrayMenu()); return; }
    const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16, quality: 'best' });
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
  }

  function destroyTray() {
    if (tray) { tray.destroy(); tray = null; }
  }

  function quit() {
    isQuitting = true;
    if (queue) { queue.shutdown(); saveQueue(true); }
    if (saveTimer) writeStore();
    app.quit();
  }

  // -------------------------------------------------------------------------
  // Analiz
  // -------------------------------------------------------------------------
  let analyzeCtl = null;
  async function analyze({ text, playlist = false }) {
    if (!store.settings.noticeAccepted) return { ok: false, code: 'notice' };
    const { urls, rejected } = URLS.extract(text);
    if (!urls.length) return { ok: false, code: rejected.length ? rejected[0].code : 'no_url', rejected };
    if (!engineFiles.ytdlpPath()) return { ok: false, code: 'engine_missing' };
    if (analyzeCtl) analyzeCtl.abort();
    const ctl = new AbortController();
    analyzeCtl = ctl;
    const list = urls.slice(0, ANALYZE_MAX);
    const results = [];
    for (let i = 0; i < list.length; i++) {
      if (ctl.signal.aborted) break;
      const u = list[i];
      send('analyze:progress', { done: i, total: list.length, url: u.url });
      try {
        // Tek bağlantıda "video + liste" adresi: kullanıcı açıkça istemedikçe yalnız video
        const asPlaylist = playlist || (u.hint && u.hint !== 'video_in_playlist');
        const r = await engine.analyze(u.url, { playlist: asPlaylist, signal: ctl.signal });
        results.push({ ok: true, url: u.url, hint: u.hint, result: r });
      } catch (e) {
        if (e.code === 'aborted') break;
        results.push({ ok: false, url: u.url, hint: u.hint, platform: u.platform, code: e.code || 'unknown', message: e.message });
      }
    }
    if (analyzeCtl === ctl) analyzeCtl = null;
    return { ok: true, results, rejected, skipped: urls.length - list.length, canceled: ctl.signal.aborted };
  }

  // Kuyruğa ekleme: { entries: [{ url, title, platform, thumbnail, duration, uploader, playlist? }], opts }
  function addToQueue({ entries, opts }) {
    const o = FORMATS.sanitizeOpts(opts);
    const d = store.settings.download;
    const active = new Set(queue.list().filter((x) => ['queued', 'running', 'paused'].includes(x.state)).map((x) => `${URLS.contentKey(x.url)}|${FORMATS.labelOf(x.opts)}`));
    const items = [];
    let dup = 0;
    let blocked = 0;
    for (const e of (Array.isArray(entries) ? entries : []).slice(0, 2000)) {
      const c = URLS.classify(e && e.url);
      if (!c.ok) { blocked++; continue; }
      const key = `${URLS.contentKey(c.url)}|${FORMATS.labelOf(o)}`;
      if (active.has(key)) { dup++; continue; }
      active.add(key);
      const pl = e.playlist && e.playlist.title ? { title: String(e.playlist.title).slice(0, 200), index: Number(e.playlist.index) || null, count: Number(e.playlist.count) || null } : null;
      const dir = pl && d.playlistFolder ? path.join(downloadDir(), YT.cleanName(pl.title, 80) || 'playlist') : downloadDir();
      items.push({
        url: c.url, title: String(e.title || '').slice(0, 300) || c.url, platform: URLS.platformById(e.platform || c.platform).id,
        uploader: e.uploader ? String(e.uploader).slice(0, 200) : null, duration: Number(e.duration) || null,
        thumbnail: /^https:\/\//.test(e.thumbnail || '') ? String(e.thumbnail).slice(0, 2048) : null,
        opts: o, label: FORMATS.labelOf(o, { best: t('fmt.best') }), dir, template: d.template, playlist: pl,
      });
    }
    const added = queue.add(items);
    return { ok: true, added: added.length, dup, blocked };
  }

  // -------------------------------------------------------------------------
  // IPC — ortak
  // -------------------------------------------------------------------------
  ipcMain.on('app:lang', (e) => { e.returnValue = currentLang(); });
  ipcMain.on('app:version', (e) => { e.returnValue = app.getVersion(); });

  ipcMain.handle('store:get', () => publicStore());

  const DEVICE_SETTINGS = ['clipboardWatch', 'resumeOnStart', 'notifyDone', 'openAtLogin', 'minimizeToTray', 'closeToTray', 'checkUpdates', 'checkEngine'];
  ipcMain.handle('settings:set', (_e, patch) => {
    const p = { ...(patch || {}) };
    const allowed = ['appTheme', 'language', 'download', 'syncHistory', 'downloadDir', ...DEVICE_SETTINGS];
    for (const k of Object.keys(p)) if (!allowed.includes(k)) delete p[k];
    if ('appTheme' in p) p.appTheme = ['dark', 'light', 'system'].includes(p.appTheme) ? p.appTheme : 'system';
    if ('language' in p) p.language = I18N.LANGUAGES[p.language] ? p.language : null;
    if ('download' in p) p.download = sanitizeDownload({ ...store.settings.download, ...(p.download || {}) });
    if ('syncHistory' in p) p.syncHistory = !!p.syncHistory;
    if ('downloadDir' in p) {
      const d = String(p.downloadDir || '');
      p.downloadDir = d && path.isAbsolute(d) ? d : null;
    }
    for (const k of DEVICE_SETTINGS) if (k in p) p[k] = !!p[k];
    const prevLang = currentLang();
    Object.assign(store.settings, p);
    const loud = Object.keys(p).some((k) => !DEVICE_SETTINGS.includes(k) && k !== 'downloadDir');
    saveStore({ sync: loud });
    if ('appTheme' in p) applyAppTheme();
    if ('openAtLogin' in p) applyOpenAtLogin();
    if ('download' in p && queue) { queue.setConcurrency(store.settings.download.concurrency); queue.setGap(store.settings.download.gapSec * 1000); }
    if ('language' in p) {
      applyLanguage();
      if (currentLang() !== prevLang) { onLanguageChanged(); return { ok: true }; }
    }
    broadcastStore();
    return { ok: true };
  });

  function onLanguageChanged() {
    if (tray) tray.setContextMenu(buildTrayMenu());
    for (const w of BrowserWindow.getAllWindows()) w.webContents.reload();
  }

  ipcMain.handle('app:acceptNotice', () => {
    store.settings.noticeAccepted = true;
    saveStore({ sync: false });
    broadcastStore();
    return { ok: true };
  });

  // --- Analiz ve kuyruk ---------------------------------------------------------
  ipcMain.handle('analyze:run', (_e, req) => analyze({ text: String((req && req.text) || '').slice(0, 200000), playlist: !!(req && req.playlist) }));
  ipcMain.handle('analyze:cancel', () => { if (analyzeCtl) analyzeCtl.abort(); return { ok: true }; });
  ipcMain.handle('thumb:get', (_e, url) => getThumb(url));
  ipcMain.handle('clip:read', () => {
    const text = clipboard.readText().slice(0, 200000);
    lastClip = text;
    return { text, ...URLS.extract(text) };
  });
  ipcMain.handle('template:check', (_e, tpl) => {
    const v = YT.validateTemplate(tpl);
    return { ...v, sample: v.ok ? YT.buildOutputTemplate(tpl, { playlist: { title: 'Playlist', index: 3, count: 12 } }) : null };
  });

  ipcMain.handle('queue:get', () => (queue ? publicQueue() : []));
  ipcMain.handle('queue:add', (_e, req) => addToQueue(req || {}));
  const QUEUE_OPS = ['pause', 'resume', 'cancel', 'retry', 'remove'];
  ipcMain.handle('queue:op', (_e, { op, ids }) => {
    if (!QUEUE_OPS.includes(op)) return { ok: false };
    let n = 0;
    for (const id of (Array.isArray(ids) ? ids : [ids]).slice(0, 5000)) if (queue[op](String(id))) n++;
    return { ok: true, n };
  });
  ipcMain.handle('queue:move', (_e, { id, delta }) => ({ ok: queue.move(String(id), Number(delta) || 0) }));
  ipcMain.handle('queue:pauseAll', () => { queue.pauseAll(); return { ok: true }; });
  ipcMain.handle('queue:resumeAll', () => { queue.resumeAll(); return { ok: true }; });
  ipcMain.handle('queue:clearFinished', () => ({ ok: true, n: queue.clearFinished() }));

  // Biten dosya: oynat / klasörde göster (yalnız kuyruktaki öğenin kendi dosyası)
  const itemFile = (id) => {
    const it = queue && queue.get(String(id));
    return it && it.file && fs.existsSync(it.file) ? it.file : null;
  };
  ipcMain.handle('file:open', async (_e, id) => {
    const f = itemFile(id);
    if (!f) return { ok: false, code: 'missing' };
    const err = await shell.openPath(f);
    return err ? { ok: false, code: 'failed', message: err } : { ok: true };
  });
  ipcMain.handle('file:show', (_e, id) => {
    const f = itemFile(id);
    if (!f) return { ok: false, code: 'missing' };
    shell.showItemInFolder(f);
    return { ok: true };
  });
  ipcMain.handle('dir:open', async () => {
    fs.mkdirSync(downloadDir(), { recursive: true });
    await shell.openPath(downloadDir());
    return { ok: true };
  });
  ipcMain.handle('dir:choose', async (e) => {
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { title: t('set.downloadDir'), defaultPath: downloadDir(), properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    return { ok: true, path: res.filePaths[0] };
  });

  // --- Geçmiş --------------------------------------------------------------------
  ipcMain.handle('history:remove', (_e, ids) => {
    const set = new Set((Array.isArray(ids) ? ids : [ids]).map(String));
    store.history = store.history.filter((h) => !set.has(h.id));
    saveStore();
    send('history:changed', store.history);
    return { ok: true };
  });
  ipcMain.handle('history:clear', () => {
    store.history = [];
    saveStore();
    send('history:changed', store.history);
    return { ok: true };
  });
  ipcMain.handle('app:openSource', (_e, url) => {
    const c = URLS.classify(url);
    if (!c.ok) return { ok: false };
    shell.openExternal(c.url);
    return { ok: true };
  });
  ipcMain.handle('app:copy', (_e, text) => { clipboard.writeText(String(text || '').slice(0, 10000)); return { ok: true }; });

  // --- Motor ---------------------------------------------------------------------
  ipcMain.handle('engine:info', () => engineFiles.info());
  ipcMain.handle('engine:check', async () => {
    try { return { ok: true, ...(await engineFiles.check()), info: engineFiles.info() }; } catch (e) { return { ok: false, code: e.code || 'error', message: e.message }; }
  });
  let engineBusy = false;
  ipcMain.handle('engine:update', async () => {
    if (engineBusy) return { ok: false, code: 'busy' };
    if (queue && queue.counts().running) return { ok: false, code: 'downloads_running' };
    engineBusy = true;
    try {
      const r = await engineFiles.update({ onStep: (step) => send('engine:step', step) });
      return { ...r, info: engineFiles.info() };
    } catch (e) {
      return { ok: false, code: e.code || 'error', message: e.message };
    } finally {
      engineBusy = false;
    }
  });
  ipcMain.handle('engine:reset', () => ({ ok: true, info: engineFiles.reset() }));
  ipcMain.handle('engine:openLicenses', () => {
    const dir = path.join(app.isPackaged ? path.join(process.resourcesPath, 'engine') : path.join(__dirname, '..', 'vendor', 'engine', 'win64'), 'licenses');
    if (fs.existsSync(dir)) return shell.openPath(dir);
    return shell.openExternal('https://github.com/yt-dlp/yt-dlp/blob/master/LICENSE');
  });

  // --- Hesap --------------------------------------------------------------------
  ipcMain.handle('account:state', () => ({ ...account.state(), notice: loginNotice, appVersion: app.getVersion() }));

  ipcMain.handle('account:login', async (_e, { email, password, remember }) => {
    try {
      await account.login(email, password, remember);
      enterApp();
      return { ok: true };
    } catch (e) {
      return { ok: false, code: e.code || 'error', message: e.message };
    }
  });

  ipcMain.handle('account:logout', async () => {
    await account.logout();
    showLogin();
  });

  ipcMain.handle('account:syncNow', () => account.syncNow());
  ipcMain.handle('account:setSync', async (_e, on) => {
    try { await account.setSyncEnabled(on); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; }
  });
  ipcMain.handle('account:deleteRemote', async () => {
    try { await account.deleteRemote(); return { ok: true }; } catch (e) { return { ok: false, code: e.code }; }
  });

  ipcMain.handle('app:openMastertool', () => {
    const theme = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    shell.openExternal(`https://mastertool.download/?lang=${encodeURIComponent(currentLang())}&theme=${theme}`);
  });

  function openWeb(page) {
    const allowed = { forgot: '/sifremi-unuttum', register: '/kayit', account: '/hesabim', tool: '/araclar/social-download' };
    if (!allowed[page]) return;
    const q = new URLSearchParams({ lang: currentLang(), theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', app: APP_CODE });
    shell.openExternal(`${API_BASE}${allowed[page]}?${q}`);
  }
  ipcMain.handle('account:openWeb', (_e, page) => openWeb(page));

  ipcMain.handle('app:about', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    openAtLogin: openAtLoginState(),
    portable: isPortable(),
    packaged: app.isPackaged,
    update: updateInfo,
    engine: engineFiles ? engineFiles.info() : null,
  }));

  ipcMain.handle('app:checkUpdate', async () => {
    try {
      return { ok: true, ...(await account.checkUpdate({ manual: true })) };
    } catch (e) {
      return { ok: false, code: e.code || 'error', message: e.message };
    }
  });

  ipcMain.handle('app:openLicenses', () => {
    const file = path.join(path.dirname(process.execPath), 'LICENSES.chromium.html');
    if (fs.existsSync(file)) return shell.openPath(file);
    return shell.openExternal('https://www.electronjs.org/docs/latest#license');
  });

  // -------------------------------------------------------------------------
  app.setAppUserModelId('com.mastertool.socialdownload');

  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (e) => e.preventDefault());
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (queue) { queue.shutdown(); saveQueue(true); }
  });
  app.on('window-all-closed', () => {
    if (!tray || !account || !account.isLoggedIn()) quit();
  });

  app.whenReady().then(async () => {
    loadStore();
    initEngine();
    initAccount();
    applyOpenAtLogin();
    pruneThumbs();
    if (!account.isLoggedIn()) {
      const r = await account.trySharedSignIn();
      if (r.code === 'app_disabled') loginNotice = t('auth.errAppDisabled');
    }
    account.watchShared();
    if (account.isLoggedIn()) {
      createMainWindow();
      initQueue();
      if (process.argv.includes('--hidden') && store.settings.minimizeToTray) mainWindow.once('ready-to-show', () => hideToTray());
      afterStart();
    } else {
      showLogin(loginNotice);
    }
  });
}
