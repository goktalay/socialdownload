// Bağlantı sınıflandırma: metinden bağlantıları ayıklar, platformu tanır, oynatma listesi ipuçlarını ve tasarım gereği
// DESTEKLENMEYEN (DRM'li / abonelikli akış) siteleri belirler. Hem ana süreçte (require) hem pencerede (<script>) çalışır.
//
// Tasarım sınırı: Social Download yalnız HERKESE AÇIK içerik içindir. Netflix, Spotify, Disney+ gibi DRM ile korunan ya da
// abonelik gerektiren akış servisleri analiz bile edilmeden reddedilir; DRM atlatma, çerez içe aktarma yoktur.
(function (root) {
  'use strict';

  // Platformlar: kimlik, görünen ad, marka rengi, alan adları. Burada olmayan herkese açık siteler "generic" olarak
  // motorun (yt-dlp) genel çıkarıcılarına bırakılır.
  const PLATFORMS = [
    { id: 'youtube', name: 'YouTube', color: '#ff0033', hosts: ['youtube.com', 'youtu.be', 'youtube-nocookie.com', 'music.youtube.com'] },
    { id: 'instagram', name: 'Instagram', color: '#e1306c', hosts: ['instagram.com', 'instagr.am'] },
    { id: 'tiktok', name: 'TikTok', color: '#25f4ee', hosts: ['tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'] },
    { id: 'x', name: 'X (Twitter)', color: '#94a3b8', hosts: ['x.com', 'twitter.com', 'mobile.twitter.com', 't.co'] },
    { id: 'facebook', name: 'Facebook', color: '#1877f2', hosts: ['facebook.com', 'fb.watch', 'fb.com', 'm.facebook.com'] },
    { id: 'vimeo', name: 'Vimeo', color: '#1ab7ea', hosts: ['vimeo.com', 'player.vimeo.com'] },
    { id: 'dailymotion', name: 'Dailymotion', color: '#0a7cff', hosts: ['dailymotion.com', 'dai.ly'] },
    { id: 'twitch', name: 'Twitch', color: '#9146ff', hosts: ['twitch.tv', 'clips.twitch.tv', 'm.twitch.tv'] },
    { id: 'reddit', name: 'Reddit', color: '#ff4500', hosts: ['reddit.com', 'redd.it', 'v.redd.it', 'old.reddit.com'] },
    { id: 'soundcloud', name: 'SoundCloud', color: '#ff5500', hosts: ['soundcloud.com', 'on.soundcloud.com', 'm.soundcloud.com'] },
    { id: 'bilibili', name: 'Bilibili', color: '#00a1d6', hosts: ['bilibili.com', 'b23.tv'] },
    { id: 'bandcamp', name: 'Bandcamp', color: '#1da0c3', hosts: ['bandcamp.com'] },
    { id: 'pinterest', name: 'Pinterest', color: '#e60023', hosts: ['pinterest.com', 'pin.it'] },
    { id: 'linkedin', name: 'LinkedIn', color: '#0a66c2', hosts: ['linkedin.com'] },
    { id: 'tumblr', name: 'Tumblr', color: '#36465d', hosts: ['tumblr.com'] },
    { id: 'archive', name: 'Internet Archive', color: '#64748b', hosts: ['archive.org'] },
    { id: 'peertube', name: 'PeerTube', color: '#f1680d', hosts: ['framatube.org', 'peertube.tv'] },
  ];
  const GENERIC = { id: 'generic', name: 'Web', color: '#22d3ee', hosts: [] };

  // DRM ile korunan ya da yalnız abonelikle izlenebilen servisler — tasarım gereği desteklenmez.
  const DRM_HOSTS = [
    'netflix.com', 'spotify.com', 'disneyplus.com', 'disney.com', 'primevideo.com', 'hulu.com', 'max.com', 'hbomax.com',
    'tv.apple.com', 'music.apple.com', 'deezer.com', 'tidal.com', 'paramountplus.com', 'peacocktv.com', 'crunchyroll.com',
    'dazn.com', 'blutv.com', 'exxen.com', 'gain.tv', 'mubi.com', 'audible.com', 'music.amazon.com', 'nowtv.com', 'tabii.com',
  ];
  // amazon.<ülke>/gp/video, amazon.<ülke>/Prime-Video yolları da DRM'lidir
  const DRM_PATHS = [/^(?:www\.)?amazon\.[a-z.]+$/i, /\/(?:gp\/video|prime-?video)/i];

  // Yerel ve özel adresler analiz edilmez (yalnız internetteki herkese açık sayfalar)
  const PRIVATE_HOST = /^(?:localhost|.*\.local|.*\.lan|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*)$/i;

  const MAX_URL_LEN = 2048;
  const MAX_URLS = 200; // tek yapıştırmada en çok bu kadar bağlantı

  const hostOf = (u) => String(u.hostname || '').toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const matchHost = (host, list) => list.some((h) => host === h || host.endsWith('.' + h));

  function platformOf(urlOrHost) {
    let host = String(urlOrHost || '');
    try { if (/^https?:/i.test(host)) host = new URL(host).hostname; } catch { /* host verildi */ }
    host = host.toLowerCase().replace(/^www\./, '');
    return PLATFORMS.find((p) => matchHost(host, p.hosts)) || GENERIC;
  }
  const platformById = (id) => PLATFORMS.find((p) => p.id === id) || GENERIC;

  function isDrmHost(u) {
    const host = hostOf(u);
    if (matchHost(host, DRM_HOSTS)) return true;
    return DRM_PATHS[0].test(host) && DRM_PATHS[1].test(u.pathname || '');
  }

  // Oynatma listesi / kanal / albüm ipucu (kesin bilgi analizde motordan gelir)
  function playlistHint(u) {
    const host = hostOf(u);
    const p = u.pathname || '';
    const q = u.searchParams;
    const pl = platformOf(host).id;
    if (pl === 'youtube') {
      if (/^\/playlist\/?$/.test(p) && q.get('list')) return 'playlist';
      if (/^\/(?:@[^/]+|c\/[^/]+|channel\/[^/]+|user\/[^/]+)(?:\/(?:videos|shorts|streams|playlists|featured|releases))?\/?$/.test(p)) return 'channel';
      if (q.get('list') && !q.get('v')) return 'playlist';
      if (q.get('list') && q.get('v')) return 'video_in_playlist';
    }
    if (pl === 'soundcloud' && /\/sets\//.test(p)) return 'playlist';
    if (pl === 'soundcloud' && /^\/[^/]+\/?(?:tracks|albums|popular-tracks)?\/?$/.test(p)) return 'channel';
    if (pl === 'vimeo' && /^\/(?:showcase|album|channels)\//.test(p)) return 'playlist';
    if (pl === 'dailymotion' && /^\/playlist\//.test(p)) return 'playlist';
    if (pl === 'twitch' && /^\/[^/]+\/(?:videos|clips)\/?$/.test(p)) return 'channel';
    if (pl === 'bandcamp' && /^\/album\//.test(p)) return 'playlist';
    return null;
  }

  // Tek bir bağlantıyı denetler. { ok, url, platform, hint } | { ok: false, code }
  function classify(raw) {
    let s = String(raw || '').trim();
    if (!s) return { ok: false, code: 'empty' };
    if (s.length > MAX_URL_LEN) return { ok: false, code: 'too_long' };
    // Şemasız "youtu.be/abc" yazımları
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) s = 'https://' + s;
    let u;
    try { u = new URL(s); } catch { return { ok: false, code: 'invalid' }; }
    if (!/^https?:$/.test(u.protocol)) return { ok: false, code: 'scheme' };
    if (u.username || u.password) return { ok: false, code: 'credentials' }; // bağlantıya gömülü kullanıcı adı/şifre yok
    const host = hostOf(u);
    if (host && PRIVATE_HOST.test(host)) return { ok: false, code: 'private_host' };
    if (!host || !host.includes('.')) return { ok: false, code: 'invalid' };
    if (isDrmHost(u)) return { ok: false, code: 'drm', host };
    u.hash = '';
    // İzleme parametreleri atılır (aynı videonun iki kez kuyruğa girmesini de önler)
    for (const k of [...u.searchParams.keys()]) if (/^(?:utm_\w+|si|feature|fbclid|gclid|igsh|igshid|ref_src|ref_url|is_from_webapp|sender_device)$/i.test(k)) u.searchParams.delete(k);
    const platform = platformOf(host);
    return { ok: true, url: u.toString(), platform: platform.id, hint: playlistHint(u) };
  }

  // Yapıştırılan metinden (çok satırlı, boşluk/virgülle ayrılmış) bağlantıları çıkarır; tekrarlar ayıklanır.
  // { urls: [{url, platform, hint}], rejected: [{text, code}] }
  function extract(text) {
    const tokens = String(text || '').split(/[\s,;<>"'`]+/).map((x) => x.replace(/^[([{]+|[)\]}.!?]+$/g, '')).filter(Boolean);
    const urls = [];
    const rejected = [];
    const seen = new Set();
    for (const tok of tokens) {
      if (!/^https?:\/\//i.test(tok) && !/^[\w-]+(\.[\w-]+)+\//.test(tok)) continue; // düz sözcükler bağlantı sayılmaz
      const c = classify(tok);
      if (!c.ok) { rejected.push({ text: tok.slice(0, 120), code: c.code }); continue; }
      if (seen.has(c.url)) continue;
      seen.add(c.url);
      urls.push({ url: c.url, platform: c.platform, hint: c.hint });
      if (urls.length >= MAX_URLS) break;
    }
    return { urls, rejected };
  }

  // Aynı içerik mi? (kuyrukta tekrar uyarısı için) — YouTube'da v= kimliği, diğerlerinde normalize adres
  function contentKey(url) {
    try {
      const u = new URL(url);
      const host = hostOf(u);
      if (platformOf(host).id === 'youtube') {
        if (host === 'youtu.be') return 'yt:' + u.pathname.slice(1).split('/')[0];
        const v = u.searchParams.get('v') || (/^\/(?:shorts|live|embed)\/([\w-]{6,})/.exec(u.pathname) || [])[1];
        if (v) return 'yt:' + v;
      }
      return host + u.pathname.replace(/\/+$/, '') + (u.search || '');
    } catch { return String(url); }
  }

  const api = { PLATFORMS, GENERIC, DRM_HOSTS, MAX_URLS, classify, extract, platformOf, platformById, playlistHint, contentKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.URLS = api;
})(typeof self !== 'undefined' ? self : this);
