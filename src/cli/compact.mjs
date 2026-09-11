// @ts-check
/**
 * `unsung compact [--migrate]` (DESIGN §4.1, §4.2, §9.1): retention and partition compaction;
 * `--migrate` first brings a data directory written by an older store version up to date.
 */

import { openStore } from '../store/store.mjs';
import { withLock } from '../pipeline/context.mjs';
import { fmt } from '../pipeline/util.mjs';

export const command = {
  name: 'compact',
  summary: 'Apply retention and compact old partitions',
  flags: {
    migrate: { type: 'boolean', summary: 'bring an older data directory up to date first' },
  },
  /**
   * @param {import('./args.mjs').ParsedArgs} args
   * @param {any} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    const store = args.flags.migrate
      ? await openStore(ctx.dataDir, { now: ctx.now, log: ctx.log, migrate: true })
      : await ctx.store();
    const report = await withLock(store, 'compact', ctx, () => store.compact({ now: ctx.now() }));
    if (ctx.flags.json) ctx.printJson(report);
    else {
      const c = report.candidates;
      ctx.print(`Candidates: ${fmt(c.removed)} old dropped or expired removed`
        + ` · ${fmt(c.partitions)} partitions folded (${fmt(c.gzipped)} gzipped)`);
      ctx.print(`Removed: ${fmt(report.repos.removed)} gone repositories`
        + ` · ${fmt(report.archive.removed)} archive extracts`
        + ` · ${fmt(report.http.removed)} cached responses`);
      ctx.print(`Ledger: ${fmt(report.units.collapsed)} old events collapsed`
        + ` · owners: ${fmt(report.owners.records)} records`);
    }
    return 0;
  },
};
