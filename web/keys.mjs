// @ts-check
/**
 * Keyboard triage (DESIGN §10.3). `keymap(mode)` says what each key does in a mode; `bindKeys`
 * listens for key presses and dispatches `{type: 'key', action, key}`. `x` starts a chord that the
 * next key (`1`–`6`) completes with a reason. Keys are ignored while a text field has focus (except
 * Escape) and when Ctrl, Alt or Cmd is held, so browser shortcuts keep working.
 */

/** @typedef {{type: 'key', action: string, key: string, chord?: string}} KeyAction */

/** The six "not good" reasons in key order (§10.3). */
export const NOTGOOD_KEYS = Object.freeze({
  1: 'slop', 2: 'clone', 3: 'personal', 4: 'spam', 5: 'dump', 6: 'empty',
});

/** Labels of the Calibrate tab, keyed by their letter (§10.3). */
export const LABEL_KEYS = Object.freeze({
  g: 'G', w: 'W', c: 'C', p: 'P', s: 'S', d: 'D', x: 'X', e: 'E',
});

const NAVIGATE = Object.freeze({
  j: 'next', k: 'prev', ArrowDown: 'next', ArrowUp: 'prev', '[': 'prevShelf', ']': 'nextShelf', '?': 'help',
  Escape: 'escape',
});

/** @type {Readonly<Record<string, Readonly<Record<string, string>>>>} */
export const KEYMAPS = Object.freeze({
  queue: Object.freeze({
    ...NAVIGATE, g: 'gem', w: 'wip', n: 'notmine', x: 'notgood', z: 'snooze', u: 'undo', p: 'publish',
    o: 'open', e: 'why', '/': 'filter', Enter: 'detail',
  }),
  notgood: Object.freeze({
    ...Object.fromEntries(Object.entries(NOTGOOD_KEYS).map(([k, r]) => [k, `notgood:${r}`])),
    Escape: 'cancel',
  }),
  calibrate: Object.freeze({
    ...Object.fromEntries(Object.entries(LABEL_KEYS).map(([k, l]) => [k, `label:${l}`])),
    j: 'next', k: 'prev', u: 'undo', '[': 'prevShelf', ']': 'nextShelf', '?': 'help', Escape: 'escape',
  }),
  quarantine: Object.freeze({ ...NAVIGATE, e: 'why', '/': 'filter' }),
  browse: Object.freeze({ '[': 'prevShelf', ']': 'nextShelf', '?': 'help', Escape: 'escape' }),
  help: Object.freeze({ '?': 'help', Escape: 'escape' }),
  dialog: Object.freeze({ Escape: 'escape' }),
});

/**
 * What each key does in a mode: `queue` (the default), `notgood` (after `x`), `calibrate`,
 * `quarantine`, `browse` (Taste and Status), `help` and `dialog`.
 * @param {string} [mode]
 * @returns {Record<string, string>}
 */
export function keymap(mode = 'queue') {
  return { ...(Object.hasOwn(KEYMAPS, mode) ? KEYMAPS[mode] : KEYMAPS.queue) };
}

/**
 * The help sheet (§10.3), for the `?` overlay.
 * @type {readonly {keys: string, what: string}[]}
 */
export const KEY_HELP = Object.freeze([
  { keys: 'j / k', what: 'Next / previous card' },
  { keys: 'g', what: 'Gem: save it (label G)' },
  { keys: 'w', what: 'Promising work in progress (label W; snoozed 30 days)' },
  { keys: 'n', what: 'Not my thing (taste only; no quality label)' },
  { keys: 'x then 1–6', what: 'Not good: 1 slop or scaffold, 2 tutorial, clone or coursework, '
    + '3 personal or site, 4 spam or malware, 5 data dump, 6 near-empty' },
  { keys: 'z', what: 'Snooze 30 days (no label)' },
  { keys: 'u', what: 'Undo the last action' },
  { keys: 'p', what: 'Publish or unpublish a saved gem (opens the note field)' },
  { keys: 'o', what: 'Open on GitHub in a new tab' },
  { keys: 'e', what: 'Show or hide the Why panel' },
  { keys: '/', what: 'Focus the filter' },
  { keys: '[ / ]', what: 'Previous / next shelf' },
  { keys: '?', what: 'This help' },
  { keys: 'g w c p s d x e', what: 'In Calibrate: the eight labels' },
]);

/**
 * @param {any} target
 * @returns {boolean}
 */
function isTyping(target) {
  if (!target) return false;
  const tag = String(target.tagName ?? '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}

/** Keys that only modify another key: pressing one never completes or cancels the x chord. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'OS', 'Fn']);

/**
 * The key a "not good" reason is picked with: `e.key`, or the digit of the physical key when the
 * layout gives it another character (`&` for the 1 key on AZERTY) or a numeric-keypad key.
 * @param {any} e
 * @param {Record<string, string>} map
 * @returns {string}
 */
function reasonKey(e, map) {
  const key = String(e.key ?? '');
  if (Object.hasOwn(map, key)) return key;
  return /^(?:Digit|Numpad)([1-6])$/.exec(String(e.code ?? ''))?.[1] ?? key;
}

/**
 * Listen for key presses on `target` and dispatch their actions. Returns a function that stops
 * listening. In the `notgood` mode (after `x`, or while the app's reason menu is open) 1–6 pick a
 * reason, matched on the physical key too, and any other key cancels; modifier keys alone do
 * neither, so Shift can be held for the digit.
 * @param {{addEventListener: Function, removeEventListener: Function}} target
 * @param {(action: KeyAction) => void} dispatch
 * @param {{mode?: () => string}} [opts] the current mode, asked on every key press
 * @returns {() => void}
 */
export function bindKeys(target, dispatch, { mode = () => 'queue' } = {}) {
  /** @type {string | null} */
  let chord = null;
  /** @param {any} e */
  const onKey = (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    const key = String(e.key ?? '');
    if (isTyping(e.target)) {
      if (key === 'Escape') {
        chord = null;
        dispatch({ type: 'key', action: 'escape', key });
      }
      return;
    }
    if (MODIFIER_KEYS.has(key)) return;
    const current = chord ?? mode();
    if (current === 'notgood') {
      const reasons = keymap('notgood');
      const k = reasonKey(e, reasons);
      const action = Object.hasOwn(reasons, k) ? reasons[k] : 'cancel';
      chord = null;
      e.preventDefault();
      dispatch({ type: 'key', action, key });
      return;
    }
    const map = keymap(current);
    if (!Object.hasOwn(map, key)) return;
    const action = map[key];
    e.preventDefault();
    if (action === 'notgood') {
      chord = 'notgood';
      dispatch({ type: 'key', action: 'chord', chord, key });
      return;
    }
    dispatch({ type: 'key', action, key });
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}
