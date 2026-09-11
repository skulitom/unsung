// @ts-check
/**
 * The explorer end to end, in Node (DESIGN §10.3, §13 WP6 "keyboard-only triage works end to end"):
 * web/app.mjs boots against the fake DOM holding index.html's regions, a fake fetch that serves the
 * examples, and an in-memory localStorage. Then the keyboard alone moves through the queue, saves,
 * rejects with a reason, snoozes, undoes, switches shelves, publishes with a note and opens help.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createEvent, createFakeDocument, keydown } from './support/fake-dom.mjs';
import { loadJsonFixture } from './support/fixtures.mjs';
import { validateFeedback } from '../src/core/schema.mjs';
import { STORAGE_KEYS, memoryStorage } from '../web/api.mjs';

const SAMPLE = loadJsonFixture('index.sample.json');
const g = /** @type {any} */ (globalThis);

/** @type {any} */
let doc;
const storage = memoryStorage();
/** @type {Record<string, Function[]>} */
const listeners = {};

/** A location whose hash fires hashchange, like a browser's. */
const location = {
  current: '',
  get hash() {
    return this.current;
  },
  set hash(v) {
    const next = String(v).startsWith('#') ? String(v) : `#${v}`;
    if (next === this.current) return;
    this.current = next;
    queueMicrotask(() => (listeners.hashchange ?? []).forEach((f) => f()));
  },
};

/**
 * The regions of web/index.html.
 * @param {any} d
 */
function skeleton(d) {
  /**
   * @param {string} tag
   * @param {string} id
   */
  const make = (tag, id) => {
    const n = d.createElement(tag);
    n.setAttribute('id', id);
    return n;
  };
  const top = d.createElement('header');
  top.append(make('nav', 'shelves'), make('input', 'filter'), make('button', 'filters-toggle'),
    make('button', 'help-button'), make('span', 'runinfo'));
  const layout = d.createElement('div');
  layout.append(make('aside', 'facets'), make('main', 'main'), make('section', 'detail'));
  const overlay = make('div', 'overlay');
  overlay.hidden = true;
  d.body.append(top, make('div', 'banner'), layout, overlay, make('div', 'toast'));
}

/** @param {number} [ms] */
const sleep = (ms = 40) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until `check` holds (the app paints on a timer and saves asynchronously).
 * @param {() => unknown} check
 * @param {string} what
 */
async function until(check, what) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await sleep(20);
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** @param {string} key */
async function press(key) {
  doc.body.dispatchEvent(keydown(key));
  await sleep();
}

/** @returns {any[]} the decisions kept in this browser */
const events = () => JSON.parse(storage.getItem(STORAGE_KEYS.examples.events) ?? '[]');
const main = () => doc.getElementById('main');
const heading = () => main().querySelector('h1')?.textContent ?? '';
const selectedNwo = () => main().querySelector('.card.selected a.repo')?.textContent ?? '';

before(async () => {
  doc = createFakeDocument();
  skeleton(doc);
  Object.assign(g, {
    document: doc,
    location,
    history: {
      /**
       * @param {unknown} _s
       * @param {unknown} _t
       * @param {string} url
       */
      replaceState: (_s, _t, url) => {
        location.current = String(url);
      },
    },
    localStorage: storage,
    addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => {
      (listeners[type] ??= []).push(fn);
    },
    fetch: async (/** @type {string} */ url) => {
      const routes = /** @type {Record<string, unknown>} */ ({
        'api/index': { ...SAMPLE, examples: true },
        'api/model': SAMPLE.model,
      });
      const body = routes[url];
      return body === undefined
        ? { ok: false, status: 404, text: async () => 'Not found' }
        : { ok: true, status: 200, text: async () => JSON.stringify(body) };
    },
  });
  await import('../web/app.mjs');
  await until(() => heading().startsWith('Promising'), 'the first paint');
});

test('the explorer boots on the examples, with the banner, the queue and the Why panel', async () => {
  assert.equal(heading(), 'Promising 14');
  assert.ok(doc.getElementById('banner').textContent.includes('Examples.'));
  assert.ok(doc.getElementById('banner').querySelector('.first-run'), 'the first-run panel is shown');
  // codefly-dev/cli leads since weights w2 retired s.incoherent, the −1 that put it second (§5.3).
  assert.equal(selectedNwo(), 'codefly-dev/cli');
  await until(() => doc.getElementById('detail').querySelector('.rank-line'), 'the Why panel');
  const rank = doc.getElementById('detail').querySelector('.rank-line').textContent;
  assert.match(rank, /^Rank 12\.69 = 12 points/);
  const shelves = doc.getElementById('shelves').textContent;
  assert.ok(shelves.includes('Promising 14') && shelves.includes('Quarantine 2'));
});

test('keyboard only: move, save, undo, reject with a reason, snooze, not my thing', async () => {
  await press('j');
  assert.equal(selectedNwo(), 'sakajunquality/bunko');
  assert.equal(location.hash, '#/r/sakajunquality/bunko', 'the URL follows the cursor');
  await press('k');
  assert.equal(selectedNwo(), 'codefly-dev/cli');
  assert.equal(location.hash, '#/r/codefly-dev/cli', 'and back');

  await press('g');
  await until(() => heading() === 'Promising 13', 'the gem to leave the queue');
  assert.equal(selectedNwo(), 'sakajunquality/bunko', 'the cursor moves to the next card');
  assert.deepEqual(events().map((e) => [e.action, e.label]), [['gem', 'G']]);
  assert.ok(doc.getElementById('toast').textContent.includes('Saved as a gem'));

  await press('u');
  await until(() => heading() === 'Promising 14', 'the undo');
  assert.equal(selectedNwo(), 'codefly-dev/cli', 'undo puts it back where it was');

  await press('x');
  assert.ok(doc.getElementById('toast').textContent.includes('Tutorial, clone or coursework'));
  await press('2');
  await until(() => heading() === 'Promising 13', 'not good');
  const notgood = events().at(-1);
  assert.deepEqual([notgood.action, notgood.reason, notgood.label], ['notgood', 'clone', 'C']);
  await press('u');
  await until(() => heading() === 'Promising 14', 'the second undo');

  await press('z');
  await until(() => heading() === 'Promising 13', 'the snooze');
  assert.ok(events().at(-1).snoozeUntil > new Date().toISOString());
  await press('u');
  await until(() => heading() === 'Promising 14', 'the third undo');

  await press('n');
  await until(() => heading() === 'Promising 13', 'not my thing');
  assert.equal(events().at(-1).label, null, '"not my thing" is never a quality label');
  await press('u');
  await until(() => heading() === 'Promising 14', 'the fourth undo');
  for (const ev of events()) assert.deepEqual(validateFeedback(ev), [], ev.action);
  assert.equal(events().filter((e) => e.action === 'undo').length, 4, 'undo appends; nothing is deleted');
});

test('keyboard only: switch shelves, publish a saved gem with a note, help and the Why panel', async () => {
  await press('g');
  await until(() => heading() === 'Promising 13', 'the gem');
  for (let i = 0; i < 4; i++) await press(']');
  await until(() => heading() === 'Saved 1', 'the Saved shelf');
  assert.match(location.hash, /^#\/(saved|r\/)/);

  await press('p');
  await until(() => doc.getElementById('publish-note'), 'the note field');
  const note = doc.getElementById('publish-note');
  assert.equal(doc.activeElement, note, 'the note field takes the focus');
  note.value = 'A lovely little tool';
  note.dispatchEvent(createEvent('input'));
  note.dispatchEvent(keydown('g'));
  await sleep();
  assert.equal(events().at(-1).action, 'gem', 'typing a g in the note triages nothing');
  const publish = main().querySelector('.publish-panel').querySelectorAll('button')
    .find((/** @type {any} */ b) => b.textContent === 'Publish');
  publish.click();
  await until(() => events().at(-1).action === 'publish', 'the publish');
  assert.equal(events().at(-1).note, 'A lovely little tool');
  await until(() => main().querySelector('.badge.published'), 'the Published badge');

  await press('[');
  await until(() => heading().startsWith('For you'), 'the previous shelf');

  await press('?');
  assert.equal(doc.getElementById('overlay').hidden, false);
  await press('Escape');
  assert.equal(doc.getElementById('overlay').hidden, true);

  await press('e');
  assert.equal(doc.getElementById('detail').querySelector('.rank-line'), null, 'e hides the Why panel');
  await press('e');
  assert.ok(doc.getElementById('detail').querySelector('.rank-line'));

  await press('/');
  assert.equal(doc.activeElement, doc.getElementById('filter'), '/ focuses the filter');
  doc.getElementById('filter').dispatchEvent(keydown('Escape'));
  await sleep();
  assert.notEqual(doc.activeElement, doc.getElementById('filter'), 'Escape leaves it');
});

/** @returns {string} the repository the detail pane shows */
const detailNwo = () => doc.getElementById('detail').querySelector('h2')?.textContent ?? '';

/**
 * Follow a card's name link as a browser does: the click, then the hash change.
 * @param {any} link
 */
async function follow(link) {
  link.click();
  location.hash = link.getAttribute('href');
  await sleep();
}

test('clicking a card\'s name keeps the shelf, and the keys act on that repository', async () => {
  location.hash = '#/look';
  await until(() => heading().startsWith('Worth a look'), 'Worth a look');
  const before = heading();
  const link = main().querySelectorAll('li.card a.repo')[1];
  const nwo = link.textContent;
  await follow(link);
  assert.equal(heading(), before, 'still on Worth a look');
  assert.equal(selectedNwo(), nwo);
  await until(() => detailNwo() === nwo, 'its detail pane');
  const count = events().length;
  await press('g');
  await until(() => events().length === count + 1, 'the decision');
  const ev = events().at(-1);
  assert.deepEqual([ev.nwo, ev.action, ev.context.view], [nwo, 'gem', 'look']);
  await press('u');
  await until(() => heading() === before, 'the undo');
});

test('with a filter on, clicking a card\'s name keeps the filter', async () => {
  const ts = SAMPLE.entries.filter((/** @type {any} */ e) => e.lane === 'promising' && e.lang === 'TypeScript')
    .length;
  assert.ok(ts >= 2, 'the examples have TypeScript cards to click');
  location.hash = '#/promising?lang=TypeScript';
  await until(() => heading() === `Promising ${ts}`, 'the filtered shelf');
  await follow(main().querySelectorAll('li.card a.repo')[1]);
  assert.equal(heading(), `Promising ${ts}`, 'the filter is kept');
  assert.match(location.hash, /lang=TypeScript/);
});

test('a repository opened from outside the shelf is the one the keys decide about', async () => {
  location.hash = '#/look';
  await until(() => heading().startsWith('Worth a look'), 'Worth a look');
  const other = SAMPLE.entries.find((/** @type {any} */ e) => e.lane === 'promising' && e.nwo !== 'codefly-dev/cli');
  location.hash = `#/r/${other.nwo}?shelf=look`;
  await until(() => detailNwo() === other.nwo, 'its detail pane');
  assert.ok(heading().startsWith('Worth a look'));
  assert.notEqual(selectedNwo(), other.nwo, 'the cursor stays on a Worth a look card');
  const count = events().length;
  await press('z');
  await until(() => events().length === count + 1, 'the decision');
  assert.equal(events().at(-1).nwo, other.nwo);
  assert.equal(events().at(-1).context.position, null, 'it has no place in this queue');
  await press('u');
  await until(() => events().at(-1).action === 'undo', 'the undo');
});

test('the reason menu opened with the mouse takes its keys, and Shift never cancels x', async () => {
  location.hash = '#/promising';
  await until(() => heading().startsWith('Promising') && selectedNwo() !== '', 'Promising');
  const nwo = selectedNwo();
  main().querySelector('.card.selected .act-notgood').click();
  await until(() => main().querySelector('.card.selected .reason-menu'), 'the reason menu');
  let count = events().length;
  await press('1');
  await until(() => events().length === count + 1, 'the reason');
  const picked = events().at(-1);
  assert.deepEqual([picked.nwo, picked.action, picked.reason], [nwo, 'notgood', 'slop']);
  await press('u');
  await until(() => events().at(-1).action === 'undo' && selectedNwo() === nwo, 'the undo');
  await press('x');
  doc.body.dispatchEvent(keydown('Shift', { shiftKey: true }));
  await sleep();
  assert.ok(doc.getElementById('toast').textContent.includes('Slop or scaffold'), 'the chord is still open');
  count = events().length;
  doc.body.dispatchEvent(keydown('1', { shiftKey: true, code: 'Digit1' }));
  await until(() => events().length === count + 1, 'the reason typed with Shift held');
  assert.deepEqual([events().at(-1).nwo, events().at(-1).reason], [nwo, 'slop']);
  await press('u');
  await until(() => events().at(-1).action === 'undo' && selectedNwo() === nwo, 'the second undo');
});

test('p takes down a pick that is still published after it was rejected', async () => {
  location.hash = '#/saved';
  await until(() => heading() === 'Saved 1' && main().querySelector('.card.selected .badge.published'),
    'the published pick on Saved');
  const nwo = selectedNwo();
  await press('x');
  await press('3');
  await until(() => heading() === 'Saved 0', 'the rejection');
  location.hash = '#/promising?hidden=1';
  const card = () => main().querySelectorAll('li.card')
    .find((/** @type {any} */ c) => c.querySelector('a.repo')?.textContent === nwo);
  await until(() => card()?.querySelector('.badge.published'), 'the rejected pick, still published');
  card().click();
  await until(() => selectedNwo() === nwo, 'the card');
  const count = events().length;
  await press('p');
  await until(() => events().length === count + 1, 'the unpublish');
  assert.equal(events().at(-1).action, 'unpublish');
  await until(() => card() && !card().querySelector('.badge.published'), 'the badge to go');
  await press('g');
  await until(() => events().at(-1).action === 'gem', 'the gem');
  await sleep();
  assert.equal(card()?.querySelector('.badge.published') ?? null, null, 'saving it again does not republish it');
});
