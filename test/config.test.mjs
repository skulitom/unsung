// @ts-check
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigError, GRAPHQL_SHARE_OF_WALL, loadConfig, resolveProfile } from '../src/config.mjs';
import { parseArgs } from '../src/cli/args.mjs';

const REPO_CONFIG = fileURLToPath(new URL('../config/', import.meta.url));
const DEFAULTS = JSON.parse(readFileSync(path.join(REPO_CONFIG, 'defaults.json'), 'utf8'));

const WEIGHTS = {
  version: 'w1',
  signals: {
    'q.licence': { points: 1, kind: 'quality' }, 's.prose': { points: -2, kind: 'slop', group: 'prose' },
  },
  confidence: {}, bands: { gem: 7, look: 5 }, gem: { kWeight: 1.5, aWeight: 1.5 },
  attention: { saturation: 25 },
  eligibility: { maxStars: 25, risingGain4w: 10 }, institutions: { orgMinRepos: 100 },
  confidenceBands: { medium: 0.3, high: 0.6 }, lanes: { provenK: 0.5 }, changelog: [],
};
const CALIBRATION = {
  version: 'c1', method: 'platt-pooled-slope-uniform-intercept', a: -6.403, b: 1.113,
  fittedOn: { labels: 149, uniform: 69, positives: 74, uniformPositives: 9, base: 0.141, weights: 'w1' },
  fittedAt: '2026-09-11',
};
const INSTITUTIONS = { version: 1, allow: ['nasa', 'ibm'], deny: [] };

/** @type {string[]} */
const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/**
 * A throwaway configuration directory; `files` replaces or (with `null`) removes a file's content.
 * @param {Record<string, unknown>} [files]
 * @returns {string}
 */
function configDir(files = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'unsung-config-'));
  temps.push(dir);
  /** @type {Record<string, unknown>} */
  const all = {
    'defaults.json': DEFAULTS, 'weights.json': WEIGHTS, 'calibration.json': CALIBRATION,
    'institutions.json': INSTITUTIONS, ...files,
  };
  for (const [name, value] of Object.entries(all)) {
    if (value === null) continue;
    const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
    writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

test('loadConfig reads and validates all four files', () => {
  const cfg = loadConfig(configDir());
  assert.deepEqual(Object.keys(cfg).sort(), ['calibration', 'defaults', 'institutions', 'weights']);
  assert.deepEqual(cfg.defaults, DEFAULTS);
  assert.deepEqual(cfg.weights, WEIGHTS);
  assert.deepEqual(cfg.calibration, CALIBRATION);
  assert.deepEqual(cfg.institutions, INSTITUTIONS);
});

test('a missing file is a ConfigError naming it (exit 2)', () => {
  const dir = configDir({ 'weights.json': null });
  assert.throws(() => loadConfig(dir), (e) => e instanceof ConfigError && e.exitCode === 2
    && e.code === 'ECONFIG' && /weights\.json is missing/.test(e.message));
});

test('invalid JSON and invalid content are reported', () => {
  assert.throws(() => loadConfig(configDir({ 'calibration.json': '{ nope' })),
    /calibration\.json is not valid JSON/);
  assert.throws(() => loadConfig(configDir({ 'calibration.json': { ...CALIBRATION, b: 'steep' } })),
    /calibration\.json is not valid: calibration\.b: expected a finite number/);
  const badDefaults = { ...DEFAULTS, server: { port: 0 } };
  assert.throws(() => loadConfig(configDir({ 'defaults.json': badDefaults })), /defaults\.server\.port/);
});

test('a byte-order mark is tolerated', () => {
  const bom = String.fromCharCode(0xfeff);
  const dir = configDir({ 'institutions.json': `${bom}${JSON.stringify(INSTITUTIONS)}` });
  assert.deepEqual(loadConfig(dir).institutions, INSTITUTIONS);
});

const REPO_FILES = ['defaults.json', 'weights.json', 'calibration.json', 'institutions.json'];
test('the repository configuration loads once every package has landed its file', {
  skip: !REPO_FILES.every((f) => existsSync(path.join(REPO_CONFIG, f)))
    && 'weights, calibration or institutions not yet written',
}, () => {
  const cfg = loadConfig(REPO_CONFIG);
  assert.equal(cfg.calibration.version, 'c1');
  assert.equal(cfg.weights.bands.gem, 7);
});

test('resolveProfile quick follows §3.8 and §9.3', () => {
  const o = resolveProfile(DEFAULTS, 'quick', {});
  assert.equal(o.profile, 'quick');
  assert.deepEqual(o.budget, {
    wallMs: 600_000, graphqlMs: 450_000, shares: { census: 0.30, archive: 0.05, enrichUntil: 0.85 },
  });
  assert.equal(GRAPHQL_SHARE_OF_WALL, 0.75);
  assert.equal(o.lagDays, 3);
  assert.equal(o.backfillDays, 0);
  assert.equal(o.archiveHours, 3);
  assert.equal(o.deepTopN, 50);
  assert.equal(o.enrichMax, 1000);
  assert.equal(o.recheckTop, 100);
  assert.equal(o.archive, true);
  assert.equal(o.wait, true);
  assert.equal(o.dryRun, false);
  assert.equal(o.until, null);
  assert.equal(o.lang, null);
  assert.equal(o.topic, null);
  assert.equal(o.maxStars, 25);
  assert.equal(o.ownerCapPerDay, 5);
  assert.equal(o.explore, 0.05);
  assert.equal(o.queueTtlDays, 14);
  assert.deepEqual(o.governor, DEFAULTS.governor);
  assert.deepEqual(o.batch, DEFAULTS.batch);
  assert.deepEqual(o.caps, DEFAULTS.caps);
});

test('resolveProfile daily is uncapped', () => {
  const o = resolveProfile(DEFAULTS, 'daily', {});
  assert.deepEqual([o.budget.wallMs, o.budget.graphqlMs], [null, null]);
  assert.deepEqual([o.archiveHours, o.deepTopN, o.enrichMax, o.recheckTop], [24, 400, 12000, 2000]);
  assert.equal(resolveProfile(DEFAULTS, null, { profile: 'daily' }).profile, 'daily');
  assert.equal(resolveProfile(DEFAULTS, undefined, {}).profile, 'quick');
});

test('explicit flags win over the profile, in either spelling', () => {
  const o = resolveProfile(DEFAULTS, 'daily', {
    budget: 1_800_000, lag: 5, backfill: 2, 'enrich-max': 20, deep: 7, archiveHours: 1, 'no-archive': true,
    noWait: true, dryRun: true, lang: 'Rust', topic: 'mcp', until: 'caught-up',
  });
  assert.deepEqual([o.budget.wallMs, o.budget.graphqlMs], [1_800_000, 1_350_000]);
  assert.deepEqual([o.lagDays, o.backfillDays, o.enrichMax, o.deepTopN, o.archiveHours], [5, 2, 20, 7, 1]);
  assert.deepEqual([o.archive, o.wait, o.dryRun], [false, false, true]);
  assert.deepEqual([o.lang, o.topic, o.until], ['Rust', 'mcp', 'caught-up']);
  assert.equal(resolveProfile(DEFAULTS, 'quick', { budget: '2h' }).budget.wallMs, 7_200_000);
  assert.equal(resolveProfile(DEFAULTS, 'quick', { budget: 'none' }).budget.wallMs, null);
  assert.equal(resolveProfile(DEFAULTS, 'quick', { budget: null }).budget.wallMs, null);
  assert.equal(resolveProfile(DEFAULTS, 'quick', { deep: null, lang: '' }).deepTopN, 50);
  assert.equal(resolveProfile(DEFAULTS, 'quick', { archive: false }).archive, false);
});

test('resolveProfile rejects bad input with ConfigError', () => {
  assert.throws(() => resolveProfile(DEFAULTS, 'weekly', {}),
    (e) => e instanceof ConfigError && /Unknown profile 'weekly'; choose quick or daily/.test(e.message));
  assert.throws(() => resolveProfile(DEFAULTS, 'toString', {}), /Unknown profile/);
  assert.throws(() => resolveProfile(DEFAULTS, 'quick', { until: 'dawn' }),
    /--until accepts only 'caught-up'/);
  assert.throws(() => resolveProfile(DEFAULTS, 'quick', { deep: -1 }), /--deep expects a whole number/);
  assert.throws(() => resolveProfile(DEFAULTS, 'quick', { 'enrich-max': 2.5 }),
    /--enrich-max expects a whole number/);
  assert.throws(() => resolveProfile(DEFAULTS, 'quick', { budget: 'soon' }), /--budget expects a duration/);
});

test('RunOptions never share objects with the defaults', () => {
  const o = resolveProfile(DEFAULTS, 'quick', {});
  o.governor.searchGapMs = 0;
  o.batch.enrich.size = 99;
  o.budget.shares.census = 1;
  assert.equal(DEFAULTS.governor.searchGapMs, 2100);
  assert.equal(DEFAULTS.batch.enrich.size, 12);
  assert.equal(DEFAULTS.shares.census, 0.30);
});

test('flags from parseArgs feed resolveProfile directly', () => {
  const spec = {
    budget: { type: 'duration' }, profile: { type: 'string', default: 'quick' }, lag: { type: 'number' },
    'no-archive': { type: 'boolean' }, 'enrich-max': { type: 'number' }, 'dry-run': { type: 'boolean' },
  };
  const argv = ['run', '--budget', '5m', '--no-archive', '--enrich-max', '9', '--dry-run'];
  const { flags } = parseArgs(argv, spec);
  const o = resolveProfile(DEFAULTS, null, flags);
  assert.deepEqual([o.profile, o.budget.wallMs, o.archive, o.enrichMax, o.dryRun, o.lagDays],
    ['quick', 300_000, false, 9, true, 3]);
});
