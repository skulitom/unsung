// @ts-check
/**
 * What the explorer shows, as pure functions (DESIGN §6.7, §10.2–§10.7): shelves, facet filters and
 * their live counts, the URL-hash view state, how feedback folds into each entry's queue state, and
 * the triage reducer (queue position and undo stack). The server, the CLI and the browser share
 * this module. Pure: time and randomness are parameters.
 */

import { fileHosts, unsafeLinkExtensions } from './lexicons.mjs';
import { labelFromFeedback, validateFeedback } from './schema.mjs';
import { activeFeedback, compareEntries, forYou } from './taste.mjs';

export { compareEntries } from './taste.mjs';

// ---------------------------------------------------------------------------------------------
// Links (§7.6, §10.8): the one rule the explorer, the gallery, the digest and `readme.mjs` share
// ---------------------------------------------------------------------------------------------

/**
 * Extensions of archives, installers, packages and scripts (§7.2, §10.8), multi-part ones included:
 * a link with a path segment ending in one of them is never live. `lexicons.unsafeLinkExtensions`,
 * the union of the lists the explorer, the gallery and `lexicons.archiveExtensions` used to keep
 * separately.
 */
export const UNSAFE_LINK_EXTENSIONS = unsafeLinkExtensions;

/** Longest URL that may become a link. */
const LINK_MAX = 2048;

/**
 * @param {string} segment one decoded, lower-case path segment
 * @returns {boolean} whether it names an archive or executable
 */
function unsafeSegment(segment) {
  const whole = segment.replace(/[\s.\0]+$/, '');
  const head = segment.replace(/[;\0][\s\S]*$/, '').replace(/[\s.]+$/, '');
  return [whole, head].some((s) => s !== '' && UNSAFE_LINK_EXTENSIONS.some((ext) => s.endsWith(ext)));
}

/**
 * The URL an anchor may point at, or null when it must stay text (§7.6, §10.8): `https:` only, with
 * a host and no credentials, at most 2,048 characters; not on a download host or link shortener
 * (`lexicons.fileHosts`, subdomains and `www.` included); and no path segment — decoded, cut at a
 * `;` or NUL, and stripped of trailing dots, spaces and NULs — ending in an archive or executable
 * extension, so `/Setup.zip/file`, `/tool.exe/`, `/tool.exe.` and `/tool.exe%00` stay text. Query
 * strings are not read. A path that does not decode fails closed.
 * @param {unknown} url
 * @returns {string | null} the URL as the URL parser normalises it
 */
export function safeLinkUrl(url) {
  if (typeof url !== 'string') return null;
  const s = url.trim();
  if (s === '' || s.length > LINK_MAX) return null;
  /** @type {URL} */
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  if (fileHosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  /** @type {string} */
  let path;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  if (path.toLowerCase().split('/').some(unsafeSegment)) return null;
  return u.href;
}

/** @typedef {import('./schema.mjs').Index} Index */
/** @typedef {import('./schema.mjs').IndexEntry} IndexEntry */
/** @typedef {import('./schema.mjs').Feedback} Feedback */
/** @typedef {import('./schema.mjs').FeedbackAction} FeedbackAction */
/** @typedef {import('./schema.mjs').TasteState} TasteState */
/** @typedef {import('./schema.mjs').RepoRecord} RepoRecord */
/** @typedef {import('./schema.mjs').Facts} Facts */

/**
 * @typedef {object} Filters
 * @property {string} q free text over name, description, topics and language
 * @property {string[]} lang languages (any of)
 * @property {7 | 30 | 90 | null} age at most this many days old
 * @property {0 | 5 | 25 | null} stars at most this many stars
 * @property {('release' | 'tests' | 'ci' | 'demo')[]} evidence all of
 * @property {string[]} script README scripts (any of)
 * @property {boolean | null} agent true: agent-assisted only; false: never; null: either
 * @property {boolean} hidden show snoozed and dismissed entries too
 */

/**
 * @typedef {object} ViewState
 * @property {'shelf' | 'repo' | 'calibrate' | 'taste' | 'status'} screen
 * @property {string} shelf the shelf the queue shows
 * @property {string | null} nwo the repository in the detail pane (`#/r/<owner>/<name>`)
 * @property {Filters} filters
 */

/**
 * An entry's queue state after its feedback (§4.3 `IndexEntry.feedback`).
 * @typedef {object} EntryFeedback
 * @property {{action: string, label: string | null, reason: string | null, at: string} | null} last
 *   the latest standing triage decision (gem, wip, notgood, notmine or snooze)
 * @property {boolean} published
 * @property {string | null} snoozeUntil
 */

/**
 * @typedef {object} UndoItem
 * @property {Feedback} event the decision
 * @property {EntryFeedback | null} prev the entry's queue state before it
 * @property {number} index where the entry sat in the queue
 * @property {boolean} removed whether the decision took it out of the queue
 */

/**
 * @typedef {object} TriageState
 * @property {string[]} ids the queue, as entry ids in display order
 * @property {number} pos cursor into `ids`; −1 when the queue is empty
 * @property {UndoItem[]} undo decisions that can be undone, newest last (at most `UNDO_LIMIT`)
 * @property {number} decisions triage decisions this session (for "help calibrate", §10.6)
 * @property {Record<string, EntryFeedback>} feedback queue state of every entry decided this session
 */

/**
 * @typedef {{type: 'load', ids: string[]} | {type: 'next'} | {type: 'prev'} | {type: 'first'}
 *   | {type: 'last'} | {type: 'select', id?: string, index?: number}
 *   | {type: 'decide', event: Feedback, prev?: EntryFeedback | null}
 *   | {type: 'undo', event?: Feedback | null}} TriageAction
 */

/** Shelves of the top bar, in order (§10.2). */
export const SHELVES = Object.freeze([
  { name: 'promising', label: 'Promising', lanes: ['promising'] },
  { name: 'proven', label: 'Proven', lanes: ['proven'] },
  { name: 'look', label: 'Worth a look', lanes: ['look'] },
  { name: 'foryou', label: 'For you', lanes: ['proven', 'promising', 'look'] },
  { name: 'saved', label: 'Saved', lanes: null },
  { name: 'doubted', label: 'Doubted', lanes: ['doubted'] },
  { name: 'institutional', label: 'Institutional', lanes: ['institutional'] },
  { name: 'rising', label: 'Rising', lanes: ['rising'] },
  { name: 'graduated', label: 'Graduated', lanes: ['graduated'] },
  { name: 'quarantine', label: 'Quarantine', lanes: ['quarantine'] },
]);

/** Shelf names, in top-bar order. */
export const SHELF_NAMES = Object.freeze(SHELVES.map((s) => s.name));

/** The shelf shown when the URL names none. */
export const DEFAULT_SHELF = 'promising';

/** Screens that are not shelves (§10.2). */
export const SCREENS = Object.freeze(['calibrate', 'taste', 'status']);

/** Evidence facets (§10.2), in display order. */
export const EVIDENCE = Object.freeze(['release', 'tests', 'ci', 'demo']);

/** Age facet steps in days, and star facet steps (§10.2). */
export const AGE_STEPS = Object.freeze([7, 30, 90]);
export const STAR_STEPS = Object.freeze([0, 5, 25]);

/** `wip` and `snooze` hide an entry for this many days (§10.3). */
export const SNOOZE_DAYS = 30;

/** A "help calibrate" card appears after every this many triage decisions (§10.6). */
export const HELP_EVERY = 20;

/** The uncertain band of Quality that "help calibrate" draws from (§10.6). */
export const UNCERTAIN = Object.freeze({ lo: 0.35, hi: 0.65 });

/** Decisions that count as triage (§10.4). */
export const TRIAGE_ACTIONS = Object.freeze(['gem', 'wip', 'notgood', 'notmine', 'snooze']);

/** Decisions that take an entry out of the queue (§10.4). */
export const LEAVES_QUEUE = TRIAGE_ACTIONS;

/** Latest standing actions that keep an entry out of the queue for good. */
const DISMISSED = Object.freeze(['gem', 'notgood', 'notmine']);

/** How many decisions `u` can walk back. */
export const UNDO_LIMIT = 50;

/** Longest note a feedback event carries (§4.1), in characters. */
export const NOTE_MAX = 280;

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/**
 * @param {unknown} x
 * @returns {number | null}
 */
function numOrNull(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : null;
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function byText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Whether a string is a GitHub `owner/name`.
 * @param {unknown} nwo
 * @returns {boolean}
 */
export function isNwo(nwo) {
  if (typeof nwo !== 'string' || nwo.length > 140) return false;
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(nwo);
  return m !== null && m[2] !== '.' && m[2] !== '..';
}

/**
 * ISO time `days` after `iso`.
 * @param {string} iso
 * @param {number} days
 * @returns {string}
 */
export function plusDays(iso, days) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) throw new RangeError(`Not a valid time: ${String(iso).slice(0, 40)}`);
  return new Date(t + days * DAY_MS).toISOString();
}

/**
 * The action of an entry's latest standing decision, whatever shape `feedback.last` has.
 * @param {Partial<EntryFeedback> | null | undefined} fb
 * @returns {string | null}
 */
export function lastAction(fb) {
  const last = fb?.last;
  if (typeof last === 'string') return last;
  if (last && typeof last === 'object' && typeof last.action === 'string') return last.action;
  return null;
}

/**
 * Whether an entry has left the queue (§10.4): saved as a gem, judged not good, not my thing, or
 * snoozed until a time still in the future.
 * @param {Partial<IndexEntry>} entry
 * @param {string} now ISO time
 * @returns {boolean}
 */
export function isHidden(entry, now) {
  const fb = /** @type {Partial<EntryFeedback> | undefined} */ (entry.feedback);
  const action = lastAction(fb);
  if (action && DISMISSED.includes(action)) return true;
  const until = typeof fb?.snoozeUntil === 'string' ? Date.parse(fb.snoozeUntil) : NaN;
  return Number.isFinite(until) && until > Date.parse(now);
}

/**
 * Whether a scoring chip is hit.
 * @param {Partial<IndexEntry>} entry
 * @param {string} id
 * @returns {boolean}
 */
function chipHit(entry, id) {
  return Array.isArray(entry.chips)
    && entry.chips.some((c) => c.id === id && c.status === 'ok' && c.hit === true);
}

/**
 * Whether an entry shows a kind of evidence (§10.2): `release` (a release, or shipped over time),
 * `tests` (tests, or CI running them), `ci` (CI verified: the tests run green) or `demo`.
 * @param {Partial<IndexEntry>} entry
 * @param {string} kind
 * @returns {boolean}
 */
export function hasEvidence(entry, kind) {
  switch (kind) {
    case 'release': return chipHit(entry, 'q.release') || chipHit(entry, 'p.shipped');
    case 'tests': return chipHit(entry, 'q.tests') || chipHit(entry, 'p.testsRun');
    case 'ci': return chipHit(entry, 'p.testsRun');
    case 'demo': return Array.isArray(entry.descriptors) && entry.descriptors.includes('d.demo');
    default: return false;
  }
}

/**
 * Language facet value of an entry.
 * @param {Partial<IndexEntry>} entry
 * @returns {string}
 */
export function langKey(entry) {
  return typeof entry.lang === 'string' && entry.lang ? entry.lang : 'none';
}

/**
 * README script facet value of an entry (`latin`, `cjk`, …), from its `script:` facet.
 * @param {Partial<IndexEntry>} entry
 * @returns {string}
 */
export function scriptKey(entry) {
  const facets = Array.isArray(entry.facets) ? entry.facets : [];
  const f = facets.find((x) => String(x).startsWith('script:'));
  return f ? String(f).slice('script:'.length) : 'unknown';
}

/**
 * @param {Partial<IndexEntry>} entry
 * @returns {boolean}
 */
function isAgent(entry) {
  return Array.isArray(entry.descriptors) && entry.descriptors.includes('d.agent');
}

/**
 * @param {Partial<IndexEntry>} entry
 * @param {number} days
 * @returns {boolean}
 */
function withinAge(entry, days) {
  return typeof entry.ageDays === 'number' && entry.ageDays <= days;
}

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

/** @returns {Filters} filters that let everything through */
export function emptyFilters() {
  return { q: '', lang: [], age: null, stars: null, evidence: [], script: [], agent: null, hidden: false };
}

/**
 * @param {unknown} list
 * @param {number} [max]
 * @returns {string[]}
 */
function stringList(list, max = 60) {
  if (!Array.isArray(list)) return [];
  /** @type {string[]} */
  const out = [];
  for (const v of list) {
    const s = String(v ?? '').trim();
    if (s && s.length <= max && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Fill in and clean a partial filter object.
 * @param {Partial<Filters> | null | undefined} f
 * @returns {Filters}
 */
export function normaliseFilters(f) {
  const base = emptyFilters();
  if (!f || typeof f !== 'object') return base;
  const age = Number(f.age);
  const stars = f.stars === null || f.stars === undefined ? NaN : Number(f.stars);
  const evidence = stringList(f.evidence).filter((e) => EVIDENCE.includes(e));
  return {
    q: typeof f.q === 'string' ? f.q.trim().slice(0, 200) : '',
    lang: stringList(f.lang),
    age: /** @type {Filters['age']} */ (AGE_STEPS.includes(age) ? age : null),
    stars: /** @type {Filters['stars']} */ (STAR_STEPS.includes(stars) ? stars : null),
    evidence: /** @type {Filters['evidence']} */ (EVIDENCE.filter((e) => evidence.includes(e))),
    script: stringList(f.script),
    agent: f.agent === true || f.agent === false ? f.agent : null,
    hidden: f.hidden === true,
  };
}

/**
 * @param {Partial<IndexEntry>} e
 * @param {Filters} f
 * @param {string | null} skip a filter group to ignore (for disjunctive facet counts)
 * @returns {boolean}
 */
function matches(e, f, skip) {
  if (skip !== 'q' && f.q) {
    const hay = [e.nwo, e.description, e.lang, ...(Array.isArray(e.topics) ? e.topics : [])]
      .filter((x) => typeof x === 'string').join(' ').toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every((term) => hay.includes(term))) return false;
  }
  if (skip !== 'lang' && f.lang.length > 0 && !f.lang.includes(langKey(e))) return false;
  if (skip !== 'age' && f.age !== null && !withinAge(e, f.age)) return false;
  if (skip !== 'stars' && f.stars !== null && !((numOrNull(e.stars) ?? 0) <= f.stars)) return false;
  if (skip !== 'evidence' && f.evidence.some((k) => !hasEvidence(e, k))) return false;
  if (skip !== 'script' && f.script.length > 0 && !f.script.includes(scriptKey(e))) return false;
  if (skip !== 'agent' && f.agent !== null && isAgent(e) !== f.agent) return false;
  return true;
}

/**
 * Apply the facet filters of §10.2 (not the snoozed/dismissed rule, which `shelf` applies).
 * @param {readonly IndexEntry[]} entries
 * @param {Partial<Filters> | null | undefined} filters
 * @returns {IndexEntry[]}
 */
export function applyFilters(entries, filters) {
  const f = normaliseFilters(filters);
  return entries.filter((e) => matches(e, f, null));
}

/**
 * @typedef {object} FacetCounts
 * @property {Record<string, number>} lang
 * @property {Record<string, number>} age keys `7`, `30`, `90`
 * @property {Record<string, number>} stars keys `0`, `5`, `25`
 * @property {Record<string, number>} evidence keys of `EVIDENCE`
 * @property {Record<string, number>} script
 * @property {{yes: number, no: number}} agent
 * @property {number} total entries passing every filter
 */

/**
 * Live facet counts (§10.2). Each group is counted under every other active filter, so a count
 * says how many entries picking that value would show (evidence combines with "and").
 * @param {readonly IndexEntry[]} entries
 * @param {Partial<Filters> | null} [filters]
 * @returns {FacetCounts}
 */
export function facetCounts(entries, filters = null) {
  const f = normaliseFilters(filters);
  /** @param {string} skip */
  const base = (skip) => entries.filter((e) => matches(e, f, skip));
  /**
   * @param {IndexEntry[]} list
   * @param {(e: IndexEntry) => string} key
   * @returns {Record<string, number>}
   */
  const tally = (list, key) => {
    /** @type {Record<string, number>} */
    const out = {};
    for (const e of list) {
      const k = key(e);
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };
  const ageBase = base('age');
  const starBase = base('stars');
  const evBase = base('evidence').filter((e) => f.evidence.every((k) => hasEvidence(e, k)));
  const agentBase = base('agent');
  /** @type {Record<string, number>} */
  const age = {};
  for (const d of AGE_STEPS) age[d] = ageBase.filter((e) => withinAge(e, d)).length;
  /** @type {Record<string, number>} */
  const stars = {};
  for (const s of STAR_STEPS) stars[s] = starBase.filter((e) => (numOrNull(e.stars) ?? 0) <= s).length;
  /** @type {Record<string, number>} */
  const evidence = {};
  for (const k of EVIDENCE) evidence[k] = evBase.filter((e) => hasEvidence(e, k)).length;
  return {
    lang: tally(base('lang'), langKey),
    age,
    stars,
    evidence,
    script: tally(base('script'), scriptKey),
    agent: { yes: agentBase.filter(isAgent).length, no: agentBase.filter((e) => !isAgent(e)).length },
    total: base('').length,
  };
}

// ---------------------------------------------------------------------------------------------
// Shelves
// ---------------------------------------------------------------------------------------------

/**
 * Shelves that show every entry they hold, whatever its queue state: Saved (its gems are what it
 * is for) and Quarantine (a quarantined repository appears there and nowhere else, §7.6).
 * @param {string} name
 * @returns {boolean}
 */
export function showsHidden(name) {
  return name === 'saved' || name === 'quarantine';
}

/**
 * Entries of a shelf before filtering: its lanes, or for Saved every entry saved as a gem that is
 * not quarantined (§7.6: a repository quarantined after it was saved appears only in Quarantine).
 * @param {Pick<Index, 'entries'> | null | undefined} index
 * @param {string} name
 * @returns {IndexEntry[]}
 */
export function laneEntries(index, name) {
  const all = Array.isArray(index?.entries) ? index.entries : [];
  if (name === 'saved') {
    return all.filter((e) => e.lane !== 'quarantine'
      && lastAction(/** @type {any} */ (e.feedback)) === 'gem');
  }
  const def = SHELVES.find((s) => s.name === name);
  const lanes = def?.lanes ?? [];
  return all.filter((e) => lanes.includes(e.lane));
}

/**
 * The entries a shelf shows, in order (§6.7, §10.2, §10.4). Lane shelves sort by `gem`
 * descending, then `stars` ascending, then `createdAt` descending; For you sorts by band and then
 * `gem + t` (taste); Saved puts the most recently saved first. Snoozed and dismissed entries are
 * left out unless `filters.hidden` is set (Saved always shows its gems, and Quarantine every
 * quarantined repository).
 * @param {Pick<Index, 'entries'> | null | undefined} index
 * @param {string} name
 * @param {Partial<Filters> | null | undefined} filters
 * @param {{taste?: TasteState | null, now: string}} opts
 * @returns {IndexEntry[]}
 */
export function shelf(index, name, filters, { taste = null, now }) {
  const f = normaliseFilters(filters);
  let list = laneEntries(index, name);
  if (!showsHidden(name) && !f.hidden) list = list.filter((e) => !isHidden(e, now));
  list = list.filter((e) => matches(e, f, null));
  if (name === 'foryou') return forYou(list, taste);
  if (name === 'saved') {
    /** @param {IndexEntry} e */
    const savedAt = (e) => {
      const last = /** @type {any} */ (e.feedback)?.last;
      return last && typeof last.at === 'string' ? last.at : '';
    };
    return list.sort((a, b) => byText(savedAt(b), savedAt(a)) || compareEntries(a, b));
  }
  return list.sort(compareEntries);
}

/**
 * How many entries each shelf holds with no facet filter (the counts of the top bar, §10.2).
 * @param {Pick<Index, 'entries'> | null | undefined} index
 * @param {{now: string}} opts
 * @returns {Record<string, number>}
 */
export function shelfCounts(index, { now }) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const name of SHELF_NAMES) {
    const list = laneEntries(index, name);
    out[name] = showsHidden(name) ? list.length : list.filter((e) => !isHidden(e, now)).length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The URL hash
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} s
 * @returns {string}
 */
function safeDecode(s) {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return '';
  }
}

/**
 * @param {string} s
 * @returns {string}
 */
function enc(s) {
  return encodeURIComponent(s).replace(/%20/g, '+');
}

/**
 * @param {string} query
 * @returns {Map<string, string>}
 */
function parseQuery(query) {
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = safeDecode(eq < 0 ? part : part.slice(0, eq));
    const value = eq < 0 ? '' : part.slice(eq + 1);
    if (key && !out.has(key)) out.set(key, value);
  }
  return out;
}

/**
 * @param {string | undefined} raw
 * @returns {string[]}
 */
function listParam(raw) {
  return raw === undefined ? [] : raw.split(',').map(safeDecode);
}

/**
 * @param {Map<string, string>} p
 * @returns {Filters}
 */
function filtersFromParams(p) {
  const agent = p.get('agent');
  const stars = p.get('stars');
  return normaliseFilters({
    q: safeDecode(p.get('q') ?? ''),
    lang: listParam(p.get('lang')),
    age: /** @type {any} */ (Number(p.get('age'))),
    stars: /** @type {any} */ (stars === undefined || stars === '' ? null : Number(stars)),
    evidence: /** @type {any} */ (listParam(p.get('ev'))),
    script: listParam(p.get('script')),
    agent: agent === '1' ? true : agent === '0' ? false : null,
    hidden: p.get('hidden') === '1',
  });
}

/**
 * @param {Filters} f
 * @returns {[string, string][]}
 */
function paramsFromFilters(f) {
  /** @type {[string, string][]} */
  const out = [];
  if (f.q) out.push(['q', enc(f.q)]);
  if (f.lang.length) out.push(['lang', f.lang.map(enc).join(',')]);
  if (f.age !== null) out.push(['age', String(f.age)]);
  if (f.stars !== null) out.push(['stars', String(f.stars)]);
  if (f.evidence.length) out.push(['ev', f.evidence.join(',')]);
  if (f.script.length) out.push(['script', f.script.map(enc).join(',')]);
  if (f.agent !== null) out.push(['agent', f.agent ? '1' : '0']);
  if (f.hidden) out.push(['hidden', '1']);
  return out;
}

/**
 * Read the view state from a URL hash (§10.2): `#/<shelf>?<filters>`, `#/r/<owner>/<name>`,
 * `#/calibrate`, `#/taste` or `#/status`. Anything unrecognised falls back to the default shelf.
 * @param {string | null | undefined} hash
 * @returns {ViewState}
 */
export function parseHash(hash) {
  let h = String(hash ?? '');
  if (h.startsWith('#')) h = h.slice(1);
  if (h.startsWith('/')) h = h.slice(1);
  const qi = h.indexOf('?');
  const pathPart = qi >= 0 ? h.slice(0, qi) : h;
  const params = parseQuery(qi >= 0 ? h.slice(qi + 1) : '');
  const segs = pathPart.split('/').filter(Boolean).map(safeDecode);
  const filters = filtersFromParams(params);
  const named = safeDecode(params.get('shelf') ?? '');
  const shelfName = SHELF_NAMES.includes(named) ? named : DEFAULT_SHELF;
  if (segs[0] === 'r' && segs.length === 3 && isNwo(`${segs[1]}/${segs[2]}`)) {
    return { screen: 'repo', shelf: shelfName, nwo: `${segs[1]}/${segs[2]}`, filters };
  }
  if (segs.length === 1 && SCREENS.includes(segs[0])) {
    return { screen: /** @type {ViewState['screen']} */ (segs[0]), shelf: shelfName, nwo: null, filters };
  }
  if (segs.length === 1 && SHELF_NAMES.includes(segs[0])) {
    return { screen: 'shelf', shelf: segs[0], nwo: null, filters };
  }
  return { screen: 'shelf', shelf: shelfName, nwo: null, filters };
}

/**
 * Write a view state as a URL hash; `parseHash(toHash(s))` gives back `s` (normalised).
 * @param {Partial<ViewState> | null | undefined} state
 * @returns {string}
 */
export function toHash(state) {
  const shelfName = SHELF_NAMES.includes(String(state?.shelf)) ? String(state?.shelf) : DEFAULT_SHELF;
  const params = paramsFromFilters(normaliseFilters(state?.filters));
  /** @param {[string, string][]} ps */
  const qs = (ps) => (ps.length ? `?${ps.map(([k, v]) => `${k}=${v}`).join('&')}` : '');
  /** @type {[string, string][]} */
  const shelfParam = shelfName !== DEFAULT_SHELF ? [['shelf', shelfName]] : [];
  const withShelf = () => [...shelfParam, ...params];
  if (state?.screen === 'repo' && isNwo(state.nwo)) {
    const [owner, name] = String(state.nwo).split('/');
    return `#/r/${enc(owner)}/${enc(name)}${qs(withShelf())}`;
  }
  if (state?.screen && SCREENS.includes(state.screen)) return `#/${state.screen}${qs(withShelf())}`;
  return `#/${shelfName}${qs(params)}`;
}

// ---------------------------------------------------------------------------------------------
// Feedback → queue state
// ---------------------------------------------------------------------------------------------

/** @returns {EntryFeedback} */
function blankFeedback() {
  return { last: null, published: false, snoozeUntil: null };
}

/**
 * An entry's queue state after one more event (§10.4). `label` (Calibrate) changes nothing;
 * `publish` and `unpublish` only flip `published`.
 * @param {Partial<EntryFeedback> | null | undefined} prev
 * @param {Pick<Feedback, 'action' | 'label' | 'reason' | 'at' | 'snoozeUntil'>} ev
 * @returns {EntryFeedback}
 */
export function nextEntryFeedback(prev, ev) {
  const base = { ...blankFeedback(), ...(prev ?? {}) };
  const last = { action: ev.action, label: ev.label ?? null, reason: ev.reason ?? null, at: ev.at };
  switch (ev.action) {
    case 'gem':
    case 'notgood':
    case 'notmine':
      return { ...base, last, snoozeUntil: null };
    case 'wip':
    case 'snooze':
      return { ...base, last, snoozeUntil: ev.snoozeUntil ?? null };
    case 'publish':
      return { ...base, published: true };
    case 'unpublish':
      return { ...base, published: false };
    default:
      return base;
  }
}

/**
 * Fold every feedback event into each repository's queue state; undone events are ignored.
 * @param {readonly Feedback[]} events
 * @returns {Record<string, EntryFeedback>} by repository id
 */
export function foldFeedback(events) {
  /** @type {Record<string, EntryFeedback>} */
  const out = {};
  for (const ev of activeFeedback(events)) {
    if (!ev.id) continue;
    out[ev.id] = nextEntryFeedback(Object.hasOwn(out, ev.id) ? out[ev.id] : null, ev);
  }
  return out;
}

/**
 * Entries with the folded feedback laid over their `feedback` field (unchanged entries are the
 * same objects).
 * @param {readonly IndexEntry[]} entries
 * @param {Record<string, EntryFeedback>} fold
 * @returns {IndexEntry[]}
 */
export function overlayFeedback(entries, fold) {
  return entries.map((e) => (Object.hasOwn(fold, e.id) ? { ...e, feedback: fold[e.id] } : e));
}

/**
 * Ids of the repositories that already carry a standing blind or Calibrate label.
 * @param {readonly Feedback[]} events
 * @returns {Set<string>}
 */
export function labelledIds(events) {
  return new Set(activeFeedback(events).filter((ev) => ev.action === 'label').map((ev) => ev.id));
}

/**
 * Build the body of a feedback event (§4.3, §10.4) — everything except `v` and `at`, which the
 * server stamps. The quality label is derived (`labelFromFeedback`); `wip` and `snooze` hide the
 * entry for 30 days unless `snoozeUntil` says otherwise; the note is cut to 280 characters.
 * @param {object} opts
 * @param {Pick<IndexEntry, 'id' | 'nwo'> & Partial<IndexEntry>} opts.entry
 * @param {FeedbackAction} opts.action
 * @param {string} opts.now ISO time, for the snooze
 * @param {Feedback['reason']} [opts.reason] notgood only
 * @param {import('./schema.mjs').Label | null} [opts.label] label only
 * @param {string} [opts.note]
 * @param {boolean} [opts.blind]
 * @param {string | number | null} [opts.undoes] undo only
 * @param {string | null} [opts.snoozeUntil]
 * @param {string | null} [opts.view]
 * @param {number | null} [opts.position]
 * @param {'sample' | 'pool' | null} [opts.stratum] blind labels (§10.7)
 * @param {{weights?: any, calibration?: any} | null} [opts.model] the index model, for versions
 * @returns {Omit<Feedback, 'v' | 'at'>}
 */
export function makeFeedback(opts) {
  const { entry, action, now } = opts;
  /** @type {Record<string, unknown>} */
  const context = {
    view: opts.view ?? null,
    position: Number.isInteger(opts.position) ? opts.position : null,
    S: numOrNull(entry.S), quality: numOrNull(entry.quality), gem: numOrNull(entry.gem),
    k: numOrNull(entry.k), stars: numOrNull(entry.stars),
    weights: typeof opts.model?.weights?.version === 'string' ? opts.model.weights.version : null,
    calibration: typeof opts.model?.calibration?.version === 'string' ? opts.model.calibration.version : null,
  };
  if (opts.stratum) context.stratum = opts.stratum;
  const ev = {
    id: entry.id,
    nwo: entry.nwo,
    action,
    label: /** @type {Feedback['label']} */ (null),
    reason: action === 'notgood' ? opts.reason ?? null : null,
    note: typeof opts.note === 'string' ? [...opts.note].slice(0, NOTE_MAX).join('') : '',
    blind: opts.blind === true,
    undoes: action === 'undo' ? opts.undoes ?? null : null,
    snoozeUntil: /** @type {string | null} */ (null),
    context: /** @type {Feedback['context']} */ (context),
  };
  ev.label = action === 'label' ? opts.label ?? null : labelFromFeedback(ev);
  if (action === 'wip' || action === 'snooze') {
    ev.snoozeUntil = opts.snoozeUntil ?? plusDays(now, SNOOZE_DAYS);
  }
  return ev;
}

// ---------------------------------------------------------------------------------------------
// Triage
// ---------------------------------------------------------------------------------------------

/** @returns {TriageState} an empty queue */
export function initialTriage() {
  return { ids: [], pos: -1, undo: [], decisions: 0, feedback: {} };
}

/**
 * @param {number} pos
 * @param {number} length
 * @returns {number}
 */
function clampPos(pos, length) {
  if (length === 0) return -1;
  return Math.min(Math.max(pos, 0), length - 1);
}

/** Actions that change an entry's queue state; a `label` (blind or Calibrate) changes none. */
const QUEUE_STATE_ACTIONS = Object.freeze([...TRIAGE_ACTIONS, 'publish', 'unpublish']);

/**
 * The triage reducer (§10.3, §10.4): queue position, the queue state of decided entries, and the
 * undo stack. `decide` applies one feedback event (already stamped with `at`): gem, notgood and
 * notmine take the entry out of the queue; wip and snooze take it out until `snoozeUntil`;
 * publish, unpublish and label leave the queue as it is. A label is kept on the undo stack but never
 * touches the entry's queue state, so labelling a repository decided in an earlier session keeps it
 * where that decision put it. `undo` walks back the newest decision (or the one `event.undoes`
 * names), restores the entry's previous state and puts it back where it was. Unknown actions return
 * the same state object.
 * @param {TriageState | null | undefined} state
 * @param {TriageAction} action
 * @returns {TriageState}
 */
export function triageReducer(state, action) {
  const s = state ?? initialTriage();
  switch (action?.type) {
    case 'load': {
      const ids = Array.isArray(action.ids) ? action.ids.slice() : [];
      const current = s.pos >= 0 ? s.ids[s.pos] : undefined;
      const keep = current === undefined ? -1 : ids.indexOf(current);
      return { ...s, ids, pos: keep >= 0 ? keep : clampPos(s.pos < 0 ? 0 : s.pos, ids.length) };
    }
    case 'next':
      return s.ids.length === 0 ? s : { ...s, pos: clampPos(s.pos + 1, s.ids.length) };
    case 'prev':
      return s.ids.length === 0 ? s : { ...s, pos: clampPos(s.pos - 1, s.ids.length) };
    case 'first':
      return { ...s, pos: clampPos(0, s.ids.length) };
    case 'last':
      return { ...s, pos: clampPos(s.ids.length - 1, s.ids.length) };
    case 'select': {
      const i = typeof action.id === 'string' ? s.ids.indexOf(action.id) : Number(action.index);
      return Number.isInteger(i) && i >= 0 && i < s.ids.length ? { ...s, pos: i } : s;
    }
    case 'decide': {
      const ev = action.event;
      if (!ev || typeof ev.id !== 'string' || typeof ev.action !== 'string' || ev.action === 'undo') return s;
      const prev = Object.hasOwn(s.feedback, ev.id) ? s.feedback[ev.id] : action.prev ?? null;
      const index = s.ids.indexOf(ev.id);
      const removed = index >= 0 && LEAVES_QUEUE.includes(ev.action);
      const ids = removed ? s.ids.filter((id) => id !== ev.id) : s.ids;
      const pos = removed && index < s.pos ? s.pos - 1 : s.pos;
      const item = { event: ev, prev, index: index >= 0 ? index : s.pos, removed };
      return {
        ids,
        pos: clampPos(pos, ids.length),
        undo: [...s.undo, item].slice(-UNDO_LIMIT),
        decisions: s.decisions + (TRIAGE_ACTIONS.includes(ev.action) ? 1 : 0),
        feedback: QUEUE_STATE_ACTIONS.includes(ev.action)
          ? { ...s.feedback, [ev.id]: nextEntryFeedback(prev, ev) } : s.feedback,
      };
    }
    case 'undo': {
      if (s.undo.length === 0) return s;
      const wanted = action.event?.undoes;
      let k = s.undo.length - 1;
      if (wanted !== undefined && wanted !== null) {
        const wantedId = action.event?.id;
        k = s.undo.findLastIndex((u) => u.event.at === wanted && (!wantedId || u.event.id === wantedId));
        if (k < 0) return s;
      }
      const item = s.undo[k];
      const id = item.event.id;
      /** @type {Record<string, EntryFeedback>} */
      const feedback = { ...s.feedback };
      if (QUEUE_STATE_ACTIONS.includes(item.event.action)) feedback[id] = item.prev ?? blankFeedback();
      let ids = s.ids;
      let pos = s.pos;
      if (item.removed && !ids.includes(id)) {
        const at = Math.min(Math.max(item.index, 0), ids.length);
        ids = [...ids.slice(0, at), id, ...ids.slice(at)];
        pos = at;
      } else if (ids.includes(id)) pos = ids.indexOf(id);
      return {
        ids,
        pos: clampPos(pos, ids.length),
        undo: [...s.undo.slice(0, k), ...s.undo.slice(k + 1)],
        decisions: Math.max(0, s.decisions - (TRIAGE_ACTIONS.includes(item.event.action) ? 1 : 0)),
        feedback,
      };
    }
    default:
      return s;
  }
}

/**
 * Whether a "help calibrate" card is due after this many triage decisions (§10.6).
 * @param {number} decisions
 * @returns {boolean}
 */
export function shouldOfferHelp(decisions) {
  return decisions > 0 && decisions % HELP_EVERY === 0;
}

/**
 * A "help calibrate" pick (§10.6): an entry from the uncertain band (`0.35 ≤ Q ≤ 0.65`) that has no
 * blind label yet, drawn with the injected generator; null when there is none.
 * @param {readonly IndexEntry[]} entries
 * @param {{labelled?: Set<string>, rand?: () => number, skip?: Set<string>}} [opts]
 * @returns {IndexEntry | null}
 */
export function pickHelpCalibrate(entries, { labelled = new Set(), rand = () => 0, skip = new Set() } = {}) {
  const pool = entries.filter((e) => e.lane !== 'quarantine' && typeof e.quality === 'number'
    && e.quality >= UNCERTAIN.lo && e.quality <= UNCERTAIN.hi && !labelled.has(e.id) && !skip.has(e.id));
  if (pool.length === 0) return null;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
}

// ---------------------------------------------------------------------------------------------
// Feedback import (Pages copies, §10.5)
// ---------------------------------------------------------------------------------------------

/** Fields a feedback event may carry. */
const FEEDBACK_FIELDS = Object.freeze(['v', 'at', 'id', 'nwo', 'action', 'label', 'reason', 'note', 'blind',
  'undoes', 'snoozeUntil', 'context']);

/**
 * @param {Feedback} ev
 * @returns {string}
 */
function feedbackKey(ev) {
  return `${ev.id}\n${ev.at}\n${ev.action}\n${ev.undoes ?? ''}`;
}

/**
 * Complete an imported event: known fields only, schema version 1, and defaults for the optional
 * fields; the label is derived when it is absent.
 * @param {unknown} raw
 * @returns {unknown}
 */
export function normaliseImported(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const r = /** @type {Record<string, any>} */ (raw);
  /** @type {Record<string, any>} */
  const ev = {};
  for (const k of FEEDBACK_FIELDS) if (r[k] !== undefined) ev[k] = r[k];
  ev.v = ev.v ?? 1;
  ev.reason = ev.reason ?? null;
  ev.note = ev.note ?? '';
  ev.blind = ev.blind ?? false;
  ev.undoes = ev.undoes ?? null;
  ev.snoozeUntil = ev.snoozeUntil ?? null;
  ev.context = ev.context ?? null;
  if (ev.label === undefined) ev.label = ev.action === 'label' ? null : labelFromFeedback(ev);
  return ev;
}

/**
 * Merge imported feedback into what is stored: invalid events are reported, events already present
 * (same repository, time, action and target) are counted as duplicates, and the rest come back in
 * time order, ready to append. Nothing stored is ever changed (§10.5).
 * @param {readonly Feedback[]} existing
 * @param {readonly unknown[]} incoming
 * @returns {{added: Feedback[], duplicates: number, invalid: {index: number, problems: string[]}[]}}
 */
export function mergeFeedback(existing, incoming) {
  const seen = new Set(existing.map(feedbackKey));
  /** @type {Feedback[]} */
  const added = [];
  /** @type {{index: number, problems: string[]}[]} */
  const invalid = [];
  let duplicates = 0;
  incoming.forEach((raw, index) => {
    const ev = normaliseImported(raw);
    const problems = validateFeedback(ev);
    if (problems.length > 0) {
      invalid.push({ index, problems: problems.slice(0, 3) });
      return;
    }
    const key = feedbackKey(/** @type {Feedback} */ (ev));
    if (seen.has(key)) {
      duplicates++;
      return;
    }
    seen.add(key);
    added.push(/** @type {Feedback} */ (ev));
  });
  added.sort((a, b) => byText(a.at, b.at));
  return { added, duplicates, invalid };
}

/**
 * Read a feedback export (what a Pages copy saves): `{v, exportedAt, events, pins}`, or a bare
 * array of events. Throws a TypeError for anything else.
 * @param {unknown} value
 * @returns {{events: unknown[], pins: Record<string, 1 | -1>}}
 */
export function parseFeedbackExport(value) {
  if (Array.isArray(value)) return { events: value, pins: {} };
  if (!value || typeof value !== 'object') throw new TypeError('Not an Unsung feedback export');
  const v = /** @type {Record<string, any>} */ (value);
  const events = Array.isArray(v.events) ? v.events : Array.isArray(v.feedback) ? v.feedback : null;
  if (!events) throw new TypeError('Not an Unsung feedback export: it has no events');
  /** @type {Record<string, 1 | -1>} */
  const pins = {};
  if (v.pins && typeof v.pins === 'object' && !Array.isArray(v.pins)) {
    for (const [facet, pin] of Object.entries(v.pins)) {
      if (/^[a-z]+:\S{1,80}$/.test(facet) && (pin === 1 || pin === -1)) pins[facet] = pin;
    }
  }
  return { events, pins };
}

// ---------------------------------------------------------------------------------------------
// Detail and Calibrate helpers
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} TreeSummary
 * @property {'tree' | 'root'} source the deep tree, or only the root listing
 * @property {number | null} count entries in the tree
 * @property {number | null} files blobs in the tree
 * @property {boolean} truncated
 * @property {{name: string, type: string, files: number | null, bytes: number | null}[]} top
 *   top-level entries, directories first, then by size
 * @property {number} more top-level entries not listed
 */

/**
 * A summary of a repository's tree for the detail pane and Calibrate (§10.2, §10.7): its
 * top-level entries with file counts when the deep tree is known, else the root listing.
 * @param {Partial<Facts> | null | undefined} facts
 * @param {number} [limit]
 * @returns {TreeSummary | null}
 */
export function treeSummary(facts, limit = 40) {
  const tree = facts?.tree;
  /** @typedef {{name: string, type: string, files: number | null}} TopEntry */
  /** @type {(a: TopEntry, b: TopEntry) => number} */
  const order = (a, b) => (a.type === b.type ? 0 : a.type === 'tree' ? -1 : 1)
    || (b.files ?? 0) - (a.files ?? 0) || byText(a.name, b.name);
  if (tree && Array.isArray(tree.entries)) {
    /** @type {Map<string, {name: string, type: string, files: number, bytes: number}>} */
    const top = new Map();
    let files = 0;
    for (const entry of tree.entries) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      const [p, type, size] = entry;
      const slash = p.indexOf('/');
      const head = slash < 0 ? p : p.slice(0, slash);
      const cur = top.get(head) ?? { name: head, type: slash < 0 ? type : 'tree', files: 0, bytes: 0 };
      if (type === 'blob') {
        files++;
        cur.files++;
        cur.bytes += typeof size === 'number' ? size : 0;
      }
      if (slash < 0 && type === 'tree') cur.type = 'tree';
      top.set(head, cur);
    }
    const list = [...top.values()].sort(order);
    return {
      source: 'tree', count: typeof tree.count === 'number' ? tree.count : tree.entries.length, files,
      truncated: Boolean(tree.truncated), top: list.slice(0, limit), more: Math.max(0, list.length - limit),
    };
  }
  if (Array.isArray(facts?.root)) {
    const list = facts.root.filter((r) => r && typeof r.name === 'string')
      .map((r) => ({ name: r.name, type: r.type === 'tree' ? 'tree' : 'blob', files: null, bytes: null }))
      .sort(order);
    return { source: 'root', count: null, files: null, truncated: false, top: list.slice(0, limit),
      more: Math.max(0, list.length - limit) };
  }
  return null;
}

/**
 * A blind Calibrate item (§10.7): identity, description, language, README and a tree summary —
 * with every score, chip, star and verdict field left out, so nothing hints at the answer.
 * @param {Pick<RepoRecord, 'id' | 'nwo'> & {facts?: Partial<Facts> | null}} record
 * @param {'sample' | 'pool'} stratum
 * @param {{readmeChars?: number}} [opts]
 * @returns {{id: string, nwo: string, stratum: 'sample' | 'pool', description: string | null,
 *   lang: string | null, readme: {name: string, text: string, truncated: boolean} | null,
 *   tree: TreeSummary | null}}
 */
export function blindItem(record, stratum, { readmeChars = 32768 } = {}) {
  const f = record.facts ?? {};
  const readme = f.readme && typeof f.readme.text === 'string'
    ? {
      name: typeof f.readme.name === 'string' ? f.readme.name : 'README',
      text: f.readme.text.slice(0, readmeChars),
      truncated: Boolean(f.readme.truncated) || f.readme.text.length > readmeChars,
    }
    : null;
  return {
    id: record.id,
    nwo: record.nwo,
    stratum,
    description: typeof f.description === 'string' ? f.description.slice(0, 1000) : null,
    lang: typeof f.primaryLanguage === 'string' ? f.primaryLanguage : null,
    readme,
    tree: treeSummary(f),
  };
}
