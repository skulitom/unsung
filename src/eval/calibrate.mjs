// @ts-check
/**
 * Calibration of points into Quality (DESIGN §6.2, §14.3): `Q = σ(a + b·S)`.
 *
 * The slope `b` comes from a logistic fit of "genuine" on `S` over every label; the intercept `a`
 * is then set so that the mean predicted rate on the uniform stratum equals that stratum's
 * smoothed base rate, `(genuine + prior[0]) / (n + prior[0] + prior[1])` — 10 / 71 = 0.141 on the
 * research labels. The numerics follow research/raw/haystack/final_eval.py, which produced c1:
 * Newton–Raphson from (a, b) = (0, 0.5) with 1e-6 added to the Hessian's diagonal, then 200
 * bisection steps for the intercept in [−20, 20]. One safeguard is added: a Newton step that would
 * lower the likelihood is halved until it does not, so poorly scaled data cannot make the fit
 * diverge. On the research labels every full step is taken, so c1 is reproduced exactly.
 */

import { sigmoid } from '../core/util.mjs';

/** @typedef {import('../core/schema.mjs').Calibration} Calibration */

/** The method name recorded in `config/calibration.json` (§4.4). */
export const CALIBRATION_METHOD = 'platt-pooled-slope-uniform-intercept';

/**
 * @typedef {object} PlattRow a scored label row
 * @property {number} S points
 * @property {string} [label] `G` counts as genuine unless `isPos` says otherwise
 * @property {string} [stratum] rows whose stratum equals `uniform` set the intercept
 */

/**
 * @typedef {object} PlattFit
 * @property {number} a intercept matched to the uniform stratum's base rate
 * @property {number} b slope from the pooled logistic fit
 * @property {number} base smoothed base rate of the uniform stratum
 * @property {number} n rows fitted
 * @property {number} pooledA intercept of the pooled fit, before the uniform adjustment
 * @property {number} uniform rows in the uniform stratum
 * @property {number} positives genuine rows
 * @property {number} uniformPositives genuine rows in the uniform stratum
 * @property {number} iterations Newton steps taken
 */

/**
 * `log(1 + e^z)`, without overflow.
 * @param {number} z
 * @returns {number}
 */
function softplus(z) {
  return z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z));
}

/**
 * Log-likelihood of 0/1 outcomes under `σ(a + b·x)`.
 * @param {number} a
 * @param {number} b
 * @param {number[]} xs
 * @param {number[]} ys
 * @returns {number}
 */
function logLik(a, b, xs, ys) {
  let ll = 0;
  for (let i = 0; i < xs.length; i++) {
    const z = a + b * xs[i];
    ll -= ys[i] ? softplus(-z) : softplus(z);
  }
  return ll;
}

/**
 * Fit Platt calibration (§6.2). Without uniform rows the pooled intercept is kept and `base` is the
 * smoothed pooled rate.
 * @param {PlattRow[]} rows
 * @param {{uniform?: string, prior?: [number, number], isPos?: (row: any) => boolean}} [opts]
 * @returns {PlattFit}
 */
export function fitPlatt(rows, opts = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new RangeError('fitPlatt needs at least one scored row');
  }
  const uniformName = opts.uniform ?? 'uniform';
  const [pa, pb] = opts.prior ?? [1, 1];
  const isPos = opts.isPos ?? ((/** @type {any} */ r) => r.label === 'G');
  const xs = rows.map((r) => {
    if (typeof r.S !== 'number' || !Number.isFinite(r.S)) throw new TypeError('Every row needs a finite S');
    return r.S;
  });
  const ys = rows.map((r) => (isPos(r) ? 1 : 0));

  let a = 0;
  let b = 0.5;
  let ll = logLik(a, b, xs, ys);
  let iterations = 0;
  while (iterations < 100) {
    iterations++;
    let ga = 0;
    let gb = 0;
    let haa = 1e-6;
    let hab = 0;
    let hbb = 1e-6;
    for (let i = 0; i < xs.length; i++) {
      const p = sigmoid(a + b * xs[i]);
      const e = p - ys[i];
      const w = p * (1 - p);
      ga += e;
      gb += e * xs[i];
      haa += w;
      hab += w * xs[i];
      hbb += w * xs[i] * xs[i];
    }
    const det = haa * hbb - hab * hab;
    const da = (hbb * ga - hab * gb) / det;
    const db = (haa * gb - hab * ga) / det;
    let step = 1;
    let next = logLik(a - da, b - db, xs, ys);
    while (!(next >= ll - 1e-12 * Math.abs(ll)) && step > 1e-9) {
      step /= 2;
      next = logLik(a - step * da, b - step * db, xs, ys);
    }
    a -= step * da;
    b -= step * db;
    ll = next;
    if (Math.abs(step * da) + Math.abs(step * db) < 1e-10) break;
  }

  const positives = ys.reduce((s, y) => s + y, 0);
  const uIdx = rows.map((r, i) => (r.stratum === uniformName ? i : -1)).filter((i) => i >= 0);
  const uniformPositives = uIdx.reduce((s, i) => s + ys[i], 0);
  if (uIdx.length === 0) {
    const base = (positives + pa) / (rows.length + pa + pb);
    return { a, b, base, n: rows.length, pooledA: a, uniform: 0, positives, uniformPositives: 0, iterations };
  }
  const base = (uniformPositives + pa) / (uIdx.length + pa + pb);
  let lo = -20;
  let hi = 20;
  for (let step = 0; step < 200; step++) {
    const mid = (lo + hi) / 2;
    let m = 0;
    for (const i of uIdx) m += sigmoid(mid + b * xs[i]);
    m /= uIdx.length;
    if (m > base) hi = mid;
    else lo = mid;
  }
  return {
    a: (lo + hi) / 2, b, base, n: rows.length, pooledA: a, uniform: uIdx.length, positives, uniformPositives,
    iterations,
  };
}

/**
 * The next version name: a trailing number is incremented (`c1` → `c2`), else `-2` is appended.
 * @param {string} version
 * @returns {string}
 */
export function bumpVersion(version) {
  const m = /^(.*?)(\d+)$/.exec(String(version));
  return m ? `${m[1]}${Number(m[2]) + 1}` : `${version}-2`;
}

/**
 * @param {number} x
 * @returns {number}
 */
function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/**
 * Whether a fit would change the stored calibration (its `a` or `b` at three decimals).
 * @param {Partial<Calibration>} current
 * @param {PlattFit} fit
 * @returns {boolean}
 */
export function calibrationChanged(current, fit) {
  return round3(fit.a) !== current.a || round3(fit.b) !== current.b;
}

/**
 * The calibration file that a fit produces (§4.4): version bumped, `a`, `b` and `base` rounded to
 * three decimals, what it was fitted on, and a changelog entry `{version, date, change, evidence}`
 * appended to the current file's changelog (§4.4: every change is logged).
 * @param {Partial<Calibration> & {changelog?: unknown[]}} current
 * @param {PlattFit} fit
 * @param {{date: string, weights: string, evidence?: string}} opts `date` as YYYY-MM-DD; `weights`
 *   the weights version the rows were scored with
 * @returns {Calibration & {changelog: unknown[]}}
 */
export function nextCalibration(current, fit, opts) {
  const version = bumpVersion(current.version ?? 'c0');
  const a = round3(fit.a);
  const b = round3(fit.b);
  const change = `Refit a from ${current.a} to ${a} and b from ${current.b} to ${b}`;
  const evidence = opts.evidence ?? `${fit.n} labels (${fit.positives} genuine); uniform stratum `
    + `${fit.uniform} (${fit.uniformPositives} genuine), smoothed base rate ${round3(fit.base)}; `
    + `points from weights ${opts.weights}`;
  const history = Array.isArray(current.changelog) ? current.changelog : [];
  return {
    version,
    method: CALIBRATION_METHOD,
    a,
    b,
    fittedOn: {
      labels: fit.n, uniform: fit.uniform, positives: fit.positives, uniformPositives: fit.uniformPositives,
      base: round3(fit.base), weights: opts.weights,
    },
    fittedAt: opts.date,
    changelog: [...history, { version, date: opts.date, change, evidence }],
  };
}
