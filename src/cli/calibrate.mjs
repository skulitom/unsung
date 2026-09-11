// @ts-check
/**
 * `unsung calibrate [--write]` (DESIGN §9.1, §6.2, §14.3): refit the slope of Quality on every
 * label and its intercept on the uniform stratum, and compare the fit with the current
 * calibration. With `--write`, a fit that differs at three decimals is written to
 * `<config>/calibration.json` with the next version and a changelog entry (§4.4).
 */

import path from 'node:path';
import { validateCalibration } from '../core/schema.mjs';
import { quality } from '../core/score.mjs';
import { calibrationChanged, fitPlatt, nextCalibration } from '../eval/calibrate.mjs';
import { scoreRows } from '../eval/evaluate.mjs';
import { brier } from '../eval/metrics.mjs';
import { writeJsonAtomicSync } from '../store/jsonl.mjs';
import { labelFlags, labelSources } from './eval.mjs';

/**
 * @param {number} x
 * @returns {string}
 */
function f3(x) {
  return Number.isFinite(x) ? x.toFixed(3).replace(/^-/, '−') : '—';
}

export const command = {
  name: 'calibrate',
  summary: 'Refit the calibration of points into Quality from labels',
  flags: {
    write: { type: 'boolean', summary: 'rewrite config/calibration.json with the fit and bump its version' },
    ...labelFlags(),
  },
  /**
   * @param {import('./args.mjs').ParsedArgs} args
   * @param {any} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    const src = await labelSources(args.flags, ctx);
    if (src.rows.length === 0) {
      ctx.log.error('No labels to fit: label repositories in the explorer, '
        + 'or use --labels fixtures in a checkout.');
      return 1;
    }
    const scored = scoreRows(src.rows, ctx.config);
    const fit = fitPlatt(scored, { uniform: 'uniform', prior: [1, 1] });
    const current = ctx.config.calibration;
    const uni = scored.filter((r) => r.stratum === 'uniform');
    const ys = uni.map((r) => (r.label === 'G' ? 1 : 0));
    const brierCurrent = uni.length ? brier(uni.map((r) => quality(r.S, current)), ys) : NaN;
    const brierRefit = uni.length ? brier(uni.map((r) => quality(r.S, fit)), ys) : NaN;
    const changed = calibrationChanged(current, fit);
    const next = changed ? nextCalibration(current, fit, {
      date: ctx.now().slice(0, 10), weights: String(ctx.config.weights?.version ?? 'w1'),
    }) : null;

    /** @type {string | null} */
    let written = null;
    if (args.flags.write === true && next) {
      const problems = validateCalibration(next);
      if (problems.length) {
        throw new Error(`The refit calibration is not valid: ${problems.slice(0, 3).join('; ')}`);
      }
      written = path.join(ctx.configDir, 'calibration.json');
      writeJsonAtomicSync(written, next, { space: 2 });
    }

    if (ctx.flags.json) {
      ctx.printJson({
        current, fit, brier: { current: brierCurrent, refit: brierRefit }, changed, next, written,
      });
      return 0;
    }
    ctx.print(`Labels: ${fit.n} (${fit.positives} genuine) · uniform stratum ${fit.uniform} `
      + `(${fit.uniformPositives} genuine), smoothed base rate ${f3(fit.base)}`);
    ctx.print(`Calibration ${current.version}: a ${f3(current.a)}, b ${f3(current.b)} · `
      + `uniform Brier ${f3(brierCurrent)}`);
    ctx.print(`Refit: a ${f3(fit.a)}, b ${f3(fit.b)} · uniform Brier ${f3(brierRefit)}`);
    if (!changed) ctx.print('The refit matches the current calibration at three decimals; nothing to write.');
    else if (written && next) ctx.print(`Wrote ${written} as calibration ${next.version}.`);
    else ctx.print('Run with --write to save the refit as the next calibration version.');
    return 0;
  },
};
