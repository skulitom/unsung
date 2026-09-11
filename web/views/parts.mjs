// @ts-check
/**
 * Pieces the explorer's views share (DESIGN §10.2, §10.9): the Quality meter, the Confidence pill,
 * the muted Attention strip, badges, chips, reason lines, a sparkline, triage buttons and small
 * formatters. Every node is built with render.mjs; repository text only ever enters as text.
 */

import { el } from '../render.mjs';

/** @typedef {import('../../src/core/schema.mjs').IndexEntry} IndexEntry */
/** @typedef {(action: Record<string, any>) => void} Dispatch */

/** Lane names as the UI says them (§6.7). */
export const LANE_LABELS = Object.freeze({
  promising: 'Promising', proven: 'Proven', look: 'Worth a look', doubted: 'Doubted',
  institutional: 'Institutional', rising: 'Rising', graduated: 'Graduated', quarantine: 'Quarantine',
  gone: 'Gone', low: 'Low',
});

/** Descriptor chips (§5.6): neutral facts, never points. */
export const DESCRIPTORS = Object.freeze({
  'd.agent': ['Agent-assisted', 'Has agent instruction files such as CLAUDE.md or AGENTS.md; neutral'],
  'd.squashed': ['Squashed history', 'Three commits or fewer; never penalised'],
  'd.script': ['Non-Latin README', 'The README prose is mostly in a non-Latin script'],
  'd.demo': ['Has a demo', 'A homepage or demo link is set'],
  'd.imported': ['Imported history', 'Its commits predate the repository by more than 30 days'],
  'd.sprawl': ['Sprawling', 'At least 200 commits and 2,000 files'],
  'd.funding': ['Seeks funding', 'Has a funding file or a Sponsors listing'],
});

/** The eight categories of the labelling guide (§1.2). */
export const CATEGORIES = Object.freeze({
  G: ['Genuine', 'Does a non-trivial job for someone other than its author; its own working code; '
    + 'claims backed by artefacts a reader can check; safe to open'],
  W: ['Work in progress', 'Same intent as genuine, not yet usable'],
  C: ['Coursework or clone', 'Follows a course or tutorial, re-uploads or re-skins another project, '
    + 'or exists to be shown to employers'],
  P: ['Personal', 'Dotfiles, notes, a profile README or a personal website'],
  S: ['AI scaffold', 'Prose, persona or skill packs, prompt-ware or scaffolding far outweighing '
    + 'working code'],
  D: ['Data dump', 'Mostly data, generated files, or a copy of something else'],
  X: ['Spam or malware', 'Lures, drainers, gambling SEO, streak farms, ad farms'],
  E: ['Near-empty', 'Too little to judge'],
});

/** "Not good" reasons in key order, with the label each implies (§10.3). */
export const REASONS = Object.freeze([
  { reason: 'slop', key: '1', label: 'Slop or scaffold', code: 'S' },
  { reason: 'clone', key: '2', label: 'Tutorial, clone or coursework', code: 'C' },
  { reason: 'personal', key: '3', label: 'Personal or site', code: 'P' },
  { reason: 'spam', key: '4', label: 'Spam or malware', code: 'X' },
  { reason: 'dump', key: '5', label: 'Data dump', code: 'D' },
  { reason: 'empty', key: '6', label: 'Near-empty', code: 'E' },
]);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

/**
 * @param {unknown} x
 * @returns {number | null}
 */
export function numOrNull(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/**
 * A whole number with thousands separators: `3,301`.
 * @param {unknown} n
 * @returns {string}
 */
export function count(n) {
  const v = numOrNull(n);
  if (v === null) return '—';
  return String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * A signed number with a true minus sign: `+1`, `−2`, `0`.
 * @param {unknown} n
 * @param {number} [digits]
 * @returns {string}
 */
export function signed(n, digits = 0) {
  const v = Number(n) || 0;
  const s = Math.abs(v).toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits);
  return `${v > 0 ? '+' : '−'}${s}`;
}

/**
 * Quality as the UI shows it: `round(100 · Q)` (§6.2).
 * @param {unknown} q
 * @returns {string}
 */
export function pct(q) {
  const v = numOrNull(q);
  return v === null ? '—' : String(Math.round(100 * v));
}

/**
 * `7 Sep 2026` (UTC), optionally with the time.
 * @param {unknown} iso
 * @param {{year?: boolean, time?: boolean}} [opts]
 * @returns {string}
 */
export function formatDate(iso, { year = true, time = false } = {}) {
  const t = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ''}`;
  if (!time) return day;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${day}, ${hh}:${mm} UTC`;
}

/**
 * A compact age: `today`, `3 d`, `5 wk`, `8 mo`, `2 yr`.
 * @param {unknown} days
 * @returns {string}
 */
export function ageText(days) {
  const d = numOrNull(days);
  if (d === null || d < 0) return '—';
  if (d < 1) return 'today';
  if (d < 14) return `${Math.floor(d)} d`;
  if (d < 60) return `${Math.floor(d / 7)} wk`;
  if (d < 730) return `${Math.floor(d / 30.44)} mo`;
  return `${Math.floor(d / 365.25)} yr`;
}

/**
 * How long ago: `just now`, `5 h ago`, `yesterday`, `3 days ago`, else the date.
 * @param {unknown} iso
 * @param {string} now
 * @returns {string}
 */
export function relTime(iso, now) {
  const t = Date.parse(String(iso ?? ''));
  const n = Date.parse(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return '—';
  const h = (n - t) / 3_600_000;
  if (h < 1) return 'just now';
  if (h < 24) return `${Math.floor(h)} h ago`;
  const days = Math.floor(h / 24);
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return formatDate(iso);
}

/**
 * Days from `iso` to `now`.
 * @param {unknown} iso
 * @param {string} now
 * @returns {number | null}
 */
export function daysSince(iso, now) {
  const t = Date.parse(String(iso ?? ''));
  const n = Date.parse(now);
  return Number.isFinite(t) && Number.isFinite(n) ? (n - t) / DAY_MS : null;
}

/**
 * The internal route of a repository's detail pane.
 * @param {string} nwo
 * @returns {string}
 */
export function repoHref(nwo) {
  const [owner, name] = String(nwo).split('/');
  return `#/r/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}`;
}

/**
 * `owner/` muted, `name` bold; a link to the detail pane unless `link` is false. `href` replaces the
 * bare route, so a card can keep its shelf and filters in the link (`#/r/o/n?shelf=look&lang=Go`).
 * @param {string} nwo
 * @param {{link?: boolean, href?: string | null}} [opts]
 * @returns {any}
 */
export function repoName(nwo, { link = true, href = null } = {}) {
  const [owner, name] = String(nwo).split('/');
  const parts = [el('span', { class: 'owner' }, `${owner}/`), el('span', { class: 'name' }, name ?? '')];
  if (!link) return el('span', { class: 'repo' }, parts);
  return el('a', { class: 'repo', href: href ?? repoHref(nwo) }, parts);
}

/**
 * @param {string} key
 * @returns {any}
 */
export function kbd(key) {
  return el('kbd', null, key);
}

/**
 * A lane badge.
 * @param {string} lane
 * @returns {any}
 */
export function laneBadge(lane) {
  const label = /** @type {Record<string, string>} */ (LANE_LABELS)[lane] ?? lane;
  return el('span', { class: ['badge', `lane-${lane}`] }, label);
}

/**
 * The Quality meter: one segment per available point, `S` of them lit, then `S/max · Q`. A score
 * with coverage below 0.8 is hatched and says "incomplete evidence" (§6.1).
 * @param {Partial<IndexEntry>} entry
 * @param {{large?: boolean}} [opts]
 * @returns {any}
 */
export function qualityMeter(entry, { large = false } = {}) {
  const S = numOrNull(entry.S) ?? 0;
  const max = Math.max(1, Math.min(20, numOrNull(entry.pointsMax) ?? 13));
  const coverage = numOrNull(entry.coverage);
  const incomplete = coverage !== null && coverage < 0.8;
  const lit = Math.max(0, Math.min(max, Math.round(S)));
  const segments = Array.from({ length: max },
    (_, i) => el('span', { class: ['seg', i < lit ? 'on' : null] }));
  const title = `Quality: ${S} of ${max} points; about ${pct(entry.quality)} in 100 repositories `
    + `with this many points were genuine${incomplete ? '; incomplete evidence' : ''}`;
  const cls = ['meter', 'meter-q', large ? 'large' : null, incomplete ? 'hatched' : null];
  return el('span', { class: cls, title }, [
    el('span', { class: 'meter-name' }, 'Quality'),
    el('span', { class: 'bar', 'aria-hidden': 'true' }, segments),
    el('span', { class: 'meter-value' }, [el('b', null, String(S)), `/${max} · Q ${pct(entry.quality)}`]),
    incomplete ? el('span', { class: 'sr-only' }, ' (incomplete evidence)') : null,
  ]);
}

/**
 * The Confidence pill: its band and `K` (§6.4).
 * @param {Partial<IndexEntry>} entry
 * @returns {any}
 */
export function confidencePill(entry) {
  const k = numOrNull(entry.k);
  const band = entry.kBand ?? (k === null ? 'low' : k >= 0.6 ? 'high' : k >= 0.3 ? 'medium' : 'low');
  const title = 'Confidence: corroboration that is costly to fake — server-stamped time, releases '
    + 'across weeks, established outsiders, a verified test run';
  return el('span', { class: ['pill', 'conf', `conf-${band}`], title }, [
    el('span', { class: 'meter-name' }, 'Confidence'), ` ${band}`, k === null ? null : ` ${k.toFixed(2)}`,
  ]);
}

/**
 * A tiny bar chart of weekly star gains, oldest to newest (quantised heights, no inline style).
 * @param {readonly number[] | null | undefined} values
 * @returns {any}
 */
export function sparkline(values) {
  const list = Array.isArray(values) ? values.map((v) => Math.max(0, Number(v) || 0)) : [];
  if (list.length === 0) return null;
  const max = Math.max(1, ...list);
  const label = `Stars gained per week: ${list.join(', ')}`;
  return el('span', { class: 'spark', role: 'img', 'aria-label': label },
    list.map((v) => el('span', { class: ['b', `h${Math.round((v / max) * 7)}`] })));
}

/**
 * The muted Attention strip: stars, forks, the four-week gain and its sparkline (§5.5).
 * @param {Partial<IndexEntry>} entry
 * @returns {any}
 */
export function attentionStrip(entry) {
  const stars = numOrNull(entry.stars) ?? 0;
  const forks = numOrNull(entry.forks) ?? 0;
  const gain = numOrNull(entry.gain4w);
  return el('span', { class: 'attention', title: 'Attention: shown, never counted toward quality' }, [
    `${count(stars)} ${stars === 1 ? 'star' : 'stars'} · ${count(forks)} ${forks === 1 ? 'fork' : 'forks'}`,
    gain !== null && gain > 0 ? ` · +${count(gain)} in 4 wk` : null,
    sparkline(entry.spark),
  ]);
}

/**
 * Descriptor chips (§5.6).
 * @param {readonly string[] | null | undefined} ids
 * @returns {any}
 */
export function descriptorChips(ids) {
  const list = Array.isArray(ids) ? ids : [];
  if (list.length === 0) return null;
  return el('span', { class: 'chips' }, list.map((id) => {
    const d = /** @type {Record<string, string[]>} */ (DESCRIPTORS)[id];
    return el('span', { class: 'chip descriptor', title: d ? d[1] : id }, d ? d[0] : id);
  }));
}

/**
 * Up to three reason lines and two penalty lines (§6.8 `top`, `negatives`).
 * @param {Partial<IndexEntry>} entry
 * @returns {any}
 */
export function reasonList(entry) {
  const top = (Array.isArray(entry.top) ? entry.top : []).slice(0, 3);
  const neg = (Array.isArray(entry.negatives) ? entry.negatives : []).slice(0, 2);
  if (top.length === 0 && neg.length === 0) return null;
  return el('ul', { class: 'reasons' }, [
    ...top.map((t) => el('li', { class: 'plus' }, t)),
    ...neg.map((t) => el('li', { class: 'minus' }, t)),
  ]);
}

/**
 * A chip's state for display: `hit`, `miss`, `unknown` or `na`.
 * @param {{status?: string, hit?: boolean | null}} chip
 * @returns {'hit' | 'miss' | 'unknown' | 'na'}
 */
export function chipState(chip) {
  if (chip.status === 'ok') return chip.hit ? 'hit' : 'miss';
  if (chip.status === 'hit' || chip.status === 'miss' || chip.status === 'na') return chip.status;
  return 'unknown';
}

/**
 * @typedef {object} ButtonOptions
 * @property {string} [key] shown first, as a key cap
 * @property {Function | null} [onClick]
 * @property {string | (string | null)[]} [cls]
 * @property {string} [title]
 * @property {boolean | null} [pressed] sets aria-pressed
 * @property {boolean | null} [expanded] sets aria-expanded
 * @property {boolean} [disabled]
 */

/**
 * A button with its key shown first.
 * @param {string} label
 * @param {ButtonOptions} [opts]
 * @returns {any}
 */
export function button(label, opts = {}) {
  const title = opts.title ?? (opts.key ? `${label} (${opts.key})` : null);
  return el('button', {
    type: 'button', class: opts.cls ?? null, title,
    'aria-pressed': opts.pressed === undefined || opts.pressed === null ? null : String(opts.pressed),
    'aria-expanded': opts.expanded === undefined || opts.expanded === null ? null : String(opts.expanded),
    disabled: opts.disabled === true,
    onclick: opts.onClick ?? null,
  }, [opts.key ? kbd(opts.key) : null, opts.key ? ' ' : null, label]);
}

/**
 * The triage buttons of a card or the detail pane (§10.3), for mouse and touch; the keys do the same.
 * Publish shows on a saved gem; Unpublish on anything still published, saved or not (a published
 * pick that was undone or rejected can always be taken down).
 * @param {Partial<IndexEntry> & {id: string}} entry
 * @param {Dispatch} dispatch
 * @param {{reasonMenu?: boolean, saved?: boolean, published?: boolean}} [opts]
 * @returns {any}
 */
export function triageBar(entry, dispatch, { reasonMenu = false, saved = false, published = false } = {}) {
  /**
   * @param {string} action
   * @param {string} label
   * @param {string} key
   */
  const act = (action, label, key) => button(label, {
    key, cls: ['act', `act-${action}`], onClick: () => dispatch({ type: 'decide', action, id: entry.id }),
  });
  const reasons = reasonMenu
    ? el('div', { class: 'reason-menu', role: 'group', 'aria-label': 'Why is it not good?' },
      REASONS.map((r) => button(r.label, {
        key: r.key, cls: 'reason', title: `${r.label} (label ${r.code})`,
        onClick: () => dispatch({ type: 'decide', action: 'notgood', reason: r.reason, id: entry.id }),
      })))
    : null;
  return el('div', { class: 'actions', role: 'group', 'aria-label': 'Triage' }, [
    act('gem', 'Gem', 'g'),
    act('wip', 'Work in progress', 'w'),
    act('notmine', 'Not my thing', 'n'),
    button('Not good', {
      key: 'x', cls: ['act', 'act-notgood'], expanded: reasonMenu,
      onClick: () => dispatch({ type: 'reasonMenu', id: entry.id }),
    }),
    act('snooze', 'Snooze', 'z'),
    saved || published ? button(published ? 'Unpublish' : 'Publish', {
      key: 'p', cls: ['act', 'act-publish'], onClick: () => dispatch({ type: 'publish', id: entry.id }),
    }) : null,
    reasons,
  ]);
}

/**
 * The eight label buttons of Calibrate and "help calibrate" (§10.7).
 * @param {(label: string) => void} onLabel
 * @param {{chosen?: string | null}} [opts]
 * @returns {any}
 */
export function labelButtons(onLabel, { chosen = null } = {}) {
  return el('div', { class: 'labels', role: 'group', 'aria-label': 'Label' },
    Object.entries(CATEGORIES).map(([code, [name, test]]) => button(name, {
      key: code.toLowerCase(), cls: ['label-btn', `label-${code}`, chosen === code ? 'chosen' : null],
      title: `${code}: ${test}`, pressed: chosen === null ? null : chosen === code,
      onClick: () => onLabel(code),
    })));
}
