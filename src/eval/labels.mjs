// @ts-check
/**
 * Label rows for evaluation and calibration (DESIGN §14.3): the 149 research labels from the
 * fixtures, quality labels from feedback, and the named sets of §14.2 with their expectations.
 *
 * Research rows are scored on the research snapshot, as the design's numbers were measured: the
 * file `meta.labelledSnapshot` names when a labelled repository was also recorded, else
 * `enrich.json`. The two spam repositories that answered 502 in research have no snapshot; they are
 * scored on identity-only Facts (every input null), which earn 0 points.
 */

import { factsFromEnrich, mergeDeep } from '../core/facts.mjs';

/** @typedef {import('../core/schema.mjs').Facts} Facts */
/** @typedef {import('./fixtures.mjs').RepoFixture} RepoFixture */

/**
 * @typedef {object} LabelRow
 * @property {string} nwo
 * @property {string} owner
 * @property {Facts} facts
 * @property {string} label one of the eight categories of §1.2
 * @property {string} stratum research: `uniform` or `search`; feedback: `uniform` (blind labels on
 *   `unsung sample` draws), `pool` (other blind labels) or `triage` (shown ranked, so biased)
 * @property {'fixture' | 'feedback'} source
 * @property {string} at ISO time to score at (the time the facts were fetched)
 * @property {string[]} [flags] research flags, such as `corp`
 * @property {string | null} [id]
 */

/**
 * @typedef {object} NamedRow a named-set repository of §14.2
 * @property {string} nwo
 * @property {string} owner
 * @property {string | null} set `seedGems`, `hardPositives`, `hardNegatives` or `luresAndSpam`
 * @property {Record<string, any>} expect `meta.expect`
 * @property {Facts} facts recorded facts, deep stage merged when recorded
 * @property {Facts} enrich the same repository at the enrich stage
 * @property {string} at ISO time to score at (the recording time)
 * @property {string | null} label research label, when the repository has one
 */

/**
 * The loader functions this module uses (`test/support/fixtures.mjs` or `fixtures.mjs#fixtureLoader`).
 * @typedef {object} Loader
 * @property {() => Record<string, {cat: string, flags?: unknown, stratum: string}>} loadLabelled
 * @property {(name: string) => RepoFixture} loadRepoFixture
 * @property {(rel: string) => any} loadJsonFixture
 * @property {(filter?: any) => string[]} listRepoFixtures
 */

/** Fallback time for fixtures without a recording time. */
const EPOCH = '2026-09-11T00:00:00Z';

/**
 * Whether a row is labelled genuine (§1.1: label G).
 * @param {{label?: string | null}} row
 * @returns {boolean}
 */
export function isGenuine(row) {
  return row?.label === 'G';
}

/**
 * @param {string} nwo
 * @returns {string}
 */
function ownerOf(nwo) {
  return String(nwo).split('/')[0];
}

/**
 * Identity-only Facts: every input null, so every signal that needs one is unknown.
 * @param {string} nwo
 * @param {string} at
 * @returns {Facts}
 */
export function identityFacts(nwo, at) {
  return factsFromEnrich({ nameWithOwner: nwo }, { fetchedAt: at, source: 'fixture' });
}

/**
 * The research labels as rows, scored on their research snapshots (§14.2 research conversion).
 * @param {Loader} loader
 * @returns {LabelRow[]}
 */
export function labelledFromFixtures(loader) {
  const labels = loader.loadLabelled();
  /** @type {LabelRow[]} */
  const rows = [];
  for (const [nwo, lab] of Object.entries(labels)) {
    const fx = loader.loadRepoFixture(nwo);
    const meta = fx.meta ?? {};
    const snapshot = typeof meta.labelledSnapshot === 'string'
      ? loader.loadJsonFixture(`repos/${fx.name}/${meta.labelledSnapshot}`) : fx.enrich;
    const at = meta.researchRecordedAt ?? meta.recordedAt ?? EPOCH;
    const facts = snapshot ? factsFromEnrich(snapshot, { fetchedAt: at, source: 'fixture' })
      : identityFacts(fx.nwo, at);
    const flags = Array.isArray(lab.flags) ? lab.flags.map(String) : [];
    rows.push({
      nwo, owner: ownerOf(nwo), facts, label: lab.cat, stratum: lab.stratum, source: 'fixture', at, flags,
      id: facts.id,
    });
  }
  return rows;
}

/**
 * Facts for one recorded fixture: the enrich node, with the deep-stage responses merged when any
 * were recorded.
 * @param {RepoFixture} fx
 * @returns {{facts: Facts, enrich: Facts, at: string, deep: boolean}}
 */
export function fixtureFacts(fx) {
  const meta = fx.meta ?? {};
  const at0 = meta.recordedAt ?? EPOCH;
  const enrich = fx.enrich ? factsFromEnrich(fx.enrich, { fetchedAt: at0, source: 'fixture' })
    : identityFacts(fx.nwo, at0);
  const hasDeep = Boolean(fx.deep || fx.tree || fx.files || fx.activity || fx.stars);
  if (!hasDeep) return { facts: enrich, enrich, at: at0, deep: false };
  const at = meta.deep?.recordedAt ?? at0;
  const facts = mergeDeep(enrich, {
    node: fx.deep, tree: fx.tree, activity: fx.activity, starHistory: fx.stars, files: fx.files,
  }, { fetchedAt: at });
  return { facts, enrich, at, deep: true };
}

/**
 * The named-set fixtures of §14.2 (those with `meta.expect`), on their recorded facts.
 * @param {Loader} loader
 * @returns {NamedRow[]}
 */
export function namedFromFixtures(loader) {
  return loader.listRepoFixtures((/** @type {any} */ meta) => Boolean(meta?.expect)).map((nwo) => {
    const fx = loader.loadRepoFixture(nwo);
    const { facts, enrich, at } = fixtureFacts(fx);
    return {
      nwo: fx.nwo, owner: ownerOf(fx.nwo), set: fx.meta?.set ?? null, expect: fx.meta.expect, facts, enrich,
      at, label: fx.meta?.label ?? null,
    };
  });
}

/** The label sources `unsung eval` and `unsung calibrate` accept (§9.1). */
export const LABEL_SOURCES = Object.freeze(['fixtures', 'feedback', 'all']);

/**
 * Rows and named sets from the chosen sources: `fixtures` reads the loader, `feedback` the store,
 * `all` both. A missing loader or store contributes nothing.
 * @param {{labels?: string, loader?: Loader | null, store?: any}} opts
 * @returns {Promise<{rows: LabelRow[], named: NamedRow[]}>}
 */
export async function labelRows({ labels = 'all', loader = null, store = null }) {
  /** @type {LabelRow[]} */
  const rows = [];
  /** @type {NamedRow[]} */
  let named = [];
  if (labels !== 'feedback' && loader) {
    rows.push(...labelledFromFixtures(loader));
    named = namedFromFixtures(loader);
  }
  if (labels !== 'fixtures' && store) rows.push(...await labelledFromFeedback(store));
  return { rows, named };
}

/**
 * Quality labels from feedback (§10.4, §14.3): for each repository, the latest event that carries
 * a label and has not been undone. `notmine`, `snooze` and publishing carry none. Rows need the
 * repository's stored facts; labels for repositories without a record are skipped.
 * @param {{readFeedback: () => Promise<any[]>, getRepoById?: (id: string) => Promise<any>,
 *   getRepo?: (nwo: string) => Promise<any>}} store
 * @returns {Promise<LabelRow[]>}
 */
export async function labelledFromFeedback(store) {
  const events = (await store.readFeedback()) ?? [];
  const undone = new Set();
  for (const e of events) {
    if (e?.action === 'undo' && e.undoes !== null && e.undoes !== undefined) undone.add(String(e.undoes));
  }
  /** @type {Map<string, any>} */
  const latest = new Map();
  events.forEach((e, i) => {
    if (!e || typeof e.id !== 'string' || e.action === 'undo') return;
    if (undone.has(String(e.at)) || undone.has(String(i))) return;
    if (typeof e.label !== 'string' || !e.label) return;
    latest.set(e.id, e);
  });
  /** @type {LabelRow[]} */
  const rows = [];
  for (const [id, e] of latest) {
    const rec = (store.getRepoById ? await store.getRepoById(id) : null)
      ?? (store.getRepo && e.nwo ? await store.getRepo(e.nwo) : null);
    if (!rec?.facts) continue;
    const stratum = e.blind === true ? (e.context?.stratum === 'sample' ? 'uniform' : 'pool') : 'triage';
    const nwo = String(rec.nwo ?? e.nwo);
    rows.push({
      nwo, owner: ownerOf(nwo), facts: rec.facts, label: e.label, stratum, source: 'feedback',
      at: rec.facts.fetchedAt ?? e.at, id,
    });
  }
  return rows;
}
