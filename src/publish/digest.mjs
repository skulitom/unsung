// @ts-check
/**
 * The weekly digest (DESIGN §11.4): Markdown and HTML for one ISO week. First the picks published
 * that week, with their notes and reasons; then "four weeks on", which reports how the picks
 * published four weeks earlier have fared: stars then and now, releases since, graduated or not.
 * Nothing is sent anywhere; the user pastes the digest into a blog, a newsletter or a discussion.
 *
 * Repository text is escaped for both formats. In the Markdown, every character that could start
 * a link, an image, emphasis, code, a table cell or raw HTML is backslash-escaped, and line breaks
 * are folded, so a description cannot add headings, links or HTML to the digest.
 */

import { isoWeek } from '../core/util.mjs';
import { cleanText, escapeHtml, externalLink, formatDate, page, siteLink } from './html.mjs';
import { siteHref } from './feed.mjs';

/** @typedef {import('./gallery.mjs').GalleryEntry} GalleryEntry */

/**
 * A pick as the digest sees it: a gallery entry, plus what the re-check found since it was featured.
 * @typedef {GalleryEntry & {releasesSince?: number | null, latestRelease?: string | null,
 *   gone?: boolean}} DigestEntry
 */

/**
 * @typedef {object} DigestData
 * @property {string} week
 * @property {DigestEntry[]} picks
 * @property {DigestEntry[]} earlier
 * @property {string} earlierWeek
 * @property {string | null} siteUrl
 * @property {string} title
 * @property {number} maxStars
 */

const WEEK = /^(\d{4})-W(\d{2})$/;
const DAY_MS = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

const FOOTER_TEXT = 'Chosen by hand with Unsung, which only reads public repositories and never acts on '
  + 'anyone\'s behalf.';

/**
 * Midnight UTC on the Monday that starts an ISO week (`2026-W37` → 7 September 2026).
 * @param {string} week
 * @returns {number} milliseconds since the epoch
 */
export function weekStart(week) {
  const m = WEEK.exec(String(week));
  if (!m) throw new RangeError(`Not an ISO week such as 2026-W37: '${String(week).slice(0, 20)}'`);
  const year = Number(m[1]);
  const n = Number(m[2]);
  const jan4 = Date.UTC(year, 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7;
  const start = jan4 - (dow - 1) * DAY_MS + (n - 1) * 7 * DAY_MS;
  if (n < 1 || isoWeek(start) !== week) throw new RangeError(`${week} does not exist`);
  return start;
}

/**
 * The ISO week `n` weeks after (or, when negative, before) `week`.
 * @param {string} week
 * @param {number} n
 * @returns {string}
 */
export function shiftWeek(week, n) {
  return isoWeek(weekStart(week) + n * 7 * DAY_MS);
}

/**
 * The last ISO week that has ended by `now`.
 * @param {string} now ISO timestamp
 * @returns {string}
 */
export function lastCompleteWeek(now) {
  const ms = Date.parse(now);
  if (!Number.isFinite(ms)) throw new RangeError(`Not a valid time: ${String(now).slice(0, 40)}`);
  return isoWeek(ms - 7 * DAY_MS);
}

/**
 * Whether an ISO timestamp falls inside an ISO week.
 * @param {unknown} iso
 * @param {string} week
 * @returns {boolean}
 */
export function inWeek(iso, week) {
  if (typeof iso !== 'string' || !Number.isFinite(Date.parse(iso))) return false;
  return isoWeek(iso) === week;
}

/**
 * `7–13 September 2026`, `31 August – 6 September 2026` or `29 December 2025 – 4 January 2026`.
 * @param {string} week
 * @returns {string}
 */
export function weekDates(week) {
  const a = new Date(weekStart(week));
  const b = new Date(weekStart(week) + 6 * DAY_MS);
  const [da, ma, ya] = [a.getUTCDate(), MONTHS[a.getUTCMonth()], a.getUTCFullYear()];
  const [db, mb, yb] = [b.getUTCDate(), MONTHS[b.getUTCMonth()], b.getUTCFullYear()];
  if (ya !== yb) return `${da} ${ma} ${ya} – ${db} ${mb} ${yb}`;
  if (ma !== mb) return `${da} ${ma} – ${db} ${mb} ${yb}`;
  return `${da}–${db} ${mb} ${yb}`;
}

/**
 * `week 37, 2026`.
 * @param {string} week
 * @returns {string}
 */
function weekLabel(week) {
  const m = /** @type {RegExpExecArray} */ (WEEK.exec(week));
  return `week ${Number(m[2])}, ${m[1]}`;
}

/**
 * What GitHub-flavoured Markdown turns into a link on its own (its autolink extension): a bare
 * `http://`, `https://` or `ftp://` URL, or a `www.` address. The token stops where a code span, a
 * table cell or Markdown link syntax would begin.
 */
const AUTOLINK = /(?:(?:https?|ftp):\/\/|www\.)[^\s<>()[\]`|]*/gi;

/**
 * Escape plain text (no URLs) for Markdown.
 * @param {string} s
 * @param {boolean} lineStart whether `s` starts the line
 * @returns {string}
 */
function escapePlain(s, lineStart) {
  let out = s.replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`);
  out = out.replace(/&(?=#?[A-Za-z0-9]+;)/g, '&amp;');
  if (lineStart) out = out.replace(/^([#>+=-]|\d+[.)])/, '\\$1');
  return out;
}

/**
 * Escape untrusted text for Markdown: line breaks folded, inline syntax characters and raw HTML
 * backslash-escaped, entity-like ampersands and line-leading block markers neutralised, and every
 * URL-like token (`https://…`, `www.…`) put in a code span, which GFM never autolinks, so text from
 * a repository cannot become a live link in the posted digest.
 * @param {unknown} text
 * @returns {string}
 */
export function escapeMarkdown(text) {
  const s = cleanText(text, { singleLine: true });
  let out = '';
  let last = 0;
  for (const m of s.matchAll(AUTOLINK)) {
    const at = /** @type {number} */ (m.index);
    out += escapePlain(s.slice(last, at), last === 0);
    out += `\`${m[0].replace(/[`|]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}\``;
    last = at + m[0].length;
  }
  return out + escapePlain(s.slice(last), last === 0);
}

/**
 * A URL safe to put inside Markdown `( )`: spaces, parentheses and angle brackets percent-encoded.
 * @param {string} url
 * @returns {string}
 */
function mdUrl(url) {
  return url.replace(/[ ()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * @param {DigestEntry} e
 * @param {string | null} siteUrl
 * @returns {string} the link for the pick's name: its gem page when the site URL is known
 */
function pickUrl(e, siteUrl) {
  return siteUrl ? siteHref(e.page, siteUrl) : e.url;
}

/**
 * @param {number | null | undefined} n
 * @returns {string}
 */
function count(n) {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-GB') : 'unknown';
}

/**
 * @param {DigestEntry} e
 * @returns {string}
 */
function releasesText(e) {
  if (typeof e.releasesSince !== 'number') return 'unknown';
  if (e.releasesSince === 0) return 'none';
  const tag = e.latestRelease ? cleanText(e.latestRelease, { singleLine: true, maxChars: 40 }) : '';
  return tag ? `${e.releasesSince} (latest ${tag})` : String(e.releasesSince);
}

/**
 * @param {DigestEntry} e
 * @param {number} maxStars
 * @returns {string}
 */
function statusText(e, maxStars) {
  if (typeof e.starsNow === 'number' && e.starsNow > maxStars) return `Graduated: past ${maxStars} stars`;
  if (e.archived) return 'Archived by its owner';
  return 'Still unsung';
}

/**
 * @param {number} n
 * @returns {string}
 */
function goneSentence(n) {
  if (n <= 0) return '';
  return n === 1 ? 'One pick from that week is no longer on GitHub, so it is left out.'
    : `${n} picks from that week are no longer on GitHub, so they are left out.`;
}

/**
 * @param {DigestEntry} e
 * @returns {string}
 */
function metaText(e) {
  /** @type {string[]} */
  const parts = [];
  if (e.lang) parts.push(e.lang);
  if (typeof e.starsAtPublish === 'number') {
    parts.push(`${count(e.starsAtPublish)} ${e.starsAtPublish === 1 ? 'star' : 'stars'} when featured`);
  }
  return parts.join(' · ');
}

/**
 * @param {DigestEntry[]} list
 * @returns {{shown: DigestEntry[], gone: number}}
 */
function splitGone(list) {
  const shown = list.filter((e) => !e.gone);
  return { shown, gone: list.length - shown.length };
}

/**
 * The digest as Markdown.
 * @param {DigestData} d
 * @returns {string}
 */
function toMarkdown({ week, picks, earlier, earlierWeek, siteUrl, title, maxStars }) {
  const { shown, gone } = splitGone(earlier);
  const lines = [`# ${escapeMarkdown(title)}: ${weekLabel(week)}`, ''];
  const n = picks.length;
  lines.push(`${weekDates(week)} · ${n === 1 ? '1 pick' : `${n} picks`}`, '');
  if (n === 0) lines.push('No picks were published this week.', '');
  for (const e of picks) {
    lines.push(`## [${escapeMarkdown(e.nwo)}](${mdUrl(pickUrl(e, siteUrl))})`, '');
    const about = e.pitch || e.description;
    if (about) lines.push(escapeMarkdown(about), '');
    if (e.note) {
      for (const para of cleanText(e.note).split(/\n{2,}/)) lines.push(`> ${escapeMarkdown(para)}`, '>');
      lines.pop();
      lines.push('');
    }
    if (e.reasons.length > 0) {
      for (const r of e.reasons) lines.push(`- ${escapeMarkdown(r)}`);
      lines.push('');
    }
    const meta = metaText(e);
    lines.push(`${meta ? `${escapeMarkdown(meta)} · ` : ''}[on GitHub](${mdUrl(e.url)})`, '');
  }
  lines.push('## Four weeks on', '');
  const earlierDates = `${weekLabel(earlierWeek)} (${weekDates(earlierWeek)})`;
  lines.push(`How the picks of ${earlierDates} are doing.`, '');
  if (shown.length === 0 && gone === 0) lines.push('No picks were published that week.', '');
  if (shown.length > 0) {
    lines.push('| Repository | Stars then | Stars now | Releases since | Status |');
    lines.push('|---|---:|---:|---|---|');
    for (const e of shown) {
      const name = `[${escapeMarkdown(e.nwo)}](${mdUrl(pickUrl(e, siteUrl))})`;
      lines.push(`| ${name} | ${count(e.starsAtPublish)} | ${count(e.starsNow)} `
        + `| ${escapeMarkdown(releasesText(e))} | ${statusText(e, maxStars)} |`);
    }
    lines.push('');
  }
  const goneText = goneSentence(gone);
  if (goneText) lines.push(goneText, '');
  lines.push('---', '', `_${escapeMarkdown(FOOTER_TEXT)}_`, '');
  return lines.join('\n');
}

/**
 * @param {DigestEntry} e
 * @param {string | null} siteUrl
 * @returns {string}
 */
function nameLinkHtml(e, siteUrl) {
  return siteUrl ? externalLink(pickUrl(e, siteUrl), e.nwo) : siteLink(`../${e.page}`, e.nwo);
}

/**
 * The digest as a standalone HTML page, meant to sit in `site/digest/`.
 * @param {DigestData} d
 * @returns {string}
 */
function toHtml({ week, picks, earlier, earlierWeek, siteUrl, title, maxStars }) {
  const { shown, gone } = splitGone(earlier);
  const heading = `${title}: ${weekLabel(week)}`;
  const n = picks.length;
  /** @type {string[]} */
  const body = [
    `<header class="site"><p class="brand">${siteLink('../', title)}</p></header>`,
    '<main class="digest">',
    `<h1>${escapeHtml(heading)}</h1>`,
    `<p class="small muted">${escapeHtml(weekDates(week))} · ${n === 1 ? '1 pick' : `${n} picks`}</p>`,
  ];
  if (n === 0) body.push('<p>No picks were published this week.</p>');
  for (const e of picks) {
    const about = e.pitch || e.description;
    const paras = e.note ? cleanText(e.note).split(/\n{2,}/) : [];
    const note = paras.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
    const meta = metaText(e);
    body.push(
      '<article class="pick">',
      `<h2>${nameLinkHtml(e, siteUrl)}</h2>`,
      about ? `<p class="description" dir="auto">${escapeHtml(about)}</p>` : '',
      note ? `<figure class="note"><blockquote dir="auto">${note}</blockquote>`
        + '<figcaption>The curator&#39;s note</figcaption></figure>' : '',
      e.reasons.length > 0
        ? `<ul class="reasons">${e.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '',
      `<p class="meta">${meta ? `${escapeHtml(meta)} · ` : ''}${externalLink(e.url, 'on GitHub')}</p>`,
      '</article>',
    );
  }
  body.push(
    '<section class="later">',
    '<h2>Four weeks on</h2>',
    `<p>How the picks of ${escapeHtml(weekLabel(earlierWeek))} (${escapeHtml(weekDates(earlierWeek))}) `
      + 'are doing.</p>',
  );
  if (shown.length === 0 && gone === 0) body.push('<p>No picks were published that week.</p>');
  if (shown.length > 0) {
    body.push('<div class="table"><table>', '<thead><tr><th scope="col">Repository</th>'
      + '<th scope="col">Stars then</th><th scope="col">Stars now</th><th scope="col">Releases since</th>'
      + '<th scope="col">Status</th></tr></thead>', '<tbody>');
    for (const e of shown) {
      body.push(`<tr><td>${nameLinkHtml(e, siteUrl)}</td><td>${escapeHtml(count(e.starsAtPublish))}</td>`
        + `<td>${escapeHtml(count(e.starsNow))}</td><td>${escapeHtml(releasesText(e))}</td>`
        + `<td>${escapeHtml(statusText(e, maxStars))}</td></tr>`);
    }
    body.push('</tbody>', '</table></div>');
  }
  const goneText = goneSentence(gone);
  if (goneText) body.push(`<p>${escapeHtml(goneText)}</p>`);
  body.push('</section>', '</main>', `<footer class="site"><p>${escapeHtml(FOOTER_TEXT)}</p></footer>`);
  return page({
    title: heading,
    description: `${n === 1 ? 'One repository' : `${n} repositories`} picked by hand in ${weekLabel(week)}, `
      + 'and how earlier picks are doing.',
    canonical: siteUrl ? siteHref(`digest/${week}.html`, siteUrl) : null,
    body: body.filter(Boolean).join('\n'),
    assetsBase: '../',
  });
}

/**
 * Build the digest for an ISO week (§11.4).
 * @param {object} opts
 * @param {string} opts.week `YYYY-Www`
 * @param {DigestEntry[]} opts.picks the picks published that week
 * @param {DigestEntry[]} opts.fourWeeksAgo the picks published four weeks earlier, re-checked;
 *   entries marked `gone` are counted but not named
 * @param {string | null} [opts.siteUrl] public URL of the site; without it, names link to GitHub in
 *   the Markdown and to the relative gem pages in the HTML
 * @param {string} [opts.title]
 * @param {number} [opts.maxStars] above this a pick has graduated (default 25)
 * @returns {{markdown: string, html: string}}
 */
export function buildDigest({
  week, picks, fourWeeksAgo, siteUrl = null, title = 'Unsung picks', maxStars = 25,
}) {
  weekStart(week);
  const d = {
    week,
    picks: (picks ?? []).filter((e) => !e.gone),
    earlier: fourWeeksAgo ?? [],
    earlierWeek: shiftWeek(week, -4),
    siteUrl: siteUrl || null,
    title: cleanText(title, { singleLine: true, maxChars: 120 }) || 'Unsung picks',
    maxStars,
  };
  return { markdown: toMarkdown(d), html: toHtml(d) };
}

/**
 * Releases published after `since`, from the re-check's recent releases (prereleases ignored).
 * @param {{recent: import('./recheck.mjs').LiveRelease[]} | null | undefined} releases
 * @param {string} since ISO timestamp
 * @returns {{count: number | null, latest: string | null}}
 */
export function releasesSince(releases, since) {
  if (!releases || !Array.isArray(releases.recent)) return { count: null, latest: null };
  const after = releases.recent.filter((r) => !r.prerelease && typeof r.publishedAt === 'string'
    && r.publishedAt > since);
  after.sort((a, b) => String(b.publishedAt).localeCompare(String(a.publishedAt)));
  return { count: after.length, latest: after[0]?.tag ?? null };
}

/**
 * `formatDate` again, for callers that build digest text.
 * @param {unknown} iso
 * @returns {string}
 */
export function digestDate(iso) {
  return formatDate(iso);
}
