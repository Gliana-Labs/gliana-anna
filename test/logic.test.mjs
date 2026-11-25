import { test } from 'node:test';
import assert from 'node:assert/strict';
import { offeredModels, offeredTools, catalogText, checkPick, cleanInput, attachImage, priceQuery, requestFor, mediaIn, extractJson, looksLikeKey } from '../app/bundle/logic.js';

const models = [
  { id: 'z-image-turbo', category: 'text-to-image', priceLabel: '$0.006 Per image' },
  { id: 'veo-3.1-fast', category: 'text-to-video', priceLabel: '$0.30 Per second' },
  { id: 'glm-5.3-abliterated', category: 'text', priceLabel: '$1' },
  { id: 'some-uncensored-image', category: 'text-to-image', priceLabel: '$0.01' },
  { id: 'whisper', category: 'stt', priceLabel: '$0.001' },
];
const tools = [
  { name: 'search', category: 'ai', method: 'POST', path: '/v1/tools/search', priceMicroUsd: 5000, payableFromBalance: true, guidance: 'Web search' },
  { name: 'ocr-ktp', category: 'identity', method: 'POST', path: '/v1/tools/ocr-ktp', priceMicroUsd: 10000, payableFromBalance: true },
  { name: 'cek-nik-x', category: 'indonesia', method: 'GET', path: '/v1/tools/x', priceMicroUsd: 1000, payableFromBalance: true },
  { name: 'stock-quote', category: 'market', method: 'GET', path: '/v1/tools/stock-quote', priceMicroUsd: 2000, payableFromBalance: true },
  { name: 'crypto-only', category: 'market', method: 'GET', path: '/v1/tools/c', priceMicroUsd: 2000, payableFromBalance: false },
];

test('offers media models and safe balance-payable tools only', () => {
  assert.deepEqual(offeredModels(models).map((m) => m.id), ['z-image-turbo', 'veo-3.1-fast']);
  assert.deepEqual(offeredTools(tools).map((t) => t.name), ['search', 'stock-quote']);
  const txt = catalogText(offeredModels(models), offeredTools(tools));
  assert.match(txt, /model z-image-turbo \| image/);
  assert.match(txt, /tool search \| ai \| \$0\.0050/);
});

test('a pick must be something we offer', () => {
  const m = offeredModels(models);
  const t = offeredTools(tools);
  assert.equal(checkPick({ type: 'model', id: 'z-image-turbo' }, m, t).ok, true);
  assert.equal(checkPick({ type: 'model', id: 'glm-5.3-abliterated' }, m, t).ok, false);
  assert.equal(checkPick({ type: 'tool', id: 'ocr-ktp' }, m, t).ok, false);
  assert.equal(checkPick({ type: 'none', why: 'no' }, m, t).ok, false);
});

test('input keeps schema fields and reports missing required ones', () => {
  const schema = { required: ['prompt'], props: { prompt: {}, duration: {}, image: {} } };
  assert.deepEqual(cleanInput({ prompt: 'a', bogus: 1, duration: 5 }, schema), { input: { prompt: 'a', duration: 5 }, missing: [] });
  assert.deepEqual(cleanInput({ duration: 5 }, schema).missing, ['prompt']);
  assert.deepEqual(attachImage({ image: '{{ATTACHED_IMAGE}}', prompt: 'x' }, 'data:image/png;base64,AA'), { image: 'data:image/png;base64,AA', prompt: 'x' });
});

test('the quote carries the fields that change the price', () => {
  const q = new URLSearchParams(priceQuery('veo-3.1-fast', { prompt: 'x', duration: 8, resolution: '1080p', image_urls: ['a', 'b'] }));
  assert.equal(q.get('duration'), '8');
  assert.equal(q.get('resolution'), '1080p');
  assert.equal(q.get('images'), '2');
  assert.equal(q.get('prompt'), null);
});

test('requests go to /v1/infer for models and to the tool path for tools, on the user key', () => {
  const r1 = requestFor({ kind: 'model', item: models[0], input: { prompt: 'cat' } }, 'gk_aaaaaaaaaaaaaaaaaaaa');
  assert.equal(r1.url, 'https://api.glianalabs.com/v1/infer');
  assert.deepEqual(JSON.parse(r1.init.body), { model: 'z-image-turbo', prompt: 'cat' });
  assert.equal(r1.init.headers.authorization, 'Bearer gk_aaaaaaaaaaaaaaaaaaaa');
  const r2 = requestFor({ kind: 'tool', item: tools[3], input: { symbol: 'BBCA' } }, 'gk_x');
  assert.equal(r2.url, 'https://api.glianalabs.com/v1/tools/stock-quote?symbol=BBCA');
});

test('finds media in a response', () => {
  const out = mediaIn({ output: ['https://api.glianalabs.com/v1/media/abc.png'], extra: { video: 'https://api.glianalabs.com/v1/media/x.mp4' } }, 'image');
  assert.deepEqual(out, [{ url: 'https://api.glianalabs.com/v1/media/abc.png', kind: 'image' }, { url: 'https://api.glianalabs.com/v1/media/x.mp4', kind: 'video' }]);
  assert.equal(mediaIn({ output: 'https://api.glianalabs.com/v1/media/abc' }, 'voice')[0].kind, 'audio');
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.ok(looksLikeKey('gk_abcdefghijklmnopqrstu'));
  assert.ok(!looksLikeKey('sk-123'));
});
