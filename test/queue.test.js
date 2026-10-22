'use strict';
// İndirme kuyruğu durum makinesi ve zamanlayıcı: eşzamanlılık sınırı, nazik istek aralığı, duraklat/sürdür/iptal/yeniden
// dene, hata, kaldırma, sıra, kapanıp açılınca geri yükleme. İndirme sahte "runner" ile.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueue, transition, clampConcurrency, ACTIONS, STATES } = require('../src/queue');

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// Elle bitirilen sahte indirmeler: run.get(id).resolve()/reject(); abort → reddedilir
function controlledRunner() {
  const runs = new Map();
  const started = [];
  const runner = (item, { signal, onProgress }) => new Promise((resolve, reject) => {
    started.push(item.id);
    const r = { resolve: (v) => resolve(v || { file: `/indir/${item.id}.mp4`, size: 100 }), reject: (code) => reject(Object.assign(new Error(code), { code })), progress: onProgress };
    runs.set(item.id, r);
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { code: 'aborted' })));
  });
  return { runner, runs, started };
}

test('durum geçişleri tablosu', () => {
  assert.equal(transition('queued', 'start'), 'running');
  assert.equal(transition('running', 'complete'), 'done');
  assert.equal(transition('running', 'fail'), 'error');
  assert.equal(transition('running', 'pause'), 'paused');
  assert.equal(transition('queued', 'pause'), 'paused');
  assert.equal(transition('paused', 'resume'), 'queued');
  assert.equal(transition('error', 'retry'), 'queued');
  assert.equal(transition('canceled', 'retry'), 'queued');
  for (const s of ['queued', 'running', 'paused', 'error']) assert.equal(transition(s, 'cancel'), 'canceled');
  // İzinsiz geçişler
  assert.equal(transition('done', 'cancel'), null);
  assert.equal(transition('done', 'retry'), null);
  assert.equal(transition('paused', 'complete'), null);
  assert.equal(transition('queued', 'resume'), null);
  assert.equal(transition('running', 'start'), null);
  // Her eylemin hedefi geçerli bir durum
  for (const a of Object.values(ACTIONS)) assert.ok(STATES.includes(a.to));
  assert.deepEqual([clampConcurrency(0), clampConcurrency(9), clampConcurrency('3'), clampConcurrency(undefined)], [1, 4, 3, 2]);
});

test('eşzamanlılık sınırı ve sırayla başlatma; bitince sıradaki başlar', async () => {
  const { runner, runs, started } = controlledRunner();
  const events = [];
  const q = createQueue({ runner, concurrency: 2, onChange: (k) => events.push(k) });
  q.add([{ url: 'a' }, { url: 'b' }, { url: 'c' }, { url: 'd' }].map((x, i) => ({ ...x, id: `i${i}` })));
  await tick();
  assert.deepEqual(started, ['i0', 'i1']);
  assert.deepEqual(q.counts(), { queued: 2, running: 2, paused: 0, done: 0, error: 0, canceled: 0 });
  runs.get('i0').progress({ pct: 50, speed: 1000 });
  assert.equal(q.get('i0').progress.pct, 50);
  assert.equal(q.get('i0').speed, 1000);
  runs.get('i0').resolve();
  await tick();
  assert.equal(q.get('i0').state, 'done');
  assert.equal(q.get('i0').file, '/indir/i0.mp4');
  assert.equal(q.get('i0').progress.pct, 100);
  assert.deepEqual(started, ['i0', 'i1', 'i2']);
  // Eşzamanlılık 4'e çıkınca kalan da başlar; 9 istenirse 4'te kalır
  assert.equal(q.setConcurrency(9), 4);
  await tick();
  assert.deepEqual(started, ['i0', 'i1', 'i2', 'i3']);
  assert.ok(events.includes('start') && events.includes('complete') && events.includes('progress'));
});

test('hata: anlaşılır kod saklanır, yeniden dene kuyruğa alır, deneme sayısı artar', async () => {
  const { runner, runs } = controlledRunner();
  const q = createQueue({ runner, concurrency: 1 });
  q.add([{ id: 'x', url: 'u' }]);
  await tick();
  runs.get('x').reject('private');
  await tick();
  assert.equal(q.get('x').state, 'error');
  assert.equal(q.get('x').error.code, 'private');
  assert.equal(q.retry('x'), true);
  await tick();
  assert.equal(q.get('x').state, 'running');
  assert.equal(q.get('x').attempts, 2);
  assert.equal(q.get('x').error, null);
  assert.equal(q.retry('x'), false); // çalışırken yeniden dene yok
});

test('duraklat → süreç durur, sürdür → kaldığı yerden yeniden başlar; iptal yarım dosyaları siler', async () => {
  const { runner, runs, started } = controlledRunner();
  const cleaned = [];
  const q = createQueue({ runner, concurrency: 1, cleanup: (it) => cleaned.push(it.id) });
  q.add([{ id: 'a', url: 'u1' }, { id: 'b', url: 'u2' }]);
  await tick();
  runs.get('a').progress({ pct: 40 });
  assert.equal(q.pause('a'), true);
  await tick();
  assert.equal(q.get('a').state, 'paused');
  assert.equal(q.get('a').progress.pct, 40); // ilerleme korunur
  assert.deepEqual(started, ['a', 'b']);       // yer açılınca sıradaki başladı
  assert.equal(q.resume('a'), true);
  assert.equal(q.get('a').state, 'queued');
  runs.get('b').resolve();
  await tick();
  assert.equal(q.get('a').state, 'running');
  assert.deepEqual(started, ['a', 'b', 'a']);
  assert.equal(q.cancel('a'), true);
  await tick();
  assert.equal(q.get('a').state, 'canceled');
  assert.deepEqual(cleaned, ['a']);
  // Bekleyen öğenin iptali de temizler; biten öğe iptal edilemez
  q.add([{ id: 'c', url: 'u3' }]);
  q.pause('c');
  q.cancel('c');
  await tick();
  assert.deepEqual(cleaned, ['a', 'c']);
  assert.equal(q.cancel('b'), false);
});

test('kaldırma, bitenleri temizleme, tümünü duraklat/sürdür, sıra değiştirme', async () => {
  const { runner, runs } = controlledRunner();
  const cleaned = [];
  const q = createQueue({ runner, concurrency: 1, cleanup: (it) => cleaned.push(it.id) });
  q.add(['a', 'b', 'c', 'd'].map((id) => ({ id, url: id })));
  await tick();
  // Çalışan öğe kaldırılınca önce iptal edilir (yarım dosya silinir)
  assert.equal(q.remove('a'), true);
  await tick();
  assert.deepEqual(cleaned, ['a']);
  assert.deepEqual(q.list().map((x) => x.id), ['b', 'c', 'd']);
  assert.equal(q.get('b').state, 'running');
  assert.equal(q.move('d', -1), true);
  assert.deepEqual(q.list().map((x) => x.id), ['b', 'd', 'c']);
  q.pauseAll();
  await tick();
  assert.deepEqual(q.list().map((x) => x.state), ['paused', 'paused', 'paused']);
  q.resumeAll();
  await tick();
  assert.deepEqual(q.list().map((x) => x.state), ['running', 'queued', 'queued']);
  runs.get('b').resolve();
  await tick();
  assert.equal(q.clearFinished(), 1);
  assert.deepEqual(q.list().map((x) => x.id), ['d', 'c']);
});

test('nazik istek aralığı: iki başlatma arasında gapMs beklenir', async () => {
  let now = 1000;
  const timers = [];
  const { runner, started } = controlledRunner();
  const q = createQueue({ runner, concurrency: 3, gapMs: 2000, now: () => now, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  q.add([{ id: 'a', url: 'a' }, { id: 'b', url: 'b' }, { id: 'c', url: 'c' }]);
  assert.deepEqual(started, ['a']);
  assert.equal(timers.at(-1).ms, 2000);
  now += 2000;
  timers.at(-1).fn();
  assert.deepEqual(started, ['a', 'b']);
  now += 500;
  q.setConcurrency(3);
  assert.equal(timers.at(-1).ms, 1500);
  now += 1500;
  timers.at(-1).fn();
  assert.deepEqual(started, ['a', 'b', 'c']);
});

test('kapanıp açılınca kuyruk geri gelir: süren → kuyrukta (ya da ayara göre duraklatılmış); bitenler korunur', async () => {
  const { runner, runs } = controlledRunner();
  const q1 = createQueue({ runner, concurrency: 1 });
  q1.add([{ id: 'a', url: 'a', title: 'A' }, { id: 'b', url: 'b', title: 'B' }, { id: 'c', url: 'c' }]);
  await tick();
  runs.get('a').resolve();
  await tick();
  runs.get('b').progress({ pct: 30 });
  const saved = JSON.parse(JSON.stringify(q1.snapshot()));
  q1.shutdown();
  assert.deepEqual(saved.map((x) => x.state), ['done', 'running', 'queued']);

  const r2 = controlledRunner();
  const q2 = createQueue({ runner: r2.runner, concurrency: 1 });
  q2.restore(saved, { resume: true });
  await tick();
  assert.deepEqual(q2.list().map((x) => x.state), ['done', 'running', 'queued']);
  assert.deepEqual(r2.started, ['b']);
  assert.equal(q2.get('b').progress.pct, 30);

  const r3 = controlledRunner();
  const q3 = createQueue({ runner: r3.runner, concurrency: 1 });
  q3.restore([...saved, { bozuk: true }, null, { id: 'z', state: 'garip' }], { resume: false });
  await tick();
  assert.deepEqual(q3.list().map((x) => x.state), ['done', 'paused', 'running']);
  assert.deepEqual(r3.started, ['c']);
});
