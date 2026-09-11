// @ts-check
/**
 * End to end (DESIGN §12.3, §13 WP2, §14.1): `run` against the REAL modules — WP1's client,
 * governor, budget, queries, batching, REST helpers, census and GH Archive sources; WP3's facts
 * and gates; WP4's scoring; WP5's verdict signal — over recorded fixtures served by a fake fetch,
 * with a fake clock and the memory store. `globalThis.fetch` is replaced by a stub that throws, so
 * any real network access fails the test.
 *
 * The named repositories of §14.2 enter through a GH Archive hour of ReleaseEvents (the census day
 * is empty), are looked up, prefiltered, enriched (one README found by the repair query), deepened
 * and scored. A second run a week later re-checks the deferred ones.
 *
 * Expectations (§13 WP2, §14.2): every seed gem is in a lane its `meta.expect.lane` allows —
 * `promising` or `proven`; `ask-my-tabs` may be `look`, and `montezuma-p/harken` may be `rising`
 * (it gained 13 stars in the four weeks before it was recorded, and §6.7 rule 5 puts such a
 * repository in Rising) — every lure is `quarantine`, the spam repositories are dropped, and no
 * hard negative is `proven`.
 */

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import { loadConfig, resolveProfile } from '../src/config.mjs';
import { DEFAULT_CONFIG_DIR } from '../src/cli/context.mjs';
import { validateIndex, validateRepoRecord } from '../src/core/schema.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import { loadDeps, missingDeps } from '../src/pipeline/deps.mjs';
import { run } from '../src/pipeline/run.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';
import { fakeClock } from './support/clock.mjs';
import { createFakeFetch } from './support/fake-fetch.mjs';
import { fixturePath, listRepoFixtures, loadRepoFixture } from './support/fixtures.mjs';

/** The hour that carries the named repositories' release events. */
const HOUR = '2026-09-11-14';
const START = '2026-09-11T16:00:00Z';
const WEEK_LATER = '2026-09-18T16:00:00Z';

/** Lean census fields (§3.2) of an enrich node. */
const LEAN = [
  'id', 'nameWithOwner', 'createdAt', 'pushedAt', 'stargazerCount', 'forkCount', 'diskUsage', 'isFork',
  'isArchived', 'isTemplate', 'isMirror', 'description', 'licenseInfo', 'primaryLanguage', 'owner',
];

const realFetch = globalThis.fetch;
/** @type {string[]} */
const blocked = [];
before(() => {
  globalThis.fetch = /** @type {any} */ (async (/** @type {any} */ url) => {
    blocked.push(String(url));
    throw new Error(`Real network access attempted: ${String(url).slice(0, 80)}`);
  });
});
after(() => {
  globalThis.fetch = realFetch;
});

/**
 * The named-set fixtures, by lower-cased nwo.
 * @returns {Map<string, import('./support/fixtures.mjs').RepoFixture>}
 */
function namedFixtures() {
  const out = new Map();
  for (const nwo of listRepoFixtures((meta) => typeof meta?.set === 'string')) {
    const fx = loadRepoFixture(nwo);
    if (fx.enrich) out.set(fx.nwo.toLowerCase(), fx);
  }
  return out;
}

/**
 * The GraphQL enrich node as GitHub would return it for `HEAD:README.md`: the fixture's README name
 * is ours, and a README found only by the repair query comes back null.
 * @param {any} enrich
 * @returns {any}
 */
function liveEnrich(enrich) {
  const node = structuredClone(enrich);
  if (node.readme) {
    const { name, ...blob } = node.readme;
    node.readme = name && name !== 'README.md' ? null : blob;
  }
  return node;
}

/**
 * A gzipped GH Archive hour: a ReleaseEvent per named repository, plus the two sample lines that
 * carry a raw U+2028 (they must survive the hand-made line split).
 * @param {Map<string, any>} fixtures
 * @param {boolean} withReleases
 * @returns {Buffer}
 */
function archiveHour(fixtures, withReleases) {
  const gz = readFileSync(fixturePath('gharchive', '2026-09-10-15.sample.json.gz'));
  const sample = zlib.gunzipSync(gz).toString('utf8');
  const tricky = sample.split('\n').filter((l) => l.includes(String.fromCharCode(0x2028)));
  const lines = [...tricky];
  if (withReleases) {
    let n = 1;
    for (const fx of fixtures.values()) {
      lines.push(JSON.stringify({
        id: String(90000000000 + n), type: 'ReleaseEvent', actor: { id: n, login: 'releaser' },
        repo: { id: 700000000 + n, name: fx.nwo, url: `https://api.github.com/repos/${fx.nwo}` },
        payload: { action: 'published', release: { tag_name: `v1.${n}.0`, prerelease: false } },
        public: true, created_at: '2026-09-11T14:05:00Z',
      }));
      n++;
    }
  }
  return zlib.gzipSync(Buffer.from(`${lines.join('\n')}\n`, 'utf8'));
}

/**
 * Answer every request the pipeline makes from the fixtures.
 * @param {Map<string, any>} fixtures
 */
function responder(fixtures) {
  const byId = new Map([...fixtures.values()].map((fx) => [fx.enrich.id, fx]));
  const rateLimit = { cost: 1, remaining: 4900, resetAt: '2026-09-11T17:00:00Z' };
  const headers = {
    'content-type': 'application/json; charset=utf-8', 'x-ratelimit-remaining': '4900',
    'x-ratelimit-reset': '1789153200',
  };
  /**
   * @param {unknown} body
   * @param {number} [status]
   */
  const json = (body, status = 200) => ({ status, headers, body });
  /**
   * @param {string} message
   * @param {(string | number)[]} path
   */
  const notFound = (message, path) => ({ type: 'NOT_FOUND', path, message });

  /**
   * The value of alias `r<i>` for one repository.
   * @param {any} v variables
   * @param {number} i
   * @param {any} fx
   * @param {string} q the document
   */
  const aliasValue = (v, i, fx, q) => {
    if (q.includes('...Enrich')) return liveEnrich(fx.enrich);
    if (q.includes('...Deep')) return fx.deep ?? null;
    if (q.includes('...Lean')) return Object.fromEntries(LEAN.map((k) => [k, fx.enrich[k] ?? null]));
    if (q.includes(`readme: object(expression: $e${i})`)) {
      const file = String(v[`e${i}`]).replace(/^HEAD:/, '');
      const r = fx.enrich.readme;
      const hit = r && r.name === file;
      const blob = { byteSize: r?.byteSize, isTruncated: r?.isTruncated ?? false, text: r?.text };
      return { readme: hit ? blob : null };
    }
    if (q.includes(`$e${i}_0`)) {
      /** @type {Record<string, any>} */
      const files = {};
      for (let j = 0; v[`e${i}_${j}`] !== undefined; j++) {
        files[`f${j}`] = fx.files?.[String(v[`e${i}_${j}`]).replace(/^HEAD:/, '')] ?? null;
      }
      return files;
    }
    return null;
  };

  /**
   * @param {string} q
   * @param {any} v
   */
  const graphql = (q, v) => {
    if (q.includes('search(type: REPOSITORY')) {
      const search = { repositoryCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
      return json({ data: { rateLimit, search } });
    }
    if (q.includes('nodes(ids:')) {
      const errors = [];
      const nodes = v.ids.map((/** @type {string} */ id, /** @type {number} */ i) => {
        const fx = byId.get(id);
        if (!fx) {
          errors.push(notFound(`Could not resolve to a node with the global id of '${id}'.`, ['nodes', i]));
          return null;
        }
        const e = fx.enrich;
        return {
          id, stargazerCount: e.stargazerCount, forkCount: e.forkCount, pushedAt: e.pushedAt,
          isArchived: e.isArchived, primaryLanguage: e.primaryLanguage,
        };
      });
      return json({ data: { rateLimit, nodes }, errors });
    }
    /** @type {Record<string, any>} */
    const data = { rateLimit };
    const errors = [];
    for (let i = 0; v[`o${i}`] !== undefined; i++) {
      const nwo = `${v[`o${i}`]}/${v[`n${i}`]}`.toLowerCase();
      const fx = fixtures.get(nwo);
      const value = fx ? aliasValue(v, i, fx, q) : null;
      if (value === null) {
        errors.push(notFound(`Could not resolve to a Repository with the name '${nwo}'.`, [`r${i}`]));
      }
      data[`r${i}`] = value;
    }
    return json({ data, errors });
  };

  /** @param {any} call */
  return (call) => {
    const url = new URL(call.url);
    if (url.hostname === 'data.gharchive.org') {
      const name = url.pathname.replace(/^\//, '').replace(/\.json\.gz$/, '');
      const body = archiveHour(fixtures, name === HOUR);
      return { status: 200, headers: { 'content-type': 'application/gzip' }, body };
    }
    if (url.hostname !== 'api.github.com') throw new Error(`unexpected host ${url.hostname}`);
    if (url.pathname === '/graphql') return graphql(String(call.query), call.variables ?? {});
    const m = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const key = m ? `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`.toLowerCase() : '';
    const fx = fixtures.get(key);
    if (!fx) return json({ message: 'Not Found' }, 404);
    const sub = m?.[3] ?? '';
    if (sub.startsWith('/git/trees/')) return fx.tree ? json(fx.tree) : json({ message: 'Not Found' }, 404);
    if (sub === '/activity') return json(fx.activity ?? []);
    if (sub === '/stargazers/history') return json(fx.stars ?? []);
    return json({ message: 'Not Found' }, 404);
  };
}

test('recorded fixtures: seed gems promising or proven, lures quarantined, spam dropped', async (t) => {
  const lib = await loadDeps();
  const missing = missingDeps(lib);
  const needs = `The end-to-end run needs every real module; still missing:\n  ${missing.join('\n  ')}`;
  assert.deepEqual(missing, [], needs);
  /** @type {import('../src/config.mjs').Config} */
  let config;
  try {
    config = loadConfig(DEFAULT_CONFIG_DIR);
  } catch (err) {
    assert.fail(`The end-to-end run needs the real configuration: ${/** @type {Error} */ (err).message}`);
  }
  const [{ createClient }, { createGovernor, createBudget }] = await Promise.all([
    import('../src/github/client.mjs'), import('../src/github/governor.mjs'),
  ]);

  const fixtures = namedFixtures();
  assert.equal(fixtures.size, 28, 'the four named sets of §14.2');
  const clock = fakeClock(START, { auto: true });
  const store = createMemoryStore({ now: clock.now });
  const fetch = createFakeFetch([{ name: 'fixtures', url: () => true, respond: responder(fixtures) }]);
  const log = {
    level: 'warn', enabled: () => false, debug() {}, info() {}, warn() {}, error() {}, stage() {},
  };

  /** @param {string} runId */
  const once = async (runId) => {
    const governor = createGovernor(config.defaults.governor, { clock });
    const token = 'e2e-fixture-token-not-real';
    const client = createClient({ token, governor, cache: store.httpCache, fetch, log, clock });
    const opts = resolveProfile(config.defaults, 'quick', {});
    const budget = createBudget(opts.budget, { clock });
    return run(opts, {
      store, client, governor, budget, clock, config, log, rand: mulberry32(11), argv: ['run'], runId, fetch,
      deps: lib,
    });
  };

  const first = await once('20260911T160000Z-e2e1');
  assert.equal(first.exit?.code, 0, `first run: ${JSON.stringify(first.exit)}`);
  clock.set(WEEK_LATER);
  const second = await once('20260918T160000Z-e2e2');
  assert.equal(second.exit?.code, 0, `second run: ${JSON.stringify(second.exit)}`);

  assert.deepEqual(blocked, [], 'no real network access');
  for (const call of fetch.calls) {
    assert.ok(/^https:\/\/(api\.github\.com|data\.gharchive\.org)\//.test(call.url), call.url);
    if (call.url.startsWith('https://data.gharchive.org/')) {
      assert.equal(call.headers.authorization, undefined, 'the token never goes to GH Archive');
    }
  }

  const index = await store.readIndex();
  assert.ok(index);
  assert.deepEqual(validateIndex(index), []);
  for await (const rec of store.listRepos()) assert.deepEqual(validateRepoRecord(rec), [], rec.nwo);
  const lane = new Map(index.entries.map((e) => [e.nwo.toLowerCase(), e]));

  /** @type {string[]} */
  const problems = [];
  for (const fx of fixtures.values()) {
    const key = fx.nwo.toLowerCase();
    const entry = lane.get(key);
    const cand = await store.getCandidate(fx.enrich.id);
    const where = entry?.lane ?? `not indexed (candidate ${cand?.state}/${cand?.reason})`;
    const expect = fx.meta.expect;
    if (fx.meta.set === 'seedGems') {
      const allowed = [...(Array.isArray(expect.lane) ? expect.lane : [expect.lane])];
      if (!entry || !allowed.includes(entry.lane)) {
        problems.push(`seed gem ${fx.nwo}: ${where}, expected ${allowed.join(' or ')}`);
      }
    }
    if (fx.meta.set === 'luresAndSpam' && expect.outcome === 'quarantined') {
      const ids = (entry?.gates ?? []).map((/** @type {any} */ g) => (typeof g === 'string' ? g : g.id));
      if (entry?.lane !== 'quarantine') problems.push(`lure ${fx.nwo}: ${where}, expected quarantine`);
      else if (!expect.gates.some((/** @type {string} */ g) => ids.includes(g))) {
        problems.push(`lure ${fx.nwo}: gates ${ids.join(', ')}, expected ${expect.gates.join(' or ')}`);
      }
    }
    if (fx.meta.set === 'hardNegatives' && entry?.lane === 'proven') {
      problems.push(`hard negative ${fx.nwo}: proven, which §14.2 forbids`);
    }
    if (fx.meta.set === 'luresAndSpam' && expect.outcome === 'dropped') {
      if (entry) problems.push(`spam ${fx.nwo}: indexed in ${entry.lane}, expected dropped`);
      if (cand?.state !== 'dropped') {
        problems.push(`spam ${fx.nwo}: candidate ${cand?.state}, expected dropped`);
      }
    }
  }
  assert.deepEqual(problems, []);

  await t.test('the README repair asked for gene-git/wg-client\'s README.rst', async () => {
    const repair = fetch.calls.find((c) => /readme: object\(expression: \$e0\)/.test(String(c.query))
      && Object.values(c.variables ?? {}).includes('HEAD:README.rst'));
    assert.ok(repair, 'a README repair query for HEAD:README.rst');
    const rec = await store.getRepo('gene-git/wg-client');
    if (rec) assert.equal(rec.facts.readme?.name, 'README.rst');
  });
  await t.test('the deferred spam repositories were re-checked a week later and dropped', async () => {
    const recheck = /** @type {any} */ (second.stages).recheck;
    assert.ok(recheck.checked >= 2, JSON.stringify(recheck));
  });
  await t.test('the seed gems land in the gem lanes, harken in Rising only through its star gain', () => {
    const harken = lane.get('montezuma-p/harken');
    assert.ok(harken, 'harken is indexed');
    assert.equal(harken.band, 'gem');
    if (harken.lane === 'rising') assert.ok((harken.gain4w ?? 0) >= 10, String(harken.gain4w));
  });
});
