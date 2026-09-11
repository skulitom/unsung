// @ts-check
/**
 * Personalisation (DESIGN §10.6, §6.7): facets, affinity, the taste term, rebuilding from
 * feedback, and the For you order — which must never move an entry across a band.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadJsonFixture } from './support/fixtures.mjs';
import { validateTaste } from '../src/core/schema.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import {
  EPOCH, PIN_AFFINITY, WILDCARD_EVERY, activeFeedback, affinity, applyFeedback, bandOf, compareEntries,
  emptyTaste, facetsOf, forYou, forYouSlots, pinsOf, rebuildTaste, setPin, tasteTerm,
} from '../src/core/taste.mjs';

/** @typedef {import('../src/core/schema.mjs').IndexEntry} IndexEntry */
/** @typedef {import('../src/core/schema.mjs').Feedback} Feedback */

/** @type {import('../src/core/schema.mjs').Index} */
const index = loadJsonFixture('index.sample.json');
const byId = new Map(index.entries.map((e) => [e.id, e]));

/**
 * @param {string} id
 * @param {Feedback['action']} action
 * @param {string} at
 * @param {Partial<Feedback>} [extra]
 * @returns {Feedback}
 */
function ev(id, action, at, extra = {}) {
  const labels = /** @type {Record<string, 'G' | 'W'>} */ ({ gem: 'G', wip: 'W' });
  return {
    v: 1, at, id, nwo: byId.get(id)?.nwo ?? 'someone/else', action, label: labels[action] ?? null,
    reason: null, note: '', blind: false, undoes: null, snoozeUntil: null, context: null, ...extra,
  };
}

/**
 * @param {Partial<IndexEntry>} fields
 * @returns {IndexEntry}
 */
function entry(fields) {
  return /** @type {IndexEntry} */ ({ id: 'R_x', nwo: 'o/x', lane: 'promising', gates: [], ...fields });
}

const codefly = /** @type {IndexEntry} */ (index.entries.find((e) => e.nwo === 'codefly-dev/cli'));

test('facets come from the index entry, lower-cased and de-duplicated, with at most 8 topics', () => {
  assert.deepEqual(facetsOf(codefly), ['lang:go', 'owner:org', 'script:latin', 'kind:genuine']);
  const topics = Array.from({ length: 12 }, (_, i) => `topic:t${i}`);
  const messy = ['Lang:Rust', 'lang:rust', ...topics, 'owner:user', 'bad', ':x', 'y:'];
  const f = facetsOf(entry({ facets: messy }));
  assert.deepEqual(f, ['lang:rust', ...topics.slice(0, 8), 'owner:user']);
});

test('without a facet list, language and topics are derived; a verdict adds its kind', () => {
  const f = facetsOf(entry({ lang: 'Jupyter Notebook', topics: ['CLI Tools', 'mcp'], verdict: {
    category: 'C', pitch: null, points: -2 } }));
  assert.deepEqual(f, ['lang:jupyter-notebook', 'topic:cli-tools', 'topic:mcp', 'kind:coursework']);
  assert.deepEqual(facetsOf(null), []);
  assert.deepEqual(facetsOf(entry({})), []);
});

test('affinity is ln((gems + 1) / (notmine + 1)), and ±0.7 when pinned or muted', () => {
  const state = { v: /** @type {1} */ (1), updatedAt: EPOCH, facets: {
    'lang:go': { gems: 3, notmine: 1, pin: /** @type {0} */ (0) },
    'lang:rust': { gems: 0, notmine: 9, pin: /** @type {1} */ (1) },
    'owner:org': { gems: 9, notmine: 0, pin: /** @type {-1} */ (-1) },
  } };
  assert.equal(affinity(state, 'lang:go'), Math.log(4 / 2));
  assert.equal(affinity(state, 'lang:rust'), PIN_AFFINITY);
  assert.equal(affinity(state, 'owner:org'), -PIN_AFFINITY);
  assert.equal(affinity(state, 'topic:unknown'), 0);
  assert.equal(affinity(null, 'lang:go'), 0);
});

test('the taste term is the mean affinity over the entry’s facets, clamped to [−1, 1]', () => {
  const state = { v: /** @type {1} */ (1), updatedAt: EPOCH, facets: {
    'lang:go': { gems: 3, notmine: 0, pin: /** @type {0} */ (0) },
  } };
  // Four facets: ln 4 on one of them, 0 on the rest.
  assert.ok(Math.abs(tasteTerm(state, codefly) - Math.log(4) / 4) < 1e-12);
  const extreme = { v: /** @type {1} */ (1), updatedAt: EPOCH, facets: {
    'lang:go': { gems: 5000, notmine: 0, pin: /** @type {0} */ (0) },
  } };
  assert.equal(tasteTerm(extreme, entry({ facets: ['lang:go'] })), 1);
  const hostile = { v: /** @type {1} */ (1), updatedAt: EPOCH, facets: {
    'lang:go': { gems: 0, notmine: 5000, pin: /** @type {0} */ (0) },
  } };
  assert.equal(tasteTerm(hostile, entry({ facets: ['lang:go'] })), -1);
  assert.equal(tasteTerm(state, entry({})), 0);
  assert.equal(tasteTerm(null, codefly), 0);
});

test('the taste term stays within ±1 for any counts and pins', () => {
  const rand = mulberry32(7);
  const facets = ['lang:go', 'lang:rust', 'topic:a', 'topic:b', 'owner:user', 'owner:org', 'script:latin'];
  for (let trial = 0; trial < 500; trial++) {
    /** @type {Record<string, {gems: number, notmine: number, pin: -1 | 0 | 1}>} */
    const f = {};
    for (const name of facets) {
      if (rand() < 0.3) continue;
      const pins = /** @type {(-1 | 0 | 1)[]} */ ([-1, 0, 0, 0, 1]);
      f[name] = { gems: Math.floor(rand() ** 3 * 10000), notmine: Math.floor(rand() ** 3 * 10000),
        pin: pins[Math.floor(rand() * 5)] };
    }
    const state = { v: /** @type {1} */ (1), updatedAt: EPOCH, facets: f };
    const e = entry({ facets: facets.filter(() => rand() < 0.6) });
    const t = tasteTerm(state, e);
    assert.ok(t >= -1 && t <= 1 && Number.isFinite(t), `t = ${t}`);
  }
});

test('applyFeedback counts gems and "not my thing" on every facet and nothing else', () => {
  const s0 = emptyTaste();
  const s1 = applyFeedback(s0, ev(codefly.id, 'gem', '2026-09-11T10:00:00.000Z'), codefly);
  assert.deepEqual(s1.facets['lang:go'], { gems: 1, notmine: 0, pin: 0 });
  assert.deepEqual(Object.keys(s1.facets).sort(), ['kind:genuine', 'lang:go', 'owner:org', 'script:latin']);
  assert.equal(s1.updatedAt, '2026-09-11T10:00:00.000Z');
  assert.deepEqual(s0.facets, {}, 'the input is not changed');
  const s2 = applyFeedback(s1, ev(codefly.id, 'notmine', '2026-09-11T10:01:00.000Z'), codefly);
  assert.deepEqual(s2.facets['owner:org'], { gems: 1, notmine: 1, pin: 0 });
  for (const action of /** @type {Feedback['action'][]} */ (['wip', 'snooze', 'publish', 'unpublish'])) {
    const s = applyFeedback(s2, ev(codefly.id, action, '2026-09-11T10:02:00.000Z'), codefly);
    assert.deepEqual(s.facets, s2.facets, action);
  }
  const notgood = ev(codefly.id, 'notgood', '2026-09-11T10:03:00.000Z', { reason: 'slop', label: 'S' });
  assert.deepEqual(applyFeedback(s2, notgood, codefly).facets, s2.facets);
  assert.deepEqual(validateTaste(s2), []);
});

test('applyFeedback reverts an undone gem when told what it undoes, and never goes below zero', () => {
  const gem = ev(codefly.id, 'gem', '2026-09-11T10:00:00.000Z');
  const s1 = applyFeedback(emptyTaste(), gem, codefly);
  const undo = ev(codefly.id, 'undo', '2026-09-11T10:00:05.000Z', { undoes: gem.at });
  const s2 = applyFeedback(s1, undo, codefly, gem);
  assert.deepEqual(s2.facets, {});
  const s3 = applyFeedback(s2, undo, codefly, gem);
  assert.deepEqual(s3.facets, {});
  assert.deepEqual(applyFeedback(s1, undo, codefly).facets, s1.facets,
    'an undo without its target does nothing');
});

test('activeFeedback drops undo events and what they undo, by time or by position', () => {
  const a = ev(codefly.id, 'gem', '2026-09-11T10:00:00.000Z');
  const b = ev(codefly.id, 'notmine', '2026-09-11T10:01:00.000Z');
  const other = ev('R_other', 'gem', '2026-09-11T10:00:00.000Z');
  const undoA = ev(codefly.id, 'undo', '2026-09-11T10:02:00.000Z', { undoes: a.at });
  assert.deepEqual(activeFeedback([a, b, other, undoA]), [b, other]);
  const undoByIndex = ev(codefly.id, 'undo', '2026-09-11T10:03:00.000Z', { undoes: 1 });
  assert.deepEqual(activeFeedback([a, b, undoByIndex]), [a]);
  const wrongRepo = ev('R_other', 'undo', '2026-09-11T10:04:00.000Z', { undoes: 0 });
  assert.deepEqual(activeFeedback([a, wrongRepo]), [a]);
  assert.deepEqual(activeFeedback(null), []);
});

test('rebuildTaste equals applying the standing events in order, keeps pins, and validates', () => {
  const bunko = /** @type {IndexEntry} */ (index.entries.find((e) => e.nwo === 'sakajunquality/bunko'));
  const events = [
    ev(codefly.id, 'gem', '2026-09-11T10:00:00.000Z'),
    ev(bunko.id, 'notmine', '2026-09-11T10:01:00.000Z'),
    ev(bunko.id, 'gem', '2026-09-11T10:02:00.000Z'),
    ev('R_not_in_index', 'gem', '2026-09-11T10:03:00.000Z'),
  ];
  const undo = ev(bunko.id, 'undo', '2026-09-11T10:04:00.000Z', { undoes: '2026-09-11T10:02:00.000Z' });
  let expected = emptyTaste();
  for (const e of events.slice(0, 2)) expected = applyFeedback(expected, e, byId.get(e.id));
  const rebuilt = rebuildTaste([...events, undo], byId, { pins: { 'lang:haxe': -1, 'topic:x': 0 } });
  assert.equal(rebuilt.updatedAt, undo.at);
  assert.deepEqual(rebuilt.facets, { ...expected.facets, 'lang:haxe': { gems: 0, notmine: 0, pin: -1 } });
  assert.deepEqual(validateTaste(rebuilt), []);
  const asObject = rebuildTaste(events, Object.fromEntries(byId));
  assert.deepEqual(asObject.facets, rebuildTaste(events, byId).facets);
  assert.deepEqual(rebuildTaste([], byId), emptyTaste());
});

test('pins can be set, muted, reset and read back', () => {
  let s = setPin(emptyTaste(), 'Lang:Go', 1, '2026-09-11T12:00:00.000Z');
  assert.deepEqual(s.facets['lang:go'], { gems: 0, notmine: 0, pin: 1 });
  s = setPin(s, 'owner:org', -1);
  assert.deepEqual(pinsOf(s), { 'lang:go': 1, 'owner:org': -1 });
  s = setPin(s, 'lang:go', 0);
  assert.deepEqual(pinsOf(s), { 'owner:org': -1 });
  assert.equal(s.facets['lang:go'], undefined, 'a reset facet with no counts disappears');
  assert.equal(s.updatedAt, '2026-09-11T12:00:00.000Z');
});

test('lanes sort by gem descending, then stars ascending, then createdAt descending', () => {
  const a = entry({ nwo: 'a/a', gem: 9, stars: 3, createdAt: '2026-09-01T00:00:00Z' });
  const b = entry({ nwo: 'b/b', gem: 9, stars: 1, createdAt: '2026-08-01T00:00:00Z' });
  const c = entry({ nwo: 'c/c', gem: 9, stars: 1, createdAt: '2026-09-05T00:00:00Z' });
  const d = entry({ nwo: 'd/d', gem: 10, stars: 20, createdAt: '2020-01-01T00:00:00Z' });
  assert.deepEqual([a, b, c, d].sort(compareEntries).map((e) => e.nwo), ['d/d', 'c/c', 'b/b', 'a/a']);
  assert.equal(bandOf(entry({ lane: 'proven' })), 'gem');
  assert.equal(bandOf(entry({ lane: 'look' })), 'look');
  assert.equal(bandOf(entry({ lane: 'look', band: 'gem' })), 'gem');
});

test('For you takes only proven, promising and look, and without taste keeps the lane order per band', () => {
  const slots = forYouSlots(index.entries, null);
  assert.ok(slots.every((s) => ['proven', 'promising', 'look'].includes(s.entry.lane)));
  const eligible = index.entries.filter((e) => ['proven', 'promising', 'look'].includes(e.lane));
  assert.equal(slots.length, eligible.length);
  assert.ok(slots.every((s) => s.t === 0 && !s.wildcard));
  const gems = slots.filter((s) => bandOf(s.entry) === 'gem').map((s) => s.entry);
  assert.deepEqual(gems, [...gems].sort(compareEntries));
});

/**
 * @param {() => number} rand
 * @param {number} n
 * @returns {IndexEntry[]}
 */
function randomEntries(rand, n) {
  const facetPool = ['lang:go', 'lang:rust', 'lang:python', 'topic:cli', 'topic:mcp', 'owner:user',
    'owner:org', 'script:latin', 'script:cjk'];
  return Array.from({ length: n }, (_, i) => {
    const lanes = /** @type {const} */ (['proven', 'promising', 'look']);
    const lane = lanes[Math.floor(rand() * 3)];
    const band = lane === 'look' ? 'look' : 'gem';
    // Deliberately overlapping ranks: a look entry can outrank a gem entry by `gem` alone.
    const gem = band === 'gem' ? 5.5 + rand() * 6.5 : 3.5 + rand() * 4.5;
    return entry({ id: `R_${i}`, nwo: `o/r${i}`, lane, band, gem: Math.round(gem * 100) / 100,
      stars: Math.floor(rand() * 26), createdAt: `2026-0${1 + Math.floor(rand() * 8)}-1${i % 10}T00:00:00Z`,
      facets: facetPool.filter(() => rand() < 0.4) });
  });
}

test('For you never moves an entry across a band and its taste terms stay within ±1', () => {
  const rand = mulberry32(2026);
  for (let trial = 0; trial < 200; trial++) {
    const entries = randomEntries(rand, 5 + Math.floor(rand() * 60));
    /** @type {Record<string, {gems: number, notmine: number, pin: -1 | 0 | 1}>} */
    const facets = {};
    const names = ['lang:go', 'lang:rust', 'lang:python', 'topic:cli', 'topic:mcp', 'owner:user',
      'owner:org'];
    for (const f of names) {
      const pins = /** @type {(-1 | 0 | 1)[]} */ ([-1, 0, 0, 1]);
      facets[f] = { gems: Math.floor(rand() * 50), notmine: Math.floor(rand() * 50),
        pin: pins[Math.floor(rand() * 4)] };
    }
    const state = { v: /** @type {1} */ (1), updatedAt: EPOCH, facets };
    const slots = forYouSlots(entries, state);
    assert.equal(slots.length, entries.length);
    assert.equal(new Set(slots.map((s) => s.entry.id)).size, entries.length, 'every entry exactly once');
    const bands = slots.map((s) => bandOf(s.entry));
    const firstLook = bands.indexOf('look');
    if (firstLook >= 0) {
      assert.ok(bands.slice(firstLook).every((b) => b === 'look'), `trial ${trial} crossed a band`);
    }
    for (const s of slots) assert.ok(s.t >= -1 && s.t <= 1);
    // Outside wildcard slots, each band is ordered by gem + t.
    for (const band of ['gem', 'look']) {
      const ranked = slots.filter((s) => bandOf(s.entry) === band && !s.wildcard)
        .map((s) => (s.entry.gem ?? 0) + s.t);
      for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1] >= ranked[i] - 1e-9);
    }
    assert.deepEqual(forYou(entries, state), slots.map((s) => s.entry));
  }
});

test('every tenth For you slot goes to the highest-gem entry of that band whose taste is negative', () => {
  const liked = Array.from({ length: 20 }, (_, i) => entry({ id: `R_a${i}`, nwo: `o/a${i}`, band: 'gem',
    gem: 12 - i * 0.1, facets: ['lang:a'] }));
  const disliked = Array.from({ length: 6 }, (_, i) => entry({ id: `R_b${i}`, nwo: `o/b${i}`, band: 'gem',
    gem: 11 - i, facets: ['lang:b'] }));
  const state = { v: /** @type {1} */ (1), updatedAt: EPOCH, facets: {
    'lang:a': { gems: 5, notmine: 0, pin: /** @type {0} */ (0) },
    'lang:b': { gems: 0, notmine: 5, pin: /** @type {0} */ (0) },
  } };
  const slots = forYouSlots([...disliked, ...liked], state);
  assert.equal(slots[WILDCARD_EVERY - 1].entry.nwo, 'o/b0');
  assert.equal(slots[WILDCARD_EVERY - 1].wildcard, true);
  assert.equal(slots[2 * WILDCARD_EVERY - 1].entry.nwo, 'o/b1');
  assert.deepEqual(slots.slice(0, 9).map((s) => s.entry.nwo), liked.slice(0, 9).map((e) => e.nwo));
  assert.equal(slots.filter((s) => s.wildcard).length, 2);
});
