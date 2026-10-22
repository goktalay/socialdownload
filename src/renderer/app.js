'use strict';

// Ana pencere: üstte bağlantı çubuğu (yapıştır → analiz), solda analiz sonucu + biçim seçimi, sağda indirme kuyruğu
// ve geçmiş. Ayarlar: Genel · İndirme · Motor · Hesap · Kısayollar · Hakkında.

const OSS = [['Social Download', 'MIT'], ['yt-dlp', 'Unlicense'], ['FFmpeg (LGPL)', 'LGPL-2.1-or-later'], ['Electron', 'MIT'], ['Chromium', 'BSD-3-Clause +'], ['Node.js', 'MIT'], ['@napi-rs/keyring', 'MIT']];
const SHOWN_PLATFORMS = ['youtube', 'instagram', 'tiktok', 'x', 'facebook', 'vimeo', 'dailymotion', 'twitch', 'reddit', 'soundcloud', 'bilibili', 'bandcamp'];
const RES_CHIPS = [0, 2160, 1440, 1080, 720, 480, 360, 240, 144];

let data = { settings: {}, history: [], limits: {}, platforms: [] };
let acct = { loggedIn: false };
let items = [];          // kuyruk
let history = [];
let tab = 'queue';
const sel = new Set();   // seçili kuyruk / geçmiş öğeleri
let anchor = null;       // shift ile aralık seçimi
let an = { status: 'idle' }; // analiz durumu
let fmt = null;          // biçim paneli seçimi { kind, height, container, audioFormat, audioQuality }
const thumbCache = new Map();

const $ = (s) => document.querySelector(s);
const IS_RTL = document.documentElement.dir === 'rtl';

// --- Biçimlendirme ---------------------------------------------------------------------------
function fmtBytes(n) {
  if (n == null || !isFinite(n)) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return ltr(`${v.toLocaleString(LANG, { maximumFractionDigits: v < 10 && i ? 1 : 0 })} ${u[i]}`);
}
function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return ltr(h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`);
}
const fmtSpeed = (b) => (b ? `${fmtBytes(b)}/${t('unit.sec')}` : '');
const heightName = (h) => (h ? FORMATS.heightLabel(h) : t('fmt.best'));
const optsLabel = (o) => FORMATS.labelOf(o, { best: t('fmt.best') });

function errText(code) {
  const k = `err.${code}`;
  const s = t(k);
  return s === k ? t('err.unknown') : s;
}

// --- Başlangıç ------------------------------------------------------------------------------
$('.url-ico').innerHTML = icon('link');
$('#url').placeholder = t('app.urlPh');
$('#btnPaste').innerHTML = icon('clipboard') + esc(t('app.paste'));
$('#btnPaste').title = `${t('app.paste')} (Ctrl+V)`;
$('#btnAnalyze').innerHTML = icon('search') + esc(t('app.analyze'));
$('#btnSettings').innerHTML = icon('gear');
$('#btnSettings').title = `${t('set.title')} (Ctrl+,)`;
$('#noticeBar').innerHTML = `${icon('shield')}<span>${esc(t('notice.short'))}</span>`;
$('.topbar').appendChild(mastertoolButton()); // en sağ üst köşe (Mastertool standardı)

$('#btnSettings').onclick = () => openSettings();
$('#btnAccount').onclick = () => openSettings('account');
$('#btnAnalyze').onclick = () => runAnalyze();
$('#btnPaste').onclick = () => pasteAndAnalyze();

const urlBox = $('#url');
function fitUrlBox() {
  urlBox.style.height = 'auto';
  urlBox.style.height = Math.min(110, urlBox.scrollHeight) + 'px';
}
urlBox.addEventListener('input', fitUrlBox);
urlBox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) { e.preventDefault(); runAnalyze(); }
});
// Yapıştırınca hemen analiz (bağlantı çubuğuna)
urlBox.addEventListener('paste', () => setTimeout(() => { fitUrlBox(); if (URLS.extract(urlBox.value).urls.length) runAnalyze(); }, 0));

// Sürükle-bırak: tarayıcıdan sürüklenen bağlantı
const urlbar = $('#urlbar');
document.addEventListener('dragover', (e) => { e.preventDefault(); urlbar.classList.add('drop'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) urlbar.classList.remove('drop'); });
document.addEventListener('drop', (e) => {
  e.preventDefault();
  urlbar.classList.remove('drop');
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (text) { urlBox.value = text.trim(); fitUrlBox(); runAnalyze(); }
});

// --- Kısayollar --------------------------------------------------------------------------------
const SHORTCUTS = [
  ['Ctrl+V', 'keys.paste'], ['Enter', 'keys.analyze'], ['Ctrl+Enter', 'keys.download'], ['Ctrl+L', 'keys.focusUrl'],
  ['Del', 'keys.remove'], ['Space', 'keys.pause'], ['F5', 'keys.retry'], ['Ctrl+A', 'keys.selectAll'], ['Ctrl+O', 'keys.openDir'],
  ['Ctrl+1 / Ctrl+2', 'keys.tabs'], ['Ctrl+,', 'keys.settings'], ['Esc', 'keys.escape'],
];

document.addEventListener('keydown', (e) => {
  if (document.querySelector('.modal-backdrop')) return;
  const tag = document.activeElement && document.activeElement.tagName;
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag);
  const k = e.key.toLowerCase();
  if (e.ctrlKey && k === 'v' && !inInput) { e.preventDefault(); pasteAndAnalyze(); return; }
  if (e.ctrlKey && k === 'l') { e.preventDefault(); urlBox.focus(); urlBox.select(); return; }
  if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); enqueueSelection(); return; }
  if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (e.ctrlKey && k === 'o') { e.preventDefault(); window.api.openDir(); return; }
  if (e.ctrlKey && (e.key === '1' || e.key === '2')) { e.preventDefault(); setTab(e.key === '1' ? 'queue' : 'history'); return; }
  if (e.key === 'Escape') {
    if (an.status === 'busy') { window.api.cancelAnalyze(); return; }
    if (inInput) { document.activeElement.blur(); return; }
    if (sel.size) { sel.clear(); renderList(); }
    return;
  }
  if (inInput) return;
  if (e.ctrlKey && k === 'a') { e.preventDefault(); for (const x of currentRows()) sel.add(x.id); renderList(); return; }
  if (e.key === 'Delete' && sel.size) { e.preventDefault(); removeSelected(); return; }
  if (e.key === ' ' && sel.size && tab === 'queue') { e.preventDefault(); togglePauseSelected(); return; }
  if (e.key === 'F5' && sel.size && tab === 'queue') { e.preventDefault(); window.api.queueOp('retry', [...sel]); return; }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && currentRows().length) {
    e.preventDefault();
    const rows = currentRows();
    const cur = rows.findIndex((x) => x.id === anchor);
    const next = Math.max(0, Math.min(rows.length - 1, cur < 0 ? 0 : cur + (e.key === 'ArrowDown' ? 1 : -1)));
    sel.clear(); sel.add(rows[next].id); anchor = rows[next].id;
    renderList();
    const el = document.querySelector(`[data-id="${CSS.escape(anchor)}"]`);
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
});

// --- Veri akışları -------------------------------------------------------------------------------
window.api.onStoreChanged((d) => { data = d; history = d.history || history; paintStats(); renderTabs(); renderTools(); if (an.status === 'done') renderFormat(); if (!data.settings.noticeAccepted) showNotice(); });
window.api.getStore().then((d) => {
  data = d;
  history = d.history || [];
  paintStats();
  renderTabs();
  renderTools();
  renderAnalysis();
  if (!data.settings.noticeAccepted) showNotice();
});
window.api.getQueue().then((q) => { items = q; paintStats(); renderTabs(); renderList(); });
window.api.onQueueChanged((q) => {
  items = q;
  for (const id of [...sel]) if (tab === 'queue' && !items.some((x) => x.id === id)) sel.delete(id);
  paintStats(); renderTabs(); renderTools(); renderList();
});
window.api.onQueueProgress((p) => {
  const it = items.find((x) => x.id === p.id);
  if (!it) return;
  it.progress = p.progress;
  it.speed = p.speed;
  if (p.progress && p.progress.meta && p.progress.meta.title && !it.title) it.title = p.progress.meta.title;
  const row = document.querySelector(`.q-item[data-id="${CSS.escape(p.id)}"]`);
  if (!row) return;
  row.querySelector('.progress > div').style.width = `${(p.progress && p.progress.pct) || 0}%`;
  row.querySelector('.q-status').innerHTML = statusText(it);
});
window.api.onHistoryChanged((h) => { history = h; renderTabs(); if (tab === 'history') renderList(); });
window.api.onAnalyzeProgress((p) => { if (an.status === 'busy') { an.progress = p; renderAnalysis(); } });
window.api.onClipboardOffer((o) => showClipOffer(o.urls));

// --- Hesap ve senkron durumu -----------------------------------------------------------------
function syncText(st) {
  if (!st.syncEnabled || st.state === 'off') return t('sync.off');
  if (st.state === 'syncing') return t('sync.syncing');
  if (st.state === 'offline') return t('sync.offline');
  if (st.state === 'error') {
    if (st.error === 'decrypt_failed') return t('sync.errDecrypt');
    if (st.error === 'too_large') return t('sync.errTooLarge');
    return t('sync.error', { msg: st.errorMessage || st.error });
  }
  return st.lastSyncAt ? t('acct.lastSync', { time: formatDate(st.lastSyncAt) }) : t('acct.never');
}
function paintAccount() {
  const b = $('#btnAccount');
  const email = (acct.user && acct.user.email) || acct.email || '';
  const name = (acct.user && acct.user.name) || email;
  b.querySelector('.ac-avatar').textContent = (name || '?').trim().charAt(0).toUpperCase();
  const st = !acct.syncEnabled ? 'off' : acct.state || 'idle';
  b.className = `account-chip s-${st}`;
  b.querySelector('.ac-sync').innerHTML = st === 'syncing' ? '<span class="spin"></span>' : icon(st === 'off' || st === 'offline' ? 'cloudOff' : 'cloud');
  b.title = `${email}\n${syncText(acct)}`;
  const el = $('#acct-status');
  if (el) el.textContent = syncText(acct);
}
window.api.onAccountStatus((st) => { acct = st; paintAccount(); });
window.api.accountState().then((st) => { acct = st; paintAccount(); });

function showUpdate(info) {
  if (!info) return;
  const bar = $('#updateBar');
  bar.innerHTML = `${icon('bolt')}<span><b>${esc(t('update.available', { version: info.version }))}</b> — ${esc(t('update.hint'))}</span>
    <button class="btn sm" type="button">${icon('open')}${esc(t('update.open'))}</button>`;
  bar.querySelector('button').onclick = () => window.api.openWeb('account');
  bar.classList.remove('hidden');
}
window.api.onUpdateAvailable(showUpdate);
window.api.about().then((a) => { showUpdate(a.update); if (a.engine && !a.engine.ytdlpPath) showEngineBar({ missing: true }); });

// Motor çubuğu: yeni yt-dlp sürümü var ya da motor bulunamadı
function showEngineBar(st) {
  const bar = $('#engineBar');
  if (!st || (!st.missing && !st.newer)) { bar.classList.add('hidden'); return; }
  bar.classList.toggle('err', !!st.missing);
  bar.innerHTML = st.missing
    ? `${icon('alert')}<span><b>${esc(t('eng.missing'))}</b> — ${esc(t('eng.missingHint'))}</span>`
    : `${icon('cpu')}<span><b>${esc(t('eng.newer', { version: st.latest }))}</b> — ${esc(t('eng.newerHint'))}</span>
       <button class="btn sm" type="button" id="eb-upd">${icon('refresh')}${esc(t('eng.update'))}</button>`;
  const b = bar.querySelector('#eb-upd');
  if (b) b.onclick = () => openSettings('engine');
  bar.classList.remove('hidden');
}
window.api.onEngineStatus((st) => showEngineBar(st));

// İlk açılış: hukuki uyarı (onaylanmadan analiz yapılmaz)
let noticeOpen = false;
async function showNotice() {
  if (noticeOpen) return;
  noticeOpen = true;
  await openModal({
    title: t('notice.title'), iconName: 'shield', closable: false, width: 560,
    body: `<div class="notice-body">${icon('alert')}<div><p><b>${esc(t('notice.text'))}</b></p>
      <ul><li>${esc(t('notice.l1'))}</li><li>${esc(t('notice.l2'))}</li><li>${esc(t('notice.l3'))}</li><li>${esc(t('notice.l4'))}</li></ul></div></div>`,
    buttons: [{ label: t('notice.accept'), cls: 'primary', icon: 'check', value: true }],
  });
  noticeOpen = false;
  await window.api.acceptNotice();
}

function paintStats() {
  const c = { running: 0, queued: 0, done: 0 };
  for (const x of items) if (x.state in c) c[x.state]++;
  $('#stats').textContent = c.running || c.queued ? t('app.statsActive', { running: c.running, queued: c.queued }) : t('app.stats', { n: history.length });
}

// --- Pano ---------------------------------------------------------------------------------------
async function pasteAndAnalyze() {
  const r = await window.api.readClipboard();
  if (!r.text || !r.text.trim()) { toast(t('app.clipEmpty'), { type: 'err' }); return; }
  urlBox.value = r.urls.length ? r.urls.map((u) => u.url).join('\n') : r.text.trim().slice(0, 4000);
  fitUrlBox();
  runAnalyze();
}

function showClipOffer(urls) {
  const bar = $('#clipBar');
  if (!urls || !urls.length || an.status === 'busy') return;
  const first = urls[0];
  bar.innerHTML = `${icon('clipboard')}<span>${esc(t('clip.offer'))} <b>${esc(urls.length > 1 ? t('clip.many', { n: urls.length }) : first.url)}</b></span>
    <button class="btn sm primary" type="button" id="cb-go">${icon('search')}${esc(t('app.analyze'))}</button>
    <button class="icon-btn" type="button" id="cb-x" title="${esc(t('common.close'))}">${icon('x')}</button>`;
  bar.classList.remove('hidden');
  bar.querySelector('#cb-go').onclick = () => { bar.classList.add('hidden'); urlBox.value = urls.map((u) => u.url).join('\n'); fitUrlBox(); runAnalyze(); };
  bar.querySelector('#cb-x').onclick = () => bar.classList.add('hidden');
}

// --- Analiz -------------------------------------------------------------------------------------
async function runAnalyze({ playlist = false, text = null } = {}) {
  const input = text != null ? text : urlBox.value;
  if (!input.trim()) { urlBox.focus(); toast(t('err.no_url'), { type: 'err' }); return; }
  const pre = URLS.extract(input);
  if (!pre.urls.length) { toast(errText(pre.rejected.length ? pre.rejected[0].code : 'no_url'), { type: 'err', sub: pre.rejected[0] ? pre.rejected[0].text : '' }); return; }
  $('#clipBar').classList.add('hidden');
  an = { status: 'busy', progress: { done: 0, total: pre.urls.length, url: pre.urls[0].url }, input };
  renderAnalysis();
  const r = await window.api.analyze(input, playlist);
  if (!r.ok) {
    an = { status: 'idle' };
    renderAnalysis();
    if (r.code === 'notice') return showNotice();
    if (r.code === 'engine_missing') showEngineBar({ missing: true });
    toast(errText(r.code), { type: 'err' });
    return;
  }
  if (r.canceled && !r.results.length) { an = { status: 'idle' }; renderAnalysis(); return; }
  if (!fmt) fmt = { ...FORMATS.sanitizeOpts(data.settings.download || {}) };
  an = { status: 'done', results: r.results, rejected: r.rejected || [], skipped: r.skipped || 0, input };
  buildEntries();
  renderAnalysis();
  if (r.skipped) toast(t('an.skipped', { n: r.skipped }));
}

// Sonuçlar → seçilebilir öğe listesi
function buildEntries() {
  const list = [];
  for (const [ri, res] of an.results.entries()) {
    if (!res.ok) { list.push({ key: `e${ri}`, error: res.code, message: res.message, url: res.url, platform: res.platform || URLS.platformOf(res.url).id }); continue; }
    const r = res.result;
    if (r.kind === 'single') {
      list.push({ key: `s${ri}`, url: r.url, title: r.title, platform: r.platform, thumbnail: r.thumbnail, duration: r.duration, uploader: r.uploader, options: r.options, single: r, hint: res.hint, available: true });
    } else {
      list.push({ key: `p${ri}`, group: r });
      for (const e of r.entries) {
        list.push({ key: `p${ri}-${e.index}`, url: e.url, title: e.title, platform: e.platform, thumbnail: e.thumbnail, duration: e.duration, uploader: e.uploader || r.uploader,
          index: e.index, available: e.available && !e.live, live: e.live, playlist: { title: r.title, index: e.index, count: r.count } });
      }
    }
  }
  an.entries = list;
  an.sel = new Set(list.filter((x) => x.url && x.available).map((x) => x.key));
}

const selectable = () => (an.entries || []).filter((x) => x.url && x.available);
const selectedEntries = () => selectable().filter((x) => an.sel.has(x.key));

function renderAnalysis() {
  const box = $('#analysis');
  if (an.status === 'idle') {
    const shown = SHOWN_PLATFORMS.map((id) => `<div class="pf-cell">${platformBadge(id, { size: 20, title: false })}<span>${esc(platformName(id))}</span></div>`).join('');
    box.innerHTML = `<div class="a-scroll"><div class="welcome">
      <div class="w-ic">${icon('download')}</div>
      <h2>${esc(t('welcome.title'))}</h2>
      <p>${esc(t('welcome.body'))}</p>
      <div class="kbd-hint">${esc(t('welcome.kbd'))} <span class="kbd">Ctrl+V</span></div>
      <div class="pf-grid">${shown}</div>
      <div class="pf-more">${esc(t('welcome.more'))}</div>
    </div>
    <div class="legal">${icon('shield')}<div><b>${esc(t('notice.text'))}</b><br>${esc(t('welcome.limits'))}</div></div></div>`;
    return;
  }
  if (an.status === 'busy') {
    const p = an.progress || {};
    box.innerHTML = `<div class="busy"><span class="spin"></span><div>${esc(p.total > 1 ? t('an.busyMany', { done: (p.done || 0) + 1, total: p.total }) : t('an.busy'))}</div>
      <div class="busy-url">${esc(p.url || '')}</div><button class="btn sm" type="button" id="an-cancel">${icon('x')}${esc(t('common.cancel'))}<span class="kbd">Esc</span></button></div>`;
    box.querySelector('#an-cancel').onclick = () => window.api.cancelAnalyze();
    return;
  }
  // Sonuç
  const entries = an.entries;
  const singles = entries.filter((x) => x.single);
  const groups = entries.filter((x) => x.group);
  const errors = entries.filter((x) => x.error);
  let html = '';
  if (entries.length === 1 && singles.length === 1) html = mediaCard(singles[0]);
  else if (entries.length === 1 && errors.length === 1) html = errorCard(errors[0]);
  else {
    const n = selectable().length;
    const head = groups.length === 1 && !singles.length && !errors.length
      ? `<div class="list-head">${platformBadge(groups[0].group.platform, { size: 30 })}<div class="lh-text"><h3>${esc(groups[0].group.title || t('an.playlist'))}</h3>
          <div class="sub">${esc(t('an.playlistSub', { n: groups[0].group.count }))}${groups[0].group.uploader ? ' · ' + esc(groups[0].group.uploader) : ''}${groups[0].group.truncated ? ' · ' + esc(t('an.truncated', { n: groups[0].group.entries.length })) : ''}</div></div></div>`
      : `<div class="list-head"><div class="w-ic-sm">${icon('list')}</div><div class="lh-text"><h3>${esc(t('an.links', { n: an.results.length }))}</h3><div class="sub">${esc(t('an.linksSub', { ok: n, err: errors.length }))}</div></div></div>`;
    html = `${head}
      <div class="sel-bar"><span id="sel-count">${esc(t('an.selected', { n: an.sel.size, total: n }))}</span><span class="spacer"></span>
        <button class="linkish" type="button" id="sel-all">${esc(t('an.selectAll'))}</button><button class="linkish" type="button" id="sel-none">${esc(t('an.selectNone'))}</button></div>
      <div class="entries">${entries.map(entryRow).join('')}</div>`;
  }
  if (an.rejected && an.rejected.length) html += `<div class="note">${icon('info')}<span>${esc(t('an.rejected', { n: an.rejected.length }))} ${esc(an.rejected.slice(0, 3).map((r) => `${r.text} (${errText(r.code)})`).join(' · '))}</span></div>`;
  box.innerHTML = `<div class="a-scroll">${html}</div><div class="fmt" id="fmt"></div>`;
  wireAnalysis(box);
  renderFormat();
  loadThumbs(box);
}

function mediaCard(e) {
  const r = e.single;
  const hint = e.hint === 'video_in_playlist'
    ? `<div class="pl-hint">${icon('playlist')}<span>${esc(t('an.inPlaylist'))}</span><button class="btn sm" type="button" id="an-pl">${icon('list')}${esc(t('an.openPlaylist'))}</button></div>` : '';
  return `<div class="media">
    <div class="thumb">${r.thumbnail ? `<img data-thumb="${esc(r.thumbnail)}" alt="">` : icon('film')}${platformBadge(r.platform, { size: 26 })}${r.duration ? `<span class="dur">${fmtDur(r.duration)}</span>` : ''}</div>
    <div class="m-body"><h3>${esc(r.title)}</h3>
      <div class="m-meta">${r.uploader ? `<span>${icon('user')}${esc(r.uploader)}</span>` : ''}<span>${esc(platformName(r.platform))}</span>
        ${r.options.maxHeight ? `<span>${icon('film')}${esc(t('an.maxRes', { res: FORMATS.heightLabel(r.options.maxHeight) }))}</span>` : `<span>${icon('music')}${esc(t('an.audioOnlySrc'))}</span>`}
        ${r.uploadDate ? `<span>${icon('clock')}${esc(`${r.uploadDate.slice(0, 4)}-${r.uploadDate.slice(4, 6)}-${r.uploadDate.slice(6, 8)}`)}</span>` : ''}</div>
      <div class="m-link" id="an-src" title="${esc(t('an.openSource'))}">${esc(r.url)}</div>${hint}</div></div>`;
}

function errorCard(e) {
  return `<div class="a-error">${icon('ban')}<div><h3>${esc(t('an.failed'))}</h3><p>${esc(errText(e.error))}</p><code>${esc(e.url)}${e.message && e.message !== e.error ? '\n' + esc(e.message) : ''}</code></div></div>`;
}

function entryRow(e) {
  if (e.group) return `<div class="q-group" style="padding:8px 12px">${platformBadge(e.group.platform, { size: 16, title: false })}${esc(e.group.title || t('an.playlist'))} · ${esc(t('an.playlistSub', { n: e.group.count }))}</div>`;
  if (e.error) {
    return `<div class="entry na" data-key="${e.key}"><input type="checkbox" disabled><span></span><div class="et">${platformBadge(e.platform, { size: 20 })}</div>
      <div class="e-title"><div>${esc(e.url)}</div><small class="e-err">${esc(errText(e.error))}</small></div><span></span></div>`;
  }
  const on = an.sel.has(e.key);
  const na = !e.available;
  return `<div class="entry ${na ? 'na' : on ? '' : 'off'}" data-key="${e.key}">
    <input type="checkbox" ${on ? 'checked' : ''} ${na ? 'disabled' : ''}>
    <span class="idx">${e.index ? ltr(e.index) : ''}</span>
    <div class="et">${e.thumbnail ? `<img data-thumb="${esc(e.thumbnail)}" alt="">` : platformBadge(e.platform, { size: 20 })}</div>
    <div class="e-title"><div title="${esc(e.title)}">${esc(e.title)}</div><small>${na ? esc(e.live ? t('err.live') : t('an.unavailable')) : esc([platformName(e.platform), e.uploader].filter(Boolean).join(' · '))}</small></div>
    <span class="e-dur">${e.duration ? fmtDur(e.duration) : ''}</span></div>`;
}

function wireAnalysis(box) {
  const src = box.querySelector('#an-src');
  if (src) src.onclick = () => window.api.openSource(an.entries[0].url);
  const pl = box.querySelector('#an-pl');
  if (pl) pl.onclick = () => runAnalyze({ playlist: true, text: an.input });
  const upd = () => {
    const c = box.querySelector('#sel-count');
    if (c) c.textContent = t('an.selected', { n: an.sel.size, total: selectable().length });
    renderFormat();
  };
  box.querySelectorAll('.entry[data-key]').forEach((row) => {
    const e = an.entries.find((x) => x.key === row.dataset.key);
    if (!e || !e.url || !e.available) return;
    row.onclick = (ev) => {
      if (an.sel.has(e.key)) an.sel.delete(e.key); else an.sel.add(e.key);
      row.classList.toggle('off', !an.sel.has(e.key));
      row.querySelector('input').checked = an.sel.has(e.key);
      if (ev.target.tagName === 'INPUT') ev.stopPropagation();
      upd();
    };
    row.oncontextmenu = (ev) => { ev.preventDefault(); contextMenu(ev.clientX, ev.clientY, [
      { icon: 'open', label: t('an.openSource'), action: () => window.api.openSource(e.url) },
      { icon: 'copy', label: t('ctx.copyLink'), action: () => { window.api.copyText(e.url); toast(t('ctx.copied'), { type: 'ok', timeout: 1500 }); } },
    ]); };
  });
  const all = box.querySelector('#sel-all');
  if (all) all.onclick = () => { for (const x of selectable()) an.sel.add(x.key); renderAnalysis(); };
  const none = box.querySelector('#sel-none');
  if (none) none.onclick = () => { an.sel.clear(); renderAnalysis(); };
}

// Biçim paneli: tür, çözünürlük, kapsayıcı / ses biçimi, hedef klasör, İndir
function renderFormat() {
  const el = $('#fmt');
  if (!el || an.status !== 'done') return;
  const lim = data.limits || {};
  const n = selectedEntries().length;
  const singles = an.entries.filter((x) => x.single);
  const only = an.entries.length === 1 && singles.length === 1 ? singles[0].single : null;
  const avail = only ? only.options.heights : null;
  const videoOk = !only || only.options.video;
  if (!videoOk && fmt.kind === 'video') fmt.kind = 'audio';
  let note = '';
  if (fmt.kind === 'video') {
    if (only) {
      const r = FORMATS.resolveHeight(avail, fmt.height);
      if (fmt.height && !r.exact && r.height) note = `<div class="fmt-note warn">${icon('info')}<span>${esc(t(r.direction === 'lower' ? 'fmt.fallbackLower' : 'fmt.fallbackHigher', { want: FORMATS.heightLabel(fmt.height), got: FORMATS.heightLabel(r.height) }))}</span></div>`;
      else if (r.height) note = `<div class="fmt-note">${icon('check')}<span>${esc(t('fmt.willDownload', { res: FORMATS.heightLabel(r.height), c: fmt.container.toUpperCase() }))}</span></div>`;
    } else note = `<div class="fmt-note">${icon('info')}<span>${esc(t('fmt.listNote'))}</span></div>`;
  }
  const chips = RES_CHIPS.filter((h) => !h || !avail || avail.includes(h) || h <= 2160).map((h) => {
    const na = avail && h && !avail.includes(h);
    return `<button type="button" class="res-chip ${fmt.height === h ? 'on' : ''} ${na ? 'na' : ''}" data-h="${h}" title="${esc(na ? t('fmt.notInSource') : '')}">${esc(h ? `${h}p` : t('fmt.best'))}${h >= 1440 ? `<small>${h === 2160 ? '4K' : '2K'}</small>` : ''}</button>`;
  }).join('');
  el.innerHTML = `
    <div class="fmt-row"><label>${esc(t('fmt.type'))}</label>
      <div class="seg" id="f-kind"><button type="button" data-v="video" ${videoOk ? '' : 'disabled'}>${icon('film')}${esc(t('fmt.video'))}</button><button type="button" data-v="audio">${icon('music')}${esc(t('fmt.audioOnly'))}</button></div></div>
    ${fmt.kind === 'video' ? `
    <div class="fmt-row"><label>${esc(t('fmt.resolution'))}</label><div class="res-chips">${chips}</div></div>
    <div class="fmt-row"><label>${esc(t('fmt.container'))}</label>
      <div class="seg" id="f-cont">${(lim.containers || FORMATS.CONTAINERS).map((c) => `<button type="button" data-v="${c}">${c.toUpperCase()}</button>`).join('')}</div></div>${note}` : `
    <div class="fmt-row"><label>${esc(t('fmt.audioFormat'))}</label>
      <div class="seg" id="f-afmt">${(lim.audioFormats || FORMATS.AUDIO_FORMATS).map((c) => `<button type="button" data-v="${c}">${c === 'opus' ? 'Opus' : c.toUpperCase()}</button>`).join('')}</div>
      <select class="input" id="f-aq">${(lim.audioQualities || FORMATS.AUDIO_QUALITIES).map((q) => `<option value="${q}" ${String(fmt.audioQuality) === q ? 'selected' : ''}>${esc(q === 'best' ? t('fmt.bestQuality') : `${q} kbps`)}</option>`).join('')}</select></div>`}
    <div class="fmt-row"><div class="fmt-dest">${icon('folder')}<span title="${esc(data.settings.downloadDir || '')}">${esc(data.settings.downloadDir || '')}</span>
        <button class="linkish" type="button" id="f-dir">${esc(t('fmt.change'))}</button></div>
      <div class="fmt-go"><button class="btn primary" type="button" id="f-go" ${n ? '' : 'disabled'}>${icon('download')}${esc(n > 1 ? t('fmt.downloadN', { n }) : t('fmt.download'))}<span class="kbd">Ctrl+Enter</span></button></div></div>`;
  const segOn = (id, v) => el.querySelectorAll(`#${id} button`).forEach((b) => b.classList.toggle('on', b.dataset.v === String(v)));
  segOn('f-kind', fmt.kind);
  segOn('f-cont', fmt.container);
  segOn('f-afmt', fmt.audioFormat);
  el.querySelectorAll('#f-kind button').forEach((b) => (b.onclick = () => { fmt.kind = b.dataset.v; renderFormat(); }));
  el.querySelectorAll('#f-cont button').forEach((b) => (b.onclick = () => { fmt.container = b.dataset.v; renderFormat(); }));
  el.querySelectorAll('#f-afmt button').forEach((b) => (b.onclick = () => { fmt.audioFormat = b.dataset.v; renderFormat(); }));
  el.querySelectorAll('.res-chip').forEach((b) => (b.onclick = () => { fmt.height = Number(b.dataset.h); renderFormat(); }));
  const aq = el.querySelector('#f-aq');
  if (aq) aq.onchange = () => { fmt.audioQuality = aq.value; };
  el.querySelector('#f-dir').onclick = chooseDir;
  el.querySelector('#f-go').onclick = enqueueSelection;
}

async function chooseDir() {
  const r = await window.api.chooseDir();
  if (r.ok) await window.api.setSettings({ downloadDir: r.path });
}

async function enqueueSelection() {
  if (an.status !== 'done') return;
  const list = selectedEntries();
  if (!list.length) return;
  const entries = list.map((e) => ({ url: e.url, title: e.title, platform: e.platform, thumbnail: e.thumbnail, duration: e.duration, uploader: e.uploader, playlist: e.playlist || null }));
  const r = await window.api.addToQueue(entries, fmt);
  if (!r.ok) return toast(t('err.unknown'), { type: 'err' });
  if (r.added) toast(t('q.added', { n: r.added }), { type: 'ok', sub: r.dup ? t('q.dup', { n: r.dup }) : '', timeout: 2500 });
  else if (r.dup) toast(t('q.dup', { n: r.dup }));
  setTab('queue');
  // Analiz paneli sıfırlanır, bağlantı çubuğu boşalır: yeni bağlantıya hazır
  an = { status: 'idle' };
  urlBox.value = '';
  fitUrlBox();
  renderAnalysis();
}

// Küçük resimler ana süreçten data: adresi olarak gelir (CSP: img-src 'self' data:)
function loadThumbs(root) {
  root.querySelectorAll('img[data-thumb]').forEach((img) => {
    const u = img.dataset.thumb;
    const set = (d) => { if (d) img.src = d; else img.remove(); };
    if (thumbCache.has(u)) return set(thumbCache.get(u));
    window.api.thumb(u).then((d) => { thumbCache.set(u, d); set(d); });
  });
}

// --- Kuyruk ve geçmiş ------------------------------------------------------------------------
function setTab(k) {
  if (tab === k) return;
  tab = k;
  sel.clear();
  anchor = null;
  renderTabs();
  renderTools();
  renderList();
}

function renderTabs() {
  const active = items.filter((x) => ['queued', 'running', 'paused'].includes(x.state)).length;
  $('#tabs').innerHTML = `<button type="button" data-t="queue" class="${tab === 'queue' ? 'on' : ''}">${icon('queue')}${esc(t('tab.queue'))}<b>${items.length}</b></button>
    <button type="button" data-t="history" class="${tab === 'history' ? 'on' : ''}">${icon('history')}${esc(t('tab.history'))}<b>${history.length}</b></button>`;
  $('#tabs').querySelectorAll('button').forEach((b) => (b.onclick = () => setTab(b.dataset.t)));
  document.title = active ? `(${active}) Social Download` : 'Social Download';
}

function renderTools() {
  const box = $('#qTools');
  const d = data.settings.download || {};
  if (tab === 'queue') {
    const anyRun = items.some((x) => x.state === 'running' || x.state === 'queued');
    const anyPaused = items.some((x) => x.state === 'paused');
    const anyDone = items.some((x) => x.state === 'done' || x.state === 'canceled');
    box.innerHTML = `<label class="conc" title="${esc(t('set.concurrencyHint'))}">${esc(t('q.concurrency'))}<select class="input" id="qt-conc">${[1, 2, 3, 4].map((n) => `<option ${Number(d.concurrency) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      ${anyRun ? `<button class="btn sm" type="button" id="qt-pause">${icon('pause')}${esc(t('queue.pauseAll'))}</button>` : ''}
      ${anyPaused ? `<button class="btn sm" type="button" id="qt-resume">${icon('play')}${esc(t('queue.resumeAll'))}</button>` : ''}
      <button class="btn sm" type="button" id="qt-clear" ${anyDone ? '' : 'disabled'}>${icon('check')}${esc(t('q.clearFinished'))}</button>
      <button class="btn sm ghost" type="button" id="qt-dir" title="${esc(t('q.openDir'))} (Ctrl+O)">${icon('folder')}</button>`;
    box.querySelector('#qt-conc').onchange = (e) => window.api.setSettings({ download: { concurrency: Number(e.target.value) } });
    if (box.querySelector('#qt-pause')) box.querySelector('#qt-pause').onclick = () => window.api.pauseAll();
    if (box.querySelector('#qt-resume')) box.querySelector('#qt-resume').onclick = () => window.api.resumeAll();
    box.querySelector('#qt-clear').onclick = () => window.api.clearFinished();
    box.querySelector('#qt-dir').onclick = () => window.api.openDir();
  } else {
    box.innerHTML = `<button class="btn sm" type="button" id="ht-clear" ${history.length ? '' : 'disabled'}>${icon('trash')}${esc(t('h.clear'))}</button>`;
    box.querySelector('#ht-clear').onclick = async () => {
      if (await confirmBox(t('h.clear'), esc(t('h.clearMsg')))) window.api.clearHistory();
    };
  }
}

const currentRows = () => (tab === 'queue' ? items : history);

const PP_KEY = { Merger: 'merge', FFmpegMerger: 'merge', ExtractAudio: 'convert', FFmpegExtractAudio: 'convert', FFmpegVideoRemuxer: 'remux', VideoRemuxer: 'remux', Metadata: 'meta', FFmpegMetadata: 'meta', MoveFiles: 'finish', MoveFilesAfterDownload: 'finish' };
function statusText(x) {
  const p = x.progress || {};
  switch (x.state) {
    case 'queued': return esc(t('st.queued'));
    case 'paused': return esc(t('st.paused')) + (p.pct ? ` · ${ltr(Math.floor(p.pct) + '%')}` : '');
    case 'canceled': return esc(t('st.canceled'));
    case 'done': return `${icon('check')} ${esc(t('st.done'))}${x.size ? ' · ' + fmtBytes(x.size) : ''}`;
    case 'error': return `${esc(errText(x.error && x.error.code))}${x.error && x.error.message && x.error.code === 'unknown' ? ` — ${esc(x.error.message)}` : ''}`;
    case 'running': {
      if (p.phase === 'post') return esc(t(`st.pp.${PP_KEY[p.pp] || 'post'}`));
      if (!p.phase || p.phase === 'starting') return esc(t('st.starting'));
      const parts = p.parts > 1 ? ` · ${esc(t(p.part === 1 ? 'st.partVideo' : 'st.partAudio'))}` : '';
      const eta = p.eta != null ? ` · ${esc(t('st.eta', { t: fmtDur(p.eta) }))}` : '';
      const size = p.total ? ` · ${fmtBytes(p.downloaded)} / ${fmtBytes(p.total)}` : '';
      return `${ltr(Math.floor(p.pct || 0) + '%')}${size}${x.speed ? ' · ' + fmtSpeed(x.speed) : ''}${eta}${parts}`;
    }
    default: return '';
  }
}

function queueRow(x) {
  const p = x.progress || {};
  const pct = x.state === 'done' ? 100 : p.pct || 0;
  const acts = [];
  const btn = (act, ic, title, cls = '') => `<button class="icon-btn ${cls}" type="button" data-act="${act}" title="${esc(title)}">${icon(ic)}</button>`;
  if (x.state === 'running' || x.state === 'queued') acts.push(btn('pause', 'pause', `${t('q.pause')} (Space)`));
  if (x.state === 'paused') acts.push(btn('resume', 'play', `${t('q.resume')} (Space)`));
  if (x.state === 'error' || x.state === 'canceled') acts.push(btn('retry', 'refresh', `${t('q.retry')} (F5)`));
  if (x.state === 'done') acts.push(btn('open', 'play', t('q.play')), btn('show', 'folder', t('q.showInFolder')));
  if (['running', 'queued', 'paused'].includes(x.state)) acts.push(btn('cancel', 'x', t('q.cancel'), 'danger'));
  else acts.push(btn('remove', 'trash', `${t('q.remove')} (Del)`, 'danger'));
  const meta = [
    `<span class="fmt-tag">${x.opts && x.opts.kind === 'audio' ? icon('music') : icon('film')}${esc(optsLabel(x.opts))}</span>`,
    x.uploader ? `<span>${icon('user')}${esc(x.uploader)}</span>` : '',
    x.duration ? `<span>${icon('clock')}${fmtDur(x.duration)}</span>` : '',
    x.playlist ? `<span title="${esc(x.playlist.title)}">${icon('playlist')}${esc(x.playlist.title.slice(0, 40))}${x.playlist.index ? ` #${x.playlist.index}` : ''}</span>` : '',
  ].join('');
  return `<div class="q-item s-${x.state} ${sel.has(x.id) ? 'sel' : ''}" data-id="${esc(x.id)}">
    <div class="qt">${x.thumbnail ? `<img data-thumb="${esc(x.thumbnail)}" alt="">` : icon(x.opts && x.opts.kind === 'audio' ? 'music' : 'film')}${platformBadge(x.platform, { size: 18 })}</div>
    <div class="q-body"><div class="q-title" title="${esc(x.title)}">${esc(x.title || x.url)}</div><div class="q-meta">${meta}</div>
      <div class="q-prog"><div class="progress"><div style="width:${pct}%"></div></div></div><div class="q-status">${statusText(x)}</div></div>
    <div class="q-acts">${acts.join('')}</div></div>`;
}

function historyRow(h) {
  return `<div class="h-item ${sel.has(h.id) ? 'sel' : ''}" data-id="${esc(h.id)}">${platformBadge(h.platform, { size: 26 })}
    <div class="h-title"><div title="${esc(h.title)}">${esc(h.title || h.url)}</div><small>${esc([h.label, h.uploader, h.duration ? '' : null].filter(Boolean).join(' · '))}${h.duration ? ' · ' + fmtDur(h.duration) : ''}</small></div>
    <span class="h-date">${esc(formatDate(h.finishedAt))}</span>
    <div class="q-acts"><button class="icon-btn" type="button" data-act="again" title="${esc(t('h.again'))}">${icon('download')}</button>
      <button class="icon-btn" type="button" data-act="source" title="${esc(t('an.openSource'))}">${icon('open')}</button>
      <button class="icon-btn danger" type="button" data-act="remove" title="${esc(t('q.remove'))} (Del)">${icon('trash')}</button></div></div>`;
}

function renderList() {
  const box = $('#qList');
  const rows = currentRows();
  if (!rows.length) {
    box.innerHTML = tab === 'queue'
      ? `<div class="q-empty"><div class="empty-ic">${icon('queue')}</div><h3>${esc(t('q.emptyTitle'))}</h3><p>${esc(t('q.emptyBody'))}</p></div>`
      : `<div class="q-empty"><div class="empty-ic">${icon('history')}</div><h3>${esc(t('h.emptyTitle'))}</h3><p>${esc(data.settings.syncHistory === false ? t('h.emptyBodyLocal') : t('h.emptyBody'))}</p></div>`;
    return;
  }
  box.innerHTML = rows.map(tab === 'queue' ? queueRow : historyRow).join('');
  box.querySelectorAll('[data-id]').forEach((el) => {
    const id = el.dataset.id;
    el.onclick = (e) => {
      const act = e.target.closest('[data-act]');
      if (act) return rowAction(act.dataset.act, id);
      if (e.shiftKey && anchor) {
        const ids = rows.map((x) => x.id);
        const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((m, n) => m - n);
        if (!e.ctrlKey) sel.clear();
        for (let i = a; i <= b; i++) sel.add(ids[i]);
      } else if (e.ctrlKey) {
        if (sel.has(id)) sel.delete(id); else sel.add(id);
        anchor = id;
      } else { sel.clear(); sel.add(id); anchor = id; }
      box.querySelectorAll('[data-id]').forEach((r) => r.classList.toggle('sel', sel.has(r.dataset.id)));
    };
    el.ondblclick = (e) => {
      if (e.target.closest('[data-act]')) return;
      const x = rows.find((r) => r.id === id);
      if (tab === 'queue' && x && x.state === 'done') rowAction('open', id);
      if (tab === 'history') rowAction('again', id);
    };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      if (!sel.has(id)) { sel.clear(); sel.add(id); anchor = id; box.querySelectorAll('[data-id]').forEach((r) => r.classList.toggle('sel', sel.has(r.dataset.id))); }
      contextMenu(e.clientX, e.clientY, tab === 'queue' ? queueMenu(id) : historyMenu(id));
    };
  });
  loadThumbs(box);
}

function queueMenu(id) {
  const x = items.find((r) => r.id === id);
  if (!x) return [];
  const ids = [...sel];
  return [
    x.state === 'done' ? { icon: 'play', label: t('q.play'), action: () => rowAction('open', id) } : null,
    x.state === 'done' ? { icon: 'folder', label: t('q.showInFolder'), action: () => rowAction('show', id) } : null,
    ['running', 'queued'].includes(x.state) ? { icon: 'pause', label: t('q.pause'), kbd: 'Space', action: () => window.api.queueOp('pause', ids) } : null,
    x.state === 'paused' ? { icon: 'play', label: t('q.resume'), kbd: 'Space', action: () => window.api.queueOp('resume', ids) } : null,
    ['error', 'canceled'].includes(x.state) ? { icon: 'refresh', label: t('q.retry'), kbd: 'F5', action: () => window.api.queueOp('retry', ids) } : null,
    x.state === 'queued' ? { icon: 'up', label: t('q.moveUp'), action: () => window.api.queueMove(id, -1) } : null,
    x.state === 'queued' ? { icon: 'down', label: t('q.moveDown'), action: () => window.api.queueMove(id, 1) } : null,
    '-',
    { icon: 'open', label: t('an.openSource'), action: () => window.api.openSource(x.url) },
    { icon: 'copy', label: t('ctx.copyLink'), action: () => { window.api.copyText(x.url); toast(t('ctx.copied'), { type: 'ok', timeout: 1500 }); } },
    x.error ? { icon: 'info', label: t('q.errorDetails'), action: () => errorDetails(x) } : null,
    '-',
    ['running', 'queued', 'paused'].includes(x.state) ? { icon: 'x', label: t('q.cancel'), danger: true, action: () => window.api.queueOp('cancel', ids) } : null,
    { icon: 'trash', label: t('q.remove'), kbd: 'Del', danger: true, action: () => removeSelected() },
  ];
}

function historyMenu(id) {
  const h = history.find((r) => r.id === id);
  if (!h) return [];
  return [
    { icon: 'download', label: t('h.again'), action: () => rowAction('again', id) },
    { icon: 'open', label: t('an.openSource'), action: () => window.api.openSource(h.url) },
    { icon: 'copy', label: t('ctx.copyLink'), action: () => { window.api.copyText(h.url); toast(t('ctx.copied'), { type: 'ok', timeout: 1500 }); } },
    '-',
    { icon: 'trash', label: t('q.remove'), kbd: 'Del', danger: true, action: () => removeSelected() },
  ];
}

function errorDetails(x) {
  openModal({
    title: t('q.errorDetails'), iconName: 'alert', width: 560,
    body: `<p style="margin:0 0 10px">${esc(errText(x.error.code))}</p><div class="tpl-sample" style="font-size:12px">${esc(x.error.message || x.error.code)}</div><div class="tpl-sample">${esc(x.url)}</div>`,
    buttons: [{ label: t('common.close'), value: null }],
  });
}

async function rowAction(act, id) {
  if (tab === 'history') {
    const h = history.find((r) => r.id === id);
    if (!h) return;
    if (act === 'again') { urlBox.value = h.url; fitUrlBox(); runAnalyze(); }
    if (act === 'source') window.api.openSource(h.url);
    if (act === 'remove') { sel.delete(id); window.api.removeHistory([id]); }
    return;
  }
  if (['pause', 'resume', 'retry', 'cancel'].includes(act)) return window.api.queueOp(act, [id]);
  if (act === 'remove') { sel.delete(id); return window.api.queueOp('remove', [id]); }
  if (act === 'open' || act === 'show') {
    const r = await (act === 'open' ? window.api.openFile(id) : window.api.showFile(id));
    if (!r.ok) toast(t(r.code === 'missing' ? 'q.fileMissing' : 'q.openFailed'), { type: 'err', sub: r.message || '' });
  }
}

async function removeSelected() {
  const ids = [...sel];
  if (!ids.length) return;
  if (tab === 'history') { sel.clear(); return window.api.removeHistory(ids); }
  const active = items.filter((x) => ids.includes(x.id) && ['running', 'queued', 'paused'].includes(x.state));
  if (active.length && !(await confirmBox(t('q.remove'), esc(t('q.removeActiveMsg', { n: active.length })), { okText: t('q.remove') }))) return;
  sel.clear();
  window.api.queueOp('remove', ids);
}

function togglePauseSelected() {
  const ids = [...sel];
  const list = items.filter((x) => ids.includes(x.id));
  const anyActive = list.some((x) => x.state === 'running' || x.state === 'queued');
  window.api.queueOp(anyActive ? 'pause' : 'resume', ids);
}

// --- Ayarlar (Mastertool ortak iskeleti): Genel · İndirme · Motor · Hesap · Kısayollar · Hakkında -------
async function openSettings(startTab = 'general') {
  const s = data.settings || {};
  const d = { ...(s.download || {}) };
  const lim = data.limits || {};
  let appTheme = s.appTheme || 'system';
  let dir = s.downloadDir || '';
  const about = await window.api.about();
  let eng = about.engine || {};
  const langOptions = Object.entries(I18N.LANGUAGES).map(([code, l]) => `<option value="${code}" ${code === LANG ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
  const tabs = [['general', 'gear', t('set.general')], ['download', 'download', t('set.download')], ['engine', 'cpu', t('set.engine')], ['account', 'user', t('set.account')], ['keys', 'keyboard', t('set.keys')], ['about', 'bolt', t('set.about')]];
  const email = (acct.user && acct.user.email) || acct.email || '';
  const opt = (v, label, cur) => `<option value="${v}" ${String(cur) === String(v) ? 'selected' : ''}>${esc(label)}</option>`;
  const engineRows = (e) => `<span>yt-dlp</span><span>${e.ytdlpVersion ? `<code>${esc(e.ytdlpVersion)}</code> · ${esc(e.updated ? t('eng.updatedCopy') : t('eng.bundledCopy'))}` : `<b style="color:var(--err)">${esc(t('eng.missing'))}</b>`}</span>
    <span>FFmpeg</span><span>${e.ffmpegDir ? `<code>${esc(e.ffmpegVersion || '?')}</code> · LGPL` : `<b style="color:var(--err)">${esc(t('eng.ffmpegMissing'))}</b>`}</span>
    <span>${esc(t('eng.lastCheck'))}</span><span>${e.lastCheck ? esc(formatDate(e.lastCheck)) + (e.latest ? ` · ${esc(t('eng.latest', { version: e.latest }))}` : '') : '—'}</span>`;

  const body = h(`<div class="set-wrap">
    <nav class="set-nav">${tabs.map(([k, ic, label]) => `<button type="button" data-tab="${k}">${icon(ic)}<span>${esc(label)}</span></button>`).join('')}</nav>
    <div class="set-pages">
      <section data-page="general">
        <div class="field"><label>${esc(t('set.language'))}</label><select class="input" id="s-lang">${langOptions}</select>
          <small class="set-hint">${esc(t('set.languageHint'))}</small></div>
        <div class="field"><label>${esc(t('set.theme'))}</label>
          <div class="seg" id="s-theme">
            <button type="button" data-v="dark">${icon('moon')}${esc(t('set.themeDark'))}</button>
            <button type="button" data-v="light">${icon('sun')}${esc(t('set.themeLight'))}</button>
            <button type="button" data-v="system">${icon('monitor')}${esc(t('set.themeSystem'))}</button>
          </div></div>
        <div class="section-title">${esc(t('set.behavior'))}</div>
        <label class="check"><input type="checkbox" id="s-clip" ${s.clipboardWatch ? 'checked' : ''}>
          <span>${esc(t('set.clipboardWatch'))}<small>${esc(t('set.clipboardWatchHint'))}</small></span></label>
        <label class="check"><input type="checkbox" id="s-notify" ${s.notifyDone ? 'checked' : ''}>
          <span>${esc(t('set.notifyDone'))}<small>${esc(t('set.notifyDoneHint'))}</small></span></label>
        <div class="section-title">${esc(t('set.startup'))}</div>
        <label class="check"><input type="checkbox" id="s-login" ${about.openAtLogin ? 'checked' : ''}>
          <span>${esc(t('set.openAtLogin'))}<small>${esc(t('set.openAtLoginHint'))}</small></span></label>
        <label class="check"><input type="checkbox" id="s-min" ${s.minimizeToTray ? 'checked' : ''}>
          <span>${esc(t('set.minTray'))}<small>${esc(t('set.minTrayHint'))}</small></span></label>
        <label class="check"><input type="checkbox" id="s-close" ${s.closeToTray ? 'checked' : ''}>
          <span>${esc(t('set.closeTray'))}<small>${esc(t('set.closeTrayHint'))}</small></span></label>
        <div class="section-title">${esc(t('set.updates'))}</div>
        <label class="check"><input type="checkbox" id="s-upd" ${s.checkUpdates ? 'checked' : ''}>
          <span>${esc(t('set.checkUpdates'))}<small>${esc(t('set.checkUpdatesHint'))}</small></span></label>
      </section>

      <section data-page="download">
        <div class="field"><label>${esc(t('set.downloadDir'))}</label>
          <div class="dir-row"><input class="input" id="s-dir" value="${esc(dir)}" readonly><button class="btn sm" type="button" id="s-dirpick">${icon('folder')}${esc(t('fmt.change'))}</button>
          <button class="btn sm ghost" type="button" id="s-dirreset" title="${esc(t('set.dirDefault'))}">${icon('refresh')}</button></div></div>
        <div class="field"><label>${esc(t('set.template'))}</label><input class="input ltr" id="s-tpl" value="${esc(d.template || '{title}')}" spellcheck="false" maxlength="200">
          <div class="tpl-tokens">${(lim.tokens || []).map((k) => `<button type="button" data-tok="${k}" title="${esc(t('tok.' + k))}">{${k}}</button>`).join('')}</div>
          <div class="tpl-sample" id="s-tplout"></div></div>
        <label class="check"><input type="checkbox" id="s-plf" ${d.playlistFolder ? 'checked' : ''}><span>${esc(t('set.playlistFolder'))}<small>${esc(t('set.playlistFolderHint'))}</small></span></label>
        <label class="check"><input type="checkbox" id="s-meta" ${d.embedMetadata ? 'checked' : ''}><span>${esc(t('set.embedMetadata'))}<small>${esc(t('set.embedMetadataHint'))}</small></span></label>
        <div class="section-title">${esc(t('set.defaults'))}</div>
        <div class="row c-1-1">
          <div class="field"><label>${esc(t('fmt.type'))}</label><select class="input" id="s-kind">${opt('video', t('fmt.video'), d.kind)}${opt('audio', t('fmt.audioOnly'), d.kind)}</select></div>
          <div class="field"><label>${esc(t('fmt.resolution'))}</label><select class="input" id="s-h">${RES_CHIPS.map((x) => opt(x, x ? FORMATS.heightLabel(x) : t('fmt.best'), d.height)).join('')}</select></div>
          <div class="field"><label>${esc(t('fmt.container'))}</label><select class="input" id="s-cont">${FORMATS.CONTAINERS.map((c) => opt(c, c.toUpperCase(), d.container)).join('')}</select></div>
          <div class="field"><label>${esc(t('fmt.audioFormat'))}</label><select class="input" id="s-afmt">${FORMATS.AUDIO_FORMATS.map((c) => opt(c, c === 'opus' ? 'Opus' : c.toUpperCase(), d.audioFormat)).join('')}</select></div>
          <div class="field"><label>${esc(t('fmt.audioQuality'))}</label><select class="input" id="s-aq">${FORMATS.AUDIO_QUALITIES.map((q) => opt(q, q === 'best' ? t('fmt.bestQuality') : `${q} kbps`, d.audioQuality)).join('')}</select></div>
        </div>
        <small class="set-hint">${esc(t('set.fallbackHint'))}</small>
        <div class="section-title">${esc(t('set.queueSec'))}</div>
        <div class="row c-1-1">
          <div class="field"><label>${esc(t('q.concurrency'))}</label><select class="input" id="s-conc">${[1, 2, 3, 4].map((n) => opt(n, n, d.concurrency)).join('')}</select>
            <small class="hint">${esc(t('set.concurrencyHint'))}</small></div>
          <div class="field"><label>${esc(t('set.limitRate'))}</label><div class="unit-wrap"><input class="input" id="s-rate" type="number" min="0" max="100000" step="100" value="${esc(d.limitRate || 0)}"><span>KB/${esc(t('unit.sec'))}</span></div>
            <small class="hint">${esc(t('set.limitRateHint'))}</small></div>
          <div class="field"><label>${esc(t('set.gap'))}</label><div class="unit-wrap"><input class="input" id="s-gap" type="number" min="0" max="30" step="0.5" value="${esc(d.gapSec ?? 2)}"><span>${esc(t('unit.sec'))}</span></div>
            <small class="hint">${esc(t('set.gapHint'))}</small></div>
        </div>
        <label class="check"><input type="checkbox" id="s-resume" ${s.resumeOnStart ? 'checked' : ''}><span>${esc(t('set.resumeOnStart'))}<small>${esc(t('set.resumeOnStartHint'))}</small></span></label>
      </section>

      <section data-page="engine">
        <div class="engine-box" id="e-box">${engineRows(eng)}</div>
        <div class="acct-actions">
          <button class="btn sm" type="button" id="e-check">${icon('search')}${esc(t('eng.check'))}</button>
          <button class="btn sm primary" type="button" id="e-update">${icon('refresh')}${esc(t('eng.update'))}</button>
          <button class="btn sm ghost" type="button" id="e-reset">${esc(t('eng.reset'))}</button>
        </div>
        <div class="engine-steps" id="e-steps"></div>
        <label class="check"><input type="checkbox" id="s-eng" ${s.checkEngine ? 'checked' : ''}><span>${esc(t('eng.auto'))}<small>${esc(t('eng.autoHint'))}</small></span></label>
        <div class="note">${icon('shield')}<span>${esc(t('eng.verifyNote'))}</span></div>
        <div class="note">${icon('info')}<span>${esc(t('eng.whyNote'))}</span></div>
        <div class="acct-actions"><button class="btn sm" type="button" id="e-lic">${icon('file')}${esc(t('eng.licenses'))}</button></div>
      </section>

      <section data-page="account">
        <div class="acct-box">
          <div class="acct-who">${icon('user')}<span>${esc(t('acct.signedInAs', { email }))}</span></div>
          <label class="check"><input type="checkbox" id="s-sync" ${acct.syncEnabled ? 'checked' : ''}>
            <span>${esc(t('acct.syncToggle'))}<small>${esc(t('acct.syncHint'))}</small></span></label>
          <label class="check"><input type="checkbox" id="s-synch" ${s.syncHistory !== false ? 'checked' : ''}>
            <span>${esc(t('acct.syncHistory'))}<small>${esc(t('acct.syncHistoryHint'))}</small></span></label>
          <div class="acct-status">${icon('cloud')}<span id="acct-status">${esc(syncText(acct))}</span></div>
          <div class="acct-actions">
            <button class="btn sm" type="button" id="s-syncnow">${icon('refresh')}${esc(t('acct.syncNow'))}</button>
            <button class="btn sm" type="button" id="s-delremote">${icon('trash')}${esc(t('acct.deleteRemote'))}</button>
          </div>
          <div class="acct-actions">
            <button class="btn sm" type="button" id="s-web">${icon('open')}${esc(t('acct.myAccount'))}</button>
            <span style="flex:1"></span>
            <button class="btn sm danger" type="button" id="s-logout">${icon('logout')}${esc(t('acct.logout'))}</button>
          </div>
        </div>
        <div class="note">${icon('shield')}<span>${esc(t('privacy.note'))}</span></div>
      </section>

      <section data-page="keys">
        <div class="keys">${SHORTCUTS.map(([k, l]) => `<span class="kbd">${esc(k)}</span><span>${esc(t(l))}</span>`).join('')}</div>
      </section>

      <section data-page="about">
        <div class="about-head">
          <img src="../../build/icon.png" alt="">
          <div><div class="about-name">Social Download</div>
            <div class="about-ver">${esc(t('about.version', { version: about.version }))}${about.portable ? ` · ${esc(t('about.portable'))}` : ''}</div></div>
        </div>
        <div class="set-hint">${esc(t('about.family'))}</div>
        <div class="acct-actions">
          <button class="btn sm" type="button" id="s-update">${icon('refresh')}${esc(t('about.checkUpdate'))}</button>
          <button class="btn sm" type="button" id="s-tool">${icon('globe')}${esc(t('about.toolPage'))}</button>
          <span class="about-update" id="s-update-result"></span>
        </div>
        <div class="note">${icon('shield')}<span>${esc(t('notice.text'))}</span></div>
        <div class="section-title">${esc(t('about.licenses'))}</div>
        <div class="set-hint">${esc(t('about.licensesIntro'))}</div>
        <ul class="oss">${OSS.map(([n, l]) => `<li><span>${esc(n)}</span><span>${esc(l)}</span></li>`).join('')}</ul>
        <div class="acct-actions">
          <button class="btn sm" type="button" id="s-licenses">${icon('file')}${esc(t('about.chromium'))}</button>
          <button class="btn sm" type="button" id="s-elic">${icon('file')}${esc(t('eng.licenses'))}</button>
          <span class="set-hint">Electron ${esc(about.electron)} · Chromium ${esc(about.chrome)}</span>
        </div>
      </section>
    </div>
  </div>`);

  const q = (sel_) => body.querySelector(sel_);
  const showTab = (k) => {
    body.querySelectorAll('.set-nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === k));
    body.querySelectorAll('.set-pages section').forEach((p) => p.classList.toggle('hidden', p.dataset.page !== k));
  };
  body.querySelectorAll('.set-nav button').forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
  showTab(startTab);

  const originalTheme = appTheme;
  const setTheme = (v) => {
    appTheme = v;
    body.querySelectorAll('#s-theme button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    window.api.setSettings({ appTheme: v });
  };
  body.querySelectorAll('#s-theme button').forEach((b) => (b.onclick = () => setTheme(b.dataset.v)));
  body.querySelectorAll('#s-theme button').forEach((b) => b.classList.toggle('on', b.dataset.v === appTheme));

  // İndirme klasörü ve dosya adı şablonu
  q('#s-dirpick').onclick = async () => { const r = await window.api.chooseDir(); if (r.ok) { dir = r.path; q('#s-dir').value = dir; } };
  q('#s-dirreset').onclick = () => { dir = ''; q('#s-dir').value = t('set.dirDefault'); };
  let tplOk = true;
  const checkTpl = async () => {
    const r = await window.api.checkTemplate(q('#s-tpl').value);
    tplOk = r.ok;
    q('#s-tpl').classList.toggle('invalid', !r.ok);
    q('#s-tplout').textContent = r.ok ? `→ ${r.sample}` : t(`tpl.${r.code}`, { token: r.token || '' });
  };
  q('#s-tpl').addEventListener('input', checkTpl);
  body.querySelectorAll('.tpl-tokens button').forEach((b) => (b.onclick = () => {
    const el = q('#s-tpl');
    const pos = el.selectionStart ?? el.value.length;
    el.value = `${el.value.slice(0, pos)}{${b.dataset.tok}}${el.value.slice(el.selectionEnd ?? pos)}`;
    el.focus();
    checkTpl();
  }));
  checkTpl();

  // Motor
  const stepEl = q('#e-steps');
  const off = window.api.onEngineStep((st) => { stepEl.textContent = t(`eng.step.${st}`); });
  const paintEngine = (e) => { eng = e; q('#e-box').innerHTML = engineRows(e); };
  q('#e-check').onclick = async () => {
    stepEl.textContent = t('eng.step.check');
    const r = await window.api.engineCheck();
    if (!r.ok) { stepEl.textContent = t('eng.failed', { msg: errText(r.code) }); return; }
    paintEngine(r.info);
    stepEl.textContent = r.newer ? t('eng.newer', { version: r.latest }) : t('eng.upToDate');
  };
  q('#e-update').onclick = async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    const r = await window.api.engineUpdate();
    b.disabled = false;
    if (!r.ok) { stepEl.textContent = t('eng.failed', { msg: errText(r.code) }); return; }
    paintEngine(r.info);
    stepEl.textContent = r.updated ? t('eng.updated', { version: r.version }) : t('eng.upToDate');
    if (r.updated) { toast(t('eng.updated', { version: r.version }), { type: 'ok' }); showEngineBar(null); }
  };
  q('#e-reset').onclick = async () => {
    if (!(await confirmBox(t('eng.reset'), esc(t('eng.resetMsg')), { okText: t('eng.reset'), danger: false }))) return;
    const r = await window.api.engineReset();
    paintEngine(r.info);
    stepEl.textContent = '';
  };
  q('#e-lic').onclick = () => window.api.engineLicenses();
  q('#s-elic').onclick = () => window.api.engineLicenses();

  // Hesap
  q('#s-sync').onchange = async (e) => {
    const on = e.target.checked;
    const r = await window.api.setSyncEnabled(on);
    if (!r.ok) { e.target.checked = !on; toast(t('sync.error', { msg: r.code }), { type: 'err' }); }
  };
  q('#s-synch').onchange = (e) => window.api.setSettings({ syncHistory: e.target.checked });
  q('#s-syncnow').onclick = () => window.api.syncNow();
  q('#s-delremote').onclick = async () => {
    const ok = await confirmBox(t('acct.deleteRemote'), esc(t('acct.deleteRemoteMsg')));
    if (!ok) return;
    const r = await window.api.deleteRemoteLibrary();
    if (r.ok) { q('#s-sync').checked = false; toast(t('acct.deleteRemoteDone'), { type: 'ok' }); }
    else toast(t('sync.error', { msg: r.code }), { type: 'err' });
  };
  q('#s-web').onclick = () => window.api.openWeb('account');
  q('#s-logout').onclick = async () => {
    const ok = await confirmBox(t('acct.logout'), esc(t('acct.logoutMsg')), { okText: t('acct.logout') });
    if (ok) window.api.logout();
  };

  // Hakkında
  q('#s-update').onclick = async () => {
    const out = q('#s-update-result');
    out.className = 'about-update';
    out.textContent = t('about.checking');
    const r = await window.api.checkUpdate();
    if (!r.ok) { out.classList.add('err'); out.textContent = t('about.checkFailed', { msg: r.message || r.code }); return; }
    if (r.newer) { out.classList.add('new'); out.textContent = `${t('update.available', { version: r.latest })} — ${t('update.hint')}`; }
    else { out.classList.add('ok'); out.textContent = t('about.upToDate'); }
  };
  q('#s-tool').onclick = () => window.api.openWeb('tool');
  q('#s-licenses').onclick = () => window.api.openLicenses();

  const res = await openModal({
    title: t('set.title'), iconName: 'gear', width: 820, body,
    buttons: [
      { label: t('common.cancel'), value: null },
      { label: t('common.save'), cls: 'primary', onClick: (m) => {
        if (!tplOk) { showTab('download'); m.querySelector('#s-tpl').focus(); return false; }
        return {
          appTheme,
          language: m.querySelector('#s-lang').value,
          clipboardWatch: m.querySelector('#s-clip').checked,
          notifyDone: m.querySelector('#s-notify').checked,
          openAtLogin: m.querySelector('#s-login').checked,
          minimizeToTray: m.querySelector('#s-min').checked,
          closeToTray: m.querySelector('#s-close').checked,
          checkUpdates: m.querySelector('#s-upd').checked,
          checkEngine: m.querySelector('#s-eng').checked,
          resumeOnStart: m.querySelector('#s-resume').checked,
          downloadDir: dir || null,
          download: {
            template: m.querySelector('#s-tpl').value.trim(),
            playlistFolder: m.querySelector('#s-plf').checked,
            embedMetadata: m.querySelector('#s-meta').checked,
            kind: m.querySelector('#s-kind').value,
            height: Number(m.querySelector('#s-h').value),
            container: m.querySelector('#s-cont').value,
            audioFormat: m.querySelector('#s-afmt').value,
            audioQuality: m.querySelector('#s-aq').value,
            concurrency: Number(m.querySelector('#s-conc').value),
            limitRate: Math.max(0, Number(m.querySelector('#s-rate').value) || 0),
            gapSec: Math.max(0, Math.min(30, Number(m.querySelector('#s-gap').value) || 0)),
          },
        };
      } },
    ],
  });
  off();
  if (!res) {
    if (appTheme !== originalTheme) window.api.setSettings({ appTheme: originalTheme });
    return;
  }
  const langChanged = res.language !== LANG;
  if (!langChanged) delete res.language;
  // Varsayılan biçim değiştiyse panel de yeni varsayılanla açılır
  const dd = data.settings.download || {};
  if (['kind', 'height', 'container', 'audioFormat', 'audioQuality'].some((k) => String(dd[k]) !== String(res.download[k]))) fmt = null;
  await window.api.setSettings(res);
  if (!fmt && an.status === 'done') { fmt = { ...FORMATS.sanitizeOpts(res.download) }; renderFormat(); }
  if (!langChanged) toast(t('set.saved'), { type: 'ok' });
}
