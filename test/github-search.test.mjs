// @ts-check
/**
 * Census windows (DESIGN §3.2): the recorded normal window is paged exactly as recorded; synthetic
 * populations reproduce hand-built count trees exactly (time splits, star splits, saturation); no
 * request ever asks for `after + first > 1000`; drifted nodes are dropped; done units are skipped.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFetch } from './support/fake-fetch.mjs';
import { fakeClock } from './support/clock.mjs';
import { loadJsonFixture } from './support/fixtures.mjs';
import { createGovernor } from '../src/github/governor.mjs';
import { createClient } from '../src/github/client.mjs';
import { BASE_QUERY, SEARCH_QUERY } from '../src/github/queries.mjs';
import {
  LEAF_MAX, PAGE_WINDOW_MS, baseCriteria, censusWindows, cursor, hourWindows, nodeMatchesBase,
  normaliseScope, scopeKey, scopeQualifiers, searchString, splitWindow, starSplits, windowKey, windowSeconds,
} from '../src/github/search.mjs';
import { clearSecrets } from '../src/secrets.mjs';

const DAY = '2026-09-08';
const RATE = { cost: 1, remaining: 4000, resetAt: '2026-09-08T20:00:00Z' };

/**
 * @typedef {{id: string, nameWithOwner: string, createdAt: string, stargazerCount: number, idxStars?: number,
 *   [k: string]: unknown}} Repo
 */

/**
 * A lean node as the search returns it.
 * @param {number} i
 * @param {number} t creation time, ms
 * @param {number} [stars]
 * @param {Record<string, unknown>} [extra]
 * @returns {Repo}
 */
function repo(i, t, stars = 0, extra = {}) {
  const iso = new Date(t).toISOString().replace('.000Z', 'Z');
  return {
    id: `R_${String(i).padStart(6, '0')}`, nameWithOwner: `user${i % 97}/repo${i}`,
    createdAt: iso, pushedAt: iso,
    stargazerCount: stars, forkCount: 0, diskUsage: 500, isFork: false, isArchived: false, isTemplate: false,
    isMirror: false, description: `Repository ${i}`, licenseInfo: null, primaryLanguage: { name: 'Rust' },
    owner: { login: `user${i % 97}`, __typename: 'User' }, ...extra,
  };
}

let serial = 0;

/**
 * `n` repositories spread evenly over an inclusive window.
 * @param {number} n
 * @param {string} fromIso
 * @param {string} toIso
 * @param {(i: number) => number} [stars]
 * @returns {Repo[]}
 */
function spread(n, fromIso, toIso, stars = () => 0) {
  const from = Date.parse(fromIso);
  const secs = (Date.parse(toIso) - from) / 1000 + 1;
  return Array.from({ length: n },
    (_, i) => repo(serial++, from + Math.floor((i * secs) / n) * 1000, stars(i)));
}

/**
 * A GitHub search over a synthetic population: parses `created:` and `stars:` (and `language:`),
 * orders by stars then id, and applies the 1,000-result cap like GitHub.
 * @param {Repo[]} pop
 * @param {{q: string, first: number, after: number}[]} log
 * @returns {import('./support/fake-fetch.mjs').Route}
 */
function searchRoute(pop, log) {
  return {
    method: 'POST',
    respond: (call) => {
      assert.equal(call.query, SEARCH_QUERY);
      const { q, first, after } = /** @type {any} */ (call.variables);
      const created = /created:(\S+)\.\.(\S+)/.exec(q);
      const stars = /stars:(\d+)(?:\.\.(\d+))?/.exec(q);
      const lang = /language:(\S+)/.exec(q);
      assert.ok(created && stars);
      const from = Date.parse(created[1]);
      const to = Date.parse(created[2]) + 999;
      const lo = Number(stars[1]);
      const hi = stars[2] === undefined ? lo : Number(stars[2]);
      const hits = pop.filter((r) => {
        const t = Date.parse(r.createdAt);
        const s = r.idxStars ?? r.stargazerCount;
        return t >= from && t <= to && s >= lo && s <= hi && (!lang || lang[1] === 'rust');
      }).sort((a, b) => (a.idxStars ?? a.stargazerCount) - (b.idxStars ?? b.stargazerCount)
        || a.id.localeCompare(b.id));
      const offset = after ? Number(Buffer.from(after, 'base64').toString('utf8').replace('cursor:', '')) : 0;
      log.push({ q, first, after: offset });
      const visible = hits.slice(0, 1000);
      const nodes = visible.slice(offset, offset + first).map(({ idxStars, ...node }) => node);
      return {
        status: 200,
        ms: 400,
        body: {
          data: {
            rateLimit: RATE,
            search: {
              repositoryCount: hits.length,
              pageInfo: {
                hasNextPage: offset + first < visible.length, endCursor: cursor(offset + nodes.length),
              },
              nodes,
            },
          },
        },
      };
    },
  };
}

/** A Store-shaped ledger in memory. */
function memoryLedger() {
  /** @type {Map<string, any>} */
  const units = new Map();
  /** @type {[string, string][]} */
  const events = [];
  return {
    units,
    events,
    isDone: (/** @type {string} */ key) => units.get(key)?.state === 'done',
    start: (/** @type {string} */ key, /** @type {string} */ stage, /** @type {string | null} */ runId) => {
      events.push(['start', key]);
      units.set(key, { key, stage, runId, state: 'running', attempts: (units.get(key)?.attempts ?? 0) + 1 });
    },
    done: (/** @type {string} */ key, /** @type {any} */ out) => {
      events.push(['done', key]);
      units.set(key, { ...units.get(key), key, state: 'done', out });
    },
    fail: (/** @type {string} */ key, /** @type {any} */ err) => {
      events.push(['fail', key]);
      units.set(key, { ...units.get(key), key, state: 'failed', err });
    },
    list: ({ state = /** @type {string | undefined} */ (undefined) } = {}) => [...units.values()]
      .filter((u) => !state || u.state === state),
  };
}

/**
 * @param {import('./support/fake-fetch.mjs').Route[]} routes
 */
function setup(routes) {
  const clock = fakeClock('2026-09-11T12:00:00Z', { auto: true });
  const fetch = createFakeFetch(routes, { clock });
  const governor = createGovernor({}, { clock });
  const client = createClient({ token: 'search-test-token-9876', governor, fetch });
  return { clock, fetch, client };
}

/**
 * @param {AsyncIterable<any>} gen
 * @returns {Promise<any[]>}
 */
async function all(gen) {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
}

afterEach(() => clearSecrets());

describe('search strings and windows', () => {
  it('reproduce the recorded search string, and add scope and star splits', () => {
    const fx = loadJsonFixture('search/normal-2026-09-08T0400.json');
    assert.equal(searchString(BASE_QUERY, null, fx.fromIso, fx.toIso), fx.q);
    assert.equal(searchString(null, 'lang=rust,topic=cli', '2026-09-08T00:00:00Z', '2026-09-08T00:59:59Z'),
      `${BASE_QUERY} created:2026-09-08T00:00:00Z..2026-09-08T00:59:59Z `
        + 'language:rust topic:cli sort:stars-asc');
    assert.match(searchString(BASE_QUERY, { lang: 'Jupyter Notebook' }, fx.fromIso, fx.toIso, '2..25'),
      / stars:2\.\.25 size:>=200 .* language:"Jupyter Notebook" sort:stars-asc$/);
    assert.throws(() => searchString(BASE_QUERY, null, '2026-09-08', fx.toIso), RangeError);
    assert.throws(() => searchString(BASE_QUERY, null, fx.fromIso, fx.toIso, '>1000'), RangeError);
  });

  it('crafted cursors match the recorded ones', () => {
    const sat = loadJsonFixture('search/saturated-2026-09-08T14.json');
    const afters = sat.pages.slice(1).map((/** @type {any} */ p) => p.request.variables.after);
    assert.deepEqual(afters, [1, 2, 3, 4, 5, 6, 7, 8, 9].map((k) => cursor(100 * k)));
    assert.equal(sat.pages[9].body.data.search.pageInfo.endCursor, cursor(1000));
    assert.equal(cursor(100), 'Y3Vyc29yOjEwMA==');
    assert.throws(() => cursor(-1), RangeError);
  });

  it('scopes, keys and splits', () => {
    assert.deepEqual(normaliseScope('all'), { lang: null, topic: null });
    assert.equal(scopeKey(null), 'all');
    assert.equal(scopeKey({ lang: 'Rust' }), 'lang=rust');
    assert.equal(scopeKey('lang=Rust,topic=CLI'), 'lang=rust,topic=cli');
    assert.equal(scopeQualifiers({ topic: 'mcp' }), 'topic:mcp');
    assert.throws(() => normaliseScope('language:rust'), RangeError);
    assert.throws(() => normaliseScope({ lang: 'rust stars:>9"' }), RangeError);
    assert.equal(windowKey(DAY, null, '2026-09-08T13:00:00Z', '2026-09-08T13:59:59Z'),
      'census:2026-09-08:all:2026-09-08T13:00:00Z..2026-09-08T13:59:59Z');
    assert.equal(windowKey(DAY, 'lang=rust', '2026-09-08T13:00:00Z', '2026-09-08T13:00:55Z', '0'),
      'census:2026-09-08:lang=rust:2026-09-08T13:00:00Z..2026-09-08T13:00:55Z:stars=0');
    assert.equal(windowSeconds('2026-09-08T13:00:00Z', '2026-09-08T13:59:59Z'), 3600);
    assert.deepEqual(splitWindow('2026-09-08T12:00:00Z', '2026-09-08T12:59:59Z', 4).map((w) => w.toIso),
      ['2026-09-08T12:14:59Z', '2026-09-08T12:29:59Z', '2026-09-08T12:44:59Z', '2026-09-08T12:59:59Z']);
    assert.equal(splitWindow('2026-09-08T12:00:00Z', '2026-09-08T12:00:02Z', 50).length, 3);
    assert.equal(hourWindows(DAY).length, 24);
    assert.deepEqual(hourWindows(DAY)[23],
      { fromIso: '2026-09-08T23:00:00Z', toIso: '2026-09-08T23:59:59Z' });
    assert.throws(() => hourWindows('2026-9-8'), RangeError);
    assert.deepEqual(starSplits(baseCriteria(BASE_QUERY)), ['0', '1', '2..25']);
  });

  it('nodeMatchesBase drops nodes whose live values drifted out of the base query', () => {
    const crit = baseCriteria(BASE_QUERY);
    const win = { fromIso: '2026-09-08T12:00:00Z', toIso: '2026-09-08T12:59:59Z' };
    const good = repo(1, Date.parse('2026-09-08T12:30:00Z'));
    assert.equal(nodeMatchesBase(good, crit, win), true);
    for (const bad of [{ isFork: true }, { isArchived: true }, { isTemplate: true }, { isMirror: true },
      { stargazerCount: 26 }, { diskUsage: 199 }, { createdAt: '2026-09-08T13:00:00Z' }]) {
      assert.equal(nodeMatchesBase({ ...good, ...bad }, crit, win), false, JSON.stringify(bad));
    }
    assert.equal(nodeMatchesBase(good, crit, win, 'go'), false);
  });
});

describe('censusWindows', () => {
  it('pages the recorded normal window exactly as it was recorded', async () => {
    const fx = loadJsonFixture('search/normal-2026-09-08T0400.json');
    const byAfter = new Map(fx.pages.map((/** @type {any} */ p) => [p.request.variables.after ?? null, p]));
    const { client, fetch } = setup([{
      method: 'POST',
      respond: (call) => {
        const p = byAfter.get(/** @type {any} */ (call.variables).after ?? null);
        return { status: p.status, headers: p.headers, body: p.body };
      },
    }]);
    const ledger = memoryLedger();
    const leaves = await all(censusWindows({
      client, fromIso: fx.fromIso, toIso: fx.toIso, ledger, runId: 'r1',
    }));
    assert.equal(leaves.length, 1);
    const [leaf] = leaves;
    const recorded = fx.pages.flatMap((/** @type {any} */ p) => p.body.data.search.nodes);
    const crit = baseCriteria(BASE_QUERY);
    const kept = recorded.filter((/** @type {any} */ n) => nodeMatchesBase(n, crit, fx));
    assert.equal(leaf.key, fx.unitKey);
    assert.equal(leaf.count, 224);
    assert.equal(leaf.pages, 3);
    assert.equal(leaf.saturated, false);
    assert.equal(leaf.nodes.length, kept.length);
    assert.equal(leaf.dropped, recorded.length - kept.length);
    assert.deepEqual(fetch.calls.map((c) => c.variables),
      fx.pages.map((/** @type {any} */ p) => p.request.variables));
    assert.deepEqual(ledger.events, [['start', fx.unitKey], ['done', fx.unitKey]]);
    assert.deepEqual(ledger.units.get(fx.unitKey).out,
      { count: 224, pages: 3, saturated: false, seeds: kept.length });
  });

  it('reproduces a hand-built time-split tree exactly', async () => {
    const pop = [
      ...spread(700, '2026-09-08T12:00:00Z', '2026-09-08T12:14:59Z'),
      ...spread(600, '2026-09-08T12:15:00Z', '2026-09-08T12:22:29Z', (i) => i % 26),
      ...spread(600, '2026-09-08T12:22:30Z', '2026-09-08T12:29:59Z', (i) => i % 3),
      ...spread(500, '2026-09-08T12:30:00Z', '2026-09-08T12:44:59Z'),
      ...spread(334, '2026-09-08T12:45:00Z', '2026-09-08T12:59:59Z'),
    ];
    /** @type {{q: string, first: number, after: number}[]} */
    const log = [];
    const { client } = setup([searchRoute(pop, log)]);
    /** @type {Record<string, number>} */
    const stats = {};
    const leaves = await all(censusWindows({
      client, fromIso: '2026-09-08T12:00:00Z', toIso: '2026-09-08T12:59:59Z', stats,
    }));
    const rows = leaves.map((l) => [
      l.fromIso.slice(11), l.toIso.slice(11), l.count, l.pages, l.saturated,
    ]);
    assert.deepEqual(rows, [
      ['12:00:00Z', '12:14:59Z', 700, 7, false],
      ['12:15:00Z', '12:22:29Z', 600, 6, false],
      ['12:22:30Z', '12:29:59Z', 600, 6, false],
      ['12:30:00Z', '12:44:59Z', 500, 5, false],
      ['12:45:00Z', '12:59:59Z', 334, 4, false],
    ]);
    const ids = leaves.flatMap((l) => l.nodes.map((/** @type {any} */ n) => n.id));
    assert.equal(ids.length, 2734);
    assert.equal(new Set(ids).size, 2734);
    assert.equal(stats.probes, 7, 'the hour, its four quarters and the two halves of the busy quarter');
    assert.equal(log.length, 30);
    assert.ok(log.every((c) => c.after + c.first <= 1000));
    assert.ok(log.every((c) => c.after % 100 === 0));
  });

  it('splits a crowded minute by stars and records saturation with the reported count', async () => {
    const pop = [
      ...spread(1100, '2026-09-08T13:00:00Z', '2026-09-08T13:00:55Z', () => 0),
      ...spread(300, '2026-09-08T13:00:00Z', '2026-09-08T13:00:55Z', () => 1),
      ...spread(100, '2026-09-08T13:00:00Z', '2026-09-08T13:00:55Z', (i) => 2 + (i % 24)),
    ];
    /** @type {{q: string, first: number, after: number}[]} */
    const log = [];
    const { client } = setup([searchRoute(pop, log)]);
    const ledger = memoryLedger();
    const leaves = await all(censusWindows({
      client, fromIso: '2026-09-08T13:00:00Z', toIso: '2026-09-08T13:59:59Z', ledger,
    }));
    /** @type {(a: string, b: string) => string} */
    const T = (a, b) => `census:${DAY}:all:${DAY}T${a}Z..${DAY}T${b}Z`;
    assert.deepEqual(leaves.map((l) => [l.key, l.count, l.pages, l.nodes.length, l.saturated]), [
      [`${T('13:00:00', '13:00:55')}:stars=0`, 1100, 10, 1000, true],
      [`${T('13:00:00', '13:00:55')}:stars=1`, 300, 3, 300, false],
      [`${T('13:00:00', '13:00:55')}:stars=2..25`, 100, 1, 100, false],
      [T('13:00:56', '13:01:51'), 0, 1, 0, false],
      [T('13:01:52', '13:03:44'), 0, 1, 0, false],
      [T('13:03:45', '13:07:29'), 0, 1, 0, false],
      [T('13:07:30', '13:14:59'), 0, 1, 0, false],
      [T('13:15:00', '13:29:59'), 0, 1, 0, false],
      [T('13:30:00', '13:59:59'), 0, 1, 0, false],
    ]);
    assert.ok(log.every((c) => c.after + c.first <= 1000), 'never after + first > 1000');
    assert.equal(Math.max(...log.map((c) => c.after)), 900);
    assert.deepEqual(ledger.units.get(`${T('13:00:00', '13:00:55')}:stars=0`).out,
      { count: 1100, pages: 10, saturated: true, seeds: 1000 });
  });

  it('partitions random populations: small leaves, no gaps, nothing lost but saturation', async () => {
    for (const seed of [1, 2, 3]) {
      let x = seed;
      const rand = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
      const pop = [];
      const clusters = 1 + Math.floor(rand() * 4);
      for (let c = 0; c < clusters; c++) {
        const at = Date.parse('2026-09-08T08:00:00Z') + Math.floor(rand() * 3600) * 1000;
        const n = Math.floor(rand() * 900);
        const width = 1 + Math.floor(rand() * 600);
        for (let i = 0; i < n; i++) {
          const t = Math.min(at + Math.floor(rand() * width) * 1000, Date.parse('2026-09-08T08:59:59Z'));
          pop.push(repo(serial++, t, Math.floor(rand() * 26)));
        }
      }
      /** @type {{q: string, first: number, after: number}[]} */
      const log = [];
      const { client } = setup([searchRoute(pop, log)]);
      const leaves = await all(censusWindows({
        client, fromIso: '2026-09-08T08:00:00Z', toIso: '2026-09-08T08:59:59Z',
      }));
      let expectFrom = Date.parse('2026-09-08T08:00:00Z');
      let lost = 0;
      for (const l of leaves.filter((y) => y.stars === null || y.stars === '0')) {
        assert.equal(Date.parse(l.fromIso), expectFrom, `seed ${seed}: leaves are contiguous`);
        expectFrom = Date.parse(l.toIso) + 1000;
      }
      assert.equal(expectFrom, Date.parse('2026-09-08T09:00:00Z'), `seed ${seed}: leaves cover the hour`);
      for (const l of leaves) {
        const secs = windowSeconds(l.fromIso, l.toIso);
        const small = l.count <= 900 || (secs <= 60 && (l.count <= 1000 || l.stars !== null));
        assert.ok(small, `seed ${seed}: ${l.key}`);
        if (l.saturated) lost += l.count - 1000;
      }
      const found = new Set(leaves.flatMap((l) => l.nodes.map((/** @type {any} */ n) => n.id)));
      assert.equal(found.size, pop.length - lost, `seed ${seed}: every repository found once`);
      assert.ok(log.every((c) => c.after + c.first <= 1000));
    }
  });

  it('drops drifted nodes and honours the language scope', async () => {
    const t = Date.parse('2026-09-08T06:10:00Z');
    const pop = [
      repo(1, t), repo(2, t, 0, { isFork: true }), repo(3, t, 30, { idxStars: 3 }),
      repo(4, t, 0, { diskUsage: 50 }),
      repo(5, t, 0, { primaryLanguage: { name: 'Go' } }),
    ];
    const { client } = setup([searchRoute(pop, [])]);
    const leaves = await all(censusWindows({
      client, fromIso: '2026-09-08T06:00:00Z', toIso: '2026-09-08T06:59:59Z', scope: { lang: 'rust' },
    }));
    assert.deepEqual(leaves[0].nodes.map((/** @type {any} */ n) => n.id), ['R_000001']);
    assert.equal(leaves[0].dropped, 4);
    assert.match(leaves[0].key, /^census:2026-09-08:lang=rust:/);
  });

  it('skips covered windows without a search, and resumes a partly done hour', async () => {
    const pop = [
      ...spread(700, '2026-09-08T12:00:00Z', '2026-09-08T12:14:59Z'),
      ...spread(1200, '2026-09-08T12:15:00Z', '2026-09-08T12:29:59Z'),
      ...spread(500, '2026-09-08T12:30:00Z', '2026-09-08T12:44:59Z'),
      ...spread(334, '2026-09-08T12:45:00Z', '2026-09-08T12:59:59Z'),
    ];
    /** @type {{q: string, first: number, after: number}[]} */
    const log = [];
    const { client } = setup([searchRoute(pop, log)]);
    const hour = { fromIso: '2026-09-08T12:00:00Z', toIso: '2026-09-08T12:59:59Z' };
    const ledger = memoryLedger();
    const first = await all(censusWindows({ client, ...hour, ledger }));
    assert.equal(first.length, 5);
    const calls = log.length;
    assert.deepEqual(await all(censusWindows({ client, ...hour, ledger })), []);
    assert.equal(log.length, calls, 'a covered hour costs no search');

    const partial = memoryLedger();
    for (const l of first.slice(0, 3)) partial.done(l.key, {});
    log.length = 0;
    const rest = await all(censusWindows({ client, ...hour, ledger: partial }));
    assert.deepEqual(rest.map((l) => l.key), first.slice(3).map((l) => l.key));
    assert.equal(log.filter((c) => c.after === 0).length, 3, 'the hour probe and the two open quarters');
  });

  it('marks a leaf done only when the consumer comes back for the next one', async () => {
    const pop = spread(50, '2026-09-08T02:00:00Z', '2026-09-08T02:59:59Z');
    const { client } = setup([searchRoute(pop, [])]);
    const ledger = memoryLedger();
    const gen = censusWindows({
      client, fromIso: '2026-09-08T02:00:00Z', toIso: '2026-09-08T02:59:59Z', ledger,
    });
    const { value } = await gen.next();
    assert.equal(ledger.units.get(value.key).state, 'running');
    assert.equal((await gen.next()).done, true);
    assert.equal(ledger.units.get(value.key).state, 'done');
    const broken = memoryLedger();
    const gen2 = censusWindows({
      client, fromIso: '2026-09-08T02:00:00Z', toIso: '2026-09-08T02:59:59Z', ledger: broken,
    });
    const got = await gen2.next();
    await gen2.return(undefined);
    assert.equal(broken.units.get(got.value.key).state, 'running', 'an abandoned leaf is not marked done');
  });

  it('a failing page fails its unit and the walk goes on; fatal errors propagate', async () => {
    const pop = [
      ...spread(250, '2026-09-08T03:00:00Z', '2026-09-08T03:29:59Z'),
      ...spread(800, '2026-09-08T03:30:00Z', '2026-09-08T03:59:59Z'),
    ];
    const good = searchRoute(pop, []);
    const { client } = setup([{
      method: 'POST',
      respond: (call, n) => {
        const v = /** @type {any} */ (call.variables);
        if (v.q.includes('03:00:00Z..2026-09-08T03:29:59Z') && v.after === cursor(200)) return 502;
        return /** @type {any} */ (good).respond(call, n);
      },
    }]);
    const ledger = memoryLedger();
    const leaves = await all(censusWindows({
      client, fromIso: '2026-09-08T03:00:00Z', toIso: '2026-09-08T03:59:59Z', ledger,
    }));
    assert.deepEqual(leaves.map((l) => l.count), [800]);
    const failed = [...ledger.units.values()].filter((u) => u.state === 'failed');
    assert.equal(failed.length, 1);
    assert.match(failed[0].key, /03:00:00Z\.\.2026-09-08T03:29:59Z$/);
    assert.equal(failed[0].err.code, 'EHEAVY');

    const auth = setup([{ method: 'POST', response: 401 }]);
    await assert.rejects(all(censusWindows({ client: auth.client, fromIso: '2026-09-08T03:00:00Z',
      toIso: '2026-09-08T03:59:59Z' })), { name: 'AuthError' });
  });

  it('pages a leaf of LEAF_MAX hits within 60 s of its probe\'s answer at the governor\'s pace', async () => {
    const hours = ['00', '01', '02', '03'];
    for (const pageMs of [5000, 5500]) {
      const pop = hours.flatMap((h) => spread(LEAF_MAX, `${DAY}T${h}:00:00Z`, `${DAY}T${h}:59:59Z`));
      const busy = searchRoute(pop, []);
      const { client } = setup([{
        method: 'POST',
        respond: async (call, n) => ({ .../** @type {any} */ (await busy.respond?.(call, n)), ms: pageMs }),
      }]);
      /** @type {string[]} */
      const warnings = [];
      const log = { debug() {}, warn: (/** @type {string} */ msg) => { warnings.push(msg); } };
      /** @type {number[]} */
      const spans = [];
      for (const h of hours) {
        const leaves = await all(censusWindows({
          client, fromIso: `${DAY}T${h}:00:00Z`, toIso: `${DAY}T${h}:59:59Z`, log,
        }));
        assert.deepEqual(leaves.map((l) => l.pages), [Math.ceil(LEAF_MAX / 100)]);
        spans.push(...leaves.map((l) => l.spanMs));
      }
      assert.ok(spans.every((s) => s <= PAGE_WINDOW_MS), `${pageMs} ms a page: spans ${spans.join(', ')} ms`);
      assert.deepEqual(warnings.filter((w) => /more than 60 s/.test(w)), []);
    }
  });

  it('does not count the time the governor held a probe back toward its leaf\'s span', async () => {
    const pop = spread(150, `${DAY}T04:00:00Z`, `${DAY}T04:59:59Z`);
    const { client, clock } = setup([searchRoute(pop, [])]);
    /** @type {any} */ (client).governor.pause('graphql', clock.ms() + 20_000, 'test');
    const [leaf] = await all(censusWindows({ client, fromIso: `${DAY}T04:00:00Z`, toIso: `${DAY}T04:59:59Z` }));
    assert.equal(leaf.pages, 2);
    assert.ok(clock.ms() >= Date.parse('2026-09-11T12:00:20Z'), 'the probe waited for the pause');
    assert.ok(leaf.spanMs < 20_000, `span ${leaf.spanMs} ms`);
  });
});
