// @ts-check
/**
 * Stages S4–S5 (DESIGN §3.6): deepen the best scored repositories — recursive tree (cached by
 * commit forever), activity, star history (only at 3 stars or more), the Deep GraphQL fragment
 * five at a time and workflow and manifest texts — merge into `Facts` and rescore.
 */

import { applyScore, isKept, resultOf } from './indexer.mjs';
import { SILENT_LOG, isFatal, isoNow, splitNwo } from './util.mjs';
import { parseAliases } from './enrich.mjs';

/** @typedef {import('../core/schema.mjs').RepoRecord} RepoRecord */
/** @typedef {import('../core/schema.mjs').Facts} Facts */
/** @typedef {import('./deps.mjs').Lib} Lib */

/** Lanes whose repositories are deepened (§3.6). */
export const DEEP_LANES = Object.freeze(['promising', 'proven', 'look', 'doubted']);

/** Workflow files fetched per repository, preferring names that suggest tests (§3.6). */
const MAX_WORKFLOWS = 3;
const TESTY = /test|ci|build|check/i;

/** Star history is fetched only from this many stars (§3.6). */
export const STAR_HISTORY_FROM = 3;

/**
 * @param {{owner: string, name: string}[]} batch
 * @returns {{owner: string, name: string}[]}
 */
const refsOf = (batch) => batch.map(({ owner, name }) => ({ owner, name }));

/**
 * @typedef {object} DeepStats
 * @property {number} repos deepened
 * @property {number} errors deep responses that failed (the repository is rescored without them)
 * @property {number} treeCached trees taken from the cache
 */

/** @returns {DeepStats} */
export function emptyDeepStats() {
  return { repos: 0, errors: 0, treeCached: 0 };
}

/**
 * Whether a record's deep facts are missing or belong to an older head (`mergeDeep` stamps
 * `deepHeadOid`, the head the deep data was fetched at).
 * @param {{facts?: any}} record
 * @returns {boolean}
 */
export function needsDeep(record) {
  const f = record?.facts;
  if (!f || !f.headOid) return false;
  const stages = Array.isArray(f.stages) ? f.stages : [];
  if (!stages.includes('deep')) return true;
  return f.deepHeadOid !== undefined && f.deepHeadOid !== null && f.deepHeadOid !== f.headOid;
}

/**
 * The `n` highest-`gem` records in the deep lanes that need deep facts (§3.6).
 * @template {{score?: any, facts?: any, nwo: string}} R
 * @param {R[]} records
 * @param {number} n
 * @returns {R[]}
 */
export function selectDeep(records, n) {
  return records
    .filter((r) => r?.score && DEEP_LANES.includes(r.score.lane) && needsDeep(/** @type {any} */ (r)))
    .sort((a, b) => (b.score.gem - a.score.gem)
      || ((a.score.attention?.stars ?? 0) - (b.score.attention?.stars ?? 0))
      || String(b.facts?.createdAt ?? '').localeCompare(String(a.facts?.createdAt ?? ''))
      || a.nwo.localeCompare(b.nwo))
    .slice(0, Math.max(0, Math.floor(n)));
}

/**
 * The files to fetch for a repository (§3.6 step 5): up to three workflow files, preferring names
 * that match `test|ci|build|check`, and the first root manifest other than `package.json`.
 * @param {Facts} facts
 * @param {Lib} lib
 * @returns {string[]}
 */
export function choosePaths(facts, lib) {
  const names = (facts.workflows ?? []).map((w) => String(w?.name ?? '')).filter((n) => /\.ya?ml$/i.test(n));
  const ordered = [...names.filter((n) => TESTY.test(n)), ...names.filter((n) => !TESTY.test(n))];
  const paths = ordered.slice(0, MAX_WORKFLOWS).map((n) => `.github/workflows/${n}`);
  const manifest = (facts.root ?? []).find((e) => e?.type === 'blob'
    && String(e.name).toLowerCase() !== 'package.json' && lib.isManifest(e.name));
  if (manifest) paths.push(String(manifest.name));
  return paths;
}

/**
 * @typedef {object} DeepEnv
 * @property {any} client the (metered) GitHub client
 * @property {any} store
 * @property {import('../config.mjs').Config} config
 * @property {Lib} lib
 * @property {(() => string) | string} [now]
 * @property {import('../log.mjs').Log} [log]
 * @property {{size: number, min: number, max: number, targetMs: number}} [batch]
 * @property {Set<string>} [feedbackIds]
 * @property {boolean} [keepAll]
 * @property {DeepStats} [stats]
 * @property {AbortSignal} [signal] Ctrl-C: stops new requests and ends any rate-limit wait (§3.12)
 * @property {number} [restConcurrency] REST reads in flight at once (default 2, the governor's cap)
 */

/**
 * Run tasks with at most `limit` in flight and return their results in task order. The first
 * failure stops new tasks from starting; the ones in flight finish, then it is thrown.
 * @template T
 * @param {(() => Promise<T>)[]} tasks
 * @param {number} limit
 * @returns {Promise<T[]>}
 */
export async function pool(tasks, limit) {
  /** @type {T[]} */
  const results = new Array(tasks.length);
  let next = 0;
  let failed = false;
  /** @type {unknown} */
  let failure = null;
  const worker = async () => {
    while (!failed && next < tasks.length) {
      const i = next++;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        if (!failed) {
          failed = true;
          failure = err;
        }
      }
    }
  };
  const width = Math.max(1, Math.min(Math.floor(Number(limit)) || 1, tasks.length));
  await Promise.all(Array.from({ length: width }, worker));
  if (failed) throw failure;
  return results;
}

/**
 * Deepen records five at a time and yield each rescored record as soon as it is stored. A chunk's
 * REST reads (tree, activity, star history) run `restConcurrency` at a time.
 * @param {RepoRecord[]} records
 * @param {DeepEnv} env
 * @returns {AsyncGenerator<RepoRecord>}
 */
export async function* deepen(records, env) {
  const { client, store, config, lib, signal } = env;
  const log = env.log ?? SILENT_LOG;
  const stats = env.stats ?? emptyDeepStats();
  const batch = env.batch ?? { size: 5, min: 1, max: 10, targetMs: 5000 };
  const chunkSize = Math.max(1, batch.size);
  const restConcurrency = Math.max(1, Math.floor(Number(env.restConcurrency)) || 2);

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @param {string} what
   * @param {string} nwo
   * @returns {Promise<T | null>}
   */
  const quietly = async (fn, what, nwo) => {
    try {
      return (await fn()) ?? null;
    } catch (err) {
      if (isFatal(err)) throw err;
      stats.errors++;
      log.debug(`Deep ${what} failed`, { nwo, error: err });
      return null;
    }
  };

  for (let i = 0; i < records.length; i += chunkSize) {
    const items = records.slice(i, i + chunkSize).map((rec) => ({ rec, ...splitNwo(rec.nwo) }));

    /** @type {Map<object, any>} */
    const deepNodes = new Map();
    for await (const r of lib.runBatched(items, {
      client,
      build: (/** @type {any[]} */ b) => lib.aliasedRepoQuery('Deep', lib.DEEP_FRAGMENT, refsOf(b)),
      parse: parseAliases,
      size: batch.size, min: batch.min, max: batch.max, targetMs: batch.targetMs, phase: 'deep', signal,
    })) {
      if (r?.error) {
        if (isFatal(r.error)) throw r.error;
        stats.errors++;
        continue;
      }
      if (r?.item) deepNodes.set(r.item, r.value ?? null);
    }

    const fileItems = items.map((it) => ({ ...it, paths: choosePaths(it.rec.facts, lib) }))
      .filter((it) => it.paths.length > 0);
    /** @type {Map<object, Record<string, {byteSize: number, text: string | null} | null>>} */
    const filesOf = new Map();
    if (fileItems.length > 0) {
      for await (const r of lib.runBatched(fileItems, {
        client,
        build: (/** @type {any[]} */ b) => lib.filesQuery(b.map(({ owner, name, paths }) => ({
          owner, name, paths,
        }))),
        parse: (/** @type {any} */ res, /** @type {any[]} */ b) => parseAliases(res, b).map((node, k) => {
          if (!node) return null;
          /** @type {Record<string, {byteSize: number, text: string | null} | null>} */
          const out = {};
          b[k].paths.forEach((/** @type {string} */ p, /** @type {number} */ j) => {
            const blob = node[`f${j}`];
            out[p] = blob ? { byteSize: blob.byteSize ?? 0, text: blob.text ?? null } : null;
          });
          return out;
        }),
        size: batch.size, min: batch.min, max: batch.max, targetMs: batch.targetMs, phase: 'deep', signal,
      })) {
        if (r?.error) {
          if (isFatal(r.error)) throw r.error;
          stats.errors++;
          continue;
        }
        if (r?.item) filesOf.set(r.item.rec, r.value ?? null);
      }
    }

    /** @type {{tree: any, activity: any, starHistory: any}[]} the chunk's REST answers, by item */
    const restOf = items.map(() => ({ tree: null, activity: null, starHistory: null }));
    /** @type {(() => Promise<void>)[]} */
    const tasks = [];
    items.forEach(({ rec }, k) => {
      const head = /** @type {string} */ (rec.facts.headOid);
      tasks.push(async () => {
        let tree = await store.getTree(head);
        if (tree) stats.treeCached++;
        else {
          tree = await quietly(() => lib.recursiveTree(client, rec.nwo, head, { signal }), 'tree', rec.nwo);
          if (tree) await store.putTree(head, tree);
        }
        restOf[k].tree = tree;
      });
      tasks.push(async () => {
        restOf[k].activity = await quietly(() => lib.activity(client, rec.nwo, { signal }), 'activity', rec.nwo);
      });
      if ((rec.facts.stars ?? 0) >= STAR_HISTORY_FROM) {
        tasks.push(async () => {
          restOf[k].starHistory = await quietly(() => lib.starHistory(client, rec.nwo, { signal }),
            'star history', rec.nwo);
        });
      }
    });
    await pool(tasks, restConcurrency);

    for (const [k, it] of items.entries()) {
      const { rec } = it;
      const f = rec.facts;
      const { tree, activity, starHistory } = restOf[k];
      const at = isoNow(env.now);
      const facts = lib.mergeDeep(f, {
        node: deepNodes.get(it) ?? null, tree, activity, starHistory, files: filesOf.get(rec) ?? null,
      }, { fetchedAt: at });
      const next = applyScore({ ...rec, facts }, config, { now: at, deps: lib });
      const hasFeedback = env.feedbackIds?.has(next.id) ?? false;
      const kept = env.keepAll === true || isKept(next, { hasFeedback });
      if (kept) await store.putRepo(next);
      else await store.deleteRepo(next.nwo);
      const result = resultOf(next);
      if (result && await store.getCandidate(next.id)) await store.patchCandidate(next.id, { result });
      stats.repos++;
      yield next;
    }
  }
}
