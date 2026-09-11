// @ts-check
/**
 * `unsung recheck [--top 100]` (DESIGN §3.7, §9.1): existence and traction refresh for the top of
 * the index and due deferred candidates, then an index rebuild. Holds the run lock while it works.
 */

import { pipelineParts, withLock } from '../pipeline/context.mjs';
import { buildIndex } from '../pipeline/indexer.mjs';
import { recheck } from '../pipeline/recheck.mjs';
import { fmt } from '../pipeline/util.mjs';

export const command = {
  name: 'recheck',
  summary: 'Refresh existence and traction for the top of the index',
  flags: {
    top: { type: 'number', arg: 'N', default: 100, summary: 'index entries to re-check, highest rank first' },
  },
  /**
   * @param {import('./args.mjs').ParsedArgs} args
   * @param {any} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    const top = Math.max(0, Math.floor(Number(args.flags.top ?? 100)));
    const { store, lib, client } = await pipelineParts(ctx);
    const stats = await withLock(store, 'recheck', ctx, async () => {
      const s = await recheck({
        client, store, config: ctx.config, now: ctx.now, top, deps: lib, log: ctx.log, signal: ctx.signal,
      });
      await store.writeIndex(await buildIndex({ store, config: ctx.config, now: ctx.now(), deps: lib }));
      return s;
    });
    if (ctx.flags.json) ctx.printJson(stats);
    else {
      const counts = `${fmt(stats.checked)} · ${fmt(stats.gone)} gone · ${fmt(stats.requeued)} re-queued`;
      ctx.print(`Re-checked ${counts}`);
    }
    return 0;
  },
};
