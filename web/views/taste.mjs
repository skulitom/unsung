// @ts-check
/**
 * The Taste screen (DESIGN §10.2, §10.6): facet affinities as chips with pin, mute and reset. Taste
 * only reorders the For you shelf, within quality bands; it never changes points, quality or
 * confidence. "Not my thing" is never a quality judgement.
 */

import { affinity } from '../../src/core/taste.mjs';
import { el, replace } from '../render.mjs';
import { button, count, signed } from './parts.mjs';

/** @typedef {import('../../src/core/schema.mjs').TasteState} TasteState */
/** @typedef {(action: Record<string, any>) => void} Dispatch */

/** Facet kinds as the UI names them (§10.6). */
export const FACET_KINDS = Object.freeze({
  lang: 'Language', topic: 'Topic', owner: 'Owner', script: 'README script', kind: 'Kind',
});

/**
 * @param {string} facet
 * @returns {{kind: string, value: string}}
 */
export function facetLabel(facet) {
  const i = facet.indexOf(':');
  const kind = i < 0 ? facet : facet.slice(0, i);
  const name = /** @type {Record<string, string>} */ (FACET_KINDS)[kind] ?? kind;
  return { kind: name, value: facet.slice(i + 1) };
}

/**
 * One facet with its affinity, counts and the pin, mute and reset buttons.
 * @param {string} facet
 * @param {{gems: number, notmine: number, pin: number} | null} info
 * @param {TasteState | null} taste
 * @param {Dispatch} dispatch
 * @returns {any}
 */
function facetRow(facet, info, taste, dispatch) {
  const a = affinity(taste, facet);
  const pin = info?.pin ?? 0;
  const { kind, value } = facetLabel(facet);
  const counts = info && (info.gems > 0 || info.notmine > 0)
    ? `${count(info.gems)} ${info.gems === 1 ? 'gem' : 'gems'} · ${count(info.notmine)} not my thing`
    : 'nothing learnt yet';
  /** @param {number} to */
  const setPin = (to) => () => dispatch({ type: 'pin', facet, pin: to });
  return el('li', { class: ['facet-row', pin === 1 ? 'pinned' : pin === -1 ? 'muted-facet' : null] }, [
    el('span', { class: 'facet-kind' }, kind),
    el('span', { class: 'facet-value' }, value),
    el('span', {
      class: ['alpha', a > 0 ? 'pos' : a < 0 ? 'neg' : null],
      title: 'Affinity: ln((gems + 1) / (not my thing + 1)), or ±0.7 when pinned or muted',
    }, signed(a, 2)),
    el('span', { class: 'facet-counts' }, counts),
    el('span', { class: 'facet-actions', role: 'group', 'aria-label': `Taste for ${kind} ${value}` }, [
      button('Pin', { pressed: pin === 1, onClick: setPin(pin === 1 ? 0 : 1) }),
      button('Mute', { pressed: pin === -1, onClick: setPin(pin === -1 ? 0 : -1) }),
      button('Reset', { disabled: pin === 0, onClick: setPin(0) }),
    ]),
  ]);
}

/**
 * Render the Taste screen.
 * @param {any} root
 * @param {{taste: TasteState | null, suggestions?: string[], mode?: string}} state
 * @param {Dispatch} dispatch
 * @returns {void}
 */
export function render(root, state, dispatch) {
  const taste = state.taste;
  const entries = Object.entries(taste?.facets ?? {});
  /** @param {string} f */
  const strength = (f) => Math.abs(affinity(taste, f));
  entries.sort(([fa], [fb]) => strength(fb) - strength(fa) || (fa < fb ? -1 : 1));
  const known = new Set(entries.map(([f]) => f));
  const suggestions = (state.suggestions ?? []).filter((f) => !known.has(f)).slice(0, 16);
  const local = state.mode === 'examples' || state.mode === 'static';
  replace(root, el('section', { class: 'screen taste-screen' }, [
    el('h1', null, 'Taste'),
    el('p', null, 'Taste only reorders the For you shelf, and only within a quality band: it never '
      + 'changes points, quality or confidence. Saving a gem (g) adds to each of its facets; '
      + '"not my thing" (n) subtracts.'),
    local ? el('p', { class: 'note' }, 'Your taste here is kept in this browser.') : null,
    entries.length === 0
      ? el('p', { class: 'empty' }, 'No taste yet. Save a few gems or mark some as not your thing, '
        + 'and it will appear here.')
      : el('ul', { class: 'facet-list', 'aria-label': 'Learnt facets' },
        entries.map(([f, info]) => facetRow(f, info, taste, dispatch))),
    suggestions.length > 0 ? el('section', null, [
      el('h2', null, 'Facets in the index'),
      el('p', { class: 'muted' }, 'Pin or mute one before you have triaged anything.'),
      el('ul', { class: 'facet-list' }, suggestions.map((f) => facetRow(f, null, taste, dispatch))),
    ]) : null,
  ]));
}
