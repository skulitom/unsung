// @ts-check
/**
 * Keyboard triage (DESIGN §10.3): every key in its mode, the `x` then `1`–`6` chord, the Calibrate
 * labels, and the rules that keep typing and browser shortcuts out of the way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDocument, keydown } from './support/fake-dom.mjs';
import { KEY_HELP, bindKeys, keymap } from '../web/keys.mjs';

test('queue keys are those of §10.3', () => {
  const map = keymap('queue');
  const expected = {
    j: 'next', k: 'prev', g: 'gem', w: 'wip', n: 'notmine', x: 'notgood', z: 'snooze', u: 'undo',
    p: 'publish', o: 'open', e: 'why', '/': 'filter', '[': 'prevShelf', ']': 'nextShelf', '?': 'help',
  };
  for (const [key, action] of Object.entries(expected)) assert.equal(map[key], action, key);
  assert.deepEqual(keymap(), map, 'queue is the default');
  assert.deepEqual(keymap('no such mode'), map);
  map.j = 'changed';
  assert.equal(keymap('queue').j, 'next', 'keymap returns a copy');
});

test('the not-good chord and the Calibrate labels', () => {
  assert.deepEqual(keymap('notgood'), {
    1: 'notgood:slop', 2: 'notgood:clone', 3: 'notgood:personal', 4: 'notgood:spam', 5: 'notgood:dump',
    6: 'notgood:empty', Escape: 'cancel',
  });
  const cal = keymap('calibrate');
  const labels = { g: 'G', w: 'W', c: 'C', p: 'P', s: 'S', d: 'D', x: 'X', e: 'E' };
  for (const [key, label] of Object.entries(labels)) {
    assert.equal(cal[key], `label:${label}`);
  }
  assert.equal(keymap('quarantine').g, undefined, 'no triage in the Quarantine view');
});

test('bindKeys dispatches actions, completes the x chord, and can be unbound', () => {
  const doc = createFakeDocument();
  /** @type {any[]} */
  const got = [];
  let mode = 'queue';
  const unbind = bindKeys(doc.body, (a) => got.push(a), { mode: () => mode });
  const j = keydown('j');
  doc.body.dispatchEvent(j);
  assert.equal(j.defaultPrevented, true);
  doc.body.dispatchEvent(keydown('x'));
  doc.body.dispatchEvent(keydown('3'));
  doc.body.dispatchEvent(keydown('x'));
  doc.body.dispatchEvent(keydown('q'));
  const unmapped = keydown('q');
  doc.body.dispatchEvent(unmapped);
  assert.equal(unmapped.defaultPrevented, false, 'unmapped keys are left alone');
  mode = 'calibrate';
  doc.body.dispatchEvent(keydown('d'));
  assert.deepEqual(got.map((a) => a.action),
    ['next', 'chord', 'notgood:personal', 'chord', 'cancel', 'label:D']);
  unbind();
  doc.body.dispatchEvent(keydown('j'));
  assert.equal(got.length, 6);
});

test('the x chord survives modifier keys, reads the physical digit key, and an open reason menu takes 1–6',
  () => {
    const doc = createFakeDocument();
    /** @type {any[]} */
    const got = [];
    let mode = 'queue';
    bindKeys(doc.body, (a) => got.push(a), { mode: () => mode });
    /**
     * @param {string} key
     * @param {Record<string, any>} [init]
     */
    const press = (key, init = {}) => doc.body.dispatchEvent(keydown(key, init));
    press('x');
    press('Shift', { shiftKey: true, code: 'ShiftLeft' });
    press('1', { shiftKey: true, code: 'Digit1' });
    press('x');
    press('&', { code: 'Digit1' });
    press('x');
    press('End', { code: 'Numpad6' });
    press('x');
    press('q');
    mode = 'notgood';
    press('CapsLock');
    press('4');
    press('j');
    press('Escape');
    mode = 'queue';
    press('j');
    assert.deepEqual(got.map((a) => a.action), ['chord', 'notgood:slop', 'chord', 'notgood:slop', 'chord',
      'notgood:empty', 'chord', 'cancel', 'notgood:spam', 'cancel', 'cancel', 'next']);
  });

test('keys are ignored while typing (except Escape) and with Ctrl, Alt or Cmd held', () => {
  const doc = createFakeDocument();
  /** @type {any[]} */
  const got = [];
  bindKeys(doc, (a) => got.push(a));
  const input = doc.createElement('input');
  const area = doc.createElement('textarea');
  const editable = doc.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  doc.body.append(input, area, editable);
  for (const target of [input, area, editable]) target.dispatchEvent(keydown('g'));
  input.dispatchEvent(keydown('Escape'));
  doc.body.dispatchEvent(keydown('g', { ctrlKey: true }));
  doc.body.dispatchEvent(keydown('g', { metaKey: true }));
  doc.body.dispatchEvent(keydown('g', { altKey: true }));
  doc.body.dispatchEvent(keydown('G'));
  assert.deepEqual(got.map((a) => a.action), ['escape']);
  doc.body.dispatchEvent(keydown('?', { shiftKey: true }));
  assert.equal(got.at(-1).action, 'help');
});

test('the help sheet names every queue key', () => {
  const sheet = KEY_HELP.map((h) => h.keys).join(' ');
  for (const key of ['j', 'k', 'g', 'w', 'n', 'x', 'z', 'u', 'p', 'o', 'e', '/', '[', ']', '?']) {
    assert.ok(sheet.includes(key), key);
  }
});
