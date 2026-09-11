// @ts-check
/**
 * The ID-walk sampler (DESIGN §3.1 S0c), used only by `unsung sample` for calibration (§14.3). It
 * draws uniform random repository ids, reads the block of public repositories that follows each
 * (`GET /repositories?since=`, one REST call per 100 ids), looks the non-fork ones up with lean
 * aliased queries (one point per 100) and keeps a few that pass the base query from each block, drawn
 * with the run's seeded generator. Seeds carry source `sample`.
 */

import { sampleN } from '../core/util.mjs';
import { runBatched } from '../github/batch.mjs';
import { LEAN_FRAGMENT, aliasedRepoQuery } from '../github/queries.mjs';
import { repositoriesSince } from '../github/rest.mjs';
import { DEFAULT_MAX_STARS, passesBase, seedFromNode } from './seed.mjs';

/** Seeds kept from one block at most, so one moment of GitHub's history cannot dominate. */
export const DEFAULT_PER_BLOCK = 2;

/** Where the search for the newest id starts when none is given. */
export const MAX_ID_GUESS = 1_300_000_000;

/**
 * @typedef {import('../core/schema.mjs').CandidateSeed} CandidateSeed
 * @typedef {import('../github/client.mjs').Client} Client
 */

/**
 * The newest public repository id, to within about 1,000: gallop upwards from a guess until
 * `/repositories?since=` comes back empty, then bisect.
 * @param {Client} client
 * @param {{from?: number, maxCalls?: number, precision?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<number>}
 */
export async function latestRepositoryId(client, opts = {}) {
  const { from = MAX_ID_GUESS, maxCalls = 40, precision = 1000, signal } = opts;
  let calls = 0;
  /** @param {number} since */
  const probe = async (since) => {
    if (++calls > maxCalls) {
      throw new RangeError('Could not find the newest repository id within the call limit');
    }
    return repositoriesSince(client, since, { signal });
  };
  let best = 0;
  let hi;
  let page = await probe(from);
  let step = 1_000_000;
  if (page.length > 0) {
    best = page[page.length - 1].id;
    for (;;) {
      const x = best + step;
      page = await probe(x);
      if (page.length === 0) {
        hi = x;
        break;
      }
      best = page[page.length - 1].id;
      step *= 2;
    }
  } else {
    hi = from;
    for (;;) {
      const x = Math.max(0, hi - step);
      page = await probe(x);
      if (page.length > 0) {
        best = page[page.length - 1].id;
        break;
      }
      hi = x;
      if (x === 0) return 0;
      step *= 2;
    }
  }
  while (hi - best > precision) {
    const mid = Math.floor((best + hi) / 2);
    page = await probe(mid);
    if (page.length > 0) best = Math.max(best, page[page.length - 1].id);
    else hi = mid;
  }
  return best;
}

/**
 * @typedef {object} SampleStats
 * @property {number} calls REST calls to `/repositories`
 * @property {number} blocks blocks with at least one non-fork repository
 * @property {number} looked repositories looked up
 * @property {number} passing looked-up repositories that passed the base query
 * @property {number} gone repositories that could not be looked up
 */

/**
 * Draw a uniform ID-walk sample of `n` seeds (fewer if `maxCalls` runs out first).
 * @param {object} opts
 * @param {Client} opts.client
 * @param {number} [opts.n] default 20
 * @param {() => number} opts.rand seeded generator, floats in [0, 1)
 * @param {number} [opts.maxId] newest repository id (default: found with `latestRepositoryId`)
 * @param {number} [opts.perBlock] seeds kept per block at most (default 2)
 * @param {number} [opts.maxCalls] REST block calls at most (default max(10, 4n))
 * @param {number} [opts.maxStars] default 25
 * @param {{debug(msg: string, f?: object): void, warn(msg: string, f?: object): void} | null} [opts.log]
 * @param {string} [opts.phase] budget phase (default `sample`)
 * @param {AbortSignal} [opts.signal]
 * @param {Partial<SampleStats>} [opts.stats]
 * @returns {Promise<CandidateSeed[]>}
 */
export async function sampleUniform(opts) {
  const {
    client, n = 20, rand, perBlock = DEFAULT_PER_BLOCK, maxStars = DEFAULT_MAX_STARS, log = null,
    phase = 'sample', signal,
  } = opts;
  if (!client || typeof client.rest !== 'function') throw new TypeError('sampleUniform needs a client');
  if (typeof rand !== 'function') throw new TypeError('sampleUniform needs a seeded rand()');
  if (!Number.isInteger(n) || n < 0) throw new RangeError('The sample size must be a whole number ≥ 0');
  if (!Number.isInteger(perBlock) || perBlock < 1) {
    throw new RangeError('perBlock must be a whole number ≥ 1');
  }
  const top = opts.maxId ?? await latestRepositoryId(client, { signal });
  if (!Number.isInteger(top) || top < 1) throw new RangeError('maxId must be a whole number ≥ 1');
  const limit = opts.maxCalls ?? Math.max(10, 4 * n);
  const stats = /** @type {SampleStats} */ (Object.assign(opts.stats ?? {}, {
    calls: 0, blocks: 0, looked: 0, passing: 0, gone: 0,
  }));
  /** @type {CandidateSeed[]} */
  const seeds = [];
  /** @type {Set<number>} */
  const seenIds = new Set();
  /** @type {Set<string>} */
  const seenNodes = new Set();

  while (seeds.length < n && stats.calls < limit) {
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    const target = 1 + Math.floor(rand() * top);
    const block = await repositoriesSince(client, target - 1, { signal });
    stats.calls++;
    const candidates = block.filter((r) => !r.fork && !seenIds.has(r.id));
    for (const r of block) seenIds.add(r.id);
    if (candidates.length === 0) continue;
    stats.blocks++;
    /** @type {CandidateSeed[]} */
    const passing = [];
    const results = runBatched(candidates, {
      client,
      build: (chunk) => aliasedRepoQuery('Lean', LEAN_FRAGMENT, chunk.map((c) => c.full_name)),
      size: 100, min: 10, max: 100, targetMs: 5000, phase, signal,
    });
    for await (const r of results) {
      stats.looked++;
      if (r.error || !r.value) {
        stats.gone++;
        continue;
      }
      /** @type {CandidateSeed} */
      let seed;
      try {
        seed = seedFromNode(r.value, 'sample');
      } catch {
        stats.gone++;
        continue;
      }
      if (passesBase(seed, { maxStars }) && !seenNodes.has(seed.id)) passing.push(seed);
    }
    stats.passing += passing.length;
    for (const seed of sampleN(passing, Math.min(perBlock, n - seeds.length), rand)) {
      seenNodes.add(seed.id);
      seeds.push(seed);
    }
  }
  if (seeds.length < n) {
    log?.warn('The ID walk ran out of calls before filling the sample', { wanted: n, got: seeds.length });
  }
  return seeds;
}
