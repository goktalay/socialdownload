// Biçim seçimi: motorun (yt-dlp) analiz çıktısından kullanılabilir çözünürlükleri çıkarır, istenen çözünürlük kaynakta
// yoksa en yakın DÜŞÜK olanı (o da yoksa en yakın yükseği) belirler ve indirme için yt-dlp biçim argümanlarını kurar.
// Hem ana süreçte (require) hem pencerede (<script>) çalışır.
(function (root) {
  'use strict';

  // Standart basamaklar (kısa kenar). Dikey videolarda (1080×1920) de kısa kenar esas alınır — yt-dlp'nin "res" ölçütüyle aynı.
  const LADDER = [4320, 2160, 1440, 1080, 720, 480, 360, 240, 144];
  const CONTAINERS = ['mp4', 'mkv', 'webm'];
  const AUDIO_FORMATS = ['mp3', 'm4a', 'opus'];
  const AUDIO_QUALITIES = ['best', '320', '256', '192', '128']; // kbps; "best" = kaynağın en iyisi / VBR 0
  const LABEL = { 4320: '8K', 2160: '4K', 1440: '2K' };

  const DEFAULTS = Object.freeze({ kind: 'video', height: 1080, container: 'mp4', audioFormat: 'mp3', audioQuality: '192' });

  // Ham piksel → basamak: kısa kenar ≥ basamağın %90'ı ise o basamak (1076 → 1080, 718 → 720, 544 → 480)
  function ladderOf(px) {
    const v = Number(px) || 0;
    if (v <= 0) return null;
    for (const l of LADDER) if (v >= l * 0.9) return l;
    return LADDER[LADDER.length - 1];
  }

  const shortSide = (f) => {
    const w = Number(f.width) || 0;
    const h = Number(f.height) || 0;
    if (w && h) return Math.min(w, h);
    return h || (typeof f.resolution === 'string' && /^\d+x(\d+)$/.test(f.resolution) ? Number(f.resolution.split('x')[1]) : 0);
  };

  const hasVideo = (f) => f && f.vcodec !== 'none' && (shortSide(f) > 0 || (f.vcodec && f.vcodec !== 'none'));
  const hasAudio = (f) => f && f.acodec && f.acodec !== 'none';

  // Analiz edilmiş tek bir öğeden seçenekler: { heights: [desc], video, audio, drm, live, maxHeight }
  function optionsOf(info) {
    const formats = Array.isArray(info && info.formats) ? info.formats : [];
    const usable = formats.filter((f) => !f.has_drm);
    const heights = new Set();
    let video = false;
    let audio = false;
    for (const f of usable) {
      if (hasVideo(f)) {
        video = true;
        const l = ladderOf(shortSide(f));
        if (l) heights.add(l);
      }
      if (hasAudio(f)) audio = true;
    }
    // Biçim listesi olmayan tek dosyalı kaynaklar (bazı genel sayfalar): üst düzey alanlar
    if (!formats.length && info) {
      const s = shortSide(info);
      if (s) { video = true; heights.add(ladderOf(s)); }
      if (info.vcodec && info.vcodec !== 'none') video = true;
      if (!info.vcodec || info.acodec !== 'none') audio = true;
    }
    const list = [...heights].sort((a, b) => b - a);
    return {
      heights: list, video, audio,
      drm: formats.length > 0 && usable.length === 0,
      live: !!(info && (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming')),
      maxHeight: list[0] || null,
    };
  }

  // İstenen çözünürlük kaynakta yoksa en yakın düşük; düşük hiç yoksa en yakın yüksek.
  // { height, exact, direction: 'same'|'lower'|'higher'|null }
  function resolveHeight(available, target) {
    const list = [...new Set((available || []).map(Number).filter((x) => x > 0))].sort((a, b) => b - a);
    const t = Number(target) || 0;
    if (!list.length) return { height: null, exact: false, direction: null };
    if (!t) return { height: list[0], exact: true, direction: 'same' };
    if (list.includes(t)) return { height: t, exact: true, direction: 'same' };
    const lower = list.find((h) => h < t);
    if (lower) return { height: lower, exact: false, direction: 'lower' };
    return { height: list[list.length - 1], exact: false, direction: 'higher' };
  }

  function sanitizeOpts(o) {
    const v = o && typeof o === 'object' ? o : {};
    const height = Number(v.height);
    return {
      kind: v.kind === 'audio' ? 'audio' : 'video',
      height: LADDER.includes(height) ? height : 0, // 0 = en iyi
      container: CONTAINERS.includes(v.container) ? v.container : DEFAULTS.container,
      audioFormat: AUDIO_FORMATS.includes(v.audioFormat) ? v.audioFormat : DEFAULTS.audioFormat,
      audioQuality: AUDIO_QUALITIES.includes(String(v.audioQuality)) ? String(v.audioQuality) : DEFAULTS.audioQuality,
    };
  }

  // yt-dlp biçim argümanları. Çözünürlük "-S res:H" ile verilir: yt-dlp en büyük ≤ H olanı, yoksa en küçük > H olanı seçer
  // (resolveHeight ile aynı kural) — oynatma listesinde her öğe ayrı analiz edilmeden doğru basamak seçilir.
  function formatArgs(opts) {
    const o = sanitizeOpts(opts);
    if (o.kind === 'audio') {
      const pref = { mp3: 'ba/b', m4a: 'ba[ext=m4a]/ba/b', opus: 'ba[acodec=opus]/ba/b' }[o.audioFormat];
      const q = o.audioQuality === 'best' ? '0' : `${o.audioQuality}K`;
      return ['-f', pref, '-x', '--audio-format', o.audioFormat, '--audio-quality', q];
    }
    const sort = [o.height ? `res:${o.height}` : 'res'];
    if (o.container === 'mp4') sort.push('ext:mp4:m4a', 'vcodec:h264');
    if (o.container === 'webm') sort.push('ext:webm:webm');
    const merge = { mp4: 'mp4/mkv', mkv: 'mkv', webm: 'webm/mkv' }[o.container];
    const args = ['-f', 'bv*+ba/b', '-S', sort.join(','), '--merge-output-format', merge];
    if (o.container === 'mkv') args.push('--remux-video', 'mkv');
    if (o.container === 'mp4') args.push('--remux-video', 'flv>mp4/mov>mp4');
    return args;
  }

  // Kısa etiket: "1080p · MP4", "4K · MKV", "MP3 · 192 kbps", "En iyi · MP4"
  function labelOf(opts, { best = 'Best' } = {}) {
    const o = sanitizeOpts(opts);
    if (o.kind === 'audio') return `${o.audioFormat.toUpperCase()} · ${o.audioQuality === 'best' ? best : `${o.audioQuality} kbps`}`;
    const h = o.height ? (LABEL[o.height] ? `${LABEL[o.height]} (${o.height}p)` : `${o.height}p`) : best;
    return `${h} · ${o.container.toUpperCase()}`;
  }
  const heightLabel = (h) => (LABEL[h] ? `${h}p ${LABEL[h]}` : `${h}p`);

  const api = { LADDER, CONTAINERS, AUDIO_FORMATS, AUDIO_QUALITIES, DEFAULTS, ladderOf, optionsOf, resolveHeight, sanitizeOpts, formatArgs, labelOf, heightLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FORMATS = api;
})(typeof self !== 'undefined' ? self : this);
