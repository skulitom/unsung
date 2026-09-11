// @ts-check
/**
 * Explanations (DESIGN §6.8): the words behind every number in a Score. No number reaches the UI
 * without one of these.
 *
 * `explain(score, weights)` returns the §6.8 fields — `headline`, `chips`, `top`, `negatives`,
 * `whyNotHigher`, `raiseConfidence`, `rankLine` — and, additively, one line for each remaining
 * number: `pointsLine` (points and coverage), `qualityLine`, `bandLine`, `confidenceLine`,
 * `attentionLine`, `laneLine`, and `gateLines` and `descriptorLines`. Pure; British English.
 */

import { CONFIDENCE_ITEMS, ORG_OWNER_MAX, SIGNALS } from './signals.mjs';
import { COVERAGE_FLOOR, SCORE_DEFAULTS, countedIds, groupStrengths, weightOf } from './score.mjs';

/** @typedef {import('./schema.mjs').Score} Score */
/** @typedef {import('./schema.mjs').Signal} Signal */
/** @typedef {import('./schema.mjs').Evidence} Evidence */
/** @typedef {import('./schema.mjs').Calibration} Calibration */

/** Order of the positive signals for `top` and `whyNotHigher` (§6.8). */
export const TOP_ORDER = Object.freeze([
  'q.release', 'p.testsRun', 'p.shipped', 'q.tests', 'q.examples', 'p.coherent', 'q.usage', 'q.ci',
  'q.manifest', 'q.deps', 'q.code', 'q.licence', 'q.readme',
]);

/** Names of the lanes as the explorer shows them (§10.2). */
export const LANE_LABELS = Object.freeze({
  quarantine: 'Quarantine', gone: 'Gone', institutional: 'Institutional', graduated: 'Graduated',
  rising: 'Rising', doubted: 'Doubted', proven: 'Proven', promising: 'Promising', look: 'Worth a look',
  low: 'Low',
});

const SCORING = new Set(['quality', 'proof', 'slop', 'judge']);
const HINTS = new Map(SIGNALS.map((d) => [d.id, d.hint]));
const ITEMS = new Map(CONFIDENCE_ITEMS.map((d) => [d.id, d]));

/**
 * @typedef {object} Chip
 * @property {string} id
 * @property {string} kind
 * @property {string} label
 * @property {number} points what the signal adds to `S` (0 unless it is hit)
 * @property {number} weight its points when hit
 * @property {'hit' | 'miss' | 'unknown' | 'na'} status
 * @property {boolean} counted false for a group member outweighed by a larger penalty (§6.1)
 * @property {boolean} provisional
 * @property {string | null} group
 * @property {string} reason
 * @property {Evidence[]} evidence
 */

/**
 * @typedef {object} Reason a hit signal as a reason line
 * @property {string} id
 * @property {string} label
 * @property {number} points
 * @property {string} reason
 * @property {Evidence[]} evidence
 */

/**
 * @typedef {object} Hint a positive signal not yet earned
 * @property {string} id
 * @property {string} label
 * @property {number} points what it would add
 * @property {'miss' | 'unknown'} status
 * @property {string} hint what it takes, and whether it is not yet known
 * @property {string} reason what was measured
 */

/**
 * @typedef {object} ConfidenceHint a confidence item not yet at its strength
 * @property {string} id
 * @property {string} label
 * @property {number} strength
 * @property {number} max
 * @property {'ok' | 'unknown'} status
 * @property {string} hint
 * @property {string} reason
 */

/**
 * @typedef {object} Explanation
 * @property {string} headline `8 points · Quality 92 · Confidence medium · 0 stars`
 * @property {Chip[]} chips every quality, proof, slop and judge signal, in registry order
 * @property {Reason[]} top up to three hit positive signals, in `TOP_ORDER`
 * @property {Reason[]} negatives up to two counted slop penalties, most negative first
 * @property {Hint[]} whyNotHigher missed or unknown positive signals, in `TOP_ORDER`
 * @property {ConfidenceHint[]} raiseConfidence
 * @property {string} rankLine `Rank 8.45 = 8 points + 0.45 confidence − 0.00 attention`
 * @property {string} pointsLine `8 of 13 points · evidence coverage 92%`
 * @property {string} qualityLine
 * @property {string} bandLine
 * @property {string} confidenceLine
 * @property {string} attentionLine
 * @property {string} laneLine
 * @property {string[]} gateLines
 * @property {string[]} descriptorLines
 */

/**
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
function plural(n, one, many = `${one}s`) {
  return `${n} ${Math.abs(n) === 1 ? one : many}`;
}

/**
 * Two decimals, never "-0.00".
 * @param {number} x
 * @returns {string}
 */
function f2(x) {
  const s = (Number.isFinite(x) ? x : 0).toFixed(2);
  return s === '-0.00' ? '0.00' : s;
}

/**
 * @param {number} x
 * @returns {number}
 */
function pct(x) {
  return Math.round(100 * (Number.isFinite(x) ? x : 0));
}

/**
 * Lower-case the first letter of a reason or label for use mid-sentence, unless it starts an
 * acronym: `Workflow files…` becomes `workflow files…`, while `CI…` and `README…` are kept.
 * @param {string} s
 * @returns {string}
 */
function lowerFirst(s) {
  return s ? s.replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase()) : s;
}

/**
 * Points with a sign, as chips show them: `+1`, `−2`, `0`.
 * @param {number} n
 * @returns {string}
 */
export function signedPoints(n) {
  if (n > 0) return `+${n}`;
  if (n < 0) return `−${-n}`;
  return '0';
}

/**
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
 * @returns {'hit' | 'miss' | 'unknown' | 'na'}
 */
function chipStatus(s) {
  if (s.status === 'ok') return s.hit ? 'hit' : 'miss';
  return s.status === 'na' ? 'na' : 'unknown';
}

/**
 * @param {Signal} s
 * @returns {Reason}
 */
function reasonOf(s) {
  return { id: s.id, label: s.label, points: s.points ?? 0, reason: s.reason, evidence: s.evidence ?? [] };
}

/**
 * @param {Signal} s
 * @param {any} weights
 * @returns {Hint}
 */
function hintOf(s, weights) {
  const w = weightOf(s, weights);
  const base = HINTS.get(s.id) ?? `+${w} for ${lowerFirst(s.label)}`;
  const unknown = s.status !== 'ok';
  return {
    id: s.id,
    label: s.label,
    points: w,
    status: unknown ? 'unknown' : 'miss',
    hint: unknown ? `${base}; not known yet (${lowerFirst(s.reason)})` : base,
    reason: s.reason,
  };
}

/**
 * @param {Signal} it
 * @param {any} weights
 * @returns {string}
 */
function groupKey(it, weights) {
  return it.group ?? weights?.confidence?.[it.id]?.group ?? it.id;
}

/**
 * The strongest a confidence item can be: the weights file's `max`, else the registry's. An
 * organisation's owner history is capped at `ORG_OWNER_MAX` (§5.4), so its ceiling is that.
 * @param {Signal} it
 * @param {any} weights
 * @returns {number}
 */
function maxOf(it, weights) {
  const w = weights?.confidence?.[it.id]?.max;
  const base = typeof w === 'number' && Number.isFinite(w) ? w : ITEMS.get(it.id)?.max ?? 1;
  if (it.id === 'k.owner' && /** @type {any} */ (it.value)?.ownerType === 'Organization') {
    return Math.min(base, ORG_OWNER_MAX);
  }
  return base;
}

/**
 * Confidence items that could still raise `K`: below their own strongest value, in a group whose
 * current strength is below that value too (§6.4: only the strongest item in a group counts).
 * Unknown items are listed (§6.4).
 * @param {Signal[]} items
 * @param {any} weights
 * @returns {ConfidenceHint[]}
 */
function raiseConfidenceOf(items, weights) {
  const groups = groupStrengths(items, weights);
  /** @type {ConfidenceHint[]} */
  const out = [];
  for (const it of items) {
    if (it.kind !== 'confidence') continue;
    const max = maxOf(it, weights);
    const strength = it.status === 'ok' && typeof it.strength === 'number' ? it.strength : 0;
    if (strength >= max || (groups.get(groupKey(it, weights)) ?? 0) >= max) continue;
    const base = ITEMS.get(it.id)?.hint ?? it.label;
    const unknown = it.status !== 'ok';
    out.push({
      id: it.id,
      label: it.label,
      strength,
      max,
      status: unknown ? 'unknown' : 'ok',
      hint: unknown ? `${base}; not known yet (${lowerFirst(it.reason)})` : base,
      reason: it.reason,
    });
  }
  return out;
}

/**
 * @param {Score} score
 * @param {any} weights
 * @returns {string}
 */
function confidenceLineOf(score, weights) {
  const items = score.confidence?.items ?? [];
  const groups = groupStrengths(items, weights);
  /** @type {string[]} */
  const parts = [];
  for (const [g, s] of groups) {
    if (s <= 0) continue;
    const best = items.find((it) => groupKey(it, weights) === g && it.status === 'ok' && it.strength === s);
    parts.push(`${best?.label ?? g} ${f2(s)}`);
  }
  const k = score.confidence?.k ?? 0;
  const what = parts.length ? parts.join(', ') : 'nothing corroborates it yet';
  return `Confidence ${f2(k)} (${score.confidence?.band ?? 'low'}): ${what}`;
}

/**
 * @param {Score} score
 * @param {any} weights
 * @returns {string}
 */
function laneLineOf(score, weights) {
  const S = score.S;
  const k = score.confidence?.k ?? 0;
  const gates = score.gates ?? [];
  /** @param {string} action */
  const reasons = (action) => gates.filter((g) => g.action === action).map((g) => g.reason).join('; ');
  const provenK = setting(weights, 'lanes', 'provenK');
  switch (score.lane) {
    case 'quarantine':
      return `Quarantine: ${reasons('quarantine') || 'a hard gate fired'}`;
    case 'gone':
      return 'Gone: not found at the last re-check';
    case 'institutional':
      return `Institutional: ${reasons('institutional') || 'owned by an institution'}`;
    case 'graduated':
      return `Graduated: ${plural(score.attention?.stars ?? 0, 'star')}, more than the `
        + `${setting(weights, 'eligibility', 'maxStars')} an unsung repository may have`;
    case 'rising':
      return `Rising: ${plural(score.attention?.gain4w ?? 0, 'star')} gained in the last four weeks `
        + `(${setting(weights, 'eligibility', 'risingGain4w')} or more)`;
    case 'doubted': {
      const judge = (score.signals ?? []).find((s) => s.kind === 'judge' && s.status === 'ok');
      const why = reasons('doubt') || judge?.reason || 'the review doubts it';
      return `Doubted: ${why}`;
    }
    case 'proven':
      return `Proven: in the gem band, and confidence ${f2(k)} reaches the ${f2(provenK)} Proven needs`;
    case 'promising':
      return `Promising: in the gem band; confidence ${f2(k)} is below the ${f2(provenK)} Proven needs`;
    case 'look':
      return `Worth a look: ${plural(S, 'point')}, short of the gem band`;
    default: {
      const look = setting(weights, 'bands', 'look');
      return `Low: ${plural(S, 'point')}, below the ${look} that Worth a look needs`;
    }
  }
}

/**
 * @param {Score} score
 * @param {any} weights
 * @returns {string}
 */
function bandLineOf(score, weights) {
  const S = score.S;
  const gem = setting(weights, 'bands', 'gem');
  const look = setting(weights, 'bands', 'look');
  if (score.band === 'gem') return `Gem band: ${plural(S, 'point')} reaches the ${gem} a gem needs`;
  if (score.band === 'look') {
    return `Worth a look: ${plural(S, 'point')} is between ${look} and ${gem - 1}; a gem needs ${gem}`;
  }
  return `Low: ${plural(S, 'point')} is below the ${look} that Worth a look needs`;
}

/**
 * Explain a Score (§6.8).
 * @param {Score} score
 * @param {any} [weights] `config/weights.json` (thresholds and the rank's weights; §6 defaults)
 * @param {{calibration?: Partial<Calibration> | null}} [opts] the calibration, to say what Quality
 *   was fitted on
 * @returns {Explanation}
 */
export function explain(score, weights = null, opts = {}) {
  const signals = score.signals ?? [];
  const counted = countedIds(signals, weights);
  const byId = new Map(signals.map((s) => [s.id, s]));
  /** @param {Signal | undefined} s */
  const hitPos = (s) => Boolean(s && s.status === 'ok' && s.hit && (s.points ?? 0) > 0);
  /** @param {Signal} s */
  const penalty = (s) => s.kind === 'slop' && s.status === 'ok' && s.hit === true && counted.has(s.id)
    && (s.points ?? 0) < 0;

  /** @type {Chip[]} */
  const chips = signals.filter((s) => SCORING.has(s.kind)).map((s) => ({
    id: s.id,
    kind: s.kind,
    label: s.label,
    points: s.points ?? 0,
    weight: weightOf(s, weights),
    status: chipStatus(s),
    counted: counted.has(s.id),
    provisional: s.provisional === true,
    group: s.group ?? null,
    reason: s.reason,
    evidence: s.evidence ?? [],
  }));

  const top = TOP_ORDER.map((id) => byId.get(id)).filter(hitPos).slice(0, 3)
    .map((s) => reasonOf(/** @type {Signal} */ (s)));
  const order = new Map(signals.map((s, i) => [s.id, i]));
  const negatives = signals.filter(penalty)
    .sort((a, b) => (a.points ?? 0) - (b.points ?? 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .slice(0, 2)
    .map(reasonOf);
  const whyNotHigher = TOP_ORDER.map((id) => byId.get(id))
    .filter((s) => s && weightOf(s, weights) > 0 && (s.status === 'unknown' || (s.status === 'ok' && !s.hit)))
    .map((s) => hintOf(/** @type {Signal} */ (s), weights));

  const S = score.S;
  const k = score.confidence?.k ?? 0;
  const a = score.attention?.a ?? 0;
  const stars = score.attention?.stars ?? 0;
  const forks = score.attention?.forks ?? 0;
  const kW = setting(weights, 'gem', 'kWeight');
  const aW = setting(weights, 'gem', 'aWeight');
  const gain = score.attention?.gain4w;

  const cal = opts.calibration;
  const on = /** @type {any} */ (cal?.fittedOn);
  const basis = on && typeof on.labels === 'number'
    ? `${on.labels} labels, ${on.uniformPositives ?? '?'} genuine in the uniform sample; `
      + `calibration ${cal?.version ?? score.model?.calibration}`
    : `calibration ${score.model?.calibration ?? 'c1'}`;
  const coverageNote = score.coverage < COVERAGE_FLOOR ? ' (incomplete evidence)' : '';

  return {
    headline: `${plural(S, 'point')} · Quality ${pct(score.quality)} · `
      + `Confidence ${score.confidence?.band ?? 'low'} · ${plural(stars, 'star')}`,
    chips,
    top,
    negatives,
    whyNotHigher,
    raiseConfidence: raiseConfidenceOf(score.confidence?.items ?? [], weights),
    rankLine: `Rank ${f2(score.gem)} = ${plural(S, 'point')} + ${f2(kW * k)} confidence `
      + `− ${f2(aW * a)} attention`,
    pointsLine: `${S} of ${plural(score.pointsMax, 'point')} · evidence coverage ${pct(score.coverage)}%`
      + coverageNote,
    qualityLine: `Quality ${pct(score.quality)}: the estimated share of genuine repositories among labelled `
      + `ones with ${plural(S, 'point')} (${basis})`,
    bandLine: bandLineOf(score, weights),
    confidenceLine: confidenceLineOf(score, weights),
    attentionLine: `Attention ${f2(a)}: ${plural(stars, 'star')}, ${plural(forks, 'fork')}`
      + `${typeof gain === 'number' ? `, ${gain} gained in the last four weeks` : ''}`
      + `; it lowers the rank by ${f2(aW * a)} and never changes Quality`,
    laneLine: laneLineOf(score, weights),
    gateLines: (score.gates ?? []).map((g) => `${g.id} (${g.action}): ${g.reason}`),
    descriptorLines: (score.descriptors ?? []).map((d) => (d.detail ? `${d.label}: ${d.detail}` : d.label)),
  };
}

/**
 * How points changed between two scores of the same repository, for example from the enrich to the
 * deep stage: `7 points at enrich; 8 at deep (+1 README matches the code)`.
 * @param {Score} before
 * @param {Score} after
 * @param {{before?: string, after?: string}} [names]
 * @returns {string}
 */
export function stageLine(before, after, names = {}) {
  const was = new Map((before.signals ?? []).map((s) => [s.id, s.points ?? 0]));
  const moves = (after.signals ?? [])
    .filter((s) => SCORING.has(s.kind) && (s.points ?? 0) !== (was.get(s.id) ?? 0))
    .map((s) => `${signedPoints((s.points ?? 0) - (was.get(s.id) ?? 0))} ${s.label}`);
  const tail = moves.length ? ` (${moves.join(', ')})` : '';
  const first = `${plural(before.S, 'point')} at ${names.before ?? 'enrich'}`;
  return `${first}; ${after.S} at ${names.after ?? 'deep'}${tail}`;
}

/**
 * An explanation as printable lines, for `unsung explain`.
 * @param {Score} score
 * @param {Explanation} ex
 * @param {{title?: string, extra?: string[]}} [opts]
 * @returns {string[]}
 */
export function formatExplanation(score, ex, opts = {}) {
  const lane = /** @type {Record<string, string>} */ (LANE_LABELS)[score.lane] ?? score.lane;
  const out = [opts.title ?? `${score.nwo} · ${lane}`];
  for (const l of [ex.headline, ex.rankLine, ex.pointsLine, ...(opts.extra ?? []), ex.laneLine, ex.bandLine,
    ex.qualityLine, ex.confidenceLine, ex.attentionLine]) out.push(`  ${l}`);
  out.push('  Chips:');
  for (const c of ex.chips) {
    const pts = c.status === 'hit' ? signedPoints(c.points).padStart(3) : '   ';
    const mark = c.status === 'hit' ? '' : ` [${c.status}]`;
    const note = c.counted ? '' : ' (not counted: a larger penalty in its group counts)';
    // A hit on a signal retired to weight 0 (§5.3: `s.incoherent` since w2) is shown, never scored.
    const retired = c.status === 'hit' && c.weight === 0 ? ' (noted, not scored)' : '';
    out.push(`    ${pts}  ${c.label}${mark}: ${c.reason}${note}${retired}`);
    // Each chip's evidence on GitHub, pinned to the scored commit where the signal knows it, under
    // the label (§6.8). Only github.com links are printed; repository text never becomes a URL here.
    const urls = new Set();
    for (const e of c.evidence ?? []) {
      const url = String(e?.url ?? '');
      if (/^https:\/\/github\.com\/\S+$/.test(url) && !urls.has(url)) {
        urls.add(url);
        out.push(`         ${url}`);
      }
    }
  }
  if (ex.negatives.length) out.push(`  Against: ${ex.negatives.map((n) => n.label).join(', ')}`);
  if (ex.whyNotHigher.length) {
    out.push('  Why not higher:');
    for (const h of ex.whyNotHigher) {
      out.push(`    ${signedPoints(h.points).padStart(3)}  ${h.label}: ${h.hint}`);
    }
  }
  if (ex.raiseConfidence.length) {
    out.push('  What would raise confidence:');
    for (const h of ex.raiseConfidence) {
      out.push(`    ${h.label} (${f2(h.strength)} of ${f2(h.max)}): ${h.hint}`);
    }
  }
  out.push(`  Descriptors: ${ex.descriptorLines.length ? ex.descriptorLines.join(' · ') : 'none'}`);
  out.push(`  Gates: ${ex.gateLines.length ? '' : 'none'}`);
  for (const g of ex.gateLines) out.push(`    ${g}`);
  return out;
}
