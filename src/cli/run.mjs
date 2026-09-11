// @ts-check
/**
 * `unsung run` (DESIGN §3, §9.1): the funnel within a budget. Exit codes: 0 finished, 75 paused by
 * GitHub's rate limits (resume later), 2 a live lock or a configuration or authentication problem,
 * 130 interrupted.
 */

import { resolveProfile } from '../config.mjs';
import { pipelineParts } from '../pipeline/context.mjs';
import { run } from '../pipeline/run.mjs';
import { summaryOf } from '../store/common.mjs';
import { createMemoryStore } from '../store/memory.mjs';
import { hasStore } from '../store/store.mjs';
import { ArgsError } from './args.mjs';

/** @type {import('./args.mjs').FlagSpec} */
const flags = {
  // No defaults for budget, archive-hours, deep and enrich-max: the profile supplies them.
  budget: {
    type: 'duration', arg: '<duration>',
    summary: 'wall-clock budget such as 10m, or none (default: the profile\'s)',
  },
  profile: { type: 'string', arg: 'quick|daily', default: 'quick', summary: 'run profile' },
  lag: { type: 'number', arg: 'N', summary: 'census the created-day N days ago (default 3)' },
  backfill: {
    type: 'number', arg: 'N', summary: 'also census the N days before it, newest first (default 0)',
  },
  lang: { type: 'string', arg: '<L>', summary: 'census only this language' },
  topic: { type: 'string', arg: '<T>', summary: 'census only this topic' },
  until: { type: 'string', arg: 'caught-up', summary: 'keep discovering until every planned unit is done' },
  'no-archive': { type: 'boolean', summary: 'skip the GH Archive lane' },
  'archive-hours': {
    type: 'number', arg: 'N', summary: 'complete GH Archive hours to process (default: the profile\'s)',
  },
  deep: { type: 'number', arg: 'N', summary: 'repositories to deepen (default: the profile\'s)' },
  'enrich-max': {
    type: 'number', arg: 'N', summary: 'enrich at most this many repositories (default: the profile\'s)',
  },
  'no-wait': { type: 'boolean', summary: 'stop with exit 75 instead of waiting out a rate-limit pause' },
  'dry-run': { type: 'boolean', summary: 'plan units and show the budget without calling GitHub' },
};

export const command = {
  name: 'run',
  summary: 'Discover, filter, enrich, score and index new repositories within a budget',
  flags,
  /**
   * @param {import('./args.mjs').ParsedArgs} args
   * @param {any} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    // Checked before anything is resolved or opened: `--lang Jupyter Notebook` without quotes would
    // otherwise census 'Jupyter' and silently drop 'Notebook' (§9.1).
    if (args.positionals.length > 0) {
      throw new ArgsError(`run takes no arguments, got '${String(args.positionals[0]).slice(0, 40)}'`);
    }
    const opts = resolveProfile(ctx.config.defaults, args.flags.profile, args.flags);
    // A dry run writes nothing (§9.1): over a data directory that holds no store it plans against
    // an empty store in memory rather than creating the directory and its STORE_VERSION.
    const fresh = opts.dryRun && Boolean(ctx.dataDir) && !hasStore(ctx.dataDir);
    const { store, lib, client, governor } = await pipelineParts(ctx, {
      github: !opts.dryRun, store: fresh ? createMemoryStore({ now: ctx.clock.now }) : undefined,
    });
    const manifest = await run(opts, {
      store, client, governor, clock: ctx.clock, config: ctx.config, log: ctx.log, rand: ctx.rand,
      argv: ctx.argv, signal: ctx.signal, fetch: globalThis.fetch, userAgent: ctx.userAgent, deps: lib,
    });
    const exit = manifest.exit ?? { code: 0, reason: 'finished', resumeAt: null };
    if (ctx.flags.json) ctx.printJson(summaryOf(manifest));
    else if (exit.code === 75) ctx.print(`Paused by GitHub's rate limits. Run again after ${exit.resumeAt}.`);
    else if (exit.code === 130) ctx.print('Interrupted. Progress is saved; run again to continue.');
    else if (!opts.dryRun) {
      const url = `http://127.0.0.1:${ctx.config.defaults.server.port}`;
      ctx.log.stage('explore', { text: `npm start → ${url}` });
    }
    return exit.code ?? 0;
  },
};
