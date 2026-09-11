// @ts-check
/**
 * The explorer's frame (DESIGN §10.2): the shelves of the top bar with their counts, the last
 * run's time and points, the facet filters with live counts, the examples and first-run banner,
 * the help overlay and the status line.
 */

import { AGE_STEPS, EVIDENCE, SCREENS, SHELVES, STAR_STEPS, toHash } from '../../src/core/views.mjs';
import { KEY_HELP } from '../keys.mjs';
import { el, replace } from '../render.mjs';
import { REASONS, button, count, formatDate, kbd } from './parts.mjs';

/** @typedef {(action: Record<string, any>) => void} Dispatch */

/** Screen links after the shelves. */
export const SCREEN_LABELS = Object.freeze({ calibrate: 'Calibrate', taste: 'Taste', status: 'Status' });

/** Evidence facet names (§10.2). */
export const EVIDENCE_LABELS = Object.freeze({
  release: 'Ships releases', tests: 'Has tests', ci: 'CI verified', demo: 'Has a demo',
});

/**
 * The shelves and screens of the top bar.
 * @param {any} root
 * @param {{route: any, counts: Record<string, number>}} state
 * @returns {void}
 */
export function renderShelves(root, state) {
  const onShelf = state.route.screen === 'shelf' || state.route.screen === 'repo';
  const shelfLinks = SHELVES.map((s) => el('li', null, el('a', {
    href: toHash({ screen: 'shelf', shelf: s.name, filters: state.route.filters }),
    class: ['shelf', s.name === 'quarantine' ? 'shelf-q' : null],
    'aria-current': onShelf && state.route.shelf === s.name ? 'page' : null,
  }, [s.label, ' ', el('span', { class: 'count' }, count(state.counts?.[s.name] ?? 0))])));
  const screenLinks = SCREENS.map((name) => el('li', { class: 'screen-link' }, el('a', {
    href: toHash({ screen: name, shelf: state.route.shelf, filters: state.route.filters }),
    class: 'screen', 'aria-current': state.route.screen === name ? 'page' : null,
  }, /** @type {Record<string, string>} */ (SCREEN_LABELS)[name])));
  replace(root, el('ul', { class: 'shelves' }, [...shelfLinks, ...screenLinks]));
}

/**
 * The end of the top bar: the last run's time and GraphQL points, or what the explorer shows.
 * @param {any} root
 * @param {{mode: string, index: any}} state
 * @returns {void}
 */
export function renderRunInfo(root, state) {
  const run = state.index?.lastRun;
  if (state.mode === 'examples') {
    replace(root, el('span', { class: 'badge example' }, 'Examples'));
    return;
  }
  if (state.mode === 'static') {
    replace(root, el('span', { class: 'badge' }, 'Read-only copy'));
    return;
  }
  if (!run) {
    replace(root, el('span', { class: 'muted' }, 'No runs yet'));
    return;
  }
  const when = formatDate(run.endedAt ?? run.startedAt, { year: false, time: true });
  replace(root, el('span', { title: `Run ${run.runId ?? ''}` },
    `Last run ${when} · ${count(run.rate?.graphql?.points)} points`));
}

/**
 * One checkbox or radio option with its live count.
 * @param {string} name
 * @param {string} type
 * @param {string} label
 * @param {boolean} checked
 * @param {number | null} n
 * @param {() => void} onChange
 * @returns {any}
 */
function option(name, type, label, checked, n, onChange) {
  return el('label', { class: ['opt', n === 0 && !checked ? 'zero' : null] }, [
    el('input', { type, name, checked, onchange: onChange }),
    el('span', { class: 'opt-label' }, label),
    n === null ? null : el('span', { class: 'n' }, count(n)),
  ]);
}

/**
 * The twelve commonest languages, plus any chosen one beyond them.
 * @param {Record<string, number>} counts
 * @param {string[]} chosen
 * @returns {[string, number][]}
 */
function languageList(counts, chosen) {
  const langs = Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return [...langs.slice(0, 12), ...langs.slice(12).filter(([l]) => chosen.includes(l))];
}

/**
 * @param {any} f
 * @returns {boolean}
 */
function anyActive(f) {
  return Boolean(f.q || f.lang.length || f.age !== null || f.stars !== null || f.evidence.length
    || f.script.length || f.agent !== null || f.hidden);
}

/**
 * The facet filters (left), with live counts; their state lives in the URL hash (§10.2).
 * @param {any} root
 * @param {{route: any, facets: any, hiddenCount?: number}} state
 * @param {Dispatch} dispatch
 * @returns {void}
 */
export function renderFacets(root, state, dispatch) {
  const f = state.route.filters;
  const c = state.facets;
  if (!c) {
    replace(root);
    return;
  }
  /** @param {Record<string, unknown>} patch */
  const set = (patch) => dispatch({ type: 'filter', patch });
  /**
   * @param {string[]} list
   * @param {string} value
   */
  const toggle = (list, value) => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  const langTotal = Object.keys(c.lang).length;
  const langs = languageList(c.lang, f.lang).map(([lang, n]) => option('lang', 'checkbox',
    lang === 'none' ? 'No language' : lang, f.lang.includes(lang), n,
    () => set({ lang: toggle(f.lang, lang) })));
  const ages = AGE_STEPS.map((d) => option('age', 'radio', `${d} days or less`, f.age === d, c.age[d],
    () => set({ age: d })));
  const stars = STAR_STEPS.map((s) => option('stars', 'radio', s === 0 ? 'None yet' : `${s} or fewer`,
    f.stars === s, c.stars[s], () => set({ stars: s })));
  const evidence = EVIDENCE.map((k) => option('evidence', 'checkbox',
    /** @type {Record<string, string>} */ (EVIDENCE_LABELS)[k], f.evidence.includes(k), c.evidence[k],
    () => set({ evidence: toggle(f.evidence, k) })));
  const scripts = Object.entries(c.script).sort((a, b) => b[1] - a[1]).map(([s, n]) => option('script',
    'checkbox', s, f.script.includes(s), n, () => set({ script: toggle(f.script, s) })));
  const more = langTotal > 12
    ? el('p', { class: 'muted' }, `and ${langTotal - 12} more: type one in the filter`) : null;
  replace(root, [
    el('div', { class: 'facets-close' }, button('Done', { onClick: () => dispatch({ type: 'facets' }) })),
    el('h2', { class: 'sr-only' }, 'Filters'),
    el('fieldset', null, [el('legend', null, 'Language'), ...langs, more]),
    el('fieldset', null, [el('legend', null, 'Age'),
      option('age', 'radio', 'Any age', f.age === null, null, () => set({ age: null })), ...ages]),
    el('fieldset', null, [el('legend', null, 'Stars'),
      option('stars', 'radio', 'Any', f.stars === null, null, () => set({ stars: null })), ...stars]),
    el('fieldset', null, [el('legend', null, 'Evidence'), ...evidence]),
    scripts.length > 0 ? el('fieldset', null, [el('legend', null, 'README script'), ...scripts]) : null,
    el('fieldset', null, [el('legend', null, 'Agent-assisted'),
      option('agent', 'radio', 'Either', f.agent === null, null, () => set({ agent: null })),
      option('agent', 'radio', 'Only agent-assisted', f.agent === true, c.agent.yes,
        () => set({ agent: true })),
      option('agent', 'radio', 'Without agent files', f.agent === false, c.agent.no,
        () => set({ agent: false }))]),
    el('fieldset', null, [el('legend', { class: 'sr-only' }, 'Hidden entries'),
      option('hidden', 'checkbox', 'Show snoozed and dismissed', f.hidden, state.hiddenCount ?? null,
        () => set({ hidden: !f.hidden }))]),
    anyActive(f)
      ? button('Clear the filters', { cls: 'clear', onClick: () => dispatch({ type: 'clearFilters' }) })
      : null,
  ]);
}

/**
 * A scope value as one shell argument: as it is when it is a plain token (`Rust`, `C++`, `C#`),
 * else in double quotes with the characters that would still be special inside them removed
 * (`"Jupyter Notebook"`).
 * @param {string} value
 * @returns {string}
 */
export function shellArg(value) {
  const s = String(value);
  return /^[A-Za-z0-9+#._-]+$/.test(s) ? s : `"${s.replace(/["\\$`!]/g, '')}"`;
}

/**
 * The command the first-run panel offers for a quick scan of one scope ('' for all languages).
 * @param {string} scope
 * @returns {string}
 */
export function firstRunCommand(scope) {
  return `npm run unsung -- run${scope ? ` --lang ${shellArg(scope)}` : ''}`;
}

/**
 * The first-run panel (§10.2): a scope, the command for a quick scan, and a way to the examples.
 * The server never runs the census itself.
 * @param {{scope: string, languages: string[]}} state
 * @param {Dispatch} dispatch
 * @returns {any}
 */
function firstRunPanel(state, dispatch) {
  const command = firstRunCommand(state.scope);
  const scope = el('select', {
    id: 'scope', 'aria-label': 'Scope of the first scan',
    onchange: (/** @type {any} */ e) => dispatch({ type: 'scope', lang: String(e.target?.value ?? '') }),
  }, [
    el('option', { value: '', selected: state.scope === '' }, 'All languages'),
    ...state.languages.map((l) => el('option', { value: l, selected: state.scope === l }, l)),
  ]);
  return el('section', { class: 'first-run', 'aria-labelledby': 'first-run-title' }, [
    el('h2', { id: 'first-run-title' }, 'First run'),
    el('p', null, 'Unsung finds good repositories that almost nobody has noticed. '
      + 'It has not scanned GitHub yet.'),
    el('p', null, [el('label', { for: 'scope' }, 'Scope '), scope]),
    el('p', null, 'Run a quick scan: about ten minutes, read-only, well inside GitHub\'s limits.'),
    el('pre', { class: 'cmd' }, el('code', null, command)),
    el('div', { class: 'row' }, [
      button('Copy the command', { onClick: () => dispatch({ type: 'copy', text: command }) }),
      button('Browse the examples', {
        cls: 'primary', onClick: () => dispatch({ type: 'dismissFirstRun' }),
      }),
    ]),
    el('p', { class: 'muted' }, 'The explorer never runs the census itself; reload it when the scan '
      + 'has finished.'),
  ]);
}

/**
 * The banner under the top bar: examples and the first-run panel, a read-only copy, or an error.
 * @param {any} root
 * @param {{phase: string, error: string | null, mode: string, firstRun: boolean, scope: string,
 *   languages: string[]}} state
 * @param {Dispatch} dispatch
 * @returns {void}
 */
export function renderBanner(root, state, dispatch) {
  if (state.phase === 'error') {
    replace(root, el('div', { class: 'banner error', role: 'alert' }, [
      el('p', null, state.error ?? 'The index could not be loaded.'),
      button('Try again', { onClick: () => dispatch({ type: 'retry' }) }),
    ]));
    return;
  }
  if (state.mode === 'static') {
    replace(root, el('div', { class: 'banner static' }, [
      el('p', null, [el('b', null, 'Read-only copy. '), 'Your decisions stay in this browser. '
        + 'Export them and merge them with ', el('code', null, 'unsung feedback import'), '.']),
      button('Export decisions', { onClick: () => dispatch({ type: 'export' }) }),
    ]));
    return;
  }
  if (state.mode !== 'examples') {
    replace(root);
    return;
  }
  replace(root, [
    el('div', { class: 'banner examples' }, [
      el('p', null, [el('b', null, 'Examples. '), 'These are repositories from Unsung\'s test '
        + 'fixtures, scored on recorded data. Your decisions on them stay in this browser.']),
      state.firstRun ? null : button('How to run a scan', { onClick: () => dispatch({ type: 'firstRun' }) }),
    ]),
    state.firstRun ? firstRunPanel(state, dispatch) : null,
  ]);
}

/**
 * Key caps for one line of the help sheet: `j / k`, `x then 1–6`, `g w c p s d x e`.
 * @param {string} keys
 * @returns {any[]}
 */
function keyCaps(keys) {
  const parts = keys.split(' ');
  return parts.map((part) => {
    if (part === '/' && parts.length > 1) return ' / ';
    if (part === 'then') return ' then ';
    return [kbd(part), ' '];
  });
}

/**
 * The help overlay (`?`).
 * @param {any} root
 * @param {{help: boolean}} state
 * @param {Dispatch} dispatch
 * @returns {void}
 */
export function renderOverlay(root, state, dispatch) {
  if (!state.help) {
    root.hidden = true;
    replace(root);
    return;
  }
  root.hidden = false;
  const rows = KEY_HELP.map((k) => el('tr', null, [
    el('th', { scope: 'row' }, keyCaps(k.keys)),
    el('td', null, k.what),
  ]));
  const attrs = { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'help-title' };
  replace(root, el('div', attrs, [
    el('h2', { id: 'help-title' }, 'Keys'),
    el('table', { class: 'keys' }, el('tbody', null, rows)),
    el('p', { class: 'muted' }, 'Keys do nothing while you type in a field; Escape leaves it.'),
    button('Close', { key: 'Esc', cls: 'primary', onClick: () => dispatch({ type: 'help' }) }),
  ]));
}

/**
 * The status line: the "not good" chord hint, or the latest message.
 * @param {any} root
 * @param {{chord: string | null, toast: {text: string, kind: string} | null}} state
 * @returns {void}
 */
export function renderToast(root, state) {
  if (state.chord === 'notgood') {
    const reasons = REASONS.map((r) => [kbd(r.key), ` ${r.label} `]);
    const hint = ['Not good: ', ...reasons, '· ', kbd('Esc'), ' cancel'];
    replace(root, el('p', { class: 'toast chord' }, hint));
    return;
  }
  replace(root, state.toast ? el('p', { class: ['toast', state.toast.kind] }, state.toast.text) : null);
}
