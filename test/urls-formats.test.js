'use strict';
// Bağlantı sınıflandırma (platform, oynatma listesi ipucu, DRM / yerel / şifreli adres reddi) ve biçim seçimi
// (kullanılabilir çözünürlükler, en yakın düşük çözünürlük, yt-dlp biçim argümanları).
const test = require('node:test');
const assert = require('node:assert/strict');
const URLS = require('../src/urls');
const FORMATS = require('../src/formats');
const { fixture } = require('./helpers');

test('platform tanıma: alan adları ve alt alanlar', () => {
  const cases = {
    'https://www.youtube.com/watch?v=aqz-KE-bpKQ': 'youtube', 'https://youtu.be/aqz-KE-bpKQ': 'youtube', 'https://m.youtube.com/shorts/abcdefghijk': 'youtube',
    'https://www.instagram.com/reel/C0abcDEF/': 'instagram', 'https://www.tiktok.com/@kisi/video/123': 'tiktok', 'https://vm.tiktok.com/ZM123/': 'tiktok',
    'https://x.com/kisi/status/1': 'x', 'https://twitter.com/kisi/status/1': 'x', 'https://www.facebook.com/watch/?v=1': 'facebook', 'https://fb.watch/abc/': 'facebook',
    'https://vimeo.com/76979871': 'vimeo', 'https://www.dailymotion.com/video/x8': 'dailymotion', 'https://clips.twitch.tv/Abc': 'twitch',
    'https://www.reddit.com/r/videos/comments/abc/x/': 'reddit', 'https://soundcloud.com/kisi/parca': 'soundcloud', 'https://ornek-sanatci.bandcamp.com/album/a': 'bandcamp',
    'https://archive.org/details/BigBuckBunny_124': 'archive', 'https://ornek.com.tr/video/1': 'generic',
  };
  for (const [u, id] of Object.entries(cases)) {
    const c = URLS.classify(u);
    assert.equal(c.ok, true, u);
    assert.equal(c.platform, id, u);
  }
  assert.equal(URLS.platformOf('https://notyoutube.com/x').id, 'generic'); // sonek eşleşmesi yalnız gerçek alt alan
});

test('tasarım sınırı: DRM / abonelik servisleri, yerel adresler, şifreli ve http dışı bağlantılar reddedilir', () => {
  for (const u of ['https://www.netflix.com/watch/8011', 'https://open.spotify.com/track/abc', 'https://www.disneyplus.com/video/1', 'https://www.primevideo.com/detail/x',
    'https://www.amazon.com/gp/video/detail/B0', 'https://music.apple.com/tr/album/x/1', 'https://www.max.com/movies/x', 'https://www.crunchyroll.com/watch/x']) {
    assert.deepEqual([URLS.classify(u).ok, URLS.classify(u).code], [false, 'drm'], u);
  }
  assert.equal(URLS.classify('https://www.amazon.com/dp/B00X').ok, true); // alışveriş sayfası DRM yolu değil (genel)
  for (const u of ['http://localhost:8080/v.mp4', 'http://192.168.1.10/a.mp4', 'http://10.0.0.5/x', 'http://nas.local/x', 'http://[::1]/x', 'http://172.20.1.1/']) {
    assert.equal(URLS.classify(u).code, 'private_host', u);
  }
  assert.equal(URLS.classify('https://kisi:sifre@youtube.com/watch?v=1').code, 'credentials');
  assert.equal(URLS.classify('ftp://ornek.com/a.mp4').code, 'scheme');
  assert.equal(URLS.classify('file:///C:/a.mp4').code, 'scheme');
  assert.equal(URLS.classify('javascript:alert(1)').code, 'scheme');
  assert.equal(URLS.classify('x'.repeat(3000)).code, 'too_long');
  assert.equal(URLS.classify('').code, 'empty');
});

test('çok satırlı yapıştırma: bağlantılar ayıklanır, izleme parametreleri atılır, tekrarlar birleşir', () => {
  const text = `İzle: https://www.youtube.com/watch?v=aqz-KE-bpKQ&si=abc&utm_source=x
  youtu.be/aqz-KE-bpKQ
  (https://vimeo.com/76979871), https://www.netflix.com/watch/1 düz metin
  https://www.youtube.com/watch?v=aqz-KE-bpKQ&utm_medium=y`;
  const r = URLS.extract(text);
  assert.deepEqual(r.urls.map((u) => u.url), ['https://www.youtube.com/watch?v=aqz-KE-bpKQ', 'https://youtu.be/aqz-KE-bpKQ', 'https://vimeo.com/76979871']);
  assert.deepEqual(r.rejected.map((x) => x.code), ['drm']);
  // İçerik anahtarı: youtu.be ve watch?v= aynı video
  assert.equal(URLS.contentKey(r.urls[0].url), URLS.contentKey(r.urls[1].url));
  assert.equal(URLS.contentKey('https://www.youtube.com/shorts/abcdefghijk'), 'yt:abcdefghijk');
  assert.equal(URLS.extract(Array.from({ length: 300 }, (_, i) => `https://vimeo.com/${i + 1}`).join('\n')).urls.length, URLS.MAX_URLS);
});

test('oynatma listesi ipucu', () => {
  const hint = (u) => URLS.classify(u).hint;
  assert.equal(hint('https://www.youtube.com/playlist?list=PL123'), 'playlist');
  assert.equal(hint('https://www.youtube.com/watch?v=abc&list=PL123'), 'video_in_playlist');
  assert.equal(hint('https://www.youtube.com/@BlenderOfficial/videos'), 'channel');
  assert.equal(hint('https://www.youtube.com/@BlenderOfficial'), 'channel');
  assert.equal(hint('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(hint('https://soundcloud.com/kisi/sets/liste'), 'playlist');
  assert.equal(hint('https://vimeo.com/showcase/123'), 'playlist');
  assert.equal(hint('https://www.twitch.tv/kanal/videos'), 'channel');
});

test('kullanılabilir çözünürlükler gerçek yt-dlp çıktısından (storyboard ve DRM biçimleri sayılmaz)', () => {
  const info = JSON.parse(fixture('yt-single.json'));
  const o = FORMATS.optionsOf(info);
  assert.deepEqual(o.heights, [2160, 1440, 1080, 720, 480, 360, 240, 144]);
  assert.equal(o.video, true);
  assert.equal(o.audio, true);
  assert.equal(o.drm, false);
  assert.equal(o.live, false);
  // Dikey video: kısa kenar esas (1080×1920 → 1080p)
  assert.deepEqual(FORMATS.optionsOf({ formats: [{ width: 1080, height: 1920, vcodec: 'h264', acodec: 'aac' }, { width: 720, height: 1280, vcodec: 'h264', acodec: 'none' }] }).heights, [1080, 720]);
  // Tüm biçimler DRM'li → drm
  assert.equal(FORMATS.optionsOf({ formats: [{ height: 720, vcodec: 'h264', has_drm: true }] }).drm, true);
  // Yalnız ses kaynağı (SoundCloud gibi)
  const a = FORMATS.optionsOf({ formats: [{ vcodec: 'none', acodec: 'opus', ext: 'opus' }, { vcodec: 'none', acodec: 'mp3' }] });
  assert.deepEqual([a.video, a.audio, a.heights], [false, true, []]);
  assert.equal(FORMATS.ladderOf(1076), 1080);
  assert.equal(FORMATS.ladderOf(718), 720);
  assert.equal(FORMATS.ladderOf(544), 480);
  assert.equal(FORMATS.ladderOf(100), 144);
});

test('en yakın düşük çözünürlük; düşük yoksa en yakın yüksek', () => {
  const avail = [1080, 720, 360];
  assert.deepEqual(FORMATS.resolveHeight(avail, 720), { height: 720, exact: true, direction: 'same' });
  assert.deepEqual(FORMATS.resolveHeight(avail, 2160), { height: 1080, exact: false, direction: 'lower' });
  assert.deepEqual(FORMATS.resolveHeight(avail, 480), { height: 360, exact: false, direction: 'lower' });
  assert.deepEqual(FORMATS.resolveHeight(avail, 240), { height: 360, exact: false, direction: 'higher' });
  assert.deepEqual(FORMATS.resolveHeight(avail, 0), { height: 1080, exact: true, direction: 'same' }); // en iyi
  assert.deepEqual(FORMATS.resolveHeight([], 720), { height: null, exact: false, direction: null });
});

test('yt-dlp biçim argümanları: -S res:H (en yakın düşük), kapsayıcı ve ses dönüştürme', () => {
  assert.deepEqual(FORMATS.formatArgs({ kind: 'video', height: 1080, container: 'mp4' }),
    ['-f', 'bv*+ba/b', '-S', 'res:1080,ext:mp4:m4a,vcodec:h264', '--merge-output-format', 'mp4/mkv', '--remux-video', 'flv>mp4/mov>mp4']);
  assert.deepEqual(FORMATS.formatArgs({ kind: 'video', height: 0, container: 'mkv' }), ['-f', 'bv*+ba/b', '-S', 'res', '--merge-output-format', 'mkv', '--remux-video', 'mkv']);
  assert.deepEqual(FORMATS.formatArgs({ kind: 'video', height: 720, container: 'webm' }), ['-f', 'bv*+ba/b', '-S', 'res:720,ext:webm:webm', '--merge-output-format', 'webm/mkv']);
  assert.deepEqual(FORMATS.formatArgs({ kind: 'audio', audioFormat: 'mp3', audioQuality: '192' }), ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '192K']);
  assert.deepEqual(FORMATS.formatArgs({ kind: 'audio', audioFormat: 'm4a', audioQuality: 'best' }), ['-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a', '--audio-quality', '0']);
  assert.deepEqual(FORMATS.formatArgs({ kind: 'audio', audioFormat: 'opus' }).slice(0, 2), ['-f', 'ba[acodec=opus]/ba/b']);
  // Bozuk giriş varsayılana düşer
  assert.deepEqual(FORMATS.sanitizeOpts({ kind: 'x', height: 999, container: 'avi', audioFormat: 'wav', audioQuality: '1' }),
    { kind: 'video', height: 0, container: 'mp4', audioFormat: 'mp3', audioQuality: '192' });
  assert.equal(FORMATS.labelOf({ kind: 'video', height: 2160, container: 'mkv' }), '4K (2160p) · MKV');
  assert.equal(FORMATS.labelOf({ kind: 'audio', audioFormat: 'opus', audioQuality: 'best' }, { best: 'En iyi' }), 'OPUS · En iyi');
});
