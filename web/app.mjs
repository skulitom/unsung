// @ts-check
/**
 * The explorer's boot, router, state and wiring (DESIGN §10.2–§10.7, §12.7). One state object;
 * `dispatch(action)` changes it (triage goes through `triageReducer`), runs side effects through
 * web/api.mjs, and schedules a render of the regions that changed. The views in web/views/ are
 * pure renderers. The explainer (src/core/explain.mjs) and the README block parser
 * (src/core/readme.mjs) are loaded when they are there; the explorer works without them.
 */

import { facetsOf, forYouSlots } from '../src/core/taste.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import {
  SHELF_NAMES, emptyFilters, facetCounts, initialTriage, isHidden, isNwo, labelledIds, laneEntries,
  lastAction, makeFeedback, normaliseFilters, overlayFeedback, parseHash, pickHelpCalibrate, shelf,
  shelfCounts, shouldOfferHelp, showsHidden, toHash, triageReducer,
} from '../src/core/views.mjs';
import { createApi } from './api.mjs';
import { bindKeys } from './keys.mjs';
import { downloadJson, el, replace } from './render.mjs';
import { render as renderCalibrate } from './views/calibrate.mjs';
import { render as renderDetail } from './views/detail.mjs';
import { LANE_LABELS, REASONS, pct } from './views/parts.mjs';
import { render as renderQuarantine } from './views/quarantine.mjs';
import { render as renderQueue } from './views/queue.mjs';
import {
  renderBanner, renderFacets, renderOverlay, renderRunInfo, renderShelves, renderToast,
} from './views/shell.mjs';
import { render as renderStatus } from './views/status.mjs';
import { render as renderTaste } from './views/taste.mjs';

/** @typedef {import('../src/core/schema.mjs').IndexEntry} IndexEntry */
/** @typedef {import('../src/core/schema.mjs').Feedback} Feedback */
/** @typedef {Record<string, any>} Action */

const g = /** @type {any} */ (globalThis);
const doc = g.document;
const api = createApi();
const rand = mulberry32(Date.now() >>> 0);

/** Layouts narrower than this show the detail pane as a full-screen overlay. */
const NARROW = '(max-width: 899px)';
const FIRST_RUN_KEY = 'unsung.firstRunDone';
const POPULAR = ['Rust', 'Go', 'Python', 'TypeScript', 'JavaScript', 'C++', 'C', 'Java', 'Kotlin', 'Swift',
  'Ruby', 'Zig', 'Elixir', 'Haskell', 'C#', 'PHP', 'Dart'];
const ACTION_WORDS = /** @type {Record<string, string>} */ ({
  gem: 'Saved as a gem', wip: 'Work in progress: back in 30 days', notmine: 'Not my thing',
  snooze: 'Snoozed for 30 days', publish: 'Published', unpublish: 'Unpublished',
});
const REGIONS = ['shelves', 'runinfo', 'banner', 'facets', 'main', 'detail', 'overlay', 'toast'];

/** @returns {string} */
const nowIso = () => new Date().toISOString();

/**
 * @param {string} id
 * @returns {any}
 */
const $ = (id) => doc?.getElementById?.(id) ?? null;

const regions = /** @type {Record<string, any>} */ (Object.fromEntries(REGIONS.map((r) => [r, $(r)])));

const state = {
  phase: 'loading',
  /** @type {string | null} */ error: null,
  /** @type {'unknown' | 'server' | 'examples' | 'static'} */ mode: 'unknown',
  /** @type {any} */ index: null,
  /** @type {Map<string, IndexEntry>} */ byId: new Map(),
  /** @type {Map<string, IndexEntry>} */ byNwo: new Map(),
  route: parseHash(g.location?.hash ?? ''),
  triage: initialTriage(),
  /** @type {any} */ taste: null,
  /** @type {any} */ model: null,
  now: nowIso(),
  /** @type {Record<string, number>} */ counts: {},
  /** @type {any} */ facets: null,
  /** @type {IndexEntry[]} */ list: [],
  hiddenCount: 0,
  /** @type {Map<string, {t: number, wildcard: boolean}> | null} */ tasteTerms: null,
  /** @type {{nwo: string | null, record: any, loading: boolean, error: string | null}} */
  detail: { nwo: null, record: null, loading: false, error: null },
  why: true,
  detailOpen: false,
  facetsOpen: false,
  /** @type {string | null} */ chord: null,
  /** @type {string | null} */ reasonMenu: null,
  help: false,
  /** @type {{id: string, draft: string} | null} */ publishing: null,
  /** @type {string | null} */ helpCard: null,
  /** @type {Set<string>} */ helpSkipped: new Set(),
  /** @type {Set<string>} */ helpLabelled: new Set(),
  /**
   * @type {{items: any[], pos: number, loading: boolean, error: string | null,
   *   labels: Record<string, string>, loaded: boolean}}
   */
  calibrate: { items: [], pos: 0, loading: false, error: null, labels: {}, loaded: false },
  /** @type {{loading: boolean, error: string | null, data: any}} */
  status: { loading: false, error: null, data: null },
  /** @type {{busy: boolean, error: string | null, done: string | null}} */
  adder: { busy: false, error: null, done: null },
  /** @type {{text: string, kind: string} | null} */ toast: null,
  /** @type {{explain: Function | null, toSafeBlocks: Function | null}} */
  lib: { explain: null, toSafeBlocks: null },
  firstRun: false,
  scope: '',
  /** @type {string[]} */ languages: [],
  /** @type {string[]} */ suggestions: [],
};

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/**
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/** @returns {boolean} */
function isNarrow() {
  try {
    return Boolean(g.matchMedia?.(NARROW)?.matches);
  } catch {
    return false;
  }
}

/**
 * @param {string} key
 * @returns {boolean}
 */
function readFlag(key) {
  try {
    return g.localStorage?.getItem(key) === '1';
  } catch {
    return false;
  }
}

/** @param {string} key */
function writeFlag(key) {
  try {
    g.localStorage?.setItem(key, '1');
  } catch {
    // Remembered for this page only.
  }
}

/** @returns {IndexEntry | null} the card under the cursor */
function currentEntry() {
  const id = state.triage.ids[state.triage.pos];
  return id ? state.byId.get(id) ?? null : null;
}

/**
 * The repository a key acts on: the one the detail pane shows when the URL names one that is not
 * the card under the cursor (it is not on this shelf, or not under these filters), else the card.
 * So g, x, n, w, z, p and o never decide about a repository the user is not looking at.
 * @returns {IndexEntry | null}
 */
function targetEntry() {
  const current = currentEntry();
  const routed = state.route.screen === 'repo' && state.route.nwo
    ? state.byNwo.get(state.route.nwo.toLowerCase()) ?? null : null;
  return routed && routed.id !== current?.id ? routed : current;
}

/** @returns {boolean} whether any facet filter is active */
function filtersActive() {
  const f = state.route.filters;
  return Boolean(f.q || f.lang.length || f.age !== null || f.stars !== null || f.evidence.length
    || f.script.length || f.agent !== null);
}

/** @returns {boolean} */
function onShelfScreen() {
  return state.route.screen === 'shelf' || state.route.screen === 'repo';
}

/**
 * @param {any} index
 * @returns {string[]} languages for the first-run scope, the index's first
 */
function languagesOf(index) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const e of index?.entries ?? []) if (e.lang) seen.set(e.lang, (seen.get(e.lang) ?? 0) + 1);
  const mine = [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  return [...new Set([...mine, ...POPULAR])].slice(0, 30);
}

/**
 * @param {any} index
 * @returns {string[]} the most common facets of the index, for pinning before any triage
 */
function suggestionsOf(index) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const e of index?.entries ?? []) {
    if (e.lane === 'quarantine') continue;
    for (const f of facetsOf(e)) seen.set(f, (seen.get(f) ?? 0) + 1);
  }
  const common = [...seen.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  return common.slice(0, 24).map(([f]) => f);
}

/**
 * @param {Feedback} ev
 * @returns {string}
 */
function describe(ev) {
  if (ev.action === 'notgood') {
    return `Not good: ${REASONS.find((r) => r.reason === ev.reason)?.label ?? ev.reason}`;
  }
  if (ev.action === 'label') return `Labelled ${ev.label}`;
  return ACTION_WORDS[ev.action] ?? ev.action;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** @type {Set<string>} */
const dirty = new Set();
let scheduled = false;
/** @type {string | null} */
let lastScrolled = null;
let toastTimer = 0;

/**
 * Mark regions for repainting (all of them when none is named) and schedule one paint.
 * @param {...string} names
 */
function invalidate(...names) {
  for (const n of names.length > 0 ? names : REGIONS) dirty.add(n);
  if (scheduled) return;
  scheduled = true;
  const raf = typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame.bind(g)
    : (/** @type {() => void} */ f) => setTimeout(f, 16);
  raf(paint);
}

/**
 * @param {string} text
 * @param {'info' | 'error'} [kind]
 */
function toast(text, kind = 'info') {
  state.toast = { text, kind };
  invalidate('toast');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    invalidate('toast');
  }, kind === 'error' ? 7000 : 4000);
}

/** @returns {any} what the detail pane needs */
function detailState() {
  const nwo = state.detail.nwo;
  const entry = nwo ? state.byNwo.get(nwo.toLowerCase()) ?? null : null;
  return {
    detail: state.detail, entry, why: state.why, overlay: state.detailOpen && isNarrow(), model: state.model,
    lib: state.lib, reasonMenu: state.reasonMenu, chord: state.chord, now: state.now, mode: state.mode,
  };
}

function paintMain() {
  const root = regions.main;
  if (state.phase === 'loading') {
    replace(root, el('p', { class: 'loading', role: 'status' }, 'Loading the index…'));
    return;
  }
  if (state.phase === 'error') {
    replace(root, el('p', { class: 'muted' }, 'Nothing to show until the index loads.'));
    return;
  }
  const screen = state.route.screen;
  if (screen === 'taste') return renderTaste(root, state, dispatch);
  if (screen === 'calibrate') return renderCalibrate(root, state, dispatch);
  if (screen === 'status') return renderStatus(root, state, dispatch);
  if (state.route.shelf === 'quarantine') return renderQuarantine(root, state, dispatch);
  const help = state.helpCard ? state.byId.get(state.helpCard) ?? null : null;
  return renderQueue(root, { ...state, helpCard: help, filtered: filtersActive() }, dispatch);
}

function paint() {
  scheduled = false;
  const todo = new Set(dirty);
  dirty.clear();
  const onShelf = onShelfScreen() && state.phase === 'ready';
  doc.body.className = [
    `screen-${onShelfScreen() ? 'shelf' : state.route.screen}`, state.detailOpen ? 'detail-open' : '',
    state.facetsOpen ? 'facets-open' : '', onShelf ? '' : 'no-side', `mode-${state.mode}`,
  ].filter(Boolean).join(' ');
  if (todo.has('shelves')) renderShelves(regions.shelves, state);
  if (todo.has('runinfo')) renderRunInfo(regions.runinfo, state);
  if (todo.has('banner')) renderBanner(regions.banner, state, dispatch);
  if (todo.has('facets')) {
    if (onShelf) renderFacets(regions.facets, state, dispatch);
    else replace(regions.facets);
  }
  if (todo.has('main')) paintMain();
  if (todo.has('detail')) {
    if (onShelf) renderDetail(regions.detail, detailState(), dispatch);
    else replace(regions.detail);
  }
  if (todo.has('overlay')) renderOverlay(regions.overlay, state, dispatch);
  if (todo.has('toast')) renderToast(regions.toast, state);
  $('filters-toggle')?.setAttribute('aria-expanded', String(state.facetsOpen));
  if (!todo.has('main')) return;
  const current = currentEntry();
  if (current && current.id !== lastScrolled) {
    lastScrolled = current.id;
    regions.main.querySelector('.card.selected, .q-item.selected')?.scrollIntoView?.({ block: 'nearest' });
  }
  if (state.publishing) {
    const area = $('publish-note');
    if (area && doc.activeElement !== area) {
      area.focus();
      area.setSelectionRange?.(area.value.length, area.value.length);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// State changes
// ---------------------------------------------------------------------------------------------

/** Recompute the shelf, its counts and facets from the index and this session's decisions. */
function refresh() {
  if (!state.index) return;
  state.now = nowIso();
  const entries = overlayFeedback(state.index.entries, state.triage.feedback);
  const idx = { ...state.index, entries };
  const name = state.route.shelf;
  const filters = state.route.filters;
  state.byId = new Map(entries.map((e) => [e.id, e]));
  state.byNwo = new Map(entries.map((e) => [e.nwo.toLowerCase(), e]));
  state.counts = shelfCounts(idx, { now: state.now });
  const base = laneEntries(idx, name);
  const visible = showsHidden(name) ? base : base.filter((e) => !isHidden(e, state.now));
  state.hiddenCount = base.length - visible.length;
  state.facets = facetCounts(filters.hidden ? base : visible, filters);
  state.list = shelf(idx, name, filters, { taste: state.taste, now: state.now });
  state.tasteTerms = name === 'foryou'
    ? new Map(forYouSlots(state.list, state.taste).map((s) => [s.entry.id, { t: s.t, wildcard: s.wildcard }]))
    : null;
  state.triage = triageReducer(state.triage, { type: 'load', ids: state.list.map((e) => e.id) });
}

let detailToken = 0;
let detailTimer = 0;
/** @type {Map<string, any>} */
const records = new Map();

/**
 * @param {string} nwo
 * @param {any} record
 */
function remember(nwo, record) {
  records.set(nwo, record);
  if (records.size > 60) records.delete(/** @type {string} */ (records.keys().next().value));
}

/** Point the detail pane at the routed repository or the card under the cursor, and load it. */
function syncDetail() {
  if (!onShelfScreen()) return;
  const routed = state.route.screen === 'repo' ? state.route.nwo : null;
  const nwo = routed ?? currentEntry()?.nwo ?? null;
  if (nwo === state.detail.nwo) return;
  const cached = nwo ? records.get(nwo) : undefined;
  state.detail = { nwo, record: cached ?? null, loading: Boolean(nwo) && cached === undefined, error: null };
  invalidate('detail');
  clearTimeout(detailTimer);
  if (!nwo || cached !== undefined) return;
  const token = ++detailToken;
  detailTimer = setTimeout(() => {
    api.repo(nwo).then((record) => {
      remember(nwo, record);
      if (token !== detailToken) return;
      state.detail = { nwo, record, loading: false, error: null };
      invalidate('detail');
    }, (err) => {
      if (token !== detailToken) return;
      state.detail = { nwo, record: null, loading: false, error: `The full record could not be loaded: `
        + `${messageOf(err)}` };
      invalidate('detail');
    });
  }, 60);
}

/** Keep the URL on the card under the cursor (shareable, §10.2) without adding history entries. */
function followCursor() {
  if (!onShelfScreen()) return;
  const entry = currentEntry();
  if (entry) {
    state.route = { ...state.route, screen: 'repo', nwo: entry.nwo };
    const hash = toHash(state.route);
    if (g.location.hash !== hash) g.history?.replaceState?.(null, '', hash);
  }
  syncDetail();
}

function syncFilterInput() {
  const input = $('filter');
  if (input && doc.activeElement !== input) input.value = state.route.filters.q ?? '';
}

function onHash() {
  const raw = String(g.location.hash ?? '');
  if (raw && !raw.startsWith('#/')) return;
  const next = parseHash(raw);
  state.route = next;
  state.reasonMenu = null;
  state.chord = null;
  state.publishing = null;
  refresh();
  if (next.screen === 'repo' && next.nwo) {
    const e = state.byNwo.get(next.nwo.toLowerCase());
    if (e) state.triage = triageReducer(state.triage, { type: 'select', id: e.id });
    if (isNarrow()) state.detailOpen = true;
  }
  syncFilterInput();
  syncDetail();
  if (next.screen === 'calibrate' && !state.calibrate.loaded) void calLoad();
  if (next.screen === 'status') void statusLoad();
  invalidate();
}

/**
 * @param {import('../src/core/views.mjs').Filters} filters
 */
function setFilters(filters) {
  g.location.hash = toHash({ ...state.route, filters: normaliseFilters(filters) });
}

/** @param {number} delta */
function stepShelf(delta) {
  const i = Math.max(0, SHELF_NAMES.indexOf(state.route.shelf));
  const name = SHELF_NAMES[(i + delta + SHELF_NAMES.length) % SHELF_NAMES.length];
  g.location.hash = toHash({ screen: 'shelf', shelf: name, filters: state.route.filters });
}

/**
 * @param {string} id
 * @param {{open?: boolean}} [opts]
 */
function select(id, { open = false } = {}) {
  state.triage = triageReducer(state.triage, { type: 'select', id });
  if (state.reasonMenu && state.reasonMenu !== id) state.reasonMenu = null;
  if (open) state.detailOpen = true;
  followCursor();
  invalidate();
}

/** @param {number} delta */
function move(delta) {
  if (state.route.screen === 'calibrate') return calMove(delta);
  state.triage = triageReducer(state.triage, { type: delta > 0 ? 'next' : 'prev' });
  state.reasonMenu = null;
  followCursor();
  invalidate('main', 'detail');
  return undefined;
}

/**
 * @param {{event: Feedback, taste?: any}} res
 */
function applyDecision(res) {
  const prev = state.byId.get(res.event.id)?.feedback ?? null;
  /** @type {import('../src/core/views.mjs').TriageAction} */
  const decision = { type: 'decide', event: res.event, prev: /** @type {any} */ (prev) };
  state.triage = triageReducer(state.triage, decision);
  if (res.taste) state.taste = res.taste;
  state.reasonMenu = null;
  state.chord = null;
  refresh();
  followCursor();
  invalidate();
}

/**
 * Record a triage decision (§10.4) on the repository in view (`targetEntry`), or on the one named.
 * @param {Feedback['action']} action
 * @param {{reason?: string | null, id?: string | null, note?: string}} [opts]
 */
async function decide(action, { reason = null, id = null, note = '' } = {}) {
  const entry = id ? state.byId.get(id) : targetEntry();
  if (!entry) return;
  if (entry.lane === 'quarantine') {
    toast('Quarantined repositories are shown, never triaged', 'error');
    return;
  }
  const at = state.triage.ids.indexOf(entry.id);
  const body = makeFeedback({
    entry, action, reason: /** @type {any} */ (reason), note, now: nowIso(), view: state.route.shelf,
    position: at >= 0 ? at : null, model: state.model ?? state.index?.model ?? null,
  });
  try {
    const res = await api.feedback(body);
    applyDecision(res);
    toast(`${describe(res.event)} — press u to undo`);
    maybeHelpCard();
  } catch (err) {
    toast(messageOf(err), 'error');
  }
}

async function undoLast() {
  const item = state.triage.undo.at(-1);
  if (!item) {
    toast('Nothing to undo');
    return;
  }
  const entry = state.byId.get(item.event.id) ?? { id: item.event.id, nwo: item.event.nwo };
  const body = makeFeedback({
    entry: /** @type {any} */ (entry), action: 'undo', undoes: item.event.at, now: nowIso(),
    view: state.route.shelf, model: state.model ?? null,
  });
  try {
    const res = await api.feedback(body);
    state.triage = triageReducer(state.triage, { type: 'undo', event: res.event });
    if (res.taste) state.taste = res.taste;
    if (item.event.action === 'label') {
      const { [item.event.id]: _gone, ...labels } = state.calibrate.labels;
      state.calibrate = { ...state.calibrate, labels };
      state.helpLabelled.delete(item.event.id);
    }
    refresh();
    followCursor();
    toast(`Undone: ${describe(item.event)}`);
    invalidate();
  } catch (err) {
    toast(messageOf(err), 'error');
  }
}

/**
 * p (§10.3): unpublish anything still published — even after its gem was undone or replaced — else
 * open the note field on a saved gem.
 * @param {string | null} id
 */
function startPublish(id) {
  const entry = id ? state.byId.get(id) : null;
  if (!entry) return;
  const fb = /** @type {any} */ (entry.feedback) ?? {};
  if (fb.published) {
    void decide('unpublish', { id });
    return;
  }
  if (lastAction(fb) !== 'gem') {
    toast('Save it as a gem first (g); then p publishes it with a note.');
    return;
  }
  state.triage = triageReducer(state.triage, { type: 'select', id });
  state.publishing = { id, draft: '' };
  invalidate('main');
}

async function confirmPublish() {
  const p = state.publishing;
  if (!p) return;
  state.publishing = null;
  await decide('publish', { id: p.id, note: p.draft });
}

/**
 * @param {IndexEntry | null} entry
 */
function openOnGitHub(entry) {
  if (!entry) return;
  if (entry.lane === 'quarantine' || !isNwo(entry.nwo)) {
    toast('Quarantined repositories are never linked', 'error');
    return;
  }
  const href = `https://github.com/${entry.nwo}`;
  const a = el('a', { href, target: '_blank', rel: 'noopener noreferrer' });
  doc.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * @param {string} facet
 * @param {-1 | 0 | 1} value
 */
async function pin(facet, value) {
  try {
    const res = await api.pin(facet, value);
    state.taste = res.taste;
    refresh();
    invalidate();
    toast(value === 1 ? `Pinned ${facet}` : value === -1 ? `Muted ${facet}` : `Reset ${facet}`);
  } catch (err) {
    toast(messageOf(err), 'error');
  }
}

/** @returns {Set<string>} ids already given a blind label in this browser */
function labelledHere() {
  return labelledIds(api.localEvents());
}

/**
 * Draw Calibrate items: the server's draw of the day, or with `fresh` ("Draw again") a new one.
 * @param {{fresh?: boolean}} [opts]
 */
async function calLoad({ fresh = false } = {}) {
  state.calibrate = { ...state.calibrate, loading: true, error: null };
  invalidate('main');
  try {
    const res = await api.calibrate(20, fresh ? { seed: Math.floor(rand() * 2 ** 31) } : {});
    const done = labelledHere();
    const items = (Array.isArray(res?.items) ? res.items : []).filter((it) => !done.has(it.id));
    state.calibrate = { items, pos: 0, loading: false, error: null, labels: {}, loaded: true };
  } catch (err) {
    state.calibrate = { ...state.calibrate, loading: false, error: messageOf(err), loaded: true };
  }
  invalidate('main');
}

/** @param {number} delta */
function calMove(delta) {
  const n = state.calibrate.items.length;
  if (n === 0) return;
  const pos = Math.min(n - 1, Math.max(0, state.calibrate.pos + delta));
  state.calibrate = { ...state.calibrate, pos };
  invalidate('main');
}

/**
 * A blind label (§10.7): no score in the event's context, the item's stratum recorded.
 * @param {{id: string, nwo: string}} target
 * @param {string} label
 * @param {{stratum: 'sample' | 'pool', view: string}} opts
 */
async function blindLabel(target, label, { stratum, view }) {
  const body = makeFeedback({
    entry: { id: target.id, nwo: target.nwo }, action: 'label', label: /** @type {any} */ (label),
    blind: true, stratum, view, now: nowIso(), model: state.model ?? null,
  });
  const res = await api.feedback(body);
  // A label changes no queue state; the entry's standing state goes in as `prev` all the same, so
  // nothing can ever blank it.
  const prev = /** @type {any} */ (state.byId.get(target.id)?.feedback ?? null);
  state.triage = triageReducer(state.triage, { type: 'decide', event: res.event, prev });
  return res;
}

/**
 * @param {string} id
 * @param {string} label
 */
async function calLabel(id, label) {
  const item = state.calibrate.items.find((it) => it.id === id);
  if (!item) return;
  try {
    const stratum = item.stratum === 'sample' ? 'sample' : 'pool';
    await blindLabel(item, label, { stratum, view: 'calibrate' });
    state.calibrate = { ...state.calibrate, labels: { ...state.calibrate.labels, [id]: label } };
    invalidate('main');
    toast(`Labelled ${label} — press j for the next one`);
  } catch (err) {
    toast(messageOf(err), 'error');
  }
}

function maybeHelpCard() {
  if (state.helpCard || !state.index || !shouldOfferHelp(state.triage.decisions)) return;
  const labelled = new Set([...labelledHere(), ...Object.keys(state.calibrate.labels),
    ...state.helpLabelled]);
  const pick = pickHelpCalibrate(state.index.entries, { labelled, rand, skip: state.helpSkipped });
  if (!pick) return;
  state.helpCard = pick.id;
  invalidate('main');
}

/**
 * @param {string} id
 * @param {string} label
 */
async function helpLabel(id, label) {
  const entry = state.byId.get(id);
  if (!entry) return;
  try {
    await blindLabel(entry, label, { stratum: 'pool', view: 'help' });
    state.helpLabelled.add(id);
    state.helpCard = null;
    const lane = /** @type {Record<string, string>} */ (LANE_LABELS)[entry.lane] ?? entry.lane;
    const points = entry.S ?? '—';
    toast(`You said ${label}. Unsung gave it ${points} points (Quality ${pct(entry.quality)}), ${lane}.`);
    invalidate();
  } catch (err) {
    toast(messageOf(err), 'error');
  }
}

function skipHelp() {
  if (state.helpCard) state.helpSkipped.add(state.helpCard);
  state.helpCard = null;
  invalidate('main');
}

async function statusLoad() {
  state.status = { ...state.status, loading: true, error: null };
  invalidate('main');
  try {
    state.status = { loading: false, error: null, data: await api.status() };
  } catch (err) {
    state.status = { loading: false, error: messageOf(err), data: null };
  }
  invalidate('main');
}

/** @param {string} raw */
async function add(raw) {
  const nwo = String(raw ?? '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  if (!isNwo(nwo)) {
    state.adder = { busy: false, error: 'Write the repository as owner/name.', done: null };
    invalidate('main');
    return;
  }
  state.adder = { busy: true, error: null, done: null };
  invalidate('main');
  try {
    const res = await api.add(nwo);
    const rec = res?.record;
    const lane = rec?.score?.lane ?? rec?.lane;
    const laneText = lane ? `: ${/** @type {Record<string, string>} */ (LANE_LABELS)[lane] ?? lane}` : '';
    const points = typeof rec?.score?.S === 'number' ? ` with ${rec.score.S} points` : '';
    state.adder = { busy: false, error: null, done: `Added ${nwo}${laneText}${points}.` };
    records.delete(nwo);
    state.index = await api.index();
    refresh();
    g.location.hash = toHash({ screen: 'repo', shelf: state.route.shelf, nwo, filters: state.route.filters });
  } catch (err) {
    state.adder = { busy: false, error: messageOf(err), done: null };
  }
  invalidate();
}

function exportFeedback() {
  try {
    downloadJson(`unsung-feedback-${nowIso().slice(0, 10)}.json`, api.exportFeedback());
    toast('Exported. Merge it with: unsung feedback import <file>');
  } catch (err) {
    toast(`The export failed: ${messageOf(err)}`, 'error');
  }
}

/** @param {string} text */
async function copy(text) {
  try {
    await g.navigator.clipboard.writeText(text);
    toast('Copied the command');
  } catch {
    toast(`Copy it by hand: ${text}`);
  }
}

function escape() {
  const active = doc.activeElement;
  if (state.help) state.help = false;
  else if (state.publishing) state.publishing = null;
  else if (active && active !== doc.body && active.tagName !== 'BODY') active.blur?.();
  else if (state.chord || state.reasonMenu) {
    state.chord = null;
    state.reasonMenu = null;
  } else if (state.helpCard) return skipHelp();
  else if (state.detailOpen) state.detailOpen = false;
  else if (state.facetsOpen) state.facetsOpen = false;
  invalidate();
  return undefined;
}

/** @returns {string} the key map in force (§10.3) */
function keyMode() {
  if (state.help) return 'help';
  if (state.publishing) return 'dialog';
  const screen = state.route.screen;
  if (screen === 'calibrate') return 'calibrate';
  if (screen === 'taste' || screen === 'status') return 'browse';
  if (state.helpCard) return 'calibrate';
  if (state.route.shelf === 'quarantine') return 'quarantine';
  // An open reason menu takes the keys its buttons show (1–6), however it was opened.
  if (state.reasonMenu) return 'notgood';
  return 'queue';
}

/** @param {Action} a */
function onKey(a) {
  const act = String(a.action);
  if (act.startsWith('notgood:')) {
    const id = state.reasonMenu;
    state.chord = null;
    invalidate('toast');
    return void decide('notgood', { reason: act.slice('notgood:'.length), id });
  }
  if (act.startsWith('label:')) {
    const label = act.slice('label:'.length);
    if (state.route.screen === 'calibrate') {
      const item = state.calibrate.items[state.calibrate.pos];
      if (item) void calLabel(item.id, label);
    } else if (state.helpCard) void helpLabel(state.helpCard, label);
    return undefined;
  }
  switch (act) {
    case 'next': return move(1);
    case 'prev': return move(-1);
    case 'gem': case 'wip': case 'notmine': case 'snooze':
      return void decide(/** @type {any} */ (act));
    case 'chord':
      state.chord = 'notgood';
      return invalidate('toast', 'main', 'detail');
    case 'cancel':
      state.chord = null;
      state.reasonMenu = null;
      return invalidate('toast', 'main', 'detail');
    case 'undo': return void undoLast();
    case 'publish': return startPublish(targetEntry()?.id ?? null);
    case 'open': return openOnGitHub(targetEntry());
    case 'why':
      state.why = !state.why;
      return invalidate('detail');
    case 'filter': {
      const input = $('filter');
      input?.focus();
      input?.select?.();
      return undefined;
    }
    case 'prevShelf': return stepShelf(-1);
    case 'nextShelf': return stepShelf(1);
    case 'help':
      state.help = !state.help;
      return invalidate('overlay');
    case 'escape': return escape();
    case 'detail':
      if (isNarrow()) state.detailOpen = true;
      return invalidate();
    default: return undefined;
  }
}

/**
 * Every change to the explorer goes through here.
 * @param {Action} action
 * @returns {void}
 */
function dispatch(action) {
  switch (action.type) {
    case 'key': return onKey(action);
    case 'select': return select(action.id, { open: action.open === true && isNarrow() });
    case 'selectIndex':
      state.triage = triageReducer(state.triage, { type: 'select', index: action.index });
      followCursor();
      return invalidate('main', 'detail');
    case 'decide':
      return void decide(action.action, { reason: action.reason ?? null, id: action.id ?? null });
    case 'reasonMenu':
      state.reasonMenu = state.reasonMenu === action.id ? null : action.id;
      if (action.id) state.triage = triageReducer(state.triage, { type: 'select', id: action.id });
      return invalidate('main', 'detail');
    case 'publish': return startPublish(action.id ?? null);
    case 'publishDraft':
      if (state.publishing) state.publishing.draft = String(action.draft ?? '').slice(0, 280);
      return undefined;
    case 'publishConfirm': return void confirmPublish();
    case 'publishCancel':
      state.publishing = null;
      return invalidate('main');
    case 'why':
      state.why = !state.why;
      return invalidate('detail');
    case 'closeDetail':
      state.detailOpen = false;
      return invalidate();
    case 'filter': return setFilters({ ...state.route.filters, ...action.patch });
    case 'clearFilters': return setFilters(emptyFilters());
    case 'pin': return void pin(action.facet, action.pin);
    case 'calLabel': return void calLabel(action.id, action.label);
    case 'calMove': return calMove(action.delta);
    case 'calLoad': return void calLoad({ fresh: action.fresh === true });
    case 'helpLabel': return void helpLabel(action.id, action.label);
    case 'helpSkip': return skipHelp();
    case 'add': return void add(action.nwo);
    case 'retry': return void load();
    case 'export': return exportFeedback();
    case 'copy': return void copy(action.text);
    case 'scope':
      state.scope = String(action.lang ?? '');
      return invalidate('banner');
    case 'dismissFirstRun':
      writeFlag(FIRST_RUN_KEY);
      state.firstRun = false;
      return invalidate('banner');
    case 'firstRun':
      state.firstRun = true;
      return invalidate('banner');
    case 'help':
      state.help = !state.help;
      return invalidate('overlay');
    case 'facets':
      state.facetsOpen = !state.facetsOpen;
      return invalidate();
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

/** @returns {Promise<{explain: Function | null, toSafeBlocks: Function | null}>} */
async function loadLib() {
  /** @type {{explain: Function | null, toSafeBlocks: Function | null}} */
  const lib = { explain: null, toSafeBlocks: null };
  try {
    const m = await import('../src/core/explain.mjs');
    if (typeof m.explain === 'function') lib.explain = m.explain;
  } catch {
    // The Why panel explains from the index instead.
  }
  try {
    const m = await import('../src/core/readme.mjs');
    if (typeof m.toSafeBlocks === 'function') lib.toSafeBlocks = m.toSafeBlocks;
  } catch {
    // READMEs are shown as plain text instead.
  }
  return lib;
}

async function load() {
  state.phase = 'loading';
  state.error = null;
  invalidate();
  try {
    const [index, lib] = await Promise.all([api.index(), loadLib()]);
    state.index = index;
    state.mode = api.mode;
    state.lib = lib;
    const [taste, model] = await Promise.all([api.taste().catch(() => null), api.model().catch(() => null)]);
    state.taste = taste;
    state.model = model && (model.weights || model.calibration) ? model : index.model ?? null;
    state.firstRun = state.mode === 'examples' && !readFlag(FIRST_RUN_KEY);
    state.languages = languagesOf(index);
    state.suggestions = suggestionsOf(index);
    state.phase = 'ready';
    refresh();
    const route = state.route;
    if (route.screen === 'repo' && route.nwo) {
      const e = state.byNwo.get(route.nwo.toLowerCase());
      if (e) state.triage = triageReducer(state.triage, { type: 'select', id: e.id });
      state.detailOpen = isNarrow();
    }
    syncFilterInput();
    syncDetail();
    if (route.screen === 'calibrate') void calLoad();
    if (route.screen === 'status') void statusLoad();
  } catch (err) {
    state.phase = 'error';
    state.error = messageOf(err);
  }
  invalidate();
}

function wireStatic() {
  const input = $('filter');
  let timer = 0;
  input?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => dispatch({ type: 'filter', patch: { q: String(input.value ?? '') } }), 200);
  });
  input?.addEventListener('keydown', (/** @type {any} */ e) => {
    if (e.key === 'Enter') input.blur();
  });
  $('filters-toggle')?.addEventListener('click', () => dispatch({ type: 'facets' }));
  $('help-button')?.addEventListener('click', () => dispatch({ type: 'help' }));
}

function boot() {
  if (!doc || !regions.main) return;
  wireStatic();
  bindKeys(doc, (a) => dispatch(a), { mode: keyMode });
  g.addEventListener('hashchange', onHash);
  try {
    g.matchMedia?.(NARROW)?.addEventListener?.('change', () => invalidate());
  } catch {
    // Older browsers repaint on the next change instead.
  }
  void load();
}

boot();
