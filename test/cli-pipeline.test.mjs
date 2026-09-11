// @ts-check
/**
 * The pipeline commands (`run`, `add`, `status`, `recheck`, `sample`, `index`, `compact`) with an
 * injected context: memory store, fake GitHub and stub functions. One test also goes through
 * `bin/unsung.mjs#main` to check the exit-code mapping.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from '../src/cli/args.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';
import { hasStore, openStore } from '../src/store/store.mjs';
import { main } from '../bin/unsung.mjs';
import { command as runCmd } from '../src/cli/run.mjs';
import { command as addCmd } from '../src/cli/add.mjs';
import { command as statusCmd } from '../src/cli/status.mjs';
import { command as recheckCmd } from '../src/cli/recheck.mjs';
import { command as sampleCmd } from '../src/cli/sample.mjs';
import { command as indexCmd } from '../src/cli/index.mjs';
import { command as compactCmd } from '../src/cli/compact.mjs';
import {
  fakeGitHub, fakeLib, recordingLog, seedOf, testClock, testConfig,
} from './support/pipeline-fakes.mjs';

const DAY = '2026-09-08';
const WINDOW = `census:${DAY}:all:${DAY}T00:00:00Z..${DAY}T23:59:59Z`;
/** @type {string[]} */
const temps = [];
after(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

const REPOS = [
  { id: 'R_gem', nwo: 'o/gem', S: 8 },
  { id: 'R_look', nwo: 'o/look', S: 5 },
  { id: 'R_low', nwo: 'o/low', S: 3 },
  {
    id: 'R_lure', nwo: 'o/lure', S: 6,
    gates: [{ id: 'g.lure.link', action: 'quarantine', reason: 'zip in tests/' }],
  },
];

/** @param {unknown} e */
const exit2 = (e) => /** @type {any} */ (e).exitCode === 2;

/**
 * A command context as `src/cli/context.mjs` builds it, over a memory store and a fake GitHub.
 * @param {{flags?: Record<string, any>, store?: any, repos?: any[], lib?: any, github?: boolean}} [o]
 */
function makeCtx({ flags = {}, store, repos = REPOS, lib, github = true } = {}) {
  const clock = testClock('2026-09-11T12:00:00Z');
  const st = store ?? createMemoryStore({ now: clock.now });
  const client = fakeGitHub(repos, { clock });
  const seeds = repos.map((r) => seedOf(r, `census:${DAY}`));
  const units = { [DAY]: [{ key: WINDOW, seeds }] };
  const hours = { sample: repos.map((r) => seedOf(r, 'sample')) };
  /** @type {string[]} */
  const out = [];
  const log = recordingLog();
  let githubCalls = 0;
  const ctx = {
    config: testConfig(), configDir: '', dataDir: '', log, now: clock.now, rand: mulberry32(3), seed: 3,
    clock, flags: { json: false, ...flags }, env: {}, argv: ['run'], version: '0.1.0',
    userAgent: 'unsung/0.1.0 (+local; read-only)', signal: new AbortController().signal,
    print: (/** @type {string} */ t) => {
      out.push(t);
    },
    printJson: (/** @type {unknown} */ v) => {
      out.push(JSON.stringify(v));
    },
    store: async () => st,
    github: async () => {
      githubCalls++;
      if (!github) throw new Error('GitHub must not be used here');
      return { client, governor: null, tokenSource: 'test' };
    },
    client: async () => client,
    governor: async () => null,
    deps: lib ?? fakeLib({ units, hours }),
  };
  return {
    ctx, out, log, store: st, client,
    get githubCalls() {
      return githubCalls;
    },
  };
}

/**
 * @param {any} cmd
 * @param {string[]} argv arguments after the command name
 */
function argsFor(cmd, argv) {
  return parseArgs([cmd.name, ...argv], cmd.flags);
}

test('every pipeline command exports {name, summary, flags, run}', () => {
  for (const cmd of [runCmd, addCmd, statusCmd, recheckCmd, sampleCmd, indexCmd, compactCmd]) {
    assert.equal(typeof cmd.name, 'string');
    assert.ok(cmd.summary.length > 10);
    assert.equal(typeof cmd.run, 'function');
    assert.equal(typeof cmd.flags, 'object');
  }
  // The profile supplies these; a default in the spec would override `--profile daily`.
  for (const f of ['budget', 'archive-hours', 'deep', 'enrich-max', 'lag', 'backfill']) {
    assert.equal(/** @type {any} */ (runCmd.flags)[f].default, undefined, f);
  }
});

test('unsung run: a quick run over fakes exits 0, writes the index and prints the explore line', async () => {
  const t = makeCtx();
  const code = await runCmd.run(argsFor(runCmd, ['--budget', 'none', '--no-archive']), t.ctx);
  assert.equal(code, 0);
  const index = await t.store.readIndex();
  assert.deepEqual(index?.entries.map((e) => e.nwo), ['o/gem', 'o/look', 'o/lure']);
  const stages = t.log.lines.filter((l) => l.level === 'stage').map((l) => l.msg);
  assert.equal(stages.at(-1), 'explore');
  assert.match(t.log.lines.at(-1)?.fields.text, /http:\/\/127\.0\.0\.1:8750/);
});

test('unsung run --json prints the run summary; --profile daily takes the daily budget', async () => {
  const t = makeCtx({ flags: { json: true } });
  const code = await runCmd.run(argsFor(runCmd, ['--profile', 'daily', '--dry-run']), t.ctx);
  assert.equal(code, 0);
  const summary = JSON.parse(t.out[0]);
  assert.equal(summary.profile, 'daily');
  assert.deepEqual(summary.budget, { wallMs: null, graphqlMs: null });
  assert.equal('units' in summary, false);
  assert.equal(t.githubCalls, 0, 'a dry run never asks for a token');
});

test('unsung run: a live lock is refused with exit 2', async () => {
  const t = makeCtx();
  await t.store.lock('other-run');
  await assert.rejects(runCmd.run(argsFor(runCmd, ['--budget', 'none']), t.ctx), exit2);
});

test('unsung add explains each repository, keeps it whatever its lane, and rebuilds the index', async () => {
  const t = makeCtx();
  const code = await addCmd.run(argsFor(addCmd, ['o/low', 'o/missing']), t.ctx);
  assert.equal(code, 1, 'one of the two was not found');
  assert.equal(t.out[0], 'o/low · low');
  assert.match(t.out[1], /^ {2}4 points · Quality \d+ · Confidence low · 0 stars$/);
  assert.match(t.out[2], /^ {2}Rank /);
  assert.ok(t.out.some((l) => /o\/missing: o\/missing was not found/.test(l)));
  assert.ok(await t.store.getRepo('o/low'));
  assert.deepEqual((await t.store.readIndex())?.entries.map((e) => e.nwo), ['o/low']);
  assert.equal(await t.store.lockInfo(), null, 'the lock is released');
  await assert.rejects(addCmd.run(argsFor(addCmd, []), t.ctx), exit2);
});

test('unsung add --no-deep skips the deep stage', async () => {
  const t = makeCtx({ flags: { json: true } });
  assert.equal(await addCmd.run(argsFor(addCmd, ['o/gem', '--no-deep']), t.ctx), 0);
  const [result] = JSON.parse(t.out[0]);
  assert.deepEqual(result, { nwo: 'o/gem', lane: 'promising', S: 8, gem: result.gem });
  assert.equal(t.client.calls.filter((c) => c.doc.startsWith('query Deep')).length, 0);
});

test('unsung status prints runs, ledger, candidates and index; --units and --audit add detail', async () => {
  const t = makeCtx();
  await runCmd.run(argsFor(runCmd, ['--budget', 'none', '--no-archive']), t.ctx);
  t.out.length = 0;
  assert.equal(await statusCmd.run(argsFor(statusCmd, ['--units', '--audit']), t.ctx), 0);
  const text = t.out.join('\n');
  assert.match(text, /^Lock: none$/m);
  assert.match(text, /^Recent runs:$/m);
  assert.match(text, /finished \(0\) {2}GraphQL \d+ points/);
  assert.match(text, /^Ledger: planned 0 · running 0 · done 1 · failed 0$/m);
  assert.match(text, /^ {2}census: 1 done · 0 failed$/m);
  assert.match(text, /^Candidates: queued 0 · deferred 0 · enriched 3 · quarantined 1/m);
  assert.match(text, /^Index: 3 entries \(promising 1 · look 1 · quarantine 1\)/m);
  assert.ok(t.out.includes(`  ${WINDOW}  done  1`));
  assert.match(text, /^Gate audit sample for 2026-W37:$/m);
  assert.match(text, /^ {2}g\.lure\.link \(1\):\n {4}o\/lure$/m);

  const j = makeCtx({ flags: { json: true }, store: t.store });
  await statusCmd.run(argsFor(statusCmd, []), j.ctx);
  const status = JSON.parse(j.out[0]);
  assert.equal(status.runs.length, 1);
  assert.deepEqual(status.units, { planned: 0, running: 0, done: 1, failed: 0 });
});

test('unsung status says which lane a run skipped before its first unit, and why (§3.8)', async () => {
  const t = makeCtx();
  await t.store.endRun({
    v: 1, runId: '20260911T120000Z-abcd', startedAt: '2026-09-11T12:00:00Z', endedAt: '2026-09-11T12:03:00Z',
    argv: ['run', '--budget', '3m'], profile: 'quick', budget: { wallMs: 180_000, graphqlMs: 135_000 },
    stages: {
      census: { days: ['2026-09-08'], units: 2 },
      archive: { hours: [], events: 0, lookups: 0, seeds: 0, skipped: 'time' },
      enrich: { repos: 20, calls: 2 },
    },
    rate: {}, exit: { code: 0, reason: 'budget', resumeAt: null },
  });
  assert.equal(await statusCmd.run(argsFor(statusCmd, []), t.ctx), 0);
  const line = t.out.find((l) => l.includes('20260911T120000Z-abcd'));
  assert.match(String(line), /budget \(0\) .* enriched 20 · archive: skipped \(time\)$/);
});

test('unsung status on an empty store says how to start', async () => {
  const t = makeCtx();
  await statusCmd.run(argsFor(statusCmd, []), t.ctx);
  assert.ok(t.out.includes('No runs yet. Start one with: unsung run'));
  assert.ok(t.out.includes('Index: not built yet'));
});

test('unsung recheck refreshes the index', async () => {
  const t = makeCtx();
  await runCmd.run(argsFor(runCmd, ['--budget', 'none', '--no-archive']), t.ctx);
  t.ctx.clock.set('2026-09-13T12:00:00Z');
  t.out.length = 0;
  assert.equal(await recheckCmd.run(argsFor(recheckCmd, ['--top', '5']), t.ctx), 0);
  assert.equal(t.out[0], 'Re-checked 2 · 0 gone · 0 re-queued');
  assert.equal((await t.store.readIndex())?.generatedAt, '2026-09-13T12:00:00.000Z');
});

test('unsung sample enriches and keeps every draw for blind labelling', async () => {
  const t = makeCtx();
  assert.equal(await sampleCmd.run(argsFor(sampleCmd, ['--n', '3']), t.ctx), 0);
  assert.equal(t.out[0], 'Sampled 3 repositories for blind labelling (Calibrate tab):');
  assert.ok(await t.store.getRepo('o/low'), 'even a low repository is kept');
  const c = await t.store.getCandidate('R_low');
  assert.deepEqual(c?.sources, ['sample']);
  assert.equal(c?.day, '2026-09-11');
});

test('unsung index rebuilds the index; --rescore recomputes scores offline', async () => {
  const t = makeCtx({ github: false });
  const seed = makeCtx({ store: t.store });
  await runCmd.run(argsFor(runCmd, ['--budget', 'none', '--no-archive']), seed.ctx);
  t.out.length = 0;
  assert.equal(await indexCmd.run(argsFor(indexCmd, ['--rescore']), t.ctx), 0);
  assert.equal(t.out[0], 'Rescored 3 repositories offline');
  assert.equal(t.out[1], 'Index: 3 entries (promising 1 · look 1 · quarantine 1)');
  assert.equal(t.githubCalls, 0);
});

test('unsung compact applies retention; --migrate upgrades an older data directory', async () => {
  const t = makeCtx();
  assert.equal(await compactCmd.run(argsFor(compactCmd, []), t.ctx), 0);
  assert.match(t.out[0], /^Candidates: 0 old dropped or expired removed/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unsung-cli-'));
  temps.push(dir);
  fs.writeFileSync(path.join(dir, 'STORE_VERSION'), '0\n');
  const m = makeCtx();
  m.ctx.dataDir = dir;
  assert.equal(await compactCmd.run(argsFor(compactCmd, ['--migrate']), m.ctx), 0);
  assert.equal(fs.readFileSync(path.join(dir, 'STORE_VERSION'), 'utf8').trim(), '1');
});

test('through bin/unsung.mjs: a held lock maps to exit 2; a dry run to exit 0', async () => {
  const t = makeCtx();
  await t.store.lock('someone');
  /** @type {string[]} */
  const err = [];
  const io = {
    stdout: { write: (/** @type {string} */ s) => { t.out.push(s); } },
    stderr: { write: (/** @type {string} */ s) => { err.push(s); } },
    createContext: async () => /** @type {any} */ (t.ctx),
    installSignals: false,
  };
  assert.equal(await main(['run', '--budget', 'none'], io), 2);
  assert.match(err.join(''), /Another run holds the lock/);
  await t.store.unlock();
  assert.equal(await main(['run', '--dry-run'], io), 0);
});

test('unsung run --dry-run and unsung status never create a missing data directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unsung-dry-'));
  temps.push(root);
  const dir = path.join(root, 'missing');
  const t = makeCtx({ github: false });
  t.ctx.dataDir = dir;
  let opened = 0;
  // What src/cli/context.mjs does: open (and create) the file store in the data directory.
  t.ctx.store = async () => {
    opened++;
    return /** @type {any} */ (await openStore(dir, { now: t.ctx.now }));
  };
  assert.equal(await runCmd.run(argsFor(runCmd, ['--dry-run']), t.ctx), 0);
  const plan = t.log.lines.find((l) => l.level === 'stage' && l.msg === 'plan');
  assert.match(plan?.fields.text, /^census 2026-09-08 \(scope all\) · archive 3 of 3 hours to do · 0 queued$/);
  assert.equal(await statusCmd.run(argsFor(statusCmd, []), t.ctx), 0);
  assert.ok(t.out.includes('No runs yet. Start one with: unsung run'));
  assert.equal(opened, 0, 'the store was never opened');
  assert.equal(fs.existsSync(dir), false, 'nothing was created');
  assert.equal(hasStore(dir), false);

  // A directory that holds a store is planned against as before.
  await openStore(dir, { now: t.ctx.now });
  assert.equal(hasStore(dir), true);
  assert.equal(await runCmd.run(argsFor(runCmd, ['--dry-run']), t.ctx), 0);
  assert.equal(opened, 1);
});
