// @ts-check
/**
 * Scores into records, records into the index (DESIGN §4.2, §4.3, §6, §3.11).
 *
 * - `applyScore` recomputes a record's `Score` from its `Facts` (never patched), forces the `gone`
 *   lane for a vanished repository (§6.7 rule 2, after quarantine), and keeps `firstSeen`, the
 *   history (≤ 50 points) and the candidate's `result` in step.
 * - `isKept` is the §4.2 rule: a record is kept unless its lane is `low`, or it has feedback or a
 *   verdict; a repository with a `drop` gate is never kept; `add` and `sample` repositories always.
 * - `buildIndex` writes one `IndexEntry` per kept repository except `gone` ones, quarantined ones as
 *   identity, lane and gate reasons only, at most `caps.indexEntries` (lowest `gem` dropped first).
 */

import { SCRIPT_LABELS } from '../core/readme.mjs';
import { SCORING_KINDS } from '../core/schema.mjs';
import { daysBetween } from '../core/util.mjs';
import { CORE } from './deps.mjs';
import { isoNow } from './util.mjs';

/** @typedef {import('../core/schema.mjs').RepoRecord} RepoRecord */
/** @typedef {import('../core/schema.mjs').Score} Score */
/** @typedef {import('../core/schema.mjs').Signal} Signal */
/** @typedef {import('../core/schema.mjs').Verdict} Verdict */
/** @typedef {import('../core/schema.mjs').Index} Index */
/** @typedef {import('../core/schema.mjs').IndexEntry} IndexEntry */
/** @typedef {import('../core/schema.mjs').Feedback} Feedback */
/** @typedef {import('../core/schema.mjs').RunSummary} RunSummary */
/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('./deps.mjs').Lib} Lib */

/** A record keeps at most this many history points (§4.3). */
export const HISTORY_MAX = 50;

/** A new history point is added when any of these changes. */
const HISTORY_KEYS = /** @type {const} */ (['headOid', 'S', 'lane', 'stars', 'gem']);

/** Lanes the index always counts, even at zero (§4.3). */
const COUNTED_LANES = [
  'promising', 'proven', 'look', 'institutional', 'doubted', 'rising', 'graduated', 'quarantine',
];

/** The registry order of positive signals for "top" reasons (§6.8), used when `explain` is missing. */
const TOP_ORDER = [
  'q.release', 'p.testsRun', 'p.shipped', 'q.tests', 'q.examples', 'p.coherent', 'q.usage', 'q.ci',
  'q.manifest', 'q.deps', 'q.code', 'q.licence', 'q.readme',
];

/** Descriptions in the index are cut to this many characters (§4.3). */
const DESCRIPTION_CHARS = 300;

/**
 * The verdict that belongs to a record's current head, if any.
 * @param {RepoRecord} record
 * @returns {Verdict | null}
 */
function currentVerdict(record) {
  const v = record?.verdict;
  return v && v.headOid === record.facts?.headOid ? v : null;
}

/**
 * @param {number | undefined | null} x
 * @param {number} [places]
 * @returns {number}
 */
function round(x, places = 2) {
  const f = 10 ** places;
  return Math.round(Number(x ?? 0) * f) / f;
}

/**
 * Recompute a record's score from its facts and bring the record up to date.
 * @param {RepoRecord} record
 * @param {Config} config
 * @param {{now?: string, verdict?: Verdict | null, deps?: Lib}} [opts] `verdict` overrides the
 *   record's own (which counts only when it was made at the current `headOid`)
 * @returns {RepoRecord}
 */
export function applyScore(record, config, { now, verdict, deps = CORE } = {}) {
  const at = isoNow(now);
  const facts = record.facts;
  const v = verdict !== undefined ? verdict : currentVerdict(record);
  const score = /** @type {Score} */ (deps.scoreFacts(facts, {
    weights: config.weights, calibration: config.calibration, institutions: config.institutions,
    verdict: v, now: at,
  }));
  if (record.gone && score.lane !== 'quarantine') score.lane = 'gone';
  const headOid = score.headOid ?? facts?.headOid ?? null;
  const stars = score.attention?.stars ?? facts?.stars ?? 0;
  const point = {
    at, headOid, S: score.S, quality: score.quality, k: score.confidence?.k ?? 0, gem: score.gem,
    lane: score.lane, stars,
  };
  const history = [...(record.history ?? [])];
  const last = history[history.length - 1];
  if (!last || HISTORY_KEYS.some((k) => last[k] !== point[k])) history.push(point);
  while (history.length > HISTORY_MAX) history.shift();
  const result = { headOid, S: score.S, band: score.band, lane: score.lane, gem: score.gem, at };
  return {
    ...record,
    v: 1,
    candidate: record.candidate ? { ...record.candidate, result } : null,
    score,
    firstSeen: record.firstSeen ?? { at, headOid, S: score.S, stars },
    history,
    verdict: v ?? null,
  };
}

/**
 * A candidate's `result` (§4.3) for a scored record: from its candidate snapshot, else its score.
 * @param {RepoRecord} record
 * @returns {import('../core/schema.mjs').CandidateResult | null}
 */
export function resultOf(record) {
  if (record?.candidate?.result) return record.candidate.result;
  const s = record?.score;
  if (!s) return null;
  const headOid = s.headOid ?? record.facts?.headOid ?? null;
  return { headOid, S: s.S, band: s.band, lane: s.lane, gem: s.gem, at: s.scoredAt };
}

/**
 * Whether a scored repository keeps a `RepoRecord` file (§4.2).
 * @param {RepoRecord} record
 * @param {{hasFeedback?: boolean, hasVerdict?: boolean}} [opts]
 * @returns {boolean}
 */
export function isKept(record, { hasFeedback = false, hasVerdict = false } = {}) {
  const score = record?.score;
  if (!score) return false;
  if ((score.gates ?? []).some((g) => g.action === 'drop')) return false;
  if (hasFeedback || hasVerdict || record.verdict) return true;
  const sources = record.candidate?.sources ?? [];
  if (sources.includes('add') || sources.includes('sample')) return true;
  return score.lane !== 'low';
}

/**
 * @typedef {object} FeedbackView
 * @property {{action: string, at: string, label: string | null, reason: string | null} | null} last
 *   the latest triage decision still in force
 * @property {boolean} published
 * @property {string | null} snoozeUntil
 */

/**
 * Fold feedback events into what the index shows per repository (§10.4): `undo` events revert the
 * event they name (by its `at`, or its position in the file).
 * @param {Feedback[]} events
 * @returns {Map<string, FeedbackView>}
 */
export function feedbackState(events) {
  const undone = new Set();
  events.forEach((e) => {
    if (e?.action === 'undo' && e.undoes !== null && e.undoes !== undefined) undone.add(String(e.undoes));
  });
  /** @type {Map<string, FeedbackView>} */
  const out = new Map();
  events.forEach((e, i) => {
    if (!e || typeof e.id !== 'string' || e.action === 'undo') return;
    if (undone.has(String(e.at)) || undone.has(String(i))) return;
    const view = out.get(e.id) ?? { last: null, published: false, snoozeUntil: null };
    if (e.action === 'publish' || e.action === 'unpublish') view.published = e.action === 'publish';
    else {
      view.last = { action: e.action, at: e.at, label: e.label ?? null, reason: e.reason ?? null };
      view.snoozeUntil = typeof e.snoozeUntil === 'string' ? e.snoozeUntil : null;
    }
    out.set(e.id, view);
  });
  return out;
}

/**
 * @param {unknown} text
 * @returns {string | null}
 */
function shortDescription(text) {
  if (typeof text !== 'string') return null;
  const chars = [...text];
  return chars.length <= DESCRIPTION_CHARS ? text : `${chars.slice(0, DESCRIPTION_CHARS - 1).join('')}…`;
}

/**
 * Weekly star gains, oldest to newest, or null when unknown.
 * @param {RepoRecord['facts']} facts
 * @returns {number[] | null}
 */
function sparkOf(facts) {
  const weeks = facts?.starHistory?.weeks;
  if (!Array.isArray(weeks) || weeks.length === 0) return null;
  const key = (/** @type {any} */ w) => (typeof w.week === 'number' ? w.week : Date.parse(String(w.week)));
  return [...weeks].sort((a, b) => key(a) - key(b)).map((w) => Number(w.gained ?? w.total ?? 0));
}

/**
 * @param {Signal | string} s
 * @returns {string}
 */
function reasonLine(s) {
  if (typeof s === 'string') return s;
  if (!s || typeof s !== 'object') return String(s);
  return s.reason ? `${s.label}: ${s.reason}` : String(s.label ?? s.id);
}

/**
 * Top reasons and negatives, from `explain` (§6.8) when it is available.
 * @param {Score} score
 * @param {Config} config
 * @param {Lib} deps
 * @returns {{top: string[], negatives: string[]}}
 */
function reasons(score, config, deps) {
  try {
    const ex = deps.explain(score, config.weights);
    return {
      top: (ex?.top ?? []).slice(0, 3).map(reasonLine),
      negatives: (ex?.negatives ?? []).slice(0, 2).map(reasonLine),
    };
  } catch (err) {
    if (/** @type {{name?: string}} */ (err)?.name !== 'NotAvailableError') throw err;
    const hits = score.signals.filter((s) => s.status === 'ok' && s.hit && (s.points ?? 0) > 0);
    const top = TOP_ORDER.map((id) => hits.find((s) => s.id === id)).filter(Boolean).slice(0, 3);
    const negatives = score.signals.filter((s) => s.status === 'ok' && s.hit && (s.points ?? 0) < 0)
      .sort((a, b) => (a.points ?? 0) - (b.points ?? 0)).slice(0, 2);
    return {
      top: top.map((s) => reasonLine(/** @type {Signal} */ (s))),
      negatives: negatives.map(reasonLine),
    };
  }
}

/**
 * @param {Score} score
 * @returns {{id: string, action: string, reason: string}[]}
 */
function gatesOf(score) {
  return (score.gates ?? []).map((g) => ({ id: g.id, action: g.action, reason: g.reason }));
}

/**
 * @param {RepoRecord} record
 * @param {Lib} deps
 * @returns {{category: string, pitch: string | null, points: number} | null}
 */
function verdictOf(record, deps) {
  const v = record.verdict;
  if (!v || v.status !== 'ok' || !v.output) return null;
  let points = typeof v.effect?.points === 'number' ? v.effect.points : null;
  if (points === null) {
    try {
      points = Number(deps.verdictSignal(v)?.points ?? 0);
    } catch {
      points = 0;
    }
  }
  return { category: v.output.category, pitch: v.output.pitch || null, points };
}

/**
 * Facets of an entry (§10.6): language, up to 8 topics, owner kind and README script.
 * @param {RepoRecord} record
 * @returns {string[]}
 */
function facetsOf(record) {
  const f = record.facts;
  /** @type {string[]} */
  const out = [];
  if (f?.primaryLanguage) out.push(`lang:${String(f.primaryLanguage).toLowerCase()}`);
  for (const t of (f?.topics ?? []).slice(0, 8)) out.push(`topic:${String(t).toLowerCase()}`);
  const type = f?.ownerInfo?.type ?? record.candidate?.ownerType;
  out.push(`owner:${type === 'Organization' ? 'org' : 'user'}`);
  out.push(`script:${scriptKeyOf(record.score?.descriptors ?? [])}`);
  return out;
}

/** README script labels (§5.6) back to their keys (`cjk`, `cyrillic`, …) — `readme.mjs#detectScript`. */
const SCRIPT_KEYS = new Map(Object.entries(SCRIPT_LABELS).map(([key, label]) => [label, key]));

/**
 * The `script:` facet value (§10.6): `latin` without a `d.script` descriptor, else the key of the
 * script its detail names (`cjk`, `cyrillic`, `arabic`, `devanagari`, `other`).
 * @param {import('../core/schema.mjs').Descriptor[]} descriptors
 * @returns {string}
 */
export function scriptKeyOf(descriptors) {
  const d = descriptors.find((x) => x.id === 'd.script');
  if (!d) return 'latin';
  return SCRIPT_KEYS.get(String(d.detail ?? '')) ?? 'other';
}

/**
 * The chips of an entry: every quality, proof, slop and judge signal (§6.8).
 * @param {Score} s
 * @returns {{id: string, points: number, status: string, hit: boolean | null, label: string}[]}
 */
function chipsOf(s) {
  return s.signals.filter((sig) => /** @type {readonly string[]} */ (SCORING_KINDS).includes(sig.kind))
    .map((sig) => ({
      id: sig.id, points: sig.points ?? 0, status: sig.status, hit: sig.hit, label: sig.label,
    }));
}

/**
 * One index entry (§4.3).
 * @param {RepoRecord} record
 * @param {{config: Config, deps?: Lib, feedback?: FeedbackView, now: string}} opts
 * @returns {IndexEntry}
 */
export function indexEntry(record, { config, deps = CORE, feedback, now }) {
  const s = /** @type {Score} */ (record.score);
  if (s.lane === 'quarantine') {
    return { id: record.id, nwo: record.nwo, lane: 'quarantine', gates: gatesOf(s) };
  }
  const f = record.facts;
  const { top, negatives } = reasons(s, config, deps);
  const age = f?.createdAt ? Math.max(0, Math.floor(daysBetween(f.createdAt, now))) : null;
  return {
    id: record.id,
    nwo: record.nwo,
    description: shortDescription(f?.description),
    lang: f?.primaryLanguage ?? null,
    topics: f?.topics ?? [],
    createdAt: f?.createdAt ?? null,
    pushedAt: f?.pushedAt ?? null,
    ageDays: age,
    lane: s.lane,
    band: s.band,
    S: s.S,
    pointsMax: s.pointsMax,
    coverage: round(s.coverage),
    quality: round(s.quality),
    k: round(s.confidence?.k),
    kBand: s.confidence?.band ?? 'low',
    a: round(s.attention?.a),
    gem: round(s.gem),
    stars: s.attention?.stars ?? f?.stars ?? 0,
    forks: s.attention?.forks ?? f?.forks ?? 0,
    gain4w: s.attention?.gain4w ?? null,
    spark: sparkOf(f),
    chips: chipsOf(s),
    top,
    negatives,
    descriptors: (s.descriptors ?? []).map((d) => d.id),
    gates: gatesOf(s),
    verdict: verdictOf(record, deps),
    facets: facetsOf(record),
    feedback: feedback ?? { last: null, published: false, snoozeUntil: null },
    headOid: s.headOid ?? f?.headOid ?? null,
  };
}

/** Gate ids for prefilter reasons that quarantine a candidate before it has a record. */
const PREFILTER_GATES = /** @type {Record<string, {id: string, reason: string}>} */ ({
  'lure-name': { id: 'g.lure.name', reason: 'The name or description matches a lure word' },
});

/**
 * Index order (§6.7): `gem` descending, then stars ascending, then newest first.
 * @param {IndexEntry} a
 * @param {IndexEntry} b
 * @returns {number}
 */
function entryOrder(a, b) {
  const ga = a.gem ?? -Infinity;
  const gb = b.gem ?? -Infinity;
  if (ga !== gb) return gb - ga;
  const sa = a.stars ?? 0;
  const sb = b.stars ?? 0;
  if (sa !== sb) return sa - sb;
  const ca = a.createdAt ?? '';
  const cb = b.createdAt ?? '';
  if (ca !== cb) return ca < cb ? 1 : -1;
  return a.nwo < b.nwo ? -1 : a.nwo > b.nwo ? 1 : 0;
}

/**
 * The fields `entryOrder` reads, taken from a record without building its entry: a quarantined
 * entry carries no rank (it sorts after every ranked one), the others `gem` rounded as in the entry.
 * @param {RepoRecord} rec a scored record
 * @returns {{gem?: number, stars?: number, createdAt?: string | null, nwo: string}}
 */
function orderKeyOf(rec) {
  const s = /** @type {Score} */ (rec.score);
  if (s.lane === 'quarantine') return { nwo: rec.nwo };
  const f = rec.facts;
  return {
    gem: round(s.gem), stars: s.attention?.stars ?? f?.stars ?? 0, createdAt: f?.createdAt ?? null, nwo: rec.nwo,
  };
}

/**
 * The first `cap` items in `order`, kept while streaming: a binary heap whose root is the last item
 * kept, so an item that cannot make the cut is never built (`offer(key, make)` calls `make` only for
 * an item that gets in). Ties with the last item kept are left out, as a stable sort would.
 * @template V
 * @param {number} cap
 * @param {(a: any, b: any) => number} order negative when `a` comes first
 */
export function topK(cap, order) {
  /** @type {{key: any, value: V}[]} */
  const heap = [];
  /** @param {number} i @param {number} j */
  const after = (i, j) => order(heap[i].key, heap[j].key) > 0;
  /** @param {number} i @param {number} j */
  const swap = (i, j) => {
    const t = heap[i];
    heap[i] = heap[j];
    heap[j] = t;
  };
  return {
    /**
     * @param {any} key
     * @param {() => V} make
     * @returns {boolean} whether the item was kept (for now)
     */
    offer(key, make) {
      if (!(cap > 0)) return false;
      if (heap.length < cap) {
        heap.push({ key, value: make() });
        for (let i = heap.length - 1; i > 0;) {
          const p = (i - 1) >> 1;
          if (!after(i, p)) break;
          swap(i, p);
          i = p;
        }
        return true;
      }
      if (order(key, heap[0].key) >= 0) return false;
      heap[0] = { key, value: make() };
      for (let i = 0; ;) {
        const l = 2 * i + 1;
        let m = i;
        if (l < heap.length && after(l, m)) m = l;
        if (l + 1 < heap.length && after(l + 1, m)) m = l + 1;
        if (m === i) break;
        swap(i, m);
        i = m;
      }
      return true;
    },
    /** @returns {V[]} the items kept, in `order` */
    sorted() {
      return [...heap].sort((a, b) => order(a.key, b.key)).map((x) => x.value);
    },
  };
}

/**
 * Build the explorer's index from every kept record (§4.3). At most `caps.indexEntries` entries
 * are kept while the records stream past, so a record that cannot make the cut is never turned
 * into an entry and memory stays bounded however many records the store holds.
 * @param {object} opts
 * @param {any} opts.store
 * @param {Config} opts.config
 * @param {string} [opts.now]
 * @param {RunSummary | null} [opts.lastRun] default: the store's latest run
 * @param {Lib} [opts.deps]
 * @returns {Promise<Index>}
 */
export async function buildIndex({ store, config, now, lastRun, deps = CORE }) {
  const at = now ?? store.now?.() ?? isoNow(undefined);
  const feedback = feedbackState(await store.readFeedback());
  const capValue = Number(config.defaults?.caps?.indexEntries ?? 20000);
  const cap = Number.isFinite(capValue) ? Math.max(0, Math.floor(capValue)) : Number.POSITIVE_INFINITY;
  /** @type {ReturnType<typeof topK<IndexEntry>>} */
  const best = topK(cap, entryOrder);
  const seen = new Set();
  for await (const rec of store.listRepos()) {
    if (!rec?.score || rec.gone || rec.score.lane === 'gone') continue;
    if ((rec.score.gates ?? []).some((/** @type {any} */ g) => g.action === 'drop')) continue;
    seen.add(rec.id);
    best.offer(orderKeyOf(rec), () => indexEntry(rec, { config, deps, feedback: feedback.get(rec.id), now: at }));
  }
  // Candidates quarantined by the prefilter never get a record; the Quarantine view still lists them.
  for (const c of await store.listCandidates({ state: 'quarantined' })) {
    if (seen.has(c.id) || !PREFILTER_GATES[String(c.reason)]) continue;
    const g = PREFILTER_GATES[String(c.reason)];
    const gates = [{ id: g.id, action: 'quarantine', reason: g.reason }];
    best.offer({ nwo: c.nwo }, () => ({ id: c.id, nwo: c.nwo, lane: 'quarantine', gates }));
  }
  const kept = best.sorted();
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(COUNTED_LANES.map((l) => [l, 0]));
  for (const e of kept) counts[e.lane] = (counts[e.lane] ?? 0) + 1;
  const last = lastRun !== undefined ? lastRun : ((await store.lastRuns(1))[0] ?? null);
  return {
    v: 1,
    generatedAt: at,
    model: { weights: config.weights ?? null, calibration: config.calibration ?? null },
    counts,
    lastRun: last,
    entries: kept,
  };
}

/**
 * Recompute every kept score from stored facts, offline (§3.11 `unsung index --rescore`).
 * @param {object} opts
 * @param {any} opts.store
 * @param {Config} opts.config
 * @param {string} [opts.now]
 * @param {Lib} [opts.deps]
 * @returns {Promise<{count: number}>}
 */
export async function rescoreAll({ store, config, now, deps = CORE }) {
  const at = now ?? store.now?.() ?? isoNow(undefined);
  let count = 0;
  for await (const rec of store.listRepos()) {
    if (!rec?.facts) continue;
    const next = applyScore(rec, config, { now: at, deps });
    await store.putRepo(next);
    const result = resultOf(next);
    if (result && await store.getCandidate(rec.id)) await store.patchCandidate(rec.id, { result });
    count++;
  }
  return { count };
}
