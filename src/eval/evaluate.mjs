// @ts-check
/**
 * `unsung eval` (DESIGN §14.4, §14.6): score every label row and report how well points separate
 * genuine repositories from the rest — pooled and uniform AUC with bootstrap intervals, the stars
 * AUC for contrast, the Goodhart (dressed) AUC, the bands and points against labels, precision of
 * the gem band and precision@k by rank, the Brier score and reliability of Quality, a refit of the
 * calibration, each signal's firing counts and LR+, and the named-set expectations of §14.2.
 *
 * `checks` compares the report with the §14.6 targets; a check that cannot be measured on the
 * labels given (for example a uniform AUC without uniform labels) has `ok: null`.
 */

import { scoreFacts } from '../core/score.mjs';
import { SIGNALS } from '../core/signals.mjs';
import { mulberry32 } from '../core/util.mjs';
import { fitPlatt } from './calibrate.mjs';
import { goodhartAuc } from './goodhart.mjs';
import { isGenuine } from './labels.mjs';
import { aucBy, bootstrap, brier, lrPlus, median, precisionAtK, reliability } from './metrics.mjs';

/** @typedef {import('../core/schema.mjs').Score} Score */
/** @typedef {import('./labels.mjs').LabelRow} LabelRow */
/** @typedef {import('./labels.mjs').NamedRow} NamedRow */

/** The numeric targets of §14.4 and §14.6. */
export const TARGETS = Object.freeze({
  aucPooled: 0.95,
  aucUniform: 0.93,
  gemPrecisionUniform: 0.8,
  goodhartPooled: 0.43,
  goodhartUniform: 0.29,
  brierUniform: 0.06,
  calibrationTolerance: 0.05,
  lrFloor: 2,
});

/**
 * @typedef {object} EvalConfig
 * @property {any} weights
 * @property {any} calibration
 * @property {any} [institutions]
 */

/**
 * @typedef {LabelRow & {score: Score, S: number, quality: number, gem: number, stars: number}} ScoredRow
 */

/**
 * The scoring options of a configuration.
 * @param {EvalConfig} config
 * @returns {{weights: any, calibration: any, institutions: any}}
 */
function scoringOpts(config) {
  return {
    weights: config.weights, calibration: config.calibration, institutions: config.institutions ?? null,
  };
}

/**
 * Score every row at its own time (`row.at`, else when its facts were fetched), with no verdict.
 * @param {LabelRow[]} rows
 * @param {EvalConfig} config
 * @returns {ScoredRow[]}
 */
export function scoreRows(rows, config) {
  const opts = scoringOpts(config);
  return rows.map((r) => {
    const score = scoreFacts(r.facts, { ...opts, now: r.at ?? r.facts.fetchedAt });
    return { ...r, score, S: score.S, quality: score.quality, gem: score.gem, stars: score.attention.stars };
  });
}

/**
 * @param {{label?: string}} r
 * @returns {'G' | 'W' | 'rest'}
 */
function kindOf(r) {
  return r.label === 'G' ? 'G' : r.label === 'W' ? 'W' : 'rest';
}

/**
 * Genuine, WIP and the rest per band.
 * @param {ScoredRow[]} rows
 * @returns {{band: string, n: number, G: number, W: number, rest: number}[]}
 */
function bandTable(rows) {
  return ['gem', 'look', 'low'].map((b) => {
    const t = { band: b, n: 0, G: 0, W: 0, rest: 0 };
    for (const r of rows) {
      if (r.score.band !== b) continue;
      t.n++;
      t[kindOf(r)]++;
    }
    return t;
  });
}

/**
 * Genuine, WIP and the rest per number of points, most points first.
 * @param {ScoredRow[]} rows
 * @returns {{S: number, G: number, W: number, rest: number}[]}
 */
function pointsTable(rows) {
  /** @type {Map<number, {S: number, G: number, W: number, rest: number}>} */
  const by = new Map();
  for (const r of rows) {
    const t = by.get(r.S) ?? { S: r.S, G: 0, W: 0, rest: 0 };
    t[kindOf(r)]++;
    by.set(r.S, t);
  }
  return [...by.values()].sort((a, b) => b.S - a.S);
}

/**
 * AUC of `S`, NaN unless both classes are present.
 * @param {ScoredRow[]} rows
 * @returns {number}
 */
function aucOfS(rows) {
  return rows.some(isGenuine) && rows.some((r) => !isGenuine(r)) ? aucBy(rows, 'S', isGenuine) : NaN;
}

/**
 * Index order (§6.7): rank descending, then stars ascending, then name.
 * @param {ScoredRow} a
 * @param {ScoredRow} b
 * @returns {number}
 */
function byRank(a, b) {
  return b.gem - a.gem || a.stars - b.stars || (a.nwo < b.nwo ? -1 : a.nwo > b.nwo ? 1 : 0);
}

/**
 * A value or list as a list; null when absent.
 * @param {unknown} v
 * @returns {string[] | null}
 */
function listOf(v) {
  if (v === null || v === undefined) return null;
  return Array.isArray(v) ? v.map(String) : [String(v)];
}

/**
 * The expectations of one named-set repository (§14.2) that its score breaks, as sentences.
 * `gates: []` means no quarantine, drop or doubt gate (an institutional gate marks a lane and may
 * fire); a non-empty list means at least one of those gates fires. A dropped repository has no
 * lane to check when a drop is what the set expects.
 * @param {Score} score
 * @param {Record<string, any> | null | undefined} expect
 * @returns {string[]}
 */
export function checkExpectation(score, expect) {
  const e = expect ?? {};
  /** @type {string[]} */
  const problems = [];
  const fired = score.gates ?? [];
  const dropped = fired.some((g) => g.action === 'drop');
  const lanes = listOf(e.lane);
  if (lanes && !(dropped && e.outcome === 'dropped') && !lanes.includes(score.lane)) {
    problems.push(`lane ${score.lane}, expected ${lanes.join(' or ')}`);
  }
  if (listOf(e.notLane)?.includes(score.lane)) problems.push(`lane ${score.lane}, which it must never be`);
  const bands = listOf(e.band);
  if (bands && !bands.includes(score.band)) {
    problems.push(`band ${score.band}, expected ${bands.join(' or ')}`);
  }
  if (typeof e.minS === 'number' && score.S < e.minS) {
    problems.push(`${score.S} points, expected at least ${e.minS}`);
  }
  if (typeof e.maxS === 'number' && score.S > e.maxS) {
    problems.push(`${score.S} points, expected at most ${e.maxS}`);
  }
  if (Array.isArray(e.gates)) {
    const blocking = fired.filter((g) => g.action !== 'institutional');
    if (e.gates.length === 0 && blocking.length > 0) {
      const ids = blocking.map((g) => g.id).join(', ');
      problems.push(`gated by ${ids}, expected no quarantine, drop or doubt gate`);
    }
    if (e.gates.length > 0 && !fired.some((g) => e.gates.includes(g.id))) {
      problems.push(`none of ${e.gates.join(', ')} fired`);
    }
  }
  if (e.outcome === 'quarantined' && score.lane !== 'quarantine') {
    problems.push(`lane ${score.lane}, expected quarantine`);
  }
  if (e.outcome === 'dropped' && !dropped) problems.push('not dropped by any gate');
  return problems;
}

/**
 * @typedef {object} NamedResult
 * @property {string} nwo
 * @property {string | null} set
 * @property {number} S
 * @property {number} enrichS points at the enrich stage
 * @property {string} band
 * @property {string} lane
 * @property {number} k
 * @property {number | null} gain4w
 * @property {string[]} gates ids of the gates that fired
 * @property {string[]} problems expectations broken
 * @property {boolean} ok
 */

/**
 * @typedef {object} NamedReport
 * @property {NamedResult[]} results
 * @property {{set: string, rule: string, ok: boolean, median: number, seedMedian: number}[]} setRules
 * @property {boolean} ok
 */

/**
 * Score the named sets (§14.2) at their recording time and check each expectation. The one set
 * rule §14.2 defines — a set's median `S` below the seed gems' median — is checked for every set
 * whose expectation carries a `setRule`.
 * @param {NamedRow[]} named
 * @param {EvalConfig} config
 * @returns {NamedReport}
 */
export function namedReport(named, config) {
  const opts = scoringOpts(config);
  /** @type {NamedResult[]} */
  const results = named.map((n) => {
    const score = scoreFacts(n.facts, { ...opts, now: n.at });
    const problems = checkExpectation(score, n.expect);
    return {
      nwo: n.nwo, set: n.set, S: score.S, enrichS: scoreFacts(n.enrich, { ...opts, now: n.at }).S,
      band: score.band, lane: score.lane, k: score.confidence.k, gain4w: score.attention.gain4w,
      gates: score.gates.map((g) => g.id), problems, ok: problems.length === 0,
    };
  });
  const seedMedian = median(results.filter((r) => r.set === 'seedGems').map((r) => r.S));
  /** @type {NamedReport['setRules']} */
  const setRules = [];
  for (const set of [...new Set(named.filter((n) => n.expect?.setRule).map((n) => String(n.set)))]) {
    const rule = String(named.find((n) => n.set === set)?.expect?.setRule);
    const m = median(results.filter((r) => r.set === set).map((r) => r.S));
    setRules.push({ set, rule, ok: Number.isFinite(seedMedian) && m < seedMedian, median: m, seedMedian });
  }
  return { results, setRules, ok: results.every((r) => r.ok) && setRules.every((r) => r.ok) };
}

/**
 * @typedef {object} SignalRow
 * @property {string} id
 * @property {string} kind
 * @property {number} G genuine rows on which it fires
 * @property {number} rest other rows on which it fires
 * @property {number} lrPooled LR+ over rows where it was evaluated
 * @property {number} lrUniform LR+ on the uniform stratum
 * @property {boolean} flagged a positive signal whose uniform LR+ is below 2 (§14.3 drift)
 */

/**
 * @typedef {object} Check
 * @property {string} id
 * @property {string} label
 * @property {number} value
 * @property {string} target
 * @property {boolean | null} ok null when it cannot be measured on these labels
 */

/**
 * @typedef {object} EvalReport
 * @property {{weights: string | null, calibration: string | null}} model
 * @property {{labels: number, genuine: number, uniform: number, uniformGenuine: number,
 *   bySource: Record<string, number>, byStratum: Record<string, number>}} counts
 * @property {{pooled: number, uniform: number, pooledCi: {lo: number, hi: number},
 *   uniformCi: {lo: number, hi: number}}} auc
 * @property {{pooled: number, uniform: number}} starsAuc
 * @property {{pooled: number, uniform: number}} goodhart
 * @property {{pooled: ReturnType<typeof bandTable>, uniform: ReturnType<typeof bandTable>}} bands
 * @property {{pooled: ReturnType<typeof pointsTable>, uniform: ReturnType<typeof pointsTable>}} byPoints
 * @property {{pooled: {n: number, genuine: number, precision: number},
 *   uniform: {n: number, genuine: number, precision: number}}} gemPrecision
 * @property {{k: number, pooled: number, uniform: number}} precisionAtK
 * @property {{brierUniform: number, brierPooled: number,
 *   reliability: import('./metrics.mjs').ReliabilityBin[],
 *   current: {version: string | null, a: number, b: number},
 *   refit: import('./calibrate.mjs').PlattFit | null}} quality
 * @property {SignalRow[]} signals
 * @property {NamedReport | null} named
 * @property {Check[]} checks
 * @property {boolean} ok every measurable check holds
 */

/**
 * @param {number} v
 * @param {number} target
 * @param {'min' | 'max'} dir
 * @returns {boolean | null}
 */
function meets(v, target, dir) {
  if (!Number.isFinite(v)) return null;
  return dir === 'min' ? v >= target : v <= target;
}

/**
 * A check against a lower bound.
 * @param {string} id
 * @param {string} label
 * @param {number} value
 * @param {number} target
 * @returns {Check}
 */
function atLeast(id, label, value, target) {
  return { id, label, value, target: `≥ ${target}`, ok: meets(value, target, 'min') };
}

/**
 * A check against an upper bound.
 * @param {string} id
 * @param {string} label
 * @param {number} value
 * @param {number} target
 * @param {string} [text]
 * @returns {Check}
 */
function atMost(id, label, value, target, text = `≤ ${target}`) {
  return { id, label, value, target: text, ok: meets(value, target, 'max') };
}

/**
 * Per-signal firing counts and LR+ (§5.3 evidence columns, §14.3 drift).
 * @param {ScoredRow[]} scored
 * @param {ScoredRow[]} uni
 * @returns {SignalRow[]}
 */
function signalRows(scored, uni) {
  return SIGNALS.map((def, i) => {
    /** @param {ScoredRow} r */
    const sig = (r) => (r.score.signals[i]?.id === def.id ? r.score.signals[i]
      : r.score.signals.find((s) => s.id === def.id));
    /** @param {ScoredRow} r */
    const fires = (r) => sig(r)?.status === 'ok' && sig(r)?.hit === true;
    /** @param {ScoredRow} r */
    const known = (r) => (sig(r)?.status === 'ok' ? sig(r)?.hit === true : null);
    const lrUniform = lrPlus(uni, known, isGenuine);
    return {
      id: def.id,
      kind: def.kind,
      G: scored.filter((r) => isGenuine(r) && fires(r)).length,
      rest: scored.filter((r) => !isGenuine(r) && fires(r)).length,
      lrPooled: lrPlus(scored, known, isGenuine),
      lrUniform,
      flagged: def.points > 0 && Number.isFinite(lrUniform) && lrUniform < TARGETS.lrFloor,
    };
  });
}

/**
 * Evaluate scoring against label rows (§14.4).
 * @param {LabelRow[]} rows
 * @param {EvalConfig} config `{weights, calibration, institutions}`
 * @param {{rand?: () => number, named?: NamedRow[] | null, bootstrap?: number, k?: number}} [opts]
 * @returns {EvalReport}
 */
export function evaluate(rows, config, opts = {}) {
  const rand = opts.rand ?? mulberry32(1);
  const n = opts.bootstrap ?? 1000;
  const k = opts.k ?? 20;
  const scored = scoreRows(rows, config);
  const uni = scored.filter((r) => r.stratum === 'uniform');
  /** @param {ScoredRow[]} rs @param {'source' | 'stratum'} key */
  const tally = (rs, key) => rs.reduce((m, r) => {
    const v = String(r[key]);
    m[v] = (m[v] ?? 0) + 1;
    return m;
  }, /** @type {Record<string, number>} */ ({}));

  const pooledCi = bootstrap(aucOfS, scored, { n, rand });
  const uniformCi = bootstrap(aucOfS, uni, { n, rand });
  /** @param {ScoredRow[]} rs */
  const starsAuc = (rs) => (rs.some(isGenuine) && rs.some((r) => !isGenuine(r))
    ? aucBy(rs, 'stars', isGenuine) : NaN);
  const g = rows.length ? goodhartAuc(rows, config) : { all: NaN, uniform: NaN };

  /** @param {ScoredRow[]} rs */
  const gemOf = (rs) => {
    const gem = rs.filter((r) => r.score.band === 'gem');
    const genuine = gem.filter(isGenuine).length;
    return { n: gem.length, genuine, precision: gem.length ? genuine / gem.length : NaN };
  };
  const ranked = [...scored].sort(byRank);
  const rankedUniform = ranked.filter((r) => r.stratum === 'uniform');
  /** @param {ScoredRow} r */
  const y = (r) => (isGenuine(r) ? 1 : 0);
  const cal = config.calibration;
  const current = { version: cal?.version ?? null, a: Number(cal?.a), b: Number(cal?.b) };
  const refit = scored.length ? fitPlatt(scored, { uniform: 'uniform', prior: [1, 1] }) : null;
  const named = opts.named?.length ? namedReport(opts.named, config) : null;

  const report = {
    model: { weights: config.weights?.version ?? null, calibration: current.version },
    counts: {
      labels: scored.length,
      genuine: scored.filter(isGenuine).length,
      uniform: uni.length,
      uniformGenuine: uni.filter(isGenuine).length,
      bySource: tally(scored, 'source'),
      byStratum: tally(scored, 'stratum'),
    },
    auc: {
      pooled: pooledCi.estimate,
      uniform: uniformCi.estimate,
      pooledCi: { lo: pooledCi.lo, hi: pooledCi.hi },
      uniformCi: { lo: uniformCi.lo, hi: uniformCi.hi },
    },
    starsAuc: { pooled: starsAuc(scored), uniform: starsAuc(uni) },
    goodhart: { pooled: g.all, uniform: g.uniform },
    bands: { pooled: bandTable(scored), uniform: bandTable(uni) },
    byPoints: { pooled: pointsTable(scored), uniform: pointsTable(uni) },
    gemPrecision: { pooled: gemOf(scored), uniform: gemOf(uni) },
    precisionAtK: {
      k,
      pooled: precisionAtK(ranked, isGenuine, k),
      uniform: precisionAtK(rankedUniform, isGenuine, k),
    },
    quality: {
      brierUniform: uni.length ? brier(uni.map((r) => r.quality), uni.map(y)) : NaN,
      brierPooled: scored.length ? brier(scored.map((r) => r.quality), scored.map(y)) : NaN,
      reliability: reliability(uni.map((r) => r.quality), uni.map(y), 10),
      current,
      refit,
    },
    signals: signalRows(scored, uni),
    named,
    checks: /** @type {Check[]} */ ([]),
    ok: false,
  };

  const tol = TARGETS.calibrationTolerance;
  const within = `within ${tol}`;
  report.checks = [
    atLeast('auc.pooled', 'Pooled AUC', report.auc.pooled, TARGETS.aucPooled),
    atLeast('auc.uniform', 'Uniform AUC', report.auc.uniform, TARGETS.aucUniform),
    atLeast('gem.precision.uniform', 'Uniform precision of S ≥ 7', report.gemPrecision.uniform.precision,
      TARGETS.gemPrecisionUniform),
    atLeast('goodhart.pooled', 'Goodhart AUC, pooled', report.goodhart.pooled, TARGETS.goodhartPooled),
    atLeast('goodhart.uniform', 'Goodhart AUC, uniform', report.goodhart.uniform, TARGETS.goodhartUniform),
    atMost('brier.uniform', 'Uniform Brier score of Quality', report.quality.brierUniform,
      TARGETS.brierUniform),
    atMost('calibration.a', 'Refit a against the calibration file',
      refit ? Math.abs(refit.a - current.a) : NaN, tol, within),
    atMost('calibration.b', 'Refit b against the calibration file',
      refit ? Math.abs(refit.b - current.b) : NaN, tol, within),
    {
      id: 'named',
      label: 'Named-set expectations held',
      value: named ? named.results.filter((r) => r.ok).length : NaN,
      target: named ? `all ${named.results.length}` : 'all',
      ok: named ? named.ok : null,
    },
  ];
  report.ok = report.checks.every((c) => c.ok !== false);
  return report;
}

/**
 * A number for a report line: integers as they are, others to `places` decimals, a minus sign for
 * negatives and a dash when not measured.
 * @param {number} x
 * @param {number} [places]
 * @returns {string}
 */
function fx(x, places = 3) {
  if (!Number.isFinite(x)) return '—';
  const s = Number.isInteger(x) && places === 0 ? String(x) : x.toFixed(places);
  return s.replace(/^-/, '−');
}

/**
 * A report as printable lines, for `unsung eval`.
 * @param {EvalReport} r
 * @returns {string[]}
 */
export function formatReport(r) {
  const c = r.counts;
  const sources = Object.entries(c.bySource).map(([s, n]) => `${s} ${n}`).join(', ');
  const gp = r.gemPrecision;
  const out = [
    `Labels: ${c.labels} (${c.genuine} genuine) · uniform stratum ${c.uniform} (${c.uniformGenuine} genuine)`
      + ` · sources: ${sources}`,
    `Model: weights ${r.model.weights ?? '—'} · calibration ${r.model.calibration ?? '—'}`,
    `AUC, genuine against the rest: pooled ${fx(r.auc.pooled)} (95% interval ${fx(r.auc.pooledCi.lo)}–`
      + `${fx(r.auc.pooledCi.hi)}) · uniform ${fx(r.auc.uniform)} `
      + `(${fx(r.auc.uniformCi.lo)}–${fx(r.auc.uniformCi.hi)})`,
    `Stars AUC, for contrast: pooled ${fx(r.starsAuc.pooled)} · uniform ${fx(r.starsAuc.uniform)}`,
    `Goodhart (dressed) AUC: pooled ${fx(r.goodhart.pooled)} · uniform ${fx(r.goodhart.uniform)}`,
    `Gem band: uniform ${gp.uniform.genuine} of ${gp.uniform.n} genuine · pooled ${gp.pooled.genuine} of `
      + `${gp.pooled.n} genuine`,
    `Precision@${r.precisionAtK.k} by rank: pooled ${fx(r.precisionAtK.pooled)} · `
      + `uniform ${fx(r.precisionAtK.uniform)}`,
    `Brier score of Quality: uniform ${fx(r.quality.brierUniform)} · pooled ${fx(r.quality.brierPooled)}`,
  ];
  const q = r.quality;
  const refit = q.refit
    ? ` · refit on these labels: a ${fx(q.refit.a)}, b ${fx(q.refit.b)}`
      + ` (base rate ${fx(q.refit.base)})`
    : '';
  out.push(`Calibration ${q.current.version ?? '—'}: a ${fx(q.current.a)}, b ${fx(q.current.b)}${refit}`);
  out.push('Points against labels, uniform stratum (S: genuine / WIP / rest):');
  for (const t of r.byPoints.uniform) out.push(`  ${String(t.S).padStart(3)}: ${t.G} / ${t.W} / ${t.rest}`);
  out.push('Signals (fires on genuine / rest · LR+ pooled · LR+ uniform):');
  for (const s of r.signals) {
    const flag = s.flagged ? '  below 2 on the uniform stratum' : '';
    out.push(`  ${s.id.padEnd(13)} ${String(s.G).padStart(3)} / ${String(s.rest).padEnd(3)} `
      + `${fx(s.lrPooled, 2).padStart(6)} ${fx(s.lrUniform, 2).padStart(6)}${flag}`);
  }
  if (r.named) {
    const held = r.named.results.filter((x) => x.ok).length;
    out.push(`Named sets: ${held} of ${r.named.results.length} expectations hold`);
    for (const x of r.named.results.filter((y) => !y.ok)) {
      out.push(`  ${x.nwo} (${x.set}): ${x.problems.join('; ')}`);
    }
    for (const s of r.named.setRules) {
      out.push(`  ${s.set}: median ${fx(s.median, 1)} against the seed gems' ${fx(s.seedMedian, 1)} `
        + `(${s.ok ? 'holds' : 'fails'})`);
    }
  }
  out.push('Checks against the §14.6 targets:');
  for (const ch of r.checks) {
    const state = ch.ok === null ? 'not measured' : ch.ok ? 'ok' : 'short';
    const value = ch.id === 'named' ? fx(ch.value, 0) : fx(ch.value);
    out.push(`  ${state.padEnd(12)} ${ch.label}: ${value} (target ${ch.target})`);
  }
  return out;
}
