// @ts-check
/**
 * `unsung explain <owner/repo>` (DESIGN §9.1, §6.8): print the score, the chips, why not higher,
 * what would raise confidence and the rank decomposition.
 *
 * The repository's stored record is rescored with the current configuration. With `--fixture`, or
 * when the data directory has no record of it, a recorded test fixture of that name is scored
 * instead, as of its recording time (the deep stage merged when it was recorded), and the output
 * says so. The data directory is read only when it already holds a store.
 */

import path from 'node:path';
import { LANE_LABELS, explain, formatExplanation, stageLine } from '../core/explain.mjs';
import { scoreFacts } from '../core/score.mjs';
import { fixtureLoader } from '../eval/fixtures.mjs';
import { fixtureFacts } from '../eval/labels.mjs';
import { hasStore } from '../store/store.mjs';
import { ArgsError } from './args.mjs';
import { DEFAULT_FIXTURES_DIR } from './eval.mjs';

/** @typedef {import('../core/schema.mjs').Score} Score */

export const command = {
  name: 'explain',
  summary: 'Print the score, chips, why-not-higher and confidence explanation of a repository',
  flags: {
    fixture: { type: 'boolean', summary: 'score the recorded test fixture, not the stored record' },
    'fixtures-dir': {
      type: 'string', arg: '<dir>', summary: 'recorded fixtures (default: test/fixtures in this checkout)',
    },
  },
  /**
   * @param {import('./args.mjs').ParsedArgs} args
   * @param {any} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    const [nwo, ...more] = args.positionals;
    if (!nwo || more.length > 0 || !/^[^/\s]+\/[^/\s]+$/.test(nwo)) {
      throw new ArgsError('Name one repository, as owner/name');
    }
    const cfg = ctx.config;
    const base = { weights: cfg.weights, calibration: cfg.calibration, institutions: cfg.institutions };

    /** @type {any} */
    let record = null;
    if (args.flags.fixture !== true && hasStore(ctx.dataDir)) {
      record = await (await ctx.store()).getRepo(nwo);
    }

    /** @type {Score} */
    let score;
    /** @type {string[]} */
    const extra = [];
    let source = 'store';
    let title = '';
    if (record?.facts) {
      const current = record.verdict && record.verdict.headOid === record.facts.headOid;
      const verdict = current ? record.verdict : null;
      score = scoreFacts(record.facts, { ...base, verdict, now: ctx.now(), gone: record.gone === true });
      title = 'stored record, rescored now';
    } else {
      const loader = fixtureLoader(path.resolve(String(args.flags['fixtures-dir'] ?? DEFAULT_FIXTURES_DIR)));
      if (!loader.hasRepoFixture(nwo)) {
        const where = args.flags.fixture === true ? `No recorded fixture for ${nwo} in ${loader.dir}`
          : `No record of ${nwo} in ${ctx.dataDir}`;
        ctx.log.error(`${where}. Score it first with: unsung add ${nwo}`);
        return 1;
      }
      const { facts, enrich, at, deep } = fixtureFacts(loader.loadRepoFixture(nwo));
      score = scoreFacts(facts, { ...base, now: at });
      if (deep) extra.push(`Stages: ${stageLine(scoreFacts(enrich, { ...base, now: at }), score)}`);
      source = 'fixture';
      title = `recorded fixture, as of ${at}`;
    }

    const ex = explain(score, cfg.weights, { calibration: cfg.calibration });
    if (ctx.flags.json) {
      ctx.printJson({ nwo: score.nwo, source, score, explanation: ex });
      return 0;
    }
    const lane = /** @type {Record<string, string>} */ (LANE_LABELS)[score.lane] ?? score.lane;
    for (const line of formatExplanation(score, ex, { title: `${score.nwo} · ${lane} · ${title}`, extra })) {
      ctx.print(line);
    }
    return 0;
  },
};
