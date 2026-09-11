// @ts-check
/**
 * The explorer's pure view logic (DESIGN §6.7, §10.2–§10.7): shelves, filters and live counts,
 * the URL hash, feedback folding, the triage reducer for every §10.4 action, and the helpers the
 * server and CLI share.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJsonFixture } from './support/fixtures.mjs';
import { validateFeedback } from '../src/core/schema.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import {
  DEFAULT_SHELF, EVIDENCE, HELP_EVERY, SHELVES, SHELF_NAMES, UNDO_LIMIT, applyFilters, blindItem,
  compareEntries, emptyFilters, facetCounts, foldFeedback, hasEvidence, initialTriage, isHidden, isNwo,
  labelledIds, makeFeedback, mergeFeedback, overlayFeedback, parseFeedbackExport, parseHash,
  pickHelpCalibrate, scriptKey, shelf, shelfCounts, shouldOfferHelp, toHash, treeSummary, triageReducer,
} from '../src/core/views.mjs';

/** @typedef {import('../src/core/schema.mjs').IndexEntry} IndexEntry */
/** @typedef {import('../src/core/schema.mjs').Feedback} Feedback */

/** @type {import('../src/core/schema.mjs').Index} */
const index = loadJsonFixture('index.sample.json');
const NOW = '2026-09-11T16:00:00.000Z';
const byNwo = new Map(index.entries.map((e) => [e.nwo, e]));

/**
 * @param {string} nwo
 * @returns {IndexEntry}
 */
function get(nwo) {
  const e = byNwo.get(nwo);
  if (!e) throw new Error(`no entry ${nwo}`);
  return e;
}

/**
 * A stamped feedback event built the way the explorer builds one.
 * @param {IndexEntry} entry
 * @param {Feedback['action']} action
 * @param {string} at
 * @param {Partial<Parameters<typeof makeFeedback>[0]>} [extra]
 * @returns {Feedback}
 */
function stamped(entry, action, at, extra = {}) {
  return { v: 1, at, ...makeFeedback({ entry, action, now: at, ...extra }) };
}

test('the shelves are those of §10.2, in order', () => {
  assert.deepEqual(SHELVES.map((s) => s.label), ['Promising', 'Proven', 'Worth a look', 'For you', 'Saved',
    'Doubted', 'Institutional', 'Rising', 'Graduated', 'Quarantine']);
  assert.equal(DEFAULT_SHELF, 'promising');
});

test('each lane shelf holds its lane, sorted by gem, then stars, then creation', () => {
  for (const def of SHELVES) {
    if (!def.lanes || def.name === 'foryou') continue;
    const list = shelf(index, def.name, {}, { now: NOW });
    assert.equal(list.length, index.entries.filter((e) => def.lanes?.includes(e.lane)).length, def.name);
    assert.deepEqual(list, [...list].sort(compareEntries), def.name);
  }
  assert.deepEqual(shelfCounts(index, { now: NOW }), {
    promising: 14, proven: 3, look: 8, foryou: 25, saved: 0, doubted: 3, institutional: 5, rising: 1,
    graduated: 2, quarantine: 2,
  });
});

test('gem, not good and not mine leave the queue; wip and snooze leave it until the snooze ends', () => {
  const bunko = get('sakajunquality/bunko');
  const toolog = get('zaghaghi/toolog');
  const dropzone = get('dragonGR/Dropzone');
  const foxsdr = get('wonderingStars/foxsdr');
  const codefly = get('codefly-dev/cli');
  const events = [
    stamped(bunko, 'gem', '2026-09-11T10:00:00.000Z'),
    stamped(toolog, 'notgood', '2026-09-11T10:01:00.000Z', { reason: 'clone' }),
    stamped(dropzone, 'wip', '2026-09-11T10:02:00.000Z'),
    stamped(foxsdr, 'snooze', '2026-09-11T10:03:00.000Z', { snoozeUntil: '2026-09-12T00:00:00.000Z' }),
    stamped(codefly, 'notmine', '2026-09-11T10:04:00.000Z'),
  ];
  const overlaid = { ...index, entries: overlayFeedback(index.entries, foldFeedback(events)) };
  const visible = shelf(overlaid, 'promising', {}, { now: NOW }).map((e) => e.nwo);
  const gone = ['sakajunquality/bunko', 'dragonGR/Dropzone', 'wonderingStars/foxsdr', 'codefly-dev/cli'];
  for (const nwo of gone) {
    assert.ok(!visible.includes(nwo), nwo);
  }
  assert.equal(visible.length, 14 - 4 - (get('zaghaghi/toolog').lane === 'promising' ? 1 : 0));
  assert.deepEqual(shelf(overlaid, 'saved', {}, { now: NOW }).map((e) => e.nwo), ['sakajunquality/bunko']);
  const later = '2026-09-12T00:00:01.000Z';
  assert.ok(shelf(overlaid, 'promising', {}, { now: later }).some((e) => e.nwo === 'wonderingStars/foxsdr'));
  const all = shelf(overlaid, 'promising', { hidden: true }, { now: NOW });
  assert.equal(all.length, 14, '"show snoozed and dismissed" shows them all');
  assert.equal(isHidden({ feedback: { last: 'gem', published: false, snoozeUntil: null } }, NOW), true,
    'a bare action string also counts');
});

test('filters: language, age, stars, evidence, README script, agent-assisted and free text', () => {
  const look = shelf(index, 'foryou', {}, { now: NOW });
  const go = applyFilters(look, { lang: ['Go'] });
  assert.ok(go.length > 0 && go.every((e) => e.lang === 'Go'));
  assert.ok(applyFilters(look, { age: 7 }).every((e) => typeof e.ageDays === 'number' && e.ageDays <= 7));
  assert.ok(applyFilters(look, { stars: 0 }).every((e) => e.stars === 0));
  const both = applyFilters(look, { evidence: ['tests', 'release'] });
  assert.ok(both.length > 0 && both.every((e) => hasEvidence(e, 'tests') && hasEvidence(e, 'release')));
  assert.ok(applyFilters(look, { evidence: ['ci'] }).every((e) => e.chips?.some((c) => c.id === 'p.testsRun'
    && c.hit)));
  const latin = applyFilters(look, { script: ['latin'] });
  assert.ok(latin.length > 0 && latin.every((e) => scriptKey(e) === 'latin'));
  const cjk = applyFilters(look, { script: ['cjk'] });
  assert.ok(cjk.length > 0 && cjk.every((e) => e.facets?.includes('script:cjk')), 'a CJK README (§5.6)');
  assert.equal(latin.length + cjk.length, look.length);
  const agent = applyFilters(look, { agent: true });
  const human = applyFilters(look, { agent: false });
  assert.equal(agent.length + human.length, look.length);
  assert.ok(agent.every((e) => e.descriptors?.includes('d.agent')));
  const text = applyFilters(look, { q: 'LONDON map' });
  assert.deepEqual(text.map((e) => e.nwo), ['skulitom/london-time-map']);
  assert.deepEqual(applyFilters(look, emptyFilters()), look);
});

test('facet counts are live: each group is counted under the other filters', () => {
  const list = shelf(index, 'foryou', {}, { now: NOW });
  const counts = facetCounts(list, { lang: ['Go'], stars: 25 });
  assert.ok(Object.keys(counts.lang).length > 1, 'other languages keep their counts while Go is chosen');
  assert.equal(counts.lang.Go, list.filter((e) => e.lang === 'Go').length);
  assert.equal(counts.total, applyFilters(list, { lang: ['Go'], stars: 25 }).length);
  assert.equal(counts.stars['0'], list.filter((e) => e.lang === 'Go' && e.stars === 0).length);
  const plain = facetCounts(list);
  for (const k of EVIDENCE) assert.equal(plain.evidence[k], list.filter((e) => hasEvidence(e, k)).length, k);
  const withTests = facetCounts(list, { evidence: ['tests'] });
  assert.equal(withTests.evidence.release, list.filter((e) => hasEvidence(e, 'tests')
    && hasEvidence(e, 'release')).length);
  assert.equal(plain.agent.yes + plain.agent.no, list.length);
});

test('the hash names a shelf, a screen or a repository, and anything else falls back', () => {
  assert.deepEqual(parseHash(''),
    { screen: 'shelf', shelf: 'promising', nwo: null, filters: emptyFilters() });
  assert.equal(parseHash('#/proven').shelf, 'proven');
  assert.equal(parseHash('#/calibrate').screen, 'calibrate');
  assert.deepEqual(parseHash('#/r/skulitom/london-time-map'), {
    screen: 'repo', shelf: 'promising', nwo: 'skulitom/london-time-map', filters: emptyFilters() });
  assert.equal(parseHash('#/r/../etc').screen, 'shelf');
  assert.equal(parseHash('#/r/a/..').screen, 'shelf');
  assert.equal(parseHash('#/nonsense?shelf=rising').shelf, 'rising');
  assert.deepEqual(parseHash('#/look?lang=%E0%A4%A&age=12&stars=5&ev=tests,bogus').filters,
    { ...emptyFilters(), lang: [], stars: 5, evidence: ['tests'] });
  assert.equal(toHash(parseHash('')), '#/promising');
  assert.equal(toHash({ screen: 'repo', nwo: 'not a repo' }), '#/promising');
});

test('parseHash(toHash(state)) gives the state back', () => {
  const rand = mulberry32(99);
  /** @param {string[]} xs */
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  for (let i = 0; i < 300; i++) {
    const screen = /** @type {any} */ (pick(['shelf', 'repo', 'calibrate', 'taste', 'status']));
    const state = {
      screen,
      shelf: pick([...SHELF_NAMES]),
      nwo: screen === 'repo' ? pick(['skulitom/london-time-map', 'a-b/c.d_e', 'x/y']) : null,
      filters: {
        q: pick(['', 'map', 'rust cli', 'a&b=c #1', '100% ümlaut']),
        lang: rand() < 0.5 ? [] : [pick(['Go', 'C++', 'C#', 'Jupyter Notebook']), 'Rust'],
        age: /** @type {any} */ (pick([null, 7, 30, 90])),
        stars: /** @type {any} */ (pick([null, 0, 5, 25])),
        evidence: /** @type {any} */ (rand() < 0.5 ? [] : ['release', 'demo']),
        script: rand() < 0.7 ? [] : ['latin', 'cjk'],
        agent: /** @type {any} */ (pick([null, true, false])),
        hidden: rand() < 0.3,
      },
    };
    const back = parseHash(toHash(state));
    const expectShelf = screen === 'shelf' ? state.shelf : state.shelf;
    assert.deepEqual(back, { ...state, shelf: expectShelf }, toHash(state));
  }
});

test('feedback folds into queue state; undone events and blind labels do not move the queue', () => {
  const e = get('zaghaghi/toolog');
  const gem = stamped(e, 'gem', '2026-09-11T10:00:00.000Z');
  const publish = stamped(e, 'publish', '2026-09-11T10:01:00.000Z', { note: 'Lovely little tool' });
  const label = stamped(e, 'label', '2026-09-11T10:02:00.000Z', { label: 'G', blind: true });
  assert.deepEqual(foldFeedback([gem, publish, label])[e.id], {
    last: { action: 'gem', label: 'G', reason: null, at: gem.at }, published: true, snoozeUntil: null });
  const undo = stamped(e, 'undo', '2026-09-11T10:03:00.000Z', { undoes: gem.at });
  assert.deepEqual(foldFeedback([gem, undo])[e.id], undefined);
  assert.deepEqual(labelledIds([gem, label]), new Set([e.id]));
  const overlaid = overlayFeedback(index.entries, foldFeedback([gem]));
  assert.equal(overlaid.filter((x, i) => x !== index.entries[i]).length, 1);
});

test('makeFeedback builds a valid event for every action, with the §10.3 labels and snoozes', () => {
  const e = get('skulitom/london-time-map');
  const model = index.model;
  /** @type {[Feedback['action'], Record<string, unknown>, string | null][]} */
  const cases = [
    ['gem', {}, 'G'], ['wip', {}, 'W'], ['notmine', {}, null], ['snooze', {}, null], ['publish', {}, null],
    ['unpublish', {}, null], ['label', { label: 'D', blind: true, stratum: 'sample' }, 'D'],
    ['undo', { undoes: '2026-09-11T09:00:00.000Z' }, null],
  ];
  for (const [action, extra, label] of cases) {
    const ev = stamped(e, action, NOW, { model, view: 'promising', position: 2, ...extra });
    assert.deepEqual(validateFeedback(ev), [], action);
    assert.equal(ev.label, label, action);
    assert.equal(ev.context?.weights, model.weights?.version);
  }
  for (const [reason, label] of Object.entries({ slop: 'S', clone: 'C', personal: 'P', spam: 'X', dump: 'D',
    empty: 'E' })) {
    const ev = stamped(e, 'notgood', NOW, { reason: /** @type {any} */ (reason) });
    assert.deepEqual(validateFeedback(ev), []);
    assert.equal(ev.label, label);
  }
  assert.equal(stamped(e, 'wip', NOW).snoozeUntil, '2026-10-11T16:00:00.000Z');
  const long = stamped(e, 'publish', NOW, { note: 'é'.repeat(400) });
  assert.equal([...long.note].length, 280);
  assert.equal(stamped(e, 'label', NOW, { label: 'G', stratum: 'pool' }).context?.stratum, 'pool');
});

test('triage: every §10.4 action, including undo', () => {
  const ids = ['a', 'b', 'c', 'd'];
  /**
   * @param {string} id
   * @param {Feedback['action']} action
   * @param {string} at
   * @param {Partial<Feedback>} [x]
   */
  const decide = (id, action, at, x = {}) => ({ type: /** @type {'decide'} */ ('decide'),
    event: stamped({ ...get('zaghaghi/toolog'), id, nwo: `o/${id}` }, action, at, x) });
  let s = triageReducer(initialTriage(), { type: 'load', ids });
  assert.equal(s.pos, 0);
  s = triageReducer(s, { type: 'next' });
  assert.equal(s.ids[s.pos], 'b');

  // gem: leaves the queue, the cursor moves to the next card, one decision, undoable.
  s = triageReducer(s, decide('b', 'gem', '2026-09-11T10:00:00.000Z'));
  assert.deepEqual(s.ids, ['a', 'c', 'd']);
  assert.equal(s.ids[s.pos], 'c');
  assert.equal(s.decisions, 1);
  assert.equal(s.feedback.b.last?.action, 'gem');

  // wip: snoozed 30 days.
  s = triageReducer(s, decide('c', 'wip', '2026-09-11T10:01:00.000Z'));
  assert.deepEqual(s.ids, ['a', 'd']);
  assert.equal(s.feedback.c.snoozeUntil, '2026-10-11T10:01:00.000Z');

  // notgood with a reason, notmine and snooze all leave.
  s = triageReducer(s, decide('d', 'notgood', '2026-09-11T10:02:00.000Z', { reason: 'slop' }));
  assert.equal(s.feedback.d.last?.label, 'S');
  s = triageReducer(s, decide('a', 'notmine', '2026-09-11T10:03:00.000Z'));
  assert.deepEqual(s.ids, []);
  assert.equal(s.pos, -1);
  assert.equal(s.decisions, 4);

  // undo restores the newest decision where it was.
  s = triageReducer(s, { type: 'undo' });
  assert.deepEqual(s.ids, ['a']);
  assert.equal(s.pos, 0);
  assert.equal(s.decisions, 3);
  assert.deepEqual(s.feedback.a, { last: null, published: false, snoozeUntil: null });
  s = triageReducer(s, { type: 'undo' });
  assert.deepEqual(s.ids, ['a', 'd']);
  assert.equal(s.ids[s.pos], 'd');

  // snooze takes an entry out until its snoozeUntil.
  s = triageReducer(s, decide('a', 'snooze', '2026-09-11T10:04:00.000Z'));
  assert.deepEqual(s.ids, ['d']);
  assert.ok(s.feedback.a.snoozeUntil);

  // publish, unpublish and label never move the queue and are not triage decisions.
  const before = s.decisions;
  s = triageReducer(s, decide('d', 'publish', '2026-09-11T10:05:00.000Z'));
  assert.equal(s.feedback.d.published, true);
  s = triageReducer(s, decide('d', 'unpublish', '2026-09-11T10:06:00.000Z'));
  assert.equal(s.feedback.d.published, false);
  s = triageReducer(s, decide('d', 'label', '2026-09-11T10:07:00.000Z', { label: 'G', blind: true }));
  assert.deepEqual(s.ids, ['d']);
  assert.equal(s.decisions, before);

  // undo of a named event (by its time) restores that one, even if it is not the newest.
  s = triageReducer(s, { type: 'undo', event: { ...stamped(get('zaghaghi/toolog'), 'undo',
    '2026-09-11T10:08:00.000Z', { undoes: '2026-09-11T10:00:00.000Z' }), id: 'b' } });
  assert.ok(s.ids.includes('b'));
  assert.equal(s.feedback.b.last, null);
});

test('triage: navigation is bounded, unknown actions change nothing, and undo stacks are capped', () => {
  let s = triageReducer(undefined, { type: 'load', ids: ['a', 'b'] });
  s = triageReducer(s, { type: 'prev' });
  assert.equal(s.pos, 0);
  s = triageReducer(triageReducer(triageReducer(s, { type: 'next' }), { type: 'next' }), { type: 'next' });
  assert.equal(s.pos, 1);
  assert.equal(triageReducer(s, { type: 'first' }).pos, 0);
  assert.equal(triageReducer(s, { type: 'select', id: 'a' }).pos, 0);
  assert.equal(triageReducer(s, { type: 'select', id: 'zzz' }), s);
  assert.equal(triageReducer(s, /** @type {any} */ ({ type: 'bogus' })), s);
  assert.equal(triageReducer(s, { type: 'undo' }), s, 'nothing to undo');
  const reloaded = triageReducer(s, { type: 'load', ids: ['x', 'b', 'y'] });
  assert.equal(reloaded.ids[reloaded.pos], 'b', 'the cursor stays on the same card');
  let many = triageReducer(undefined, { type: 'load', ids: [] });
  for (let i = 0; i < UNDO_LIMIT + 10; i++) {
    const at = new Date(Date.parse(NOW) + i * 1000).toISOString();
    many = triageReducer(many, { type: 'decide', event: stamped({ ...get('zaghaghi/toolog'), id: `r${i}`,
      nwo: `o/r${i}` }, 'snooze', at) });
  }
  assert.equal(many.undo.length, UNDO_LIMIT);
  assert.equal(many.decisions, UNDO_LIMIT + 10);
});

test('help calibrate: every 20 decisions, an unlabelled entry from the uncertain band', () => {
  assert.equal(HELP_EVERY, 20);
  assert.equal(shouldOfferHelp(0), false);
  assert.equal(shouldOfferHelp(19), false);
  assert.equal(shouldOfferHelp(20), true);
  assert.equal(shouldOfferHelp(40), true);
  const entries = index.entries.map((e, i) => ({ ...e, quality: i % 3 === 0 ? 0.5 : 0.9 }));
  const rand = mulberry32(1);
  for (let i = 0; i < 20; i++) {
    const pick = pickHelpCalibrate(entries, { rand });
    assert.ok(pick && pick.quality === 0.5 && pick.lane !== 'quarantine');
  }
  const all = new Set(entries.map((e) => e.id));
  assert.equal(pickHelpCalibrate(entries, { labelled: all }), null);
});

test('imported feedback: duplicates skipped, invalid events reported, the rest in time order', () => {
  const e = get('zaghaghi/toolog');
  const a = stamped(e, 'gem', '2026-09-11T10:00:00.000Z');
  const b = stamped(e, 'publish', '2026-09-11T09:00:00.000Z');
  const { label: _dropped, ...unlabelled } = stamped(e, 'wip', '2026-09-11T11:00:00.000Z');
  const bad = { ...stamped(e, 'notgood', '2026-09-11T12:00:00.000Z', { reason: 'slop' }), reason: null };
  const result = mergeFeedback([a], [a, unlabelled, b, bad, 'junk']);
  assert.equal(result.duplicates, 1);
  assert.deepEqual(result.invalid.map((x) => x.index), [3, 4]);
  assert.deepEqual(result.added.map((x) => x.at), [b.at, unlabelled.at]);
  assert.equal(result.added[1].label, 'W', 'a missing label is derived');
  assert.deepEqual(parseFeedbackExport([a]), { events: [a], pins: {} });
  assert.deepEqual(parseFeedbackExport({ v: 1, events: [a], pins: { 'lang:go': 1, 'bad key': 1, 'x:y': 5 } }),
    { events: [a], pins: { 'lang:go': 1 } });
  assert.throws(() => parseFeedbackExport({ v: 1 }), TypeError);
  assert.throws(() => parseFeedbackExport('text'), TypeError);
});

test('a blind Calibrate item carries no score, chip, star or verdict field', () => {
  const record = {
    id: 'R_1', nwo: 'o/r', gone: false,
    facts: { description: 'A thing', primaryLanguage: 'Rust', stars: 12, forks: 3, watchers: 4,
      readme: { name: 'README.md', bytes: 20, truncated: false, text: '# Hi' },
      tree: { truncated: false, count: 3, entries: [['src', 'tree'], ['src/main.rs', 'blob', 100],
        ['Cargo.toml', 'blob', 20]] } },
    score: { S: 9, quality: 0.97, signals: [], lane: 'proven' }, verdict: { output: { category: 'G' } },
  };
  const item = blindItem(/** @type {any} */ (record), 'sample');
  const forbidden = ['S', 'quality', 'score', 'signals', 'chips', 'stars', 'forks', 'watchers', 'verdict',
    'gem', 'k', 'lane', 'band', 'points', 'a', 'pointsMax', 'coverage'];
  const text = JSON.stringify(item);
  for (const key of forbidden) assert.ok(!text.includes(`"${key}":`), key);
  assert.equal(item.stratum, 'sample');
  assert.equal(item.lang, 'Rust');
  assert.equal(item.readme?.text, '# Hi');
  assert.deepEqual(item.tree?.top.map((t) => [t.name, t.files]), [['src', 1], ['Cargo.toml', 1]]);
});

test('tree summaries prefer the deep tree and fall back to the root listing', () => {
  assert.equal(treeSummary(null), null);
  const root = treeSummary({ root: [{ name: 'README.md', type: 'blob' }, { name: 'src', type: 'tree' }] });
  assert.deepEqual(root?.top.map((t) => t.name), ['src', 'README.md']);
  assert.equal(root?.source, 'root');
  const big = treeSummary({ tree: { truncated: true, count: 90, entries: Array.from({ length: 60 },
    (_, i) => [`f${i}.txt`, 'blob', 1]) } }, 10);
  assert.equal(big?.top.length, 10);
  assert.equal(big?.more, 50);
  assert.equal(big?.truncated, true);
});

test('owner/name validation', () => {
  for (const ok of ['skulitom/london-time-map', 'a/b', 'A-1/x.y_z']) assert.ok(isNwo(ok), ok);
  for (const bad of ['a', 'a/b/c', '../x', 'a/..', 'a/.', '-a/b', 'a b/c', '', null, 'a/b?x']) {
    assert.ok(!isNwo(bad), String(bad));
  }
});
