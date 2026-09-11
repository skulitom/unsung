// @ts-check
/**
 * The Quarantine view (DESIGN §7.6, §10.2): repositories held back by a hard gate, shown as identity
 * plus gate reasons only. Nothing here is a link: the repository address is plain text beside a
 * warning, and no README, description or file from them is ever rendered.
 */

import { el, replace } from '../render.mjs';

/** @typedef {import('../../src/core/schema.mjs').IndexEntry} IndexEntry */
/** @typedef {(action: Record<string, any>) => void} Dispatch */

/** What each quarantine gate means (§7.2). */
export const GATE_NOTES = Object.freeze({
  'g.lure.name': 'Its name or description reads like a lure (cracks, keygens, cheats, drainers)',
  'g.lure.link': 'Its README links an archive or executable in a way lures do',
  'g.lure.script': 'A large payload of Batchfile, PowerShell, VBScript or AutoHotkey, or a committed binary',
  'g.lure.drainer': 'It asks people to send cryptocurrency or to connect a wallet to claim something',
});

export const WARNING = 'Do not download, unpack or run anything from these repositories. They are never '
  + 'exported, never sent to a reviewer, and Unsung links none of them.';

/**
 * @param {IndexEntry['gates'][number]} gate
 * @returns {{id: string, reason: string}}
 */
function gateOf(gate) {
  if (typeof gate === 'string') return { id: gate, reason: '' };
  return { id: String(gate?.id ?? ''), reason: String(gate?.reason ?? '') };
}

/**
 * One quarantined repository: identity, its gates and their reasons, and its address as text.
 * @param {Pick<IndexEntry, 'id' | 'nwo' | 'gates'>} entry
 * @param {{selected?: boolean}} [opts]
 * @returns {any}
 */
export function quarantineItem(entry, { selected = false } = {}) {
  return el('li', { class: ['q-item', selected ? 'selected' : null], dataset: { id: entry.id } }, [
    el('p', { class: 'q-name' }, entry.nwo),
    el('ul', { class: 'gates' }, (Array.isArray(entry.gates) ? entry.gates : []).map((g) => {
      const { id, reason } = gateOf(g);
      const note = /** @type {Record<string, string>} */ (GATE_NOTES)[id];
      return el('li', null, [el('code', null, id), ' ', reason || note || '']);
    })),
    el('p', { class: 'q-url' }, [
      el('span', { class: 'warn-mark', 'aria-hidden': 'true' }, '!'),
      ' Repository address, as text only: ',
      el('span', { class: 'url-text' }, `https://github.com/${entry.nwo}`),
    ]),
  ]);
}

/**
 * Render the Quarantine shelf.
 * @param {any} root
 * @param {{list: Pick<IndexEntry, 'id' | 'nwo' | 'gates'>[], triage: {ids: string[], pos: number}}} state
 * @param {Dispatch} _dispatch
 * @returns {void}
 */
export function render(root, state, _dispatch) {
  const current = state.triage.ids[state.triage.pos];
  replace(root, [
    el('header', { class: 'queue-head' }, [
      el('h1', null, ['Quarantine ', el('span', { class: 'count' }, String(state.list.length))]),
      el('p', { class: 'warning', role: 'note' }, WARNING),
    ]),
    state.list.length === 0 ? el('p', { class: 'empty' }, 'Nothing is quarantined.')
      : el('ol', { class: 'q-list', 'aria-label': 'Quarantined repositories' },
        state.list.map((e) => quarantineItem(e, { selected: e.id === current }))),
  ]);
}
