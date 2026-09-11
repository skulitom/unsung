// @ts-check
/**
 * Safe DOM building for the explorer (DESIGN §10.8). Every node is made with `createElement` and
 * every string goes in as a text node or through `textContent`; the HTML-parsing sinks are never
 * used (test/web-safety.test.mjs scans web/ for them). A link becomes an `<a>` only when its URL is
 * `https:`, it does not name an archive or an executable, and the repository is not quarantined;
 * the full URL is always shown after the label. Repository text is never parsed as HTML. Which URLs
 * may be links is decided by `safeLinkUrl` in src/core/views.mjs, the rule the gallery shares.
 */

import { UNSAFE_LINK_EXTENSIONS, safeLinkUrl } from '../src/core/views.mjs';

/**
 * Extensions of archives and executables (§7.2, §10.8), without their dots: a URL with a path
 * segment ending in one is never a live link.
 */
export const UNSAFE_EXTENSIONS = Object.freeze(UNSAFE_LINK_EXTENSIONS.map((ext) => ext.slice(1)));

/** Attributes `el` never sets, whatever it is given. */
const NEVER = new Set(['style', 'srcdoc', 'src', 'srcset', 'action', 'formaction', 'background', 'poster',
  'ping', 'xlink:href', 'manifest', 'codebase', 'data']);

/** Boolean attributes that are also DOM properties. */
const BOOLEAN_PROPS = new Set(['checked', 'selected', 'disabled', 'hidden', 'open', 'readonly', 'required',
  'multiple']);

/** @type {any} */
let current = null;

/**
 * Render into this document instead of `globalThis.document` (tests pass a fake one).
 * @param {any} doc
 * @returns {void}
 */
export function useDocument(doc) {
  current = doc ?? null;
}

/** @returns {any} */
function doc() {
  const d = current ?? /** @type {any} */ (globalThis).document;
  if (!d) throw new Error('There is no document to render into');
  return d;
}

/**
 * A text node.
 * @param {unknown} s
 * @returns {any}
 */
export function text(s) {
  return doc().createTextNode(s === null || s === undefined ? '' : String(s));
}

/**
 * Whether a URL may be a live link (§10.8), by `safeLinkUrl`: `https:`, a host, no credentials, not
 * a download host or link shortener, and no path segment naming an archive or executable.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isSafeUrl(url) {
  return safeLinkUrl(url) !== null;
}

/**
 * The `href` `el` will set: an internal route (`#/…`) or a safe URL; null for anything else.
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeHref(value) {
  const s = String(value ?? '').trim();
  if (/^#\/[^\s"'<>`]*$/.test(s)) return s;
  return isSafeUrl(s) ? s : null;
}

/**
 * @param {string} s
 * @returns {string}
 */
function kebab(s) {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * @param {any} node
 * @param {string} key
 * @param {unknown} value
 */
function setAttr(node, key, value) {
  if (value === undefined || value === null || value === false) return;
  const k = key.toLowerCase();
  if (k === 'class' || k === 'classname') {
    const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value);
    if (cls) node.className = cls;
    return;
  }
  if (k === 'text') {
    node.textContent = String(value);
    return;
  }
  if (k === 'dataset') {
    if (value && typeof value === 'object') {
      for (const [dk, dv] of Object.entries(value)) {
        if (dv === null || dv === undefined || !/^[a-z][a-zA-Z0-9]*$/.test(dk)) continue;
        node.setAttribute(`data-${kebab(dk)}`, String(dv));
      }
    }
    return;
  }
  if (k.startsWith('on')) {
    if (typeof value === 'function') node.addEventListener(k.slice(2), value);
    return;
  }
  if (NEVER.has(k) || !/^[a-z][a-z0-9-]*$/.test(k)) return;
  if (k === 'href') {
    const safe = safeHref(value);
    if (safe) node.setAttribute('href', safe);
    return;
  }
  if (k === 'value') {
    node.value = String(value);
    return;
  }
  if (BOOLEAN_PROPS.has(k)) {
    if (value) {
      node.setAttribute(k, '');
      if (k === 'checked' || k === 'selected') node[k] = true;
    }
    return;
  }
  node.setAttribute(k, value === true ? '' : String(value));
}

/**
 * @typedef {any} Child a node, a string or number (text), an array of children, or nothing
 */

/**
 * Append children: strings and numbers become text nodes; arrays are flattened; null, undefined
 * and booleans are skipped.
 * @param {any} node
 * @param {Child} children
 * @returns {any} the node
 */
export function append(node, children) {
  if (children === null || children === undefined || typeof children === 'boolean') return node;
  if (Array.isArray(children)) {
    for (const c of children) append(node, c);
    return node;
  }
  if (typeof children === 'string' || typeof children === 'number') {
    node.appendChild(text(children));
    return node;
  }
  if (typeof children === 'object' && typeof children.nodeType === 'number') node.appendChild(children);
  return node;
}

/**
 * Create an element. `attrs` may hold `class` (a string or a list), `text`, `dataset`, event
 * handlers (`onclick: fn`), `href` (only safe URLs and internal routes survive), `value`, boolean
 * attributes and any other plain attribute. Style, source and script-bearing attributes are
 * dropped, and string handlers are never set.
 * @param {string} tag
 * @param {Record<string, unknown> | null} [attrs]
 * @param {Child} [children]
 * @returns {any}
 */
export function el(tag, attrs = null, children = null) {
  const node = doc().createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) setAttr(node, key, value);
  return append(node, children);
}

/**
 * A document fragment holding `children`.
 * @param {Child} children
 * @returns {any}
 */
export function frag(children) {
  return append(doc().createDocumentFragment(), children);
}

/**
 * Remove every child of `node` and append `children` instead.
 * @param {any} node
 * @param {Child} [children]
 * @returns {any} the node
 */
export function replace(node, children = null) {
  if (typeof node.replaceChildren === 'function') node.replaceChildren();
  else while (node.firstChild) node.removeChild(node.firstChild);
  return append(node, children);
}

/**
 * A link that is safe to show (§10.8). A safe URL becomes an `<a>` with
 * `rel="noopener noreferrer nofollow"` and `target="_blank"`, followed by its full URL when the
 * label differs; any other URL — or any URL of a quarantined repository — is plain text.
 * @param {unknown} url
 * @param {unknown} [label]
 * @param {{quarantined?: boolean}} [opts]
 * @returns {any}
 */
export function safeLink(url, label, { quarantined = false } = {}) {
  const u = String(url ?? '').trim();
  const l = label === null || label === undefined || String(label).trim() === '' ? u : String(label);
  const differs = l !== u;
  if (!quarantined && isSafeUrl(u)) {
    return el('span', { class: 'link' }, [
      el('a', { href: u, rel: 'noopener noreferrer nofollow', target: '_blank' }, l),
      differs ? el('span', { class: 'link-url' }, ` (${u})`) : null,
    ]);
  }
  return el('span', { class: 'link link-inert', title: 'Shown as text: not a safe link' },
    differs && u ? `${l} (${u})` : l);
}

/**
 * @param {unknown} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clampInt(n, lo, hi) {
  const x = Number.isFinite(Number(n)) ? Math.round(Number(n)) : lo;
  return Math.min(hi, Math.max(lo, x));
}

/**
 * @typedef {{quarantined?: boolean, headingOffset?: number}} BlockOptions
 */

/**
 * One inline run: text, inline code, a link `{text, url}`, or an image (shown as `[image: alt]`).
 * @param {unknown} run
 * @param {BlockOptions} opts
 * @returns {any}
 */
function renderRun(run, opts) {
  if (typeof run === 'string' || typeof run === 'number') return text(run);
  if (!run || typeof run !== 'object') return null;
  const r = /** @type {Record<string, any>} */ (run);
  if (r.type === 'image') return text(`[image: ${String(r.alt ?? r.text ?? '')}]`);
  if (typeof r.url === 'string' || typeof r.href === 'string' || r.type === 'link') {
    return safeLink(r.url ?? r.href ?? '', r.text ?? r.label, { quarantined: opts.quarantined });
  }
  if (r.type === 'code') return el('code', null, String(r.text ?? r.value ?? ''));
  const t = String(r.text ?? r.value ?? '');
  if (r.type === 'strong' || r.type === 'bold') return el('strong', null, t);
  if (r.type === 'em' || r.type === 'emphasis') return el('em', null, t);
  return text(t);
}

/**
 * @param {Record<string, any>} b
 * @param {BlockOptions} opts
 * @returns {any[]}
 */
function runsOf(b, opts) {
  const runs = b.runs ?? b.inline ?? b.children ?? b.content;
  if (Array.isArray(runs)) return runs.map((r) => renderRun(r, opts));
  if (typeof b.text === 'string') return [text(b.text)];
  return [];
}

/**
 * @param {unknown} item
 * @param {BlockOptions} opts
 * @returns {any}
 */
function listItem(item, opts) {
  if (Array.isArray(item)) return item.map((r) => renderRun(r, opts));
  if (typeof item === 'string') return text(item);
  if (!item || typeof item !== 'object') return null;
  const it = /** @type {Record<string, any>} */ (item);
  if (Array.isArray(it.blocks)) return it.blocks.map((b) => renderBlock(b, opts));
  return runsOf(it, opts);
}

/**
 * @param {unknown} block
 * @param {BlockOptions} opts
 * @returns {any}
 */
function renderBlock(block, opts) {
  if (typeof block === 'string') return el('p', null, block);
  if (!block || typeof block !== 'object') return null;
  const b = /** @type {Record<string, any>} */ (block);
  switch (b.type ?? b.kind) {
    case 'heading': {
      const level = clampInt(Number(b.level ?? b.depth ?? 1) + (opts.headingOffset ?? 2), 2, 6);
      return el(`h${level}`, { class: 'readme-h' }, runsOf(b, opts));
    }
    case 'paragraph':
      return el('p', null, runsOf(b, opts));
    case 'code':
      return el('pre', { class: 'code' }, el('code', null, String(b.text ?? b.code ?? b.value ?? '')));
    case 'list': {
      const items = Array.isArray(b.items) ? b.items : [];
      return el(b.ordered ? 'ol' : 'ul', null, items.map((it) => el('li', null, listItem(it, opts))));
    }
    case 'quote':
      return el('blockquote', null, Array.isArray(b.blocks)
        ? b.blocks.map((x) => renderBlock(x, opts)) : runsOf(b, opts));
    case 'rule':
      return el('hr');
    default: {
      const runs = runsOf(b, opts);
      return runs.length > 0 ? el('p', null, runs) : null;
    }
  }
}

/**
 * Render README blocks from `toSafeBlocks` (§10.8): headings (shifted down so they sit under the
 * page's own headings), paragraphs, code, lists, quotes and rules, with inline text, code and
 * links. Raw HTML inside the text stays literal text.
 * @param {readonly unknown[]} blocks
 * @param {BlockOptions & {maxBlocks?: number}} [opts]
 * @returns {any}
 */
export function renderBlocks(blocks, opts = {}) {
  const max = opts.maxBlocks ?? 600;
  const list = Array.isArray(blocks) ? blocks : [];
  const root = el('div', { class: 'readme' });
  for (const b of list.slice(0, max)) append(root, renderBlock(b, opts));
  if (list.length > max) {
    root.appendChild(el('p', { class: 'muted' }, `${list.length - max} more blocks not shown`));
  }
  return root;
}

/**
 * A README as plain preformatted text, for when the block renderer is not available.
 * @param {unknown} markdown
 * @returns {any}
 */
export function plainText(markdown) {
  return el('pre', { class: 'readme-plain' }, String(markdown ?? ''));
}

/**
 * Offer a JSON file for download (the Pages feedback export, §10.5). The object URL is made
 * here from our own data, never from repository text.
 * @param {string} filename
 * @param {unknown} value
 * @returns {void}
 */
export function downloadJson(filename, value) {
  const g = /** @type {any} */ (globalThis);
  const blob = new g.Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' });
  const url = g.URL.createObjectURL(blob);
  const a = doc().createElement('a');
  a.setAttribute('href', url);
  a.setAttribute('download', filename.replace(/[^\w.-]/g, '_'));
  doc().body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => g.URL.revokeObjectURL(url), 1000);
}
