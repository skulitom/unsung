// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseArgs } from '../src/cli/args.mjs';
import { command } from '../src/cli/review.mjs';
import { validateVerdict as validateVerdictRecord } from '../src/core/schema.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import { verdictKey } from '../src/core/verdict.mjs';
import {
  FIRST_CALL_ESTIMATE_USD, isEligible, isUncertain, packFilesQuery, reviewRepos, selectForReview,
  selectionPlan,
} from '../src/llm/review.mjs';
import { RUBRIC_VERSION } from '../src/llm/rubric.mjs';
import { parseCliOutput } from '../src/llm/validate.mjs';
import { filesQuery as referenceFilesQuery } from '../tools/lib/queries.mjs';
import { fixturePath, loadJsonFixture } from './support/fixtures.mjs';

const packFixture = loadJsonFixture('llm/pack-record.json');
// The judge's answers, read from the envelopes' .result text exactly as a claude-cli review reads them.
const goodOutput = parseCliOutput(loadJsonFixture('llm/cli-result.json').stdout);
const injectionOutput = parseCliOutput(loadJsonFixture('llm/injection.json').stdout);
const fabricatedOutput = parseCliOutput(loadJsonFixture('llm/fabricated-quote.json').stdout);
const DEFAULTS = JSON.parse(readFileSync(fixturePath('..', '..', 'config', 'defaults.json'), 'utf8'));
const NOW = '2026-09-11T12:00:00Z';

/**
 * A kept record built from the pack fixture, with its own identity.
 * @param {number} n
 * @param {Record<string, any>} [score]
 * @returns {any}
 */
function rec(n, score = {}) {
  const r = structuredClone(packFixture.record);
  r.id = `R_kgDOrev${String(n).padStart(3, '0')}`;
  r.nwo = `octo-sailor/tide-${n}`;
  r.facts.id = r.id;
  r.facts.nwo = r.nwo;
  r.facts.name = `tide-${n}`;
  r.facts.headOid = `head${n}`;
  r.score = { ...r.score, ...score };
  return r;
}

/**
 * An index entry for a record.
 * @param {any} r
 * @param {Record<string, any>} over
 * @returns {any}
 */
function entry(r, over) {
  return {
    id: r.id, nwo: r.nwo, headOid: r.facts.headOid, lane: 'promising', S: 8, k: 0.3, gem: 8.45, gates: [],
    ...over,
  };
}

/**
 * A memory store with the Store methods a review uses.
 * @param {{index?: any, records?: any[], files?: Record<string, any>}} [init]
 */
function memoryStore({ index = null, records = [], files = {} } = {}) {
  const repos = new Map(records.map((r) => [r.id, structuredClone(r)]));
  /** @type {any[]} */
  const verdicts = [];
  const fileCache = new Map(Object.entries(files));
  const calls = { putFiles: 0, putRepo: 0 };
  return {
    verdicts, repos, calls,
    async readIndex() {
      return index;
    },
    async writeIndex(/** @type {any} */ i) {
      index = i;
    },
    async getRepo(/** @type {string} */ nwo) {
      return [...repos.values()].find((r) => r.nwo === nwo) ?? null;
    },
    async getRepoById(/** @type {string} */ id) {
      return repos.get(id) ?? null;
    },
    async putRepo(/** @type {any} */ r) {
      calls.putRepo++;
      repos.set(r.id, r);
    },
    async appendVerdict(/** @type {any} */ v) {
      verdicts.push(v);
    },
    async getVerdict(/** @type {string} */ key) {
      for (let i = verdicts.length - 1; i >= 0; i--) if (verdictKey(verdicts[i]) === key) return verdicts[i];
      return null;
    },
    async getFiles(/** @type {string} */ id, /** @type {string} */ oid) {
      return fileCache.get(`${id}@${oid}`) ?? null;
    },
    async putFiles(/** @type {string} */ id, /** @type {string} */ oid, /** @type {any} */ f) {
      calls.putFiles++;
      fileCache.set(`${id}@${oid}`, f);
    },
  };
}

/** A fake GitHub client that serves the pack fixture's files. */
function fakeClient() {
  /** @type {any[]} */
  const calls = [];
  return {
    calls,
    async graphql(/** @type {string} */ doc, /** @type {Record<string, string>} */ variables) {
      calls.push({ doc, variables });
      /** @type {Record<string, any>} */
      const r0 = {};
      for (const [k, v] of Object.entries(variables)) {
        if (!k.startsWith('e0_')) continue;
        const p = v.slice(v.indexOf(':') + 1);
        const f = packFixture.files[p];
        r0[`f${k.slice(3)}`] = f ? { byteSize: f.byteSize, text: f.text } : null;
      }
      return { data: { r0 }, errors: null, rateLimit: null, ms: 5 };
    },
  };
}

/**
 * A fake backend answering from a script of RawResults (the last one repeats).
 * @param {any[]} script
 */
function fakeBackend(script) {
  /** @type {any[]} */
  const calls = [];
  return {
    name: /** @type {'claude-cli'} */ ('claude-cli'), model: 'claude-opus-5', calls,
    call: async (/** @type {any} */ pack) => {
      calls.push(pack);
      return structuredClone(script[Math.min(calls.length - 1, script.length - 1)]);
    },
  };
}
const ok = (output = goodOutput, costUsd = 0.1) => ({
  ok: true, output, costUsd, usage: { input: 12004, output: 2210 }, stopReason: 'end_turn',
});
const fail = (/** @type {string} */ kind, costUsd = 0) => ({
  ok: false, costUsd, usage: { input: 0, output: 0 }, stopReason: null,
  error: { kind, message: `${kind} failure` },
});

/**
 * @param {any} store
 * @param {any} backend
 * @param {Record<string, any>} [over]
 */
const run = (store, backend, over = {}) => reviewRepos({
  store, client: fakeClient(), config: { defaults: DEFAULTS }, backend, now: () => NOW, rand: mulberry32(1),
  packRand: mulberry32(2), ...over,
});

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

test('selection: the uncertain band first by gem, then the rest, plus audit picks from look', () => {
  const e = (/** @type {string} */ id, /** @type {Record<string, any>} */ o) => ({
    id, nwo: `o/${id}`, gates: [], ...o,
  });
  const index = { entries: [
    e('A', { lane: 'promising', S: 8, k: 0.3, gem: 8.45 }),
    e('B', { lane: 'proven', S: 10, k: 0.8, gem: 11 }),
    e('C', { lane: 'look', S: 6, k: 0, gem: 6 }),
    e('D', { lane: 'promising', S: 7, k: 0.6, gem: 7.9 }),
    e('E', { lane: 'look', S: 5, k: 0.2, gem: 5.4 }),
    e('F', { lane: 'promising', S: 9, k: 0.1, gem: 9.1, gates: [{ id: 'g.injection', action: 'doubt' }] }),
    e('G', { lane: 'quarantine' }),
    e('H', { lane: 'doubted', S: 8, k: 0.1, gem: 8 }),
    e('I', { lane: 'look', S: 5, k: 0.2, gem: 5.1, gates: ['g.injection'] }),
  ] };
  const plan = selectionPlan(index, { top: 3, rand: mulberry32(4) });
  assert.deepEqual(plan.main.map((x) => x.id), ['A', 'C', 'B']);
  assert.deepEqual(plan.audit.map((x) => x.id), ['E'], 'ceil(0.1 × 3) = 1 audit pick from look');
  const ids = (/** @type {number} */ top) => selectForReview(index, { top, rand: mulberry32(4) })
    .map((x) => x.id);
  assert.deepEqual(ids(3), ['A', 'C', 'B', 'E']);
  assert.deepEqual(ids(10), ['A', 'C', 'B', 'D', 'E']);
  assert.deepEqual(selectForReview(index, { top: 3, exclude: ['A'], rand: mulberry32(4) }).slice(0, 3)
    .map((x) => x.id), ['C', 'B', 'D']);
  assert.deepEqual(selectForReview(index, { top: 0 }), []);
  assert.equal(isEligible(index.entries[5]), false);
  assert.equal(isUncertain(index.entries[3]), false);
});

test('the pack files query matches the documented assembly, with expressions as variables', () => {
  const mine = packFilesQuery('octo', 'tide', ['abc:src/main.rs', 'abc:tests/t.rs']);
  const ref = referenceFilesQuery([{ owner: 'octo', name: 'tide', paths: ['src/main.rs', 'tests/t.rs'] }]);
  assert.equal(mine.doc, ref.doc);
  assert.deepEqual(mine.variables,
    { o0: 'octo', n0: 'tide', e0_0: 'abc:src/main.rs', e0_1: 'abc:tests/t.rs' });
  assert.ok(!mine.doc.includes('src/main.rs'));
  assert.match(mine.doc, /^query\(/);
});

// ---------------------------------------------------------------------------------------------
// Review runs
// ---------------------------------------------------------------------------------------------

test('a review fetches pack files once, records valid verdicts and attaches them', async () => {
  const r1 = rec(1);
  const r2 = rec(2);
  const index = { entries: [entry(r1, {}), entry(r2, { gem: 8 })] };
  const store = memoryStore({ records: [r1, r2], index });
  const backend = fakeBackend([ok()]);
  const client = fakeClient();
  /** @type {any[]} */
  const rescored = [];
  const s = await run(store, backend, {
    client, rescore: (/** @type {any} */ record, /** @type {any} */ v) => {
      rescored.push(v.status);
      return { ...record, rescored: true };
    },
  });
  assert.equal(s.reviewed, 2);
  assert.equal(s.counts.ok, 2);
  assert.equal(s.spentUsd, 0.2);
  assert.equal(backend.calls.length, 2);
  assert.equal(client.calls.length, 2);
  assert.equal(store.calls.putFiles, 2);
  assert.deepEqual(rescored, ['ok', 'ok']);
  assert.equal(store.verdicts.length, 2);
  for (const v of store.verdicts) {
    assert.deepEqual(validateVerdictRecord(v), []);
    assert.equal(v.rubric, RUBRIC_VERSION);
    assert.equal(v.effect.points, 1);
    assert.equal(v.validation.claimsKept, 4);
    assert.ok(v.packBytes > 0 && v.packBytes <= 48 * 1024);
  }
  const saved = /** @type {any} */ (await store.getRepoById(r1.id));
  assert.equal(saved.rescored, true);
  assert.equal(saved.verdict.headOid, 'head1');
  assert.ok(backend.calls[0].text.includes('<<<FILE path="src/main.rs"'));

  const again = await run(store, backend);
  assert.equal(again.reviewed, 0, 'cached verdicts are never reviewed again');
  assert.equal(backend.calls.length, 2);
});

test('cached pack files are used without asking GitHub', async () => {
  const r = rec(3);
  const store = memoryStore({ records: [r], index: { entries: [entry(r, {})] },
    files: { [`${r.id}@head3`]: packFixture.files } });
  const client = fakeClient();
  const s = await run(store, fakeBackend([ok()]), { client });
  assert.equal(s.counts.ok, 1);
  assert.equal(client.calls.length, 0);
});

test('the cost cap stops a run before a call that would exceed it', async () => {
  const records = [rec(11), rec(12), rec(13)];
  const index = { entries: records.map((r, i) => entry(r, { gem: 9 - i })) };
  const store = memoryStore({ records, index });
  const backend = fakeBackend([ok(goodOutput, 0.1)]);
  const s = await run(store, backend, { maxUsd: 0.25 });
  assert.equal(backend.calls.length, 2);
  assert.equal(s.stopReason, 'budget');
  assert.equal(s.remaining, 1);
  assert.equal(s.spentUsd, 0.2);

  const tight = memoryStore({ records, index });
  const none = fakeBackend([ok()]);
  const t = await run(tight, none, { maxUsd: FIRST_CALL_ESTIMATE_USD - 0.01 });
  assert.equal(none.calls.length, 0, 'the first call is estimated at $0.15');
  assert.equal(t.stopReason, 'budget');
});

test('a refusal is recorded and never retried', async () => {
  const r = rec(21);
  const store = memoryStore({ records: [r], index: { entries: [entry(r, {})] } });
  const refusal = { ok: false, costUsd: 0, usage: { input: 0, output: 0 }, stopReason: 'refusal',
    refusal: { category: 'cyber' } };
  const backend = fakeBackend([refusal]);
  const s = await run(store, backend);
  assert.equal(s.counts.refused, 1);
  assert.equal(store.verdicts[0].status, 'refused');
  assert.deepEqual(store.verdicts[0].refusal, { category: 'cyber' });
  assert.deepEqual(validateVerdictRecord(store.verdicts[0]), []);
  assert.equal(store.calls.putRepo, 0, 'a refusal is not attached to the record');
  await run(store, backend);
  await run(store, backend, { repo: r.nwo });
  assert.equal(backend.calls.length, 1, 'never retried');
});

test('error verdicts are retried on the next run; three in a row stop the run', async () => {
  const records = [rec(31), rec(32), rec(33), rec(34)];
  const store = memoryStore({ records, index: { entries: records.map((r, i) => entry(r, { gem: 9 - i })) } });
  const backend = fakeBackend([fail('server')]);
  const s = await run(store, backend);
  assert.equal(s.counts.error, 3);
  assert.equal(s.stopReason, 'errors');
  assert.equal(s.remaining, 1);
  const retry = fakeBackend([ok()]);
  const s2 = await run(store, retry);
  assert.equal(retry.calls.length, 4);
  assert.equal(s2.counts.ok, 4);
});

test('a rate limit ends the run and an authentication failure disables the backend', async () => {
  const records = [rec(41), rec(42), rec(43)];
  const index = { entries: records.map((r, i) => entry(r, { gem: 9 - i })) };
  const rateStore = memoryStore({ records, index });
  const s = await run(rateStore, fakeBackend([ok(), fail('rate')]));
  assert.equal(s.stopReason, 'rate-limit');
  assert.equal(s.remaining, 2);
  assert.equal(rateStore.verdicts.length, 1, 'no verdict for the rate-limited repository');
  const authStore = memoryStore({ records, index });
  const a = await run(authStore, fakeBackend([fail('auth')]));
  assert.equal(a.stopReason, 'auth');
  assert.equal(authStore.verdicts.length, 0);
});

test('quarantined repositories are never sent; g.injection records a skipped-injection verdict', async () => {
  const lure = { id: 'g.lure.link', action: 'quarantine', reason: 'x', evidence: [] };
  const q = rec(51, { lane: 'quarantine', gates: [lure] });
  const inj = rec(52, { gates: [{ id: 'g.injection', action: 'doubt', reason: 'x', evidence: [] }] });
  const store = memoryStore({ records: [q, inj] });
  const backend = fakeBackend([ok()]);
  const s1 = await run(store, backend, { repo: q.nwo });
  assert.equal(s1.skippedFor.quarantined, 1);
  const s2 = await run(store, backend, { repo: inj.nwo });
  assert.equal(s2.counts['skipped-injection'], 1);
  assert.equal(backend.calls.length, 0);
  assert.equal(store.verdicts.length, 1);
  assert.equal(store.verdicts[0].status, 'skipped-injection');
  assert.deepEqual(validateVerdictRecord(store.verdicts[0]), []);
});

test('--repo reviews one repository regardless of order, and reports one it cannot find', async () => {
  const r = rec(61);
  const store = memoryStore({ records: [r], index: { entries: [entry(r, { lane: 'look', S: 5, gem: 5 })] } });
  const backend = fakeBackend([ok()]);
  assert.equal((await run(store, backend, { top: 0 })).reviewed, 0, 'S 5 is not eligible by order');
  const s = await run(store, backend, { repo: 'Octo-Sailor/Tide-61', top: 0 });
  assert.equal(s.reviewed, 1);
  assert.equal(s.results[0].audit, false);
  assert.equal((await run(store, backend, { repo: 'nobody/nothing' })).stopReason, 'not-found');
  assert.equal((await run(memoryStore(), backend)).stopReason, 'no-index');
});

test('an injection verdict doubts without points; a fabricated one is unsupported', async () => {
  const a = rec(71);
  const b = rec(72);
  const store = memoryStore({ records: [a, b], index: { entries: [entry(a, {}), entry(b, { gem: 8 })] } });
  const s = await run(store, fakeBackend([ok(injectionOutput), ok(fabricatedOutput)]));
  assert.deepEqual(s.results.map((x) => [x.status, x.points, x.lane]),
    [['ok', 0, 'doubted'], ['unsupported', 0, null]]);
  assert.equal(/** @type {any} */ (await store.getRepoById(a.id)).verdict.status, 'ok');
  assert.equal(/** @type {any} */ (await store.getRepoById(b.id)).verdict, null);
  assert.equal(store.verdicts[1].validation.claimsDropped, 3);
});

test('a failing rescore still attaches the verdict; an aborted run stops at once', async () => {
  const r = rec(81);
  const store = memoryStore({ records: [r], index: { entries: [entry(r, {})] } });
  /** @type {string[]} */
  const warnings = [];
  const log = { level: 'info', enabled: () => true, debug() {}, info() {}, error() {}, stage() {},
    warn: (/** @type {string} */ m) => warnings.push(m) };
  await run(store, fakeBackend([ok()]), {
    log, rescore: () => {
      throw new Error('scoreFacts is not yet available');
    },
  });
  assert.equal(/** @type {any} */ (await store.getRepoById(r.id)).verdict.status, 'ok');
  assert.match(warnings.join('\n'), /Could not rescore/);
  const controller = new AbortController();
  controller.abort();
  const fresh = memoryStore({ records: [rec(82)], index: { entries: [entry(rec(82), {})] } });
  const backend = fakeBackend([ok()]);
  const s = await run(fresh, backend, { signal: controller.signal });
  assert.equal(s.stopReason, 'interrupted');
  assert.equal(backend.calls.length, 0);
});

test('timed-out calls are charged, so repeated timeouts stop at the cost cap (llm-3)', async () => {
  const records = [rec(91), rec(92), rec(93)];
  const store = memoryStore({ records, index: { entries: records.map((r, i) => entry(r, { gem: 9 - i })) } });
  const timeout = { ...fail('timeout', 0.5), costEstimated: true };
  const backend = fakeBackend([timeout]);
  const s = await run(store, backend, { maxUsd: 1 });
  assert.equal(backend.calls.length, 2, 'the third call would exceed the cap');
  assert.equal(s.stopReason, 'budget');
  assert.equal(s.spentUsd, 1);
  assert.equal(s.remaining, 1);
  for (const v of store.verdicts) {
    assert.equal(v.status, 'error');
    assert.equal(v.costUsd, 0.5);
    assert.equal(v.costEstimated, true);
    assert.deepEqual(validateVerdictRecord(v), []);
  }
});

test('timeouts alternating with answers no longer slip past the cap (llm-3)', async () => {
  const records = [rec(94), rec(95), rec(96), rec(97), rec(98), rec(99)];
  const store = memoryStore({ records, index: { entries: records.map((r, i) => entry(r, { gem: 9 - i / 10 })) } });
  const timeout = { ...fail('timeout', 0.5), costEstimated: true };
  let n = 0;
  const backend = {
    name: /** @type {'claude-cli'} */ ('claude-cli'), model: 'claude-opus-5',
    call: async () => structuredClone(n++ % 2 === 0 ? timeout : ok(goodOutput, 0.1)),
  };
  const s = await run(store, backend, { maxUsd: 1 });
  assert.equal(n, 3, 'timeout, answer, timeout; then the next estimate no longer fits');
  assert.equal(s.stopReason, 'budget');
  assert.equal(s.spentUsd, 1.1);
});

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

/**
 * Run `unsung review` with a fake context that must never open the store or reach GitHub.
 * @param {string[]} argv
 * @param {Record<string, string>} [env]
 */
async function cli(argv, env = {}) {
  const out = /** @type {string[]} */ ([]);
  const errs = /** @type {string[]} */ ([]);
  const args = parseArgs(['review', ...argv], command.flags);
  const ctx = /** @type {any} */ ({
    config: { defaults: DEFAULTS }, flags: args.flags, env, now: () => NOW, rand: mulberry32(1),
    signal: new AbortController().signal,
    log: { level: 'info', enabled: () => true, debug() {}, info() {}, stage() {},
      warn: (/** @type {string} */ m) => errs.push(m), error: (/** @type {string} */ m) => errs.push(m) },
    print: (/** @type {string} */ l) => out.push(l),
    printJson: (/** @type {any} */ v) => out.push(JSON.stringify(v)),
    store: async () => {
      throw new Error('the store must not be opened');
    },
    client: async () => {
      throw new Error('GitHub must not be reached');
    },
  });
  const code = await command.run(args, ctx);
  return { code, out: out.join('\n'), err: errs.join('\n') };
}

test('unsung review with backend none explains how to enable a backend and exits 0', async () => {
  const r = await cli([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /optional and off by default/);
  assert.match(r.out, /--backend claude-cli/);
  assert.match(r.out, /npm install @anthropic-ai\/sdk/);
});

test('unsung review --backend anthropic-api without the SDK prints the install instruction and exits 2',
  async (t) => {
    try {
      await import('@anthropic-ai/sdk');
      t.skip('the SDK is installed here');
      return;
    } catch {
      // expected: not installed
    }
    const r = await cli(['--backend', 'anthropic-api']);
    assert.equal(r.code, 2);
    assert.match(r.err, /npm install @anthropic-ai\/sdk/);
  });

test('unsung review rejects bad options and a missing claude executable with exit 2', async () => {
  assert.equal((await cli(['--backend', 'gpt'])).code, 2);
  assert.equal((await cli(['--top', '-1'])).code, 2);
  assert.equal((await cli(['--max-usd', '-3', '--backend', 'claude-cli'])).code, 2);
  assert.equal((await cli(['--repo', 'not a repo', '--backend', 'claude-cli'])).code, 2);
  const env = { PATH: '', UNSUNG_CLAUDE: 'Z:\\nowhere\\claude.exe' };
  const missing = await cli(['--backend', 'claude-cli'], env);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /Could not find the claude executable/);
});
