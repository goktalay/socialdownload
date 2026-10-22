'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STRINGS, LANGUAGES, createT, resolveLanguage } = require('../src/i18n');
const YT = require('../src/ytdlp');

// Kodda kullanılan her anahtar sözlükte olmalı (dinamik anahtarlar dahil)
test('i18n: kullanılan anahtarlar sözlükte var', () => {
  const dir = path.join(__dirname, '..', 'src');
  const files = ['main.js', ...fs.readdirSync(path.join(dir, 'renderer')).filter((f) => f.endsWith('.js')).map((f) => 'renderer/' + f)];
  const used = new Set();
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/\bt\('([\w.-]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/'((?:auth|keys|st|fmt)\.[\w.]+)'/g)) used.add(m[1]);
  }
  for (const k of ['merge', 'convert', 'remux', 'meta', 'finish', 'post']) used.add('st.pp.' + k);
  for (const k of ['check', 'signature', 'download', 'verify', 'install']) used.add('eng.step.' + k);
  for (const k of Object.keys(YT.TOKENS)) used.add('tok.' + k);
  for (const k of ['empty', 'too_long', 'path', 'raw', 'unknown_token', 'no_token']) used.add('tpl.' + k);
  // Motorun, bağlantı denetiminin ve güncelleyicinin üretebildiği tüm hata kodları
  const ytSrc = fs.readFileSync(path.join(dir, 'ytdlp.js'), 'utf8') + fs.readFileSync(path.join(dir, 'urls.js'), 'utf8') + fs.readFileSync(path.join(dir, 'engine.js'), 'utf8') + fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
  for (const m of ytSrc.matchAll(/code: '([a-z_]+)'/g)) used.add('err.' + m[1]);
  for (const m of ytSrc.matchAll(/\['([a-z_]+)', \//g)) used.add('err.' + m[1]);
  // Şablon denetimi (tpl.*) ve dosya açma (q.fileMissing / q.openFailed) kodları kendi metinleriyle gösterilir
  for (const k of ['path', 'raw', 'unknown_token', 'no_token', 'too_long', 'empty', 'missing', 'failed']) if (!(('err.' + k) in STRINGS.en)) used.delete('err.' + k);
  const missing = [...used].filter((k) => !k.endsWith('.') && !(k in STRINGS.en));
  assert.deepStrictEqual(missing, []);
});

// Mastertool standardı: 8 dil sabit sırayla, hepsinde aynı anahtarlar ve aynı yer tutucular
test('i18n: 8 dil, anahtar ve yer tutucu eşliği', () => {
  assert.deepStrictEqual(Object.keys(LANGUAGES), ['tr', 'en', 'fr', 'de', 'es', 'ar', 'zh', 'ru']);
  assert.strictEqual(LANGUAGES.ar.dir, 'rtl');
  const keys = Object.keys(STRINGS.en).sort();
  const ph = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join();
  for (const l of Object.keys(LANGUAGES)) {
    assert.deepStrictEqual(Object.keys(STRINGS[l]).sort(), keys, l);
    for (const k of keys) {
      assert.strictEqual(ph(STRINGS[l][k]), ph(STRINGS.en[k]), `${l} ${k}`);
      assert.ok(String(STRINGS[l][k]).trim(), `${l} ${k} boş`);
      assert.ok(!/IP Tools'u|IP Tools keeps|IP Tools starts|Quick Preview şu/.test(STRINGS[l][k]), `${l} ${k}: başka uygulamanın metni`);
    }
  }
});

test('i18n: hukuki uyarı metni her dilde var', () => {
  assert.strictEqual(STRINGS.tr['notice.text'], 'Yalnızca indirme hakkınız olan içerikleri indirin; telif hakları ve platform kullanım koşulları kullanıcının sorumluluğundadır.');
  for (const l of Object.keys(LANGUAGES)) {
    assert.ok(STRINGS[l]['notice.text'].length > 20, l);
    assert.ok(STRINGS[l]['notice.short'].includes(STRINGS[l]['notice.text']), l);
    assert.ok(/Netflix/.test(STRINGS[l]['notice.l3']), l);
  }
});

test('i18n: dil çözümleme ve yer tutucu doldurma', () => {
  assert.strictEqual(resolveLanguage('tr-TR'), 'tr');
  assert.strictEqual(resolveLanguage('pt-BR'), 'en');
  assert.strictEqual(resolveLanguage(''), 'en');
  assert.strictEqual(createT('tr')('q.added', { n: 3 }), '3 öğe kuyruğa eklendi');
  assert.strictEqual(createT('xx')('q.added', { n: 3 }), '3 items added to the queue');
  assert.strictEqual(createT('en')('tpl.unknown_token', { token: 'x' }), 'Unknown token: {x}');
  assert.strictEqual(createT('en')('yok.anahtar'), 'yok.anahtar');
});
