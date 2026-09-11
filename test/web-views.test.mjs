// @ts-check
/**
 * The explorer's views (DESIGN §10.2–§10.8), rendered into the fake DOM from index.sample.json:
 * cards, the Why panel, Quarantine, Taste, Calibrate, Status and the frame. The fake DOM throws on
 * every HTML-parsing sink, so a view that reached for one would fail here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allElements, createEvent, createFakeDocument, serialise } from './support/fake-dom.mjs';
import { loadJsonFixture } from './support/fixtures.mjs';
import { forYouSlots } from '../src/core/taste.mjs';
import {
  emptyFilters, facetCounts, initialTriage, makeFeedback, overlayFeedback, parseHash, shelf, shelfCounts,
  triageReducer,
} from '../src/core/views.mjs';
import { useDocument } from '../web/render.mjs';
import { render as renderCalibrate } from '../web/views/calibrate.mjs';
import { explanationFor, render as renderDetail } from '../web/views/detail.mjs';
import { triageBar } from '../web/views/parts.mjs';
import { render as renderQuarantine } from '../web/views/quarantine.mjs';
import { render as renderQueue } from '../web/views/queue.mjs';
import {
  firstRunCommand, renderBanner, renderFacets, renderOverlay, renderRunInfo, renderShelves, renderToast,
  shellArg,
} from '../web/views/shell.mjs';
import { render as renderStatus } from '../web/views/status.mjs';
import { render as renderTaste } from '../web/views/taste.mjs';

/** @typedef {import('../src/core/schema.mjs').IndexEntry} IndexEntry */

const doc = createFakeDocument();
useDocument(doc);

const SAMPLE = loadJsonFixture('index.sample.json');
const NOW = '2026-09-11T16:00:00.000Z';
const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

/** @param {string} nwo */
const get = (nwo) => /** @type {IndexEntry} */ (SAMPLE.entries.find((/** @type {any} */ e) => e.nwo === nwo));

/** @returns {{actions: any[], dispatch: (a: any) => void}} */
function recorder() {
  /** @type {any[]} */
  const actions = [];
  return { actions, dispatch: (a) => actions.push(a) };
}

/**
 * The part of the app state the queue needs, for one shelf.
 * @param {string} name
 * @param {Record<string, any>} [extra]
 */
function queueState(name, extra = {}) {
  const index = extra.index ?? SAMPLE;
  const route = { screen: 'shelf', shelf: name, nwo: null, filters: emptyFilters() };
  const list = shelf(index, name, route.filters, { now: NOW, taste: extra.taste ?? null });
  const triage = triageReducer(initialTriage(), { type: 'load', ids: list.map((e) => e.id) });
  const tasteTerms = name === 'foryou'
    ? new Map(forYouSlots(list, extra.taste ?? null)
      .map((s) => [s.entry.id, { t: s.t, wildcard: s.wildcard }]))
    : null;
  return { route, list, triage, now: NOW, tasteTerms, hiddenCount: 0, filtered: false, helpCard: null,
    reasonMenu: null, chord: null, publishing: null, ...extra };
}

/** @returns {any} */
const root = () => doc.createElement('div');

/**
 * @param {any} node
 * @param {string} text
 * @returns {any}
 */
function buttonWith(node, text) {
  return node.querySelectorAll('button').find((/** @type {any} */ b) => b.textContent.includes(text));
}

test('the queue shows dense cards: name, description, meters, reasons and chips', () => {
  const r = root();
  const state = queueState('promising');
  renderQueue(r, state, recorder().dispatch);
  const cards = r.querySelectorAll('li.card');
  assert.equal(cards.length, state.list.length);
  assert.equal(r.querySelector('h1').textContent, `Promising ${state.list.length}`);
  /** @param {any} list @param {string} nwo */
  const cardOf = (list, nwo) => list
    .find((/** @type {any} */ c) => c.querySelector('a.repo').textContent === nwo);
  const first = cards[0];
  assert.ok(first.classList.contains('selected'));
  // The highest rank leads: codefly-dev/cli has 12 points since weights w2 retired s.incoherent (§5.3).
  assert.equal(first.querySelector('a.repo').getAttribute('href'), '#/r/codefly-dev/cli');
  const bunko = cardOf(cards, 'sakajunquality/bunko');
  assert.equal(cards.indexOf(bunko), 1);
  assert.equal(bunko.querySelector('a.repo').getAttribute('href'), '#/r/sakajunquality/bunko');
  assert.ok(bunko.querySelector('.meter-q'));
  assert.equal(bunko.querySelectorAll('.meter-q .seg').length, 13);
  assert.equal(bunko.querySelectorAll('.meter-q .seg.on').length, 12);
  assert.match(bunko.querySelector('.meter-q').textContent, /12\/13 · Q 100/);
  assert.ok(bunko.querySelector('.pill.conf').textContent.includes('medium'));
  assert.ok(bunko.querySelector('.attention').textContent.includes('2 stars'));
  assert.equal(bunko.querySelectorAll('.reasons li.plus').length, 3);
  assert.equal(bunko.querySelectorAll('.reasons li.minus').length, 0);
  assert.equal(bunko.querySelector('.descriptor').textContent, 'Agent-assisted');
  assert.ok(first.querySelector('.actions'), 'the selected card has its triage buttons');
  assert.equal(cards[1].querySelector('.actions'), null, 'only the selected one');
  const codefly = cardOf(cards, 'codefly-dev/cli');
  assert.equal(codefly.querySelectorAll('.reasons li.minus').length, 0,
    'a retired signal (s.incoherent, worth 0 since w2) is not a penalty');
  assert.ok(codefly.querySelector('.attention').textContent.includes('0 stars'));
  const look = root();
  renderQueue(look, queueState('look'), recorder().dispatch);
  const mdheavy = cardOf(look.querySelectorAll('li.card'), 'gbazad93/AirFlow-ML-Data-Integration');
  assert.equal(mdheavy.querySelectorAll('.reasons li.minus').length, 1, 'a slop penalty is a minus reason');
  assert.match(mdheavy.querySelector('.reasons li.minus').textContent, /^Markdown-heavy/);
});

test('clicking a card selects it; a triage button decides without opening the detail', () => {
  const r = root();
  const { actions, dispatch } = recorder();
  renderQueue(r, queueState('promising'), dispatch);
  const cards = r.querySelectorAll('li.card');
  cards[2].dispatchEvent(createEvent('click'));
  assert.deepEqual(actions.at(-1), { type: 'select', id: cards[2].getAttribute('data-id'), open: true });
  buttonWith(cards[0], 'Gem').click();
  assert.equal(actions.at(-2).type, 'decide');
  assert.equal(actions.at(-2).action, 'gem');
  assert.equal(actions.at(-1).open, false, 'the bubbling select does not open the overlay');
  buttonWith(cards[0], 'Not good').click();
  assert.equal(actions.at(-2).type, 'reasonMenu');
});

test('the "not good" reasons open with x and name their labels', () => {
  const r = root();
  const { actions, dispatch } = recorder();
  renderQueue(r, queueState('promising', { chord: 'notgood' }), dispatch);
  const menu = r.querySelector('.reason-menu');
  assert.equal(menu.querySelectorAll('button').length, 6);
  buttonWith(menu, 'Data dump').click();
  assert.equal(actions.find((a) => a.type === 'decide').reason, 'dump');
});

test('hostile repository text is only ever text', () => {
  const hostile = { ...get('codefly-dev/cli'), id: 'R_evil', nwo: 'evil/repo', description: HOSTILE,
    top: [HOSTILE], negatives: [HOSTILE], verdict: { category: 'G', pitch: HOSTILE, points: 1 } };
  const index = { ...SAMPLE, entries: [hostile] };
  const r = root();
  renderQueue(r, queueState('promising', { index }), recorder().dispatch);
  assert.equal(r.querySelectorAll('img').length + r.querySelectorAll('script').length, 0);
  assert.ok(serialise(r).includes('&lt;script&gt;'));
  const d = root();
  renderDetail(d, { detail: { nwo: 'evil/repo', record: { facts: { readme: { name: 'README.md', bytes: 10,
    truncated: false, text: HOSTILE } } }, loading: false, error: null }, entry: hostile, why: true,
  model: SAMPLE.model, lib: {}, now: NOW }, recorder().dispatch);
  assert.equal(d.querySelectorAll('img').length + d.querySelectorAll('script').length, 0);
  assert.ok(d.querySelector('pre.readme-plain').textContent.includes('<script>'));
});

test('low coverage is hatched, For you shows taste terms, and empty shelves say so', () => {
  const thin = { ...get('codefly-dev/cli'), coverage: 0.5 };
  const r = root();
  renderQueue(r, queueState('promising', { index: { ...SAMPLE, entries: [thin] } }), recorder().dispatch);
  assert.ok(r.querySelector('.card.hatched-card .meter-q.hatched'));
  assert.ok(r.querySelector('.meter-q').textContent.includes('incomplete evidence'));
  const taste = { v: 1, updatedAt: NOW, facets: { 'lang:go': { gems: 3, notmine: 0, pin: 0 },
    'lang:rust': { gems: 0, notmine: 3, pin: 0 } } };
  const fy = root();
  renderQueue(fy, queueState('foryou', { taste }), recorder().dispatch);
  const tastes = fy.querySelectorAll('.taste').map((/** @type {any} */ n) => n.textContent);
  assert.ok(tastes.some((t) => t.startsWith('Taste +')));
  assert.ok(tastes.some((t) => t === 'Wildcard' || t.startsWith('Taste −')));
  const badges = fy.querySelectorAll('.badge');
  assert.ok(badges.some((/** @type {any} */ b) => b.classList.contains('lane-proven')));
  const empty = root();
  const { actions, dispatch } = recorder();
  renderQueue(empty, { ...queueState('saved'), filtered: true, hiddenCount: 0 }, dispatch);
  assert.ok(empty.textContent.includes('Nothing on this shelf matches your filters.'));
  buttonWith(empty, 'Clear the filters').click();
  assert.equal(actions[0].type, 'clearFilters');
  const hidden = root();
  renderQueue(hidden, { ...queueState('promising'), hiddenCount: 3 }, recorder().dispatch);
  const hiddenNote = hidden.querySelector('.hidden-note').textContent;
  assert.ok(hiddenNote.includes('3 snoozed or dismissed are not shown'));
});

test('the help-calibrate card is blind: no meters, stars or pitch, just the eight labels', () => {
  const entry = get('skulitom/london-time-map');
  const r = root();
  const { actions, dispatch } = recorder();
  renderQueue(r, queueState('promising', { helpCard: entry }), dispatch);
  const blind = r.querySelector('.blind-card');
  assert.equal(blind.querySelector('.meter-q'), null);
  assert.ok(!blind.textContent.includes('stars'));
  assert.equal(blind.querySelectorAll('.labels button').length, 8);
  buttonWith(blind, 'Coursework').click();
  assert.deepEqual(actions[0], { type: 'helpLabel', id: entry.id, label: 'C' });
});

test('publishing opens a 280-character note field on a saved gem', () => {
  const last = { action: 'gem', label: 'G', reason: null, at: NOW };
  const gem = { ...get('zaghaghi/toolog'), feedback: { last, published: false, snoozeUntil: null } };
  const index = { ...SAMPLE, entries: [gem] };
  const r = root();
  const { actions, dispatch } = recorder();
  renderQueue(r, queueState('saved', { index, publishing: { id: gem.id, draft: 'Nice' } }), dispatch);
  const area = r.querySelector('textarea');
  assert.equal(area.getAttribute('maxlength'), '280');
  assert.equal(area.value, 'Nice');
  assert.ok(buttonWith(r.querySelector('.actions'), 'Publish'));
  buttonWith(r.querySelector('.publish-panel'), 'Publish').click();
  assert.equal(actions[0].type, 'publishConfirm');
});

test('Quarantine shows identity and gate reasons only, with no links at all', () => {
  const r = root();
  const state = queueState('quarantine');
  renderQuarantine(r, state, recorder().dispatch);
  assert.equal(r.querySelectorAll('.q-item').length, 2);
  assert.equal(r.querySelectorAll('a').length, 0);
  assert.ok(r.textContent.includes('https://github.com/TigerSeparate/zaPReTTeLeGrAM'));
  assert.ok(r.textContent.includes('g.lure.script'));
  assert.ok(r.textContent.includes('12.8 MB of Batchfile'));
  assert.ok(r.querySelector('.warning').textContent.startsWith('Do not download'));
  const d = root();
  const q = get('TigerSeparate/zaPReTTeLeGrAM');
  renderDetail(d, { detail: { nwo: q.nwo, record: { facts: { readme: { text: 'secret payload' } } },
    loading: false, error: null }, entry: q, why: true, model: SAMPLE.model, lib: {}, now: NOW },
  recorder().dispatch);
  assert.equal(d.querySelectorAll('a').length, 0);
  assert.ok(!d.textContent.includes('secret payload'), 'nothing from the repository is rendered');
});

test('the Why panel: rank line, a waterfall that sums to S, why not higher, raising confidence', () => {
  const entry = get('codefly-dev/cli');
  const d = root();
  renderDetail(d, { detail: { nwo: entry.nwo, record: null, loading: false, error: null }, entry, why: true,
    model: SAMPLE.model, lib: {}, now: NOW }, recorder().dispatch);
  assert.equal(d.querySelector('.rank-line').textContent,
    'Rank 12.69 = 12 points + 0.69 confidence − 0.00 attention');
  const totals = d.querySelectorAll('.wf-total').map((/** @type {any} */ n) => n.textContent);
  assert.equal(totals.at(-1), '12');
  assert.equal(d.querySelector('.wf-sum').textContent, '= 12 points of 14 available',
    'the reviewer\'s +1 adds its point to the maximum (§6.1)');
  // Weights w2 retired s.incoherent (§5.3): its hit is noted under the sum and counts for nothing.
  assert.equal(d.querySelectorAll('.wf .wf-row.minus').length, 0);
  const noted = d.querySelectorAll('.wf-noted li');
  assert.equal(noted.length, 1);
  assert.equal(noted[0].querySelector('.wf-label').textContent, 'README cites missing files');
  assert.equal(noted[0].querySelector('.wf-points').textContent, '0');
  assert.equal(noted[0].querySelector('.wf-note').textContent, 'no points');
  const whyNot = d.querySelector('.why-not').textContent;
  assert.ok(whyNot.includes('Has examples') && whyNot.includes('README matches the code'));
  assert.ok(d.querySelectorAll('.raise li').length > 0);
  assert.ok(d.querySelector('.verdict').textContent.includes('G · Genuine'));
  const github = d.querySelector('.links a');
  assert.equal(github.getAttribute('href'), 'https://github.com/codefly-dev/cli');
  assert.equal(github.getAttribute('rel'), 'noopener noreferrer nofollow');
  const hidden = root();
  const closed = { nwo: entry.nwo, record: null, loading: false, error: null };
  renderDetail(hidden, { detail: closed, entry, why: false, model: SAMPLE.model, lib: {}, now: NOW },
    recorder().dispatch);
  assert.equal(hidden.querySelector('.rank-line'), null, 'e hides the Why panel');
});

test('with a full record the pane shows README blocks, tree, commits, stars and the support ladder', () => {
  const entry = get('montezuma-p/harken');
  const record = {
    v: 1, id: entry.id, nwo: entry.nwo, verdict: null,
    facts: {
      description: entry.description, primaryLanguage: 'Rust', homepageUrl: 'https://harken.example/',
      hasDiscussions: false, hasIssues: true, releases: { count: 8, recent: [] }, watchers: 3, funding: [],
      readme: { name: 'README.md', bytes: 2048, truncated: false, text: '# Harken\n\nListens.' },
      tree: { truncated: false, count: 3, entries: [['src', 'tree'], ['src/main.rs', 'blob', 900],
        ['Cargo.toml', 'blob', 300]] },
      commits: { total: 2, recent: [{ at: '2026-09-01T00:00:00Z', headline: HOSTILE, authorLogin: 'me' }] },
      starHistory: { weeks: [{ week: '2026-08-16', gained: 0 }, { week: '2026-08-23', gained: 12 }],
        gain4w: 13 },
    },
    score: { S: 8, signals: [{ id: 'q.release', kind: 'quality', status: 'ok', hit: true, points: 1,
      weight: 1, label: 'Ships releases', reason: '8 releases', evidence: [{ label: 'releases',
        url: 'https://github.com/montezuma-p/harken/releases' }] }], confidence: { items: [] } },
  };
  /** @type {any[]} */
  const parsed = [];
  const lib = { toSafeBlocks: (/** @type {string} */ md) => {
    parsed.push(md);
    return [{ type: 'heading', level: 1, runs: [{ type: 'text', text: 'Harken' }] },
      { type: 'paragraph', runs: [{ type: 'link', text: 'site', url: 'https://harken.example/' }] }];
  } };
  const d = root();
  renderDetail(d, { detail: { nwo: entry.nwo, record, loading: false, error: null }, entry, why: true,
    model: SAMPLE.model, lib, now: NOW }, recorder().dispatch);
  assert.deepEqual(parsed, ['# Harken\n\nListens.']);
  assert.ok(d.querySelector('.readme h3'));
  assert.ok(d.querySelector('.wf-evidence a'), 'chips link to their evidence');
  assert.ok(d.querySelector('.tree-list').textContent.includes('src/'));
  assert.ok(d.querySelector('.commits').textContent.includes('<script>'));
  assert.equal(d.querySelectorAll('.commits script').length, 0);
  assert.ok(d.querySelector('.spark'));
  const ladder = d.querySelector('.ladder').textContent;
  for (const step of ['Try it', 'Star it yourself', 'Follow releases', 'Give feedback after trying it']) {
    assert.ok(ladder.includes(step), step);
  }
  assert.ok(!ladder.includes('Sponsor'), 'Sponsor only when funding exists');
});

test('explain() from src/core is used when it has loaded', () => {
  const entry = get('codefly-dev/cli');
  const explained = {
    headline: 'From explain',
    chips: [{ id: 'q.release', label: 'Ships releases', points: 1, status: 'hit' }],
    top: [], negatives: [],
    whyNotHigher: [{ label: 'Has examples', points: 1, hint: '+1 with examples' }],
    raiseConfidence: [{ label: 'People', hint: 'outsiders' }],
    rankLine: 'Rank from explain',
  };
  const lib = { explain: () => explained };
  const x = explanationFor(entry, { score: { S: 1 } }, SAMPLE.model, lib);
  assert.equal(x.fromIndex, false);
  assert.equal(x.rankLine, 'Rank from explain');
  assert.deepEqual(x.raiseConfidence, ['People: outsiders']);
  const fallback = explanationFor(entry, null, SAMPLE.model, lib);
  assert.equal(fallback.fromIndex, true, 'without a stored score the index explains');
});

test('Taste lists facets by strength with pin, mute and reset', () => {
  const taste = { v: 1, updatedAt: NOW, facets: { 'lang:go': { gems: 3, notmine: 0, pin: 0 },
    'topic:mcp': { gems: 0, notmine: 0, pin: -1 }, 'owner:org': { gems: 1, notmine: 1, pin: 0 } } };
  const r = root();
  const { actions, dispatch } = recorder();
  renderTaste(r, { taste, suggestions: ['lang:rust', 'lang:go'], mode: 'server' }, dispatch);
  const rows = r.querySelectorAll('.facet-list')[0].querySelectorAll('.facet-row');
  assert.deepEqual(rows.map((/** @type {any} */ n) => n.querySelector('.facet-value').textContent),
    ['go', 'mcp', 'org']);
  assert.equal(rows[1].querySelectorAll('button')[1].getAttribute('aria-pressed'), 'true');
  buttonWith(rows[0], 'Pin').click();
  buttonWith(rows[1], 'Mute').click();
  assert.deepEqual(actions, [{ type: 'pin', facet: 'lang:go', pin: 1 },
    { type: 'pin', facet: 'topic:mcp', pin: 0 }]);
  const suggested = r.querySelectorAll('.facet-list')[1].querySelectorAll('.facet-value')
    .map((/** @type {any} */ n) => n.textContent);
  assert.deepEqual(suggested, ['rust']);
  const empty = root();
  renderTaste(empty, { taste: null, mode: 'examples' }, recorder().dispatch);
  assert.ok(empty.textContent.includes('No taste yet'));
  assert.ok(empty.textContent.includes('kept in this browser'));
});

test('Calibrate hides the score until the label is given, then reveals it', () => {
  const entry = get('skulitom/london-time-map');
  const item = { id: entry.id, nwo: entry.nwo, stratum: 'sample', description: entry.description,
    lang: 'JavaScript',
    readme: { name: 'README.md', text: '# London', truncated: false },
    tree: { source: 'root', count: null, files: null, truncated: false, top: [{ name: 'src', type: 'tree',
      files: null, bytes: null }], more: 0 } };
  const byId = new Map([[entry.id, entry]]);
  const r = root();
  const { actions, dispatch } = recorder();
  renderCalibrate(r, { calibrate: { items: [item], pos: 0, loading: false, error: null, labels: {} }, byId,
    lib: {}, mode: 'server' }, dispatch);
  assert.ok(r.textContent.includes('1 of 1 · uniform sample'));
  assert.equal(r.querySelector('.meter-q'), null);
  assert.ok(!r.textContent.includes('points'));
  assert.equal(r.querySelectorAll('.labels button').length, 8);
  assert.equal(r.querySelectorAll('.blind a').length, 0, 'no link to the repository (its stars would show)');
  buttonWith(r, 'Genuine').click();
  assert.deepEqual(actions[0], { type: 'calLabel', id: entry.id, label: 'G' });
  const after = root();
  renderCalibrate(after, { calibrate: { items: [item], pos: 0, loading: false, error: null,
    labels: { [entry.id]: 'G' } }, byId, lib: {}, mode: 'server' }, recorder().dispatch);
  assert.ok(after.querySelector('.reveal').textContent.includes(`${entry.S} points`));
  assert.ok(after.querySelector('.meter-q'));
  const loading = root();
  renderCalibrate(loading, { calibrate: { items: [], pos: 0, loading: true, error: null, labels: {} }, byId,
    lib: {} }, recorder().dispatch);
  assert.ok(loading.textContent.includes('Drawing items'));
});

test('Status shows runs, units, the lock, the budget, sources, and the add form', () => {
  const r = root();
  const { actions, dispatch } = recorder();
  const data = { runs: [SAMPLE.lastRun], units: { done: 3 }, lock: null, rate: SAMPLE.lastRun.rate,
    canAdd: true };
  const adderState = { busy: false, error: null, done: null };
  renderStatus(r, { status: { loading: false, error: null, data }, adder: adderState, mode: 'server' },
    dispatch);
  assert.equal(r.querySelectorAll('table.runs tbody tr').length, 1);
  assert.ok(r.textContent.includes('done: 3'));
  assert.ok(r.textContent.includes('Free: no run is in progress.'));
  assert.ok(r.textContent.includes('GraphQL: 30 points'));
  assert.ok(r.textContent.includes('census days 2026-09-08'));
  const input = r.querySelector('#add-nwo');
  input.value = 'o/r';
  buttonWith(r, 'Add').click();
  assert.deepEqual(actions[0], { type: 'add', nwo: 'o/r' });
  const examples = root();
  renderStatus(examples, { status: { loading: false, error: null, data: { ...data, canAdd: false } },
    adder: { busy: false, error: null, done: null }, mode: 'examples' }, recorder().dispatch);
  assert.ok(examples.textContent.includes('No runs yet'));
  assert.ok(examples.querySelector('#add-nwo').hasAttribute('disabled'));
});

test('the frame: shelves with counts, facets with live counts, banners, help and the chord hint', () => {
  const route = { screen: 'shelf', shelf: 'look', nwo: null, filters: { ...emptyFilters(), lang: ['Go'] } };
  const shelves = root();
  renderShelves(shelves, { route, counts: shelfCounts(SAMPLE, { now: NOW }) });
  const links = shelves.querySelectorAll('a');
  assert.equal(links.length, 13);
  const current = links.find((/** @type {any} */ a) => a.getAttribute('aria-current') === 'page');
  assert.ok(current.textContent.startsWith('Worth a look'));
  assert.equal(links[0].getAttribute('href'), '#/promising?lang=Go');
  const list = shelf(SAMPLE, 'foryou', {}, { now: NOW });
  const facets = root();
  const { actions, dispatch } = recorder();
  renderFacets(facets, { route, facets: facetCounts(list, route.filters), hiddenCount: 2 }, dispatch);
  const go = facets.querySelectorAll('label.opt')
    .find((/** @type {any} */ l) => l.textContent.startsWith('Go'));
  assert.equal(go.querySelector('input').checked, true);
  go.querySelector('input').dispatchEvent(createEvent('change'));
  assert.deepEqual(actions[0], { type: 'filter', patch: { lang: [] } });
  assert.ok(buttonWith(facets, 'Clear the filters'));
  const banner = root();
  renderBanner(banner, { phase: 'ready', error: null, mode: 'examples', firstRun: true, scope: 'Rust',
    languages: ['Rust', 'Go'] }, recorder().dispatch);
  assert.ok(banner.textContent.includes('Examples.'));
  assert.equal(banner.querySelector('pre.cmd').textContent, 'npm run unsung -- run --lang Rust');
  const staticBanner = root();
  renderBanner(staticBanner, { phase: 'ready', error: null, mode: 'static', firstRun: false, scope: '',
    languages: [] }, recorder().dispatch);
  assert.ok(buttonWith(staticBanner, 'Export decisions'));
  const run = root();
  renderRunInfo(run, { mode: 'server', index: SAMPLE });
  assert.ok(run.textContent.startsWith('Last run 11 Sep, 16:00 UTC · 30 points'));
  const overlay = root();
  renderOverlay(overlay, { help: true }, recorder().dispatch);
  assert.equal(overlay.hidden, false);
  assert.ok(overlay.querySelectorAll('.keys tr').length >= 14);
  renderOverlay(overlay, { help: false }, recorder().dispatch);
  assert.equal(overlay.hidden, true);
  const toastRoot = root();
  renderToast(toastRoot, { chord: 'notgood', toast: null });
  assert.ok(toastRoot.textContent.includes('Slop or scaffold'));
});

test('no view creates a script, style, iframe or image element', () => {
  const r = root();
  renderQueue(r, queueState('promising'), recorder().dispatch);
  renderDetail(r, { detail: { nwo: 'codefly-dev/cli', record: null, loading: false, error: null },
    entry: get('codefly-dev/cli'), why: true, model: SAMPLE.model, lib: {}, now: NOW }, recorder().dispatch);
  const tags = new Set(allElements(r).map((/** @type {any} */ n) => n.localName));
  for (const bad of ['script', 'style', 'iframe', 'img', 'object', 'embed', 'form']) {
    assert.ok(!tags.has(bad), bad);
  }
});

test('a card links to its detail pane on the same shelf, with the same filters', () => {
  const state = queueState('look');
  state.route = { ...state.route, filters: { ...emptyFilters(), lang: ['Rust'] } };
  const r = root();
  renderQueue(r, state, recorder().dispatch);
  const links = r.querySelectorAll('li.card a.repo');
  assert.equal(links.length, state.list.length);
  links.forEach((/** @type {any} */ a, /** @type {number} */ i) => {
    const route = parseHash(a.getAttribute('href'));
    assert.deepEqual([route.screen, route.shelf, route.nwo, route.filters.lang],
      ['repo', 'look', state.list[i].nwo, ['Rust']]);
  });
  assert.match(links[0].getAttribute('href'), /\?shelf=look&lang=Rust$/);
});

test('the first-run command quotes a scope with spaces, so the shell passes it whole', () => {
  const banner = root();
  const { actions, dispatch } = recorder();
  renderBanner(banner, { phase: 'ready', error: null, mode: 'examples', firstRun: true,
    scope: 'Jupyter Notebook', languages: ['Jupyter Notebook', 'Rust'] }, dispatch);
  const command = 'npm run unsung -- run --lang "Jupyter Notebook"';
  assert.equal(banner.querySelector('pre.cmd').textContent, command);
  buttonWith(banner, 'Copy the command').click();
  assert.deepEqual(actions.at(-1), { type: 'copy', text: command });
  assert.equal(firstRunCommand(''), 'npm run unsung -- run');
  assert.equal(firstRunCommand('C++'), 'npm run unsung -- run --lang C++');
  for (const [raw, arg] of [['Rust', 'Rust'], ['C#', 'C#'], ['Vim Script', '"Vim Script"'],
    ["Ren'Py", '"Ren\'Py"'], ['a"b$c`d\\e!', '"abcde"']]) {
    assert.equal(shellArg(raw), arg, raw);
  }
});

test('the triage bar offers Unpublish for anything still published, saved or not', () => {
  const { actions, dispatch } = recorder();
  const published = triageBar({ id: 'R_x' }, dispatch, { saved: false, published: true });
  buttonWith(published, 'Unpublish').click();
  assert.deepEqual(actions.at(-1), { type: 'publish', id: 'R_x' });
  assert.ok(buttonWith(triageBar({ id: 'R_x' }, dispatch, { saved: true }), 'Publish'));
  assert.equal(buttonWith(triageBar({ id: 'R_x' }, dispatch, {}), 'ublish'), undefined, 'nothing to publish yet');
});

test('Calibrate\'s "Draw again" asks for a fresh draw', () => {
  const entry = get('skulitom/london-time-map');
  const item = { id: entry.id, nwo: entry.nwo, stratum: 'pool', description: entry.description,
    lang: 'JavaScript', readme: { name: 'README.md', text: '# London', truncated: false },
    tree: { source: 'root', count: null, files: null, truncated: false, top: [], more: 0 } };
  const { actions, dispatch } = recorder();
  for (const items of [[], [item]]) {
    const r = root();
    renderCalibrate(r, { calibrate: { items, pos: 0, loading: false, error: null, labels: {} },
      byId: new Map(), lib: {}, mode: 'server' }, dispatch);
    buttonWith(r, 'Draw again').click();
  }
  assert.deepEqual(actions, [{ type: 'calLoad', fresh: true }, { type: 'calLoad', fresh: true }]);
});

test('in examples mode the Status screen lists no runs under its "No runs yet" note', () => {
  const r = root();
  const data = { runs: [], units: {}, lock: null, rate: null, examples: true, canAdd: false };
  renderStatus(r, { status: { loading: false, error: null, data }, adder: { busy: false, error: null,
    done: null }, mode: 'examples' }, recorder().dispatch);
  assert.ok(r.textContent.includes('No runs yet'));
  assert.equal(r.querySelector('table.runs'), null);
  assert.ok(r.textContent.includes('No runs recorded yet.'));
  assert.ok(r.textContent.includes('No budget recorded yet.'));
});

test('a quarantined repository saved as a gem earlier appears only in Quarantine (§7.6)', () => {
  const gem = { last: { action: 'gem', label: 'G', reason: null, at: NOW }, published: false, snoozeUntil: null };
  const q = get('TigerSeparate/zaPReTTeLeGrAM');
  const b = get('sakajunquality/bunko');
  const index = { ...SAMPLE, entries: overlayFeedback(SAMPLE.entries, { [q.id]: gem, [b.id]: gem }) };
  assert.deepEqual(shelf(index, 'saved', {}, { now: NOW }).map((e) => e.nwo), ['sakajunquality/bunko']);
  const counts = shelfCounts(index, { now: NOW });
  assert.equal(counts.saved, 1);
  assert.equal(counts.quarantine, 2, 'a dismissed quarantined repository is still counted there');
  assert.ok(shelf(index, 'quarantine', {}, { now: NOW }).some((e) => e.nwo === q.nwo), 'and listed there');
  const r = root();
  renderQueue(r, queueState('saved', { index }), recorder().dispatch);
  assert.deepEqual(r.querySelectorAll('li.card a.repo').map((/** @type {any} */ a) => a.textContent),
    ['sakajunquality/bunko']);
});

test('a blind label leaves the queue state of an earlier decision alone, and so does its undo', () => {
  const b = get('sakajunquality/bunko');
  const saved = { last: { action: 'gem', label: 'G', reason: null, at: '2026-09-10T10:00:00.000Z' },
    published: false, snoozeUntil: null };
  const index = { ...SAMPLE, entries: overlayFeedback(SAMPLE.entries, { [b.id]: saved }) };
  const label = /** @type {any} */ ({ v: 1, at: NOW, ...makeFeedback({ entry: b, action: 'label', label: 'G',
    blind: true, stratum: 'pool', now: NOW }) });
  /**
   * @param {any} t
   * @param {string} name
   */
  const ids = (t, name) => shelf({ ...index, entries: overlayFeedback(index.entries, t.feedback) }, name, {},
    { now: NOW }).map((e) => e.id);
  const labelled = triageReducer(initialTriage(), { type: 'decide', event: label, prev: null });
  assert.ok(ids(labelled, 'saved').includes(b.id), 'still saved');
  assert.ok(!ids(labelled, 'promising').includes(b.id), 'not back in the queue');
  assert.equal(labelled.undo.length, 1, 'the label can be undone');
  assert.equal(labelled.decisions, 0, 'a label is not a triage decision');
  const undo = /** @type {any} */ ({ id: b.id, undoes: label.at });
  const undone = triageReducer(labelled, { type: 'undo', event: undo });
  assert.equal(undone.undo.length, 0);
  assert.ok(ids(undone, 'saved').includes(b.id));
  assert.ok(!ids(undone, 'promising').includes(b.id));
});
