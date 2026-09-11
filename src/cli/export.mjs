// @ts-check
/**
 * `unsung export` (DESIGN §9.1, §11.2): build the static gallery and its Atom feeds from the picks
 * you published. Argument handling and printing only; the work is in `src/publish/gallery.mjs`.
 */

import path from 'node:path';
import { ArgsError } from './args.mjs';
import { DEFAULT_TITLE, buildGallery, resolveBlocksExport } from '../publish/gallery.mjs';

/** @typedef {import('./args.mjs').ParsedArgs} ParsedArgs */
/** @typedef {import('./context.mjs').Ctx} Ctx */

/**
 * @param {string} abs
 * @returns {string}
 */
function shown(abs) {
  const rel = path.relative(process.cwd(), abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 * @returns {string}
 */
function count(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

export const command = {
  name: 'export',
  summary: 'Build the static gallery and Atom feeds from the picks you published',
  flags: {
    out: { type: 'string', default: 'site', arg: '<dir>', summary: 'where to write the site' },
    'site-url': {
      type: 'string', arg: '<url>', summary: 'public address of the site, for feeds and canonical links',
    },
    'issues-url': {
      type: 'string',
      arg: '<url>',
      summary: 'where maintainers can ask to be removed (needed once you publish)',
    },
    title: { type: 'string', default: DEFAULT_TITLE, arg: '<text>', summary: 'title of the gallery' },
  },

  /**
   * @param {ParsedArgs} args
   * @param {Ctx} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    if (args.positionals.length > 0) {
      throw new ArgsError(`export takes no arguments, got '${args.positionals[0].slice(0, 40)}'`);
    }
    const f = args.flags;
    const outDir = path.resolve(String(f.out ?? 'site'));
    const siteUrl = typeof f['site-url'] === 'string' && f['site-url'] !== '' ? f['site-url'] : null;
    if (!siteUrl) {
      ctx.log.warn('Without --site-url the feeds use relative links; set it to the address your site is '
        + 'published at so feed readers can follow them');
    }
    const store = await ctx.store();
    const blocksExport = await resolveBlocksExport();
    const result = await buildGallery({
      store,
      client: () => ctx.client(),
      config: ctx.config,
      outDir,
      siteUrl,
      issuesUrl: typeof f['issues-url'] === 'string' ? f['issues-url'] : null,
      title: typeof f.title === 'string' ? f.title : DEFAULT_TITLE,
      now: ctx.now,
      log: ctx.log,
      blocksExport,
      signal: ctx.signal,
    });

    if (f.json) {
      ctx.printJson({
        outDir: result.outDir,
        picks: result.entries.map((e) => e.nwo),
        pages: result.pages,
        feeds: result.feeds,
        skipped: result.skipped,
        removed: result.removed,
      });
      return 0;
    }
    const n = result.entries.length;
    const pages = count(result.pages.length, 'gem page', 'gem pages');
    const feeds = count(result.feeds.length, 'feed', 'feeds');
    ctx.print(`export     ${count(n, 'pick', 'picks')} · ${pages} · ${feeds} → ${shown(result.outDir)}`);
    for (const s of result.skipped) ctx.print(`skipped    ${s.nwo}: ${s.reason}`);
    for (const r of result.removed) ctx.print(`removed    ${r} (no longer published)`);
    if (n === 0) {
      ctx.print('No picks to publish yet. Save a gem in the explorer, press p to publish it with a note, '
        + 'then run unsung export again.');
    }
    return 0;
  },
};
