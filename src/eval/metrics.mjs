// @ts-check
/**
 * Evaluation metrics (DESIGN §14.4, §14.5): AUC, precision@k, the Brier score and reliability of
 * Quality, bootstrap intervals (plain, grouped and paired), Cohen's κ and per-signal LR+.
 *
 * Pure functions of their inputs. Randomness is a parameter (`rand`, a generator of floats in
 * [0, 1)); without one a fixed-seed Mulberry32 generator is used, so reports are reproducible.
 */

import { mulberry32 } from '../core/util.mjs';

/**
 * @param {unknown} x
 * @param {string} what
 * @returns {number}
 */
function finite(x, what) {
  const n = typeof x === 'boolean' ? Number(x) : x;
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    throw new TypeError(`${what} must be a finite number, got ${String(x).slice(0, 40)}`);
  }
  return n;
}

/**
 * AUC of scores: the chance that a random positive outscores a random negative, ties counting
 * one half (the Mann–Whitney statistic, computed from mid-ranks). NaN when either side is empty.
 * @param {number[]} pos scores of the positives
 * @param {number[]} neg scores of the negatives
 * @returns {number}
 */
export function auc(pos, neg) {
  if (pos.length === 0 || neg.length === 0) return NaN;
  /** @type {[number, number][]} */
  const all = [
    ...pos.map((x) => /** @type {[number, number]} */ ([finite(x, 'A score'), 1])),
    ...neg.map((x) => /** @type {[number, number]} */ ([finite(x, 'A score'), 0])),
  ].sort((p, q) => p[0] - q[0]);
  let rankSum = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j < all.length && all[j][0] === all[i][0]) j++;
    const midRank = (i + 1 + j) / 2;
    for (let t = i; t < j; t++) if (all[t][1] === 1) rankSum += midRank;
    i = j;
  }
  const np = pos.length;
  return (rankSum - (np * (np + 1)) / 2) / (np * neg.length);
}

/**
 * @template T
 * @param {string | ((row: T) => unknown)} key
 * @returns {(row: T) => unknown}
 */
function getter(key) {
  return typeof key === 'function' ? key : (row) => /** @type {any} */ (row)?.[key];
}

/**
 * AUC of one field (or a function) over rows, positives chosen by `isPos`.
 * @template T
 * @param {T[]} rows
 * @param {string | ((row: T) => unknown)} key property name or accessor giving the score
 * @param {(row: T) => boolean} isPos
 * @returns {number}
 */
export function aucBy(rows, key, isPos) {
  const get = getter(key);
  /** @type {number[]} */
  const pos = [];
  /** @type {number[]} */
  const neg = [];
  for (const r of rows) (isPos(r) ? pos : neg).push(finite(get(r), 'A score'));
  return auc(pos, neg);
}

/**
 * Share of positives among the first `k` rows of an already sorted list. NaN when there are none.
 * @template T
 * @param {T[]} sorted best first
 * @param {(row: T) => boolean} isPos
 * @param {number} k
 * @returns {number}
 */
export function precisionAtK(sorted, isPos, k) {
  const top = sorted.slice(0, Math.max(0, Math.floor(k)));
  if (top.length === 0) return NaN;
  return top.filter((r) => isPos(r)).length / top.length;
}

/**
 * Brier score: the mean squared difference between predicted probabilities and outcomes.
 * @param {number[]} ps predicted probabilities
 * @param {(number | boolean)[]} ys outcomes, 1/0 or true/false
 * @returns {number}
 */
export function brier(ps, ys) {
  if (ps.length !== ys.length) throw new RangeError('brier needs as many outcomes as predictions');
  if (ps.length === 0) return NaN;
  let sum = 0;
  for (let i = 0; i < ps.length; i++) {
    const d = finite(ps[i], 'A probability') - finite(ys[i], 'An outcome');
    sum += d * d;
  }
  return sum / ps.length;
}

/**
 * @typedef {object} ReliabilityBin
 * @property {number} lo lower edge (inclusive)
 * @property {number} hi upper edge (exclusive, except the last bin, which includes 1)
 * @property {number} n predictions in the bin
 * @property {number | null} meanP mean prediction, null when the bin is empty
 * @property {number | null} rate observed rate of positives, null when the bin is empty
 */

/**
 * Reliability table: predictions in `bins` equal-width bins over [0, 1], with the mean prediction
 * and the observed rate in each.
 * @param {number[]} ps
 * @param {(number | boolean)[]} ys
 * @param {number} [bins]
 * @returns {ReliabilityBin[]}
 */
export function reliability(ps, ys, bins = 10) {
  if (ps.length !== ys.length) throw new RangeError('reliability needs as many outcomes as predictions');
  const nb = Math.max(1, Math.floor(bins));
  const acc = Array.from({ length: nb }, () => ({ n: 0, p: 0, y: 0 }));
  for (let i = 0; i < ps.length; i++) {
    const p = finite(ps[i], 'A probability');
    const b = Math.min(nb - 1, Math.max(0, Math.floor(p * nb)));
    acc[b].n++;
    acc[b].p += p;
    acc[b].y += finite(ys[i], 'An outcome');
  }
  return acc.map((a, i) => ({
    lo: i / nb,
    hi: (i + 1) / nb,
    n: a.n,
    meanP: a.n ? a.p / a.n : null,
    rate: a.n ? a.y / a.n : null,
  }));
}

/**
 * Quantile of sorted values (linear interpolation between order statistics). NaN when empty.
 * @param {number[]} sorted ascending
 * @param {number} q in [0, 1]
 * @returns {number}
 */
export function quantile(sorted, q) {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Median of numbers (NaN when empty).
 * @param {number[]} xs
 * @returns {number}
 */
export function median(xs) {
  return quantile([...xs].sort((a, b) => a - b), 0.5);
}

/**
 * @typedef {object} BootstrapOptions
 * @property {number} [n] resamples (default 1000)
 * @property {() => number} [rand] generator of floats in [0, 1) (default Mulberry32 seeded 1)
 * @property {number} [alpha] 1 − the interval's coverage (default 0.05, a 95 % interval)
 * @property {(row: any) => string} [group] resample whole groups (for example owners, §14.5)
 */

/**
 * Rows split into the clusters a bootstrap resamples: one per row, or one per `group` key.
 * @template T
 * @param {T[]} rows
 * @param {((row: T) => string) | undefined} group
 * @returns {T[][]}
 */
function clustersOf(rows, group) {
  if (!group) return rows.map((r) => [r]);
  /** @type {Map<string, T[]>} */
  const by = new Map();
  for (const r of rows) {
    const k = String(group(r));
    const list = by.get(k) ?? [];
    list.push(r);
    by.set(k, list);
  }
  return [...by.values()];
}

/**
 * One resample: as many clusters as there are, drawn with replacement.
 * @template T
 * @param {T[][]} clusters
 * @param {() => number} rand
 * @returns {T[]}
 */
function resample(clusters, rand) {
  /** @type {T[]} */
  const out = [];
  for (let i = 0; i < clusters.length; i++) {
    out.push(...clusters[Math.floor(rand() * clusters.length)]);
  }
  return out;
}

/**
 * The percentile interval of finite resampled values.
 * @param {number[]} values
 * @param {number} alpha
 * @returns {{lo: number, hi: number, n: number}}
 */
function interval(values, alpha) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return { lo: quantile(sorted, alpha / 2), hi: quantile(sorted, 1 - alpha / 2), n: sorted.length };
}

/**
 * Percentile bootstrap interval of a statistic. Resamples on which the statistic is not a finite
 * number (for example an AUC without positives) are skipped; `n` reports how many counted.
 * @template T
 * @param {(rows: T[]) => number} fn
 * @param {T[]} rows
 * @param {BootstrapOptions} [opts]
 * @returns {{estimate: number, lo: number, hi: number, n: number}}
 */
export function bootstrap(fn, rows, opts = {}) {
  const { n = 1000, rand = mulberry32(1), alpha = 0.05, group } = opts;
  const clusters = clustersOf(rows, group);
  /** @type {number[]} */
  const values = [];
  for (let i = 0; i < n; i++) values.push(fn(resample(clusters, rand)));
  return { estimate: fn(rows), ...interval(values, alpha) };
}

/**
 * Paired bootstrap of the difference `fnA − fnB` (§8.5, §14.5): both statistics are computed on the
 * same resamples, so their shared noise cancels.
 * @template T
 * @param {(rows: T[]) => number} fnA
 * @param {(rows: T[]) => number} fnB
 * @param {T[]} rows
 * @param {BootstrapOptions} [opts]
 * @returns {{diff: number, lo: number, hi: number, n: number}}
 */
export function pairedBootstrap(fnA, fnB, rows, opts = {}) {
  const { n = 1000, rand = mulberry32(1), alpha = 0.05, group } = opts;
  const clusters = clustersOf(rows, group);
  /** @type {number[]} */
  const values = [];
  for (let i = 0; i < n; i++) {
    const sample = resample(clusters, rand);
    values.push(fnA(sample) - fnB(sample));
  }
  return { diff: fnA(rows) - fnB(rows), ...interval(values, alpha) };
}

/**
 * Cohen's κ between two raters' labels of the same items (§14.3: revise the guide below 0.6).
 * 1 when both give every item the same single label; NaN when there are no items.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function cohenKappa(a, b) {
  if (a.length !== b.length) throw new RangeError('cohenKappa needs two label lists of the same length');
  const n = a.length;
  if (n === 0) return NaN;
  /** @type {Map<string, [number, number]>} */
  const marg = new Map();
  let agree = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === b[i]) agree++;
    const ma = marg.get(a[i]) ?? [0, 0];
    ma[0]++;
    marg.set(a[i], ma);
    const mb = marg.get(b[i]) ?? [0, 0];
    mb[1]++;
    marg.set(b[i], mb);
  }
  const po = agree / n;
  let pe = 0;
  for (const [x, y] of marg.values()) pe += (x / n) * (y / n);
  if (pe >= 1) return 1;
  return (po - pe) / (1 - pe);
}

/**
 * Confusion counts of a binary signal: rows where `hit` returns null (the signal was unknown or did
 * not apply) are left out.
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => boolean | null} hit
 * @param {(row: T) => boolean} isPos
 * @returns {{tp: number, fp: number, fn: number, tn: number}}
 */
export function confusion(rows, hit, isPos) {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const r of rows) {
    const h = hit(r);
    if (h === null || h === undefined) continue;
    const p = isPos(r);
    if (h && p) c.tp++;
    else if (h) c.fp++;
    else if (p) c.fn++;
    else c.tn++;
  }
  return c;
}

/**
 * Positive likelihood ratio of a signal: `P(hit | genuine) / P(hit | not genuine)` (§14.3). NaN
 * when either class is absent or the signal never fires (0 / 0). Otherwise, when a cell of the 2×2
 * table is empty, 0.5 is added to every cell (Haldane–Anscombe), so the ratio stays finite.
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => boolean | null} hit null for rows where the signal is unknown or `na`
 * @param {(row: T) => boolean} isPos
 * @returns {number}
 */
export function lrPlus(rows, hit, isPos) {
  let { tp, fp, fn, tn } = confusion(rows, hit, isPos);
  if (tp + fn === 0 || fp + tn === 0 || tp + fp === 0) return NaN;
  if (tp === 0 || fp === 0 || fn === 0 || tn === 0) {
    tp += 0.5;
    fp += 0.5;
    fn += 0.5;
    tn += 0.5;
  }
  return (tp / (tp + fn)) / (fp / (fp + tn));
}
