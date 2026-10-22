'use strict';

// İndirme kuyruğu: durum makinesi + zamanlayıcı. İndirmenin kendisi dışarıdan verilen "runner" ile yapılır (ana süreçte
// yt-dlp; testlerde sahte), böylece kuyruk mantığı Electron ve ağ olmadan sınanır.
//
//   queued ──start──▶ running ──complete──▶ done
//     ▲  │              │  └────fail──────▶ error ──retry──▶ queued
//     │  └──pause──▶ paused ◀──pause──┘        │
//     └────resume─────┘                        │
//   queued | running | paused | error ──cancel──▶ canceled ──retry──▶ queued
//
// Duraklatılan indirme sürdürülünce kaldığı yerden devam eder (yt-dlp .part dosyası korunur); iptal edilende yarım
// dosyalar silinir (cleanup). Uygulama kapanıp açılınca "running" öğeler kuyruğa (ya da ayara göre duraklatılmışa) döner.

const STATES = ['queued', 'running', 'paused', 'done', 'error', 'canceled'];
const ACTIONS = {
  start: { from: ['queued'], to: 'running' },
  complete: { from: ['running'], to: 'done' },
  fail: { from: ['running'], to: 'error' },
  pause: { from: ['queued', 'running'], to: 'paused' },
  resume: { from: ['paused'], to: 'queued' },
  cancel: { from: ['queued', 'running', 'paused', 'error'], to: 'canceled' },
  retry: { from: ['error', 'canceled'], to: 'queued' },
};
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 4;
const MAX_ITEMS = 2000;

// Saf geçiş: izinli değilse null
function transition(state, action) {
  const a = ACTIONS[action];
  return a && a.from.includes(state) ? a.to : null;
}

const clampConcurrency = (n) => { const v = Number(n); return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, Math.round(n === undefined || n === null || n === '' || !Number.isFinite(v) ? 2 : v))); };
const isActive = (s) => s === 'queued' || s === 'running' || s === 'paused';

function createQueue(deps) {
  // deps: { runner(item, { signal, onProgress }) → Promise<{ file, size? }>, cleanup?(item), onChange?(kind, item|null),
  //         concurrency?, gapMs?, now?, setTimer?, clearTimer?, newId? }
  const now = deps.now || Date.now;
  const setTimer = deps.setTimer || setTimeout;
  const clearTimer = deps.clearTimer || clearTimeout;
  let seq = 0;
  const newId = deps.newId || (() => `q${now().toString(36)}${(seq++).toString(36)}`);
  let concurrency = clampConcurrency(deps.concurrency);
  let gapMs = Math.max(0, Number(deps.gapMs) || 0);
  let items = [];
  const runs = new Map(); // id → { token, ctl }
  let lastStart = -Infinity;
  let timer = null;
  let stopped = false;

  const emit = (kind, item) => { if (deps.onChange) deps.onChange(kind, item || null); };
  const byId = (id) => items.find((x) => x.id === id);
  const runningCount = () => items.filter((x) => x.state === 'running').length;

  function setState(item, action, patch = {}) {
    const to = transition(item.state, action);
    if (!to) return false;
    Object.assign(item, patch, { state: to });
    if (to !== 'running') item.speed = null;
    emit(action, item);
    return true;
  }

  // Kuyruktaki ilk öğeyi başlatır; nazik istek aralığı (gapMs) iki başlatma arasında beklenir
  function schedule() {
    if (stopped) return;
    if (timer) { clearTimer(timer); timer = null; }
    while (runningCount() < concurrency) {
      const next = items.find((x) => x.state === 'queued');
      if (!next) return;
      const wait = lastStart + gapMs - now();
      if (wait > 0) { timer = setTimer(() => { timer = null; schedule(); }, wait); return; }
      start(next);
    }
  }

  function start(item) {
    lastStart = now();
    const token = {};
    const ctl = new AbortController();
    runs.set(item.id, { token, ctl });
    setState(item, 'start', { startedAt: now(), attempts: (item.attempts || 0) + 1, error: null, progress: item.progress || null });
    let p;
    try {
      p = Promise.resolve(deps.runner(item, {
        signal: ctl.signal,
        onProgress: (pr) => {
          const r = runs.get(item.id);
          if (!r || r.token !== token || item.state !== 'running') return;
          item.progress = { ...(item.progress || {}), ...pr };
          if (pr && 'speed' in pr) item.speed = pr.speed;
          emit('progress', item);
        },
      }));
    } catch (e) {
      p = Promise.reject(e);
    }
    p.then((res) => {
      const r = runs.get(item.id);
      if (!r || r.token !== token) return;
      runs.delete(item.id);
      if (item.state === 'running') {
        setState(item, 'complete', { finishedAt: now(), file: (res && res.file) || null, size: (res && res.size) || null, progress: { ...(item.progress || {}), pct: 100 } });
      } else if (r.cleanup && deps.cleanup) {
        Promise.resolve().then(() => deps.cleanup(item)).catch(() => {});
      }
      schedule();
    }, (err) => {
      const r = runs.get(item.id);
      if (!r || r.token !== token) return;
      runs.delete(item.id);
      if (item.state === 'running') {
        setState(item, 'fail', { finishedAt: now(), error: { code: (err && err.code) || 'unknown', message: String((err && err.message) || '').slice(0, 500) } });
      } else if (r.cleanup && deps.cleanup) {
        // Çalışırken iptal edildi: süreç sonlandıktan sonra yarım dosyaları sil
        Promise.resolve().then(() => deps.cleanup(item)).catch(() => {});
      }
      schedule();
    });
  }

  function abortRun(id) {
    const r = runs.get(id);
    if (r) r.ctl.abort();
    return !!r;
  }

  // --- Dış arayüz -------------------------------------------------------------------------------
  // Yeni öğeler (kopyalanır). Her öğe: { url, title, platform, opts, dir, ... }
  function add(list) {
    const added = [];
    for (const raw of list || []) {
      if (items.length >= MAX_ITEMS) break;
      const item = { ...raw, id: raw.id || newId(), state: 'queued', createdAt: raw.createdAt || now(), attempts: 0, progress: null, error: null, file: null };
      items.push(item);
      added.push(item);
    }
    if (added.length) { emit('add', null); schedule(); }
    return added;
  }

  function pause(id) {
    const it = byId(id);
    if (!it) return false;
    const wasRunning = it.state === 'running';
    if (!setState(it, 'pause')) return false;
    if (wasRunning) abortRun(id);
    schedule();
    return true;
  }

  function resume(id) {
    const it = byId(id);
    if (!it || !setState(it, 'resume')) return false;
    schedule();
    return true;
  }

  function cancel(id) {
    const it = byId(id);
    if (!it) return false;
    const wasRunning = it.state === 'running';
    if (!setState(it, 'cancel', { progress: null })) return false;
    const run = wasRunning && runs.get(id);
    if (run) { run.cleanup = true; run.ctl.abort(); } else if (deps.cleanup) Promise.resolve().then(() => deps.cleanup(it)).catch(() => {});
    schedule();
    return true;
  }

  function retry(id) {
    const it = byId(id);
    if (!it || !setState(it, 'retry', { error: null, progress: null, finishedAt: null })) return false;
    schedule();
    return true;
  }

  // Kuyruktan çıkarır; sürmekte olan indirme önce iptal edilir (yarım dosyalar silinir). Biten öğenin dosyasına dokunulmaz.
  function remove(id) {
    const it = byId(id);
    if (!it) return false;
    if (isActive(it.state) || it.state === 'error') cancel(id);
    items = items.filter((x) => x.id !== id);
    emit('remove', it);
    schedule();
    return true;
  }

  function clearFinished() {
    const before = items.length;
    items = items.filter((x) => x.state !== 'done' && x.state !== 'canceled');
    if (items.length !== before) emit('remove', null);
    return before - items.length;
  }

  function pauseAll() { for (const it of [...items]) if (it.state === 'queued' || it.state === 'running') pause(it.id); }
  function resumeAll() { for (const it of [...items]) if (it.state === 'paused') setState(it, 'resume'); schedule(); }

  // Sıra değiştirme (yalnız bekleyenler anlamlı): delta = -1 yukarı, +1 aşağı
  function move(id, delta) {
    const i = items.findIndex((x) => x.id === id);
    const j = i + Math.sign(delta);
    if (i < 0 || j < 0 || j >= items.length) return false;
    [items[i], items[j]] = [items[j], items[i]];
    emit('move', null);
    return true;
  }

  function setConcurrency(n) { concurrency = clampConcurrency(n); schedule(); return concurrency; }
  function setGap(ms) { gapMs = Math.max(0, Number(ms) || 0); }

  // Kayıtlı kuyruğu geri yükler: "running" olanlar yarıda kalmıştır → resume ise kuyruğa, değilse duraklatılmışa
  function restore(list, { resume: autoResume = true } = {}) {
    items = [];
    for (const raw of (Array.isArray(list) ? list : []).slice(0, MAX_ITEMS)) {
      if (!raw || !raw.id || !STATES.includes(raw.state)) continue;
      const it = { ...raw, speed: null };
      if (it.state === 'running') it.state = autoResume ? 'queued' : 'paused';
      items.push(it);
    }
    emit('restore', null);
    schedule();
  }

  // Kapanışta: süreçler durdurulur, durumlar "running" olarak kalır ki açılışta sürdürülsün
  function shutdown() {
    stopped = true;
    if (timer) { clearTimer(timer); timer = null; }
    for (const [, r] of runs) r.ctl.abort();
    runs.clear();
  }

  // Kalıcı kayıt için sade kopya
  const snapshot = () => items.map((x) => ({ ...x }));

  return {
    add, pause, resume, cancel, retry, remove, clearFinished, pauseAll, resumeAll, move, setConcurrency, setGap, restore, shutdown, snapshot,
    get: byId, list: () => items, counts: () => STATES.reduce((o, s) => ((o[s] = items.filter((x) => x.state === s).length), o), {}),
    get concurrency() { return concurrency; },
  };
}

module.exports = { STATES, ACTIONS, MIN_CONCURRENCY, MAX_CONCURRENCY, MAX_ITEMS, transition, clampConcurrency, createQueue };
