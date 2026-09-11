// @ts-check
/**
 * AIMD batching of aliased GraphQL queries (DESIGN §3.10). Start at the configured size; after a
 * success whose duration is under 0.7 × `targetMs`, grow by 1 up to `max`; on a HeavyQueryError or a
 * duration over 1.5 × `targetMs`, halve (floor, never below `min`). The items of a batch that failed
 * as heavy are retried as two halves, recursively; a single item that still fails is handed to
 * `onHeavy` (the REST fallback) and reported with `heavy: true`.
 *
 * Results come out one per item, in order within each batch. Rate limits are handled by the client
 * and governor; a network error or GitHub error that survives the client's retries is reported on
 * each item of the batch and the run goes on. Anything else — AuthError, PauseError, an exhausted
 * rate limit, an abort, a ReadOnlyViolation, a bug — propagates and ends the generator.
 */

import { aliasValues } from './queries.mjs';

/**
 * @typedef {import('./client.mjs').Client} Client
 * @typedef {import('./client.mjs').GraphqlResult} GraphqlResult
 */

/**
 * @typedef {object} BatchStats
 * @property {number} calls GraphQL requests made
 * @property {number} items items answered by GraphQL
 * @property {number} halvings HeavyQueryErrors (each halves the batch)
 * @property {number} slow successes slower than 1.5 × target
 * @property {number} heavy items that failed alone
 * @property {number} errors items reported with an error
 * @property {number} size the current batch size
 */

/**
 * @template T
 * @typedef {object} BatchResult
 * @property {T} item
 * @property {unknown} value the item's answer (`null`: not found, or failed)
 * @property {Error | null} error
 * @property {boolean} heavy the item failed alone and went to `onHeavy`
 */

/**
 * @param {unknown} err
 * @returns {boolean}
 */
export function isHeavyError(err) {
  const e = /** @type {any} */ (err);
  return e?.name === 'HeavyQueryError' || e?.code === 'EHEAVY';
}

/**
 * A GitHub failure the run can survive: a heavy query, or a network or server error that outlived
 * the client's retries. Everything else ends the run.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRecoverableError(err) {
  const code = /** @type {any} */ (err)?.code;
  return code === 'EHEAVY' || code === 'EGITHUB' || code === 'ENETWORK';
}

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clampInt(v, lo, hi) {
  const n = Number.isFinite(v) ? Math.floor(v) : lo;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Run `items` through aliased GraphQL queries with AIMD batch sizing.
 * @template T
 * @param {Iterable<T>} items
 * @param {object} opts
 * @param {Client} opts.client
 * @param {(items: T[]) => {doc: string, variables: Record<string, unknown>}} opts.build
 * @param {(result: GraphqlResult, items: T[]) => unknown[]} [opts.parse] default: aliases `r0`, `r1`, …
 * @param {number} [opts.size] starting batch size (default 12)
 * @param {number} [opts.min] smallest batch size (default 1)
 * @param {number} [opts.max] largest batch size (default 20)
 * @param {number} [opts.targetMs] target duration of one query (default 6000)
 * @param {(item: T, error: Error) => Promise<unknown>} [opts.onHeavy] fallback for an item that fails alone
 * @param {string} [opts.phase] budget phase passed to the client
 * @param {'graphql' | 'search'} [opts.kind]
 * @param {AbortSignal} [opts.signal]
 * @param {Partial<BatchStats>} [opts.stats] filled in as batches run
 * @returns {AsyncGenerator<BatchResult<T>>}
 */
export async function* runBatched(items, opts) {
  const {
    client, build, parse, size = 12, min = 1, max = 20, targetMs = 6000, onHeavy, phase,
    kind = 'graphql', signal,
  } = opts;
  if (!client || typeof client.graphql !== 'function') throw new TypeError('runBatched needs a client');
  if (typeof build !== 'function') throw new TypeError('runBatched needs a build(items) function');
  const lo = Math.max(1, Math.floor(Number(min) || 1));
  const hi = Math.max(lo, Math.floor(Number(max) || lo));
  let current = clampInt(Number(size), lo, hi);
  const stats = /** @type {BatchStats} */ (Object.assign(opts.stats ?? {}, {
    calls: opts.stats?.calls ?? 0, items: opts.stats?.items ?? 0, halvings: opts.stats?.halvings ?? 0,
    slow: opts.stats?.slow ?? 0, heavy: opts.stats?.heavy ?? 0, errors: opts.stats?.errors ?? 0,
    size: current,
  }));

  const queue = Array.from(items);
  let next = 0;
  /** @type {T[][]} halves waiting to be retried; the last one is taken first */
  const retry = [];

  while (retry.length > 0 || next < queue.length) {
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    /** @type {T[]} */
    let chunk;
    if (retry.length > 0) chunk = /** @type {T[]} */ (retry.pop());
    else {
      chunk = queue.slice(next, next + current);
      next += chunk.length;
    }

    /** @type {GraphqlResult | null} */
    let result = null;
    /** @type {Error | null} */
    let error = null;
    try {
      const built = build(chunk);
      stats.calls++;
      result = await client.graphql(built.doc, built.variables, { kind, phase, signal });
    } catch (err) {
      if (!isRecoverableError(err)) throw err;
      error = /** @type {Error} */ (err);
    }

    if (error || !result) {
      if (isHeavyError(error)) {
        stats.halvings++;
        current = Math.max(lo, Math.floor(current / 2));
        stats.size = current;
        if (chunk.length > 1) {
          const mid = Math.ceil(chunk.length / 2);
          retry.push(chunk.slice(mid), chunk.slice(0, mid));
          continue;
        }
        stats.heavy++;
        const item = chunk[0];
        if (!onHeavy) {
          stats.errors++;
          yield { item, value: null, error, heavy: true };
          continue;
        }
        /** @type {unknown} */
        let value = null;
        /** @type {Error | null} */
        let fallbackError = null;
        try {
          value = await onHeavy(item, /** @type {Error} */ (error));
        } catch (err) {
          if (!isRecoverableError(err)) throw err;
          fallbackError = /** @type {Error} */ (err);
          stats.errors++;
        }
        yield { item, value: fallbackError ? null : value, error: fallbackError, heavy: true };
        continue;
      }
      stats.errors += chunk.length;
      for (const item of chunk) yield { item, value: null, error, heavy: false };
      continue;
    }

    const values = parse ? parse(result, chunk) : aliasValues(result, chunk.length);
    if (result.ms > 1.5 * targetMs) {
      current = Math.max(lo, Math.floor(current / 2));
      stats.slow++;
    } else if (result.ms < 0.7 * targetMs) {
      current = Math.min(hi, current + 1);
    }
    stats.size = current;
    stats.items += chunk.length;
    for (let i = 0; i < chunk.length; i++) {
      yield { item: chunk[i], value: values?.[i] ?? null, error: null, heavy: false };
    }
  }
}
