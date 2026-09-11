// @ts-check
/**
 * The run orchestrator (DESIGN §3, §3.8, §3.12) against stub sources and a fake GitHub: phases and
 * manifest, crash and resume, the lock, the exit codes 0, 75, 2 and 130, and the §3.8 budget shares.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfile } from '../src/config.mjs';
import { validateIndex, validateRunManifest } from '../src/core/schema.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import { runBatched as realRunBatched } from '../src/github/batch.mjs';
import { createClient } from '../src/github/client.mjs';
import { createBudget, createGovernor } from '../src/github/governor.mjs';
import { deepReserveMs, run, makeRunId } from '../src/pipeline/run.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';
import { LockError } from '../src/store/common.mjs';
import { createFakeFetch } from './support/fake-fetch.mjs';
import {
  fakeGitHub, fakeLib, recordingLog, referenceBudget, seedOf, testClock, testConfig,
} from './support/pipeline-fakes.mjs';

/** @typedef {import('./support/pipeline-fakes.mjs').FakeRepo} FakeRepo */

const DAY = '2026-09-08';
const SHARES = { census: 0.3, archive: 0.05, enrichUntil: 0.85 };

/** @returns {Error} what bin/unsung.mjs aborts the run's signal with on Ctrl-C */
const interrupt = () => Object.assign(new Error('Interrupted'), { name: 'InterruptError' });

/**
 * @param {number} n
 * @param {Record<string, any>} [over]
 * @returns {FakeRepo[]}
 */
function makeRepos(n, over = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `R_${String(i).padStart(3, '0')}`,
    nwo: `owner${i}/repo${i}`,
    S: i % 3 === 0 ? 8 : i % 3 === 1 ? 5 : 3,
    createdAt: `${DAY}T${String(i % 24).padStart(2, '0')}:00:00Z`,
    ...over,
  }));
}

/**
 * Census units of `size` repositories each, in the WP1 key format.
 * @param {FakeRepo[]} repos
 * @param {number} size
 * @param {number} [pages]
 */
function unitsOf(repos, size, pages = 1) {
  const units = [];
  for (let i = 0; i < repos.length; i += size) {
    const h = String(units.length).padStart(2, '0');
    units.push({
      key: `census:${DAY}:all:${DAY}T${h}:00:00Z..${DAY}T${h}:59:59Z`,
      seeds: repos.slice(i, i + size).map((r) => seedOf(r, `census:${DAY}`)),
      pages,
    });
  }
  return { [DAY]: units };
}

/**
 * @param {object} o
 * @param {FakeRepo[]} o.repos
 * @param {any} [o.units]
 * @param {any} [o.hours]
 * @param {Record<string, any>} [o.flags] run flags for resolveProfile
 * @param {Record<string, any>} [o.clientOpts]
 * @param {any} [o.store]
 * @param {any} [o.clock]
 * @param {Record<string, any>} [o.ctx]
 */
function setup({ repos, units, hours, flags = {}, clientOpts = {}, store, clock, ctx = {} }) {
  const clk = clock ?? testClock('2026-09-11T12:00:00Z');
  const st = store ?? createMemoryStore({ now: clk.now });
  const config = testConfig();
  const lib = fakeLib({ units: units ?? unitsOf(repos, 4), hours: hours ?? {} });
  const client = fakeGitHub(repos, { clock: clk, ...clientOpts });
  const log = recordingLog();
  const opts = resolveProfile(/** @type {any} */ (config.defaults), 'quick', { budget: 'none', ...flags });
  return {
    clock: clk, store: st, config, lib, client, log, opts,
    ctx: {
      store: st, client, clock: clk, config, log, rand: mulberry32(7), argv: ['run'], deps: lib, ...ctx,
    },
  };
}

test('makeRunId has the §4.3 form', () => {
  assert.match(makeRunId('2026-09-11T12:34:56.789Z', () => 0.5), /^20260911T123456Z-8000$/);
});

test('a run goes census → archive → enrich → deep → index and records a valid manifest', async () => {
  const repos = makeRepos(10);
  const archiveRepo = { id: 'R_arch', nwo: 'old/released', S: 9, createdAt: '2025-01-01T00:00:00Z' };
  const t = setup({
    repos: [...repos, archiveRepo],
    units: unitsOf(repos, 4),
    hours: { '2026-09-11-10': [seedOf(archiveRepo, 'archive:2026-09-11-10:Release')] },
  });
  const manifest = await run(t.opts, t.ctx);
  const st = /** @type {any} */ (manifest.stages);
  assert.deepEqual(validateRunManifest(manifest), []);
  assert.deepEqual(manifest.exit, { code: 0, reason: 'finished', resumeAt: null });
  assert.equal(st.census.units, 3);
  assert.equal(st.census.seeds, 10);
  assert.equal(st.census.pages, 3);
  assert.deepEqual(st.archive.hours, ['2026-09-11-10', '2026-09-11-9', '2026-09-11-8']);
  assert.equal(st.archive.seeds, 1);
  assert.equal(st.prefilter.in, 11);
  assert.equal(st.prefilter.queued, 11);
  assert.equal(st.enrich.repos, 11);
  assert.equal(st.deep.repos, 8, 'gem and look repositories are deepened');
  assert.equal(st.score.gem + st.score.look + st.score.low, 11);
  assert.equal(/** @type {any} */ (manifest.rate).graphql.points, t.client.calls.length);

  const index = await t.store.readIndex();
  assert.ok(index);
  assert.deepEqual(validateIndex(index), []);
  assert.equal(index?.lastRun?.runId, manifest.runId);
  assert.equal(index?.entries.length, 8, 'low repositories keep only their candidate result');
  assert.equal((await t.store.lastRuns(1))[0].runId, manifest.runId);
  assert.equal(await t.store.lockInfo(), null, 'the lock is released');
  const archiveDone = t.store.ledger.list({ state: 'done', stage: 'archive' }).map((u) => u.key);
  assert.deepEqual(archiveDone, ['archive:2026-09-11-10', 'archive:2026-09-11-8', 'archive:2026-09-11-9']);
  const stages = t.log.lines.filter((l) => l.level === 'stage').map((l) => l.msg);
  assert.deepEqual(stages, ['census', 'archive', 'prefilter', 'recheck', 'enrich', 'deep', 'score', 'index']);
});

test('a run cut short by an exception, then re-run, completes every unit once, no duplicates', async () => {
  const repos = makeRepos(12);
  const store = createMemoryStore({ now: testClock().now });
  /** @type {Map<string, number>} */
  const doneCount = new Map();
  const realDone = store.ledger.done;
  store.ledger.done = (key, out) => {
    doneCount.set(key, (doneCount.get(key) ?? 0) + 1);
    return realDone(key, out);
  };
  const units = unitsOf(repos, 4, 2);
  const flags = { 'no-archive': true };

  // Call 5 is the first page of the third unit: units one and two are stored, the third is not.
  const first = setup({ repos, units, store, clientOpts: { failAfter: 4 }, flags });
  await assert.rejects(run(first.opts, first.ctx), /simulated crash on call 5/);
  const crashed = (await store.lastRuns(1))[0];
  assert.equal(crashed.exit?.code, 1);
  assert.equal(crashed.exit?.reason, 'error');
  assert.equal(await store.lockInfo(), null, 'the lock is released after a crash');
  assert.deepEqual([...doneCount.values()], [1, 1]);
  assert.equal(store.ledger.list({ state: 'running' }).length, 0, 'the unfinished unit is back to planned');
  assert.equal(store.ledger.list({ state: 'planned' }).length, 1);

  const second = setup({ repos, units, store, flags });
  const manifest = await run(second.opts, second.ctx);
  assert.equal(manifest.exit?.code, 0);
  const searches = second.client.calls.filter((c) => c.kind === 'search');
  assert.equal(searches.length, 2, 'only the third unit is fetched again');
  assert.equal(doneCount.size, 3);
  assert.deepEqual([...doneCount.values()], [1, 1, 1], 'every unit is completed exactly once');
  const lines = await store.rawCandidateLines();
  const full = lines.filter((l) => l.patch !== true).map((l) => l.id);
  assert.equal(full.length, 12);
  assert.equal(new Set(full).size, 12, 'no duplicate candidate lines');
});

test('a live lock blocks a second run (exit 2)', async () => {
  const t = setup({ repos: makeRepos(2) });
  await t.store.lock('someone-else');
  await assert.rejects(run(t.opts, t.ctx), (e) => e instanceof LockError && e.exitCode === 2);
  assert.equal(t.client.calls.length, 0);
  assert.equal((await t.store.lockInfo())?.runId, 'someone-else');
});

test('a rate-limit pause with --no-wait ends the run with exit 75 and resumeAt', async () => {
  const t = setup({
    repos: makeRepos(8), flags: { 'no-wait': true, 'no-archive': true },
    clientOpts: { pauseOn: { call: 2, resumeAt: '2026-09-11T12:20:00Z' } },
  });
  const manifest = await run(t.opts, t.ctx);
  assert.deepEqual(manifest.exit, { code: 75, reason: 'paused', resumeAt: '2026-09-11T12:20:00.000Z' });
  assert.equal(/** @type {any} */ (manifest.rate).pauses.length, 1);
  assert.equal(await t.store.lockInfo(), null);
  assert.ok(await t.store.readIndex(), 'the index is still written for what was found');
  assert.equal(t.store.ledger.list({ state: 'running' }).length, 0);
});

test('a pause inside the budget is waited out and the run finishes', async () => {
  const t = setup({
    repos: makeRepos(8), flags: { budget: '10m', 'no-archive': true },
    clientOpts: { pauseOn: { call: 2, resumeAt: '2026-09-11T12:02:00Z' } },
  });
  const manifest = await run(t.opts, t.ctx);
  assert.equal(manifest.exit?.code, 0);
  assert.equal(/** @type {any} */ (manifest.stages).census.units, 2);
  assert.ok(Date.parse(t.clock.now()) >= Date.parse('2026-09-11T12:02:00Z'), 'the fake clock waited');
});

test('a pause past the wall budget, or the governor\'s PauseError, ends with 75', async () => {
  const late = setup({
    repos: makeRepos(8), flags: { budget: '10m', 'no-archive': true },
    clientOpts: { pauseOn: { call: 2, resumeAt: '2026-09-11T13:00:00Z' } },
  });
  assert.equal((await run(late.opts, late.ctx)).exit?.code, 75);

  const pauseError = Object.assign(new Error('breaker'), {
    name: 'PauseError', code: 'EPAUSED', exitCode: 75, resource: 'graphql', why: 'breaker',
    resumeAt: '2026-09-11T12:15:00.000Z',
  });
  /** @type {any[]} */
  const configured = [];
  const governor = {
    configure: (/** @type {any} */ p) => configured.push(p),
    snapshot: () => ({ pauses: [] }),
  };
  const t = setup({
    repos: makeRepos(8), flags: { budget: '10m', 'no-archive': true },
    clientOpts: { errorOn: { call: 1, error: pauseError } }, ctx: { governor },
  });
  const manifest = await run(t.opts, t.ctx);
  assert.deepEqual(manifest.exit, { code: 75, reason: 'paused', resumeAt: '2026-09-11T12:15:00.000Z' });
  assert.deepEqual(configured, [{ wait: true, deadlineMs: Date.parse('2026-09-11T12:10:00Z') }]);
});

test('Ctrl-C finishes the request in flight, writes the manifest, releases the lock: 130', async () => {
  const ac = new AbortController();
  const repos = makeRepos(12);
  const t = setup({
    repos, units: unitsOf(repos, 4, 2), flags: { 'no-archive': true },
    clientOpts: { onCall: (/** @type {number} */ n) => { if (n === 3) ac.abort(interrupt()); } },
    ctx: { signal: ac.signal },
  });
  const manifest = await run(t.opts, t.ctx);
  assert.deepEqual(manifest.exit, { code: 130, reason: 'interrupted', resumeAt: null });
  assert.equal(t.client.calls.length, 4, 'the unit in flight finished its requests');
  assert.equal(await t.store.lockInfo(), null);
  assert.equal((await t.store.lastRuns(1))[0].exit?.code, 130);
  assert.equal(t.store.ledger.list({ state: 'done' }).length, 2);
  assert.equal(t.store.ledger.list({ state: 'running' }).length, 0);
  assert.equal(await t.store.readIndex(), null, 'an interrupted run does not rebuild the index');
});

test('an interrupted wait for a pause also ends with 130', async () => {
  const ac = new AbortController();
  const t = setup({
    repos: makeRepos(8), flags: { budget: '10m', 'no-archive': true },
    clientOpts: {
      pauseOn: { call: 2, resumeAt: '2026-09-11T12:05:00Z' },
      onCall: (/** @type {number} */ n) => { if (n === 2) setImmediate(() => ac.abort(interrupt())); },
    },
    ctx: { signal: ac.signal },
  });
  /**
   * A sleep that only an abort ends.
   * @param {number} _ms
   * @param {any} o
   */
  const sleep = (_ms, o) => new Promise((_resolve, reject) => {
    o?.signal?.addEventListener('abort', () => reject(o.signal.reason), { once: true });
  });
  t.ctx.clock = { ...t.clock, sleep };
  const manifest = await run(t.opts, t.ctx);
  assert.equal(manifest.exit?.code, 130);
  assert.equal(await t.store.lockInfo(), null);
});

test('§3.8 budget shares: census 30 %, archive to 35 %, enrich to 85 %, deep the rest', async () => {
  const repos = makeRepos(300, { S: 8 });
  const old = { S: 8, createdAt: '2025-01-01T00:00:00Z' };
  const archiveRepos = makeRepos(20, old).map((r, i) => ({ ...r, id: `A_${i}`, nwo: `arch${i}/r` }));
  /** @type {Record<string, any[]>} */
  const hours = {};
  ['10', '9', '8'].forEach((h, i) => {
    hours[`2026-09-11-${h}`] = archiveRepos.slice(i * 6, i * 6 + 6)
      .map((r) => seedOf(r, `archive:2026-09-11-${h}:Release`));
  });
  const budget = referenceBudget({ wallMs: null, graphqlMs: 40_000, shares: SHARES });
  const t = setup({
    repos: [...repos, ...archiveRepos], units: unitsOf(repos, 20), hours, clientOpts: { ms: 1000 },
    ctx: { budget }, flags: { deep: 400 },
  });
  const manifest = await run(t.opts, t.ctx);
  const st = /** @type {any} */ (manifest.stages);
  assert.equal(manifest.exit?.code, 0);
  const s = budget.spent;
  assert.equal(s.census, 12_000, 'census stops at 30 % (12 of 15 windows)');
  assert.equal(st.census.units, 12);
  assert.equal(s.census + s.archive, 14_000, 'archive stops at 35 % (2 of 3 hours)');
  assert.deepEqual(st.archive.hours, ['2026-09-11-10', '2026-09-11-9']);
  const beforeDeep = s.census + s.archive + (s.recheck ?? 0) + s.enrich;
  assert.ok(beforeDeep >= 34_000 && beforeDeep <= 35_000, `enrich runs until 85 % (${beforeDeep})`);
  assert.ok(s.deep > 0 && beforeDeep + s.deep <= 43_000, `deep takes the rest (${s.deep})`);
  assert.equal(st.enrich.calls * 1000, s.enrich);
  const serverMs = /** @type {any} */ (manifest.rate).graphql.serverMs;
  assert.equal(serverMs, s.census + s.archive + s.enrich + s.deep + (s.recheck ?? 0));
});

test('--until caught-up lets discovery ignore the budget', async () => {
  const repos = makeRepos(40, { S: 8 });
  const budget = referenceBudget({ wallMs: null, graphqlMs: 10_000, shares: SHARES });
  const t = setup({
    repos, clientOpts: { ms: 1000 }, ctx: { budget }, flags: { until: 'caught-up', 'no-archive': true },
  });
  const manifest = await run(t.opts, t.ctx);
  const st = /** @type {any} */ (manifest.stages);
  assert.equal(st.census.units, 10, 'every planned unit is done');
  assert.equal(st.enrich.repos, 0, 'nothing left for enrich');
});

test('--dry-run plans units and the budget without the lock or any GitHub call', async () => {
  const t = setup({ repos: makeRepos(4), flags: { 'dry-run': true, budget: '10m' } });
  const key = 'census:2026-09-08:all:2026-09-08T00:00:00Z..2026-09-08T00:59:59Z';
  t.store.ledger.start(key, 'census', 'old');
  t.store.ledger.done(key, {});
  const manifest = await run(t.opts, t.ctx);
  const plan = /** @type {any} */ (manifest.stages.plan);
  assert.equal(manifest.exit?.reason, 'dry-run');
  assert.equal(t.client.calls.length, 0);
  assert.deepEqual(plan.days, [{ day: '2026-09-08', done: 1, known: 1 }]);
  assert.equal(plan.hours.length, 3);
  assert.equal(await t.store.readIndex(), null);
  assert.equal((await t.store.lastRuns(5)).length, 0);
  const line = t.log.lines.find((l) => l.msg === 'budget');
  assert.match(line?.fields.text, /^10m 00s wall · GraphQL 7m 30s: census ≤ 30 %/);
});

test('queued candidates past their TTL expire; the daily profile compacts first', async () => {
  const clock = testClock('2026-09-11T12:00:00Z');
  const store = createMemoryStore({ now: clock.now });
  const old = seedOf({ id: 'OLD', nwo: 'o/old' });
  await store.putCandidates([{
    v: 1, id: 'OLD', nwo: 'o/old', day: '2026-08-20', createdAt: old.createdAt, pushedAt: null, stars: 0,
    forks: 0, diskKB: 800, lang: 'Rust', licence: 'MIT', hasDesc: true, ownerType: 'User',
    sources: ['census:2026-08-20'], seenAt: '2026-08-20T00:00:00Z', prior: 5, explore: false,
    state: 'queued', reason: null, nextAt: null, result: null,
  }]);
  let compacted = 0;
  const realCompact = store.compact;
  store.compact = async (/** @type {any} */ o) => {
    compacted++;
    return realCompact(o);
  };
  const t = setup({ repos: makeRepos(2), store, clock });
  const opts = resolveProfile(/** @type {any} */ (t.config.defaults), 'daily', { 'no-archive': true });
  await run(opts, t.ctx);
  assert.equal(compacted, 1);
  const c = await store.getCandidate('OLD');
  assert.equal(c?.state, 'expired');
  assert.equal(c?.reason, 'queue-ttl');
});

test('exploration fills one slot in every 20 with a prior ≤ 1 candidate and marks it', async () => {
  const repos = makeRepos(40, { S: 8 });
  // Half the seeds have prior 1 (a language only): no licence, no description, under 1 MB.
  const seeds = repos.map((r, i) => {
    const seed = seedOf(r, `census:${DAY}`);
    return i % 2 ? { ...seed, licence: null, hasDesc: false, description: null } : seed;
  });
  const units = { [DAY]: [{ key: `census:${DAY}:all:${DAY}T00:00:00Z..${DAY}T23:59:59Z`, seeds }] };
  const t = setup({ repos, units, flags: { 'no-archive': true } });
  const manifest = await run(t.opts, t.ctx);
  const st = /** @type {any} */ (manifest.stages);
  assert.equal(st.enrich.repos, 40);
  assert.equal(st.enrich.explore, 2);
  const explored = (await t.store.listCandidates()).filter((c) => c.explore);
  assert.equal(explored.length, 2);
  for (const c of explored) assert.equal(c.prior, 1);
});

/**
 * A test budget that counts the calls charged to each phase; `deny(phase, calls)` says when a phase
 * must stop.
 * @param {(phase: string, calls: Record<string, number>) => boolean} deny
 */
function scriptedBudget(deny) {
  /** @type {Record<string, number>} */
  const calls = {};
  return {
    calls,
    allows: (/** @type {string} */ phase) => !deny(phase, calls),
    spend: (/** @type {string} */ phase) => {
      calls[phase] = (calls[phase] ?? 0) + 1;
    },
    exhausted: () => false,
    snapshot: () => ({ ...calls }),
  };
}

/**
 * A fake GitHub paced like the governor: each GraphQL call charges its response time and moves the
 * clock by that time ÷ `ratio` (the live quick run got 390 s of GraphQL out of 600 s, 0.65).
 * @param {any} inner a `fakeGitHub` without a clock
 * @param {{advance: (ms: number) => unknown}} clock
 * @param {number} ratio
 */
function governed(inner, clock, ratio) {
  /** @param {string} doc */
  const cost = (doc) => (doc.startsWith('query search') ? 5000 : doc.startsWith('query Enrich') ? 4800
    : doc.startsWith('query exists') ? 500 : 1500);
  return {
    calls: inner.calls,
    /**
     * @param {string} doc
     * @param {any} variables
     * @param {any} o
     */
    async graphql(doc, variables, o) {
      const res = await inner.graphql(doc, variables, o);
      const ms = cost(doc);
      clock.advance(Math.round(ms / ratio));
      return { ...res, ms };
    },
    /**
     * @param {string} path
     * @param {any} o
     */
    async rest(path, o) {
      const res = await inner.rest(path, o);
      clock.advance(400);
      return res;
    },
  };
}

test('archive keeps its own 5 % when census overshoots its 30 % (real budget, live-shaped leaves)', async () => {
  const repos = makeRepos(40);
  // Leaves of 8, 8, 9 and 9 pages at 5 s: census stops after the fourth, at 170 s of 450 s (38 %).
  const units = {
    [DAY]: [8, 8, 9, 9].map((pages, i) => ({
      key: `census:${DAY}:all:${DAY}T0${i}:00:00Z..${DAY}T0${i}:59:59Z`,
      seeds: repos.slice(i * 10, i * 10 + 10).map((r) => seedOf(r, `census:${DAY}`)),
      pages,
    })),
  };
  const arch = { id: 'R_arch', nwo: 'old/released', S: 9, createdAt: '2025-01-01T00:00:00Z' };
  const t = setup({
    repos: [...repos, arch], units, hours: { '2026-09-11-10': [seedOf(arch, 'archive:2026-09-11-10:Release')] },
    clientOpts: { ms: 5000 }, flags: { budget: '10m', 'enrich-max': 12, deep: 0 },
  });
  t.ctx.budget = createBudget(t.opts.budget, { clock: t.clock });
  const manifest = await run(t.opts, t.ctx);
  const st = /** @type {any} */ (manifest.stages);
  assert.equal(st.census.units, 4);
  assert.equal(st.census.pages, 34);
  assert.deepEqual(st.archive.hours, ['2026-09-11-10', '2026-09-11-9', '2026-09-11-8']);
  assert.equal(st.archive.seeds, 1);
  assert.equal(t.store.ledger.list({ state: 'done', stage: 'archive' }).length, 3);
  const line = t.log.lines.find((l) => l.level === 'stage' && l.msg === 'archive');
  assert.match(line?.fields.text, /^2026-09-11-10, 2026-09-11-9, 2026-09-11-8 · /);
});

test('a budgeted run starts no archive hour without the wall clock to finish it before deep', async () => {
  const repos = makeRepos(30);
  const arch = { id: 'R_arch', nwo: 'old/released', S: 9, createdAt: '2025-01-01T00:00:00Z' };
  // 3 minutes (the live check): deep keeps 36 s, and census (two leaves of 8 pages at 5 s) ends at
  // 80 s, leaving 64 s — too little for an archive hour, which took 2m 04s live and overran the wall.
  const t = setup({
    repos: [...repos, arch], units: unitsOf(repos, 10, 8),
    hours: { '2026-09-11-10': [seedOf(arch, 'archive:2026-09-11-10:Release')] }, flags: { budget: '3m' },
  });
  t.ctx.client = governed(fakeGitHub([...repos, arch]), t.clock, 1);
  t.ctx.budget = createBudget(t.opts.budget, { clock: t.clock });
  const start = t.clock.ms();
  const manifest = await run(t.opts, t.ctx);
  const st = /** @type {any} */ (manifest.stages);
  assert.equal(st.census.units, 2);
  assert.deepEqual(st.archive.hours, []);
  assert.equal(st.archive.skipped, 'time');
  const line = t.log.lines.find((l) => l.level === 'stage' && l.msg === 'archive');
  assert.equal(line?.fields.text, 'skipped: 1m 04s of the wall clock left before deep; an hour takes about 2m 00s');
  assert.equal(st.enrich.repos, 20, 'the census seeds are enriched');
  assert.ok(st.deep.repos > 0, 'and deep still runs');
  assert.ok(t.clock.ms() - start <= 180_000, `inside the wall budget (${t.clock.ms() - start} ms)`);
  assert.equal(t.store.ledger.get('archive:2026-09-11-10'), null, 'the hour is left for a later run');
});

test('an archive lane the budget denies says why instead of "no new hours"', async () => {
  const t = setup({
    repos: makeRepos(4), clientOpts: { ms: 1000 }, flags: { budget: '10m', deep: 0 },
    ctx: { budget: scriptedBudget((phase) => phase === 'archive') },
  });
  const manifest = await run(t.opts, t.ctx);
  assert.equal(/** @type {any} */ (manifest.stages).archive.skipped, 'budget');
  const line = t.log.lines.find((l) => l.level === 'stage' && l.msg === 'archive');
  assert.equal(line?.fields.text, 'skipped: census used 0m 01s of the 7m 30s GraphQL budget');
});

test('an archive hour whose seeds were stored is done even when the budget stops the lane after it', async () => {
  const arch = { id: 'R_arch', nwo: 'old/released', S: 9, createdAt: '2025-01-01T00:00:00Z' };
  const repos = makeRepos(4);
  const hours = { '2026-09-11-10': [seedOf(arch, 'archive:2026-09-11-10:Release')] };
  const store = createMemoryStore({ now: testClock().now });
  /** @type {number[]} */
  const lookups = [];
  for (const pass of [1, 2]) {
    const budget = scriptedBudget((phase, calls) => phase === 'archive' && (calls.archive ?? 0) > 0);
    const t = setup({
      repos: [...repos, arch], units: unitsOf(repos, 4), hours, store, ctx: { budget }, flags: { deep: 0 },
    });
    const manifest = await run(t.opts, t.ctx);
    lookups.push(t.client.calls.filter((c) => c.doc.startsWith('query Lean')).length);
    if (pass === 1) {
      assert.deepEqual(/** @type {any} */ (manifest.stages).archive.hours, ['2026-09-11-10']);
      assert.equal(store.ledger.get('archive:2026-09-11-10')?.state, 'done');
      assert.deepEqual((await store.getCandidate('R_arch'))?.sources, ['archive:2026-09-11-10:Release']);
    }
  }
  assert.deepEqual(lookups, [1, 0], 'the hour is not downloaded and looked up again');
});

test('a quick run keeps the end of its wall clock for deep: the top 50 are deepened (governor pace)', async () => {
  assert.equal(deepReserveMs(600_000, 50), 100_000);
  assert.equal(deepReserveMs(100_000, 50), 20_000);
  assert.equal(deepReserveMs(null, 400), 0);
  assert.equal(deepReserveMs(600_000, 0), 0);
  const repos = makeRepos(1000);
  const clock = testClock('2026-09-11T12:00:00Z');
  const t = setup({ repos, units: unitsOf(repos, 500, 5), clock, flags: { budget: '10m', 'no-archive': true } });
  t.ctx.client = governed(fakeGitHub(repos), clock, 0.65);
  t.ctx.budget = createBudget(t.opts.budget, { clock });
  const start = clock.ms();
  const manifest = await run(t.opts, t.ctx);
  const st = /** @type {any} */ (manifest.stages);
  assert.ok(st.enrich.repos >= 400, `enrich still does most of the work (${st.enrich.repos} repos)`);
  assert.ok(st.deep.repos >= 40, `deep reached ${st.deep.repos} of the top 50`);
  const took = clock.ms() - start;
  assert.ok(took <= 600_000 + 8_000, `the run ends inside its wall budget, give or take a call (${took} ms)`);
});

test('deep stops only between chunks: a chunk whose queries were answered is finished', async () => {
  const t = setup({
    repos: makeRepos(12, { S: 8 }), flags: { 'no-archive': true },
    ctx: { budget: scriptedBudget((phase, calls) => phase === 'deep' && (calls.deep ?? 0) > 0) },
  });
  const manifest = await run(t.opts, t.ctx);
  assert.equal(/** @type {any} */ (manifest.stages).deep.repos, 5, 'the first chunk of five, whole');
  const line = t.log.lines.find((l) => l.level === 'stage' && l.msg === 'deep');
  assert.match(line?.fields.text, /^deepened 5 of top 12 · /, 'the stage line says how many were deepened');
});

test('each run starts its census day at a seeded hour, so short runs do not all take 00–01 UTC', async () => {
  const days = ['2026-09-08', '2026-09-09'];
  const repos = makeRepos(48);
  /** @type {Record<string, any[]>} */
  const units = {};
  days.forEach((day, d) => {
    units[day] = Array.from({ length: 24 }, (_, h) => {
      const hh = String(h).padStart(2, '0');
      return {
        key: `census:${day}:all:${day}T${hh}:00:00Z..${day}T${hh}:59:59Z`,
        seeds: [seedOf(repos[d * 24 + h], `census:${day}`)], pages: 1,
      };
    });
  });
  const clock = testClock('2026-09-11T12:00:00Z');
  const store = createMemoryStore({ now: clock.now });
  /** @type {number[]} */
  const starts = [];
  /** @type {string[][]} */
  const censused = [];
  for (const [i, seed] of [7, 8].entries()) {
    if (i === 1) clock.set('2026-09-12T12:00:00Z');
    const budget = scriptedBudget((phase, calls) => phase === 'census' && (calls.census ?? 0) >= 2);
    const t = setup({
      repos, units, clock, store, ctx: { budget, rand: mulberry32(seed) },
      flags: { 'no-archive': true, deep: 0, 'enrich-max': 0 },
    });
    // WP1's censusDay walks the hours from startHour round; the stub does the same with its units.
    t.lib.censusDay = (/** @type {any} */ o) => {
      starts.push(o.startHour);
      const list = units[o.day];
      const rotated = [...list.slice(o.startHour), ...list.slice(0, o.startHour)];
      return fakeLib({ units: { [o.day]: rotated } }).censusDay(o);
    };
    await run(t.opts, t.ctx);
    censused.push(store.ledger.list({ state: 'done', stage: 'census' })
      .filter((u) => u.key.startsWith(`census:${days[i]}:`))
      .map((u) => /T(\d\d):00:00Z\.\./.exec(u.key)?.[1] ?? '?')
      .sort());
  }
  assert.equal(starts.length, 2);
  starts.forEach((s, i) => {
    assert.ok(Number.isInteger(s) && s >= 0 && s < 24, `start hour ${s}`);
    const want = [s, (s + 1) % 24].map((h) => String(h).padStart(2, '0')).sort();
    assert.deepEqual(censused[i], want, `run ${i + 1} censused the two hours from its start hour`);
  });
  assert.notDeepEqual(censused, [['00', '01'], ['00', '01']]);
});

test('Ctrl-C during a rate-limit pause in enrich ends the wait at once (real client, governor, batches)', async () => {
  const repos = makeRepos(6, { S: 8 });
  const inner = fakeGitHub(repos);
  const ac = new AbortController();
  const base = testClock('2026-09-11T12:00:00Z');
  /** @type {{ms: number, outcome: string}[]} */
  const waits = [];
  // A pause-length wait ends through its signal; one given no signal completes after 200 real ms, as
  // the governor's sleep did when enrich did not pass the run's signal on.
  const clock = {
    now: base.now,
    ms: base.ms,
    sleep: (/** @type {number} */ ms, /** @type {{signal?: AbortSignal}} */ o = {}) => {
      if (ms < 10_000) return base.sleep(ms, o);
      const w = { ms, outcome: 'waiting' };
      waits.push(w);
      setImmediate(() => ac.abort(interrupt()));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          w.outcome = 'completed';
          base.advance(ms);
          resolve(undefined);
        }, 200);
        o.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          w.outcome = 'rejected';
          reject(o.signal?.reason);
        }, { once: true });
      });
    },
  };
  let limited = false;
  const fetch = createFakeFetch([{
    method: 'POST',
    respond: async (call) => {
      const q = String(call.query);
      if (!limited && q.startsWith('query Enrich')) {
        limited = true;
        return { status: 403, headers: { 'retry-after': '60' }, body: { message: 'secondary rate limit' } };
      }
      const answer = await inner.graphql(q, call.variables, {});
      return { status: 200, body: { data: answer.data } };
    },
  }]);
  let callsAtAbort = -1;
  ac.signal.addEventListener('abort', () => {
    callsAtAbort = fetch.calls.length;
  }, { once: true });
  const governor = createGovernor(testConfig().defaults.governor, { clock });
  const client = createClient({ token: 'offline-pipeline-test-token-7', governor, fetch, clock });
  const t = setup({
    repos, clock: base, flags: { 'no-archive': true, deep: 0 },
    ctx: { client, governor, clock, signal: ac.signal },
  });
  t.lib.runBatched = realRunBatched;
  const manifest = await run(t.opts, t.ctx);
  assert.deepEqual(manifest.exit, { code: 130, reason: 'interrupted', resumeAt: null });
  assert.deepEqual(waits.map((w) => w.outcome), ['rejected'], 'the pause was cut short, not slept through');
  assert.ok(callsAtAbort > 0);
  assert.equal(fetch.calls.length, callsAtAbort, 'no GitHub request after Ctrl-C');
  assert.equal(await t.store.lockInfo(), null);
});
