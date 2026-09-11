// @ts-check
/**
 * DESIGN §6.2, §4.4, §12.5 and §14.6: `config/calibration.json` holds c1 exactly, and `fitPlatt`
 * on the labelled fixtures reproduces its `a` and `b` within ±0.05. Also the fit's numerics on
 * synthetic data and the next-version file `unsung calibrate --write` produces.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { validateCalibration } from '../src/core/schema.mjs';
import { quality } from '../src/core/score.mjs';
import { sigmoid } from '../src/core/util.mjs';
import {
  CALIBRATION_METHOD, bumpVersion, calibrationChanged, fitPlatt, nextCalibration,
} from '../src/eval/calibrate.mjs';
import { scoreRows } from '../src/eval/evaluate.mjs';
import { labelledFromFixtures } from '../src/eval/labels.mjs';
import { brier } from '../src/eval/metrics.mjs';
import * as fixtures from './support/fixtures.mjs';

const CONFIG_DIR = new URL('../config/', import.meta.url);
const calibration = JSON.parse(readFileSync(new URL('calibration.json', CONFIG_DIR), 'utf8'));
const config = loadConfig(new URL('.', CONFIG_DIR).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const scored = scoreRows(labelledFromFixtures(fixtures), config);

test('config/calibration.json is c1 exactly as §4.4 states, and validates', () => {
  assert.deepEqual(validateCalibration(calibration), []);
  const { changelog, ...rest } = calibration;
  assert.deepEqual(rest, {
    version: 'c1',
    method: 'platt-pooled-slope-uniform-intercept',
    a: -6.403,
    b: 1.113,
    fittedOn: { labels: 149, uniform: 69, positives: 74, uniformPositives: 9, base: 0.141, weights: 'w1' },
    fittedAt: '2026-09-11',
  });
  assert.equal(CALIBRATION_METHOD, calibration.method);
  assert.ok(Array.isArray(changelog) && changelog.some((c) => c.version === 'c1'), 'c1 is in the changelog');
});

test('§6.2 table: Quality at S = 3…10 under c1', () => {
  const table = { 3: 0.04, 4: 0.12, 5: 0.3, 6: 0.57, 7: 0.8, 8: 0.92, 9: 0.97, 10: 0.99 };
  for (const [S, q] of Object.entries(table)) {
    assert.equal(Math.round(100 * quality(Number(S), calibration)) / 100, q, `S = ${S}`);
  }
});

test('§14.6: fitPlatt on the labelled fixtures reproduces a and b within ±0.05', () => {
  const fit = fitPlatt(scored, { uniform: 'uniform', prior: [1, 1] });
  assert.ok(Math.abs(fit.a - calibration.a) <= 0.05, `a ${fit.a.toFixed(4)} against ${calibration.a}`);
  assert.ok(Math.abs(fit.b - calibration.b) <= 0.05, `b ${fit.b.toFixed(4)} against ${calibration.b}`);
  assert.equal(fit.n, calibration.fittedOn.labels);
  assert.equal(fit.uniform, calibration.fittedOn.uniform);
  assert.equal(fit.positives, calibration.fittedOn.positives);
  assert.equal(fit.uniformPositives, calibration.fittedOn.uniformPositives);
  assert.equal(Math.round(fit.base * 1000) / 1000, calibration.fittedOn.base);
  assert.ok(fit.iterations < 100, 'Newton converged');
});

test('§14.4: the uniform Brier score of Quality is at most 0.06 (measured 0.041)', () => {
  const uni = scored.filter((r) => r.stratum === 'uniform');
  const b = brier(uni.map((r) => quality(r.S, calibration)), uni.map((r) => (r.label === 'G' ? 1 : 0)));
  assert.ok(b <= 0.06, `Brier ${b.toFixed(4)}`);
});

test('fitPlatt recovers known parameters from synthetic data', () => {
  const a0 = -5;
  const b0 = 0.9;
  /** @type {{S: number, label: string, stratum: string}[]} */
  const rows = [];
  for (let S = -2; S <= 12; S++) {
    const pos = Math.round(2000 * sigmoid(a0 + b0 * S));
    for (let i = 0; i < 2000; i++) rows.push({ S, label: i < pos ? 'G' : 'C', stratum: 'uniform' });
  }
  const fit = fitPlatt(rows, { uniform: 'uniform', prior: [0, 0] });
  assert.ok(Math.abs(fit.b - b0) < 0.01, `b ${fit.b}`);
  assert.ok(Math.abs(fit.a - a0) < 0.05, `a ${fit.a}`);
  assert.ok(Math.abs(fit.a - fit.pooledA) < 1e-6, 'every row uniform and no prior: the intercepts agree');
});

test('the intercept makes the mean prediction on the uniform stratum equal its smoothed base rate', () => {
  const fit = fitPlatt(scored, { uniform: 'uniform', prior: [1, 1] });
  const uni = scored.filter((r) => r.stratum === 'uniform');
  const mean = uni.reduce((s, r) => s + sigmoid(fit.a + fit.b * r.S), 0) / uni.length;
  assert.ok(Math.abs(mean - fit.base) < 1e-9);
  assert.ok(Math.abs(fit.base - 10 / 71) < 1e-12, 'base (9 + 1) / (69 + 2)');
});

test('without uniform rows the pooled intercept is kept', () => {
  const rows = scored.map((r) => ({ S: r.S, label: r.label, stratum: 'search' }));
  const fit = fitPlatt(rows);
  assert.equal(fit.a, fit.pooledA);
  assert.equal(fit.uniform, 0);
});

test('fitPlatt refuses empty input and rows without points', () => {
  assert.throws(() => fitPlatt([]), RangeError);
  assert.throws(() => fitPlatt([{ S: NaN, label: 'G' }]), TypeError);
});

test('bumpVersion increments a trailing number', () => {
  assert.equal(bumpVersion('c1'), 'c2');
  assert.equal(bumpVersion('c9'), 'c10');
  assert.equal(bumpVersion('cal'), 'cal-2');
});

test('nextCalibration writes the next version with a changelog entry, and validates', () => {
  const fit = fitPlatt(scored, { uniform: 'uniform', prior: [1, 1] });
  const next = nextCalibration(calibration, fit, { date: '2026-10-01', weights: 'w1' });
  assert.deepEqual(validateCalibration(next), []);
  assert.equal(next.version, 'c2');
  assert.equal(next.method, CALIBRATION_METHOD);
  assert.equal(next.a, Math.round(fit.a * 1000) / 1000);
  assert.equal(next.b, Math.round(fit.b * 1000) / 1000);
  assert.deepEqual(next.fittedOn, {
    labels: 149, uniform: 69, positives: 74, uniformPositives: 9, base: 0.141, weights: 'w1',
  });
  assert.equal(next.fittedAt, '2026-10-01');
  assert.deepEqual(next.changelog.map((c) => /** @type {any} */ (c).version), ['c1', 'c2']);
  assert.match(/** @type {any} */ (next.changelog[1]).change, /Refit a from -6\.403 to/);
  assert.equal(calibrationChanged(calibration, fit), next.a !== calibration.a || next.b !== calibration.b);
  assert.equal(calibrationChanged({ a: next.a, b: next.b }, fit), false);
});
