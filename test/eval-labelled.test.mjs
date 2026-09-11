// @ts-check
/**
 * DESIGN §14.6, the numeric gates in `npm test`, on the labelled fixtures: pooled AUC ≥ 0.95,
 * uniform AUC ≥ 0.93, precision of S ≥ 7 on the uniform stratum ≥ 0.8, Goodhart AUC ≥ 0.43 pooled
 * and ≥ 0.29 uniform; and on the named sets, every expectation of §14.2. (`fitPlatt` within ±0.05
 * of config/calibration.json is asserted in test/eval-calibrate.test.mjs.)
 *
 * `montezuma-p/harken` gained 13 stars in the four weeks before it was recorded, so §6.7 rule 5
 * makes it Rising; §14.2 allows `rising` for it (its `meta.expect.lane` says so), and the last test
 * pins that this is the only reason it leaves the gem lanes.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mulberry32 } from '../src/core/util.mjs';
import { TARGETS, evaluate, formatReport } from '../src/eval/evaluate.mjs';
import { labelledFromFixtures, namedFromFixtures } from '../src/eval/labels.mjs';
import * as fixtures from './support/fixtures.mjs';

/** @param {string} f */
const read = (f) => JSON.parse(readFileSync(new URL(`../config/${f}`, import.meta.url), 'utf8'));
const config = { weights: read('weights.json'), calibration: read('calibration.json'),
  institutions: read('institutions.json') };

const report = evaluate(labelledFromFixtures(fixtures), config, {
  named: namedFromFixtures(fixtures), rand: mulberry32(7), bootstrap: 300,
});


test('the labelled set: 149 labels, 74 genuine; uniform stratum 69, 9 genuine', () => {
  const c = report.counts;
  assert.deepEqual([c.labels, c.genuine, c.uniform, c.uniformGenuine], [149, 74, 69, 9]);
});

test('§14.6: pooled AUC ≥ 0.95 and uniform AUC ≥ 0.93', () => {
  assert.ok(report.auc.pooled >= 0.95, `pooled AUC ${report.auc.pooled.toFixed(4)}`);
  assert.ok(report.auc.uniform >= 0.93, `uniform AUC ${report.auc.uniform.toFixed(4)}`);
  assert.equal(TARGETS.aucPooled, 0.95);
  assert.equal(TARGETS.aucUniform, 0.93);
});

test('§14.6: precision of S ≥ 7 on the uniform stratum ≥ 0.8', () => {
  const u = report.gemPrecision.uniform;
  assert.ok(u.precision >= 0.8, `${u.genuine} of ${u.n}`);
  assert.equal(TARGETS.gemPrecisionUniform, 0.8);
});

test('§14.6: Goodhart (dressed) AUC ≥ 0.43 pooled and ≥ 0.29 uniform', () => {
  assert.ok(report.goodhart.pooled >= 0.43, `pooled ${report.goodhart.pooled.toFixed(4)}`);
  assert.ok(report.goodhart.uniform >= 0.29, `uniform ${report.goodhart.uniform.toFixed(4)}`);
  assert.equal(TARGETS.goodhartPooled, 0.43);
  assert.equal(TARGETS.goodhartUniform, 0.29);
});

test('§14.4: the stars AUC, printed for contrast, is the measured 0.864 pooled and 0.619 uniform', () => {
  assert.ok(Math.abs(report.starsAuc.pooled - 0.864) < 0.005, String(report.starsAuc.pooled));
  assert.ok(Math.abs(report.starsAuc.uniform - 0.619) < 0.005, String(report.starsAuc.uniform));
  assert.ok(report.auc.uniform > report.starsAuc.uniform);
});

test('§14.4: the uniform Brier score is at most 0.06 and the refit stays within 0.05', () => {
  assert.ok(report.quality.brierUniform <= 0.06, String(report.quality.brierUniform));
  const refit = report.quality.refit;
  assert.ok(refit);
  assert.ok(Math.abs(refit.a - config.calibration.a) <= 0.05);
  assert.ok(Math.abs(refit.b - config.calibration.b) <= 0.05);
});

test('bootstrap intervals bracket the AUCs', () => {
  assert.ok(report.auc.pooledCi.lo <= report.auc.pooled && report.auc.pooled <= report.auc.pooledCi.hi);
  assert.ok(report.auc.uniformCi.lo <= report.auc.uniform && report.auc.uniform <= report.auc.uniformCi.hi);
});

test('§14.6: every named-set expectation of §14.2 holds', () => {
  const named = report.named;
  assert.ok(named);
  assert.equal(named.results.length, 28);
  for (const r of named.results) assert.deepEqual(r.problems, [], `${r.nwo} (${r.set})`);
  assert.equal(named.ok, true);
  assert.equal(named.setRules.length, 1);
  assert.ok(named.setRules[0].ok, `hard-negative median ${named.setRules[0].median} against `
    + `${named.setRules[0].seedMedian}`);
});

test('every lure and spam repository is quarantined or dropped by the gate its expectation names', () => {
  const lures = report.named?.results.filter((r) => r.set === 'luresAndSpam') ?? [];
  assert.equal(lures.length, 5);
  for (const r of lures) assert.deepEqual(r.problems, [], r.nwo);
});

test('the report checks every §14.6 target and none falls short', () => {
  const short = report.checks.filter((c) => c.ok === false).map((c) => c.id);
  assert.deepEqual(short, []);
  assert.ok(report.checks.every((c) => c.ok !== null), 'every check is measurable on the fixtures');
  const text = formatReport(report).join('\n');
  for (const c of report.checks) assert.ok(text.includes(c.label), c.label);
  assert.match(text, /Named sets: 28 of 28 expectations hold/);
});

test('§14.2: montezuma-p/harken is a gem-band seed that leaves the gem lanes only through Rising', () => {
  const harken = report.named?.results.find((r) => r.nwo === 'montezuma-p/harken');
  assert.ok(harken?.ok, harken?.problems.join('; '));
  assert.equal(harken.band, 'gem');
  assert.ok(harken.S >= 7, String(harken.S));
  if (harken.lane === 'rising') assert.ok((harken.gain4w ?? 0) >= 10, String(harken.gain4w));
  else assert.ok(['promising', 'proven'].includes(harken.lane), harken.lane);
});
