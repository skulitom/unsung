// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRepoRecord } from '../src/core/schema.mjs';
import { addRepo } from '../src/pipeline/add.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';
import { fakeGitHub, fakeLib, testConfig } from './support/pipeline-fakes.mjs';

const NOW = '2026-09-11T12:00:00.000Z';
const config = testConfig();

/**
 * @param {any} store
 * @param {any} client
 * @param {Record<string, any>} [over]
 */
const opts = (store, client, over = {}) => ({ client, store, config, now: NOW, deps: fakeLib(), ...over });

test('addRepo enriches, deepens, scores and keeps a repository whatever its lane', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const client = fakeGitHub([{ id: 'R_low', nwo: 'Some/Low', S: 3, workflows: ['ci.yml'] }]);
  const rec = await addRepo('Some/Low', opts(store, client));
  assert.deepEqual(validateRepoRecord(rec), []);
  assert.equal(rec.score?.S, 4, 'deepened (+1 in the fake scorer)');
  assert.equal(rec.score?.lane, 'low');
  assert.deepEqual(rec.facts.stages, ['enrich', 'deep']);
  const stored = await store.getRepo('some/low');
  assert.equal(stored?.id, 'R_low');
  const cand = await store.getCandidate('R_low');
  assert.deepEqual(cand?.sources, ['add']);
  assert.equal(cand?.state, 'enriched');
  assert.equal(cand?.day, '2026-09-11', 'add seeds partition by the day they were seen');
  assert.equal(cand?.prior, 2);
});

test('addRepo --no-deep scores from enrich alone; a known candidate gains the add source', async () => {
  const store = createMemoryStore({ now: () => NOW });
  await store.putCandidates([{
    v: 1, id: 'R_1', nwo: 'o/one', day: '2026-09-08', createdAt: NOW, pushedAt: NOW, stars: 0, forks: 0,
    diskKB: 800, lang: 'Rust', licence: 'MIT', hasDesc: true, ownerType: 'User',
    sources: ['census:2026-09-08'], seenAt: NOW, prior: 3, explore: false, state: 'queued', reason: null,
    nextAt: null, result: null,
  }]);
  const client = fakeGitHub([{ id: 'R_1', nwo: 'o/one', S: 8 }]);
  const rec = await addRepo('o/one', opts(store, client, { deep: false }));
  assert.deepEqual(rec.facts.stages, ['enrich']);
  assert.equal(client.calls.length, 1);
  const cand = await store.getCandidate('R_1');
  assert.deepEqual(cand?.sources, ['census:2026-09-08', 'add']);
  assert.equal(cand?.day, '2026-09-08');
  assert.equal(cand?.state, 'enriched');
});

test('addRepo repairs a README and falls back to REST for a heavy repository', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const root = [{ name: 'README.rst', type: 'blob' }];
  const rstClient = fakeGitHub([{ id: 'R_rst', nwo: 'gene-git/wg-client', readme: null, root }]);
  const rst = await addRepo('gene-git/wg-client', opts(store, rstClient, { deep: false }));
  assert.equal(rst.facts.readme?.name, 'README.rst');
  const heavyClient = {
    graphql: async () => {
      throw Object.assign(new Error('HTTP 502'), { name: 'HeavyQueryError', code: 'EHEAVY' });
    },
    rest: fakeGitHub([{ id: 'R_h', nwo: 'o/heavy' }]).rest,
  };
  const heavy = await addRepo('o/heavy', opts(store, heavyClient, { deep: false }));
  assert.equal(heavy.facts.heavy, true);
  assert.equal(heavy.facts.source, 'rest');
});

test('addRepo refuses a bad name (exit 2) and reports a missing repository', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const client = fakeGitHub([]);
  await assert.rejects(addRepo('not a repo', opts(store, client)),
    (e) => /** @type {any} */ (e).exitCode === 2 && /owner\/name/.test(/** @type {Error} */ (e).message));
  await assert.rejects(addRepo('o/missing', opts(store, client)),
    (e) => /** @type {any} */ (e).code === 'ENOTFOUND'
      && /o\/missing was not found/.test(/** @type {Error} */ (e).message));
});

test('a repository caught by a drop gate is scored and returned but not kept', async () => {
  const store = createMemoryStore({ now: () => NOW });
  const gates = [{ id: 'g.spam.words', action: 'drop', reason: 'slot, gacor' }];
  const client = fakeGitHub([{ id: 'R_s', nwo: 'o/slots', S: 6, gates }]);
  const rec = await addRepo('o/slots', opts(store, client));
  assert.equal(rec.score?.gates[0].id, 'g.spam.words');
  assert.equal(await store.getRepo('o/slots'), null);
  assert.equal((await store.getCandidate('R_s'))?.state, 'dropped');
  assert.equal(client.calls.filter((c) => c.doc.startsWith('query Deep')).length, 0, 'not deepened');
});
