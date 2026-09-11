// @ts-check
/**
 * The Calibrate tab (DESIGN §10.7): blind labelling. Only the description, the README (through the
 * safe renderer), a tree summary and the language are shown; no points, chips, stars or verdict
 * until the label is given, and then the score is revealed. Labels are stored with `blind: true`
 * and the item's stratum (`sample` from the uniform ID walk, `pool` from the enriched pool).
 */

import { el, replace } from '../render.mjs';
import { readmeView, treeView } from './detail.mjs';
import { CATEGORIES, button, labelButtons, laneBadge, pct, qualityMeter, repoName } from './parts.mjs';

/** @typedef {import('../../src/core/schema.mjs').IndexEntry} IndexEntry */
/** @typedef {(action: Record<string, any>) => void} Dispatch */

/**
 * @typedef {object} CalibrateState
 * @property {{items: any[], pos: number, loading: boolean, error: string | null,
 *   labels: Record<string, string>}} calibrate
 * @property {Map<string, IndexEntry>} byId
 * @property {{toSafeBlocks?: Function | null}} lib
 * @property {string} [mode]
 */

/**
 * What Unsung made of it, shown once the label is given.
 * @param {string} chosen
 * @param {IndexEntry | undefined} entry
 * @returns {any}
 */
function reveal(chosen, entry) {
  const name = /** @type {Record<string, string[]>} */ (CATEGORIES)[chosen]?.[0] ?? chosen;
  if (!entry || entry.lane === 'quarantine') {
    return el('div', { class: 'reveal', role: 'status' }, [
      el('p', null, `You said ${chosen}: ${name}.`),
      el('p', { class: 'muted' }, 'This one is not in the index, so there is no score to compare.'),
    ]);
  }
  const gemBand = entry.band === 'gem';
  const agrees = (chosen === 'G' || chosen === 'W') === gemBand;
  return el('div', { class: 'reveal', role: 'status' }, [
    el('p', null, [`You said ${chosen}: ${name}. Unsung gave it ${entry.S ?? '—'} points (Quality `
      + `${pct(entry.quality)}), `, laneBadge(entry.lane), '.']),
    qualityMeter(entry),
    el('p', { class: 'muted' }, agrees ? 'You and the checklist agree.'
      : 'You and the checklist disagree — exactly what these labels are for.'),
  ]);
}

/**
 * Render the Calibrate tab.
 * @param {any} root
 * @param {CalibrateState} state
 * @param {Dispatch} dispatch
 * @returns {void}
 */
export function render(root, state, dispatch) {
  const cal = state.calibrate;
  const intro = [
    el('h1', null, 'Calibrate'),
    el('p', null, 'Label without the score: decide from the description, the README and the tree, as in the '
      + 'labelling guide. The score appears once you have labelled. Keys: g w c p s d x e.'),
  ];
  if (cal.loading) {
    const wait = el('p', { role: 'status' }, 'Drawing items to label…');
    replace(root, el('section', { class: 'screen calibrate' }, [...intro, wait]));
    return;
  }
  if (cal.error || cal.items.length === 0) {
    replace(root, el('section', { class: 'screen calibrate' }, [
      ...intro,
      cal.error ? el('p', { class: 'error', role: 'alert' }, cal.error) : null,
      el('p', { class: 'empty' }, state.mode === 'static' ? 'A read-only copy has nothing to calibrate.'
        : 'Nothing to label yet. npm run unsung -- sample draws a uniform sample for blind labelling.'),
      button('Draw again', { onClick: () => dispatch({ type: 'calLoad', fresh: true }) }),
    ]));
    return;
  }
  const pos = Math.min(Math.max(cal.pos, 0), cal.items.length - 1);
  const item = cal.items[pos];
  const chosen = cal.labels[item.id] ?? null;
  replace(root, el('section', { class: 'screen calibrate' }, [
    ...intro,
    el('p', { class: 'progress' }, `${pos + 1} of ${cal.items.length} · `
      + `${item.stratum === 'sample' ? 'uniform sample' : 'enriched pool'}`),
    el('article', { class: 'blind', 'aria-label': 'Item to label' }, [
      el('h2', null, repoName(item.nwo, { link: false })),
      item.description ? el('p', { class: 'desc' }, item.description)
        : el('p', { class: 'muted' }, 'No description.'),
      item.lang ? el('p', null, el('span', { class: 'lang' }, item.lang)) : null,
      labelButtons((label) => dispatch({ type: 'calLabel', id: item.id, label }), { chosen }),
      chosen ? reveal(chosen, state.byId.get(item.id))
        : el('p', { class: 'muted' }, 'The score stays hidden until you label.'),
      el('details', { class: 'section', open: true }, [el('summary', null, 'README'),
        readmeView({ readme: item.readme }, state.lib)]),
      el('details', { class: 'section', open: true }, [el('summary', null, 'Tree'), treeView(item.tree)]),
    ]),
    el('nav', { class: 'pager', 'aria-label': 'Items' }, [
      button('Previous', { key: 'k', disabled: pos === 0,
        onClick: () => dispatch({ type: 'calMove', delta: -1 }) }),
      button('Next', { key: 'j', disabled: pos >= cal.items.length - 1,
        onClick: () => dispatch({ type: 'calMove', delta: 1 }) }),
      button('Draw again', { onClick: () => dispatch({ type: 'calLoad', fresh: true }) }),
    ]),
  ]));
}
