// @ts-check
/**
 * From seeds to candidates (DESIGN §3.4, §4.2, §4.3): the prefilter, the partition day, merging a
 * seed into a candidate the store already knows, owner memory (rule 7) and the owner cap
 * (rule 10). The pure prefilter (`src/core/gates.mjs#prefilter`) decides rules 1–6, 8, 9 and the
 * prior; rules 7 and 10 need the store and the whole run, so they are applied here, in the same
 * order: rule 7 overrides anything rules 8–11 would decide, and rule 10 applies only to what would
 * otherwise be queued.
 */

import { dayOf } from '../store/common.mjs';
import { daysFrom } from './util.mjs';

/** @typedef {import('../core/schema.mjs').Candidate} Candidate */
/** @typedef {import('../core/schema.mjs').CandidateSeed} CandidateSeed */
/** @typedef {import('../core/schema.mjs').Facts} Facts */
/** @typedef {import('./deps.mjs').Lib} Lib */

/** Reasons the prefilter rules 1–6 give; owner memory (rule 7) never overrides them. */
const EARLY_REASONS = new Set([
  'excluded-kind', 'attention', 'too-small', 'profile-or-site', 'lure-name', 'spam-words',
]);

/** Prefilter reasons (§3.4). A candidate dropped for one of these is looked at again when re-seen. */
const PREFILTER_REASONS = new Set([
  ...EARLY_REASONS, 'farm-owner', 'no-language', 'no-language-yet', 'owner-cap',
]);

/** Owner flags that make the prefilter drop an owner's later repositories (§3.4 rule 7, §7.4). */
const FARM_FLAGS = new Set(['farm', 'streak']);

/** An owner with this many candidates in one created-day is remembered as `prolific` (§7.4). */
export const PROLIFIC_AT = 50;

/** Days after the last enrich before a push re-queues a repository (§3.7). */
export const REQUEUE_AFTER_DAYS = 7;

/** Nothing known: handed to the pure prefilter, which then never applies rules 7 and 10 itself. */
const NOTHING = new Map();

/**
 * @typedef {object} PrefilterResult
 * @property {Candidate['state']} state
 * @property {string | null} reason
 * @property {number} prior
 * @property {string | null} nextAt
 * @property {unknown[]} gates
 */

/**
 * @param {string} nwo
 * @returns {string} the owner login
 */
export function ownerOf(nwo) {
  return String(nwo ?? '').split('/')[0] ?? '';
}

/**
 * Partition day of a seed (§4.2): the created day for census seeds, the day it was seen otherwise.
 * @param {{source?: string, createdAt: string}} seed
 * @param {string} seenAt
 * @returns {string}
 */
export function partitionDay(seed, seenAt) {
  return String(seed.source ?? '').startsWith('census:') ? dayOf(seed.createdAt) : dayOf(seenAt);
}

/**
 * Run the pure prefilter and apply owner memory (rule 7).
 * @param {CandidateSeed} seed
 * @param {{lib: Lib, now: string, maxStars: number, ownerCapPerDay: number,
 *   owner: import('../core/schema.mjs').OwnerMemory | null}} ctx
 * @returns {PrefilterResult}
 */
export function prefilterSeed(seed, { lib, now, maxStars, ownerCapPerDay, owner }) {
  // Owner memory goes in as a lookup function (so rule 7 reports its gate); the owner cap is left
  // to `ingestSeeds`, which sees the whole run.
  const ownerLogin = String(owner?.login ?? '').toLowerCase();
  /** @param {string} login */
  const ownerMemory = (login) => (owner && login.toLowerCase() === ownerLogin ? owner : null);
  const pre = lib.prefilter(seed, { now, maxStars, ownerMemory, ownerCounts: NOTHING, ownerCapPerDay });
  /** @type {PrefilterResult} */
  const out = {
    state: pre?.state ?? 'queued',
    reason: pre?.reason ?? null,
    prior: Number.isFinite(pre?.prior) ? pre.prior : 0,
    nextAt: pre?.nextAt ?? null,
    gates: Array.isArray(pre?.gates) ? pre.gates : [],
  };
  const flagged = (owner?.flags ?? []).some((f) => FARM_FLAGS.has(f));
  if (flagged && !EARLY_REASONS.has(String(out.reason))) {
    return { ...out, state: 'dropped', reason: 'farm-owner', nextAt: null };
  }
  return out;
}

/**
 * A new candidate from a seed and its prefilter result.
 * @param {CandidateSeed} seed
 * @param {PrefilterResult} pre
 * @param {string} now
 * @returns {Candidate}
 */
export function candidateFromSeed(seed, pre, now) {
  return {
    v: 1,
    id: seed.id,
    nwo: seed.nwo,
    day: partitionDay(seed, now),
    createdAt: seed.createdAt,
    pushedAt: seed.pushedAt ?? null,
    stars: seed.stars ?? 0,
    forks: seed.forks ?? 0,
    diskKB: seed.diskKB ?? 0,
    lang: seed.lang ?? null,
    licence: seed.licence ?? null,
    hasDesc: Boolean(seed.hasDesc),
    ownerType: seed.ownerType ?? null,
    sources: [seed.source],
    seenAt: now,
    prior: pre.prior,
    explore: false,
    state: pre.state,
    reason: pre.reason,
    nextAt: pre.state === 'deferred' ? pre.nextAt : null,
    result: null,
  };
}

/**
 * A seed-shaped view of a candidate, for passing it through the prefilter again (§3.7).
 * @param {Candidate} c
 * @param {{stars?: number, forks?: number, pushedAt?: string | null, lang?: string | null,
 *   isArchived?: boolean}} [live]
 * @returns {CandidateSeed}
 */
export function seedFromCandidate(c, live = {}) {
  return {
    id: c.id,
    nwo: c.nwo,
    createdAt: c.createdAt,
    pushedAt: live.pushedAt ?? c.pushedAt,
    stars: live.stars ?? c.stars,
    forks: live.forks ?? c.forks,
    diskKB: c.diskKB,
    lang: live.lang !== undefined ? live.lang : c.lang,
    licence: c.licence,
    hasDesc: c.hasDesc,
    description: null,
    ownerType: c.ownerType,
    isFork: false,
    isArchived: live.isArchived ?? false,
    isTemplate: false,
    isMirror: false,
    source: c.sources?.[0] ?? 'recheck',
  };
}

/**
 * Candidate fields that mirror live repository values in `Facts`.
 * @param {Facts} facts
 * @returns {Partial<Candidate>}
 */
export function liveFromFacts(facts) {
  /** @type {Record<string, unknown>} */
  const out = {
    nwo: facts.nwo,
    pushedAt: facts.pushedAt,
    stars: facts.stars,
    forks: facts.forks,
    diskKB: facts.diskKB,
    lang: facts.primaryLanguage,
    licence: facts.licence,
    ownerType: facts.ownerInfo?.type,
  };
  if (facts.description !== undefined) {
    out.hasDesc = typeof facts.description === 'string' && facts.description !== '';
  }
  for (const [k, v] of Object.entries(out)) {
    if (v === undefined || (v === null && k !== 'licence' && k !== 'lang')) delete out[k];
  }
  return /** @type {Partial<Candidate>} */ (out);
}

/**
 * A candidate built from enriched facts (`add` and `sample`, which have no census seed).
 * @param {Facts} facts
 * @param {{source: string, now: string, prior?: number, state?: Candidate['state']}} opts
 * @returns {Candidate}
 */
export function candidateFromFacts(facts, { source, now, prior = 0, state = 'enriched' }) {
  return {
    v: 1,
    id: facts.id,
    nwo: facts.nwo,
    day: dayOf(now),
    createdAt: facts.createdAt ?? now,
    pushedAt: facts.pushedAt ?? null,
    stars: facts.stars ?? 0,
    forks: facts.forks ?? 0,
    diskKB: facts.diskKB ?? 0,
    lang: facts.primaryLanguage ?? null,
    licence: facts.licence ?? null,
    hasDesc: typeof facts.description === 'string' && facts.description !== '',
    ownerType: facts.ownerInfo?.type ?? null,
    sources: [source],
    seenAt: now,
    prior,
    explore: false,
    state,
    reason: null,
    nextAt: null,
    result: null,
  };
}

/**
 * Merge a seed into a known candidate: sources accumulate and live values refresh. A deferred,
 * expired or gone candidate, or one dropped by a prefilter rule, takes the new prefilter result;
 * a queued one keeps the higher prior; an enriched one is re-queued (prior + 2) when it was pushed
 * after an enrich at least 7 days old (§3.7, §3.11). Quarantined, heavy and gate-dropped
 * candidates keep their state.
 * @param {Candidate} cur
 * @param {CandidateSeed} seed
 * @param {PrefilterResult} pre
 * @param {string} now
 * @returns {{next: Candidate, reopened: boolean}}
 */
export function mergeSeed(cur, seed, pre, now) {
  const sources = cur.sources.includes(seed.source) ? cur.sources : [...cur.sources, seed.source];
  /** @type {Candidate} */
  const next = {
    ...cur,
    nwo: seed.nwo ?? cur.nwo,
    pushedAt: seed.pushedAt ?? cur.pushedAt,
    stars: seed.stars ?? cur.stars,
    forks: seed.forks ?? cur.forks,
    diskKB: seed.diskKB ?? cur.diskKB,
    lang: seed.lang ?? cur.lang,
    licence: seed.licence ?? cur.licence,
    hasDesc: seed.hasDesc ?? cur.hasDesc,
    ownerType: seed.ownerType ?? cur.ownerType,
    sources,
  };
  const reopen = cur.state === 'deferred' || cur.state === 'expired' || cur.state === 'gone'
    || (cur.state === 'dropped' && PREFILTER_REASONS.has(String(cur.reason)));
  if (reopen) {
    return {
      next: {
        ...next, state: pre.state, reason: pre.reason, prior: pre.prior,
        nextAt: pre.state === 'deferred' ? pre.nextAt : null, seenAt: now,
      },
      reopened: true,
    };
  }
  if (cur.state === 'queued') {
    return { next: { ...next, prior: Math.max(cur.prior, pre.prior) }, reopened: false };
  }
  if (cur.state === 'enriched') {
    const pushed = seed.pushedAt && cur.pushedAt && Date.parse(seed.pushedAt) > Date.parse(cur.pushedAt);
    const lastEnrich = cur.result?.at ?? cur.seenAt;
    if (pushed && daysFrom(lastEnrich, now) >= REQUEUE_AFTER_DAYS) {
      return {
        next: { ...next, state: 'queued', reason: 'pushed', prior: pre.prior + 2, seenAt: now },
        reopened: true,
      };
    }
  }
  return { next, reopened: false };
}

/**
 * @typedef {object} PrefilterStats
 * @property {number} in seeds seen
 * @property {number} queued
 * @property {number} deferred
 * @property {number} quarantined
 * @property {Record<string, number>} dropped by reason
 * @property {number} known seeds for candidates already known, whose state did not change
 */

/** @returns {PrefilterStats} */
export function emptyPrefilterStats() {
  return { in: 0, queued: 0, deferred: 0, quarantined: 0, dropped: {}, known: 0 };
}

/**
 * @param {PrefilterStats} stats
 * @param {string} state
 * @param {string | null} reason
 * @param {number} delta
 */
function count(stats, state, reason, delta) {
  if (state === 'dropped') {
    const r = reason ?? 'other';
    stats.dropped[r] = (stats.dropped[r] ?? 0) + delta;
    if (stats.dropped[r] === 0) delete stats.dropped[r];
  } else if (state === 'queued' || state === 'deferred' || state === 'quarantined') {
    stats[state] += delta;
  }
}

/**
 * Run-wide state for the owner cap (§3.4 rule 10) and `prolific` owner memory.
 * @typedef {object} OwnerCaps
 * @property {Map<string, {queued: {id: string, prior: number}[], total: number, flagged: boolean}>} slots
 *   keyed `<created-day>|<login>`
 * @property {Set<string>} loadedDays partitions whose queued candidates have been counted
 */

/** @returns {OwnerCaps} */
export function createOwnerCaps() {
  return { slots: new Map(), loadedDays: new Set() };
}

/**
 * Prefilter a batch of seeds and store the result: new candidates are appended, known ones merged
 * (never duplicated), the owner cap keeps the five highest-prior candidates of an owner per
 * created-day, and owners with 50 candidates in a day are remembered as `prolific`.
 * @param {CandidateSeed[]} seeds
 * @param {object} env
 * @param {any} env.store
 * @param {Lib} env.lib
 * @param {string} env.now
 * @param {number} env.maxStars
 * @param {number} env.ownerCapPerDay
 * @param {OwnerCaps} env.caps
 * @param {PrefilterStats} env.stats
 * @returns {Promise<Candidate[]>} the stored candidates for these seeds (after merging)
 */
export async function ingestSeeds(seeds, { store, lib, now, maxStars, ownerCapPerDay, caps, stats }) {
  const list = (Array.isArray(seeds) ? seeds : [])
    .filter((s) => s && typeof s.id === 'string' && s.id !== '');
  /** @type {{seed: CandidateSeed, pre: PrefilterResult}[]} */
  const judged = [];
  for (const seed of list) {
    const owner = await store.getOwner(ownerOf(seed.nwo));
    judged.push({ seed, pre: prefilterSeed(seed, { lib, now, maxStars, ownerCapPerDay, owner }) });
  }
  // Higher priors claim an owner's slots first (rule 10 keeps the five with the highest prior).
  judged.sort((a, b) => b.pre.prior - a.pre.prior);

  /** @type {Map<string, Candidate>} */
  const out = new Map();
  /** @type {Map<string, Record<string, unknown>>} demotions of candidates already stored */
  const demote = new Map();
  /** @type {string[]} */
  const prolific = [];

  for (const { seed, pre } of judged) {
    stats.in++;
    const cur = out.get(seed.id) ?? await store.getCandidate(seed.id);
    /** @type {Candidate} */
    let next;
    let changed = true;
    if (cur) {
      const merged = mergeSeed(cur, seed, pre, now);
      next = merged.next;
      changed = merged.reopened && !out.has(seed.id);
      if (!merged.reopened && !out.has(seed.id)) stats.known++;
    } else {
      next = candidateFromSeed(seed, pre, now);
    }

    const createdDay = dayOf(seed.createdAt);
    const login = ownerOf(seed.nwo).toLowerCase();
    if (!caps.loadedDays.has(createdDay)) {
      caps.loadedDays.add(createdDay);
      for (const c of await store.listCandidates({ day: createdDay })) {
        if (dayOf(c.createdAt) !== createdDay) continue;
        const key = `${createdDay}|${ownerOf(c.nwo).toLowerCase()}`;
        const slot = caps.slots.get(key) ?? { queued: [], total: 0, flagged: false };
        slot.total++;
        if (c.state === 'queued') slot.queued.push({ id: c.id, prior: c.prior });
        caps.slots.set(key, slot);
      }
    }
    const key = `${createdDay}|${login}`;
    const slot = caps.slots.get(key) ?? { queued: [], total: 0, flagged: false };
    caps.slots.set(key, slot);
    if (!cur) slot.total++;
    if (slot.total >= PROLIFIC_AT && !slot.flagged) {
      slot.flagged = true;
      prolific.push(ownerOf(seed.nwo));
    }

    if (next.state === 'queued' && !slot.queued.some((q) => q.id === next.id)) {
      if (slot.queued.length < ownerCapPerDay) {
        slot.queued.push({ id: next.id, prior: next.prior });
      } else {
        const lowest = slot.queued.reduce((a, b) => (b.prior < a.prior ? b : a));
        if (next.prior > lowest.prior) {
          slot.queued.splice(slot.queued.indexOf(lowest), 1, { id: next.id, prior: next.prior });
          const pending = out.get(lowest.id);
          if (pending) out.set(lowest.id, { ...pending, state: 'dropped', reason: 'owner-cap' });
          else demote.set(lowest.id, { state: 'dropped', reason: 'owner-cap' });
          count(stats, 'queued', null, -1);
          count(stats, 'dropped', 'owner-cap', 1);
        } else {
          next = { ...next, state: 'dropped', reason: 'owner-cap', nextAt: null };
        }
      }
    }
    if (changed) count(stats, next.state, next.reason, 1);
    out.set(seed.id, next);
  }

  await store.putCandidates([...out.values()]);
  for (const [id, set] of demote) await store.patchCandidate(id, set);
  for (const login of prolific) {
    const evidence = `${PROLIFIC_AT} or more candidates in one created-day`;
    await store.putOwner({ login, flags: ['prolific'], evidence });
  }
  return [...out.values()];
}
