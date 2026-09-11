// @ts-check
/**
 * The queue (DESIGN §10.2): dense cards for the current shelf — name, description, language and
 * age; the Quality meter, the Confidence pill and a muted Attention strip; up to three reason
 * lines; descriptor chips; the verdict pitch. Low-coverage scores are hatched. Every twentieth
 * decision a "help calibrate" card asks for a blind label (§10.6). 50 cards show at a time.
 */

import { SHELVES, toHash } from '../../src/core/views.mjs';
import { el, replace, safeLink } from '../render.mjs';
import {
  ageText, attentionStrip, button, confidencePill, descriptorChips, formatDate, kbd, labelButtons,
  laneBadge, qualityMeter, reasonList, repoName, signed, triageBar,
} from './parts.mjs';

/** @typedef {import('../../src/core/schema.mjs').IndexEntry} IndexEntry */
/** @typedef {(action: Record<string, any>) => void} Dispatch */

/** Cards shown at once. */
export const PAGE_SIZE = 50;

/** One line under each shelf's title, saying what it holds (§6.7). */
export const SHELF_NOTES = Object.freeze({
  promising: 'Gem-band repositories (7 points or more) that little yet corroborates. '
    + 'Fresh solo work lives here.',
  proven: 'Gem-band repositories with corroboration that is costly to fake (confidence 0.5 or more).',
  look: 'Five or six points: often good work caught early, sometimes a near miss.',
  foryou: 'Promising, Proven and Worth a look, reordered by your taste within each quality band. '
    + 'Every tenth card is a wildcard from outside your usual taste.',
  saved: 'Gems you saved, newest first. Press p to publish one to your gallery with a note.',
  doubted: 'A gate or a reviewer doubts these: a tutorial clone, a template, or text aimed at an '
    + 'AI reviewer.',
  institutional: 'Repositories of large organisations or on the allowlist: niche rather than overlooked.',
  rising: 'Gained ten or more stars in four weeks: people are already noticing.',
  graduated: 'More than 25 stars: no longer unsung.',
  quarantine: 'Held back by a hard gate; shown as identity and reasons only.',
});

/**
 * @typedef {object} QueueState
 * @property {{shelf: string, filters: any}} route
 * @property {IndexEntry[]} list the shelf's entries, in order
 * @property {{ids: string[], pos: number, decisions: number}} triage
 * @property {Map<string, {t: number, wildcard: boolean}> | null} [tasteTerms] For you only
 * @property {string | null} [reasonMenu] the card whose "not good" reasons are open
 * @property {string | null} [chord] `notgood` after x
 * @property {{id: string, draft: string} | null} [publishing] the card whose note field is open
 * @property {IndexEntry | null} [helpCard] a blind "help calibrate" entry
 * @property {number} [hiddenCount] entries left out as snoozed or dismissed
 * @property {boolean} [filtered] whether any facet filter is active
 * @property {string} now
 */

/**
 * Whether a click landed on a control inside a card (so it should not open the detail overlay).
 * @param {any} target
 * @returns {boolean}
 */
function onControl(target) {
  return Boolean(target?.closest?.('button, a, input, textarea, select, label'));
}

/**
 * The note field that `p` opens on a saved gem (§10.3): the curator's note travels with the pick.
 * @param {IndexEntry} entry
 * @param {string} draft
 * @param {Dispatch} dispatch
 * @returns {any}
 */
function publishPanel(entry, draft, dispatch) {
  const area = el('textarea', {
    id: 'publish-note', maxlength: 280, rows: 3, value: draft,
    'aria-label': 'Note for the gallery (280 characters at most)',
    placeholder: 'Why is it worth a look? This note appears in your gallery.',
    oninput: (/** @type {any} */ e) => dispatch({
      type: 'publishDraft', draft: String(e.target?.value ?? ''),
    }),
  });
  return el('div', { class: 'publish-panel', role: 'group', 'aria-label': 'Publish to the gallery' }, [
    el('label', { for: 'publish-note' }, 'Note for the gallery'),
    area,
    el('div', { class: 'row' }, [
      button('Publish', {
        cls: 'primary', onClick: () => dispatch({ type: 'publishConfirm', id: entry.id }),
      }),
      button('Cancel', { key: 'Esc', onClick: () => dispatch({ type: 'publishCancel' }) }),
      el('span', { class: 'muted' }, 'This marks it for unsung export; nothing leaves this computer.'),
    ]),
  ]);
}

/**
 * @param {IndexEntry} entry
 * @param {QueueState} state
 * @param {Dispatch} dispatch
 * @param {number} index position in the shelf
 * @returns {any}
 */
function card(entry, state, dispatch, index) {
  const selected = state.triage.ids[state.triage.pos] === entry.id;
  const fb = /** @type {any} */ (entry.feedback) ?? {};
  const saved = (typeof fb.last === 'string' ? fb.last : fb.last?.action) === 'gem';
  const snoozed = typeof fb.snoozeUntil === 'string' && Date.parse(fb.snoozeUntil) > Date.parse(state.now);
  const incomplete = typeof entry.coverage === 'number' && entry.coverage < 0.8;
  const taste = state.tasteTerms?.get(entry.id);
  const showLane = state.route.shelf === 'foryou' || state.route.shelf === 'saved';
  const publishing = state.publishing?.id === entry.id ? state.publishing : null;
  const tasteChip = taste ? el('span', {
    class: ['taste', taste.wildcard ? 'wild' : null],
    title: 'Taste reorders For you within a quality band; it never changes points',
  }, taste.wildcard ? 'Wildcard' : `Taste ${signed(taste.t, 2)}`) : null;
  const until = snoozed ? `Snoozed until ${formatDate(fb.snoozeUntil, { year: false })}` : null;
  const menuOpen = state.reasonMenu === entry.id || state.chord === 'notgood';
  const { shelf, filters } = state.route;
  const href = toHash({ screen: 'repo', shelf, nwo: entry.nwo, filters });
  return el('li', {
    class: ['card', selected ? 'selected' : null, incomplete ? 'hatched-card' : null],
    id: `card-${index}`, dataset: { id: entry.id }, 'aria-current': selected ? 'true' : null,
    onclick: (/** @type {any} */ e) => dispatch({
      type: 'select', id: entry.id, open: !onControl(e?.target),
    }),
  }, [
    el('div', { class: 'card-head' }, [
      repoName(entry.nwo, { href }),
      entry.lang ? el('span', { class: 'lang' }, entry.lang) : null,
      el('span', { class: 'age', title: `Created ${formatDate(entry.createdAt)}` }, ageText(entry.ageDays)),
      showLane ? laneBadge(entry.lane) : null,
      fb.published ? el('span', { class: 'badge published' }, 'Published') : null,
      until ? el('span', { class: 'badge snoozed' }, until) : null,
      tasteChip,
    ]),
    entry.description ? el('p', { class: 'desc' }, entry.description) : null,
    el('div', { class: 'meters' }, [qualityMeter(entry), confidencePill(entry), attentionStrip(entry)]),
    reasonList(entry),
    el('div', { class: 'card-foot' }, [
      descriptorChips(entry.descriptors),
      entry.verdict?.pitch
        ? el('p', { class: 'pitch', title: `Reviewer category ${entry.verdict.category}` },
          `“${entry.verdict.pitch}”`)
        : null,
    ]),
    selected ? triageBar(entry, dispatch, { reasonMenu: menuOpen, saved, published: Boolean(fb.published) })
      : null,
    publishing ? publishPanel(entry, publishing.draft, dispatch) : null,
  ]);
}

/**
 * The blind "help calibrate" card (§10.6): no score, no stars, no verdict until it is labelled.
 * @param {IndexEntry} entry
 * @param {Dispatch} dispatch
 * @returns {any}
 */
function helpCard(entry, dispatch) {
  return el('li', { class: ['card', 'blind-card'], 'aria-label': 'Help calibrate' }, [
    el('div', { class: 'card-head' }, [
      el('span', { class: 'badge help' }, 'Help calibrate'),
      repoName(entry.nwo, { link: false }),
      entry.lang ? el('span', { class: 'lang' }, entry.lang) : null,
    ]),
    entry.description ? el('p', { class: 'desc' }, entry.description) : null,
    el('p', { class: 'muted' }, 'Label this one without its score: which of the eight is it? '
      + 'The score appears once you have chosen.'),
    el('p', null, safeLink(`https://github.com/${entry.nwo}`, 'Open on GitHub')),
    labelButtons((label) => dispatch({ type: 'helpLabel', id: entry.id, label })),
    el('div', { class: 'row' }, [
      button('Skip', { key: 'Esc', onClick: () => dispatch({ type: 'helpSkip' }) }),
    ]),
  ]);
}

/**
 * Render the queue of the current shelf.
 * @param {any} root
 * @param {QueueState} state
 * @param {Dispatch} dispatch
 * @returns {void}
 */
export function render(root, state, dispatch) {
  const name = state.route.shelf;
  const def = SHELVES.find((s) => s.name === name) ?? SHELVES[0];
  const list = state.list;
  const pos = state.triage.pos;
  const start = pos >= 0 ? Math.floor(pos / PAGE_SIZE) * PAGE_SIZE : 0;
  const page = list.slice(start, start + PAGE_SIZE);
  const note = /** @type {Record<string, string>} */ (SHELF_NOTES)[name] ?? '';
  const hidden = state.hiddenCount ?? 0;
  const empty = list.length === 0;
  const sorted = name === 'foryou' || name === 'saved'
    ? null : el('p', { class: 'sort-note' }, 'Sorted by rank, then fewest stars, then newest.');
  const emptyNote = state.filtered ? 'Nothing on this shelf matches your filters.' : 'Nothing on this shelf.';
  const pager = list.length > PAGE_SIZE ? el('nav', { class: 'pager', 'aria-label': 'Pages' }, [
    button('Previous 50', {
      disabled: start === 0,
      onClick: () => dispatch({ type: 'selectIndex', index: Math.max(0, start - PAGE_SIZE) }),
    }),
    el('span', null, `${start + 1}–${Math.min(list.length, start + PAGE_SIZE)} of ${list.length}`),
    button('Next 50', {
      disabled: start + PAGE_SIZE >= list.length,
      onClick: () => dispatch({ type: 'selectIndex', index: start + PAGE_SIZE }),
    }),
  ]) : null;
  replace(root, [
    el('header', { class: 'queue-head' }, [
      el('h1', null, [def.label, ' ', el('span', { class: 'count' }, String(list.length))]),
      el('p', { class: 'shelf-note' }, note),
      sorted,
    ]),
    el('ol', { class: 'cards', 'aria-label': `${def.label} queue` }, [
      state.helpCard ? helpCard(state.helpCard, dispatch) : null,
      ...page.map((e, i) => card(e, state, dispatch, start + i)),
    ]),
    empty ? el('div', { class: 'empty' }, [
      el('p', null, emptyNote),
      state.filtered
        ? button('Clear the filters', { onClick: () => dispatch({ type: 'clearFilters' }) }) : null,
    ]) : null,
    hidden > 0 && !state.route.filters?.hidden ? el('p', { class: 'hidden-note' }, [
      `${hidden} snoozed or dismissed ${hidden === 1 ? 'is' : 'are'} not shown. `,
      button('Show them', { onClick: () => dispatch({ type: 'filter', patch: { hidden: true } }) }),
    ]) : null,
    pager,
    empty ? null : el('p', { class: 'key-hint' }, [kbd('j'), ' ', kbd('k'), ' move · ', kbd('g'), ' gem · ',
      kbd('x'), ' not good · ', kbd('e'), ' why · ', kbd('?'), ' all keys']),
  ]);
}
