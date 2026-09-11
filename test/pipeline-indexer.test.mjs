// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateIndex, validateRepoRecord } from '../src/core/schema.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import {
  applyScore, buildIndex, feedbackState, indexEntry, isKept, rescoreAll, topK, HISTORY_MAX,
} from '../src/pipeline/indexer.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';
import { fakeLib, nodeOf, testConfig } from './support/pipeline-fakes.mjs';

const NOW = '2026-09-11T12:00:00.000Z';
const lib = fakeLib();
const config = testConfig();
/** @param {string} now */
const at = (now) => ({ now, deps: lib });

/**
 * A scored record for a fake repository.
 * @param {import('./support/pipeline-fakes.mjs').FakeRepo} repo
 * @param {Record<string, any>} [over]
 */
function scored(repo, over = {}) {
  const facts = lib.factsFromEnrich(nodeOf(repo), { fetchedAt: NOW });
  const candidate = {
    v: 1, id: repo.id, nwo: repo.nwo, day: '2026-09-08', createdAt: facts.createdAt,
    pushedAt: facts.pushedAt, stars: facts.stars, forks: 0, diskKB: 800, lang: 'Rust', licence: 'MIT',
    hasDesc: true, ownerType: 'User', sources: ['census:2026-09-08'], seenAt: NOW, prior: 3, explore: false,
    state: 'enriched', reason: null, nextAt: null, result: null,
  };
  const base = {
    v: 1, id: repo.id, nwo: repo.nwo, candidate, facts, score: null, firstSeen: null, history: [],
    verdict: null, checkedAt: NOW, gone: false, ...over,
  };
  return applyScore(/** @type {any} */ (base), config, at(NOW));
}

/**
 * @param {string} id
 * @param {string} action
 * @param {string} reason
 */
const gated = (id, action, reason) => [{ id, action, reason }];

test('applyScore recomputes the score and keeps firstSeen, history and the candidate result in step', () => {
  const rec = scored({ id: 'R_1', nwo: 'o/one', S: 8, k: 0.2 });
  assert.deepEqual(validateRepoRecord(rec), []);
  assert.equal(rec.score?.S, 8);
  assert.equal(rec.score?.lane, 'promising');
  assert.deepEqual(rec.candidate?.result, {
    headOid: 'oid-R_1', S: 8, band: 'gem', lane: 'promising', gem: rec.score?.gem, at: NOW,
  });
  assert.deepEqual(rec.firstSeen, { at: NOW, headOid: 'oid-R_1', S: 8, stars: 0 });
  assert.equal(rec.history.length, 1);

  const same = applyScore(rec, config, at('2026-09-12T00:00:00Z'));
  assert.equal(same.history.length, 1, 'no new history point when nothing changed');
  assert.deepEqual(same.firstSeen, rec.firstSeen);

  const moved = applyScore({ ...rec, facts: { ...rec.facts, stars: 4 } }, config, at('2026-09-13T00:00:00Z'));
  assert.equal(moved.history.length, 2);
  assert.equal(moved.history[1].stars, 4);
  assert.equal(moved.firstSeen?.stars, 0, 'firstSeen never changes');
});

test('history keeps at most 50 points', () => {
  let rec = scored({ id: 'R_1', nwo: 'o/one' });
  for (let i = 1; i <= 60; i++) {
    rec = applyScore({ ...rec, facts: { ...rec.facts, stars: i % 26 } }, config, at(NOW));
  }
  assert.equal(rec.history.length, HISTORY_MAX);
});

test('a gone repository lands in the gone lane unless it is quarantined', () => {
  const rec = scored({ id: 'R_1', nwo: 'o/one', S: 9 });
  assert.equal(applyScore({ ...rec, gone: true }, config, at(NOW)).score?.lane, 'gone');
  const lure = scored({ id: 'R_2', nwo: 'o/two', gates: gated('g.lure.link', 'quarantine', 'zip') });
  assert.equal(applyScore({ ...lure, gone: true }, config, at(NOW)).score?.lane, 'quarantine');
});

test('the record verdict counts only at its own head; an explicit verdict wins', () => {
  const rec = scored({ id: 'R_1', nwo: 'o/one', S: 7 });
  const verdict = /** @type {any} */ ({
    v: 1, id: 'R_1', nwo: 'o/one', headOid: 'old-head', status: 'ok', effect: { points: 1 },
  });
  const stale = applyScore({ ...rec, verdict }, config, at(NOW));
  assert.equal(stale.score?.S, 7);
  assert.equal(stale.verdict, null);
  const current = applyScore({ ...rec, verdict: { ...verdict, headOid: 'oid-R_1' } }, config, at(NOW));
  assert.equal(current.score?.S, 8);
  assert.equal(current.verdict?.headOid, 'oid-R_1');
  const given = applyScore(rec, config, { ...at(NOW), verdict: { ...verdict, effect: { points: -2 } } });
  assert.equal(given.score?.S, 5);
});

test('isKept: not low, or feedback, or a verdict; never with a drop gate; add and sample always', () => {
  assert.equal(isKept(scored({ id: 'A', nwo: 'o/a', S: 8 })), true);
  assert.equal(isKept(scored({ id: 'B', nwo: 'o/b', S: 5 })), true);
  const low = scored({ id: 'C', nwo: 'o/c', S: 3 });
  assert.equal(low.score?.lane, 'low');
  assert.equal(isKept(low), false);
  assert.equal(isKept(low, { hasFeedback: true }), true);
  assert.equal(isKept(low, { hasVerdict: true }), true);
  const snapshot = /** @type {any} */ (low.candidate);
  assert.equal(isKept({ ...low, candidate: { ...snapshot, sources: ['add'] } }), true);
  assert.equal(isKept({ ...low, candidate: { ...snapshot, sources: ['sample'] } }), true);
  const farm = scored({ id: 'D', nwo: 'o/d', S: 9, gates: gated('g.spam.farm', 'drop', 'farm') });
  assert.equal(isKept(farm, { hasFeedback: true }), false);
  assert.equal(isKept(/** @type {any} */ ({ score: null })), false);
});

test('feedbackState folds undo, publish and snooze', () => {
  /** @param {Record<string, any>} over */
  const ev = (over) => ({
    v: 1, id: 'R_1', nwo: 'o/one', label: null, reason: null, note: '', blind: false, undoes: null,
    snoozeUntil: null, context: null, ...over,
  });
  const state = feedbackState(/** @type {any} */ ([
    ev({ at: 't1', action: 'gem', label: 'G' }),
    ev({ at: 't2', action: 'publish' }),
    ev({ at: 't3', action: 'notgood', label: 'C', reason: 'clone' }),
    ev({ at: 't4', action: 'undo', undoes: 't3' }),
    ev({ id: 'R_2', at: 't5', action: 'snooze', snoozeUntil: '2026-10-11T00:00:00Z' }),
    ev({ id: 'R_3', at: 't6', action: 'gem', label: 'G' }),
    ev({ id: 'R_3', at: 't7', action: 'undo', undoes: 5 }),
  ]));
  assert.deepEqual(state.get('R_1'), {
    last: { action: 'gem', at: 't1', label: 'G', reason: null }, published: true, snoozeUntil: null,
  });
  assert.equal(state.get('R_2')?.snoozeUntil, '2026-10-11T00:00:00Z');
  assert.equal(state.get('R_3'), undefined, 'an undo by position reverts the event');
});

test('indexEntry: quarantine shows identity only; descriptions ≤ 300 characters; spark oldest first', () => {
  const gate = { id: 'g.lure.script', action: 'quarantine', reason: '13 MB of Batchfile' };
  const lure = scored({ id: 'L', nwo: 'o/lure', gates: [gate] });
  assert.deepEqual(indexEntry(lure, { config, deps: lib, now: NOW }), {
    id: 'L', nwo: 'o/lure', lane: 'quarantine', gates: [gate],
  });
  const rec = scored({ id: 'R', nwo: 'o/r', description: 'ż'.repeat(400), S: 8 });
  const weeks = [{ week: '2026-09-06', gained: 3 }, { week: '2026-08-30', gained: 1 }];
  const withStars = {
    ...rec, facts: { ...rec.facts, topics: ['CLI', 'mcp'], starHistory: { weeks, gain4w: 4 } },
  };
  const e = indexEntry(withStars, { config, deps: lib, now: NOW });
  assert.equal([...String(e.description)].length, 300);
  assert.ok(String(e.description).endsWith('…'));
  assert.deepEqual(e.spark, [1, 3]);
  assert.deepEqual(e.facets, ['lang:rust', 'topic:cli', 'topic:mcp', 'owner:user', 'script:latin']);
  const chip = { id: 'q.licence', points: 1, status: 'ok', hit: true, label: 'Has a licence' };
  assert.deepEqual(e.chips, [chip]);
  assert.deepEqual(e.top, ['Has a licence: MIT']);
  assert.equal(e.ageDays, 3);
  assert.deepEqual(e.feedback, { last: null, published: false, snoozeUntil: null });
});

test('buildIndex: kept records but gone and dropped ones, sorted by gem, capped, with counts', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const recs = [
    scored({ id: 'A', nwo: 'o/a', S: 8, k: 0.2 }),
    scored({ id: 'B', nwo: 'o/b', S: 10, k: 0.7 }),
    scored({ id: 'C', nwo: 'o/c', S: 5 }),
    scored({ id: 'D', nwo: 'o/d', S: 9, gates: gated('g.lure.link', 'quarantine', 'zip in tests/') }),
    { ...scored({ id: 'E', nwo: 'o/e', S: 9 }), gone: true },
    scored({ id: 'F', nwo: 'o/f', S: 9, gates: gated('g.spam.words', 'drop', 'slots') }),
  ];
  for (const r of recs) await store.putRepo(/** @type {any} */ (r));
  await store.putCandidates([{
    v: 1, id: 'Q', nwo: 'o/photoshop-crack', day: '2026-09-08', createdAt: NOW, pushedAt: null, stars: 0,
    forks: 0, diskKB: 300, lang: 'C', licence: null, hasDesc: false, ownerType: 'User',
    sources: ['census:2026-09-08'], seenAt: NOW, prior: 1, explore: false, state: 'quarantined',
    reason: 'lure-name', nextAt: null, result: null,
  }]);
  await store.endRun(/** @type {any} */ ({
    v: 1, runId: 'r1', startedAt: NOW, endedAt: NOW, argv: [], profile: 'quick',
    budget: { wallMs: null, graphqlMs: null }, stages: {}, rate: {},
    exit: { code: 0, reason: 'finished', resumeAt: null },
  }));

  const index = await buildIndex({ store, config, now: NOW, deps: lib });
  assert.deepEqual(validateIndex(index), []);
  assert.deepEqual(index.entries.map((e) => e.nwo), ['o/b', 'o/a', 'o/c', 'o/d', 'o/photoshop-crack']);
  assert.equal(index.counts.proven, 1);
  assert.equal(index.counts.promising, 1);
  assert.equal(index.counts.look, 1);
  assert.equal(index.counts.quarantine, 2);
  assert.equal(index.counts.rising, 0);
  assert.equal(index.lastRun?.runId, 'r1');
  assert.deepEqual(index.model, { weights: config.weights, calibration: config.calibration });
  assert.deepEqual(index.entries[4].gates, [
    { id: 'g.lure.name', action: 'quarantine', reason: 'The name or description matches a lure word' },
  ]);

  const small = testConfig({ caps: { readmeBytes: 1, fileBytes: 1, treeEntries: 1, indexEntries: 2 } });
  const capped = await buildIndex({ store, config: small, now: NOW, deps: lib, lastRun: null });
  assert.deepEqual(capped.entries.map((e) => e.nwo), ['o/b', 'o/a'], 'the lowest gem is dropped first');
  assert.equal(capped.lastRun, null);
});

test('rescoreAll recomputes every record offline and updates candidate results', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const rec = scored({ id: 'A', nwo: 'o/a', S: 8 });
  await store.putRepo(rec);
  await store.putCandidates([/** @type {any} */ (rec.candidate)]);
  /** @param {any} f @param {any} o */
  const bumpedScore = (f, o) => ({ ...lib.scoreFacts(f, o), S: 11, band: 'gem' });
  const bumped = { ...lib, scoreFacts: bumpedScore };
  const result = await rescoreAll({ store, config, now: '2026-09-12T00:00:00Z', deps: bumped });
  assert.deepEqual(result, { count: 1 });
  assert.equal((await store.getRepo('o/a'))?.score?.S, 11);
  assert.equal((await store.getCandidate('A'))?.result?.S, 11);
});

test('topK keeps the first cap items in order and builds only the ones that get in', () => {
  const rand = mulberry32(9);
  const xs = Array.from({ length: 500 }, () => Math.floor(rand() * 1000));
  let made = 0;
  const top = topK(20, (/** @type {number} */ a, /** @type {number} */ b) => a - b);
  for (const x of xs) {
    top.offer(x, () => {
      made++;
      return x;
    });
  }
  assert.deepEqual(top.sorted(), [...xs].sort((a, b) => a - b).slice(0, 20));
  assert.ok(made < 200, `${made} of 500 built`);
  const none = topK(0, (/** @type {number} */ a, /** @type {number} */ b) => a - b);
  assert.equal(none.offer(1, () => 1), false);
  assert.deepEqual(none.sorted(), []);
});

test('buildIndex keeps the first caps.indexEntries while streaming: a full sort\'s entries, few built', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const rand = mulberry32(42);
  const n = 3000;
  for (let i = 0; i < n; i++) {
    const day = String(1 + Math.floor(rand() * 28)).padStart(2, '0');
    await store.putRepo(scored({
      id: `R${i}`, nwo: `o${i % 40}/r${i}`, S: 5 + Math.floor(rand() * 7), k: Math.floor(rand() * 10) / 10,
      stars: Math.floor(rand() * 26), createdAt: `2026-08-${day}T00:00:00Z`,
      gates: i % 97 === 0 ? gated('g.lure.link', 'quarantine', 'zip') : [],
    }));
  }
  let built = 0;
  const counting = {
    ...lib,
    explain: (/** @type {any} */ s, /** @type {any} */ w) => {
      built++;
      return lib.explain(s, w);
    },
  };
  const small = testConfig({ caps: { readmeBytes: 1, fileBytes: 1, treeEntries: 1, indexEntries: 100 } });
  const index = await buildIndex({ store, config: small, now: NOW, deps: counting, lastRun: null });
  // The naive way: an entry for every record, sorted by §6.7 (gem, then fewer stars, then newer).
  const every = [];
  for await (const rec of store.listRepos()) every.push(indexEntry(rec, { config: small, deps: lib, now: NOW }));
  /**
   * @param {any} a
   * @param {any} b
   */
  const order = (a, b) => ((b.gem ?? -Infinity) - (a.gem ?? -Infinity)) || ((a.stars ?? 0) - (b.stars ?? 0))
    || (a.createdAt === b.createdAt ? 0 : (a.createdAt ?? '') < (b.createdAt ?? '') ? 1 : -1)
    || (a.nwo < b.nwo ? -1 : a.nwo > b.nwo ? 1 : 0);
  every.sort(order);
  assert.equal(index.entries.length, 100);
  assert.deepEqual(index.entries, every.slice(0, 100));
  assert.ok(built < n / 3, `entries were built for ${built} of ${n} records`);
  const whole = await buildIndex({ store, config, now: NOW, deps: lib, lastRun: null });
  assert.deepEqual(whole.entries, every, 'under the cap: every entry, in the same order');
});
