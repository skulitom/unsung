// @ts-check
/**
 * Scoring (DESIGN §6): points and coverage from the signals, the calibrated Quality, the band,
 * Confidence, Traction, the rank ("gem score") and the lane. Pure: Facts, configuration, an
 * optional verdict and a time in; a `Score` out.
 *
 * The three meters never blend (§0): `S` comes from the quality, proof, slop and judge signals
 * alone, Confidence from the confidence items, Attention from stars and forks. Confidence and
 * Attention move the rank by at most `kWeight` and `aWeight` points each (§6.6).
 *
 * Numbers that come out of floating-point sums (`coverage`, `k`, `gem`) are rounded to nine
 * decimal places, so that 1 − 0.7 is 0.3 and a threshold such as `K ≥ 0.5` is never missed by a
 * rounding error.
 */

import { evaluateGates } from './gates.mjs';
import { SCORING_KINDS } from './schema.mjs';
import { describe, evaluateConfidence, evaluateSignals } from './signals.mjs';
import { sat, sigmoid } from './util.mjs';
import { verdictLane, verdictSignal } from './verdict.mjs';

/** @typedef {import('./schema.mjs').Facts} Facts */
/** @typedef {import('./schema.mjs').Signal} Signal */
/** @typedef {import('./schema.mjs').Gate} Gate */
/** @typedef {import('./schema.mjs').Score} Score */
/** @typedef {import('./schema.mjs').Verdict} Verdict */
/** @typedef {import('./schema.mjs').Weights} Weights */
/** @typedef {import('./schema.mjs').Calibration} Calibration */
/** @typedef {import('./schema.mjs').Institutions} Institutions */
/** @typedef {import('./schema.mjs').Band} Band */
/** @typedef {import('./schema.mjs').Lane} Lane */
/** @typedef {Score['attention']} Attention */

/** The §6 values used when a weights file leaves a field out. */
export const SCORE_DEFAULTS = Object.freeze({
  bands: Object.freeze({ gem: 7, look: 5 }),
  gem: Object.freeze({ kWeight: 1.5, aWeight: 1.5 }),
  attention: Object.freeze({ saturation: 25 }),
  eligibility: Object.freeze({ maxStars: 25, risingGain4w: 10 }),
  confidenceBands: Object.freeze({ medium: 0.3, high: 0.6 }),
  lanes: Object.freeze({ provenK: 0.5 }),
});

/** The c1 calibration of §6.2, used when no calibration is given. */
export const DEFAULT_CALIBRATION = Object.freeze({ version: 'c1', a: -6.403, b: 1.113 });

/** Coverage below this marks a score "incomplete evidence" (§6.1). */
export const COVERAGE_FLOOR = 0.8;

/** Id of the judge signal (§5.3). */
const JUDGE = 'llm.review';

/**
 * Round away floating-point noise (nine decimal places).
 * @param {number} x
 * @returns {number}
 */
export function tidy(x) {
  const r = Math.round(x * 1e9) / 1e9;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * A numeric setting from the weights file, else its §6 default.
 * @param {any} weights
 * @param {keyof typeof SCORE_DEFAULTS} section
 * @param {string} key
 * @returns {number}
 */
function setting(weights, section, key) {
  const v = weights?.[section]?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : /** @type {any} */ (SCORE_DEFAULTS[section])[key];
}

/**
 * @param {Signal} s
 * @returns {boolean}
 */
function isScoring(s) {
  return /** @type {readonly string[]} */ (SCORING_KINDS).includes(s.kind);
}

/**
 * @param {Signal} s
 * @returns {boolean}
 */
function isJudge(s) {
  return s.kind === 'judge' || s.id === JUDGE;
}

/**
 * The weight of a scoring signal: its own `weight`, else the weights file's points, else 0.
 * @param {Signal} s
 * @param {any} weights
 * @returns {number}
 */
export function weightOf(s, weights) {
  if (typeof s.weight === 'number' && Number.isFinite(s.weight)) return s.weight;
  const w = weights?.signals?.[s.id]?.points;
  return typeof w === 'number' && Number.isFinite(w) ? w : 0;
}

/**
 * The group a signal belongs to (only the most negative contribution of a group counts), or null.
 * @param {Signal} s
 * @param {any} weights
 * @returns {string | null}
 */
export function groupOf(s, weights) {
  if (typeof s.group === 'string' && s.group) return s.group;
  const g = weights?.signals?.[s.id]?.group;
  return typeof g === 'string' && g ? g : null;
}

/**
 * What a signal adds to `S` on its own (§6.1): its weight when it is `ok` and hit, else 0.
 * @param {Signal} s
 * @param {any} [weights]
 * @returns {number}
 */
export function contribution(s, weights = null) {
  return s.status === 'ok' && s.hit === true ? weightOf(s, weights) : 0;
}

/**
 * Which scoring signals count toward `S`: every signal outside a group; within a group, the member
 * with the most negative contribution (the first on a tie) and every member that contributes
 * nothing. Only a group member outweighed by a larger penalty is left out (§6.1).
 * @param {Signal[]} signals
 * @param {any} [weights]
 * @returns {Set<string>} ids of the signals that count
 */
export function countedIds(signals, weights = null) {
  /** @type {Map<string, Signal>} */
  const worst = new Map();
  /** @type {Set<string>} */
  const out = new Set();
  for (const s of signals) {
    if (!isScoring(s)) continue;
    const g = groupOf(s, weights);
    if (!g) {
      out.add(s.id);
      continue;
    }
    if (contribution(s, weights) === 0) out.add(s.id);
    const cur = worst.get(g);
    if (!cur || contribution(s, weights) < contribution(cur, weights)) worst.set(g, s);
  }
  for (const s of worst.values()) out.add(s.id);
  return out;
}

/**
 * Points and coverage (§6.1).
 *
 * - `S` sums the contributions of the quality, proof, slop and judge signals; within a group only
 *   the most negative contribution counts.
 * - `pointsMax` sums the positive weights of those signals whose status is not `na`.
 * - `coverage` is Σ|weight| over `ok` signals ÷ Σ|weight| over signals that are not `na`, with the
 *   judge left out; 0 when nothing applies.
 * @param {Signal[]} signals
 * @param {any} [weights] `config/weights.json`, for signals that carry no weight or group
 * @returns {{S: number, pointsMax: number, coverage: number}}
 */
export function points(signals, weights = null) {
  const counted = countedIds(signals, weights);
  let S = 0;
  let pointsMax = 0;
  let covered = 0;
  let applicable = 0;
  for (const s of signals) {
    if (!isScoring(s)) continue;
    const w = weightOf(s, weights);
    if (counted.has(s.id)) S += contribution(s, weights);
    if (s.status === 'na') continue;
    if (w > 0) pointsMax += w;
    if (isJudge(s)) continue;
    applicable += Math.abs(w);
    if (s.status === 'ok') covered += Math.abs(w);
  }
  const coverage = applicable > 0 ? tidy(covered / applicable) : 0;
  return { S: tidy(S), pointsMax: tidy(pointsMax), coverage };
}

/**
 * Calibrated Quality (§6.2): `σ(a + b·S)`, the estimated share of genuine repositories among
 * labelled ones with this many points.
 * @param {number} S
 * @param {Partial<Calibration> | null} [calibration] default c1
 * @returns {number}
 */
export function quality(S, calibration = null) {
  const a = typeof calibration?.a === 'number' ? calibration.a : DEFAULT_CALIBRATION.a;
  const b = typeof calibration?.b === 'number' ? calibration.b : DEFAULT_CALIBRATION.b;
  return sigmoid(a + b * S);
}

/**
 * The band of a score (§6.3): `gem` at `S ≥ bands.gem`, `look` at `S ≥ bands.look`, else `low`.
 * @param {number} S
 * @param {any} [weights]
 * @returns {Band}
 */
export function band(S, weights = null) {
  if (S >= setting(weights, 'bands', 'gem')) return 'gem';
  if (S >= setting(weights, 'bands', 'look')) return 'look';
  return 'low';
}

/**
 * The confidence band of `K` (§6.4): `low` below `medium`, `medium` below `high`, else `high`.
 * @param {number} k
 * @param {any} [weights]
 * @returns {'low' | 'medium' | 'high'}
 */
export function confidenceBand(k, weights = null) {
  if (k >= setting(weights, 'confidenceBands', 'high')) return 'high';
  if (k >= setting(weights, 'confidenceBands', 'medium')) return 'medium';
  return 'low';
}

/**
 * The strongest strength per confidence group (§5.4). Unknown items contribute 0.
 * @param {Signal[]} items confidence items
 * @param {any} [weights]
 * @returns {Map<string, number>}
 */
export function groupStrengths(items, weights = null) {
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const it of items ?? []) {
    if (it.kind !== 'confidence') continue;
    const g = it.group ?? weights?.confidence?.[it.id]?.group ?? it.id;
    const known = it.status === 'ok' && typeof it.strength === 'number';
    const s = known ? Math.min(1, Math.max(0, /** @type {number} */ (it.strength))) : 0;
    out.set(g, Math.max(out.get(g) ?? 0, s));
  }
  return out;
}

/**
 * Confidence (§6.4): `K = 1 − Π over groups (1 − strongest strength in the group)`, and its band.
 * @param {Signal[]} items confidence items
 * @param {any} [weights] for the band thresholds (default 0.3 and 0.6)
 * @returns {{k: number, band: 'low' | 'medium' | 'high'}}
 */
export function confidence(items, weights = null) {
  let rest = 1;
  for (const s of groupStrengths(items, weights).values()) rest *= 1 - s;
  const k = tidy(1 - rest);
  return { k, band: confidenceBand(k, weights) };
}

/**
 * @param {unknown} x
 * @returns {number}
 */
function countOf(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0;
}

/**
 * Attention measures (§5.5, §6.5): stars, forks, watchers other than the owner, stars gained in
 * the last four weeks (null when star history is unknown) and `A = sat(stars + forks, 25)`.
 * @param {Facts} facts
 * @param {any} [weights]
 * @returns {Attention}
 */
export function attention(facts, weights = null) {
  const stars = countOf(facts?.stars);
  const forks = countOf(facts?.forks);
  const watchers = Math.max(0, countOf(facts?.watchers) - 1);
  const g = facts?.starHistory?.gain4w;
  const gain4w = typeof g === 'number' && Number.isFinite(g) ? g : null;
  const a = tidy(sat(stars + forks, setting(weights, 'attention', 'saturation')));
  return { stars, forks, watchers, gain4w, a };
}

/**
 * The rank (§6.6): `gem = S + kWeight·K − aWeight·A`.
 * @param {number} S
 * @param {number} k
 * @param {number} a
 * @param {any} [weights]
 * @returns {number}
 */
export function gemScore(S, k, a, weights = null) {
  return tidy(S + setting(weights, 'gem', 'kWeight') * k - setting(weights, 'gem', 'aWeight') * a);
}

/**
 * Whether a verdict puts its repository in the Doubted lane: the §8.5 rule of `verdictLane`, plus
 * §6.7's `malware_suspect` flag on any valid (`ok`) verdict, which errs on the safe side.
 * @param {Verdict | null | undefined} verdict
 * @returns {boolean}
 */
export function verdictDoubts(verdict) {
  if (!verdict) return false;
  if (verdictLane(verdict) === 'doubted') return true;
  const flags = verdict.status === 'ok' ? verdict.output?.flags : null;
  return Array.isArray(flags) && flags.includes('malware_suspect');
}

/**
 * @typedef {object} LaneInput
 * @property {Gate[]} [gates]
 * @property {Band} band
 * @property {number} k
 * @property {Attention | {stars?: number, gain4w?: number | null}} attention
 * @property {Verdict | null} [verdict]
 * @property {any} [weights]
 * @property {boolean} [gone] not found at the last re-check
 */

/**
 * The lane (§6.7): the first matching rule decides.
 *
 * 1 quarantine (a quarantine gate) · 2 gone · 3 institutional (an institutional gate) ·
 * 4 graduated (`stars > maxStars`) · 5 rising (`gain4w ≥ risingGain4w`) · 6 doubted (a doubt gate,
 * or a verdict that doubts) · 7 proven (gem band, `K ≥ provenK`) · 8 promising (gem band) ·
 * 9 look · 10 low. A `drop` gate does not name a lane: the pipeline does not keep such
 * repositories.
 * @param {LaneInput} input
 * @returns {Lane}
 */
export function laneOf(input) {
  const { gates = [], band: b, k, attention: att, verdict = null, weights = null, gone = false } = input;
  const has = (/** @type {string} */ action) => gates.some((g) => g.action === action);
  if (has('quarantine')) return 'quarantine';
  if (gone) return 'gone';
  if (has('institutional')) return 'institutional';
  if (countOf(att?.stars) > setting(weights, 'eligibility', 'maxStars')) return 'graduated';
  const gain = att?.gain4w;
  if (typeof gain === 'number' && gain >= setting(weights, 'eligibility', 'risingGain4w')) return 'rising';
  if (has('doubt') || verdictDoubts(verdict)) return 'doubted';
  if (b === 'gem') return k >= setting(weights, 'lanes', 'provenK') ? 'proven' : 'promising';
  if (b === 'look') return 'look';
  return 'low';
}

/**
 * The judge signal when `g.injection` has disabled the reviewer (§7.2): unknown, no points.
 * @param {any} weights
 * @returns {Signal}
 */
function disabledJudge(weights) {
  return {
    ...verdictSignal(null, { weights }),
    reason: 'The reviewer is disabled because the repository addresses an AI reviewer',
  };
}

/**
 * @typedef {object} ScoreOptions
 * @property {any} [weights] `config/weights.json`
 * @property {Partial<Calibration> | null} [calibration] `config/calibration.json`
 * @property {Partial<Institutions> | null} [institutions] `config/institutions.json`
 * @property {Verdict | null} [verdict] the valid verdict for the current `headOid`, if any
 * @property {string | null} [now] ISO time of scoring; default `facts.fetchedAt`
 * @property {boolean} [gone] not found at the last re-check (lane `gone`)
 */

/**
 * Score Facts (§6): evaluate every signal (the judge last, from the verdict), the confidence
 * items, the gates and the descriptors, then points, Quality, band, Confidence, Attention, the
 * rank and the lane. A `g.injection` gate disables the judge: its verdict is ignored and no
 * points change (§7.2).
 * @param {Facts} facts
 * @param {ScoreOptions} [opts]
 * @returns {Score}
 */
export function scoreFacts(facts, opts = {}) {
  const weights = opts.weights ?? null;
  const now = opts.now ?? facts.fetchedAt;
  const base = evaluateSignals(facts, { weights, now });
  const gates = evaluateGates(facts, base, { institutions: opts.institutions ?? null, now, weights });
  const judgeOff = gates.some((g) => g.id === 'g.injection');
  const verdict = judgeOff ? null : opts.verdict ?? null;
  const judge = judgeOff ? disabledJudge(weights) : verdictSignal(verdict, { weights });
  const signals = [...base, judge];
  const items = evaluateConfidence(facts, signals, { weights, now });

  const { S, pointsMax, coverage } = points(signals, weights);
  const b = band(S, weights);
  const conf = confidence(items, weights);
  const att = attention(facts, weights);
  const gone = opts.gone === true;
  const lane = laneOf({ gates, band: b, k: conf.k, attention: att, verdict, weights, gone });
  return {
    v: 1,
    id: facts.id,
    nwo: facts.nwo,
    headOid: facts.headOid ?? null,
    scoredAt: now,
    model: {
      weights: typeof weights?.version === 'string' ? weights.version : 'w1',
      calibration: typeof opts.calibration?.version === 'string' ? opts.calibration.version
        : DEFAULT_CALIBRATION.version,
      rubric: verdict && typeof verdict.rubric === 'string' ? verdict.rubric : null,
    },
    signals,
    S,
    pointsMax,
    coverage,
    quality: quality(S, opts.calibration),
    band: b,
    confidence: { k: conf.k, band: conf.band, items },
    attention: att,
    gem: gemScore(S, conf.k, att.a, weights),
    lane,
    gates,
    descriptors: describe(facts),
  };
}
