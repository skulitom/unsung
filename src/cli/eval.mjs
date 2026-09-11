// @ts-check
/**
 * `unsung eval [--labels fixtures|feedback|all]` (DESIGN §9.1, §14.4): the metrics of §14.4 on the
 * research labels in the fixtures, on quality labels from feedback in the data directory, or on
 * both, with the named-set expectations of §14.2 when the fixtures are read.
 *
 * The data directory is read only when it already holds a store, so evaluating a fresh checkout
 * never creates one.
 */

import path from 'node:path';
import { evaluate, formatReport } from '../eval/evaluate.mjs';
import { fixtureLoader } from '../eval/fixtures.mjs';
import { LABEL_SOURCES, labelRows } from '../eval/labels.mjs';
import { hasStore } from '../store/store.mjs';
import { ArgsError } from './args.mjs';
import { PACKAGE_ROOT } from './context.mjs';

/** The fixtures of this checkout (§14.2). */
export const DEFAULT_FIXTURES_DIR = path.join(PACKAGE_ROOT, 'test', 'fixtures');

/**
 * Flags shared by `eval` and `calibrate` (a fresh object each time).
 * @returns {Record<string, import('./args.mjs').FlagDef>}
 */
export function labelFlags() {
  return {
    labels: { type: 'string', default: 'all', arg: 'fixtures|feedback|all', summary: 'which labels to use' },
    'fixtures-dir': {
      type: 'string', arg: '<dir>', summary: 'labelled fixtures (default: test/fixtures in this checkout)',
    },
  };
}

/**
 * The label rows and named sets `--labels` asks for.
 * @param {Record<string, any>} flags
 * @param {any} ctx
 * @returns {Promise<{rows: import('../eval/labels.mjs').LabelRow[],
 *   named: import('../eval/labels.mjs').NamedRow[], labels: string, fixturesDir: string | null,
 *   feedback: boolean}>}
 */
export async function labelSources(flags, ctx) {
  const labels = String(flags.labels ?? 'all');
  if (!LABEL_SOURCES.includes(labels)) {
    throw new ArgsError(`--labels takes fixtures, feedback or all, not '${labels.slice(0, 40)}'`);
  }
  const dir = path.resolve(String(flags['fixtures-dir'] ?? DEFAULT_FIXTURES_DIR));
  let loader = labels === 'feedback' ? null : fixtureLoader(dir);
  if (loader && !loader.exists()) {
    if (labels === 'fixtures') throw new ArgsError(`No labelled fixtures in ${dir}`);
    loader = null;
  }
  const store = labels !== 'fixtures' && hasStore(ctx.dataDir) ? await ctx.store() : null;
  const { rows, named } = await labelRows({ labels, loader, store });
  return { rows, named, labels, fixturesDir: loader ? dir : null, feedback: Boolean(store) };
}

export const command = {
  name: 'eval',
  summary: 'Measure the scoring against labels: AUCs, Goodhart AUC, bands, calibration, named sets',
  flags: labelFlags(),
  /**
   * @param {import('./args.mjs').ParsedArgs} args
   * @param {any} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    const src = await labelSources(args.flags, ctx);
    if (src.rows.length === 0) {
      if (ctx.flags.json) ctx.printJson({ labels: 0 });
      else {
        ctx.print('No labels to evaluate yet. Label repositories in the explorer, '
          + 'or evaluate a checkout\'s fixtures with --labels fixtures.');
      }
      return 0;
    }
    const report = evaluate(src.rows, ctx.config, { rand: ctx.rand, named: src.named });
    if (ctx.flags.json) ctx.printJson(report);
    else for (const line of formatReport(report)) ctx.print(line);
    return 0;
  },
};
