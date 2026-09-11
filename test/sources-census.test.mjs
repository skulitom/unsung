// @ts-check
/**
 * The census source (DESIGN §3.2): which days to census, and a whole created-day walked hour by hour
 * into CandidateSeed arrays, each carrying its ledger unit.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFetch } from './support/fake-fetch.mjs';
import { fakeClock } from './support/clock.mjs';
import { createGovernor } from '../src/github/governor.mjs';
import { createClient } from '../src/github/client.mjs';
import { cursor } from '../src/github/search.mjs';
import { censusDay, planDays, rotatedHours } from '../src/sources/census.mjs';
import { passesBase } from '../src/sources/seed.mjs';
import { clearSecrets } from '../src/secrets.mjs';
import { validateUnit } from '../src/core/schema.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';

const DAY = '2026-09-08';

/**
 * @param {number} i
 * @param {number} t
 * @param {Record<string, unknown>} [extra]
 */
function node(i, t, extra = {}) {
  const iso = new Date(t).toISOString().replace('.000Z', 'Z');
  return {
    id: `R_${i}`, nameWithOwner: `owner${i}/repo${i}`, createdAt: iso, pushedAt: iso, stargazerCount: i % 5,
    forkCount: 0, diskUsage: 250 + i, isFork: false, isArchived: false, isTemplate: false, isMirror: false,
    description: i % 2 ? 'A tool' : null, licenseInfo: i % 3 ? { spdxId: 'MIT' } : null,
    primaryLanguage: { name: 'Go' }, owner: { login: `owner${i}`, __typename: 'User' }, ...extra,
  };
}

/**
 * @param {any[]} pop
 * @returns {import('./support/fake-fetch.mjs').Route}
 */
function searchRoute(pop) {
  return {
    method: 'POST',
    respond: (call) => {
      const { q, first, after } = /** @type {any} */ (call.variables);
      const m = /created:(\S+)\.\.(\S+)/.exec(q);
      const from = Date.parse(String(m?.[1]));
      const to = Date.parse(String(m?.[2])) + 999;
      const hits = pop.filter((r) => Date.parse(r.createdAt) >= from && Date.parse(r.createdAt) <= to);
      const offset = after ? Number(Buffer.from(after, 'base64').toString().replace('cursor:', '')) : 0;
      const nodes = hits.slice(0, 1000).slice(offset, offset + first);
      return {
        status: 200,
        body: {
          data: {
            rateLimit: { cost: 1, remaining: 4000, resetAt: '2026-09-11T13:00:00Z' },
            search: {
              repositoryCount: hits.length,
              pageInfo: {
                hasNextPage: offset + first < Math.min(hits.length, 1000),
                endCursor: cursor(offset + nodes.length),
              },
              nodes,
            },
          },
        },
      };
    },
  };
}

afterEach(() => clearSecrets());

describe('planDays', () => {
  it('censuses D − lag, then backfills older days, newest first', () => {
    assert.deepEqual(planDays({ today: '2026-09-11T15:20:00Z', lagDays: 3 }), ['2026-09-08']);
    assert.deepEqual(planDays({ today: '2026-09-11', lagDays: 3, backfillDays: 2 }),
      ['2026-09-08', '2026-09-07', '2026-09-06']);
    assert.deepEqual(planDays({ today: new Date('2026-03-02T00:30:00Z'), lagDays: 1 }), ['2026-03-01']);
    assert.deepEqual(planDays({ today: Date.parse('2026-01-01T00:00:00Z'), lagDays: 0, backfillDays: 1 }),
      ['2026-01-01', '2025-12-31']);
    assert.throws(() => planDays({ today: 'soon' }), RangeError);
    assert.throws(() => planDays({ today: '2026-09-11', lagDays: -1 }), RangeError);
  });
});

describe('censusDay', () => {
  it('by default walks the 24 hours oldest first and yields seeds per leaf unit', async () => {
    const t = (/** @type {string} */ hhmmss) => Date.parse(`${DAY}T${hhmmss}Z`);
    /** @type {any[]} */
    const pop = [];
    for (let i = 0; i < 50; i++) pop.push(node(i, t('00:00:00') + i * 60_000));
    for (let i = 0; i < 1200; i++) pop.push(node(1000 + i, t('05:00:00') + Math.floor(i * 3) * 1000));
    for (let i = 0; i < 10; i++) pop.push(node(5000 + i, t('23:10:00') + i * 1000));
    pop.push(node(9001, t('23:30:00'), { isFork: true }), node(9002, t('23:31:00'), { stargazerCount: 40 }));
    const clock = fakeClock('2026-09-11T12:00:00Z', { auto: true });
    const fetch = createFakeFetch([searchRoute(pop)], { clock });
    const governor = createGovernor({}, { clock });
    const client = createClient({ token: 'census-test-token-3333', governor, fetch });
    /** @type {Map<string, any>} */
    const units = new Map();
    const ledger = {
      isDone: (/** @type {string} */ k) => units.get(k)?.state === 'done',
      start: (/** @type {string} */ k) => { units.set(k, { state: 'running' }); },
      done: (/** @type {string} */ k, /** @type {any} */ out) => { units.set(k, { state: 'done', out }); },
      fail: (/** @type {string} */ k) => { units.set(k, { state: 'failed' }); },
    };
    /** @type {Record<string, number>} */
    const stats = {};
    const batches = [];
    for await (const seeds of censusDay({ client, day: DAY, ledger, runId: 'run-1', stats })) {
      batches.push(seeds);
    }

    assert.equal(batches.length, 25, '23 quiet or small hours, and the busy hour split in two');
    const keys = batches.map((b) => /** @type {any} */ (b).unit.key);
    assert.deepEqual(keys.slice(0, 2), [
      'census:2026-09-08:all:2026-09-08T00:00:00Z..2026-09-08T00:59:59Z',
      'census:2026-09-08:all:2026-09-08T01:00:00Z..2026-09-08T01:59:59Z',
    ]);
    assert.deepEqual(keys.slice(5, 7), [
      'census:2026-09-08:all:2026-09-08T05:00:00Z..2026-09-08T05:29:59Z',
      'census:2026-09-08:all:2026-09-08T05:30:00Z..2026-09-08T05:59:59Z',
    ]);
    const seeds = batches.flat();
    assert.equal(seeds.length, 1260);
    assert.equal(new Set(seeds.map((s) => s.id)).size, 1260);
    assert.ok(seeds.every((s) => s.source === 'census:2026-09-08' && passesBase(s)));
    assert.ok(!seeds.some((s) => s.id === 'R_9001' || s.id === 'R_9002'), 'drifted repositories are dropped');
    const fields = ['createdAt', 'description', 'diskKB', 'forks', 'hasDesc', 'id', 'isArchived', 'isFork',
      'isMirror', 'isTemplate', 'lang', 'licence', 'nwo', 'ownerType', 'pushedAt', 'source', 'stars'];
    assert.deepEqual(Object.keys(seeds[0]).sort(), fields);
    assert.equal(units.size, 25);
    assert.ok([...units.values()].every((u) => u.state === 'done'));
    assert.equal(stats.leaves, 25);
    assert.equal(stats.dropped, 2);
    assert.equal(JSON.parse(JSON.stringify(batches[0])).length, 50,
      'the unit is not serialised with the seeds');
  });

  it('starts at startHour and wraps round to the hours before it', async () => {
    const t = (/** @type {string} */ hhmmss) => Date.parse(`${DAY}T${hhmmss}Z`);
    const pop = [node(1, t('00:30:00')), node(2, t('13:30:00')), node(3, t('23:30:00'))];
    const clock = fakeClock('2026-09-11T12:00:00Z', { auto: true });
    const fetch = createFakeFetch([searchRoute(pop)], { clock });
    const governor = createGovernor({}, { clock });
    const client = createClient({ token: 'census-test-token-4444', governor, fetch });
    /** @type {string[]} */
    const hours = [];
    /** @type {string[]} */
    const ids = [];
    for await (const seeds of censusDay({ client, day: DAY, startHour: 13 })) {
      hours.push(/T(\d\d):00:00Z\.\./.exec(/** @type {any} */ (seeds).unit.key)?.[1] ?? '?');
      ids.push(...seeds.map((s) => s.id));
    }
    const want = Array.from({ length: 24 }, (_, i) => String((13 + i) % 24).padStart(2, '0'));
    assert.deepEqual(hours, want);
    assert.deepEqual(ids, ['R_2', 'R_3', 'R_1']);
    assert.equal(rotatedHours(DAY, 5)[0].fromIso, `${DAY}T05:00:00Z`);
    assert.equal(rotatedHours(DAY, 5)[23].fromIso, `${DAY}T04:00:00Z`);
    for (const bad of [24, -1, 2.5, 'x']) assert.equal(rotatedHours(DAY, bad)[0].fromIso, `${DAY}T00:00:00Z`);
  });

  it('a language with a space ("Jupyter Notebook") is quoted in the search and keys units the store keeps',
    async () => {
      const t = (/** @type {string} */ hhmmss) => Date.parse(`${DAY}T${hhmmss}Z`);
      const pop = [node(1, t('00:30:00'), { primaryLanguage: { name: 'Jupyter Notebook' } })];
      const clock = fakeClock('2026-09-11T12:00:00Z', { auto: true });
      const fetch = createFakeFetch([searchRoute(pop)], { clock });
      const governor = createGovernor({}, { clock });
      const client = createClient({ token: 'census-test-token-5555', governor, fetch });
      const store = createMemoryStore({ now: () => '2026-09-11T12:00:00Z' });
      const batches = [];
      const scope = { lang: 'Jupyter Notebook' };
      const opts = { client, day: DAY, scope, ledger: store.ledger, runId: 'run-j' };
      for await (const seeds of censusDay(opts)) batches.push(seeds);
      const queries = fetch.calls.map((c) => String(/** @type {any} */ (c).variables?.q));
      assert.ok(queries.length >= 24, `${queries.length} searches`);
      for (const q of queries) assert.ok(q.includes(' language:"Jupyter Notebook" '), q);
      const first = `census:${DAY}:lang=jupyter notebook:${DAY}T00:00:00Z..${DAY}T00:59:59Z`;
      assert.equal(/** @type {any} */ (batches[0]).unit.key, first);
      assert.deepEqual(batches.flat().map((s) => s.id), ['R_1']);
      const units = store.ledger.list({ prefix: `census:${DAY}:lang=jupyter notebook:` });
      assert.equal(units.length, 24);
      assert.ok(units.every((u) => u.state === 'done'));
      for (const u of units) assert.deepEqual(validateUnit(u), [], u.key);
    });
});
