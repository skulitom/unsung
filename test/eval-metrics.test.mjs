// @ts-check
/**
 * DESIGN §12.5 `src/eval/metrics.mjs`: AUC, precision@k, Brier score, reliability, bootstrap
 * intervals, Cohen's κ and LR+, checked against hand-computed values and brute force.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mulberry32 } from '../src/core/util.mjs';
import {
  auc, aucBy, bootstrap, brier, cohenKappa, confusion, lrPlus, median, pairedBootstrap, precisionAtK,
  quantile, reliability,
} from '../src/eval/metrics.mjs';

/**
 * @param {number[]} pos
 * @param {number[]} neg
 * @returns {number}
 */
function bruteAuc(pos, neg) {
  let s = 0;
  for (const p of pos) for (const n of neg) s += p > n ? 1 : p === n ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

test('auc: separation, reversal, ties and a hand-computed case', () => {
  assert.equal(auc([3, 4], [1, 2]), 1);
  assert.equal(auc([1, 2], [3, 4]), 0);
  assert.equal(auc([2, 2], [2, 2, 2]), 0.5);
  assert.equal(auc([3, 2], [1, 2]), 0.875);
  assert.ok(Number.isNaN(auc([], [1])));
  assert.ok(Number.isNaN(auc([1], [])));
  assert.throws(() => auc([1, NaN], [0]), TypeError);
});

test('auc equals the brute-force pair count on random scores with many ties', () => {
  const rand = mulberry32(42);
  for (let trial = 0; trial < 20; trial++) {
    const pos = Array.from({ length: 5 + Math.floor(rand() * 30) }, () => Math.floor(rand() * 8));
    const neg = Array.from({ length: 5 + Math.floor(rand() * 30) }, () => Math.floor(rand() * 8) - 2);
    assert.ok(Math.abs(auc(pos, neg) - bruteAuc(pos, neg)) < 1e-12);
  }
});

test('aucBy takes a property name or an accessor', () => {
  const rows = [{ S: 9, g: true }, { S: 7, g: true }, { S: 7, g: false }, { S: 1, g: false }];
  assert.equal(aucBy(rows, 'S', (r) => r.g), 0.875);
  assert.equal(aucBy(rows, (r) => -r.S, (r) => r.g), 0.125);
});

test('precisionAtK counts positives among the first k', () => {
  const rows = [true, false, true, true];
  const id = (/** @type {boolean} */ x) => x;
  assert.equal(precisionAtK(rows, id, 2), 0.5);
  assert.equal(precisionAtK(rows, id, 10), 0.75);
  assert.ok(Number.isNaN(precisionAtK(rows, id, 0)));
  assert.ok(Number.isNaN(precisionAtK([], id, 5)));
});

test('brier is the mean squared error of probabilities', () => {
  assert.equal(brier([1, 0], [1, 0]), 0);
  assert.equal(brier([0.5, 0.5], [1, 0]), 0.25);
  assert.ok(Math.abs(brier([0.8], [true]) - 0.04) < 1e-12);
  assert.throws(() => brier([0.5], [1, 0]), RangeError);
  assert.ok(Number.isNaN(brier([], [])));
});

test('reliability puts predictions into equal-width bins', () => {
  const bins = reliability([0.05, 0.15, 0.15, 0.95, 1], [0, 1, 0, 1, 1], 10);
  assert.equal(bins.length, 10);
  assert.deepEqual(bins[0], { lo: 0, hi: 0.1, n: 1, meanP: 0.05, rate: 0 });
  assert.equal(bins[1].n, 2);
  assert.equal(bins[1].rate, 0.5);
  assert.equal(bins[9].n, 2, 'a prediction of exactly 1 falls in the last bin');
  assert.equal(bins[5].meanP, null);
  assert.equal(bins[5].rate, null);
});

test('quantile and median interpolate between order statistics', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4], 0), 1);
  assert.equal(quantile([1, 2, 3, 4], 1), 4);
  assert.equal(median([9, 1, 5]), 5);
  assert.ok(Number.isNaN(median([])));
});

test('bootstrap is reproducible with a seed and brackets the estimate', () => {
  const rows = Array.from({ length: 60 }, (_, i) => i % 7);
  const mean = (/** @type {number[]} */ xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const a = bootstrap(mean, rows, { n: 300, rand: mulberry32(9) });
  const b = bootstrap(mean, rows, { n: 300, rand: mulberry32(9) });
  assert.deepEqual(a, b);
  assert.equal(a.estimate, mean(rows));
  assert.ok(a.lo <= a.estimate && a.estimate <= a.hi);
  assert.equal(a.n, 300);
});

test('bootstrap skips resamples where the statistic is undefined', () => {
  const rows = [{ S: 1, g: true }, { S: 0, g: false }];
  const both = (/** @type {typeof rows} */ rs) => rs.some((x) => x.g) && rs.some((x) => !x.g);
  const aucOf = (/** @type {typeof rows} */ rs) => (both(rs) ? aucBy(rs, 'S', (x) => x.g) : NaN);
  const r = bootstrap(aucOf, rows, { n: 200, rand: mulberry32(3) });
  assert.ok(r.n < 200 && r.n > 0);
  assert.equal(r.lo, 1);
});

test('a grouped bootstrap resamples whole groups', () => {
  const rows = ['a', 'a', 'b', 'b', 'c', 'c', 'd', 'd'].map((owner, i) => ({ owner, i }));
  const whole = (/** @type {{owner: string}[]} */ rs) => {
    /** @type {Record<string, number>} */
    const c = {};
    for (const r of rs) c[r.owner] = (c[r.owner] ?? 0) + 1;
    return Object.values(c).every((n) => n % 2 === 0) ? 1 : 0;
  };
  const r = bootstrap(whole, rows, { n: 200, rand: mulberry32(5), group: (x) => x.owner });
  assert.equal(r.lo, 1);
  assert.equal(r.hi, 1);
});

test('pairedBootstrap measures a difference on shared resamples', () => {
  const rows = Array.from({ length: 40 }, (_, i) => i);
  const mean = (/** @type {number[]} */ xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const same = pairedBootstrap(mean, mean, rows, { n: 100, rand: mulberry32(1) });
  assert.deepEqual([same.diff, same.lo, same.hi], [0, 0, 0]);
  const plusOne = pairedBootstrap((xs) => mean(xs) + 1, mean, rows, { n: 100, rand: mulberry32(1) });
  assert.ok(Math.abs(plusOne.lo - 1) < 1e-12 && Math.abs(plusOne.hi - 1) < 1e-12);
});

test('cohenKappa matches a textbook 2×2 table', () => {
  // 20 both yes, 5 A yes / B no, 10 A no / B yes, 15 both no: po 0.7, pe 0.5, κ 0.4.
  /** @type {string[]} */
  const a = [];
  /** @type {string[]} */
  const b = [];
  const add = (/** @type {string} */ x, /** @type {string} */ y, /** @type {number} */ n) => {
    for (let i = 0; i < n; i++) {
      a.push(x);
      b.push(y);
    }
  };
  add('y', 'y', 20);
  add('y', 'n', 5);
  add('n', 'y', 10);
  add('n', 'n', 15);
  assert.ok(Math.abs(cohenKappa(a, b) - 0.4) < 1e-12);
  assert.equal(cohenKappa(['G', 'C'], ['G', 'C']), 1);
  assert.equal(cohenKappa(['G', 'G'], ['G', 'G']), 1);
  assert.ok(Number.isNaN(cohenKappa([], [])));
  assert.throws(() => cohenKappa(['G'], []), RangeError);
});

test('lrPlus: sensitivity over the false-positive rate, Haldane-corrected at zero cells', () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => ({ pos: true, hit: i < 8 })),
    ...Array.from({ length: 20 }, (_, i) => ({ pos: false, hit: i < 2 })),
  ];
  assert.ok(Math.abs(lrPlus(rows, (r) => r.hit, (r) => r.pos) - 8) < 1e-12);
  assert.deepEqual(confusion(rows, (r) => r.hit, (r) => r.pos), { tp: 8, fp: 2, fn: 2, tn: 18 });
  const perfect = [
    ...Array.from({ length: 5 }, () => ({ pos: true, hit: true })),
    ...Array.from({ length: 10 }, () => ({ pos: false, hit: false })),
  ];
  const expected = (5.5 / 6) / (0.5 / 11);
  assert.ok(Math.abs(lrPlus(perfect, (r) => r.hit, (r) => r.pos) - expected) < 1e-12);
  const withUnknown = [...rows, { pos: true, hit: null }, { pos: false, hit: null }];
  assert.equal(lrPlus(withUnknown, (r) => r.hit, (r) => r.pos), lrPlus(rows, (r) => r.hit, (r) => r.pos));
  assert.ok(Number.isNaN(lrPlus(rows.filter((r) => r.pos), (r) => r.hit, (r) => r.pos)));
  assert.ok(Number.isNaN(lrPlus(rows, () => false, (r) => r.pos)), 'a signal that never fires has no LR+');
});
