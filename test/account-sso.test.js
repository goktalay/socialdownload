'use strict';

// Hesap ve ortak oturum (SSO) akışları — sahte /api/sd sunucusuyla. Mastertool sözleşmesi: şifreyle girişte sso:true,
// ortak kimlikle şifresiz giriş (/auth/sso), çıkışta ortak kimliği silme ve "out" duyurusu, 401'de tüm ailenin kapanması.
// Senkron: ayarlar ve (isteğe bağlı) indirme geçmişi uçtan uca şifreli ("sdl-enc-v1"); dosyalar, yollar ve indirme klasörü gönderilmez.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { memoryKeyring, tmpDir } = require('./helpers');

const SALT = 'AAECAwQFBgcICQoLDA0ODw==';
const KDF = { alg: 'PBKDF2-SHA256', iter: 1000, salt: SALT }; // testte hızlı olsun diye az tur
const calls = [];
let reply = {}; // uç → (body) => [status, json]

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ route: req.url, method: req.method, body, auth: req.headers.authorization || '' });
    const h = reply[req.url];
    const [status, json] = h ? h(body, req.method) : [404, { code: 'not_found' }];
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(json));
  });
});

let createAccount;
let encKeyFromMaster;
let deriveKeys;
let decryptLibrary;
let encryptLibrary;
let ENC_INFO;
let APP;

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.SD_API = `http://127.0.0.1:${server.address().port}`;
  ({ createAccount, encKeyFromMaster, deriveKeys, decryptLibrary, encryptLibrary, ENC_INFO, APP } = require('../src/account'));
});
test.after(() => server.close());

const { createSso } = require('../src/sso');

function makeApp(kr, stateDir, events = []) {
  const dir = tmpDir('sd-acc-');
  const store = {
    settings: { appTheme: 'system', language: null, download: { kind: 'video', height: 1080, container: 'mp4', template: '{title}', concurrency: 2 }, syncHistory: true,
      downloadDir: 'C:\\Users\\Gizli\\Videolar', openAtLogin: false, minimizeToTray: true, clipboardWatch: true },
    history: [], syncMeta: {},
  };
  const sso = createSso({ keyring: kr, stateDir, pollMs: 50 });
  const acc = createAccount({
    userDataDir: dir, appVersion: '1.0.0', sso,
    encrypt: (x) => 'b64:' + Buffer.from(x).toString('base64'),
    decrypt: (x) => Buffer.from(String(x).slice(4), 'base64').toString(),
    getStore: () => store,
    replaceLibrary: ({ settings, history, syncMeta }) => {
      Object.assign(store.settings, settings);
      if (store.settings.syncHistory !== false) store.history = history; // main.js ile aynı kural
      store.syncMeta = syncMeta;
      events.push('replace');
    },
    persistStore: () => {}, resetSyncMeta: () => { store.syncMeta = {}; events.push('reset'); },
    onStatus: () => {}, onSessionExpired: (c) => events.push('expired:' + c), onUpdate: () => {},
    onSharedSignIn: () => events.push('sharedIn'), onSharedSignOut: (c) => events.push('sharedOut' + (c ? ':' + c : '')),
  });
  return { acc, sso, events, store };
}

function serverAccepting() {
  reply = {
    '/api/sd/auth/prelogin': () => [200, { kdf: KDF }],
    '/api/sd/auth/login': (b) => [200, { token: 'app-tok-1', sso_token: b.sso ? 'sso-tok-1' : undefined, user: { id: 7, email: 'demo@ornek.com', name: 'Demo' }, sync_enabled: true, kdf: KDF }],
    '/api/sd/auth/sso': (b) => (b.sso_token === 'sso-tok-1'
      ? [200, { token: 'app-tok-2', user: { id: 7, email: 'demo@ornek.com', name: 'Demo' }, sync_enabled: true, kdf: KDF }]
      : [401, { code: 'session_expired' }]),
    '/api/sd/auth/logout': () => [200, { ok: true, sso_ended: true }],
  };
}

test('uygulama kodu "sd" ve anahtar türetme etiketi "sdl-enc-v1"', () => {
  assert.equal(APP, 'sd');
  assert.equal(ENC_INFO, 'sdl-enc-v1');
});

test('şifreyle giriş /api/sd uçlarını kullanır, sso:true gönderir, ortak kimliği yazar ve durumu "in" yapar', async () => {
  serverAccepting();
  calls.length = 0;
  const kr = memoryKeyring();
  const stateDir = tmpDir('sd-st-');
  const { acc, sso } = makeApp(kr, stateDir);
  await acc.login('Demo@Ornek.com', 'Test1234!', true);
  assert.deepEqual(calls.map((c) => c.route), ['/api/sd/auth/prelogin', '/api/sd/auth/login']);
  const login = calls.find((c) => c.route === '/api/sd/auth/login');
  assert.equal(login.body.sso, true);
  assert.equal(login.body.password, undefined); // şifre gönderilmez
  const cred = sso.readCredential();
  assert.equal(cred.sso_token, 'sso-tok-1');
  assert.equal(cred.email, 'demo@ornek.com');
  assert.equal(Buffer.from(cred.master, 'base64').length, 32);
  assert.deepEqual(sso.readState().state, 'in');
  // Ortak kimlikteki master, şifreden türetilenle aynı encKey'i verir (HKDF info "sdl-enc-v1")
  const { encKey } = await deriveKeys('Test1234!', KDF);
  assert.deepEqual(encKeyFromMaster(Buffer.from(cred.master, 'base64')), encKey);
  const crypto = require('crypto');
  assert.deepEqual(encKey, Buffer.from(crypto.hkdfSync('sha256', Buffer.from(cred.master, 'base64'), Buffer.alloc(0), Buffer.from('sdl-enc-v1'), 32)));
});

test('ikinci uygulama ortak kimlikle şifresiz girer', async () => {
  serverAccepting();
  const kr = memoryKeyring();
  const stateDir = tmpDir('sd-st-');
  const a = makeApp(kr, stateDir);
  await a.acc.login('demo@ornek.com', 'Test1234!', true);
  calls.length = 0;
  const b = makeApp(kr, stateDir);
  assert.equal(b.acc.isLoggedIn(), false);
  const r = await b.acc.trySharedSignIn();
  assert.equal(r.ok, true);
  assert.equal(b.acc.isLoggedIn(), true);
  assert.deepEqual(calls.map((c) => c.route), ['/api/sd/auth/sso']); // prelogin/şifre yok
  assert.equal(calls[0].body.sso_token, 'sso-tok-1');
});

test('çıkış: sunucuya bildirilir, ortak kimlik silinir, durum "out"; diğer uygulama da kapanır', async () => {
  serverAccepting();
  const kr = memoryKeyring();
  const stateDir = tmpDir('sd-st-');
  const a = makeApp(kr, stateDir);
  const b = makeApp(kr, stateDir);
  await a.acc.login('demo@ornek.com', 'Test1234!', true);
  await b.acc.trySharedSignIn();
  b.acc.watchShared();
  calls.length = 0;
  await a.acc.logout();
  assert.ok(calls.some((c) => c.route === '/api/sd/auth/logout' && c.auth === 'Bearer app-tok-1'));
  assert.equal(a.sso.readCredential(), null);
  assert.equal(a.sso.readState().state, 'out');
  await new Promise((r) => setTimeout(r, 250)); // izleyici (fs.watch / 50 ms yoklama)
  b.acc.stopWatching();
  assert.equal(b.acc.isLoggedIn(), false);
  assert.deepEqual(b.events, ['sharedOut']);
});

test('başka uygulamada giriş yapılınca giriş ekranındaki uygulama kendiliğinden açılır', async () => {
  serverAccepting();
  const kr = memoryKeyring();
  const stateDir = tmpDir('sd-st-');
  const b = makeApp(kr, stateDir);
  b.acc.watchShared();
  const a = makeApp(kr, stateDir);
  await a.acc.login('demo@ornek.com', 'Test1234!', true);
  await new Promise((r) => setTimeout(r, 300));
  b.acc.stopWatching();
  assert.equal(b.acc.isLoggedIn(), true);
  assert.deepEqual(b.events, ['sharedIn']);
});

test('ortak oturum geçersizse (401) ortak kimlik silinir ve durum "out" olur', async () => {
  serverAccepting();
  const kr = memoryKeyring();
  const stateDir = tmpDir('sd-st-');
  const { sso, acc } = makeApp(kr, stateDir);
  sso.writeCredential({ email: 'demo@ornek.com', user: { id: 7, name: 'Demo' }, sso_token: 'eski', master: Buffer.alloc(32, 1), kdf: KDF });
  const r = await acc.trySharedSignIn();
  assert.deepEqual([r.ok, r.code], [false, 'session_expired']);
  assert.equal(sso.readCredential(), null);
  assert.equal(sso.readState().state, 'out');
});

test('lisans kapalıysa (403 app_disabled) ortak kimlik korunur, diğer uygulamalar etkilenmez', async () => {
  serverAccepting();
  reply['/api/sd/auth/sso'] = () => [403, { code: 'app_disabled' }];
  const kr = memoryKeyring();
  const stateDir = tmpDir('sd-st-');
  const { sso, acc } = makeApp(kr, stateDir);
  sso.writeCredential({ email: 'demo@ornek.com', user: { id: 7, name: 'Demo' }, sso_token: 'sso-tok-1', master: Buffer.alloc(32, 1), kdf: KDF });
  const r = await acc.trySharedSignIn();
  assert.deepEqual([r.ok, r.code], [false, 'app_disabled']);
  assert.ok(sso.readCredential());
  assert.equal(acc.isLoggedIn(), false);
});

test('ortak kimlik deposu olmadan da (sso yok) normal giriş çalışır', async () => {
  serverAccepting();
  calls.length = 0;
  const acc = createAccount({
    userDataDir: tmpDir('sd-acc-'), appVersion: '1.0.0',
    encrypt: (x) => x, decrypt: (x) => x, getStore: () => ({ settings: {}, syncMeta: {}, history: [] }),
    replaceLibrary() {}, persistStore() {}, resetSyncMeta() {}, onStatus() {}, onSessionExpired() {}, onUpdate() {},
  });
  await acc.login('demo@ornek.com', 'Test1234!', false);
  assert.equal(acc.isLoggedIn(), true);
  assert.equal(calls.find((c) => c.route === '/api/sd/auth/login').body.sso, false);
  assert.deepEqual(await acc.trySharedSignIn(), { ok: true });
});

// --- Kütüphane senkronu: ayarlar + geçmiş, uçtan uca şifreli ("sdl-enc-v1") ---------------------------------------------
test('senkron: sunucuya yalnız şifreli ayarlar ve geçmiş gider; indirme klasörü, cihaza özgü ayarlar ve dosya yolları gitmez', async () => {
  serverAccepting();
  let lib = { version: null, blob: null };
  reply['/api/sd/me'] = () => [200, { user: { id: 7, email: 'demo@ornek.com' }, sync_enabled: true, kdf: KDF }];
  reply['/api/sd/library'] = (b) => {
    if (b && b.blob) { lib = { version: (lib.version || 0) + 1, blob: b.blob }; return [200, { version: lib.version }]; }
    return [200, lib];
  };
  reply['/api/sd/releases/latest'] = () => [200, { version: '1.2.0', notes: 'yeni' }];
  const { acc, store } = makeApp(memoryKeyring(), tmpDir('sd-st-'));
  store.settings.appTheme = 'dark';
  store.history.push({ id: 'h1', url: 'https://youtu.be/aqz-KE-bpKQ', title: 'Big Buck Bunny', platform: 'youtube', uploader: 'Blender', duration: 635, label: '1080p · MP4', finishedAt: 5, file: 'C:\\Users\\Gizli\\a.mp4' });
  await acc.login('demo@ornek.com', 'Test1234!', true);
  await acc.syncNow();
  assert.ok(lib.blob, 'blob yüklendi');
  const { encKey } = await deriveKeys('Test1234!', KDF);
  const plain = decryptLibrary(encKey, lib.blob);
  assert.equal(plain.schema, 1);
  assert.deepEqual(plain.items.map((x) => [x.id, x.kind]).sort(), [['h1', 'history'], ['settings', 'settings']]);
  const s = plain.items.find((x) => x.id === 'settings');
  assert.deepEqual(Object.keys(s.data).sort(), ['appTheme', 'download', 'language', 'syncHistory']);
  assert.equal(s.data.appTheme, 'dark');
  const h = plain.items.find((x) => x.id === 'h1');
  assert.deepEqual(h.data, { url: 'https://youtu.be/aqz-KE-bpKQ', title: 'Big Buck Bunny', platform: 'youtube', uploader: 'Blender', duration: 635, label: '1080p · MP4', finishedAt: 5 });
  const text = JSON.stringify(plain);
  assert.ok(!text.includes('Gizli') && !text.includes('downloadDir') && !text.includes('clipboardWatch') && !text.includes('minimizeToTray') && !text.includes('openAtLogin'));
  // başka uygulamanın anahtar türetme etiketi çözemez
  const crypto = require('crypto');
  const other = Buffer.from(crypto.hkdfSync('sha256', Buffer.alloc(32, 9), Buffer.alloc(0), Buffer.from('ipt-enc-v1'), 32));
  assert.throws(() => decryptLibrary(other, lib.blob), { code: 'decrypt_failed' });
  // Geçmiş senkronu kapatılınca hesaptaki geçmiş silinir (mezar taşı), yerel geçmiş kalır
  store.settings.syncHistory = false;
  await acc.syncNow();
  const plain2 = decryptLibrary(encKey, lib.blob);
  assert.equal(plain2.items.find((x) => x.id === 'h1').deleted, true);
  assert.equal(store.history.length, 1);
  // güncelleme denetimi /api/sd/releases/latest
  const up = await acc.checkUpdate({ manual: true });
  assert.deepEqual([up.latest, up.newer], ['1.2.0', true]);
  assert.ok(calls.some((c) => c.route === '/api/sd/releases/latest'));
});

test('senkron: yeni cihazda hesaptaki ayarlar ve geçmiş yüklenir, cihaza özgü ayarlar korunur', async () => {
  serverAccepting();
  const { encKey } = await deriveKeys('Test1234!', KDF);
  const T = Date.now() - 60000;
  const remote = encryptLibrary(encKey, { schema: 1, items: [
    { id: 'settings', kind: 'settings', updated_at: T, rev: 3, device: 'baska', deleted: false, data: { appTheme: 'light', language: 'de', download: { kind: 'audio', audioFormat: 'opus' }, syncHistory: true } },
    { id: 'hA', kind: 'history', updated_at: T, rev: 1, device: 'baska', deleted: false, data: { url: 'https://vimeo.com/1', title: 'A', platform: 'vimeo', uploader: null, duration: 10, label: 'MP3 · 192 kbps', finishedAt: 9 } },
    { id: 'hB', kind: 'history', updated_at: T, rev: 2, device: 'baska', deleted: true, data: null }, // silinmiş (mezar taşı) yüklenmez
  ] });
  let put = 0;
  reply['/api/sd/library'] = (b) => (b && b.blob ? (put++, [200, { version: 6 }]) : [200, { version: 5, blob: remote }]);
  const { acc, store, events } = makeApp(memoryKeyring(), tmpDir('sd-st-'));
  await acc.login('demo@ornek.com', 'Test1234!', true);
  await acc.syncNow();
  assert.ok(events.includes('replace'));
  assert.equal(store.settings.appTheme, 'light');
  assert.equal(store.settings.language, 'de');
  assert.deepEqual(store.settings.download, { kind: 'audio', audioFormat: 'opus' });
  assert.equal(store.settings.minimizeToTray, true, 'cihaza özgü ayar korunur');
  assert.equal(store.settings.downloadDir, 'C:\\Users\\Gizli\\Videolar', 'indirme klasörü korunur');
  assert.deepEqual(store.history.map((r) => r.id), ['hA']);
  assert.equal(put, 0, 'sunucu zaten güncel');
});
