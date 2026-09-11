// @ts-check
/**
 * `unsung add <owner/repo>…` (DESIGN §9.1): enrich, deepen, score and explain named repositories
 * now, whatever their lane, and rebuild the index. Holds the run lock while it works.
 */

import { ArgsError } from './args.mjs';
import { addRepo } from '../pipeline/add.mjs';
import { pipelineParts, withLock } from '../pipeline/context.mjs';
import { buildIndex } from '../pipeline/indexer.mjs';
import { isFatal } from '../pipeline/util.mjs';

/** @typedef {import('../core/schema.mjs').RepoRecord} RepoRecord */

/**
 * @param {unknown} item a string, or a signal-like `{label, reason, hint, points}`
 * @returns {string}
 */
function line(item) {
  if (typeof item === 'string') return item;
  const o = /** @type {Record<string, any>} */ (item ?? {});
  const signed = typeof o.points === 'number' && o.points > 0 ? `+${o.points}` : String(o.points);
  const pts = typeof o.points === 'number' && o.points !== 0 ? ` (${signed})` : '';
  const text = o.hint ?? o.reason ?? o.detail ?? '';
  return `${o.label ?? o.id ?? ''}${pts}${text ? `: ${text}` : ''}`;
}

/**
 * The explanation printed for a record (§6.8), from `explain` when it is available.
 * @param {RepoRecord} rec
 * @param {any} lib
 * @param {any} weights
 * @returns {string[]}
 */
export function explanationLines(rec, lib, weights) {
  const s = rec.score;
  if (!s) return [`${rec.nwo}: not scored`];
  const dropped = (s.gates ?? []).find((g) => g.action === 'drop');
  const out = [`${rec.nwo} · ${dropped ? `dropped by ${dropped.id}` : s.lane}`];
  /** @type {any} */
  let ex = null;
  try {
    ex = lib.explain(s, weights);
  } catch {
    ex = null;
  }
  const stars = s.attention?.stars ?? 0;
  const headline = `${s.S} points · Quality ${Math.round(100 * s.quality)} · `
    + `Confidence ${s.confidence?.band ?? 'low'} · ${stars} star${stars === 1 ? '' : 's'}`;
  const conf = (1.5 * (s.confidence?.k ?? 0)).toFixed(2);
  const att = (1.5 * (s.attention?.a ?? 0)).toFixed(2);
  const rank = `Rank ${s.gem.toFixed(2)} = ${s.S} points + ${conf} confidence − ${att} attention`;
  out.push(`  ${ex?.headline ?? headline}`);
  out.push(`  ${ex?.rankLine ?? rank}`);
  /** @param {string} title @param {unknown} list */
  const section = (title, list) => {
    if (!Array.isArray(list) || list.length === 0) return;
    out.push(`  ${title}:`);
    for (const item of list) out.push(`    ${line(item)}`);
  };
  section('Why', ex?.top);
  section('Against', ex?.negatives);
  section('Why not higher', ex?.whyNotHigher);
  section('What would raise confidence', ex?.raiseConfidence);
  section('Gates', (s.gates ?? []).map((g) => `${g.id} (${g.action}): ${g.reason}`));
  return out;
}

export const command = {
  name: 'add',
  summary: 'Enrich, deepen, score and explain named repositories now',
  flags: {
    'no-deep': { type: 'boolean', summary: 'score from the enrich stage only (quicker, fewer signals)' },
  },
  /**
   * @param {import('./args.mjs').ParsedArgs} args
   * @param {any} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    if (args.positionals.length === 0) throw new ArgsError('Name at least one repository, as owner/name');
    const { store, lib, client } = await pipelineParts(ctx);
    let failures = 0;
    /** @type {any[]} */
    const results = [];
    await withLock(store, 'add', ctx, async () => {
      for (const nwo of args.positionals) {
        try {
          const rec = await addRepo(nwo, {
            client, store, config: ctx.config, now: ctx.now, deep: args.flags['no-deep'] !== true, deps: lib,
            log: ctx.log, signal: ctx.signal,
          });
          const s = rec.score;
          results.push({ nwo: rec.nwo, lane: s?.lane ?? null, S: s?.S ?? null, gem: s?.gem ?? null });
          if (!ctx.flags.json) for (const l of explanationLines(rec, lib, ctx.config.weights)) ctx.print(l);
        } catch (err) {
          if (isFatal(err)) throw err;
          failures++;
          results.push({ nwo, error: err instanceof Error ? err.message : String(err) });
          if (!ctx.flags.json) ctx.print(`${nwo}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      await store.writeIndex(await buildIndex({ store, config: ctx.config, now: ctx.now(), deps: lib }));
    });
    if (ctx.flags.json) ctx.printJson(results);
    return failures > 0 ? 1 : 0;
  },
};
