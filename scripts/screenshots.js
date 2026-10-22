// 1600×1000 ekran görüntüleri (gece + gündüz) ve manifest.json: Türkçe set docs/screenshots/, İngilizce set
// docs/screenshots/en/ (aynı dosya adları). Arayüz gerçek dosyalardan (src/renderer) yüklenir; window.api örnek verilerle
// taklit edilir — gerçek ağ, gerçek indirme ya da kişisel veri yok. Küçük resimler uydurma (SVG manzara); oynatma listesi
// örneği Blender Foundation'ın Creative Commons açık filmleridir.
//
// Kullanım: npm run screenshots   (Chromium yolu: CHROMIUM_PATH ya da Playwright'ın varsayılanı)
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const OUT_BASE = path.join(ROOT, 'docs', 'screenshots');
const W = 1600;
const H = 1000;
const NOW = Date.UTC(2026, 9, 22, 11, 32);

const SAMPLE = {
  tr: { email: 'ornek@example.com', name: 'Örnek Kullanıcı', winUser: 'Ornek', password: 'örnekşifre', locale: 'tr-TR', tz: 'Europe/Istanbul', dir: 'C:\\Users\\Ornek\\Downloads\\Social Download' },
  en: { email: 'sample@example.com', name: 'Sample User', winUser: 'Sample', password: 'samplepass', locale: 'en-US', tz: 'Europe/London', dir: 'C:\\Users\\Sample\\Downloads\\Social Download' },
};

// Uydurma küçük resim: gökyüzü + tepeler + güneş (palet sırayla)
const PALETTES = [
  ['#1e3a8a', '#f97316', '#fde68a', '#14532d', '#166534'], ['#0f172a', '#7c3aed', '#f0abfc', '#1f2937', '#374151'],
  ['#0c4a6e', '#38bdf8', '#fef08a', '#065f46', '#047857'], ['#450a0a', '#f43f5e', '#fecaca', '#3f2d20', '#57534e'],
  ['#172554', '#22d3ee', '#ffffff', '#1e293b', '#334155'], ['#422006', '#f59e0b', '#fef3c7', '#78350f', '#92400e'],
  ['#1a2e05', '#84cc16', '#ecfccb', '#14532d', '#365314'], ['#3b0764', '#ec4899', '#fbcfe8', '#1e1b4b', '#312e81'],
];
function thumb(i) {
  const [a, b, sun, h1, h2] = PALETTES[i % PALETTES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 270"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
    <rect width="480" height="270" fill="url(#s)"/><circle cx="${330 - (i % 3) * 90}" cy="${120 + (i % 2) * 20}" r="34" fill="${sun}" opacity=".95"/>
    <path d="M0 200 Q120 ${140 + (i % 4) * 10} 240 190 T480 ${170 + (i % 3) * 12} V270 H0z" fill="${h1}"/><path d="M0 235 Q160 200 300 230 T480 220 V270 H0z" fill="${h2}"/></svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64');
}

const OPEN_MOVIES = [
  ['Big Buck Bunny', 596], ['Elephants Dream', 654], ['Sintel', 888], ['Tears of Steel', 734], ['Cosmos Laundromat', 730],
  ['Agent 327: Operation Barbershop', 231], ['Spring', 464], ['Sprite Fright', 629], ['Charge', 236], ['Wing It!', 220],
];

function data(lang) {
  const tr = lang === 'tr';
  const yt = (id) => `https://www.youtube.com/watch?v=${id}`;
  const single = {
    kind: 'single', id: 'kpd4k', url: 'https://vimeo.com/824512345', platform: 'vimeo', extractor: 'Vimeo', uploadDate: '20260914',
    title: tr ? "Kapadokya'da gün doğumu — drone çekimi" : 'Sunrise over Cappadocia — drone footage', uploader: tr ? 'Örnek Kanal' : 'Sample Channel', duration: 412,
    thumbnail: 'thumb:0', options: { heights: [1080, 720, 540 > 0 ? 480 : 0, 360, 240].filter(Boolean), video: true, audio: true, drm: false, live: false, maxHeight: 1080 },
  };
  const playlist = {
    kind: 'playlist', id: 'PLopen', url: 'https://www.youtube.com/playlist?list=PLopenmovies', platform: 'youtube', title: 'Blender Open Movies',
    uploader: 'Blender', thumbnail: 'thumb:1', count: OPEN_MOVIES.length + 1, truncated: false,
    entries: [...OPEN_MOVIES.slice(0, 6).map(([t, d], i) => ({ id: `om${i}`, url: yt(`om${i}xxxxxxx`), title: t, index: i + 1, duration: d, uploader: 'Blender', thumbnail: `thumb:${i + 2}`, platform: 'youtube', available: true, live: false })),
      { id: 'priv', url: yt('privxxxxxxx'), title: '[Private video]', index: 7, duration: null, uploader: null, thumbnail: null, platform: 'youtube', available: false, live: false },
      ...OPEN_MOVIES.slice(6).map(([t, d], i) => ({ id: `om${i + 6}`, url: yt(`om${i + 6}xxxxxxx`), title: t, index: i + 8, duration: d, uploader: 'Blender', thumbnail: `thumb:${i + 8}`, platform: 'youtube', available: true, live: false }))],
  };
  const podcast = {
    kind: 'single', id: 'pod', url: 'https://soundcloud.com/ornek-radyo/bolum-42', platform: 'soundcloud', extractor: 'Soundcloud', uploadDate: '20261001',
    title: tr ? 'Bilim sohbetleri — 42. bölüm: Işığın hızı' : 'Science talks — episode 42: The speed of light', uploader: tr ? 'Örnek Radyo' : 'Sample Radio', duration: 2712,
    thumbnail: 'thumb:5', options: { heights: [], video: false, audio: true, drm: false, live: false, maxHeight: null },
  };
  const v = (h, c = 'mp4') => ({ kind: 'video', height: h, container: c, audioFormat: 'mp3', audioQuality: '192' });
  const au = (f, q) => ({ kind: 'audio', height: 0, container: 'mp4', audioFormat: f, audioQuality: q });
  const lab = (o) => (o.kind === 'audio' ? `${o.audioFormat.toUpperCase()} · ${o.audioQuality === 'best' ? (tr ? 'En iyi' : 'Best') : o.audioQuality + ' kbps'}` : `${o.height === 2160 ? '4K (2160p)' : o.height + 'p'} · ${o.container.toUpperCase()}`);
  const pl = { title: 'Blender Open Movies', count: 11 };
  const it = (id, x) => ({ id, attempts: 1, createdAt: NOW - 600000, startedAt: NOW - 200000, finishedAt: null, file: null, size: null, error: null, speed: null, progress: null, dir: SAMPLE[lang].dir, ...x, label: lab(x.opts) });
  const queue = [
    it('q1', { url: yt('om2xxxxxxx'), title: 'Sintel', platform: 'youtube', uploader: 'Blender', duration: 888, thumbnail: 'thumb:4', opts: v(1080), playlist: { ...pl, index: 3 }, state: 'running', speed: 4.3e6, progress: { phase: 'download', part: 1, parts: 2, pct: 61.7, downloaded: 2.38e8, total: 3.86e8, eta: 34 } }),
    it('q2', { url: podcast.url, title: podcast.title, platform: 'soundcloud', uploader: podcast.uploader, duration: 2712, thumbnail: 'thumb:5', opts: au('mp3', '192'), state: 'running', speed: 1.1e6, progress: { phase: 'post', pp: 'ExtractAudio', pct: 97 } }),
    it('q3', { url: yt('om3xxxxxxx'), title: 'Tears of Steel', platform: 'youtube', uploader: 'Blender', duration: 734, thumbnail: 'thumb:6', opts: v(1080), playlist: { ...pl, index: 4 }, state: 'paused', progress: { pct: 41 } }),
    it('q4', { url: yt('om4xxxxxxx'), title: 'Cosmos Laundromat', platform: 'youtube', uploader: 'Blender', duration: 730, thumbnail: 'thumb:7', opts: v(1080), playlist: { ...pl, index: 5 }, state: 'queued' }),
    it('q5', { url: yt('om5xxxxxxx'), title: 'Agent 327: Operation Barbershop', platform: 'youtube', uploader: 'Blender', duration: 231, thumbnail: 'thumb:2', opts: v(1080), playlist: { ...pl, index: 6 }, state: 'queued' }),
    it('q6', { url: 'https://www.tiktok.com/@ornek/video/7312345678901234567', title: tr ? 'Ekmek tarifi — 60 saniyede ekşi maya' : 'Bread recipe — sourdough in 60 seconds', platform: 'tiktok', uploader: '@ornek', duration: 58, thumbnail: 'thumb:3', opts: v(1080), state: 'done', finishedAt: NOW - 90000, size: 2.41e7, file: 'x.mp4', progress: { pct: 100 } }),
    it('q7', { url: 'https://www.instagram.com/reel/C9abcDEFghi/', title: 'instagram.com/reel/C9abcDEFghi', platform: 'instagram', uploader: null, duration: null, thumbnail: null, opts: v(1080), state: 'error', error: { code: 'login_required', message: 'Requested content is not available, rate-limit reached or login required' } }),
    it('q8', { url: yt('om0xxxxxxx'), title: 'Big Buck Bunny', platform: 'youtube', uploader: 'Blender', duration: 596, thumbnail: 'thumb:2', opts: v(2160, 'mkv'), state: 'done', finishedAt: NOW - 400000, size: 1.18e9, file: 'y.mkv', progress: { pct: 100 } }),
  ];
  const history = [
    ['q6', 'tiktok', queue[5].title, '1080p · MP4', '@ornek', 58, 1], ['q8', 'youtube', 'Big Buck Bunny', '4K (2160p) · MKV', 'Blender', 596, 7],
    ['h3', 'vimeo', single.title, '1080p · MP4', single.uploader, 412, 26], ['h4', 'soundcloud', tr ? 'Bilim sohbetleri — 41. bölüm' : 'Science talks — episode 41', 'MP3 · 192 kbps', podcast.uploader, 2650, 50],
    ['h5', 'reddit', tr ? 'Gökyüzünde kuzey ışıkları (zaman atlamalı)' : 'Northern lights timelapse', '720p · MP4', 'r/timelapse', 41, 140],
    ['h6', 'dailymotion', tr ? 'Yelken yarışı özeti' : 'Sailing race highlights', '720p · MP4', tr ? 'Örnek Spor' : 'Sample Sports', 305, 300],
    ['h7', 'x', tr ? 'Roket fırlatma anı' : 'Rocket launch moment', '1080p · MP4', '@ornekuzay', 47, 1440],
    ['h8', 'youtube', 'Elephants Dream', 'MP3 · ' + (tr ? 'En iyi' : 'Best'), 'Blender', 654, 2880], ['h9', 'twitch', tr ? 'Turnuva finali — son raunt' : 'Tournament final — last round', '720p · MP4', 'ornek_tv', 182, 4320],
  ].map(([id, platform, title, label, uploader, duration, mins]) => ({ id, url: `https://example.com/${id}`, platform, title, label, uploader, duration, finishedAt: NOW - mins * 60000 }));
  return { single, playlist, podcast, queue, history };
}

function store(lang, { height = 2160, history = [] } = {}) {
  return {
    settings: {
      appTheme: 'system', language: lang, syncHistory: true, downloadDir: SAMPLE[lang].dir, clipboardWatch: false, resumeOnStart: true, notifyDone: true,
      openAtLogin: false, minimizeToTray: false, closeToTray: false, checkUpdates: true, checkEngine: true, noticeAccepted: true,
      download: { kind: 'video', height, container: 'mp4', audioFormat: 'mp3', audioQuality: '192', template: '{title}', concurrency: 2, limitRate: 0, gapSec: 2, playlistFolder: true, embedMetadata: true },
    },
    history,
    limits: { maxConcurrency: 4, ladder: [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144], containers: ['mp4', 'mkv', 'webm'], audioFormats: ['mp3', 'm4a', 'opus'], audioQualities: ['best', '320', '256', '192', '128'],
      tokens: ['title', 'uploader', 'id', 'date', 'platform', 'resolution', 'playlist', 'index'] },
    platforms: [],
  };
}

const ENGINE = { ytdlpPath: 'C:\\Program Files\\Mastertool\\Social Download\\resources\\engine\\yt-dlp.exe', ytdlpVersion: '2026.10.21', updated: false, bundledYtdlp: '2026.10.21',
  ffmpegDir: 'C:\\Program Files\\Mastertool\\Social Download\\resources\\engine\\ffmpeg', ffmpegVersion: 'n9.0.2-33-g4cf298e66a', lastCheck: NOW - 3600000, latest: '2026.10.21' };

// window.api taklidi (preload.js ile aynı yüzey)
function stubScript({ lang, st, queue, thumbs }) {
  const S = SAMPLE[lang];
  return `(() => {
    const STORE = ${JSON.stringify(st)};
    const QUEUE = ${JSON.stringify(queue)};
    const THUMBS = ${JSON.stringify(thumbs)};
    const listeners = {};
    const on = (name) => (cb) => { (listeners[name] = listeners[name] || []).push(cb); return () => {}; };
    window.__emit = (name, data) => (listeners[name] || []).forEach((cb) => cb(data));
    window.__analyze = null;
    window.api = {
      lang: ${JSON.stringify(lang)}, version: '1.0.0',
      accountState: async () => ({ loggedIn: true, email: ${JSON.stringify(S.email)}, user: { id: 1, name: ${JSON.stringify(S.name)}, email: ${JSON.stringify(S.email)} }, syncEnabled: true, state: 'ok', lastSyncAt: ${NOW}, error: null, notice: null, appVersion: '1.0.0' }),
      login: async () => ({ ok: false }), logout: async () => {}, syncNow: async () => {}, setSyncEnabled: async () => ({ ok: true }), deleteRemoteLibrary: async () => ({ ok: true }),
      openWeb: async () => {}, onAccountStatus: on('account'), onUpdateAvailable: on('update'), openMastertool: async () => {},
      about: async () => ({ version: '1.0.0', electron: '33.4.11', chrome: '130.0.6723.191', openAtLogin: false, portable: false, packaged: true, update: null, engine: ${JSON.stringify(ENGINE)} }),
      checkUpdate: async () => ({ ok: true, newer: false }), openLicenses: async () => {},
      getStore: async () => STORE, onStoreChanged: on('store'), setSettings: async () => ({ ok: true }), acceptNotice: async () => ({ ok: true }),
      onHistoryChanged: on('history'), removeHistory: async () => ({ ok: true }), clearHistory: async () => ({ ok: true }),
      analyze: async () => { await new Promise((r) => setTimeout(r, 30)); return window.__analyze; }, cancelAnalyze: async () => ({ ok: true }), onAnalyzeProgress: on('aprog'),
      thumb: async (u) => THUMBS[u] || null, readClipboard: async () => ({ text: '', urls: [], rejected: [] }), onClipboardOffer: on('clip'),
      checkTemplate: async (tpl) => ({ ok: true, sample: tpl.replace(/\{(\w+)\}/g, (m, k) => ({ index: '03', playlist: 'Playlist', title: '%(title)s', id: '%(id)s', uploader: '%(uploader,channel,creator|NA)s',
        date: '%(upload_date>%Y-%m-%d|NA)s', platform: '%(extractor_key)s', resolution: '%(height&{}p|audio)s' }[k] || m)) + '.%(ext)s' }),
      getQueue: async () => QUEUE, addToQueue: async () => ({ ok: true, added: 1, dup: 0 }), queueOp: async () => ({ ok: true }), queueMove: async () => ({ ok: true }),
      pauseAll: async () => ({ ok: true }), resumeAll: async () => ({ ok: true }), clearFinished: async () => ({ ok: true }),
      onQueueChanged: on('queue'), onQueueProgress: on('qprog'), openFile: async () => ({ ok: true }), showFile: async () => ({ ok: true }),
      openDir: async () => ({ ok: true }), chooseDir: async () => ({ ok: false }), openSource: async () => ({ ok: true }), copyText: async () => ({ ok: true }),
      engineInfo: async () => (${JSON.stringify(ENGINE)}), engineCheck: async () => ({ ok: true, newer: false, latest: '2026.10.21', info: ${JSON.stringify(ENGINE)} }),
      engineUpdate: async () => ({ ok: true, updated: false }), engineReset: async () => ({ ok: true, info: ${JSON.stringify(ENGINE)} }), engineLicenses: async () => {},
      onEngineStep: on('estep'), onEngineStatus: on('estatus'),
    };
  })();`;
}

// Başlık ve açıklamalar (≤ 80 karakter); dosya adları iki dilde aynı
const TEXT = {
  tr: {
    welcome: ['Bağlantıyı yapıştırın', 'Ctrl+V ya da Yapıştır: bağlantı analiz edilir; desteklenen platformlar'],
    single: ['Analiz ve çözünürlük seçimi', 'Kaynakta 4K yok: en yakın düşük çözünürlük (1080p) indirileceği açıkça yazılır'],
    playlist: ['Oynatma listesi', 'Tüm öğeler seçili gelir, tek tek kaldırılabilir; özel öğeler seçilemez'],
    queue: ['İndirme kuyruğu', 'Eşzamanlı 1–4 indirme; ilerleme, hız, kalan süre; duraklat, sürdür, yeniden dene'],
    audio: ['Yalnız ses', 'MP3, M4A ya da Opus; 128–320 kbps ya da en iyi kalite'],
    history: ['Geçmiş', 'Son indirmeler; yeniden indir, kaynağı aç; isteğe bağlı şifreli senkron'],
    setdl: ['Ayarlar › İndirme', 'Klasör, dosya adı şablonu, varsayılan biçim, eşzamanlılık, hız ve istek aralığı'],
    engine: ['Ayarlar › Motor', 'yt-dlp + FFmpeg; imza ve SHA-256 doğrulamalı "Motoru güncelle"'],
    notice: ['Kullanmadan önce', 'Yalnız herkese açık içerik; giriş gerektiren ve DRM’li içerik tasarım gereği yok'],
    login: ['Tek giriş', 'Mastertool hesabıyla bir kez giriş yapın; diğer uygulamalar yeniden sormaz'],
  },
  en: {
    welcome: ['Paste a link', 'Ctrl+V or Paste: the link is analyzed; supported platforms'],
    single: ['Analysis and resolution choice', 'No 4K in the source: it clearly says the closest lower (1080p) will be used'],
    playlist: ['Playlist', 'All items come selected and can be removed one by one; private ones are skipped'],
    queue: ['Download queue', '1–4 parallel downloads; progress, speed, time left; pause, resume, retry'],
    audio: ['Audio only', 'MP3, M4A or Opus; 128–320 kbps or best quality'],
    history: ['History', 'Recent downloads; download again, open source; optional encrypted sync'],
    setdl: ['Settings › Downloads', 'Folder, file name template, default format, parallelism, speed and pacing'],
    engine: ['Settings › Engine', 'yt-dlp + FFmpeg; signature- and SHA-256-verified "Update engine"'],
    notice: ['Before you start', 'Public content only; sign-in-only and DRM content is not supported by design'],
    login: ['Single sign-on', 'Sign in once with your Mastertool account; the other apps won’t ask again'],
  },
};

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const thumbs = {};
  for (let i = 0; i < 16; i++) thumbs[`thumb:${i}`] = thumb(i);
  for (const lang of ['tr', 'en']) {
    const OUT = lang === 'tr' ? OUT_BASE : path.join(OUT_BASE, lang);
    fs.mkdirSync(OUT, { recursive: true });
    const T = TEXT[lang];
    const S = SAMPLE[lang];
    const D = data(lang);
    const manifest = [];
    const errors = [];

    const shot = async (file, theme, [title, caption], run) => {
      if (caption.length > 80) throw new Error(`caption > 80: ${caption}`);
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: theme, locale: S.locale, timezoneId: S.tz });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(`${file}: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(`${file}: ${m.text()}`); });
      await run(page, theme === 'dark');
      await page.mouse.move(W - 2, H - 2);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, file) });
      await ctx.close();
      manifest.push({ file, theme, title, caption });
      console.log('✓', lang, file);
    };
    const openMain = async (page, { st = store(lang, { history: D.history }), queue = D.queue } = {}, after) => {
      await page.addInitScript(stubScript({ lang, st, queue, thumbs }));
      await page.goto('file://' + path.join(ROOT, 'src', 'renderer', 'index.html'));
      await page.waitForSelector('.welcome');
      if (after) await after(page);
    };
    const analyzeWith = async (page, url, results) => {
      await page.evaluate((r) => { window.__analyze = r; }, { ok: true, results, rejected: [], skipped: 0 });
      await page.fill('#url', url);
      await page.click('#btnAnalyze');
      await page.waitForSelector('#fmt .fmt-row');
      await page.waitForTimeout(300);
    };

    for (const theme of ['dark', 'light']) {
      const tn = theme === 'dark' ? 'gece' : 'gunduz';
      await shot(`01-hos-geldiniz-${tn}.png`, theme, T.welcome, (p) => openMain(p));
      await shot(`02-video-analiz-${tn}.png`, theme, T.single, (p) => openMain(p, {}, (pg) => analyzeWith(pg, D.single.url, [{ ok: true, url: D.single.url, hint: null, result: D.single }])));
      await shot(`03-oynatma-listesi-${tn}.png`, theme, T.playlist, (p) => openMain(p, { st: store(lang, { height: 1080, history: D.history }) }, async (pg) => {
        await analyzeWith(pg, D.playlist.url, [{ ok: true, url: D.playlist.url, hint: 'playlist', result: D.playlist }]);
        await pg.click('.entry[data-key="p0-4"]'); // bir öğeyi kaldır
      }));
      await shot(`04-kuyruk-${tn}.png`, theme, T.queue, (p) => openMain(p, {}, async (pg) => {
        await pg.waitForSelector('.q-item');
        await pg.click('.q-item[data-id="q3"]');
      }));
      await shot(`05-yalniz-ses-${tn}.png`, theme, T.audio, (p) => openMain(p, {}, (pg) => analyzeWith(pg, D.podcast.url, [{ ok: true, url: D.podcast.url, hint: null, result: D.podcast }])));
      await shot(`06-gecmis-${tn}.png`, theme, T.history, (p) => openMain(p, {}, async (pg) => {
        await pg.click('#tabs [data-t="history"]');
        await pg.waitForSelector('.h-item');
      }));
      await shot(`07-ayarlar-indirme-${tn}.png`, theme, T.setdl, (p) => openMain(p, {}, async (pg) => {
        await pg.click('#btnSettings');
        await pg.waitForSelector('.set-wrap');
        await pg.click('.set-nav [data-tab="download"]');
        await pg.fill('#s-tpl', '{index} - {title} [{resolution}]');
        await pg.dispatchEvent('#s-tpl', 'input');
      }));
      await shot(`08-ayarlar-motor-${tn}.png`, theme, T.engine, (p) => openMain(p, {}, async (pg) => {
        await pg.click('#btnSettings');
        await pg.waitForSelector('.set-wrap');
        await pg.click('.set-nav [data-tab="engine"]');
        await pg.click('#e-check');
        await pg.waitForTimeout(200);
      }));
      await shot(`09-uyari-${tn}.png`, theme, T.notice, (p) => openMain(p, { st: { ...store(lang), settings: { ...store(lang).settings, noticeAccepted: false } }, queue: [] }, async (pg) => {
        await pg.waitForSelector('.modal .notice-body');
      }));
      // Giriş penceresi 440×640; masaüstü zemini üzerinde ortalanır
      await shot(`10-giris-${tn}.png`, theme, T.login, async (p, dark) => {
        const lp = await p.context().newPage();
        lp.on('pageerror', (e) => errors.push(`login: ${e.message}`));
        await lp.setViewportSize({ width: 440, height: 640 });
        await lp.addInitScript(stubScript({ lang, st: store(lang), queue: [], thumbs }));
        await lp.addInitScript(() => { const a = window.api.accountState; window.api.accountState = async () => ({ ...(await a()), loggedIn: false }); });
        await lp.goto('file://' + path.join(ROOT, 'src', 'renderer', 'login.html'));
        await lp.waitForTimeout(300);
        await lp.evaluate((pw) => { document.querySelector('#password').value = pw; document.activeElement.blur(); }, S.password);
        const png = (await lp.screenshot()).toString('base64');
        await lp.close();
        const icon = fs.readFileSync(path.join(ROOT, 'build', 'icon.svg')).toString('base64');
        const bg = dark ? 'radial-gradient(900px 600px at 80% 0%, #3b1a4a, transparent), radial-gradient(800px 600px at 0% 100%, #0f3a44, transparent), #0b0f17'
          : 'radial-gradient(900px 600px at 80% 0%, #fbdcef, transparent), radial-gradient(800px 600px at 0% 100%, #d5f5fb, transparent), #eef2f7';
        await p.setContent(`<body style="margin:0;height:100vh;display:grid;place-items:center;background:${bg}">
          <div style="border-radius:10px;overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,${dark ? '.55' : '.22'}),0 0 0 1px rgba(${dark ? '255,255,255,.08' : '0,0,0,.08'})">
            <div style="height:32px;background:${dark ? '#1c1f26' : '#f3f3f3'};display:flex;align-items:center;gap:8px;padding:0 12px;font:12px 'Segoe UI',system-ui;color:${dark ? '#ddd' : '#333'}">
              <img src="data:image/svg+xml;base64,${icon}" style="width:16px;height:16px;border-radius:4px">Social Download</div>
            <img src="data:image/png;base64,${png}" style="display:block;width:440px;height:640px"></div></body>`);
      });
    }
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`${manifest.length} görüntü → ${path.relative(ROOT, OUT)}`);
    if (errors.length) { console.error('Sayfa hataları:\n' + errors.join('\n')); process.exitCode = 1; }
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
