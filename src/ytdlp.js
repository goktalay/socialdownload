'use strict';

// Motor (yt-dlp) sarmalayıcısı: argüman kurma, analiz çıktısını (-J) ayrıştırma, ilerleme satırlarını okuma, hataları
// anlaşılır kodlara çevirme ve indirme/analiz süreçlerini yönetme. Süreç başlatma (spawn) enjekte edilir; testler sahte
// süreçle ve sahte JSON çıktısıyla çalışır.
//
// Tasarım sınırları (bkz. docs/site-teknik.md › Bilinen sınırlar): yt-dlp HİÇBİR ZAMAN çerez, tarayıcı çerezi, kullanıcı
// adı/şifre, .netrc ya da DRM'li biçimlere izin veren seçeneklerle çağrılmaz; kullanıcının kendi yt-dlp yapılandırma
// dosyası da okunmaz (--ignore-config). FORBIDDEN_ARGS bunu her çağrıda denetler.

const fs = require('fs');
const path = require('path');
const URLS = require('./urls');
const FORMATS = require('./formats');

const FORBIDDEN_ARGS = ['--cookies', '--cookies-from-browser', '--username', '-u', '--password', '-p', '--twofactor', '-2', '--netrc',
  '--netrc-location', '--netrc-cmd', '--video-password', '--allow-unplayable-formats', '--ap-mso', '--ap-username', '--ap-password',
  '--client-certificate', '--client-certificate-key', '--client-certificate-password', '--config-locations', '--exec', '--exec-before-download',
  '--load-info-json', '--batch-file', '-a', '--add-header', '--use-postprocessor'];

const BASE_ARGS = ['--ignore-config', '--no-cookies', '--no-cookies-from-browser', '--encoding', 'utf-8', '--socket-timeout', '30'];
const ANALYZE_TIMEOUT_MS = 120 * 1000;
const MAX_JSON_BYTES = 64 * 1024 * 1024;
const PLAYLIST_MAX = 1000; // bir oynatma listesinden en çok bu kadar öğe listelenir

// Argüman dizisinde yasaklı seçenek var mı (değer olarak geçen URL'ler '--' sonrasındadır ve sayılmaz)
function assertSafeArgs(args) {
  const end = args.indexOf('--');
  const opts = end >= 0 ? args.slice(0, end) : args;
  // "-P temp:…" gibi değerler seçenek sanılmasın: yalnız tire ile başlayanlar ve önceki öğe değer beklemiyorsa
  for (const a of opts) {
    const name = String(a).split('=')[0];
    if (FORBIDDEN_ARGS.includes(name)) throw Object.assign(new Error(`forbidden_arg ${name}`), { code: 'forbidden_arg' });
  }
  return args;
}

// --- Dosya adı şablonu -----------------------------------------------------------------------------------------------
// Kullanıcı şablonu yalnız bu belirteçleri içerebilir; yt-dlp'nin kendi %(…)s sözdizimi doğrudan kabul edilmez.
const TOKENS = {
  title: '%(title)s',
  uploader: '%(uploader,channel,creator|NA)s',
  id: '%(id)s',
  date: '%(upload_date>%Y-%m-%d|NA)s',
  platform: '%(extractor_key)s',
  resolution: '%(height&{}p|audio)s',
  playlist: null, // bizden: oynatma listesi adı
  index: null,    // bizden: listedeki sıra (001)
};
const DEFAULT_TEMPLATE = '{title}';

const cleanName = (s, max = 120) => String(s || '').replace(/[\x00-\x1f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, max);

function validateTemplate(tpl) {
  const s = String(tpl || '').trim();
  if (!s) return { ok: false, code: 'empty' };
  if (s.length > 200) return { ok: false, code: 'too_long' };
  if (/[\\/]|\.\./.test(s)) return { ok: false, code: 'path' };
  if (/%\(/.test(s)) return { ok: false, code: 'raw' };
  for (const m of s.matchAll(/\{(\w*)\}/g)) if (!(m[1] in TOKENS)) return { ok: false, code: 'unknown_token', token: m[1] };
  if (!/\{\w+\}/.test(s)) return { ok: false, code: 'no_token' };
  return { ok: true };
}

// Şablonu yt-dlp çıktı şablonuna çevirir (uzantı yt-dlp'den). item.playlist = { title, index, count }
function buildOutputTemplate(tpl, item) {
  const s = validateTemplate(tpl).ok ? String(tpl).trim() : DEFAULT_TEMPLATE;
  const pl = (item && item.playlist) || null;
  const width = pl && pl.count ? Math.max(2, String(pl.count).length) : 3;
  // Düz metin: dosya adında geçersiz karakterler boşluk olur, % yt-dlp için kaçırılır
  const lit = (x) => x.replace(/[\x00-\x1f<>:"/\\|?*]+/g, ' ').replace(/%/g, '%%');
  let out = '';
  let last = 0;
  for (const m of s.matchAll(/\{(\w+)\}/g)) {
    out += lit(s.slice(last, m.index));
    const k = m[1];
    if (k === 'playlist') out += pl ? cleanName(pl.title, 80).replace(/%/g, '%%') || 'playlist' : '';
    else if (k === 'index') out += pl && pl.index ? String(pl.index).padStart(width, '0') : '';
    else out += TOKENS[k];
    last = m.index + m[0].length;
  }
  out += lit(s.slice(last));
  out = out.replace(/^[\s.\-_]+|[\s.\-_]+$/g, '').replace(/ {2,}/g, ' ');
  return (out || TOKENS.title) + '.%(ext)s';
}

// --- Argümanlar ------------------------------------------------------------------------------------------------------
function analyzeArgs(url, { playlist = false, limit = PLAYLIST_MAX } = {}) {
  return assertSafeArgs([...BASE_ARGS, '-J', '--flat-playlist', playlist ? '--yes-playlist' : '--no-playlist',
    '--playlist-end', String(Math.max(1, Math.min(PLAYLIST_MAX, limit))), '--no-warnings', '--', url]);
}

const PROGRESS_TPL = 'download:SDP|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.format_id)s';
const POST_TPL = 'postprocess:SDPP|%(progress.status)s|%(progress.postprocessor)s';

// item: { url, opts, playlist? }; env: { outDir, tempDir, ffmpegDir?, template, limitRate (KB/s, 0 = sınırsız), retries, embedMetadata }
function downloadArgs(item, env) {
  const args = [...BASE_ARGS, '--newline', '--progress', '--no-playlist', '--continue', '--no-mtime',
    '--progress-template', PROGRESS_TPL, '--progress-template', POST_TPL,
    '--print', 'before_dl:SDFMT|%(format_id)s|%(height|)s|%(ext)s|%(duration|)s|%(title)s',
    '--print', 'after_move:SDFILE|%(filepath)s',
    '-P', env.outDir, '-P', `temp:${env.tempDir}`, '-o', buildOutputTemplate(env.template, item),
    '--windows-filenames', '--trim-filenames', '180',
    '--retries', String(env.retries ?? 3), '--fragment-retries', String(env.retries ?? 3)];
  if (env.ffmpegDir) args.push('--ffmpeg-location', env.ffmpegDir);
  const kb = Number(env.limitRate) || 0;
  if (kb > 0) args.push('--limit-rate', `${Math.round(kb)}K`);
  if (env.embedMetadata) args.push('--embed-metadata');
  args.push(...FORMATS.formatArgs(item.opts), '--', item.url);
  return assertSafeArgs(args);
}

// --- Çıktı satırları ---------------------------------------------------------------------------------------------------
const num = (v) => (v === undefined || v === null || v === '' || v === 'NA' || v === 'None' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function parseLine(line) {
  const s = String(line || '').replace(/\r$/, '');
  if (s.startsWith('SDP|')) {
    const [, status, done, total, est, speed, eta, fmt] = s.split('|');
    return { type: 'progress', status, downloaded: num(done), total: num(total) ?? num(est), estimated: num(total) == null && num(est) != null, speed: num(speed), eta: num(eta), formatId: fmt && fmt !== 'NA' ? fmt : null };
  }
  if (s.startsWith('SDPP|')) {
    const [, status, pp] = s.split('|');
    return { type: 'post', status, pp: pp || null };
  }
  if (s.startsWith('SDFMT|')) {
    const [, fmt, height, ext, duration, ...title] = s.split('|');
    return { type: 'format', formatId: fmt, parts: fmt ? fmt.split('+').length : 1, height: num(height), ext: ext || null, duration: num(duration), title: title.join('|') || null };
  }
  if (s.startsWith('SDFILE|')) return { type: 'file', path: s.slice(7) };
  if (/^ERROR:/.test(s)) return { type: 'error', message: s.replace(/^ERROR:\s*/, '') };
  if (/^WARNING:/.test(s)) return { type: 'warning', message: s.replace(/^WARNING:\s*/, '') };
  return { type: 'other', text: s };
}

// İlerleme izleyici: çok parçalı (video + ses) indirmeyi tek yüzdeye çevirir; birleştirme/dönüştürme son %3'tür
function createProgressTracker() {
  let parts = 1;
  const seen = [];
  let phase = 'download';
  let last = { pct: 0 };
  return {
    feed(ev) {
      if (ev.type === 'format') { parts = Math.max(1, ev.parts); return { phase: 'starting', pct: 0, height: ev.height, ext: ev.ext, title: ev.title, parts }; }
      if (ev.type === 'post') { phase = 'post'; last = { ...last, phase, pp: ev.pp, pct: Math.max(last.pct || 0, 97), speed: null, eta: null }; return last; }
      if (ev.type !== 'progress') return null;
      if (ev.formatId && !seen.includes(ev.formatId)) seen.push(ev.formatId);
      const idx = Math.max(0, Math.min(parts - 1, seen.length - 1));
      const partPct = ev.status === 'finished' ? 100 : ev.total ? Math.min(100, (ev.downloaded / ev.total) * 100) : 0;
      const pct = Math.min(97, ((idx * 100 + partPct) / parts) * 0.97);
      last = { phase: 'download', part: idx + 1, parts, pct: Math.max(phase === 'post' ? 97 : 0, Math.round(pct * 10) / 10), downloaded: ev.downloaded, total: ev.total, speed: ev.speed, eta: ev.eta };
      return last;
    },
  };
}

// --- Hatalar -----------------------------------------------------------------------------------------------------------
// yt-dlp hata metni → anlaşılır kod (arayüzde err.<kod> çevirisi). Sıra önemlidir.
const ERROR_RULES = [
  ['drm', /\bDRM\b|drm protected|widevine|playready|fairplay/i],
  ['ffmpeg_missing', /ffmpeg(?: and ffprobe)? (?:is )?not (?:found|installed)|ffprobe and ffmpeg not found|ffmpeg-location .* does not exist/i],
  ['bot_check', /not a bot|confirm you.re not a robot|captcha/i],
  ['age_restricted', /confirm your age|age[- ]restricted|inappropriate for some users|age-gated/i],
  ['members_only', /members[- ]only|join this channel|channel.s members|subscriber[s]?[- ]only|premium members|requires (?:a )?(?:premium|subscription|purchase)|rental|paid content/i],
  ['private', /private video|video is private|is private|private (?:post|account|profile)|this (?:post|account) is private/i],
  ['login_required', /log ?in required|login required|requires? (?:authentication|login|logging in|an account)|sign ?in to|need to log ?in|use --cookies|--cookies-from-browser|logged[- ]in|rate-limit reached or login required/i],
  ['geo_blocked', /(?:not|n.t) (?:made this video )?available in your (?:country|region|location)|geo[- ]?restrict|geo[- ]?blocked|from your location/i],
  ['live', /is (?:currently )?live|live event will begin|premieres in|this live event|livestream|is_live/i],
  ['rate_limited', /HTTP Error 429|too many requests|rate[- ]limit/i],
  ['unsupported_url', /unsupported url|no suitable extractor/i],
  ['unavailable', /video unavailable|has been removed|no longer available|has been terminated|does not exist|not found|HTTP Error 404|HTTP Error 410|content isn.t available|is unavailable/i],
  ['disk_full', /no space left|errno 28|not enough space|disk (?:is )?full/i],
  ['permission', /permission denied|errno 13|access is denied|winerror 5\b|read-only file system/i],
  ['no_formats', /requested format(?: is)? not available|no video formats found|no formats found|no media found/i],
  ['forbidden', /HTTP Error 403|forbidden/i],
  ['network', /unable to download (?:webpage|api|json)|getaddrinfo|name or service not known|timed out|timeout|connection (?:reset|refused|aborted)|network is unreachable|urlopen error|failed to resolve|ssl|certificate verify|temporary failure|remote end closed/i],
];

function classifyError(text) {
  const s = String(text || '');
  for (const [code, re] of ERROR_RULES) if (re.test(s)) return code;
  return 'unknown';
}

// Son ERROR satırı (yoksa son anlamlı satır) — kullanıcıya ayrıntı olarak gösterilir
function lastErrorLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const err = lines.filter((l) => /^ERROR:/.test(l)).pop() || lines.pop() || '';
  return err.replace(/^ERROR:\s*/, '').replace(/\[[\w:]+\]\s*/, '').slice(0, 400);
}

// --- Analiz sonucu ----------------------------------------------------------------------------------------------------
const BLOCKED_AVAILABILITY = { private: 'private', premium_only: 'members_only', subscriber_only: 'members_only', needs_auth: 'login_required' };

function bestThumb(info) {
  const list = Array.isArray(info.thumbnails) ? info.thumbnails.filter((t) => t && /^https:\/\//.test(t.url || '')) : [];
  if (list.length) {
    // ~480 px genişliğe en yakın olanı (küçük resim için büyüğe gerek yok)
    const scored = list.map((t) => ({ t, d: Math.abs((Number(t.width) || 480) - 480) + (t.preference ? -t.preference : 0) }));
    scored.sort((a, b) => a.d - b.d);
    return scored[0].t.url;
  }
  return /^https:\/\//.test(info.thumbnail || '') ? info.thumbnail : null;
}

const platformFor = (info, fallbackUrl) => {
  const p = URLS.platformOf(info.webpage_url || info.original_url || fallbackUrl || '');
  if (p.id !== 'generic') return p.id;
  const key = String(info.extractor_key || info.ie_key || '').toLowerCase();
  const byKey = URLS.PLATFORMS.find((x) => key.startsWith(x.id) || (x.id === 'x' && key.startsWith('twitter')));
  return byKey ? byKey.id : 'generic';
};

const isHttp = (u) => /^https?:\/\//i.test(String(u || ''));

// -J çıktısı → { kind: 'single' | 'playlist', … } ya da hata { error: kod }
function parseAnalysis(info, sourceUrl) {
  if (!info || typeof info !== 'object') return { error: 'no_formats' };
  const type = info._type || 'video';
  if (type === 'playlist' || type === 'multi_video') {
    const raw = Array.isArray(info.entries) ? info.entries : [];
    const entries = [];
    let i = 0;
    for (const e of raw) {
      i++;
      if (!e) continue;
      const url = isHttp(e.url) ? e.url : isHttp(e.webpage_url) ? e.webpage_url : null;
      if (!url) continue;
      const title = String(e.title || '').trim();
      const hidden = /^\[(?:private|deleted) video\]$/i.test(title) || BLOCKED_AVAILABILITY[e.availability];
      entries.push({
        id: String(e.id || url), url, title: title || url, index: i, duration: num(e.duration), uploader: e.uploader || e.channel || null,
        thumbnail: bestThumb(e), platform: platformFor(e, url), available: !hidden, live: e.live_status === 'is_live' || e.live_status === 'is_upcoming',
      });
    }
    if (!entries.length) return { error: 'playlist_empty' };
    return {
      kind: 'playlist', id: String(info.id || ''), url: info.webpage_url || info.original_url || sourceUrl, title: String(info.title || info.id || '').trim(),
      uploader: info.uploader || info.channel || null, platform: platformFor(info, sourceUrl), thumbnail: bestThumb(info) || (entries.find((e) => e.thumbnail) || {}).thumbnail || null,
      count: num(info.playlist_count) || entries.length, entries, truncated: raw.length >= PLAYLIST_MAX || (num(info.playlist_count) || 0) > raw.length,
    };
  }
  const blocked = BLOCKED_AVAILABILITY[info.availability];
  if (blocked) return { error: blocked };
  const options = FORMATS.optionsOf(info);
  if (options.drm) return { error: 'drm' };
  if (options.live) return { error: 'live' };
  if (!options.video && !options.audio) return { error: 'no_formats' };
  // Yaklaşık boyutlar (en iyi video + en iyi ses) — yalnız bilgi amaçlı
  return {
    kind: 'single', id: String(info.id || ''), url: info.webpage_url || info.original_url || sourceUrl, title: String(info.title || info.id || '').trim(),
    uploader: info.uploader || info.channel || info.creator || null, duration: num(info.duration), thumbnail: bestThumb(info),
    platform: platformFor(info, sourceUrl), extractor: info.extractor_key || null, uploadDate: info.upload_date || null, options,
  };
}

// --- Süreçler -----------------------------------------------------------------------------------------------------------
const ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', NO_COLOR: '1' };

function killTree(child, spawnFn) {
  if (!child || child.exitCode !== null && child.exitCode !== undefined) return;
  try {
    if (process.platform === 'win32' && child.pid) spawnFn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch { /* zaten bitti */ }
}

// Satır satır okuyucu (stdout/stderr)
function lineReader(stream, onLine) {
  let buf = '';
  stream.setEncoding && stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.search(/\r?\n|\r/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + (buf[i] === '\r' && buf[i + 1] === '\n' ? 2 : 1));
      if (line) onLine(line);
    }
  });
  stream.on('end', () => { if (buf) onLine(buf); buf = ''; });
}

function createEngine(deps) {
  // deps: { spawn, ytdlpPath(): string|null, ffmpegDir(): string|null, extraEnv?(): object }
  const spawnFn = deps.spawn;

  function run(args, { signal, onStdoutLine, collectStdout = false, timeoutMs = 0 } = {}) {
    return new Promise((resolve, reject) => {
      const bin = deps.ytdlpPath();
      if (!bin) return reject(Object.assign(new Error('engine missing'), { code: 'engine_missing' }));
      let child;
      try {
        child = spawnFn(bin, args, { windowsHide: true, env: { ...process.env, ...ENV, ...(deps.extraEnv ? deps.extraEnv() : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return reject(Object.assign(new Error(e.message), { code: 'engine_missing' }));
      }
      let out = '';
      let outBytes = 0;
      const errLines = [];
      let aborted = false;
      let timedOut = false;
      const onAbort = () => { aborted = true; killTree(child, spawnFn); };
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
      const timer = timeoutMs ? setTimeout(() => { timedOut = true; killTree(child, spawnFn); }, timeoutMs) : null;
      if (collectStdout) {
        child.stdout.setEncoding && child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => { outBytes += d.length; if (outBytes <= MAX_JSON_BYTES) out += d; });
      } else lineReader(child.stdout, (l) => { if (onStdoutLine) onStdoutLine(l); });
      // --print sessiz kipi açtığından ilerleme satırları (--progress) stderr'e yazılır
      lineReader(child.stderr, (l) => {
        if (onStdoutLine && /^SD(?:P|PP|FMT|FILE)\|/.test(l)) return onStdoutLine(l);
        errLines.push(l);
        if (errLines.length > 60) errLines.shift();
        if (onStdoutLine && /^(?:ERROR|WARNING):/.test(l)) onStdoutLine(l);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(Object.assign(new Error(e.message), { code: e.code === 'ENOENT' ? 'engine_missing' : 'unknown' }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener && signal.removeEventListener('abort', onAbort);
        const errText = errLines.join('\n');
        if (aborted) return reject(Object.assign(new Error('aborted'), { code: 'aborted' }));
        if (timedOut) return reject(Object.assign(new Error('timeout'), { code: 'network' }));
        if (code !== 0) return reject(Object.assign(new Error(lastErrorLine(errText) || `exit ${code}`), { code: classifyError(errText) }));
        if (outBytes > MAX_JSON_BYTES) return reject(Object.assign(new Error('too large'), { code: 'too_large' }));
        resolve({ out, err: errText });
      });
    });
  }

  async function analyze(url, { playlist = false, signal } = {}) {
    const { out } = await run(analyzeArgs(url, { playlist }), { signal, collectStdout: true, timeoutMs: ANALYZE_TIMEOUT_MS });
    let info;
    try { info = JSON.parse(out); } catch { throw Object.assign(new Error('bad json'), { code: 'no_formats' }); }
    const r = parseAnalysis(info, url);
    if (r.error) throw Object.assign(new Error(r.error), { code: r.error });
    return r;
  }

  // Kuyruk runner'ı: { file, size, height, ext }
  async function download(item, env, { signal, onProgress }) {
    fs.mkdirSync(env.outDir, { recursive: true });
    fs.mkdirSync(env.tempDir, { recursive: true });
    const tracker = createProgressTracker();
    let file = null;
    let meta = {};
    let lastEmit = 0;
    await run(downloadArgs(item, { ...env, ffmpegDir: deps.ffmpegDir() }), {
      signal,
      onStdoutLine: (line) => {
        const ev = parseLine(line);
        if (ev.type === 'file') { file = ev.path; return; }
        if (ev.type === 'format') meta = { height: ev.height, ext: ev.ext, title: ev.title };
        const p = tracker.feed(ev);
        if (!p) return;
        const t = Date.now();
        if (ev.type === 'progress' && ev.status === 'downloading' && t - lastEmit < 250) return; // en çok 4/sn
        lastEmit = t;
        onProgress({ ...p, ...(ev.type === 'format' ? { meta } : {}) });
      },
    });
    let size = null;
    try { size = file ? fs.statSync(file).size : null; } catch { /* taşındı */ }
    // Geçici klasör (yalnız bu öğenin): boşsa sil
    try { fs.rmSync(env.tempDir, { recursive: true, force: true }); } catch { /* kullanımda */ }
    return { file, size, height: meta.height || null, ext: file ? path.extname(file).slice(1).toLowerCase() : meta.ext || null };
  }

  async function version() {
    const { out } = await run(['--version'], { collectStdout: true, timeoutMs: 30000 });
    return String(out).trim().split(/\s+/)[0] || null;
  }

  return { run, analyze, download, version };
}

module.exports = {
  FORBIDDEN_ARGS, BASE_ARGS, TOKENS, DEFAULT_TEMPLATE, PLAYLIST_MAX,
  assertSafeArgs, validateTemplate, buildOutputTemplate, cleanName, analyzeArgs, downloadArgs, parseLine, createProgressTracker,
  classifyError, lastErrorLine, parseAnalysis, createEngine, lineReader,
};
