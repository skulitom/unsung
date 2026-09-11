// @ts-check
/**
 * Wiring shared by the pipeline commands (`src/cli/{run,add,status,recheck,sample,index,compact}.mjs`):
 * the store, the GitHub client and the injected functions from a command context, and a helper that
 * holds the run lock around a piece of work (§3.12). A context may carry `deps` (a `Lib`) to replace
 * the real modules, which is how the command tests run offline.
 */

import { loadDeps } from './deps.mjs';
import { makeRunId } from './run.mjs';

/** @typedef {import('./deps.mjs').Lib} Lib */

/**
 * @typedef {object} PipelineParts
 * @property {any} store
 * @property {Lib} lib
 * @property {any} client the GitHub client, or null when not asked for
 * @property {any} governor
 */

/**
 * The store, the injected functions and (unless `github` is false) the GitHub client of a command
 * context. `store` replaces the context's store without opening it (a dry run over a directory
 * that holds no store plans against an empty memory store instead of creating one).
 * @param {any} ctx the command context (`src/cli/context.mjs`), optionally with `deps`
 * @param {{github?: boolean, store?: any}} [opts]
 * @returns {Promise<PipelineParts>}
 */
export async function pipelineParts(ctx, { github = true, store: given } = {}) {
  const store = given ?? await ctx.store();
  const lib = ctx.deps ?? await loadDeps();
  const gh = github ? await ctx.github() : null;
  return { store, lib, client: gh?.client ?? null, governor: gh?.governor ?? null };
}

/**
 * Run `fn` holding the run lock under an id such as `add-20260911T120000Z-1a2b`; a live lock held by
 * a run throws `LockError` (exit 2). The lock is always released.
 * @template T
 * @param {any} store
 * @param {string} what `add`, `recheck`, `sample`, `index` or `compact`
 * @param {{now: () => string, rand: () => number}} ctx
 * @param {(lockId: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withLock(store, what, ctx, fn) {
  const id = `${what}-${makeRunId(ctx.now(), ctx.rand)}`;
  await store.lock(id);
  try {
    return await fn(id);
  } finally {
    await store.unlock();
  }
}
