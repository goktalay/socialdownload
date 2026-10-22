'use strict';

// Mastertool hesabı ve uçtan uca şifreli kütüphane senkronu (mastertool.download, sözleşme v1).
// Kardeş uygulamalardaki account.js'in Social Download uyarlaması: uçlar /api/sd/*, şifreleme anahtarı "sdl-enc-v1".
// Social Download'un kütüphanesi: ayarlar (tema, dil, indirme tercihleri) ve isteğe bağlı indirme GEÇMİŞİ (bağlantı, başlık,
// platform, biçim, tarih). İndirilen DOSYALARIN kendisi, dosya yolları ve indirme klasörü hiçbir zaman gönderilmez.
//
// Anahtarlar istemcide türetilir; sunucu ne şifreyi ne de şifreleme anahtarını görür:
//   master   = PBKDF2-SHA256(şifre, salt, iter, 32B)
//   encKey   = HKDF-SHA256(master, salt = boş, info = "sdl-enc-v1", 32B)   → AES-256-GCM
//   authHash = base64(PBKDF2-SHA256(master, şifre, 1, 32B))                → girişte gönderilen tek değer
// Kütüphane blob'u: base64(iv12 ‖ şifreli metin ‖ tag16), açık metni { schema: 1, items: [...] }.
//
// Ortak oturum (SSO, Mastertool sözleşmesi): şifreyle girişte sunucu bir sso_token da verir; bu ve master anahtar
// Windows Kimlik Bilgisi Yöneticisi'nde ortak kimlik olarak saklanır (bkz. sso.js). Diğer Mastertool uygulamaları
// buradan şifresiz girer (POST /auth/sso). Herhangi birinde çıkış ortak kimliği siler ve durum dosyasıyla hepsine duyurur.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const API_BASE = (process.env.SD_API || 'https://mastertool.download').replace(/\/+$/, '');
const APP = 'sd';
const ENC_INFO = 'sdl-enc-v1';
const SYNC_DEBOUNCE_MS = 3000;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BLOB_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Kriptografi
// ---------------------------------------------------------------------------
const pbkdf2 = (pass, salt, iter, len) =>
  new Promise((resolve, reject) => crypto.pbkdf2(pass, salt, iter, len, 'sha256', (e, k) => (e ? reject(e) : resolve(k))));

async function deriveKeys(password, kdf) {
  if (!kdf || kdf.alg !== 'PBKDF2-SHA256') throw Object.assign(new Error('unsupported_kdf'), { code: 'unsupported_kdf' });
  const pw = Buffer.from(password, 'utf8');
  const master = await pbkdf2(pw, Buffer.from(kdf.salt, 'base64'), kdf.iter, 32);
  const authHash = (await pbkdf2(master, pw, 1, 32)).toString('base64');
  const encKey = encKeyFromMaster(master);
  return { authHash, encKey, master };
}

// Ortak kimlikten gelen master ile (şifre olmadan) şifreleme anahtarı
function encKeyFromMaster(master) {
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), Buffer.from(ENC_INFO), 32));
}

function encryptLibrary(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, ct, c.getAuthTag()]).toString('base64');
}

function decryptLibrary(key, blob) {
  const buf = Buffer.from(blob, 'base64');
  if (buf.length < 29) throw Object.assign(new Error('decrypt_failed'), { code: 'decrypt_failed' });
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const pt = Buffer.concat([d.update(buf.subarray(12, buf.length - 16)), d.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch {
    throw Object.assign(new Error('decrypt_failed'), { code: 'decrypt_failed' });
  }
}

// Anahtar sırası sabit JSON (içerik değişti mi karşılaştırması için)
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v === undefined ? null : v);
}
const hashOf = (data) => crypto.createHash('sha256').update(stable(data)).digest('base64');

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

async function api(method, route, { token, body, timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(API_BASE + route, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
  } catch {
    throw new ApiError(0, 'offline', 'offline');
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = await res.json(); } catch { /* boş gövde */ }
  if (!res.ok) {
    const code = (json && (json.code || json.detail)) || `http_${res.status}`;
    const err = new ApiError(res.status, code, json && json.message);
    err.body = json;
    throw err;
  }
  return json || {};
}

const route = (p) => `/api/${APP}${p}`;

// ---------------------------------------------------------------------------
// Hesap + senkron yöneticisi
// ---------------------------------------------------------------------------
function createAccount(deps) {
  // deps: { userDataDir, appVersion, encrypt, decrypt, getStore, replaceLibrary, persistStore, resetSyncMeta,
  //         onStatus, onSessionExpired, onUpdate, sso?, onSharedSignIn?, onSharedSignOut? }
  const sso = deps.sso || null; // cihazda ortak oturum; yoksa (kimlik deposu açılamadı) yalnız bu uygulama
  const file = path.join(deps.userDataDir, 'account.json');

  // Kalıcı alanlar (token ve anahtar yalnız "Beni hatırla" seçiliyse ve DPAPI ile şifreli yazılır)
  let saved = { deviceId: crypto.randomUUID(), email: '', remember: true, lastUserId: null };
  try { saved = { ...saved, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* ilk açılış */ }

  // Oturum (bellekte)
  let session = null; // { token, user, encKey: Buffer, kdfSalt, syncEnabled }
  if (saved.token && saved.encKey) {
    try {
      session = {
        token: deps.decrypt(saved.token),
        encKey: Buffer.from(deps.decrypt(saved.encKey), 'base64'),
        user: saved.user,
        kdfSalt: saved.kdfSalt,
        syncEnabled: saved.syncEnabled !== false,
      };
    } catch { session = null; }
  }

  const status = { state: 'idle', lastSyncAt: saved.lastSyncAt || null, error: null, libraryVersion: saved.libraryVersion ?? null };

  // Bu oturumun türediği / yazdığı ortak kimliğin sso_token'ı (yalnız bellekte; ortak kimlikle karşılaştırmak için)
  let ssoToken = null;
  if (session && sso) { const c = sso.readCredential(); ssoToken = c ? c.sso_token : null; }
  let watcher = null;
  const bump = (state) => {
    if (!sso) return;
    try { const st = sso.bumpState(state); if (watcher) watcher.seen(st.gen); } catch { /* durum dosyası yazılamadı */ }
  };
  const dropShared = () => { if (sso) { sso.deleteCredential(); ssoToken = null; bump('out'); } };

  function persist() {
    const out = { ...saved };
    if (session && saved.remember) {
      out.token = deps.encrypt(session.token);
      out.encKey = deps.encrypt(session.encKey.toString('base64'));
      out.user = session.user;
      out.kdfSalt = session.kdfSalt;
      out.syncEnabled = session.syncEnabled;
    } else {
      delete out.token; delete out.encKey;
    }
    out.lastSyncAt = status.lastSyncAt;
    out.libraryVersion = status.libraryVersion;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
  }

  function publicState() {
    return {
      loggedIn: !!session,
      user: session ? session.user : null,
      email: saved.email,
      syncEnabled: session ? session.syncEnabled : false,
      ...status,
    };
  }

  function setStatus(patch) {
    Object.assign(status, patch);
    deps.onStatus(publicState());
  }

  const deviceName = () => `${os.hostname()} (Windows)`.slice(0, 120);

  // --- Kimlik doğrulama ----------------------------------------------------
  async function login(email, password, remember) {
    email = String(email || '').trim().toLowerCase();
    const pre = await api('POST', route('/auth/prelogin'), { body: { email } });
    let { authHash, encKey: key, master } = await deriveKeys(password, pre.kdf);
    const res = await api('POST', route('/auth/login'), {
      body: { email, auth_hash: authHash, device: deviceName(), app_version: String(deps.appVersion).slice(0, 30), sso: !!sso },
    });
    // Sunucu girişte güncel kdf'yi döner; tuz farklıysa (şifre başka yerde değişmiş) anahtarı yeniden türet
    const kdf = res.kdf || pre.kdf;
    if (kdf.salt !== pre.kdf.salt || Number(kdf.iter) !== Number(pre.kdf.iter)) ({ encKey: key, master } = await deriveKeys(password, kdf));

    // Ortak kimliği yaz: diğer Mastertool uygulamaları artık şifre sormaz
    if (sso && res.sso_token) {
      try {
        sso.writeCredential({ email: (res.user && res.user.email) || email, user: res.user, sso_token: res.sso_token, master, kdf });
        ssoToken = res.sso_token;
        bump('in');
      } catch { /* kimlik deposu yazılamadı: yalnız bu uygulamada oturum açılır */ }
    }
    master.fill(0);

    // Farklı bir hesapla giriş: bu bilgisayardaki ayarlar ve geçmiş o hesabınkiyle birleştirilmez; hesaptaki kazanır
    const otherUser = !!(saved.lastUserId && saved.lastUserId !== res.user.id);
    if (otherUser) deps.resetSyncMeta();

    session = { token: res.token, user: res.user, encKey: key, kdfSalt: (res.kdf || pre.kdf).salt, syncEnabled: res.sync_enabled !== false };
    saved.email = email;
    saved.remember = !!remember;
    saved.lastUserId = res.user.id;
    if (otherUser) { status.libraryVersion = null; status.lastSyncAt = null; }
    persist();
    setStatus({ error: null });
    return { otherUser };
  }

  // Çıkış tüm Mastertool uygulamalarını kapatır: sunucuda oturum sonlandırılır, ortak kimlik silinir, durum "out"
  async function logout() {
    const token = session && session.token;
    session = null;
    stopTimers();
    persist();
    setStatus({ state: 'idle', error: null });
    dropShared();
    if (token) await api('POST', route('/auth/logout'), { token, timeout: 8000 }).catch(() => {});
  }

  // Ortak kimlikle şifresiz giriş. { ok, otherUser } | { ok: false, code }
  async function signInWithShared(cred) {
    let res;
    try {
      res = await api('POST', route('/auth/sso'), {
        body: { sso_token: cred.sso_token, device: deviceName(), app_version: String(deps.appVersion).slice(0, 30) },
      });
    } catch (e) {
      // Ortak oturum geçersiz (süresi doldu, şifre değişti, oturum kapatıldı): tüm aile için sil
      if (e.status === 401) dropShared();
      return { ok: false, code: e.code || 'error' };
    }
    const master = Buffer.from(String(cred.master || ''), 'base64');
    if (master.length !== 32) return { ok: false, code: 'bad_credential' };
    // Sunucudaki tuz ortak kimliktekinden farklıysa (şifre değişmiş) master artık geçersizdir
    if (res.kdf && cred.kdf && res.kdf.salt !== cred.kdf.salt) { master.fill(0); dropShared(); return { ok: false, code: 'session_expired' }; }
    const key = encKeyFromMaster(master);
    master.fill(0);
    const otherUser = !!(saved.lastUserId && saved.lastUserId !== res.user.id);
    if (otherUser) deps.resetSyncMeta();
    session = { token: res.token, user: res.user, encKey: key, kdfSalt: (res.kdf || cred.kdf || {}).salt, syncEnabled: res.sync_enabled !== false };
    ssoToken = cred.sso_token;
    saved.email = String(cred.email || (res.user && res.user.email) || '');
    saved.remember = true;
    saved.lastUserId = res.user.id;
    if (otherUser) { status.libraryVersion = null; status.lastSyncAt = null; }
    persist();
    setStatus({ error: null });
    return { ok: true, otherUser };
  }

  // Açılışta ve giriş ekranında: ortak kimlik varsa şifresiz gir
  async function trySharedSignIn() {
    if (session) return { ok: true };
    if (!sso) return { ok: false, code: 'none' };
    const cred = sso.readCredential();
    if (!cred) return { ok: false, code: 'none' };
    return signInWithShared(cred);
  }

  // Durum dosyası değişti (başka bir uygulama giriş/çıkış yaptı): asıl bilgi ortak kimlikten okunur
  let syncing = false;
  async function syncFromShared() {
    if (!sso || syncing) return;
    syncing = true;
    try {
      const cred = sso.readCredential();
      if (!cred) {
        if (!session) return;
        // Başka bir uygulamada çıkış yapıldı: burada da oturumu kapat (yerel veriler kalır)
        const token = session.token;
        session = null;
        ssoToken = null;
        stopTimers();
        persist();
        setStatus({ state: 'idle', error: null });
        api('POST', route('/auth/logout'), { token, timeout: 8000 }).catch(() => {});
        if (deps.onSharedSignOut) deps.onSharedSignOut();
        return;
      }
      if (session && cred.sso_token === ssoToken) return; // zaten bu ortak oturumla açığız
      const wasIn = !!session;
      if (wasIn) { stopTimers(); session = null; persist(); }
      const r = await signInWithShared(cred);
      if (r.ok) { if (deps.onSharedSignIn) deps.onSharedSignIn(r); }
      else if (wasIn && deps.onSharedSignOut) deps.onSharedSignOut(r.code);
    } finally {
      syncing = false;
    }
  }

  function watchShared() {
    if (!sso || watcher) return;
    try { watcher = sso.watch(() => { syncFromShared().catch(() => {}); }); } catch { watcher = null; }
  }

  function stopWatching() {
    if (watcher) watcher.stop();
    watcher = null;
  }

  // Oturum sunucuda geçersiz: 401 session_expired, ya da 403 app_disabled (yönetici bu hesapta
  // Social Download'u kapattı) / wrong_app (başka uygulamanın oturumu). Yerel veriler korunur.
  function expire(code = 'session_expired') {
    // Hesap oturumu düştüyse tüm aile kapanır; lisans (app_disabled) ve wrong_app yalnız bu uygulamayı ilgilendirir
    if (code === 'session_expired') dropShared();
    session = null;
    stopTimers();
    persist();
    setStatus({ state: 'idle', error: code });
    deps.onSessionExpired(code);
  }

  async function authed(method, r, body) {
    if (!session) throw new ApiError(401, 'session_expired');
    try {
      return await api(method, r, { token: session.token, body });
    } catch (e) {
      if (e.status === 401) expire('session_expired');
      else if (e.status === 403 && ['app_disabled', 'wrong_app'].includes(e.code)) expire(e.code);
      throw e;
    }
  }

  // --- Yerel kütüphane ↔ senkron öğeleri ------------------------------------
  // Her öğe: { id, kind, updated_at, rev, device, deleted, data }
  const meta = () => {
    const st = deps.getStore();
    if (!st.syncMeta) st.syncMeta = {};
    return st.syncMeta;
  };

  // Senkronlanan ayarlar (bkz. README › Veri modeli). Cihaza özgü olanlar (indirme klasörü, Windows ile başlat, tepsi,
  // pano algılama) gönderilmez. Geçmiş öğeleri yalnız "geçmişi senkronize et" açıkken (settings.syncHistory) gönderilir.
  const SETTINGS_FIELDS = ['appTheme', 'language', 'download', 'syncHistory'];
  const SETTINGS_ID = 'settings';
  const HISTORY_FIELDS = ['url', 'title', 'platform', 'uploader', 'duration', 'label', 'finishedAt'];
  const HISTORY_SYNC_MAX = 200;

  const pick = (o, fields) => { const out = {}; for (const k of fields) out[k] = o[k] ?? null; return out; };

  // Yerel deponun o anki halinden öğe verileri
  function currentData() {
    const st = deps.getStore();
    const out = new Map();
    const settings = {};
    for (const k of SETTINGS_FIELDS) settings[k] = st.settings[k] ?? null;
    out.set(SETTINGS_ID, { kind: 'settings', data: settings });
    if (st.settings.syncHistory !== false) {
      for (const h of (st.history || []).slice(0, HISTORY_SYNC_MAX)) out.set(h.id, { kind: 'history', data: pick(h, HISTORY_FIELDS) });
    }
    return out;
  }

  // Değişen/eklenen/silinen yerel öğelerin zaman damgasını ve rev'ini ilerlet
  function refreshMeta() {
    const m = meta();
    const now = Date.now();
    const cur = currentData();
    let changed = false;
    for (const [id, { kind, data }] of cur) {
      const h = hashOf(data);
      const old = m[id];
      if (!old || old.deleted || old.hash !== h) {
        // Bu cihazın ayarları ilk kez kayda geçiyorsa (yeni kurulum ya da yeni hesap) en eski zamanı alır;
        // böylece hesapta kayıtlı ayarlar varsayılan değerlerin üzerine yazılmaz, yoksa bunlar yüklenir.
        const fresh = id === SETTINGS_ID && !old;
        m[id] = { kind, hash: h, updated_at: fresh ? 0 : now, rev: (old ? old.rev : 0) + 1, device: saved.deviceId, deleted: false };
        changed = true;
      }
    }
    for (const [id, old] of Object.entries(m)) {
      if (!cur.has(id) && !old.deleted) {
        m[id] = { ...old, hash: null, deleted: true, updated_at: now, rev: old.rev + 1, device: saved.deviceId };
        changed = true;
      }
      if (m[id].deleted && now - m[id].updated_at > TOMBSTONE_TTL_MS) { delete m[id]; changed = true; }
    }
    return { cur, changed };
  }

  function localItems() {
    const { cur, changed } = refreshMeta();
    if (changed) deps.persistStore(); // zaman damgaları hemen diske; yoksa yeniden açılışta tekrar "değişti" sayılır
    const m = meta();
    return Object.entries(m).map(([id, x]) => ({
      id, kind: x.kind, updated_at: x.updated_at, rev: x.rev, device: x.device, deleted: !!x.deleted,
      data: x.deleted ? null : cur.get(id).data,
    }));
  }

  // Aynı id'de: büyük updated_at → büyük rev → büyük cihaz id'si kazanır (deterministik)
  const newer = (a, b) =>
    a.updated_at !== b.updated_at ? a.updated_at > b.updated_at : (a.rev || 0) !== (b.rev || 0) ? (a.rev || 0) > (b.rev || 0) : String(a.device || '') > String(b.device || '');

  function merge(a, b) {
    const map = new Map();
    for (const it of [...a, ...b]) {
      const prev = map.get(it.id);
      if (!prev || newer(it, prev)) map.set(it.id, it);
    }
    const now = Date.now();
    return [...map.values()].filter((it) => !(it.deleted && now - it.updated_at > TOMBSTONE_TTL_MS));
  }

  const itemsKey = (items) => stable([...items].sort((x, y) => (x.id < y.id ? -1 : 1)).map((x) => [x.id, x.updated_at, x.rev, x.deleted]));

  // Birleştirilmiş öğeleri yerel depoya uygula
  function applyItems(items) {
    const s = items.find((x) => x.kind === 'settings' && !x.deleted && x.data);
    const settings = {};
    if (s) for (const k of SETTINGS_FIELDS) if (k in s.data && s.data[k] !== null) settings[k] = s.data[k];
    const history = items.filter((x) => x.kind === 'history' && !x.deleted && x.data).map((x) => ({ id: x.id, ...pick(x.data, HISTORY_FIELDS) }));
    const m = {};
    for (const it of items) {
      m[it.id] = { kind: it.kind, hash: null, updated_at: it.updated_at, rev: it.rev || 0, device: it.device, deleted: !!it.deleted };
    }
    deps.replaceLibrary({ settings, history, syncMeta: m });
    // Uygulanan verinin özetini kaydet ki yerel değişiklik sanılmasın
    const cur = currentData();
    for (const [id, x] of Object.entries(m)) if (!x.deleted && cur.has(id)) x.hash = hashOf(cur.get(id).data);
    deps.persistStore();
  }

  // --- Senkron döngüsü --------------------------------------------------------
  let running = null;
  let again = false;

  async function syncOnce() {
    if (!session) return;
    if (!session.syncEnabled) { setStatus({ state: 'off', error: null }); return; }
    setStatus({ state: 'syncing', error: null });
    try {
      const local = localItems();
      let remote = await authed('GET', route('/library'));
      for (let attempt = 0; attempt < 4; attempt++) {
        let remoteItems = [];
        if (remote.blob) {
          const lib = decryptLibrary(session.encKey, remote.blob);
          remoteItems = Array.isArray(lib.items) ? lib.items : [];
        }
        // Bu cihazın ayarları hiç senkronlanmamışsa (updated_at 0) hesaptaki ayarlar kazanır
        const remoteHasSettings = remoteItems.some((x) => x.id === SETTINGS_ID && !x.deleted);
        const merged = merge(remoteHasSettings ? local.filter((x) => !(x.id === SETTINGS_ID && !x.updated_at)) : local, remoteItems);
        if (itemsKey(merged) !== itemsKey(local)) applyItems(merged);
        if (remote.blob && itemsKey(merged) === itemsKey(remoteItems)) {
          status.libraryVersion = remote.version;
          break; // sunucu zaten güncel
        }
        const blob = encryptLibrary(session.encKey, { schema: 1, items: merged });
        if (Buffer.byteLength(blob) > MAX_BLOB_BYTES) throw new ApiError(413, 'too_large');
        try {
          const put = await authed('PUT', route('/library'), { base_version: remote.version ?? null, blob });
          status.libraryVersion = put.version;
          break;
        } catch (e) {
          if (e.status !== 409 || !e.body) throw e;
          remote = { version: e.body.version, blob: e.body.blob }; // çakışma: sunucudaki yeni hali birleştirip tekrar dene
          local.splice(0, local.length, ...merged);
        }
      }
      status.lastSyncAt = Date.now();
      persist();
      setStatus({ state: 'ok', error: null });
    } catch (e) {
      const code = e.code || 'error';
      if (code === 'session_expired') return;
      setStatus({ state: code === 'offline' ? 'offline' : 'error', error: code, errorMessage: e.message });
    }
  }

  function syncNow() {
    if (!session) return Promise.resolve();
    if (running) { again = true; return running; }
    running = syncOnce().finally(() => {
      running = null;
      if (again) { again = false; syncNow(); }
    });
    return running;
  }

  let debounce = null;
  let interval = null;
  function onLocalChange() {
    if (!session || !session.syncEnabled) return;
    clearTimeout(debounce);
    debounce = setTimeout(syncNow, SYNC_DEBOUNCE_MS);
  }
  function startTimers() {
    stopTimers();
    interval = setInterval(syncNow, SYNC_INTERVAL_MS);
  }
  function stopTimers() {
    clearTimeout(debounce);
    clearInterval(interval);
    debounce = interval = null;
  }

  // Açılış: oturum geçerli mi, senkron açık mı, yeni sürüm var mı
  async function start() {
    if (!session) return;
    startTimers();
    try {
      const me = await authed('GET', route('/me'));
      session.user = me.user || session.user;
      session.syncEnabled = me.sync_enabled !== false;
      if (me.kdf && session.kdfSalt && me.kdf.salt !== session.kdfSalt) return expire(); // şifre başka yerde değişti
      persist();
    } catch (e) {
      if (e.status === 401 || e.status === 403) return;
      setStatus({ state: e.code === 'offline' ? 'offline' : 'error', error: e.code });
    }
    await syncNow();
  }

  async function setSyncEnabled(on) {
    await authed('PUT', route('/settings'), { sync_enabled: !!on });
    session.syncEnabled = !!on;
    persist();
    setStatus({ state: on ? 'idle' : 'off' });
    if (on) syncNow();
  }

  async function deleteRemote() {
    await authed('DELETE', route('/library'));
    await setSyncEnabled(false);
    status.libraryVersion = null;
    // Sunucu kopyası gitti; yerel öğeler bir sonraki açılışta yeniden yüklenebilsin diye meta korunur
    persist();
  }

  async function checkUpdate({ manual = false } = {}) {
    try {
      const r = await authed('GET', route('/releases/latest'));
      const newer = !!(r && r.version && compareVersions(r.version, deps.appVersion) > 0);
      if (newer) deps.onUpdate({ version: r.version, notes: r.notes || '' });
      return { latest: (r && r.version) || null, current: deps.appVersion, newer };
    } catch (e) {
      if (manual) throw e;
      return null; // açılıştaki bildirim isteğe bağlı
    }
  }

  return {
    isLoggedIn: () => !!session,
    state: publicState,
    login, logout, start, syncNow, onLocalChange, setSyncEnabled, deleteRemote, checkUpdate,
    trySharedSignIn, syncFromShared, watchShared, stopWatching,
    // testler için
    _merge: merge,
  };
}

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

module.exports = { createAccount, deriveKeys, encKeyFromMaster, encryptLibrary, decryptLibrary, compareVersions, API_BASE, APP, ENC_INFO };
