// @ts-check
/**
 * `unsung digest` (DESIGN §9.1, §11.4): write the weekly digest, as Markdown and HTML, for an ISO
 * week. It lists the picks published that week and reports how the picks of four weeks earlier have
 * fared, after a live re-check. Nothing is sent anywhere. Argument handling and printing only; the
 * work is in `src/publish/digest.mjs` and `src/publish/gallery.mjs`.
 */

import path from 'node:path';
import { ArgsError } from './args.mjs';
import {
  DEFAULT_TITLE, eligiblePicks, normaliseOptOut, normaliseSiteUrl, optedOut, resolveBlocksExport, resolveNow,
  toGalleryEntry,
} from '../publish/gallery.mjs';
import {
  buildDigest, inWeek, lastCompleteWeek, releasesSince, shiftWeek, weekStart,
} from '../publish/digest.mjs';
import { readJsonInside, writeFileAtomic } from '../publish/files.mjs';
import { recheckRepos } from '../publish/recheck.mjs';

/** @typedef {import('./args.mjs').ParsedArgs} ParsedArgs */
/** @typedef {import('./context.mjs').Ctx} Ctx */
/** @typedef {import('../publish/gallery.mjs').Pick} Pick */
/** @typedef {import('../publish/digest.mjs').DigestEntry} DigestEntry */

/**
 * @param {string} abs
 * @returns {string}
 */
function shown(abs) {
  const rel = path.relative(process.cwd(), abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
}

export const command = {
  name: 'digest',
  summary: 'Build the weekly digest',
  flags: {
    week: { type: 'string', arg: 'YYYY-Www', summary: 'ISO week to write (default: the last complete week)' },
    out: { type: 'string', default: 'site/digest', arg: '<dir>', summary: 'where to write the digest' },
    'site-url': {
      type: 'string', arg: '<url>',
      summary: 'public address of the site, for links to gem pages (default: the one the last export used)',
    },
  },

  /**
   * @param {ParsedArgs} args
   * @param {Ctx} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    if (args.positionals.length > 0) {
      throw new ArgsError(`digest takes no arguments, got '${args.positionals[0].slice(0, 40)}'`);
    }
    const f = args.flags;
    const now = resolveNow(ctx.now);
    const given = typeof f.week === 'string' && f.week !== '' ? f.week.trim().toUpperCase() : null;
    const week = given ? given.replace(/^(\d{4})-?W/, '$1-W') : lastCompleteWeek(now);
    try {
      weekStart(week);
    } catch {
      const got = String(f.week).slice(0, 20);
      throw new ArgsError(`--week expects an ISO week such as 2026-W37, got '${got}'`);
    }
    const outDir = path.resolve(String(f.out ?? 'site/digest'));
    const lastExport = readJsonInside(path.dirname(outDir), 'data/gallery.json', null);
    const flagSite = typeof f['site-url'] === 'string' && f['site-url'] !== '' ? f['site-url'] : null;
    const savedSite = typeof lastExport?.siteUrl === 'string' ? lastExport.siteUrl : null;
    const siteUrl = normaliseSiteUrl(flagSite ?? savedSite);
    const savedTitle = typeof lastExport?.title === 'string' ? lastExport.title : '';
    const title = savedTitle || DEFAULT_TITLE;
    const cfg = /** @type {any} */ (ctx.config);
    const maxStars = Number(cfg?.weights?.eligibility?.maxStars ?? cfg?.defaults?.maxStars ?? 25);

    const store = await ctx.store();
    const blocksExport = await resolveBlocksExport();
    const picks = await eligiblePicks({ store, now, blocksExport });
    const earlierWeek = shiftWeek(week, -4);
    const thisWeek = picks.filter((p) => inWeek(p.publishedAt, week));
    const earlier = picks.filter((p) => inWeek(p.publishedAt, earlierWeek));
    const wanted = [...thisWeek, ...earlier];
    const live = wanted.length > 0
      ? await recheckRepos(await ctx.client(), wanted.map((p) => p.id), { signal: ctx.signal })
      : new Map();
    const optout = normaliseOptOut(typeof store.readOptOut === 'function' ? await store.readOptOut() : null);

    /**
     * @param {Pick} p
     * @returns {DigestEntry | null}
     */
    const toEntry = (p) => {
      const l = live.get(p.id) ?? null;
      if (!l) return { ...toGalleryEntry(p, null), gone: true };
      if (optedOut(optout, p.id, l.nwo, l.owner)) return null;
      const r = releasesSince(l.releases, p.publishedAt);
      return { ...toGalleryEntry(p, l), releasesSince: r.count, latestRelease: r.latest, gone: false };
    };
    const weekEntries = /** @type {DigestEntry[]} */ (thisWeek.map(toEntry).filter((e) => e && !e.gone));
    const earlierEntries = /** @type {DigestEntry[]} */ (earlier.map(toEntry).filter(Boolean));

    const { markdown, html } = buildDigest({
      week, picks: weekEntries, fourWeeksAgo: earlierEntries, siteUrl, title, maxStars,
    });
    const md = writeFileAtomic(outDir, `${week}.md`, markdown);
    const page = writeFileAtomic(outDir, `${week}.html`, html);

    if (f.json) {
      ctx.printJson({
        week, markdown: md, html: page, picks: weekEntries.map((e) => e.nwo),
        fourWeeksOn: { week: earlierWeek, picks: earlierEntries.filter((e) => !e.gone).map((e) => e.nwo) },
      });
      return 0;
    }
    const n = weekEntries.length;
    ctx.print(`digest     ${week} · ${n === 1 ? '1 pick' : `${n} picks`} · four weeks on: `
      + `${earlierEntries.filter((e) => !e.gone).length} from ${earlierWeek}`);
    ctx.print(`written    ${shown(md)}, ${shown(page)}`);
    if (!siteUrl) {
      ctx.print('Tip: pass --site-url (or export with it first) so the Markdown links to your gem pages.');
    }
    return 0;
  },
};
