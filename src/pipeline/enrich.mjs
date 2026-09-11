// @ts-check
/**
 * Stages S2–S3 (DESIGN §3.5, §4.2): enrich candidates in AIMD batches through `runBatched`, repair
 * READMEs that are not called `README.md`, fall back to REST for repositories that stay heavy,
 * turn each node into `Facts`, score it, and either keep a `RepoRecord` or keep only the
 * candidate's `result`. Owners caught by `g.spam.farm` or `g.spam.streak` are remembered.
 */

import { applyScore, isKept } from './indexer.mjs';
import { liveFromFacts, ownerOf } from './candidates.mjs';
import { SILENT_LOG, isFatal, isNotFound, isoNow, splitNwo } from './util.mjs';

/** @typedef {import('../core/schema.mjs').Candidate} Candidate */
/** @typedef {import('../core/schema.mjs').RepoRecord} RepoRecord */
/** @typedef {import('../core/schema.mjs').Facts} Facts */
/** @typedef {import('./deps.mjs').Lib} Lib */

/** README names the repair query looks for (§3.5). */
const README_BLOB = /^readme(\.[a-z0-9]+)?$/i;

/** README repairs are fetched this many at a time (§3.5). */
export const REPAIR_BATCH = 20;

/** Marks a repository whose REST fallback failed too. */
const FAILED = Symbol('failed');

/**
 * @typedef {object} EnrichStats
 * @property {number} repos scored
 * @property {number} kept records written
 * @property {number} dropped by a drop gate
 * @property {number} gone not found
 * @property {number} heavy fetched over REST after failing alone
 * @property {number} failed left for another run after an error
 * @property {number} repairs README repair queries
 * @property {number} explore exploration picks scored
 */

/** @returns {EnrichStats} */
export function emptyEnrichStats() {
  return { repos: 0, kept: 0, dropped: 0, gone: 0, heavy: 0, failed: 0, repairs: 0, explore: 0 };
}

/**
 * @typedef {object} EnrichEnv
 * @property {any} client the (metered) GitHub client
 * @property {any} store
 * @property {import('../config.mjs').Config} config
 * @property {Lib} lib
 * @property {(() => string) | string} [now]
 * @property {import('../log.mjs').Log} [log]
 * @property {{size: number, min: number, max: number, targetMs: number}} [batch]
 * @property {Set<string>} [feedbackIds] repositories with feedback are always kept
 * @property {boolean} [keepAll] keep every scored repository (`add`, `sample`)
 * @property {EnrichStats} [stats]
 * @property {AbortSignal} [signal] Ctrl-C: stops new requests and ends any rate-limit wait (§3.12)
 */

/**
 * @typedef {object} Enriched
 * @property {Candidate} candidate the stored candidate after this step
 * @property {RepoRecord | null} record the scored record (null when gone or failed)
 * @property {boolean} [kept] whether the record was written
 * @property {boolean} [gone]
 * @property {boolean} [heavy]
 * @property {unknown} [error]
 */

/**
 * The README file to fetch in a repair query, or null (§3.5): the node has no `README.md` but its
 * root holds a blob named like `README.rst` or `Readme.md`.
 * @param {any} node
 * @returns {string | null}
 */
export function readmeToRepair(node) {
  if (!node || node.readme) return null;
  const entries = node.root?.entries;
  if (!Array.isArray(entries)) return null;
  const hit = entries.find((e) => e && e.type === 'blob' && README_BLOB.test(String(e.name)));
  return hit ? String(hit.name) : null;
}

/**
 * Values of aliased repository results (`r0`, `r1`, …), aligned with the batch; null for a
 * missing alias (`NOT_FOUND`).
 * @param {any} res `client.graphql()` result, or its `data`
 * @param {unknown[]} batch
 * @returns {any[]}
 */
export function parseAliases(res, batch) {
  const data = res && typeof res === 'object' && 'data' in res ? res.data : res;
  return batch.map((_, i) => data?.[`r${i}`] ?? null);
}

/**
 * @param {{owner: string, name: string}[]} batch
 * @returns {{owner: string, name: string}[]}
 */
function refsOf(batch) {
  return batch.map(({ owner, name }) => ({ owner, name }));
}

/**
 * The stored record of a repository: by name first (cheap), then by id (renames).
 * @param {any} store
 * @param {string} id
 * @param {string} nwo
 * @returns {Promise<RepoRecord | null>}
 */
async function existingRecord(store, id, nwo) {
  const byName = nwo ? await store.getRepo(nwo) : null;
  if (byName && byName.id === id) return byName;
  return id ? store.getRepoById(id) : null;
}

/**
 * Patch a candidate if the store knows it; otherwise return it unchanged.
 * @param {any} store
 * @param {Candidate} c
 * @param {Partial<Candidate>} set
 * @returns {Promise<Candidate>}
 */
async function patchIfKnown(store, c, set) {
  if (await store.getCandidate(c.id)) return store.patchCandidate(c.id, set);
  return { ...c, ...set };
}

/**
 * Remember owners that a spam gate caught (§3.11, §7.4): `farm` and `streak` are permanent.
 * @param {any} store
 * @param {{id: string, reason?: string}[]} gates
 * @param {Facts} facts
 */
async function rememberOwners(store, gates, facts) {
  for (const g of gates) {
    const flag = g.id === 'g.spam.farm' ? 'farm' : g.id === 'g.spam.streak' ? 'streak' : null;
    if (!flag) continue;
    /** @type {Record<string, unknown>} */
    const m = {
      login: facts.owner || ownerOf(facts.nwo),
      type: facts.ownerInfo?.type ?? 'User',
      flags: [flag],
      evidence: `${g.id}: ${String(g.reason ?? '').slice(0, 200)} (${facts.nwo})`,
    };
    if (typeof facts.ownerInfo?.publicRepos === 'number') m.publicRepos = facts.ownerInfo.publicRepos;
    await store.putOwner(m);
  }
}

/**
 * Mark a candidate gone (§3.5, §3.7); a kept record is kept, in the hidden `gone` lane.
 * @param {Candidate} candidate
 * @param {EnrichEnv} env
 * @returns {Promise<Candidate>}
 */
export async function markGone(candidate, env) {
  const at = isoNow(env.now);
  const existing = await existingRecord(env.store, candidate.id, candidate.nwo);
  if (existing?.facts) {
    const opts = { now: at, deps: env.lib };
    await env.store.putRepo(applyScore({ ...existing, gone: true, checkedAt: at }, env.config, opts));
  }
  return patchIfKnown(env.store, candidate, { state: 'gone', reason: 'not-found', nextAt: null });
}

/**
 * Turn one enriched node into Facts, score it and store the outcome: the candidate gets its state
 * (`enriched`, `quarantined`, or `dropped` by a drop gate) and `result`; the record is written if
 * kept, and a record that is no longer kept is removed.
 * @param {any} node the enrich-shaped node (GraphQL or REST fallback)
 * @param {Candidate} candidate
 * @param {EnrichEnv} env
 * @param {{heavy?: boolean, readmeRepair?: any}} [opts]
 * @returns {Promise<Enriched & {dropped: boolean}>}
 */
export async function settleNode(node, candidate, env, { heavy = false, readmeRepair = null } = {}) {
  const { store, config, lib } = env;
  const at = isoNow(env.now);
  const made = lib.factsFromEnrich(node, {
    fetchedAt: at, readmeRepair, source: heavy ? 'rest' : 'graphql', heavy, id: candidate.id,
  });
  /** @type {Facts} */
  const facts = { ...made, id: made?.id ?? candidate.id };
  if (heavy) Object.assign(facts, { heavy: true, source: 'rest' });
  const existing = await existingRecord(store, facts.id, facts.nwo);
  /** @type {RepoRecord} */
  const base = {
    v: 1,
    id: facts.id,
    nwo: facts.nwo,
    candidate: { ...candidate, ...liveFromFacts(facts) },
    facts,
    score: existing?.score ?? null,
    firstSeen: existing?.firstSeen ?? null,
    history: existing?.history ?? [],
    verdict: existing?.verdict && existing.verdict.headOid === facts.headOid ? existing.verdict : null,
    checkedAt: at,
    gone: false,
  };
  let record = applyScore(base, config, { now: at, deps: lib });
  const gates = record.score?.gates ?? [];
  const drop = gates.find((g) => g.action === 'drop');
  const quarantined = record.score?.lane === 'quarantine';
  /** @type {Candidate['state']} */
  const state = drop ? 'dropped' : quarantined ? 'quarantined' : 'enriched';
  const quarantineGate = gates.find((g) => g.action === 'quarantine');
  const reason = drop ? drop.id : quarantined ? (quarantineGate?.id ?? 'quarantine') : null;
  const snapshot = /** @type {Candidate} */ (record.candidate);
  record = { ...record, candidate: { ...snapshot, state, reason, nextAt: null } };
  await rememberOwners(store, gates, facts);

  const kept = !drop && (env.keepAll === true || isKept(record, {
    hasFeedback: env.feedbackIds?.has(record.id) ?? false, hasVerdict: Boolean(existing?.verdict),
  }));
  if (kept) await store.putRepo(record);
  else if (existing) await store.deleteRepo(existing.nwo);

  const set = {
    ...liveFromFacts(facts), state, reason, nextAt: null, explore: Boolean(candidate.explore),
    result: record.candidate?.result ?? null,
  };
  /** @type {Candidate} */
  let stored;
  if (await store.getCandidate(candidate.id)) stored = await store.patchCandidate(candidate.id, set);
  else {
    await store.putCandidates([{ ...candidate, ...set }]);
    stored = /** @type {Candidate} */ (await store.getCandidate(candidate.id));
  }
  return { candidate: stored, record, kept, dropped: Boolean(drop), heavy };
}

/**
 * Enrich candidates (§3.5). Yields one result per candidate, in the order the batches answer.
 * Rate-limit pauses, authentication errors and interrupts end the generator; other per-repository
 * failures leave the candidate queued (or `heavy` when the REST fallback failed too).
 * @param {Candidate[]} candidates
 * @param {EnrichEnv} env
 * @returns {AsyncGenerator<Enriched>}
 */
export async function* enrich(candidates, env) {
  const { client, lib, store, signal } = env;
  const log = env.log ?? SILENT_LOG;
  const stats = env.stats ?? emptyEnrichStats();
  const batch = env.batch ?? { size: 12, min: 1, max: 20, targetMs: 6000 };
  const items = candidates.map((candidate) => ({ candidate, ...splitNwo(candidate.nwo) }));
  /** @type {Map<object, any>} nodes fetched over REST */
  const viaRest = new Map();

  /** @param {{candidate: Candidate}} item */
  const restNode = async (item) => {
    try {
      const node = await lib.restFallback(client, item.candidate.nwo, { signal });
      viaRest.set(item, node ?? null);
      return node ?? null;
    } catch (err) {
      if (isFatal(err)) throw err;
      if (isNotFound(err)) {
        viaRest.set(item, null);
        return null;
      }
      log.debug('REST fallback failed', { nwo: item.candidate.nwo, error: err });
      viaRest.set(item, FAILED);
      return null;
    }
  };
  /** @param {{candidate: Candidate}} item */
  const onHeavy = async (item) => {
    stats.heavy++;
    return restNode(item);
  };

  /**
   * @param {{candidate: Candidate}} item
   * @param {any} node
   * @param {{heavy?: boolean, readmeRepair?: any}} opts
   * @returns {Promise<Enriched>}
   */
  const settle = async (item, node, opts) => {
    const out = await settleNode(node, item.candidate, env, opts);
    stats.repos++;
    if (out.kept) stats.kept++;
    if (out.dropped) stats.dropped++;
    if (item.candidate.explore) stats.explore++;
    return out;
  };

  /**
   * @param {{item: any, node: any, file: string}[]} list
   * @returns {AsyncGenerator<Enriched>}
   */
  async function* repair(list) {
    const { doc, variables } = lib.readmeRepairQuery(list.map(({ item, file }) => ({
      owner: item.owner, name: item.name, file, path: file,
    })));
    /** @type {any} */
    let data = null;
    try {
      const res = await client.graphql(doc, variables, { kind: 'graphql', signal });
      data = res?.data ?? null;
      stats.repairs++;
    } catch (err) {
      if (isFatal(err)) throw err;
      log.debug('README repair failed; scoring without it', { error: err });
    }
    for (const [i, p] of list.entries()) {
      const blob = data?.[`r${i}`]?.readme ?? null;
      const readmeRepair = blob ? { ...blob, name: p.file } : null;
      const node = readmeRepair ? { ...p.node, readme: readmeRepair } : p.node;
      yield await settle(p.item, node, { readmeRepair });
    }
  }

  /** @type {{item: any, node: any, file: string}[]} */
  const toRepair = [];
  const results = lib.runBatched(items, {
    client,
    build: (/** @type {any[]} */ b) => lib.aliasedRepoQuery('Enrich', lib.ENRICH_FRAGMENT, refsOf(b)),
    parse: parseAliases,
    size: batch.size,
    min: batch.min,
    max: batch.max,
    targetMs: batch.targetMs,
    onHeavy,
    phase: 'enrich',
    signal,
  });
  for await (const r of results) {
    const item = r?.item;
    if (!item) continue;
    const c = item.candidate;
    let node = r.value ?? null;
    let heavy = false;
    if (viaRest.has(item)) {
      heavy = true;
      node = viaRest.get(item);
    } else if (r.error) {
      if (isFatal(r.error)) throw r.error;
      if (r.error?.name === 'HeavyQueryError') {
        stats.heavy++;
        heavy = true;
        await restNode(item);
        node = viaRest.get(item);
      } else {
        stats.failed++;
        log.debug('Enrich failed; the candidate stays queued', { nwo: c.nwo, error: r.error });
        yield { candidate: c, record: null, error: r.error };
        continue;
      }
    }
    if (node === FAILED) {
      stats.failed++;
      const failed = await patchIfKnown(store, c, { state: 'heavy', reason: 'fetch-failed' });
      yield { candidate: failed, record: null, heavy: true };
      continue;
    }
    if (!node) {
      stats.gone++;
      yield { candidate: await markGone(c, env), record: null, gone: true };
      continue;
    }
    const file = heavy ? null : readmeToRepair(node);
    if (file) {
      toRepair.push({ item, node, file });
      if (toRepair.length >= REPAIR_BATCH) yield* repair(toRepair.splice(0));
      continue;
    }
    yield await settle(item, node, { heavy });
  }
  if (toRepair.length > 0) yield* repair(toRepair.splice(0));
}
