// @ts-check
/**
 * `unsung index [--rescore]` (DESIGN §3.11, §9.1): rebuild `data/index.json`; `--rescore` first
 * recomputes every kept score from stored facts, offline, for a new weights or calibration version.
 */

import { pipelineParts, withLock } from '../pipeline/context.mjs';
import { buildIndex, rescoreAll } from '../pipeline/indexer.mjs';
import { fmt } from '../pipeline/util.mjs';

export const command = {
  name: 'index',
  summary: 'Rebuild the index; --rescore recomputes every kept score offline',
  flags: {
    rescore: {
      type: 'boolean', summary: 'recompute every kept score from stored facts first (no API calls)',
    },
  },
  /**
   * @param {import('./args.mjs').ParsedArgs} args
   * @param {any} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    const { store, lib } = await pipelineParts(ctx, { github: false });
    const result = await withLock(store, 'index', ctx, async () => {
      const rescored = args.flags.rescore
        ? (await rescoreAll({ store, config: ctx.config, now: ctx.now(), deps: lib })).count
        : null;
      const index = await buildIndex({ store, config: ctx.config, now: ctx.now(), deps: lib });
      await store.writeIndex(index);
      return { rescored, entries: index.entries.length, counts: index.counts };
    });
    if (ctx.flags.json) ctx.printJson(result);
    else {
      if (result.rescored !== null) ctx.print(`Rescored ${fmt(result.rescored)} repositories offline`);
      const counts = Object.entries(result.counts).filter(([, n]) => n > 0)
        .map(([l, n]) => `${l} ${fmt(n)}`).join(' · ');
      ctx.print(`Index: ${fmt(result.entries)} entries${counts ? ` (${counts})` : ''}`);
    }
    return 0;
  },
};
