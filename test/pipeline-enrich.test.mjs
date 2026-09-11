// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCandidate, validateRepoRecord } from '../src/core/schema.mjs';
import { emptyEnrichStats, enrich, parseAliases, readmeToRepair } from '../src/pipeline/enrich.mjs';
import { candidateFromSeed } from '../src/pipeline/candidates.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';
import { fakeGitHub, fakeLib, nodeOf, seedOf, testConfig } from './support/pipeline-fakes.mjs';

/** @typedef {import('./support/pipeline-fakes.mjs').FakeRepo} FakeRepo */

const NOW = '2026-09-11T12:00:00.000Z';
const config = testConfig();

/**
 * A queued candidate for a fake repository.
 * @param {FakeRepo} r
 * @param {number} [prior]
 */
function queued(r, prior = 3) {
  return candidateFromSeed(seedOf(r), { state: 'queued', reason: null, prior, nextAt: null, gates: [] }, NOW);
}

/**
 * @param {AsyncIterable<any>} gen
 * @returns {Promise<any[]>}
 */
async function drain(gen) {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
}

/**
 * Enrich fake repositories from a fresh memory store.
 * @param {FakeRepo[]} repos
 * @param {Record<string, any>} [envOver]
 */
async function setup(repos, envOver = {}) {
  const store = createMemoryStore({ now: () => NOW });
  const lib = fakeLib();
  const client = fakeGitHub(repos);
  const cands = repos.map((r) => queued(r));
  await store.putCandidates(cands);
  const stats = emptyEnrichStats();
  const batch = { size: 12, min: 1, max: 20, targetMs: 6000 };
  const env = { client, store, config, lib, now: () => NOW, batch, stats, ...envOver };
  const out = await drain(enrich(cands, env));
  return { store, client, lib, out, stats, cands };
}

test('parseAliases and readmeToRepair', () => {
  assert.deepEqual(parseAliases({ data: { r0: { a: 1 }, r2: null } }, [1, 2, 3]), [{ a: 1 }, null, null]);
  /**
   * @param {string} name
   * @param {string} [type]
   * @param {any} [readme]
   */
  const node = (name, type = 'blob', readme = null) => ({ readme, root: { entries: [{ name, type }] } });
  assert.equal(readmeToRepair(node('README.rst')), 'README.rst');
  assert.equal(readmeToRepair(node('Readme.md')), 'Readme.md');
  assert.equal(readmeToRepair(node('README', 'tree')), null);
  assert.equal(readmeToRepair(node('README.rst', 'blob', { text: 'x' })), null);
});

test('enrich scores every candidate; gem and look ones are kept, low ones keep only a result', async () => {
  const repos = [
    { id: 'R_gem', nwo: 'o/gem', S: 8 },
    { id: 'R_look', nwo: 'o/look', S: 5 },
    { id: 'R_low', nwo: 'o/low', S: 3 },
  ];
  const { store, client, out, stats } = await setup(repos);
  assert.equal(out.length, 3);
  assert.equal(client.calls.length, 1, 'one aliased query for the batch');
  assert.equal(stats.repos, 3);
  assert.equal(stats.kept, 2);
  const gem = await store.getRepo('o/gem');
  assert.ok(gem);
  assert.deepEqual(validateRepoRecord(gem), []);
  assert.equal(gem?.candidate?.state, 'enriched');
  assert.ok(await store.getRepo('o/look'));
  assert.equal(await store.getRepo('o/low'), null);
  const low = await store.getCandidate('R_low');
  assert.equal(low?.state, 'enriched');
  assert.equal(low?.result?.lane, 'low');
  assert.equal(low?.result?.S, 3);
  for (const c of await store.listCandidates()) assert.deepEqual(validateCandidate(c), []);
});

test('a README that is not README.md is repaired with a follow-up query', async () => {
  const root = [{ name: 'README.rst', type: 'blob' }, { name: 'src', type: 'tree' }];
  const { store, client } = await setup([{ id: 'R_rst', nwo: 'gene-git/wg-client', readme: null, root }]);
  assert.equal(client.calls.length, 2);
  assert.deepEqual(client.calls[1].variables.items, [
    { owner: 'gene-git', name: 'wg-client', file: 'README.rst', path: 'README.rst' },
  ]);
  const rec = await store.getRepo('gene-git/wg-client');
  assert.equal(rec?.facts.readme?.name, 'README.rst');
  assert.equal(rec?.facts.readme?.text, 'repaired README.rst');
});

test('NOT_FOUND marks the candidate gone, and a kept record moves to the gone lane', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const lib = fakeLib();
  // First enrich while it exists, then again once it has vanished.
  const repo = { id: 'R_v', nwo: 'o/vanish', S: 8 };
  const cand = queued(repo);
  await store.putCandidates([cand]);
  await drain(enrich([cand], { client: fakeGitHub([repo]), store, config, lib, now: () => NOW }));
  const stats = emptyEnrichStats();
  const client = fakeGitHub([{ ...repo, gone: true }]);
  const out = await drain(enrich([cand], { client, store, config, lib, now: () => NOW, stats }));
  assert.equal(out[0].gone, true);
  assert.equal(out[0].record, null);
  assert.equal(stats.gone, 1);
  assert.equal((await store.getCandidate('R_v'))?.state, 'gone');
  const rec = await store.getRepo('o/vanish');
  assert.equal(rec?.gone, true);
  assert.equal(rec?.score?.lane, 'gone');
});

test('a repository that stays heavy alone is fetched over REST and marked heavy', async () => {
  const repos = [
    { id: 'R_a', nwo: 'o/a', S: 8 },
    { id: 'R_h', nwo: 'o/heavy', S: 8, heavy: true },
    { id: 'R_b', nwo: 'o/b', S: 8 },
  ];
  const { store, client, stats } = await setup(repos);
  assert.equal(stats.heavy, 1);
  assert.equal(stats.repos, 3);
  assert.ok(client.restCalls.includes('/repos/o/heavy'));
  const heavy = await store.getRepo('o/heavy');
  assert.equal(heavy?.facts.heavy, true);
  assert.equal(heavy?.facts.source, 'rest');
  assert.equal((await store.getRepo('o/a'))?.facts.heavy, false);
});

test('a drop gate drops the candidate, keeps no record and remembers a farm owner', async () => {
  const gates = [{ id: 'g.spam.farm', action: 'drop', reason: '6,690 repositories' }];
  const { store, stats } = await setup([{ id: 'R_f', nwo: 'farmer/repo', S: 9, gates }]);
  assert.equal(stats.dropped, 1);
  const c = await store.getCandidate('R_f');
  assert.equal(c?.state, 'dropped');
  assert.equal(c?.reason, 'g.spam.farm');
  assert.equal(await store.getRepo('farmer/repo'), null);
  const owner = await store.getOwner('farmer');
  assert.deepEqual(owner?.flags, ['farm']);
  assert.match(String(owner?.evidence), /g\.spam\.farm/);
});

test('a quarantine gate quarantines the candidate and keeps the record in the quarantine lane', async () => {
  const gates = [{ id: 'g.lure.link', action: 'quarantine', reason: 'zip in tests/' }];
  const { store } = await setup([{ id: 'R_q', nwo: 'o/lure', S: 6, gates }]);
  const c = await store.getCandidate('R_q');
  assert.equal(c?.state, 'quarantined');
  assert.equal(c?.reason, 'g.lure.link');
  assert.equal((await store.getRepo('o/lure'))?.score?.lane, 'quarantine');
});

test('exploration picks keep their flag; feedback keeps a low repository', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const repo = { id: 'R_x', nwo: 'o/x', S: 3 };
  const cand = { ...queued(repo, 1), explore: true };
  await store.putCandidates([{ ...cand, explore: false }]);
  const stats = emptyEnrichStats();
  const env = {
    client: fakeGitHub([repo]), store, config, lib: fakeLib(), now: () => NOW, stats,
    feedbackIds: new Set(['R_x']),
  };
  await drain(enrich([cand], env));
  assert.equal(stats.explore, 1);
  assert.equal((await store.getCandidate('R_x'))?.explore, true);
  assert.ok(await store.getRepo('o/x'), 'a repository with feedback is kept even when low');
});

test('a GitHub error on a batch leaves its candidates queued', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const repo = { id: 'R_e', nwo: 'o/e' };
  const cand = queued(repo);
  await store.putCandidates([cand]);
  const error = Object.assign(new Error('HTTP 500'), { name: 'GitHubError', code: 'EGITHUB' });
  const lib = fakeLib({}, {
    async* runBatched(/** @type {any[]} */ items) {
      for (const item of items) yield { item, value: null, error, heavy: false };
    },
  });
  const stats = emptyEnrichStats();
  const env = { client: fakeGitHub([repo]), store, config, lib, now: () => NOW, stats };
  const out = await drain(enrich([cand], env));
  assert.equal(out[0].error.name, 'GitHubError');
  assert.equal(stats.failed, 1);
  assert.equal((await store.getCandidate('R_e'))?.state, 'queued');
});

test('an authentication failure ends enrich at once', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const repo = { id: 'R_a', nwo: 'o/a' };
  const cand = queued(repo);
  await store.putCandidates([cand]);
  const auth = Object.assign(new Error('Bad credentials'), { name: 'AuthError', code: 'EAUTH', exitCode: 2 });
  const client = fakeGitHub([repo], { errorOn: { call: 1, error: auth } });
  const env = { client, store, config, lib: fakeLib(), now: () => NOW };
  await assert.rejects(drain(enrich([cand], env)), (e) => /** @type {any} */ (e).name === 'AuthError');
  assert.equal((await store.getCandidate('R_a'))?.state, 'queued');
});

test('the node handed to factsFromEnrich is the enrich node, with the fetch time', async () => {
  /** @type {any[]} */
  const seen = [];
  const base = fakeLib();
  /**
   * @param {any} node
   * @param {any} o
   */
  const spy = (node, o) => {
    seen.push({ node, o });
    return base.factsFromEnrich(node, o);
  };
  const lib = { ...base, factsFromEnrich: spy };
  const repo = { id: 'R_a', nwo: 'o/a' };
  const store = createMemoryStore({ now: () => NOW });
  const cand = queued(repo);
  await store.putCandidates([cand]);
  await drain(enrich([cand], { client: fakeGitHub([repo]), store, config, lib, now: () => NOW }));
  assert.deepEqual(seen[0].node, nodeOf(repo));
  assert.deepEqual(seen[0].o, {
    fetchedAt: NOW, readmeRepair: null, source: 'graphql', heavy: false, id: 'R_a',
  });
});

test('enrich hands the run signal to its batches, the README repair and the REST fallback', async () => {
  const signal = new AbortController().signal;
  /** @type {[string, unknown][]} */
  const seen = [];
  const base = fakeLib();
  const lib = {
    ...base,
    runBatched: (/** @type {any[]} */ items, /** @type {any} */ o) => {
      seen.push(['batch', o.signal]);
      return base.runBatched(items, o);
    },
    restFallback: (/** @type {any} */ c, /** @type {string} */ nwo, /** @type {any} */ o) => {
      seen.push(['rest', o?.signal]);
      return base.restFallback(c, nwo);
    },
  };
  const root = [{ name: 'README.rst', type: 'blob' }];
  const repos = [{ id: 'R_rst', nwo: 'o/rst', readme: null, root }, { id: 'R_h', nwo: 'o/heavy', heavy: true }];
  const store = createMemoryStore({ now: () => NOW });
  const cands = repos.map((r) => queued(r));
  await store.putCandidates(cands);
  const inner = fakeGitHub(repos);
  const client = {
    rest: inner.rest,
    graphql: (/** @type {string} */ doc, /** @type {any} */ v, /** @type {any} */ o) => {
      if (doc.startsWith('query repair')) seen.push(['repair', o?.signal]);
      return inner.graphql(doc, v, o);
    },
  };
  const out = await drain(enrich(cands, { client, store, config, lib, now: () => NOW, signal }));
  assert.equal(out.length, 2);
  assert.deepEqual(seen.map(([w]) => w).sort(), ['batch', 'repair', 'rest']);
  assert.ok(seen.every(([, s]) => s === signal), 'every request carries the signal');
});
