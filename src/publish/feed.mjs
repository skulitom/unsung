// @ts-check
/**
 * Atom feeds (RFC 4287; DESIGN §11.3). The feed id is `tag:unsung.local,2026:<site-url>`; an entry id
 * is `tag:unsung.local,2026:<node id>`; `updated` is the publish time; the title is
 * `owner/name — pitch or description`; content is `type="text"`; `link rel="alternate"` points to the
 * gem page and `link rel="related"` to the repository.
 *
 * Every value is escaped for XML, and characters XML 1.0 forbids (most control characters, unpaired
 * surrogates) are removed, so a feed is always well-formed whatever a repository says about itself.
 */

import { cleanText } from './html.mjs';

/** @typedef {import('./gallery.mjs').GalleryEntry} GalleryEntry */

/** Prefix of every feed and entry id. */
export const TAG_PREFIX = 'tag:unsung.local,2026:';

/** @type {Record<string, string>} */
const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/**
 * @typedef {object} AtomEntry
 * @property {string} id
 * @property {string} title
 * @property {string} updated RFC 3339
 * @property {string | null} published RFC 3339
 * @property {string} alternate the gem page
 * @property {string} related the repository
 * @property {string} content plain text
 */

/**
 * A code point XML 1.0 allows in a document, minus the C1 control range, which it discourages.
 * @param {number} cp
 * @returns {boolean}
 */
function isXmlChar(cp) {
  if (cp >= 0x7f && cp <= 0x9f) return false;
  return cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp <= 0xd7ff)
    || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

/**
 * Escape text for XML character data or a quoted attribute, removing characters XML forbids.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeXml(value) {
  const s = value === null || value === undefined ? '' : String(value);
  let out = '';
  for (const ch of s) {
    if (isXmlChar(/** @type {number} */ (ch.codePointAt(0)))) out += ch;
  }
  return out.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/**
 * An RFC 3339 timestamp (`2026-09-11T10:00:00Z`) for an ISO string, or null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function atomDate(value) {
  const ms = typeof value === 'string' || typeof value === 'number' ? Date.parse(String(value)) : NaN;
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * Resolve a site-relative path against the site URL; without a site URL the path stays relative.
 * @param {string} rel
 * @param {string | null | undefined} siteUrl
 * @returns {string}
 */
export function siteHref(rel, siteUrl) {
  if (!siteUrl) return rel;
  try {
    return new URL(rel, siteUrl).href;
  } catch {
    return rel;
  }
}

/**
 * The Atom entry for a gallery entry (§11.3).
 * @param {GalleryEntry} entry
 * @param {string | null | undefined} siteUrl public URL of the site, ending in `/`
 * @returns {AtomEntry}
 */
export function feedEntry(entry, siteUrl) {
  const head = cleanText(entry.pitch || entry.description || '', { singleLine: true, maxChars: 200 });
  const updated = atomDate(entry.publishedAt) ?? '1970-01-01T00:00:00Z';
  /** @type {string[]} */
  const parts = [];
  const note = cleanText(entry.note ?? '');
  if (note) parts.push(note);
  const about = cleanText(entry.pitch || entry.description || '', { singleLine: true });
  if (about && about !== note) parts.push(about);
  const reasons = (entry.reasons ?? []).map((r) => `- ${cleanText(r, { singleLine: true })}`);
  if (reasons.length > 0) parts.push(['Why it is here:', ...reasons].join('\n'));
  const now = typeof entry.starsNow === 'number' ? `, ${entry.starsNow} now` : '';
  if (typeof entry.starsAtPublish === 'number') {
    parts.push(`Stars when featured: ${entry.starsAtPublish}${now}.`);
  }
  parts.push(`Repository: ${entry.url}`);
  return {
    id: `${TAG_PREFIX}${entry.id}`,
    title: head ? `${entry.nwo} — ${head}` : entry.nwo,
    updated,
    published: updated,
    alternate: siteHref(entry.page, siteUrl),
    related: entry.url,
    content: parts.join('\n\n'),
  };
}

/**
 * @typedef {object} FeedOptions
 * @property {string} id feed id (`tag:unsung.local,2026:<site-url>`)
 * @property {string} title
 * @property {string} selfUrl where this feed is published
 * @property {string} siteUrl the gallery page this feed belongs to
 * @property {string | null} [updated] RFC 3339; default the newest entry, else the epoch
 * @property {AtomEntry[]} entries
 * @property {string | null} [author] feed author (default the title); RFC 4287 needs one
 * @property {string | null} [subtitle]
 */

/**
 * A complete Atom 1.0 document.
 * @param {FeedOptions} opts
 * @returns {string}
 */
export function atomFeed({
  id, title, selfUrl, siteUrl, updated = null, entries, author = null, subtitle = null,
}) {
  const newest = entries.map((e) => e.updated).filter(Boolean).sort().at(-1) ?? null;
  const when = atomDate(updated) ?? atomDate(newest) ?? '1970-01-01T00:00:00Z';
  /** @type {string[]} */
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-GB">',
    `  <id>${escapeXml(id)}</id>`,
    `  <title type="text">${escapeXml(title)}</title>`,
  ];
  if (subtitle) lines.push(`  <subtitle type="text">${escapeXml(subtitle)}</subtitle>`);
  lines.push(
    `  <updated>${when}</updated>`,
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(selfUrl)}"/>`,
    `  <link rel="alternate" type="text/html" href="${escapeXml(siteUrl)}"/>`,
    `  <author><name>${escapeXml(author ?? title)}</name></author>`,
    '  <generator>Unsung</generator>',
  );
  for (const e of entries) {
    lines.push(
      '  <entry>',
      `    <id>${escapeXml(e.id)}</id>`,
      `    <title type="text">${escapeXml(e.title)}</title>`,
      `    <updated>${atomDate(e.updated) ?? when}</updated>`,
    );
    const published = atomDate(e.published);
    if (published) lines.push(`    <published>${published}</published>`);
    lines.push(
      `    <link rel="alternate" type="text/html" href="${escapeXml(e.alternate)}"/>`,
      `    <link rel="related" type="text/html" href="${escapeXml(e.related)}"/>`,
      `    <content type="text">${escapeXml(e.content)}</content>`,
      '  </entry>',
    );
  }
  lines.push('</feed>', '');
  return lines.join('\n');
}
