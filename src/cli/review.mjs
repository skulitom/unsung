// @ts-check
/**
 * `unsung review` (DESIGN §8, §9.1): the optional LLM review. Argument handling and printing; the
 * work is `reviewRepos` in `src/llm/review.mjs`. Valid verdicts are rescored with WP2's
 * `applyScore` and the index is rebuilt with `buildIndex` when those modules are present.
 */

import { LLM_BACKENDS } from '../core/schema.mjs';
import { ClaudeNotFoundError, SDK_INSTALL_HINT, SdkMissingError, createBackend } from '../llm/backends.mjs';
import { reviewRepos } from '../llm/review.mjs';

/** @typedef {import('./context.mjs').Ctx} Ctx */
/** @typedef {import('./args.mjs').ParsedArgs} ParsedArgs */
/** @typedef {import('../llm/review.mjs').ReviewSummary} ReviewSummary */

const ENABLE_HELP = [
  'The LLM review is optional and off by default (backend none), so nothing was reviewed.',
  'To enable it, choose a backend:',
  '  --backend claude-cli     runs the claude executable of Claude Code; it bills your Claude plan',
  '  --backend anthropic-api  calls the Anthropic API through the official SDK; run',
  `                           '${SDK_INSTALL_HINT}' first`,
  'or set llm.backend in config/defaults.json. A run reviews at most --top repositories and stops',
  'before it would spend more than --max-usd dollars.',
];

const NWO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/**
 * @param {number} x
 * @returns {string}
 */
function dollars(x) {
  return `$${(Number(x) || 0).toFixed(2)}`;
}

/**
 * @param {number} p
 * @returns {string}
 */
function signed(p) {
  return p > 0 ? `+${p}` : p < 0 ? `−${-p}` : '0';
}

/**
 * Text lines summarising a review run.
 * @param {ReviewSummary} s
 * @returns {string[]}
 */
export function summaryLines(s) {
  const c = s.counts;
  const lines = [
    `review     ${s.backend} · ${s.model ?? '?'} · ${s.reviewed} reviewed (ok ${c.ok ?? 0} · `
      + `unsupported ${c.unsupported ?? 0} · refused ${c.refused ?? 0} · error ${c.error ?? 0}) · `
      + `${s.skipped} skipped · ${dollars(s.spentUsd)} of ${dollars(s.maxUsd)}`,
  ];
  for (const r of s.results) {
    const lane = r.lane ? ` · ${r.lane}` : '';
    const audit = r.audit ? ' (audit)' : '';
    lines.push(`  ${r.nwo.padEnd(40)} ${r.status.padEnd(12)} ${signed(r.points)}${lane}${audit}`);
  }
  const left = s.remaining;
  const detail = s.error ?? 'no detail';
  /** @type {Record<string, string>} */
  const why = {
    budget: `Stopped before exceeding the ${dollars(s.maxUsd)} cap; ${left} selected repositories `
      + 'are left for the next run.',
    'rate-limit': `The Anthropic API is rate limiting; ${left} repositories are left unreviewed. `
      + 'Try again later.',
    'github-rate-limit': `GitHub is rate limiting; ${left} repositories are left unreviewed. `
      + 'Try again later.',
    auth: `The backend refused the credentials (${detail}). For claude-cli, run claude once `
      + 'and log in; for anthropic-api, set ANTHROPIC_API_KEY or run ant auth login.',
    'unknown-model': `The model ${s.model ?? ''} is not available (${detail}); choose another with --model.`,
    backend: `The backend could not be started (${detail}).`,
    errors: 'Stopped after three backend errors in a row; the failed repositories will be retried next run.',
    interrupted: `Interrupted; ${left} repositories are left for the next run.`,
    'no-index': 'There is no index yet: run unsung run first.',
    'not-found': 'That repository is not in the store: add it first with unsung add <owner/repo>.',
  };
  if (s.stopReason && why[s.stopReason]) lines.push(why[s.stopReason]);
  return lines;
}

/**
 * WP2's indexer, when it has landed.
 * @returns {Promise<any>}
 */
async function loadIndexer() {
  try {
    return await import('../pipeline/indexer.mjs');
  } catch (err) {
    if (/** @type {{code?: string}} */ (err)?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

/** @type {{name: string, summary: string, flags: import('./args.mjs').FlagSpec,
 *   run: (args: ParsedArgs, ctx: Ctx) => Promise<number>}} */
export const command = {
  name: 'review',
  summary: 'Optional LLM review of the repositories the heuristics are least sure about',
  flags: {
    top: { type: 'number', default: 20, arg: 'N', summary: 'repositories to review' },
    backend: {
      type: 'string', arg: 'none|claude-cli|anthropic-api',
      summary: 'LLM backend (default from config: none)',
    },
    model: { type: 'string', arg: '<model>', summary: 'model (default from config: claude-opus-5)' },
    effort: {
      type: 'string', arg: '<level>', summary: 'effort (both backends; default from config: high)',
    },
    'max-usd': {
      type: 'number', arg: '<dollars>', summary: 'spending cap for the run (default from config: 3)',
    },
    repo: { type: 'string', arg: '<o/r>', summary: 'review one repository regardless of order' },
    endpoint: { type: 'string', arg: '<url>', summary: 'Anthropic API endpoint (default from config)' },
    'no-fallbacks': { type: 'boolean', summary: 'turn off server-side refusal fallbacks (anthropic-api)' },
  },

  async run(args, ctx) {
    const flags = args.flags ?? {};
    const llm = ctx.config?.defaults?.llm ?? {};
    const name = String(flags.backend ?? llm.backend ?? 'none');
    if (!LLM_BACKENDS.includes(name)) {
      ctx.log.error(`Unknown backend '${name}'; choose none, claude-cli or anthropic-api`);
      return 2;
    }
    const top = flags.top ?? 20;
    if (!Number.isInteger(top) || top < 0) {
      ctx.log.error(`--top expects a whole number of 0 or more, got '${String(top)}'`);
      return 2;
    }
    const maxUsd = flags['max-usd'] ?? llm.maxUsd ?? 3;
    if (typeof maxUsd !== 'number' || !Number.isFinite(maxUsd) || maxUsd < 0) {
      ctx.log.error(`--max-usd expects an amount of 0 or more, got '${String(maxUsd)}'`);
      return 2;
    }
    const repo = typeof flags.repo === 'string' ? flags.repo.trim() : null;
    if (repo !== null && !NWO.test(repo)) {
      ctx.log.error(`--repo expects owner/name, got '${repo.slice(0, 80)}'`);
      return 2;
    }
    if (name === 'none') {
      if (flags.json) ctx.printJson({ backend: 'none', reviewed: 0, message: ENABLE_HELP.join(' ') });
      else for (const line of ENABLE_HELP) ctx.print(line);
      return 0;
    }

    const backendName = /** @type {'claude-cli' | 'anthropic-api'} */ (name);
    let backend;
    try {
      backend = await createBackend(backendName, {
        llm,
        model: flags.model ?? llm.model,
        effort: flags.effort ?? llm.effort,
        endpoint: flags.endpoint ?? llm.endpoint,
        fallbacks: flags['no-fallbacks'] ? false : (llm.fallbacks ?? true),
        env: ctx.env,
      });
    } catch (err) {
      if (err instanceof SdkMissingError || err instanceof ClaudeNotFoundError) {
        ctx.log.error(err.message);
        return 2;
      }
      throw err;
    }

    const store = await ctx.store();
    const client = {
      /** @param {...any} a */
      graphql: async (...a) => (await ctx.client()).graphql(...a),
    };
    const indexer = await loadIndexer();
    const rescore = typeof indexer?.applyScore === 'function'
      ? (/** @type {any} */ record, /** @type {any} */ verdict) => indexer.applyScore(record, ctx.config,
        { now: ctx.now(), verdict })
      : undefined;

    const summary = await reviewRepos({
      store, client, config: ctx.config, backend, top, maxUsd, repo, now: ctx.now, log: ctx.log,
      rand: ctx.rand, signal: ctx.signal, rescore,
    });

    if ((summary.counts.ok ?? 0) > 0) {
      if (typeof indexer?.buildIndex === 'function') {
        const index = await indexer.buildIndex({ store, config: ctx.config, now: ctx.now() });
        await store.writeIndex(index);
      } else {
        ctx.log.warn('The index was not rebuilt (src/pipeline/indexer.mjs is not available); '
          + 'run unsung index --rescore to show the new verdicts.');
      }
    }

    if (flags.json) ctx.printJson(summary);
    else for (const line of summaryLines(summary)) ctx.print(line);

    switch (summary.stopReason) {
      case 'interrupted':
        return 130;
      case 'auth':
      case 'unknown-model':
      case 'backend':
        return 2;
      case 'rate-limit':
      case 'github-rate-limit':
        return 75;
      default:
        return 0;
    }
  },
};
