// @ts-check
/**
 * What a verdict of the optional LLM review does to a repository (DESIGN §8.5): the `llm.review`
 * judge signal (+1 or −2 points), the Doubted lane, and the export block. Pure: a verdict in, a
 * signal or a decision out. Every claim in a stored verdict's `output` has already been verified
 * against the evidence pack by `src/llm/validate.mjs`, so the rules here count claims as they are.
 *
 * Only a verdict with status `ok` (at least two verified claims) has any effect on points or lanes.
 */

/** @typedef {import('./schema.mjs').Verdict} Verdict */
/** @typedef {import('./schema.mjs').VerdictOutput} VerdictOutput */
/** @typedef {import('./schema.mjs').Signal} Signal */
/** @typedef {import('./schema.mjs').Evidence} Evidence */

/** Id of the judge signal. */
export const JUDGE_SIGNAL_ID = 'llm.review';

/** Categories whose confident, supported verdict costs two points (§8.5). */
export const ADVERSE_CATEGORIES = Object.freeze(['C', 'S', 'D', 'P', 'E']);

/** Flags that put a repository in the Doubted lane when a verified claim backs them (§8.5). */
export const DOUBT_FLAGS = Object.freeze(['malware_suspect', 're_upload', 'tutorial_clone']);

/** Flags that keep a repository out of the gallery (§8.5, §11.2). */
export const EXPORT_BLOCKING_FLAGS = Object.freeze(['do_not_promote', 'malware_suspect']);

/** Claim dimensions that can back an adverse category or a doubt flag. */
const BACKING_SUPPORTS = Object.freeze(['category', 'originality']);

/** Default points of the judge (§5.3): +1 to promote, −2 to demote. */
export const JUDGE_POINTS = Object.freeze({ promote: 1, demote: -2 });

/** Minimum `categoryConfidence` for the −2 (§8.5). */
export const DEMOTE_CONFIDENCE = 0.7;

/** Minimum mean score for the +1 (§8.5). */
export const PROMOTE_MEAN = 3.0;

/** Verified claims a verdict needs to have any effect (§8.5). */
export const MIN_CLAIMS = 2;

const UNSUPPORTED_REASON = `Fewer than ${MIN_CLAIMS} claims could be verified, so the review has no effect`;

/** @type {Record<string, string>} */
const CATEGORY_NAMES = {
  G: 'genuine',
  W: 'promising work in progress',
  C: 'coursework, tutorial or clone',
  P: 'personal config, notes or site',
  S: 'an AI scaffold with little substance',
  D: 'a data dump or mirror',
  X: 'spam, malware or a farm',
  E: 'near-empty',
};

/**
 * The verdict cache key of §3.11: `(id, headOid, rubric, backend, model)`, joined with `|`.
 * `store.getVerdict(key)` is asked with this string.
 * @param {{id: string, headOid?: string | null, rubric: string, backend: string, model?: string | null}} v
 * @returns {string}
 */
export function verdictKey(v) {
  return [v.id, v.headOid ?? 'HEAD', v.rubric, v.backend, v.model ?? ''].join('|');
}

/**
 * Mean of the five dimension scores, or null when any is missing.
 * @param {VerdictOutput['scores'] | null | undefined} scores
 * @returns {number | null}
 */
export function meanScore(scores) {
  if (!scores || typeof scores !== 'object') return null;
  const values = [scores.purpose, scores.craft, scores.verification, scores.honesty, scores.originality];
  if (!values.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * The judge's points from `weights.json#signals['llm.review'].points`: a number (0 turns the judge
 * off, as the demotion rule of §8.5 does), `[promote, demote]`, or `{promote, demote}`. Anything
 * else gives the §5.3 defaults.
 * @param {any} [weights]
 * @returns {{promote: number, demote: number}}
 */
export function judgePoints(weights) {
  const raw = weights?.signals?.[JUDGE_SIGNAL_ID]?.points;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw === 0 ? { promote: 0, demote: 0 } : { promote: Math.abs(raw), demote: -2 * Math.abs(raw) };
  }
  if (Array.isArray(raw) && raw.length === 2 && raw.every((x) => typeof x === 'number')) {
    return { promote: Math.max(0, raw[0]), demote: Math.min(0, raw[1]) };
  }
  if (raw && typeof raw === 'object' && typeof raw.promote === 'number' && typeof raw.demote === 'number') {
    return { promote: Math.max(0, raw.promote), demote: Math.min(0, raw.demote) };
  }
  return { ...JUDGE_POINTS };
}

/**
 * @param {VerdictOutput} out
 * @returns {boolean}
 */
function hasBackingClaim(out) {
  return (out.claims ?? []).some((c) => BACKING_SUPPORTS.includes(c.supports));
}

/**
 * @param {number} x
 * @returns {string}
 */
function oneDecimal(x) {
  return (Math.round(x * 10) / 10).toFixed(1);
}

/**
 * @param {number} n
 * @returns {string}
 */
function claimsText(n) {
  return `${n} verified claim${n === 1 ? '' : 's'}`;
}

/**
 * The effect of a verdict (§8.5 step 5): its points, its lane, and a one-line reason in British
 * English. Verdicts that are not `ok` have no effect.
 * @param {Pick<Verdict, 'status' | 'output'> | null | undefined} verdict
 * @param {{weights?: any}} [opts] `weights.json`, for the judge's points (default +1 / −2)
 * @returns {{points: number, lane: 'doubted' | null, reason: string}}
 */
export function verdictEffect(verdict, opts = {}) {
  if (!verdict) return { points: 0, lane: null, reason: 'Not reviewed' };
  const out = verdict.output;
  switch (verdict.status) {
    case 'ok':
      break;
    case 'unsupported':
      return { points: 0, lane: null, reason: UNSUPPORTED_REASON };
    case 'refused':
      return { points: 0, lane: null, reason: 'The model declined to review this repository' };
    case 'skipped-injection':
      return {
        points: 0, lane: null, reason: 'Not sent for review: the repository addresses an AI reviewer',
      };
    default:
      return { points: 0, lane: null, reason: 'The review failed, so it has no effect' };
  }
  if (!out) return { points: 0, lane: null, reason: 'The review has no output, so it has no effect' };

  const pts = judgePoints(opts.weights);
  const n = (out.claims ?? []).length;
  const mean = meanScore(out.scores);
  const name = CATEGORY_NAMES[out.category] ?? out.category;
  const conf = typeof out.categoryConfidence === 'number' ? out.categoryConfidence : 0;
  const backed = hasBackingClaim(out);
  const adverse = ADVERSE_CATEGORIES.includes(out.category) && conf >= DEMOTE_CONFIDENCE && backed;
  const doubtFlags = backed ? (out.flags ?? []).filter((f) => DOUBT_FLAGS.includes(f)) : [];

  if (n < MIN_CLAIMS) return { points: 0, lane: null, reason: UNSUPPORTED_REASON };
  if (out.injectionSeen === true) {
    return {
      points: 0,
      lane: 'doubted',
      reason: 'The reviewer found text in the repository addressing it; points are unchanged',
    };
  }
  if (adverse) {
    return {
      points: pts.demote,
      lane: 'doubted',
      reason: `Judged ${name} (confidence ${conf.toFixed(2)}) with ${claimsText(n)}`,
    };
  }
  if (out.category === 'X') {
    return { points: 0, lane: 'doubted', reason: `Judged ${name} with ${claimsText(n)}` };
  }
  if (doubtFlags.length > 0) {
    return {
      points: 0,
      lane: 'doubted',
      reason: `Flagged ${doubtFlags.join(', ').replace(/_/g, ' ')} with ${claimsText(n)}`,
    };
  }
  if (out.category === 'G' && mean !== null && mean >= PROMOTE_MEAN) {
    return {
      points: pts.promote,
      lane: null,
      reason: `Judged ${name} (mean ${oneDecimal(mean)}/4) with ${claimsText(n)}`,
    };
  }
  const meanText = mean === null ? '' : `, mean ${oneDecimal(mean)}/4`;
  return { points: 0, lane: null, reason: `Judged ${name}${meanText}; no change to points` };
}

/**
 * `https://github.com/<nwo>/blob/<headOid>/<path>` with each path segment encoded.
 * @param {string} nwo
 * @param {string | null | undefined} headOid
 * @param {string} p
 * @returns {string}
 */
function blobUrl(nwo, headOid, p) {
  const segments = String(p).split('/').map((s) => encodeURIComponent(s)).join('/');
  return `https://github.com/${nwo}/blob/${headOid ?? 'HEAD'}/${segments}`;
}

/**
 * Up to three verified claims as evidence links, each quote cut to 120 characters (§4.3).
 * @param {Verdict} verdict
 * @returns {Evidence[]}
 */
function claimEvidence(verdict) {
  const claims = verdict.output?.claims ?? [];
  return claims.slice(0, 3).map((c) => {
    const chars = Array.from(String(c.quote ?? ''));
    const quote = chars.length > 120 ? `${chars.slice(0, 119).join('')}…` : chars.join('');
    const label = `${c.supports}: ${c.path}`.slice(0, 200);
    return { label, url: blobUrl(verdict.nwo, verdict.headOid, c.path), quote };
  });
}

/**
 * The `llm.review` judge signal (§5.3, §8.5). With no verdict, or one that is not `ok`, the signal
 * is `unknown` with weight 0, so it neither scores nor counts toward `pointsMax`. With an `ok`
 * verdict its weight is the verdict's points (+1, −2 or 0) and it hits when that is not 0.
 * @param {Verdict | null | undefined} verdict
 * @param {{weights?: any}} [opts] `weights.json`, for the judge's points
 * @returns {Signal}
 */
export function verdictSignal(verdict, opts = {}) {
  /** @type {Signal} */
  const base = {
    id: JUDGE_SIGNAL_ID,
    kind: 'judge',
    status: 'unknown',
    hit: null,
    value: null,
    weight: 0,
    points: 0,
    strength: null,
    group: null,
    provisional: false,
    cost: null,
    label: 'LLM review',
    reason: 'Not reviewed (the LLM review is optional)',
    evidence: [],
  };
  if (!verdict) return base;
  const effect = verdictEffect(verdict, opts);
  if (verdict.status !== 'ok' || !verdict.output) return { ...base, reason: effect.reason };
  const out = verdict.output;
  const hit = effect.points !== 0;
  return {
    ...base,
    status: 'ok',
    hit,
    value: {
      category: out.category,
      mean: meanScore(out.scores),
      claims: (out.claims ?? []).length,
      lane: effect.lane,
    },
    weight: effect.points,
    points: hit ? effect.points : 0,
    reason: effect.reason,
    evidence: claimEvidence(verdict),
  };
}

/**
 * The lane a verdict imposes: `doubted` (§6.7 rule 6, §8.5) or null.
 * @param {Verdict | null | undefined} verdict
 * @returns {'doubted' | null}
 */
export function verdictLane(verdict) {
  return verdictEffect(verdict).lane;
}

/**
 * Whether a verdict keeps its repository out of the gallery (§8.5, §11.2): its output carries
 * `do_not_promote` or `malware_suspect`. Applies to any verdict with an output, whatever its status,
 * because blocking an export is the safe direction.
 * @param {Verdict | null | undefined} verdict
 * @returns {boolean}
 */
export function verdictBlocksExport(verdict) {
  const flags = verdict?.output?.flags;
  return Array.isArray(flags) && flags.some((f) => EXPORT_BLOCKING_FLAGS.includes(f));
}
