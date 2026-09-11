// @ts-check
/**
 * The Status screen (DESIGN §10.2): recent runs, the ledger by state, the lock, the budget the last
 * run spent and source health — plus "add a repository", which asks the server to enrich, deepen
 * and score one repository now (`POST /api/add`). The server never runs the census itself.
 */

import { el, replace } from '../render.mjs';
import { button, count, formatDate } from './parts.mjs';

/** @typedef {(action: Record<string, any>) => void} Dispatch */

/**
 * @typedef {object} StatusState
 * @property {{loading: boolean, error: string | null, data: any}} status
 * @property {{busy: boolean, error: string | null, done: string | null}} adder
 * @property {string} [mode]
 */

/**
 * `4m 05s` between a start and an end (ISO strings or milliseconds).
 * @param {unknown} start
 * @param {unknown} end
 * @returns {string}
 */
export function took(start, end) {
  /** @param {unknown} v */
  const ms = (v) => (typeof v === 'number' ? v : Date.parse(String(v ?? '')));
  const d = ms(end) - ms(start);
  if (!Number.isFinite(d) || d < 0) return '—';
  const s = Math.round(d / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function valueText(v) {
  return typeof v === 'number' ? count(v) : String(v);
}

/**
 * One stage of a run summary as `key value · key value`, nested counts flattened.
 * @param {unknown} stage
 * @returns {string}
 */
export function stageLine(stage) {
  if (!stage || typeof stage !== 'object') return '—';
  return Object.entries(/** @type {Record<string, unknown>} */ (stage)).map(([k, v]) => {
    if (Array.isArray(v)) return `${k} ${v.map(String).join(', ') || 'none'}`;
    if (v && typeof v === 'object') {
      const inner = Object.entries(v).map(([ik, iv]) => `${ik} ${valueText(iv)}`);
      return `${k} ${inner.join(', ') || 'none'}`;
    }
    return `${k} ${valueText(v)}`;
  }).join(' · ');
}

/**
 * @param {any[]} runs
 * @returns {any}
 */
function runsTable(runs) {
  if (runs.length === 0) return el('p', { class: 'muted' }, 'No runs recorded yet.');
  const head = ['Started', 'Profile', 'Took', 'Exit', 'Found', 'Enriched', 'Gems', 'GraphQL points'];
  const rows = runs.map((r) => {
    const st = r?.stages ?? {};
    const found = (Number(st.census?.seeds) || 0) + (Number(st.archive?.seeds) || 0);
    return el('tr', null, [
      el('td', null, formatDate(r?.startedAt, { time: true })),
      el('td', null, String(r?.profile ?? '—')),
      el('td', null, took(r?.startedAt, r?.endedAt)),
      el('td', null, r?.exit ? `${r.exit.code ?? '—'} ${r.exit.reason ?? ''}`.trim() : 'running'),
      el('td', { class: 'num' }, count(found)),
      el('td', { class: 'num' }, count(st.enrich?.repos)),
      el('td', { class: 'num' }, count(st.score?.gem)),
      el('td', { class: 'num' }, count(r?.rate?.graphql?.points)),
    ]);
  });
  return el('div', { class: 'table-wrap' }, el('table', { class: 'runs' }, [
    el('thead', null, el('tr', null, head.map((h) => el('th', { scope: 'col' }, h)))),
    el('tbody', null, rows),
  ]));
}

/**
 * @param {any} rate
 * @returns {any}
 */
function budget(rate) {
  if (!rate) return el('p', { class: 'muted' }, 'No budget recorded yet.');
  const g = rate.graphql ?? {};
  const r = rate.rest ?? {};
  const pauses = Array.isArray(rate.pauses) ? rate.pauses : [];
  const pauseText = pauses.map((p) => `${p.resource ?? '?'} ${took(0, Number(p.ms) || 0)} `
    + `(${p.why ?? 'unknown'})`).join('; ');
  return el('ul', { class: 'facts' }, [
    el('li', null, `GraphQL: ${count(g.points)} points, ${took(0, Number(g.serverMs) || 0)} of `
      + `response time, ${count(g.remaining)} points left`),
    el('li', null, `REST: ${count(r.calls)} calls (${count(r.notModified)} not modified), `
      + `${count(r.remaining)} left`),
    el('li', null, pauses.length === 0 ? 'No pauses.' : `Pauses: ${pauseText}`),
  ]);
}

/**
 * The "add a repository" field (no form element: the page's CSP forbids form submission).
 * @param {StatusState} state
 * @param {any} data
 * @param {Dispatch} dispatch
 * @returns {any}
 */
function adder(state, data, dispatch) {
  const can = Boolean(data?.canAdd) && state.mode === 'server';
  const input = el('input', {
    id: 'add-nwo', type: 'text', placeholder: 'owner/name', autocomplete: 'off', spellcheck: 'false',
    'aria-label': 'Repository to add, as owner/name', disabled: !can || state.adder.busy,
    onkeydown: (/** @type {any} */ e) => {
      if (e.key === 'Enter') dispatch({ type: 'add', nwo: String(e.target?.value ?? '') });
    },
  });
  const why = state.mode === 'server'
    ? 'Adding needs the store, GitHub access and the full configuration; one of them is not available yet.'
    : 'Adding needs the local explorer with its store (npm start).';
  return el('section', null, [
    el('h2', null, 'Add a repository'),
    el('p', { class: 'muted' }, 'Enrich, deepen, score and explain one repository now: about two '
      + 'seconds and one or two GraphQL points.'),
    el('div', { class: 'row' }, [input, button(state.adder.busy ? 'Adding…' : 'Add', {
      cls: 'primary', disabled: !can || state.adder.busy,
      onClick: () => dispatch({ type: 'add', nwo: String(input.value ?? '') }),
    })]),
    can ? null : el('p', { class: 'muted' }, why),
    state.adder.error ? el('p', { class: 'error', role: 'alert' }, state.adder.error) : null,
    state.adder.done ? el('p', { class: 'note', role: 'status' }, state.adder.done) : null,
  ]);
}

/**
 * @param {any} lock
 * @returns {string}
 */
function lockLine(lock) {
  if (!lock) return 'Free: no run is in progress.';
  const since = formatDate(lock.startedAt, { time: true });
  const how = lock.live ? 'running' : 'stale: the next run takes it over';
  return `Held by ${lock.runId ?? 'an unknown run'} since ${since} (${how})`;
}

/**
 * Render the Status screen.
 * @param {any} root
 * @param {StatusState} state
 * @param {Dispatch} dispatch
 * @returns {void}
 */
export function render(root, state, dispatch) {
  const { loading, error, data } = state.status;
  const runs = Array.isArray(data?.runs) ? data.runs : [];
  const units = data?.units && typeof data.units === 'object' ? Object.entries(data.units) : [];
  const last = runs[0] ?? null;
  const sources = last?.stages
    ? el('ul', { class: 'facts' }, Object.entries(last.stages).map(([name, stage]) =>
      el('li', null, [el('b', null, name), ` ${stageLine(stage)}`])))
    : el('p', { class: 'muted' }, 'Nothing yet.');
  replace(root, el('section', { class: 'screen status' }, [
    el('h1', null, 'Status'),
    state.mode === 'examples' ? el('p', { class: 'note' }, 'No runs yet: the explorer is showing the '
      + 'examples. Run a quick scan with npm run unsung -- run, and reload this page when it has finished.')
      : null,
    state.mode === 'static' ? el('p', { class: 'note' }, 'This is a read-only copy of a gallery: there '
      + 'are no runs here.') : null,
    loading ? el('p', { role: 'status' }, 'Loading…') : null,
    error ? el('p', { class: 'error', role: 'alert' }, error) : null,
    el('h2', null, 'Recent runs'),
    runsTable(runs),
    el('h2', null, 'Ledger'),
    units.length === 0 ? el('p', { class: 'muted' }, 'The ledger is empty.')
      : el('ul', { class: 'facts' }, units.map(([s, n]) => el('li', null, `${s}: ${count(n)}`))),
    el('h2', null, 'Lock'),
    el('p', null, lockLine(data?.lock ?? null)),
    el('h2', null, 'Budget of the last run'),
    budget(last?.rate ?? data?.rate ?? null),
    el('h2', null, 'Sources'),
    sources,
    adder(state, data, dispatch),
  ]));
}
