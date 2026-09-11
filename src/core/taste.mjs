// @ts-check
/**
 * Personalisation (DESIGN §10.6). Taste is learnt from triage only: `gem` adds to every facet of the
 * repository, `notmine` subtracts, and pins override what was learnt. The taste term `t ∈ [−1, 1]`
 * reorders the For you shelf within a quality band; it never changes `S`, `Q` or `K`, and never moves
 * an entry across a band (§6.7). Pure: no clock, no randomness, no I/O.
 */

import { clamp } from './util.mjs';

/** @typedef {import('./schema.mjs').IndexEntry} IndexEntry */
/** @typedef {import('./schema.mjs').Feedback} Feedback */
/** @typedef {import('./schema.mjs').TasteState} TasteState */
/** @typedef {{gems: number, notmine: number, pin: -1 | 0 | 1}} FacetTaste */
/**
 * One For you slot: the entry, its taste term, and whether it is a wildcard (§10.6).
 * @typedef {{entry: IndexEntry, t: number, wildcard: boolean}} ForYouSlot
 */

/** Affinity of a pinned facet; a muted facet gets the negative (§10.6). */
export const PIN_AFFINITY = 0.7;

/** Every tenth For you slot is a wildcard (§10.6). */
export const WILDCARD_EVERY = 10;

/** At most this many `topic:` facets per entry (§10.6). */
export const MAX_TOPIC_FACETS = 8;

/** `updatedAt` of a taste built from no events. */
export const EPOCH = '1970-01-01T00:00:00.000Z';

/** Lanes the For you shelf draws from (§6.7). */
export const FOR_YOU_LANES = Object.freeze(['proven', 'promising', 'look']);

/** Order of the quality bands, best first. */
const BAND_ORDER = Object.freeze({ gem: 0, look: 1, low: 2 });

/** Facet word for each verdict category (§1.2), used for `kind:<kind>`. */
export const CATEGORY_KIND = Object.freeze({
  G: 'genuine', W: 'wip', C: 'coursework', P: 'personal', S: 'scaffold', D: 'dump', X: 'spam', E: 'empty',
});

/**
 * @param {unknown} x
 * @returns {number}
 */
function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : 0;
}

/**
 * Lower-case facet value: spaces become `-`.
 * @param {unknown} s
 * @returns {string}
 */
function slug(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * The later of two ISO timestamps (either may be missing).
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {string}
 */
function later(a, b) {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN;
  const tb = typeof b === 'string' ? Date.parse(b) : NaN;
  if (Number.isNaN(tb)) return typeof a === 'string' ? a : EPOCH;
  if (Number.isNaN(ta)) return /** @type {string} */ (b);
  return tb > ta ? /** @type {string} */ (b) : /** @type {string} */ (a);
}

/**
 * Look an entry up by id in a `Map` or a plain object.
 * @param {Map<string, IndexEntry> | Record<string, IndexEntry> | null | undefined} byId
 * @param {string} id
 * @returns {IndexEntry | undefined}
 */
function lookup(byId, id) {
  if (!byId) return undefined;
  if (byId instanceof Map) return byId.get(id);
  return Object.hasOwn(byId, id) ? byId[id] : undefined;
}

/**
 * Facets of an entry (§10.6): `lang:<family>`, `topic:<t>` (at most 8), `owner:user|org`,
 * `script:<script>` and `kind:<kind>` from a verdict. The index carries them in `entry.facets`;
 * without that list, language and topics are derived from the entry. Lower-cased and de-duplicated.
 * @param {Partial<IndexEntry> | null | undefined} entry
 * @returns {string[]}
 */
export function facetsOf(entry) {
  if (!entry || typeof entry !== 'object') return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  let topics = 0;
  /** @param {unknown} f */
  const add = (f) => {
    const k = String(f ?? '').trim().toLowerCase();
    const colon = k.indexOf(':');
    if (colon <= 0 || colon === k.length - 1 || seen.has(k)) return;
    if (k.startsWith('topic:')) {
      if (topics >= MAX_TOPIC_FACETS) return;
      topics++;
    }
    seen.add(k);
    out.push(k);
  };
  if (Array.isArray(entry.facets) && entry.facets.length > 0) {
    for (const f of entry.facets) add(f);
  } else {
    if (entry.lang) add(`lang:${slug(entry.lang)}`);
    for (const t of Array.isArray(entry.topics) ? entry.topics : []) add(`topic:${slug(t)}`);
  }
  const category = entry.verdict?.category;
  if (category && Object.hasOwn(CATEGORY_KIND, category)) {
    add(`kind:${CATEGORY_KIND[/** @type {keyof typeof CATEGORY_KIND} */ (category)]}`);
  }
  return out;
}

/**
 * A taste with no facets.
 * @param {string} [updatedAt]
 * @returns {TasteState}
 */
export function emptyTaste(updatedAt = EPOCH) {
  return { v: 1, updatedAt, facets: {} };
}

/**
 * The events that still stand: `undo` events and the events they revert are removed. An `undo`
 * names its target by the target's `at` (what Unsung writes) or by its position in `events`; the
 * target must belong to the same repository.
 * @param {readonly Feedback[] | null | undefined} events
 * @returns {Feedback[]}
 */
export function activeFeedback(events) {
  const list = Array.isArray(events) ? events : [];
  /** @type {Set<string>} */
  const undoneKeys = new Set();
  /** @type {Set<Feedback>} */
  const undoneEvents = new Set();
  for (const ev of list) {
    if (!ev || ev.action !== 'undo' || ev.undoes === null || ev.undoes === undefined) continue;
    if (typeof ev.undoes === 'number') {
      const target = list[ev.undoes];
      if (target && target.id === ev.id) undoneEvents.add(target);
    } else undoneKeys.add(`${ev.id}\n${ev.undoes}`);
  }
  return list.filter((ev) => ev && ev.action !== 'undo' && !undoneEvents.has(ev)
    && !undoneKeys.has(`${ev.id}\n${ev.at}`));
}

/**
 * Apply one feedback event (§10.4): `gem` adds one to `gems` on each facet of `entry`, `notmine`
 * adds one to `notmine`; other actions leave the counts alone. An `undo` reverts the event it
 * names, which the caller passes as `undone` (`rebuildTaste` does this itself). Returns a new state.
 * @param {TasteState | null | undefined} state
 * @param {Feedback} ev
 * @param {Partial<IndexEntry> | null | undefined} entry the repository the event is about
 * @param {Feedback | null} [undone] for an `undo`, the event it reverts
 * @returns {TasteState}
 */
export function applyFeedback(state, ev, entry, undone = null) {
  const base = state ?? emptyTaste();
  /** @type {Record<string, FacetTaste>} */
  const facets = { ...base.facets };
  /** @type {{field: 'gems' | 'notmine', by: number} | null} */
  let delta = null;
  if (ev?.action === 'gem') delta = { field: 'gems', by: 1 };
  else if (ev?.action === 'notmine') delta = { field: 'notmine', by: 1 };
  else if (ev?.action === 'undo' && undone) {
    if (undone.action === 'gem') delta = { field: 'gems', by: -1 };
    else if (undone.action === 'notmine') delta = { field: 'notmine', by: -1 };
  }
  if (delta) {
    for (const f of facetsOf(entry)) {
      const cur = Object.hasOwn(facets, f) ? facets[f] : { gems: 0, notmine: 0, pin: /** @type {0} */ (0) };
      const next = { ...cur, [delta.field]: Math.max(0, cur[delta.field] + delta.by) };
      if (next.gems === 0 && next.notmine === 0 && next.pin === 0) delete facets[f];
      else facets[f] = next;
    }
  }
  return { v: 1, updatedAt: later(base.updatedAt, ev?.at), facets };
}

/**
 * The pins of a taste: `{facet: 1 | -1}` for every pinned or muted facet.
 * @param {TasteState | null | undefined} state
 * @returns {Record<string, 1 | -1>}
 */
export function pinsOf(state) {
  /** @type {Record<string, 1 | -1>} */
  const out = {};
  for (const [f, v] of Object.entries(state?.facets ?? {})) {
    if (v && (v.pin === 1 || v.pin === -1)) out[f] = v.pin;
  }
  return out;
}

/**
 * Pin (`1`), mute (`-1`) or reset (`0`, back to what was learnt) one facet. Returns a new state.
 * @param {TasteState | null | undefined} state
 * @param {string} facet
 * @param {-1 | 0 | 1} pin
 * @param {string} [at] new `updatedAt`
 * @returns {TasteState}
 */
export function setPin(state, facet, pin, at) {
  const base = state ?? emptyTaste();
  const key = String(facet).trim().toLowerCase();
  /** @type {Record<string, FacetTaste>} */
  const facets = { ...base.facets };
  const cur = Object.hasOwn(facets, key) ? facets[key] : { gems: 0, notmine: 0, pin: /** @type {0} */ (0) };
  const p = pin === 1 || pin === -1 ? pin : 0;
  const next = { ...cur, pin: p };
  if (next.gems === 0 && next.notmine === 0 && next.pin === 0) delete facets[key];
  else facets[key] = next;
  return { v: 1, updatedAt: at ?? base.updatedAt, facets };
}

/**
 * Rebuild the taste from every feedback event (§4.3: `taste.json` is rebuilt on every write).
 * Undone events are skipped; `opts.pins` (see `pinsOf`) are carried over, because pins are not
 * feedback. `updatedAt` defaults to the time of the newest event.
 * @param {readonly Feedback[] | null | undefined} events
 * @param {Map<string, IndexEntry> | Record<string, IndexEntry> | null | undefined} entriesById
 * @param {{pins?: Record<string, number> | null, updatedAt?: string}} [opts]
 * @returns {TasteState}
 */
export function rebuildTaste(events, entriesById, opts = {}) {
  let state = emptyTaste();
  for (const ev of activeFeedback(events)) {
    if (ev.action !== 'gem' && ev.action !== 'notmine') continue;
    state = applyFeedback(state, ev, lookup(entriesById, ev.id));
  }
  for (const [facet, pin] of Object.entries(opts.pins ?? {})) {
    if (pin === 1 || pin === -1) state = setPin(state, facet, pin);
  }
  let updatedAt = EPOCH;
  for (const ev of Array.isArray(events) ? events : []) updatedAt = later(updatedAt, ev?.at);
  return { v: 1, updatedAt: opts.updatedAt ?? updatedAt, facets: state.facets };
}

/**
 * Affinity of one facet (§10.6): `ln((gems + 1) / (notmine + 1))`, or `±0.7` when pinned or muted.
 * An unknown facet has affinity 0.
 * @param {TasteState | null | undefined} state
 * @param {string} facet
 * @returns {number}
 */
export function affinity(state, facet) {
  const facets = state?.facets;
  const f = facets && Object.hasOwn(facets, facet) ? facets[facet] : null;
  if (!f) return 0;
  if (f.pin === 1) return PIN_AFFINITY;
  if (f.pin === -1) return -PIN_AFFINITY;
  const a = Math.log((num(f.gems) + 1) / (num(f.notmine) + 1));
  return a === 0 ? 0 : a;
}

/**
 * Taste term of an entry (§10.6): the mean affinity over its facets, clamped to `[−1, 1]`; 0 for
 * an entry without facets.
 * @param {TasteState | null | undefined} state
 * @param {Partial<IndexEntry> | null | undefined} entry
 * @returns {number}
 */
export function tasteTerm(state, entry) {
  const facets = facetsOf(entry);
  if (facets.length === 0 || !state) return 0;
  let sum = 0;
  for (const f of facets) sum += affinity(state, f);
  const t = clamp(sum / facets.length, -1, 1);
  return Number.isFinite(t) && t !== 0 ? t : 0;
}

/**
 * Quality band of an entry: its `band`, else inferred from its lane.
 * @param {Partial<IndexEntry>} entry
 * @returns {'gem' | 'look' | 'low'}
 */
export function bandOf(entry) {
  if (entry.band === 'gem' || entry.band === 'look' || entry.band === 'low') return entry.band;
  if (entry.lane === 'proven' || entry.lane === 'promising') return 'gem';
  return entry.lane === 'look' ? 'look' : 'low';
}

/**
 * Order within a lane (§6.7): `gem` descending, then `stars` ascending, then `createdAt`
 * descending; `nwo` breaks the remaining ties so the order is total.
 * @param {Partial<IndexEntry>} a
 * @param {Partial<IndexEntry>} b
 * @returns {number}
 */
export function compareEntries(a, b) {
  const g = num(b.gem) - num(a.gem);
  if (g !== 0) return g;
  const s = num(a.stars) - num(b.stars);
  if (s !== 0) return s;
  const ca = a.createdAt ?? '';
  const cb = b.createdAt ?? '';
  if (ca !== cb) return ca < cb ? 1 : -1;
  const na = a.nwo ?? '';
  const nb = b.nwo ?? '';
  return na < nb ? -1 : na > nb ? 1 : 0;
}

/**
 * The For you order with its taste terms (§6.7, §10.6). Only lanes `proven`, `promising` and
 * `look` take part. Entries are grouped by band (gem before look) and, within a band, sorted by
 * `gem + t`. Every tenth slot goes to the highest-`gem` entry of the same band whose `t < 0`, so the
 * feed does not narrow into a bubble. No entry ever leaves its band.
 * @param {readonly IndexEntry[]} entries
 * @param {TasteState | null | undefined} state
 * @param {{every?: number}} [opts]
 * @returns {ForYouSlot[]}
 */
export function forYouSlots(entries, state, { every = WILDCARD_EVERY } = {}) {
  /** @type {Map<string, ForYouSlot[]>} */
  const byBand = new Map();
  for (const entry of entries) {
    if (!FOR_YOU_LANES.includes(entry.lane)) continue;
    const band = bandOf(entry);
    const list = byBand.get(band) ?? [];
    list.push({ entry, t: tasteTerm(state, entry), wildcard: false });
    byBand.set(band, list);
  }
  const bands = [...byBand.keys()].sort((a, b) => (BAND_ORDER[/** @type {'gem'} */ (a)] ?? 9)
    - (BAND_ORDER[/** @type {'gem'} */ (b)] ?? 9));
  /** @type {ForYouSlot[]} */
  const out = [];
  for (const band of bands) {
    const list = /** @type {ForYouSlot[]} */ (byBand.get(band));
    const ranked = [...list].sort((x, y) => (num(y.entry.gem) + y.t) - (num(x.entry.gem) + x.t)
      || compareEntries(x.entry, y.entry));
    const wild = list.filter((s) => s.t < 0).sort((x, y) => compareEntries(x.entry, y.entry));
    /** @type {Set<ForYouSlot>} */
    const placed = new Set();
    let ri = 0;
    let wi = 0;
    while (placed.size < list.length) {
      if (every > 0 && (out.length + 1) % every === 0) {
        while (wi < wild.length && placed.has(wild[wi])) wi++;
        if (wi < wild.length) {
          const s = wild[wi++];
          placed.add(s);
          out.push({ ...s, wildcard: true });
          continue;
        }
      }
      while (placed.has(ranked[ri])) ri++;
      const s = ranked[ri++];
      placed.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * The For you shelf (§6.7, §10.6): `forYouSlots` without the annotations.
 * @param {readonly IndexEntry[]} entries
 * @param {TasteState | null | undefined} state
 * @returns {IndexEntry[]}
 */
export function forYou(entries, state) {
  return forYouSlots(entries, state).map((s) => s.entry);
}
