'use strict';
// Motor: güvenli argümanlar (çerez/şifre/DRM seçeneği yok), dosya adı şablonu, ilerleme satırları, hata sınıflandırma,
// analiz çıktısı (gerçek yt-dlp JSON'undan kısaltılmış örnekler), sahte süreçle analiz/indirme/iptal; motor güncellemesi
// (OpenPGP imzası + SHA-256 + sürüm denetimi).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Y = require('../src/ytdlp');
const PGP = require('../src/openpgp');
const { createEngineFiles, parseSums, compareVersions, SIGNING_FPR, SIGNING_KEY_FILE } = require('../src/engine');
const { fixture, fakeSpawn, tmpDir, testSigner, fakeFetch } = require('./helpers');

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test('argümanlar: her çağrıda --ignore-config / --no-cookies; yasaklı seçenekler reddedilir; URL "--" sonrasında', () => {
  const a = Y.analyzeArgs('https://youtu.be/x', { playlist: true });
  for (const f of ['--ignore-config', '--no-cookies', '--no-cookies-from-browser', '-J', '--flat-playlist', '--yes-playlist']) assert.ok(a.includes(f), f);
  assert.deepEqual(a.slice(-2), ['--', 'https://youtu.be/x']);
  assert.ok(Y.analyzeArgs('https://youtu.be/x').includes('--no-playlist'));
  const d = Y.downloadArgs({ url: 'https://youtu.be/x', opts: { kind: 'video', height: 720, container: 'mp4' } }, { outDir: '/o', tempDir: '/t', template: '{title}', limitRate: 500, embedMetadata: true, ffmpegDir: '/ff' });
  for (const f of ['--ignore-config', '--no-cookies', '--no-playlist', '--continue', '--newline', '--embed-metadata', '--windows-filenames']) assert.ok(d.includes(f), f);
  assert.equal(d[d.indexOf('--limit-rate') + 1], '500K');
  assert.equal(d[d.indexOf('--ffmpeg-location') + 1], '/ff');
  assert.equal(d[d.indexOf('-S') + 1], 'res:720,ext:mp4:m4a,vcodec:h264');
  assert.deepEqual(d.slice(-2), ['--', 'https://youtu.be/x']);
  for (const f of Y.FORBIDDEN_ARGS) assert.ok(!d.includes(f) && !a.includes(f), f);
  for (const bad of ['--cookies-from-browser', '--cookies', '--password', '-u', '--netrc', '--allow-unplayable-formats', '--exec']) {
    assert.throws(() => Y.assertSafeArgs(['-J', bad, 'x', '--', 'https://a.b']), /forbidden_arg/);
  }
  // URL konumundaki "--cookies" metni seçenek sayılmaz
  assert.doesNotThrow(() => Y.assertSafeArgs(['-J', '--', '--cookies']));
});

test('dosya adı şablonu: yalnız {belirteç}; klasör ayracı / .. / ham %(…) reddedilir; % kaçırılır', () => {
  assert.deepEqual(Y.validateTemplate('{title} [{id}]'), { ok: true });
  assert.equal(Y.validateTemplate('').code, 'empty');
  assert.equal(Y.validateTemplate('../{title}').code, 'path');
  assert.equal(Y.validateTemplate('a/{title}').code, 'path');
  assert.equal(Y.validateTemplate('%(title)s').code, 'raw');
  assert.deepEqual(Y.validateTemplate('{baslik}'), { ok: false, code: 'unknown_token', token: 'baslik' });
  assert.equal(Y.validateTemplate('sabit ad').code, 'no_token');
  assert.equal(Y.buildOutputTemplate('{title} [{id}]', {}), '%(title)s [%(id)s].%(ext)s');
  assert.equal(Y.buildOutputTemplate('{index} - {title} %100', { playlist: { title: 'Liste: A/B', index: 7, count: 120 } }), '007 - %(title)s %%100.%(ext)s');
  assert.equal(Y.buildOutputTemplate('{playlist} {index}', { playlist: { title: 'Ders %50 "A"', index: 2, count: 9 } }), 'Ders %%50 A 02.%(ext)s');
  assert.equal(Y.buildOutputTemplate('../kötü', {}), '%(title)s.%(ext)s'); // geçersiz → varsayılan
  assert.equal(Y.buildOutputTemplate('{date} {uploader} {resolution}', {}), '%(upload_date>%Y-%m-%d|NA)s %(uploader,channel,creator|NA)s %(height&{}p|audio)s.%(ext)s');
});

test('ilerleme satırları ve çok parçalı (görüntü + ses) yüzde', () => {
  assert.deepEqual(Y.parseLine('SDFMT|137+140|1080|mp4|635|Başlık | ayraçlı'), { type: 'format', formatId: '137+140', parts: 2, height: 1080, ext: 'mp4', duration: 635, title: 'Başlık | ayraçlı' });
  const p = Y.parseLine('SDP|downloading|500|1000|NA|250.5|2|137');
  assert.deepEqual([p.type, p.downloaded, p.total, p.speed, p.eta, p.formatId], ['progress', 500, 1000, 250.5, 2, '137']);
  assert.equal(Y.parseLine('SDP|downloading|10|NA|200|NA|NA|NA').total, 200); // tahmini toplam
  assert.deepEqual(Y.parseLine('SDPP|started|Merger'), { type: 'post', status: 'started', pp: 'Merger' });
  assert.deepEqual(Y.parseLine('SDFILE|C:\\İndirilenler\\a.mp4'), { type: 'file', path: 'C:\\İndirilenler\\a.mp4' });
  assert.equal(Y.parseLine('ERROR: [youtube] x: Private video').type, 'error');
  const tr = Y.createProgressTracker();
  tr.feed(Y.parseLine('SDFMT|137+140|1080|mp4|635|T'));
  assert.equal(tr.feed(Y.parseLine('SDP|downloading|50|100|NA|1|1|137')).pct, 24.3);
  assert.equal(tr.feed(Y.parseLine('SDP|finished|100|100|NA|NA|NA|137')).pct, 48.5);
  const second = tr.feed(Y.parseLine('SDP|downloading|50|100|NA|1|1|140'));
  assert.deepEqual([second.part, second.parts, second.pct], [2, 2, 72.8]);
  assert.equal(tr.feed(Y.parseLine('SDPP|started|Merger')).pct, 97);
});

test('hata sınıflandırma: yt-dlp metinleri → anlaşılır kodlar', () => {
  const cases = {
    'ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video': 'private',
    'ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.': 'age_restricted',
    'ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication.': 'bot_check',
    'ERROR: [youtube] abc: Join this channel to get access to members-only content like this video': 'members_only',
    'ERROR: [instagram] abc: Requested content is not available, rate-limit reached or login required. Use --cookies': 'login_required',
    'ERROR: [youtube] abc: The uploader has not made this video available in your country': 'geo_blocked',
    'ERROR: [youtube] abc: This live event will begin in 3 hours.': 'live',
    'ERROR: [generic] Unsupported URL: https://ornek.com/': 'unsupported_url',
    'ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader': 'unavailable',
    'ERROR: unable to download video data: HTTP Error 429: Too Many Requests': 'rate_limited',
    'ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path using --ffmpeg-location': 'ffmpeg_missing',
    "ERROR: unable to write data: [Errno 28] No space left on device": 'disk_full',
    'ERROR: unable to open for writing: [Errno 13] Permission denied': 'permission',
    'ERROR: [youtube] abc: Requested format is not available. Use --list-formats': 'no_formats',
    'ERROR: [youtube] abc: Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>': 'network',
    'ERROR: [vimeo] 1: This video is DRM protected': 'drm',
    'ERROR: unable to download video data: HTTP Error 403: Forbidden': 'forbidden',
    'tamamen başka bir şey': 'unknown',
  };
  for (const [text, code] of Object.entries(cases)) assert.equal(Y.classifyError(text), code, text);
  assert.equal(Y.lastErrorLine('[info] a\nWARNING: w\nERROR: [youtube] abc: Private video\n'), 'abc: Private video');
});

test('analiz çıktısı: tekil video (gerçek yt-dlp örneği)', () => {
  const r = Y.parseAnalysis(JSON.parse(fixture('yt-single.json')), 'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  assert.equal(r.kind, 'single');
  assert.equal(r.platform, 'youtube');
  assert.equal(r.id, 'aqz-KE-bpKQ');
  assert.equal(r.duration, 635);
  assert.match(r.title, /Big Buck Bunny/);
  assert.match(r.thumbnail, /^https:\/\/i\.ytimg\.com\//);
  assert.deepEqual(r.options.heights, [2160, 1440, 1080, 720, 480, 360, 240, 144]);
  // Engellenen erişilebilirlik ve canlı yayın / DRM
  assert.deepEqual(Y.parseAnalysis({ availability: 'needs_auth', formats: [] }), { error: 'login_required' });
  assert.deepEqual(Y.parseAnalysis({ availability: 'subscriber_only' }), { error: 'members_only' });
  assert.deepEqual(Y.parseAnalysis({ availability: 'private' }), { error: 'private' });
  assert.deepEqual(Y.parseAnalysis({ live_status: 'is_live', formats: [{ height: 720, vcodec: 'h264', acodec: 'aac' }] }), { error: 'live' });
  assert.deepEqual(Y.parseAnalysis({ formats: [{ height: 720, vcodec: 'h264', has_drm: true }] }), { error: 'drm' });
});

test('analiz çıktısı: oynatma listesi / kanal — öğeler, özel ve canlı öğeler seçilemez', () => {
  const r = Y.parseAnalysis(JSON.parse(fixture('yt-channel.json')), 'https://www.youtube.com/@BlenderOfficial/videos');
  assert.equal(r.kind, 'playlist');
  assert.equal(r.platform, 'youtube');
  assert.equal(r.entries.length, 8);
  assert.deepEqual(r.entries.map((e) => e.index), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.ok(r.entries.slice(0, 6).every((e) => e.available && /^https:\/\/www\.youtube\.com\/watch\?v=/.test(e.url) && e.title));
  assert.equal(r.entries[6].available, false); // [Private video]
  assert.equal(r.entries[7].live, true);
  assert.deepEqual(Y.parseAnalysis({ _type: 'playlist', entries: [] }), { error: 'playlist_empty' });
});

test('sahte süreçle analiz ve indirme: ilerleme, dosya yolu, hata ve iptal', async () => {
  const single = fixture('yt-single.json').toString();
  const dir = tmpDir('sd-dl-');
  const out = path.join(dir, 'out');
  const spawn = fakeSpawn((args) => {
    const url = args[args.length - 1];
    if (args.includes('-J')) {
      if (url.includes('ozel')) return { stderr: ['ERROR: [youtube] ozel: Private video. Sign in if you\'ve been granted access'], code: 1 };
      return { json: single };
    }
    if (url.includes('asili')) return { stderr: ['SDFMT|18|360|mp4|10|Asılı', 'SDP|downloading|10|100|NA|5|9|18'], hang: true };
    const file = path.join(out, 'Big Buck Bunny.mp4');
    return {
      stderr: ['SDFMT|137+140|1080|mp4|635|Big Buck Bunny', 'SDP|downloading|0|1000|NA|NA|NA|137', 'SDP|finished|1000|1000|NA|NA|NA|137',
        'SDP|downloading|50|100|NA|10|5|140', 'SDP|finished|100|100|NA|NA|NA|140', 'SDPP|started|Merger', `SDFILE|${file}`],
      onExit: () => fs.writeFileSync(file, Buffer.alloc(1234)),
    };
  });
  const eng = Y.createEngine({ spawn, ytdlpPath: () => '/yok/yt-dlp', ffmpegDir: () => '/ff', extraEnv: () => ({ LD_LIBRARY_PATH: '/lib' }) });
  const a = await eng.analyze('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  assert.equal(a.kind, 'single');
  assert.equal(spawn.calls[0].env.LD_LIBRARY_PATH, '/lib');
  assert.equal(spawn.calls[0].env.PYTHONIOENCODING, 'utf-8');
  await assert.rejects(eng.analyze('https://www.youtube.com/watch?v=ozel'), (e) => e.code === 'private' && /Private video/.test(e.message));

  const progress = [];
  const r = await eng.download({ url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', opts: { kind: 'video', height: 1080 } },
    { outDir: out, tempDir: path.join(dir, 'part', 'q1'), template: '{title}' }, { onProgress: (p) => progress.push(p) });
  assert.equal(r.file, path.join(out, 'Big Buck Bunny.mp4'));
  assert.equal(r.size, 1234);
  assert.equal(r.ext, 'mp4');
  assert.ok(progress.some((p) => p.phase === 'starting' && p.meta && p.meta.height === 1080));
  assert.ok(progress.some((p) => p.phase === 'post' && p.pp === 'Merger'));
  assert.ok(!fs.existsSync(path.join(dir, 'part', 'q1'))); // geçici klasör temizlendi
  const dl = spawn.calls.at(-1).args;
  assert.equal(dl[dl.indexOf('--ffmpeg-location') + 1], '/ff');

  // İptal: asılı süreç sonlandırılır, "aborted" ile reddedilir
  const ctl = new AbortController();
  const p = eng.download({ url: 'https://ornek.com/asili', opts: {} }, { outDir: out, tempDir: path.join(dir, 'part', 'q2'), template: '{title}' }, { signal: ctl.signal, onProgress: () => {} });
  await tick(30);
  ctl.abort();
  await assert.rejects(p, (e) => e.code === 'aborted');
  // Motor yoksa
  const none = Y.createEngine({ spawn, ytdlpPath: () => null, ffmpegDir: () => null });
  await assert.rejects(none.analyze('https://youtu.be/x'), (e) => e.code === 'engine_missing');
});

test('OpenPGP: gerçek yt-dlp SHA2-256SUMS imzası gömülü anahtarla doğrulanır; değiştirilmiş dosya reddedilir', () => {
  const key = fs.readFileSync(SIGNING_KEY_FILE, 'utf8');
  const keys = PGP.readPublicKeys(key);
  assert.equal(keys[0].fingerprint, SIGNING_FPR);
  const sums = fixture('SHA2-256SUMS');
  const sig = fixture('SHA2-256SUMS.sig');
  assert.deepEqual(PGP.verifyDetached(sums, sig, key, { fingerprint: SIGNING_FPR }), { ok: true, fingerprint: SIGNING_FPR });
  const bad = Buffer.from(sums);
  bad[20] ^= 1;
  assert.equal(PGP.verifyDetached(bad, sig, key).ok, false);
  // Başka anahtarla imzalanmış dosya, sabit parmak izi istenince reddedilir
  const s = testSigner();
  assert.equal(PGP.verifyDetached(sums, s.sign(sums), s.armored).ok, true);
  assert.deepEqual(PGP.verifyDetached(sums, s.sign(sums), s.armored, { fingerprint: SIGNING_FPR }), { ok: false, code: 'wrong_key' });
  assert.equal(parseSums(sums.toString())['yt-dlp.exe'], '33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555');
  assert.equal(compareVersions('2026.10.21.1', '2026.10.21'), 1);
  assert.equal(compareVersions('2026.09.30', '2026.10.01'), -1);
});

test('motor güncellemesi: imza + sha256 + sürüm denetimi; başarısızlıkta eski motor korunur', async () => {
  const signer = testSigner();
  const user = tmpDir('sd-eng-');
  const res = tmpDir('sd-res-');
  fs.writeFileSync(path.join(res, 'yt-dlp'), 'eski', { mode: 0o755 });
  fs.writeFileSync(path.join(res, 'engine.json'), JSON.stringify({ ytdlp: '2026.01.01', ffmpeg: 'n9.0' }));
  const tag = '2026.10.21';
  const bin = Buffer.from('#!/bin/sh\necho 2026.10.21\n');
  const sums = Buffer.from(`${crypto.createHash('sha256').update(bin).digest('hex')}  yt-dlp_linux\n${'0'.repeat(64)}  yt-dlp.exe\n`);
  const base = `https://github.com/yt-dlp/yt-dlp/releases/download/${tag}`;
  const routes = {
    'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest': { tag_name: tag },
    [`${base}/SHA2-256SUMS`]: sums, [`${base}/SHA2-256SUMS.sig`]: signer.sign(sums), [`${base}/yt-dlp_linux`]: bin,
  };
  let runVersion = tag;
  const mk = (r) => createEngineFiles({ resourcesDir: res, userDir: user, platform: 'linux', env: {}, fetch: fakeFetch(r), run: async () => runVersion + '\n', signingKey: signer.armored, signingFpr: signer.fingerprint });

  // 1) İmza tutmuyor (özet listesi değiştirilmiş) → güncelleme yok
  const tampered = { ...routes, [`${base}/SHA2-256SUMS`]: Buffer.concat([sums, Buffer.from('x')]) };
  await assert.rejects(mk(tampered).update(), (e) => e.code === 'bad_signature');
  // 2) İkili değiştirilmiş → sha256 tutmuyor
  await assert.rejects(mk({ ...routes, [`${base}/yt-dlp_linux`]: Buffer.from('kötü') }).update(), (e) => e.code === 'bad_checksum');
  // 3) Çalışınca başka sürüm yazıyor → kurulmaz
  runVersion = '1.0';
  await assert.rejects(mk(routes).update(), (e) => e.code === 'bad_binary');
  assert.equal(mk(routes).ytdlpPath(), path.join(res, 'yt-dlp'));
  // 4) Başarılı: güncellenen kopya kullanılır, adımlar sırayla
  runVersion = tag;
  const ef = mk(routes);
  const steps = [];
  const r = await ef.update({ onStep: (s) => steps.push(s) });
  assert.deepEqual(r, { ok: true, updated: true, version: tag });
  assert.deepEqual(steps, ['check', 'signature', 'download', 'verify', 'install']);
  assert.equal(ef.ytdlpPath(), path.join(user, 'engine', 'yt-dlp'));
  assert.equal(ef.info().ytdlpVersion, tag);
  assert.equal(ef.info().updated, true);
  // Güncel: tekrar indirmez
  assert.deepEqual(await ef.update(), { ok: true, updated: false, version: tag });
  // Uygulamayla gelene dön
  ef.reset();
  assert.equal(ef.ytdlpPath(), path.join(res, 'yt-dlp'));
  // Yalnız yt-dlp deposu: başka adres reddedilir
  const odd = { ...routes, 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest': { tag_name: '../../evil' } };
  await assert.rejects(mk(odd).check(), (e) => e.code === 'bad_tag');
});

test('Windows: iptal süreç ağacını taskkill /T /F ile sonlandırır', async () => {
  const orig = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const dir = tmpDir('sd-win-');
    const spawn = fakeSpawn(() => ({ stderr: ['SDFMT|18|360|mp4|10|Asılı'], hang: true }));
    const eng = Y.createEngine({ spawn, ytdlpPath: () => 'C:\\yt-dlp.exe', ffmpegDir: () => null });
    const ctl = new AbortController();
    const p = eng.download({ url: 'https://ornek.com/v', opts: {} }, { outDir: path.join(dir, 'o'), tempDir: path.join(dir, 't'), template: '{title}' }, { signal: ctl.signal, onProgress: () => {} });
    await tick(20);
    ctl.abort();
    await assert.rejects(p, (e) => e.code === 'aborted');
    const kill = spawn.calls.find((c) => c.bin === 'taskkill');
    assert.ok(kill, 'taskkill çağrıldı');
    assert.deepEqual(kill.args, ['/pid', String(spawn.calls[0].child.pid), '/T', '/F']);
  } finally {
    Object.defineProperty(process, 'platform', orig);
  }
});
