// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choosePaths, deepen, emptyDeepStats, needsDeep, pool, selectDeep } from '../src/pipeline/deep.mjs';
import { applyScore } from '../src/pipeline/indexer.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';
import { fakeGitHub, fakeLib, nodeOf, testConfig } from './support/pipeline-fakes.mjs';

const NOW = '2026-09-11T12:00:00.000Z';
const config = testConfig();
const lib = fakeLib();

/**
 * A scored record (enrich stage only) for a fake repository.
 * @param {import('./support/pipeline-fakes.mjs').FakeRepo} repo
 */
function record(repo) {
  const facts = lib.factsFromEnrich(nodeOf(repo), { fetchedAt: NOW });
  return applyScore(/** @type {any} */ ({
    v: 1, id: repo.id, nwo: repo.nwo, candidate: null, facts, score: null, firstSeen: null, history: [],
    verdict: null, checkedAt: NOW, gone: false,
  }), config, { now: NOW, deps: lib });
}

/**
 * @param {AsyncIterable<any>} gen
 * @returns {Promise<any[]>}
 */
async function drain(gen) {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
}

test('needsDeep: missing deep facts, or deep facts of an older head', () => {
  const rec = record({ id: 'A', nwo: 'o/a' });
  assert.equal(needsDeep(rec), true);
  const deepFacts = { ...rec.facts, stages: ['enrich', 'deep'], deepHeadOid: rec.facts.headOid };
  const deep = { ...rec, facts: deepFacts };
  assert.equal(needsDeep(deep), false);
  assert.equal(needsDeep({ ...deep, facts: { ...deep.facts, deepHeadOid: 'older' } }), true);
  const headless = { facts: { ...rec.facts, headOid: null } };
  assert.equal(needsDeep(headless), false, 'nothing to deepen without a head');
});

test('selectDeep takes the highest-gem repositories in the deep lanes that need deep facts', () => {
  /**
   * @param {string} id
   * @param {string} action
   */
  const gate = (id, action) => [{ id, action, reason: 'x' }];
  const recs = [
    record({ id: 'A', nwo: 'o/a', S: 8 }),
    record({ id: 'B', nwo: 'o/b', S: 10 }),
    record({ id: 'C', nwo: 'o/c', S: 3 }),
    record({ id: 'D', nwo: 'o/d', S: 9, gates: gate('g.lure.link', 'quarantine') }),
    record({ id: 'E', nwo: 'o/e', S: 6 }),
    record({ id: 'F', nwo: 'o/f', S: 9, gates: gate('g.injection', 'doubt') }),
    record({ id: 'G', nwo: 'o/g', S: 9, stars: 30 }),
  ];
  const done = record({ id: 'H', nwo: 'o/h', S: 11 });
  const deepFacts = { ...done.facts, stages: ['enrich', 'deep'], deepHeadOid: done.facts.headOid };
  done.facts = /** @type {any} */ (deepFacts);
  const picked = selectDeep([...recs, done], 10).map((r) => r.nwo);
  assert.deepEqual(picked, ['o/b', 'o/f', 'o/a', 'o/e']);
  assert.deepEqual(selectDeep(recs, 2).map((r) => r.nwo), ['o/b', 'o/f']);
  assert.deepEqual(selectDeep(recs, 0), []);
});

test('choosePaths: three workflows, test-like first, then the first root manifest but package.json', () => {
  const facts = /** @type {any} */ ({
    workflows: [
      { name: 'release.yml' }, { name: 'docs.yaml' }, { name: 'ci.yml' }, { name: 'lint-check.yml' },
      { name: 'notes.txt' },
    ],
    root: [
      { name: 'package.json', type: 'blob' }, { name: 'go.mod', type: 'blob' },
      { name: 'Cargo.toml', type: 'blob' },
    ],
  });
  assert.deepEqual(choosePaths(facts, lib), [
    '.github/workflows/ci.yml', '.github/workflows/lint-check.yml', '.github/workflows/release.yml', 'go.mod',
  ]);
  const bare = /** @type {any} */ ({ workflows: null, root: [{ name: 'package.json', type: 'blob' }] });
  assert.deepEqual(choosePaths(bare, lib), []);
});

test('deepen merges tree, activity, star history and files, rescores and stores the record', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const repos = [
    { id: 'A', nwo: 'o/a', S: 7, stars: 5, gain4w: 2, workflows: ['ci.yml'] },
    { id: 'B', nwo: 'o/b', S: 8, stars: 0 },
  ];
  const recs = repos.map(record);
  for (const r of recs) await store.putRepo(r);
  await store.putCandidates([{
    v: 1, id: 'A', nwo: 'o/a', day: '2026-09-08', createdAt: NOW, pushedAt: NOW, stars: 5, forks: 0,
    diskKB: 800, lang: 'Rust', licence: 'MIT', hasDesc: true, ownerType: 'User',
    sources: ['census:2026-09-08'], seenAt: NOW, prior: 3, explore: false, state: 'enriched', reason: null,
    nextAt: null, result: null,
  }]);
  const client = fakeGitHub(repos);
  const stats = emptyDeepStats();
  const out = await drain(deepen(recs, { client, store, config, lib, now: () => NOW, stats }));
  assert.equal(out.length, 2);
  assert.equal(stats.repos, 2);
  const a = await store.getRepo('o/a');
  assert.deepEqual(a?.facts.stages, ['enrich', 'deep']);
  assert.equal(a?.score?.S, 8, 'rescored after deep');
  const text = (/** @type {string} */ p) => ({ byteSize: 10, text: `text of ${p}` });
  assert.deepEqual(/** @type {any} */ (a?.facts).deepSeen, {
    node: true, tree: true, activity: true, stars: true,
    files: { '.github/workflows/ci.yml': text('.github/workflows/ci.yml'), 'Cargo.toml': text('Cargo.toml') },
  });
  const b = /** @type {any} */ (await store.getRepo('o/b'));
  assert.equal(b?.facts.deepSeen.stars, false, 'no star history under 3 stars');
  assert.equal((await store.getCandidate('A'))?.result?.S, 8);
  assert.ok(client.restCalls.some((p) => p.startsWith('/repos/o/a/stargazers/history')));
  assert.ok(!client.restCalls.some((p) => p.startsWith('/repos/o/b/stargazers/history')));
  const deepQueries = client.calls.filter((c) => c.doc.startsWith('query Deep'));
  assert.equal(deepQueries.length, 1, 'five repositories per deep query');

  // Trees are cached by commit: a second pass reads no tree over REST.
  const again = fakeGitHub(repos);
  await drain(deepen(recs, { client: again, store, config, lib, now: () => NOW, stats }));
  assert.equal(again.restCalls.filter((p) => p.includes('/git/trees/')).length, 0);
  assert.equal(stats.treeCached, 2);
});

test('a failing REST read is counted and the repository is still rescored', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const repos = [{ id: 'A', nwo: 'o/a', S: 7 }];
  const error = Object.assign(new Error('HTTP 500'), { name: 'GitHubError', code: 'EGITHUB' });
  const broken = { ...lib, activity: async () => { throw error; } };
  const stats = emptyDeepStats();
  const env = { client: fakeGitHub(repos), store, config, lib: broken, now: () => NOW, stats };
  await drain(deepen(repos.map(record), env));
  assert.equal(stats.errors, 1);
  const a = /** @type {any} */ (await store.getRepo('o/a'));
  assert.equal(a?.facts.deepSeen.activity, false);
});

test('a rate-limit pause during deep ends the stage', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const repos = [{ id: 'A', nwo: 'o/a' }];
  const pause = Object.assign(new Error('paused'), {
    name: 'PauseError', code: 'EPAUSED', resumeAt: '2026-09-11T13:00:00Z',
  });
  const paused = { ...lib, recursiveTree: async () => { throw pause; } };
  const env = { client: fakeGitHub(repos), store, config, lib: paused, now: () => NOW };
  await assert.rejects(drain(deepen(repos.map(record), env)), (e) => e === pause);
});

test('deepen hands the run signal to every request and reads REST two at a time', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const repos = [
    { id: 'A', nwo: 'o/a', stars: 5 }, { id: 'B', nwo: 'o/b', stars: 5 }, { id: 'C', nwo: 'o/c', stars: 0 },
  ];
  const signal = new AbortController().signal;
  /** @type {[string, unknown][]} */
  const seen = [];
  let live = 0;
  let peak = 0;
  /**
   * A REST helper that records the signal it was given and takes a turn of the event loop.
   * @param {string} what
   * @param {(...a: any[]) => Promise<any>} fn
   */
  const rest = (what, fn) => async (/** @type {any[]} */ ...args) => {
    seen.push([what, args.at(-1)?.signal]);
    live++;
    peak = Math.max(peak, live);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return await fn(...args);
    } finally {
      live--;
    }
  };
  const spy = {
    ...lib,
    runBatched: (/** @type {any[]} */ items, /** @type {any} */ o) => {
      seen.push(['graphql', o.signal]);
      return lib.runBatched(items, o);
    },
    recursiveTree: rest('tree', lib.recursiveTree),
    activity: rest('activity', lib.activity),
    starHistory: rest('stars', lib.starHistory),
  };
  const env = { client: fakeGitHub(repos), store, config, lib: spy, now: () => NOW, signal };
  const out = await drain(deepen(repos.map(record), env));
  assert.deepEqual(out.map((r) => r.nwo), ['o/a', 'o/b', 'o/c'], 'records come out in order');
  assert.deepEqual(seen.map(([w]) => w).sort(),
    ['activity', 'activity', 'activity', 'graphql', 'graphql', 'stars', 'stars', 'tree', 'tree', 'tree']);
  assert.ok(seen.every(([, s]) => s === signal), 'every request carries the signal');
  assert.equal(peak, 2, 'two REST reads in flight, the governor\'s REST concurrency');
  const a = /** @type {any} */ (await store.getRepo('o/a'));
  assert.deepEqual([a.facts.deepSeen.tree, a.facts.deepSeen.activity, a.facts.deepSeen.stars], [true, true, true]);
});

test('pool keeps results in order and starts no task after a failure', async () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await pool([3, 1, 2].map((n) => async () => {
    await tick();
    return n * 10;
  }), 2), [30, 10, 20]);
  /** @type {number[]} */
  const started = [];
  const tasks = [0, 1, 2, 3, 4, 5].map((i) => async () => {
    started.push(i);
    await tick();
    if (i === 1) throw new Error('boom');
    return i;
  });
  await assert.rejects(pool(tasks, 2), /boom/);
  assert.ok(!started.includes(5), `started ${started.join(', ')}`);
  assert.deepEqual(await pool([], 2), []);
});
