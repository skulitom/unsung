// @ts-check
/**
 * The explorer's data access (DESIGN §10.1, §10.5): the server API, the examples kept in the
 * browser, and the read-only Pages fallback to data/gallery.json with feedback in localStorage.
 * Every request goes to an injected fake fetch.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJsonFixture } from './support/fixtures.mjs';
import { validateFeedback } from '../src/core/schema.mjs';
import { ApiError, STORAGE_KEYS, createApi, indexFromGallery, memoryStorage } from '../web/api.mjs';

const SAMPLE = loadJsonFixture('index.sample.json');
const NOW = '2026-09-11T16:00:00.000Z';

/**
 * @typedef {{status: number, body: unknown} | Error | ((init: any) => {status: number, body: unknown})} Route
 */

/**
 * A fake fetch keyed by `METHOD url`; unknown routes answer 404 with an HTML page.
 * @param {Record<string, Route>} routes
 */
function fakeFetch(routes) {
  /** @type {{url: string, init: any}[]} */
  const calls = [];
  /**
   * @param {string} url
   * @param {any} [init]
   */
  const f = async (url, init = {}) => {
    calls.push({ url, init });
    const route = routes[`${init.method ?? 'GET'} ${url}`];
    if (route instanceof Error) throw route;
    if (!route) return { ok: false, status: 404, text: async () => '<!doctype html><p>Not found</p>' };
    const r = typeof route === 'function' ? route(init) : route;
    return {
      ok: r.status >= 200 && r.status < 300, status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    };
  };
  return Object.assign(f, { calls });
}

const codefly = SAMPLE.entries.find((/** @type {any} */ e) => e.nwo === 'codefly-dev/cli');

/**
 * @param {any} entry
 * @param {string} action
 * @param {Record<string, unknown>} [extra]
 */
function body(entry, action, extra = {}) {
  return /** @type {any} */ ({ id: entry.id, nwo: entry.nwo, action, label: null, reason: null, note: '',
    blind: false, undoes: null, snoozeUntil: null, context: null, ...extra });
}

test('served locally, every call goes to the JSON API with the explorer headers', async () => {
  const fetch = fakeFetch({
    'GET api/index': { status: 200, body: SAMPLE },
    'POST api/feedback': (init) => ({
      status: 200, body: { taste: {}, entry: null, event: JSON.parse(init.body) },
    }),
    'GET api/repo/o/missing': { status: 404, body: { error: 'There is no record for o/missing' } },
    'GET api/repo/A-1/x.y_z': { status: 200, body: { id: 'R', nwo: 'A-1/x.y_z' } },
    'GET api/calibrate?n=50': { status: 200, body: { items: [] } },
    'POST api/add': { status: 409, body: { error: 'A run holds the lock' } },
  });
  const api = createApi({ fetch, storage: memoryStorage(), now: () => NOW });
  const index = await api.index();
  assert.equal(api.mode, 'server');
  assert.equal(index.entries.length, SAMPLE.entries.length);
  await api.feedback(body(codefly, 'gem'));
  const sent = fetch.calls.find((c) => c.url === 'api/feedback');
  assert.equal(sent?.init.method, 'POST');
  assert.equal(sent?.init.headers['content-type'], 'application/json');
  assert.equal(sent?.init.headers['x-unsung'], '1');
  assert.equal(JSON.parse(sent?.init.body).action, 'gem');
  assert.equal(await api.repo('o/missing'), null);
  assert.equal((await api.repo('A-1/x.y_z')).id, 'R');
  await assert.rejects(api.repo('../etc'), ApiError);
  await api.calibrate(500);
  assert.ok(fetch.calls.some((c) => c.url === 'api/calibrate?n=50'), 'n is capped at 50');
  await assert.rejects(api.add('o/r'),
    (/** @type {any} */ err) => err.status === 409 && /lock/.test(err.message));
  await assert.rejects(api.add('not a repo'), (/** @type {any} */ err) => err.status === 400);
});

test('Calibrate asks for the day\'s draw, or passes a fresh seed for another one', async () => {
  const fetch = fakeFetch({
    'GET api/index': { status: 200, body: SAMPLE },
    'GET api/calibrate?n=20': { status: 200, body: { items: [], seed: 1 } },
    'GET api/calibrate?n=20&seed=5': { status: 200, body: { items: [], seed: 5 } },
    'GET api/calibrate?n=20&seed=4294967295': { status: 200, body: { items: [], seed: 4294967295 } },
  });
  const api = createApi({ fetch, storage: memoryStorage(), now: () => NOW });
  await api.index();
  assert.equal((await api.calibrate(20, { seed: 5 })).seed, 5);
  assert.equal((await api.calibrate()).seed, 1);
  await api.calibrate(20, { seed: -1 });
  await api.calibrate(20, { seed: Number.NaN });
  assert.deepEqual(fetch.calls.map((c) => c.url).filter((u) => u.startsWith('api/calibrate')), [
    'api/calibrate?n=20&seed=5', 'api/calibrate?n=20', 'api/calibrate?n=20&seed=4294967295', 'api/calibrate?n=20',
  ]);
});

test('a server error is reported, not mistaken for a static copy', async () => {
  const api = createApi({ fetch: fakeFetch({ 'GET api/index': { status: 500, body: { error: 'Boom' } } }),
    storage: memoryStorage() });
  await assert.rejects(api.index(), (/** @type {any} */ err) => err.status === 500 && err.message === 'Boom');
});

test('the examples keep their decisions in the browser, under their own key', async () => {
  const fetch = fakeFetch({ 'GET api/index': { status: 200, body: { ...SAMPLE, examples: true } } });
  const storage = memoryStorage();
  let t = Date.parse(NOW);
  const api = createApi({ fetch, storage, now: () => new Date(t).toISOString() });
  await api.index();
  assert.equal(api.mode, 'examples');
  const res = await api.feedback(body(codefly, 'gem'));
  assert.deepEqual(validateFeedback(res.event), []);
  assert.equal(res.event.label, 'G');
  assert.equal(res.entry?.feedback?.last?.action, 'gem');
  assert.equal(res.taste.facets['lang:go'].gems, 1);
  assert.ok(!fetch.calls.some((c) => c.init.method === 'POST'), 'nothing is posted');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEYS.examples.events) ?? '[]').length, 1);
  assert.equal(storage.getItem(STORAGE_KEYS.static.events), null);
  const second = await api.feedback(body(codefly, 'publish'));
  assert.ok(second.event.at > res.event.at, 'times never repeat, even within one millisecond');
  const undo = await api.feedback(body(codefly, 'undo', { undoes: res.event.at }));
  assert.equal(undo.entry?.feedback?.last, null);
  await assert.rejects(api.feedback(body(codefly, 'undo', { undoes: '1999-01-01T00:00:00.000Z' })),
    (/** @type {any} */ err) => err.status === 409);
  await assert.rejects(api.feedback(body(codefly, 'notgood')),
    (/** @type {any} */ err) => err.status === 400);
  t += 1000;
  const pinned = await api.pin('lang:rust', -1);
  assert.equal(pinned.taste.facets['lang:rust'].pin, -1);
  const exported = api.exportFeedback();
  assert.equal(exported.v, 1);
  assert.equal(exported.events.length, 3);
  assert.deepEqual(exported.pins, { 'lang:rust': -1 });
  const again = createApi({ fetch, storage, now: () => NOW });
  const reloaded = await again.index();
  const entry = reloaded.entries.find((/** @type {any} */ e) => e.id === codefly.id);
  assert.equal(entry.feedback.published, true, 'decisions survive a reload');
});

test('a read-only copy falls back to data/gallery.json and localStorage', async () => {
  const gallery = { v: 1, generatedAt: NOW, entries: [
    { nwo: 'o/tool', url: 'https://github.com/o/tool', description: 'A tool', lang: 'Rust', pitch: 'Fast.',
      note: 'I use it daily', publishedAt: NOW, starsAtPublish: 2, starsNow: 5,
      reasons: ['Ships releases: 3'],
      signals: [{ label: 'Ships releases', points: 1 }, { label: 'Has tests', points: 1 }], quality: 0.8,
      confidence: 0.6 },
    { nwo: 'not a repo', signals: [] },
  ] };
  const fetch = fakeFetch({ 'GET data/gallery.json': { status: 200, body: gallery } });
  const storage = memoryStorage();
  const api = createApi({ fetch, storage, now: () => NOW });
  const index = await api.index();
  assert.equal(api.mode, 'static');
  assert.equal(index.entries.length, 1);
  const e = index.entries[0];
  assert.equal(e.lane, 'proven');
  assert.equal(e.S, 2);
  assert.equal(e.feedback?.published, true);
  assert.deepEqual(e.top, ['Ships releases: 3']);
  assert.equal(await api.repo('o/tool'), null);
  assert.equal((await api.status()).static, true);
  await assert.rejects(api.add('o/tool'), (/** @type {any} */ err) => err.status === 409);
  const res = await api.feedback(body(e, 'notmine'));
  assert.equal(res.entry?.feedback?.last?.action, 'notmine');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEYS.static.events) ?? '[]').length, 1);
});

test('network failures fall back too, and with nothing to show the error says what to do', async () => {
  const offline = fakeFetch({ 'GET api/index': new TypeError('fetch failed'),
    'GET data/gallery.json': { status: 200, body: { entries: [] } } });
  const api = createApi({ fetch: offline, storage: memoryStorage() });
  await api.index();
  assert.equal(api.mode, 'static');
  const nothing = createApi({ fetch: fakeFetch({}), storage: memoryStorage() });
  await assert.rejects(nothing.index(),
    (/** @type {any} */ err) => err.status === 404 && /npm start/.test(err.message));
});

test('blocked storage never breaks the explorer: decisions are kept for the page', async () => {
  const blocked = {
    getItem() {
      throw new Error('SecurityError');
    },
    setItem() {
      throw new Error('QuotaExceeded');
    },
    removeItem() {},
  };
  const examplesFetch = fakeFetch({ 'GET api/index': { status: 200, body: { ...SAMPLE, examples: true } } });
  const api = createApi({ fetch: examplesFetch, storage: blocked, now: () => NOW });
  await api.index();
  const res = await api.feedback(body(codefly, 'snooze', { snoozeUntil: '2026-10-11T16:00:00.000Z' }));
  assert.equal(res.entry?.feedback?.snoozeUntil, '2026-10-11T16:00:00.000Z');
  assert.equal(api.localEvents().length, 1);
  const noStorage = createApi({ fetch: fakeFetch({ 'GET api/index': { status: 200, body: { ...SAMPLE,
    examples: true } } }), storage: null, now: () => NOW });
  await noStorage.index();
  await noStorage.feedback(body(codefly, 'gem'));
  assert.equal(noStorage.localEvents().length, 1);
});

test('indexFromGallery keeps only valid picks and caps their text', () => {
  const idx = indexFromGallery({ entries: [{ nwo: 'o/r', description: 'd'.repeat(500), pitch: 'p'.repeat(300),
    signals: [{ label: 'x', points: 1 }] }, null, { nwo: 'bad' }] });
  assert.equal(idx.entries.length, 1);
  assert.equal(idx.entries[0].description?.length, 300);
  assert.equal(idx.entries[0].verdict?.pitch?.length, 140);
  assert.equal(indexFromGallery(null).entries.length, 0);
});
