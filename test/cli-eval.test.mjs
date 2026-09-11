// @ts-check
/**
 * DESIGN §9.1 and §12.5: the `explain`, `eval` and `calibrate` commands with an injected context —
 * a temporary data directory without a store unless a test gives one, and the repository's
 * configuration. One test runs `node bin/unsung.mjs explain` as a child process (no shell).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli/args.mjs';
import { command as calibrateCmd } from '../src/cli/calibrate.mjs';
import { command as evalCmd } from '../src/cli/eval.mjs';
import { command as explainCmd } from '../src/cli/explain.mjs';
import { loadConfig } from '../src/config.mjs';
import { validateCalibration } from '../src/core/schema.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import { fixtureFacts, identityFacts } from '../src/eval/labels.mjs';
import { loadRepoFixture } from './support/fixtures.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CONFIG_DIR = path.join(ROOT, 'config');
const CONFIG_FILES = ['defaults.json', 'weights.json', 'calibration.json', 'institutions.json'];

/** @type {string[]} */
const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/** @returns {string} */
function tempDir() {
  const d = mkdtempSync(path.join(os.tmpdir(), 'unsung-wp4-'));
  temps.push(d);
  return d;
}

/** @returns {string} a copy of the repository's configuration directory */
function configCopy() {
  const dir = tempDir();
  for (const f of CONFIG_FILES) copyFileSync(path.join(CONFIG_DIR, f), path.join(dir, f));
  return dir;
}

/**
 * A command context as src/cli/context.mjs builds it.
 * @param {{json?: boolean, configDir?: string, dataDir?: string, store?: any}} [o]
 */
function makeCtx({ json = false, configDir = CONFIG_DIR, dataDir = tempDir(), store = null } = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {any[]} */
  const printed = [];
  /** @type {string[]} */
  const errors = [];
  const log = {
    level: 'info', enabled: () => true, debug() {}, info() {}, warn() {}, stage() {},
    error: (/** @type {string} */ m) => { errors.push(m); },
  };
  const ctx = {
    config: loadConfig(configDir), configDir, dataDir, log, now: () => '2026-09-11T16:00:00Z',
    rand: mulberry32(11), seed: 11, flags: { json }, env: {}, argv: [], version: '0.1.0',
    print: (/** @type {string} */ t) => { out.push(t); },
    printJson: (/** @type {unknown} */ v) => { printed.push(JSON.parse(JSON.stringify(v))); },
    store: async () => {
      if (!store) throw new Error('the store must not be opened here');
      return store;
    },
  };
  return { ctx, out, printed, errors };
}

/**
 * @param {any} cmd
 * @param {string[]} argv
 */
const argsFor = (cmd, argv) => parseArgs([cmd.name, ...argv], cmd.flags);

/** @param {string} dir */
function markStore(dir) {
  writeFileSync(path.join(dir, 'STORE_VERSION'), '1\n');
}

test('each command exports {name, summary, flags, run}', () => {
  for (const cmd of [explainCmd, evalCmd, calibrateCmd]) {
    assert.equal(typeof cmd.name, 'string');
    assert.equal(typeof cmd.summary, 'string');
    assert.equal(typeof cmd.flags, 'object');
    assert.equal(typeof cmd.run, 'function');
  }
  assert.deepEqual([explainCmd.name, evalCmd.name, calibrateCmd.name], ['explain', 'eval', 'calibrate']);
});

test('§13: `unsung explain skulitom/london-time-map` on the fixture prints the §6.9 row', async () => {
  const { ctx, out } = makeCtx();
  const code = await explainCmd.run(argsFor(explainCmd, ['skulitom/london-time-map']), ctx);
  assert.equal(code, 0);
  const text = out.join('\n');
  assert.equal(out[0], 'skulitom/london-time-map · Promising · recorded fixture, as of 2026-09-11T15:22:23Z');
  for (const part of [
    '8 points · Quality 92 · Confidence medium · 0 stars',
    'Rank 8.45 = 8 points + 0.45 confidence − 0.00 attention',
    'Stages: 7 points at enrich; 8 at deep (+1 README matches the code)',
    'Confidence 0.30 (medium): Owner history 0.30',
    'Ships releases: +1 for a release or a tag',
    'CI runs the tests: +1 if CI runs the tests and passes',
    'Shipped over time: +1 for releases on two days at least a week apart',
    'Has tests: +1 for tests in the repository',
  ]) assert.ok(text.includes(part), part);
});

test('explain --json gives the score and its explanation', async () => {
  const { ctx, printed } = makeCtx({ json: true });
  assert.equal(await explainCmd.run(argsFor(explainCmd, ['skulitom/london-time-map', '--fixture']), ctx), 0);
  const [r] = printed;
  assert.equal(r.source, 'fixture');
  assert.deepEqual([r.score.S, r.score.lane, r.score.gem, r.score.confidence.k], [8, 'promising', 8.45, 0.3]);
  assert.equal(r.explanation.headline, '8 points · Quality 92 · Confidence medium · 0 stars');
});

test('explain rescores a stored record when the data directory holds one', async () => {
  const dataDir = tempDir();
  markStore(dataDir);
  const { facts } = fixtureFacts(loadRepoFixture('skulitom/london-time-map'));
  const rec = { v: 1, id: facts.id, nwo: facts.nwo, facts, verdict: null, gone: false };
  const store = { getRepo: async (/** @type {string} */ nwo) => (nwo === facts.nwo ? rec : null) };
  const { ctx, printed } = makeCtx({ json: true, dataDir, store });
  assert.equal(await explainCmd.run(argsFor(explainCmd, ['skulitom/london-time-map']), ctx), 0);
  assert.equal(printed[0].source, 'store');
  assert.equal(printed[0].score.S, 8);
  assert.equal(printed[0].score.scoredAt, '2026-09-11T16:00:00Z');
});

test('explain of an unknown repository fails with a hint; a malformed name is a usage error', async () => {
  const { ctx, errors } = makeCtx();
  assert.equal(await explainCmd.run(argsFor(explainCmd, ['nobody/nothing-here']), ctx), 1);
  assert.match(errors.join('\n'), /No record of nobody\/nothing-here .*unsung add nobody\/nothing-here/);
  await assert.rejects(explainCmd.run(argsFor(explainCmd, ['not-a-repo']), ctx), { code: 'EARGS' });
  await assert.rejects(explainCmd.run(argsFor(explainCmd, []), ctx), { code: 'EARGS' });
});

test('eval --labels fixtures prints the §14.4 metrics and the §14.6 checks', async () => {
  const { ctx, out } = makeCtx();
  assert.equal(await evalCmd.run(argsFor(evalCmd, ['--labels', 'fixtures']), ctx), 0);
  const text = out.join('\n');
  for (const part of [
    'Labels: 149 (74 genuine) · uniform stratum 69 (9 genuine)',
    'AUC, genuine against the rest:',
    'Stars AUC, for contrast: pooled 0.864 · uniform 0.619',
    'Goodhart (dressed) AUC:',
    'Checks against the §14.6 targets:',
    'Named sets: 28 of 28 expectations hold',
    'Named-set expectations held: 28 (target all 28)',
  ]) assert.ok(text.includes(part), part);
});

test('eval --json prints the report; without labels it says so; a bad source is a usage error', async () => {
  const j = makeCtx({ json: true });
  assert.equal(await evalCmd.run(argsFor(evalCmd, ['--labels', 'fixtures']), j.ctx), 0);
  assert.equal(j.printed[0].counts.labels, 149);
  assert.equal(j.printed[0].named.results.length, 28);
  const none = makeCtx();
  assert.equal(await evalCmd.run(argsFor(evalCmd, ['--labels', 'feedback']), none.ctx), 0);
  assert.match(none.out.join('\n'), /No labels to evaluate yet/);
  const bad = argsFor(evalCmd, ['--labels', 'everything']);
  await assert.rejects(evalCmd.run(bad, none.ctx), { code: 'EARGS' });
  const empty = argsFor(evalCmd, ['--labels', 'fixtures', '--fixtures-dir', tempDir()]);
  await assert.rejects(evalCmd.run(empty, none.ctx), { code: 'EARGS' });
});

test('eval reads feedback labels from a store', async () => {
  const dataDir = tempDir();
  markStore(dataDir);
  const at = '2026-09-10T00:00:00Z';
  const london = fixtureFacts(loadRepoFixture('skulitom/london-time-map')).facts;
  const recs = /** @type {Record<string, any>} */ ({
    R_g: { id: 'R_g', nwo: 'o/g', facts: { ...london, id: 'R_g' } },
    R_c: { id: 'R_c', nwo: 'o/c', facts: { ...identityFacts('o/c', at), id: 'R_c' } },
  });
  const store = {
    readFeedback: async () => [
      { v: 1, at, id: 'R_g', nwo: 'o/g', action: 'gem', label: 'G', blind: false },
      { v: 1, at, id: 'R_c', nwo: 'o/c', action: 'notgood', label: 'C', reason: 'clone', blind: false },
    ],
    getRepoById: async (/** @type {string} */ id) => recs[id] ?? null,
  };
  const { ctx, printed } = makeCtx({ json: true, dataDir, store });
  assert.equal(await evalCmd.run(argsFor(evalCmd, ['--labels', 'feedback']), ctx), 0);
  assert.deepEqual(printed[0].counts.bySource, { feedback: 2 });
  assert.equal(printed[0].auc.pooled, 1);
});

test('calibrate prints the refit and writes nothing without --write', async () => {
  const configDir = configCopy();
  const { ctx, out } = makeCtx({ configDir });
  assert.equal(await calibrateCmd.run(argsFor(calibrateCmd, ['--labels', 'fixtures']), ctx), 0);
  assert.match(out.join('\n'), /Calibration c1: a −6\.403, b 1\.113/);
  assert.match(out.join('\n'), /Run with --write/);
  assert.equal(readFileSync(path.join(configDir, 'calibration.json'), 'utf8'),
    readFileSync(path.join(CONFIG_DIR, 'calibration.json'), 'utf8'));
});

test('calibrate --write saves the next version with a changelog entry', async () => {
  const configDir = configCopy();
  const argv = ['--labels', 'fixtures', '--write'];
  const { ctx, out } = makeCtx({ configDir });
  assert.equal(await calibrateCmd.run(argsFor(calibrateCmd, argv), ctx), 0);
  const written = JSON.parse(readFileSync(path.join(configDir, 'calibration.json'), 'utf8'));
  assert.deepEqual(validateCalibration(written), []);
  assert.equal(written.version, 'c2');
  assert.equal(written.fittedAt, '2026-09-11');
  assert.deepEqual(written.changelog.map((/** @type {any} */ c) => c.version), ['c1', 'c2']);
  assert.equal(loadConfig(configDir).calibration.version, 'c2');
  assert.match(out.join('\n'), /as calibration c2/);
  const again = makeCtx({ configDir });
  assert.equal(await calibrateCmd.run(argsFor(calibrateCmd, argv), again.ctx), 0);
  assert.match(again.out.join('\n'), /matches the current calibration/);
});

test('the real binary explains the fixture from a data directory without a store (no shell)', () => {
  const dataDir = tempDir();
  const bin = path.join(ROOT, 'bin', 'unsung.mjs');
  const argv = [bin, 'explain', 'skulitom/london-time-map', '--data', dataDir];
  const stdout = execFileSync(process.execPath, argv, { encoding: 'utf8', windowsHide: true, cwd: ROOT });
  assert.match(stdout, /8 points · Quality 92 · Confidence medium · 0 stars/);
  assert.match(stdout, /Rank 8\.45 = 8 points \+ 0\.45 confidence − 0\.00 attention/);
});
