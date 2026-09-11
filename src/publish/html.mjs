// @ts-check
/**
 * HTML generation for the gallery, gem pages and digests (DESIGN §11.2, §7.6, §10.8).
 *
 * Every value that reaches a page goes through `escapeHtml` or `escapeAttr`; repository text is also
 * passed through `cleanText`, which removes control characters and the bidirectional overrides that
 * can make a page read differently from its source. Links are real anchors only for `https:` URLs
 * that are not archives or executables. The output never contains inline scripts or styles, so the
 * page-level Content-Security-Policy can forbid both. Which URLs may be anchors is decided by
 * `safeLinkUrl` in src/core/views.mjs, the rule the explorer shares.
 */

import { UNSAFE_LINK_EXTENSIONS, safeLinkUrl } from '../core/views.mjs';

/** Content-Security-Policy for every generated page: no inline code, no remote resources. */
export const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
  + "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * File extensions that mark a link as an archive, installer or script (§7.2 `g.lure.link`, §10.8),
 * with their dots. A link with a path segment ending in one is shown as text, never as an anchor.
 */
export const UNSAFE_EXTENSIONS = UNSAFE_LINK_EXTENSIONS;

/** @type {Record<string, string>} */
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** @type {Record<string, string>} */
const ATTR_EXTRA = { '`': '&#96;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

/**
 * C0 and C1 control characters other than tab, line feed and carriage return: never valid in a page.
 * @param {number} cp
 * @returns {boolean}
 */
function isControl(cp) {
  return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || (cp >= 0x7f && cp <= 0x9f);
}

/**
 * Bidirectional embeddings, overrides and isolates, which can reorder how surrounding text is
 * displayed. Plain direction marks (U+200E, U+200F) are harmless and kept.
 * @param {number} cp
 * @returns {boolean}
 */
function isBidiControl(cp) {
  return (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
}

/**
 * Invisible characters with no display role in a description or note: zero-width space, word joiner
 * and invisible operators, and the byte-order mark. Zero-width joiners (U+200C, U+200D) are kept,
 * because emoji sequences and several scripts need them.
 * @param {number} cp
 * @returns {boolean}
 */
function isInvisible(cp) {
  return cp === 0x200b || (cp >= 0x2060 && cp <= 0x2064) || cp === 0xfeff;
}

/**
 * Unpaired surrogate halves and the noncharacters U+FFFE and U+FFFF.
 * @param {number} cp
 * @returns {boolean}
 */
function isBroken(cp) {
  return (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff;
}

/**
 * @param {unknown} value
 * @param {(cp: number) => boolean} drop
 * @returns {string}
 */
function filterChars(value, drop) {
  const s = value === null || value === undefined ? '' : String(value);
  let out = '';
  for (const ch of s) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (!drop(cp)) out += ch;
  }
  return out;
}

/**
 * Escape text for an HTML text node. Control characters, unpaired surrogates and bidirectional
 * overrides are removed; `& < > " '` become entities. `null` and `undefined` become ''.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  const s = filterChars(value, (cp) => isControl(cp) || isBroken(cp) || isBidiControl(cp));
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/**
 * Escape text for a double-quoted attribute value: as `escapeHtml`, and also backticks and line
 * breaks, so the value stays on one line and inside its quotes.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeAttr(value) {
  return escapeHtml(value).replace(/[`\n\r\t]/g, (c) => ATTR_EXTRA[c]);
}

/**
 * Tidy untrusted text for display: drop control, invisible and bidirectional-override characters;
 * optionally fold all whitespace to single spaces and cap the length (an ellipsis marks a cut).
 * The result still needs escaping.
 * @param {unknown} value
 * @param {{singleLine?: boolean, maxChars?: number}} [opts]
 * @returns {string}
 */
export function cleanText(value, { singleLine = false, maxChars } = {}) {
  let s = filterChars(value, (cp) => isControl(cp) || isBroken(cp) || isBidiControl(cp) || isInvisible(cp));
  s = singleLine ? s.replace(/\s+/g, ' ').trim() : s.replace(/\r\n?/g, '\n').trim();
  if (typeof maxChars === 'number' && maxChars > 0) {
    const chars = [...s];
    if (chars.length > maxChars) s = `${chars.slice(0, Math.max(1, maxChars - 1)).join('').trimEnd()}…`;
  }
  return s;
}

/**
 * The normalised URL if it may become a link (§10.8), by `safeLinkUrl`: `https:` only, no embedded
 * credentials, not a download host or link shortener, and no path segment naming an archive,
 * installer or script. Otherwise null.
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeUrl(value) {
  return safeLinkUrl(value);
}

/**
 * An anchor to one of the site's own pages; `href` is a relative path built by Unsung, never
 * repository text.
 * @param {string} href
 * @param {string} text
 * @param {{className?: string}} [opts]
 * @returns {string}
 */
export function siteLink(href, text, { className } = {}) {
  const cls = className ? ` class="${escapeAttr(className)}"` : '';
  return `<a href="${escapeAttr(href)}"${cls}>${escapeHtml(text)}</a>`;
}

/**
 * An anchor to an external `https:` URL, or the text alone when the URL may not be linked. Links
 * whose URL came from repository content (`ugc`) are marked `nofollow ugc`.
 * @param {unknown} url
 * @param {string} text
 * @param {{ugc?: boolean, className?: string}} [opts]
 * @returns {string}
 */
export function externalLink(url, text, { ugc = false, className } = {}) {
  const safe = safeUrl(url);
  if (!safe) return escapeHtml(text);
  const rel = ugc ? 'noopener nofollow ugc' : 'noopener';
  const cls = className ? ` class="${escapeAttr(className)}"` : '';
  return `<a href="${escapeAttr(safe)}" rel="${rel}"${cls}>${escapeHtml(text)}</a>`;
}

/**
 * `11 September 2026` for an ISO timestamp (UTC), or '' when it is not a date.
 * @param {unknown} iso
 * @returns {string}
 */
export function formatDate(iso) {
  const ms = typeof iso === 'string' || typeof iso === 'number' ? Date.parse(String(iso)) : NaN;
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * `1 star`, `3 stars`; `null` gives `an unknown number of stars`.
 * @param {number | null | undefined} n
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
export function plural(n, one, many = `${one}s`) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return `an unknown number of ${many}`;
  return `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;
}

/**
 * @typedef {object} PageOptions
 * @property {string} title shown in the tab and as `og:title`
 * @property {string} [description] meta and `og:description`
 * @property {string | null} [canonical] absolute `https:` or `http:` URL of this page
 * @property {string} body trusted HTML built with this module's escaping functions
 * @property {string} [assetsBase] relative path from this page to the site root ('' or `../../../`)
 * @property {string[]} [scripts] module scripts, relative to the site root (`assets/gallery.mjs`)
 * @property {{title: string, href: string}[]} [feeds] Atom feeds to advertise
 */

/**
 * A complete HTML document. The head carries the page CSP, a referrer policy, the title, the
 * description and Open Graph `title` and `description` (no image), an optional canonical link, the
 * gallery stylesheet and optional module scripts and feed links. `body` is inserted as it is, so it
 * must already be escaped.
 * @param {PageOptions} opts
 * @returns {string}
 */
export function page({ title, description = '', canonical = null, body, assetsBase = '', scripts = [],
  feeds = [] }) {
  const t = cleanText(title, { singleLine: true, maxChars: 200 });
  const desc = cleanText(description, { singleLine: true, maxChars: 300 });
  const base = typeof assetsBase === 'string' && /^(\.\.?\/)*$/.test(assetsBase) ? assetsBase : '';
  /** @type {string | null} */
  let canon = null;
  if (typeof canonical === 'string') {
    try {
      const u = new URL(canonical);
      if (u.protocol === 'https:' || u.protocol === 'http:') canon = u.href;
    } catch {
      canon = null;
    }
  }
  const lines = [
    '<!doctype html>',
    '<html lang="en-GB">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(PAGE_CSP)}">`,
    '<meta name="referrer" content="strict-origin-when-cross-origin">',
    `<title>${escapeHtml(t)}</title>`,
    desc ? `<meta name="description" content="${escapeAttr(desc)}">` : null,
    `<meta property="og:title" content="${escapeAttr(t)}">`,
    desc ? `<meta property="og:description" content="${escapeAttr(desc)}">` : null,
    canon ? `<link rel="canonical" href="${escapeAttr(canon)}">` : null,
    `<link rel="stylesheet" href="${escapeAttr(`${base}assets/style.css`)}">`,
    ...feeds.map((f) => `<link rel="alternate" type="application/atom+xml" title="${escapeAttr(f.title)}" `
      + `href="${escapeAttr(f.href)}">`),
    ...scripts.map((s) => `<script type="module" src="${escapeAttr(`${base}${s}`)}"></script>`),
    '</head>',
    '<body>',
    body,
    '</body>',
    '</html>',
    '',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Safe blocks (§10.8): heading, paragraph, code, list, quote, rule; inline runs are text, code or
// links {text, url}.
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {string | {type?: string, kind?: string, text?: string, value?: string, url?: string,
 *   alt?: string}} Run
 */
/**
 * @typedef {{type?: string, kind?: string, level?: number, depth?: number, ordered?: boolean,
 *   text?: string, runs?: Run[], inline?: Run[], children?: unknown[], content?: unknown[],
 *   items?: unknown[], blocks?: unknown[]}} Block
 */

/**
 * @param {unknown} v
 * @returns {Block | null}
 */
function asBlock(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? /** @type {Block} */ (v) : null;
}

/**
 * @param {Block} b
 * @returns {string}
 */
function blockType(b) {
  return String(b.type ?? b.kind ?? 'paragraph').toLowerCase();
}

const BLOCK_TYPES = new Set(['heading', 'paragraph', 'code', 'list', 'quote', 'rule']);

/**
 * @param {unknown[]} list
 * @returns {boolean}
 */
function looksLikeBlocks(list) {
  return list.length > 0 && list.every((x) => {
    const b = asBlock(x);
    return b !== null && BLOCK_TYPES.has(blockType(b));
  });
}

/**
 * @param {Block} b
 * @returns {Run[]}
 */
function runsOf(b) {
  const r = b.runs ?? b.inline ?? b.children ?? b.content;
  if (Array.isArray(r)) return /** @type {Run[]} */ (r);
  if (typeof b.text === 'string') return [b.text];
  return [];
}

/**
 * @param {unknown} label
 * @param {unknown} url
 * @param {boolean} quarantined
 * @returns {string}
 */
function blockLink(label, url, quarantined) {
  const shownUrl = cleanText(url, { singleLine: true, maxChars: 300 });
  const text = cleanText(label, { singleLine: true }) || shownUrl;
  const safe = quarantined ? null : safeUrl(url);
  if (!safe) {
    return shownUrl && shownUrl !== text ? `${escapeHtml(text)} (${escapeHtml(shownUrl)})` : escapeHtml(text);
  }
  const suffix = text === safe ? '' : ` <span class="url">(${escapeHtml(safe)})</span>`;
  return `<a href="${escapeAttr(safe)}" rel="noopener noreferrer nofollow" target="_blank">`
    + `${escapeHtml(text)}</a>${suffix}`;
}

/**
 * @param {unknown} run
 * @param {boolean} quarantined
 * @returns {string}
 */
function runHtml(run, quarantined) {
  if (typeof run === 'string') return escapeHtml(run);
  const r = asBlock(run);
  if (!r) return '';
  const kind = String(r.type ?? r.kind ?? 'text').toLowerCase();
  const text = r.text ?? r.value ?? '';
  if (kind === 'link' || typeof r.url === 'string') return blockLink(text, r.url, quarantined);
  if (kind === 'code') return `<code>${escapeHtml(text)}</code>`;
  if (kind === 'image') return escapeHtml(`[image: ${String(/** @type {any} */ (r).alt ?? text)}]`);
  return escapeHtml(text);
}

/**
 * @param {Run[]} runs
 * @param {boolean} quarantined
 * @returns {string}
 */
function runsHtml(runs, quarantined) {
  return runs.map((r) => runHtml(r, quarantined)).join('');
}

/**
 * @param {unknown} item
 * @param {boolean} quarantined
 * @param {number} offset
 * @returns {string}
 */
function listItemHtml(item, quarantined, offset) {
  if (typeof item === 'string') return escapeHtml(item);
  if (Array.isArray(item)) {
    return looksLikeBlocks(item) ? renderBlocks(item, quarantined, offset) : runsHtml(item, quarantined);
  }
  const b = asBlock(item);
  if (!b) return '';
  if (Array.isArray(b.blocks)) return renderBlocks(b.blocks, quarantined, offset);
  return runsHtml(runsOf(b), quarantined);
}

/**
 * @param {unknown} value
 * @param {boolean} quarantined
 * @param {number} offset
 * @returns {string}
 */
function blockHtml(value, quarantined, offset) {
  if (typeof value === 'string') return `<p>${escapeHtml(value)}</p>`;
  const b = asBlock(value);
  if (!b) return '';
  switch (blockType(b)) {
    case 'heading': {
      const raw = Number(b.level ?? b.depth ?? 2);
      const level = Math.min(6, Math.max(1, (Number.isFinite(raw) ? Math.round(raw) : 2) + offset));
      return `<h${level}>${runsHtml(runsOf(b), quarantined)}</h${level}>`;
    }
    case 'code': {
      const text = typeof b.text === 'string' ? b.text : runsOf(b).map((r) => (typeof r === 'string'
        ? r : String(r?.text ?? ''))).join('');
      return `<pre><code>${escapeHtml(text)}</code></pre>`;
    }
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const items = Array.isArray(b.items) ? b.items : [];
      const lis = items.map((it) => `<li>${listItemHtml(it, quarantined, offset)}</li>`).join('');
      return `<${tag}>${lis}</${tag}>`;
    }
    case 'quote': {
      const kids = Array.isArray(b.children) && looksLikeBlocks(b.children) ? b.children : null;
      const inner = Array.isArray(b.blocks) ? b.blocks : kids;
      if (inner) return `<blockquote>${renderBlocks(inner, quarantined, offset)}</blockquote>`;
      return `<blockquote><p>${runsHtml(runsOf(b), quarantined)}</p></blockquote>`;
    }
    case 'rule':
      return '<hr>';
    default:
      return `<p>${runsHtml(runsOf(b), quarantined)}</p>`;
  }
}

/**
 * @param {unknown[]} blocks
 * @param {boolean} quarantined
 * @param {number} offset
 * @returns {string}
 */
function renderBlocks(blocks, quarantined, offset) {
  return blocks.map((b) => blockHtml(b, quarantined, offset)).filter((s) => s !== '').join('\n');
}

/**
 * Render safe blocks (from `toSafeBlocks`, §10.8) as HTML. Text is escaped; raw HTML inside a block
 * stays literal text; a link becomes an anchor only if its URL is `https:`, not an archive or
 * executable, and the repository is not quarantined, and then it carries
 * `rel="noopener noreferrer nofollow"`, `target="_blank"` and its full URL after the label. Every
 * other link is plain text with its URL. Images become `[image: alt]`.
 * @param {unknown} blocks
 * @param {{quarantined?: boolean, headingOffset?: number}} [opts] `headingOffset` demotes headings
 * @returns {string}
 */
export function blocksToHtml(blocks, { quarantined = false, headingOffset = 0 } = {}) {
  if (!Array.isArray(blocks)) return '';
  const offset = Number.isInteger(headingOffset) ? headingOffset : 0;
  return renderBlocks(blocks, Boolean(quarantined), offset);
}
