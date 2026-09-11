// @ts-check
/**
 * `unsung sample [--n 20]` (DESIGN §3.1 S0c, §14.3): draw a uniform ID-walk sample, enrich and
 * score it, and keep every record so that the Calibrate tab can offer it for blind labelling.
 */

import { candidateFromSeed, mergeSeed, prefilterSeed, ownerOf } from '../pipeline/candidates.mjs';
import { pipelineParts, withLock } from '../pipeline/context.mjs';
import { emptyEnrichStats, enrich } from '../pipeline/enrich.mjs';
import { buildIndex } from '../pipeline/indexer.mjs';
import { fmt } from '../pipeline/util.mjs';

export const command = {
  name: 'sample',
  summary: 'Draw a uniform sample of repositories for blind labelling',
  flags: {
    n: { type: 'number', arg: 'N', default: 20, summary: 'repositories to draw' },
  },
  /**
   * @param {import('./args.mjs').ParsedArgs} args
   * @param {any} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    const n = Math.max(0, Math.floor(Number(args.flags.n ?? 20)));
    const { store, lib, client } = await pipelineParts(ctx);
    const stats = emptyEnrichStats();
    /** @type {{nwo: string, lane: string | null, S: number | null}[]} */
    const drawn = [];
    await withLock(store, 'sample', ctx, async () => {
      const { maxStars, ownerCapPerDay } = ctx.config.defaults;
      const seeds = await lib.sampleUniform({ client, n, rand: ctx.rand, maxStars, log: ctx.log });
      const now = ctx.now();
      /** @type {any[]} */
      const cands = [];
      for (const seed of seeds) {
        const owner = await store.getOwner(ownerOf(seed.nwo));
        const pre = prefilterSeed(seed, { lib, now, maxStars, ownerCapPerDay, owner });
        const known = await store.getCandidate(seed.id);
        // Every draw is enriched, whatever the prefilter says: the sample measures the whole haystack.
        const c = known ? mergeSeed(known, seed, pre, now).next : candidateFromSeed(seed, pre, now);
        cands.push({ ...c, state: 'queued', reason: pre.state === 'queued' ? null : pre.reason });
      }
      await store.putCandidates(cands);
      const env = {
        client, store, config: ctx.config, lib, now: ctx.now, log: ctx.log,
        batch: ctx.config.defaults.batch.enrich, keepAll: true, stats, signal: ctx.signal,
      };
      for await (const out of enrich(cands, env)) {
        const s = out.record?.score;
        drawn.push({ nwo: out.candidate.nwo, lane: s?.lane ?? (out.gone ? 'gone' : null), S: s?.S ?? null });
      }
      await store.writeIndex(await buildIndex({ store, config: ctx.config, now: ctx.now(), deps: lib }));
    });
    if (ctx.flags.json) ctx.printJson({ drawn, stats });
    else {
      ctx.print(`Sampled ${fmt(drawn.length)} repositories for blind labelling (Calibrate tab):`);
      for (const d of drawn) ctx.print(`  ${d.nwo}`);
    }
    return 0;
  },
};
