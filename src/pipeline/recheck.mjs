// @ts-check
/**
 * Stage S6 (DESIGN §3.7): existence and traction refresh with `nodes(ids:)`, 100 ids per call.
 *
 * - The top `top` index entries (by `gem`) not checked for 24 hours: a null node means `gone`
 *   (hidden everywhere, kept 30 days); otherwise live stars, forks, `pushedAt`, archived state and
 *   language are refreshed and the score recomputed. A push after an enrich at least 7 days old
 *   re-queues the repository with `prior + 2`.
 * - Deferred candidates past `nextAt` are re-checked the same way and pass the prefilter again.
 */

import { applyScore, resultOf } from './indexer.mjs';
import {
  REQUEUE_AFTER_DAYS, candidateFromFacts, ownerOf, prefilterSeed, seedFromCandidate,
} from './candidates.mjs';
import { loadDeps } from './deps.mjs';
import { SILENT_LOG, daysFrom, isoNow } from './util.mjs';

/** @typedef {import('../core/schema.mjs').RepoRecord} RepoRecord */
/** @typedef {import('../core/schema.mjs').Candidate} Candidate */
/** @typedef {import('./deps.mjs').Lib} Lib */

/** Ids per `nodes(ids:)` call (§3.7). */
export const IDS_PER_CALL = 100;

/** Index entries checked within this many hours are skipped (§3.1 S6). */
export const RECHECK_AFTER_HOURS = 24;

/**
 * @typedef {object} RecheckStats
 * @property {number} checked repositories and deferred candidates that answered
 * @property {number} gone
 * @property {number} requeued
 */

/**
 * @param {Lib} lib
 * @param {string[]} ids
 * @returns {{doc: string, variables: Record<string, unknown>}}
 */
function existsDoc(lib, ids) {
  const q = lib.existsQuery(ids);
  if (typeof q === 'string') return { doc: q, variables: { ids } };
  return { doc: q.doc, variables: q.variables ?? { ids } };
}

/**
 * Re-check repositories and due deferred candidates.
 * @param {object} opts
 * @param {any} opts.client
 * @param {any} opts.store
 * @param {import('../config.mjs').Config} opts.config
 * @param {(() => string) | string} [opts.now]
 * @param {number} [opts.top] index entries to consider (default 100)
 * @param {boolean} [opts.deferred] also re-check due deferred candidates (default true)
 * @param {Lib} [opts.deps]
 * @param {import('../log.mjs').Log} [opts.log]
 * @param {AbortSignal} [opts.signal] Ctrl-C: stops new requests and ends any rate-limit wait
 * @returns {Promise<RecheckStats>}
 */
export async function recheck({
  client, store, config, now, top = 100, deferred = true, deps, log = SILENT_LOG, signal,
}) {
  const lib = deps ?? await loadDeps();
  const at = isoNow(now);
  const stats = { checked: 0, gone: 0, requeued: 0 };

  /** @type {RepoRecord[]} */
  const records = [];
  const index = await store.readIndex();
  const entries = [...(index?.entries ?? [])]
    .filter((e) => e && e.lane !== 'quarantine' && e.lane !== 'gone')
    .sort((a, b) => (b.gem ?? 0) - (a.gem ?? 0));
  for (const e of entries) {
    if (records.length >= top) break;
    const rec = (await store.getRepoById(e.id)) ?? (await store.getRepo(e.nwo));
    if (!rec || rec.gone) continue;
    if (rec.checkedAt && daysFrom(rec.checkedAt, at) * 24 < RECHECK_AFTER_HOURS) continue;
    records.push(rec);
  }
  /** @type {Candidate[]} */
  const due = deferred ? await store.dueDeferred(at) : [];

  const ids = [...new Set([...records.map((r) => r.id), ...due.map((c) => c.id)])];
  /** @type {Map<string, any>} */
  const live = new Map();
  for (let i = 0; i < ids.length; i += IDS_PER_CALL) {
    const chunk = ids.slice(i, i + IDS_PER_CALL);
    const { doc, variables } = existsDoc(lib, chunk);
    const res = await client.graphql(doc, variables, { kind: 'graphql', signal });
    const nodes = Array.isArray(res?.data?.nodes) ? res.data.nodes : [];
    chunk.forEach((id, j) => {
      const node = nodes[j];
      live.set(id, node && typeof node === 'object' && node.id ? node : null);
    });
  }

  for (const rec of records) {
    const node = live.get(rec.id) ?? null;
    if (!node) {
      const gone = applyScore({ ...rec, gone: true, checkedAt: at }, config, { now: at, deps: lib });
      await store.putRepo(gone);
      if (await store.getCandidate(rec.id)) {
        await store.patchCandidate(rec.id, {
          state: 'gone', reason: 'not-found', nextAt: null, result: resultOf(gone),
        });
      }
      stats.gone++;
      continue;
    }
    const f = rec.facts;
    const pushed = node.pushedAt && f.pushedAt && Date.parse(node.pushedAt) > Date.parse(f.pushedAt);
    const facts = {
      ...f,
      stars: node.stargazerCount ?? f.stars,
      forks: node.forkCount ?? f.forks,
      pushedAt: node.pushedAt ?? f.pushedAt,
      isArchived: node.isArchived ?? f.isArchived,
      primaryLanguage: node.primaryLanguage?.name ?? f.primaryLanguage,
    };
    const next = applyScore({ ...rec, facts, checkedAt: at }, config, { now: at, deps: lib });
    await store.putRepo(next);
    stats.checked++;
    const cand = await store.getCandidate(rec.id);
    const live1 = {
      stars: facts.stars, forks: facts.forks, pushedAt: facts.pushedAt, result: resultOf(next),
    };
    if (pushed && daysFrom(f.fetchedAt, at) >= REQUEUE_AFTER_DAYS) {
      if (cand) {
        await store.patchCandidate(rec.id, {
          ...live1, state: 'queued', reason: 'pushed', prior: (cand.prior ?? 0) + 2, seenAt: at,
        });
      } else {
        const fresh = candidateFromFacts(facts, { source: 'recheck', now: at, prior: 2, state: 'queued' });
        await store.putCandidates([{ ...fresh, reason: 'pushed' }]);
      }
      stats.requeued++;
    } else if (cand) {
      await store.patchCandidate(rec.id, live1);
    }
  }

  for (const c of due) {
    const node = live.get(c.id) ?? null;
    if (!node) {
      await store.patchCandidate(c.id, { state: 'gone', reason: 'not-found', nextAt: null });
      stats.gone++;
      continue;
    }
    const lang = node.primaryLanguage?.name ?? null;
    const seed = seedFromCandidate(c, {
      stars: node.stargazerCount, forks: node.forkCount, pushedAt: node.pushedAt, lang,
      isArchived: node.isArchived,
    });
    const owner = await store.getOwner(ownerOf(c.nwo));
    const pre = prefilterSeed(seed, {
      lib, now: at, maxStars: config.defaults.maxStars, ownerCapPerDay: config.defaults.ownerCapPerDay, owner,
    });
    const prior = Math.max(pre.prior, c.prior + (!c.lang && lang ? 1 : 0));
    await store.patchCandidate(c.id, {
      state: pre.state, reason: pre.reason, nextAt: pre.state === 'deferred' ? pre.nextAt : null, prior,
      lang, stars: seed.stars, forks: seed.forks, pushedAt: seed.pushedAt,
    });
    stats.checked++;
    if (pre.state === 'queued') stats.requeued++;
  }
  log.debug('Re-check finished', stats);
  return stats;
}
