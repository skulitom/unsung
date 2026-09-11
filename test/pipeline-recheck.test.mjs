// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, applyScore } from '../src/pipeline/indexer.mjs';
import { recheck } from '../src/pipeline/recheck.mjs';
import { candidateFromSeed } from '../src/pipeline/candidates.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';
import { fakeGitHub, fakeLib, nodeOf, seedOf, testConfig } from './support/pipeline-fakes.mjs';

/** @typedef {import('./support/pipeline-fakes.mjs').FakeRepo} FakeRepo */

const config = testConfig();
const lib = fakeLib();
const T0 = '2026-09-01T00:00:00.000Z';
const NOW = '2026-09-11T12:00:00.000Z';

/**
 * Store kept records (enriched at T0, `FRESH` checked this morning) with their candidates, and
 * build the index.
 * @param {any} store
 * @param {FakeRepo[]} repos
 */
async function seedStore(store, repos) {
  /** @type {any} */
  const enriched = { state: 'enriched', reason: null, prior: 3, nextAt: null, gates: [] };
  for (const repo of repos) {
    const facts = lib.factsFromEnrich(nodeOf(repo), { fetchedAt: T0 });
    const cand = candidateFromSeed(seedOf(repo), enriched, T0);
    const checkedAt = repo.id === 'FRESH' ? '2026-09-11T06:00:00.000Z' : T0;
    const rec = applyScore(/** @type {any} */ ({
      v: 1, id: repo.id, nwo: repo.nwo, candidate: cand, facts, score: null, firstSeen: null, history: [],
      verdict: null, checkedAt, gone: false,
    }), config, { now: T0, deps: lib });
    await store.putRepo(rec);
    await store.putCandidates([/** @type {any} */ (rec.candidate)]);
  }
  await store.writeIndex(await buildIndex({ store, config, now: T0, deps: lib, lastRun: null }));
}

test('re-check: gone ones are hidden, traction refreshed, pushed ones re-queued with prior + 2', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const before = [
    { id: 'KEEP', nwo: 'o/keep', S: 8, stars: 1, pushedAt: '2026-08-30T00:00:00Z' },
    { id: 'GONE', nwo: 'o/gone', S: 9 },
    { id: 'PUSH', nwo: 'o/push', S: 7, pushedAt: '2026-08-30T00:00:00Z' },
    { id: 'FRESH', nwo: 'o/fresh', S: 10 },
  ];
  await seedStore(store, before);
  const live = [
    { ...before[0], stars: 30 },
    { ...before[1], gone: true },
    { ...before[2], pushedAt: '2026-09-10T00:00:00Z' },
    before[3],
  ];
  const client = fakeGitHub(live);
  const stats = await recheck({ client, store, config, now: NOW, top: 100, deps: lib });
  assert.deepEqual(stats, { checked: 2, gone: 1, requeued: 1 });
  assert.equal(client.calls.length, 1, 'one nodes(ids:) call for up to 100 ids');
  const ids = client.calls[0].variables.ids.sort();
  assert.deepEqual(ids, ['GONE', 'KEEP', 'PUSH'], 'checked within 24 h: skipped');

  const gone = await store.getRepo('o/gone');
  assert.equal(gone?.gone, true);
  assert.equal(gone?.score?.lane, 'gone');
  assert.equal((await store.getCandidate('GONE'))?.state, 'gone');

  const keep = await store.getRepo('o/keep');
  assert.equal(keep?.facts.stars, 30);
  assert.equal(keep?.score?.lane, 'graduated');
  assert.equal(keep?.checkedAt, NOW);

  const pushed = await store.getCandidate('PUSH');
  assert.equal(pushed?.state, 'queued');
  assert.equal(pushed?.prior, 5);
  assert.equal(pushed?.reason, 'pushed');
});

test('re-check takes only the top entries by gem', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const repos = [
    { id: 'A', nwo: 'o/a', S: 8 }, { id: 'B', nwo: 'o/b', S: 10 }, { id: 'C', nwo: 'o/c', S: 9 },
  ];
  await seedStore(store, repos);
  const client = fakeGitHub([{ id: 'A', nwo: 'o/a' }, { id: 'B', nwo: 'o/b' }, { id: 'C', nwo: 'o/c' }]);
  await recheck({ client, store, config, now: NOW, top: 2, deps: lib });
  assert.deepEqual(client.calls[0].variables.ids, ['B', 'C']);
});

test('deferred candidates past nextAt pass the prefilter again', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const young = { id: 'Y', nwo: 'o/young', lang: null, createdAt: '2026-09-02T00:00:00Z' };
  const old = { id: 'N', nwo: 'o/none', lang: null, createdAt: '2026-09-01T00:00:00Z' };
  const vanished = { id: 'V', nwo: 'o/vanished', lang: null, createdAt: '2026-09-01T00:00:00Z' };
  const later = { id: 'L', nwo: 'o/later', lang: null, createdAt: '2026-09-10T00:00:00Z' };
  for (const r of [young, old, vanished, later]) {
    const seed = seedOf(r);
    const pre = lib.prefilter(seed, { now: r.createdAt, maxStars: 25 });
    await store.putCandidates([candidateFromSeed(seed, /** @type {any} */ (pre), r.createdAt)]);
  }
  const deferred = (await store.listCandidates({ state: 'deferred' })).map((c) => c.id).sort();
  assert.deepEqual(deferred, ['L', 'N', 'V', 'Y']);
  const client = fakeGitHub([{ ...young, lang: 'Go' }, old, { ...vanished, gone: true }, later]);
  const stats = await recheck({ client, store, config, now: NOW, deps: lib });
  assert.deepEqual(stats, { checked: 2, gone: 1, requeued: 1 });
  const y = await store.getCandidate('Y');
  assert.equal(y?.state, 'queued');
  assert.equal(y?.lang, 'Go');
  assert.equal(y?.prior, 3, 'the language now present adds to the prior');
  const n = await store.getCandidate('N');
  assert.equal(n?.state, 'dropped');
  assert.equal(n?.reason, 'no-language');
  assert.equal((await store.getCandidate('V'))?.state, 'gone');
  assert.equal((await store.getCandidate('L'))?.state, 'deferred', 'not due yet');
  assert.deepEqual(client.calls[0].variables.ids.sort(), ['N', 'V', 'Y']);
});

test('re-check hands the run signal to its nodes(ids:) calls', async () => {
  const store = createMemoryStore({ now: () => NOW });
  await seedStore(store, [{ id: 'A', nwo: 'o/a', S: 8 }]);
  const inner = fakeGitHub([{ id: 'A', nwo: 'o/a' }]);
  const signal = new AbortController().signal;
  /** @type {unknown[]} */
  const seen = [];
  const client = {
    graphql: (/** @type {string} */ doc, /** @type {any} */ v, /** @type {any} */ o) => {
      seen.push(o?.signal);
      return inner.graphql(doc, v, o);
    },
  };
  const stats = await recheck({ client, store, config, now: NOW, deps: lib, signal });
  assert.equal(stats.checked, 1);
  assert.deepEqual(seen, [signal]);
});

test('nothing to re-check makes no call', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const client = fakeGitHub([]);
  const stats = await recheck({ client, store, config, now: NOW, deps: lib });
  assert.deepEqual(stats, { checked: 0, gone: 0, requeued: 0 });
  assert.equal(client.calls.length, 0);
});
