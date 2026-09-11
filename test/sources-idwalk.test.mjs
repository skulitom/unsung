// @ts-check
/**
 * The ID-walk sampler (DESIGN §3.1 S0c): uniform random blocks from `/repositories?since=`, lean
 * lookups of the non-forks only, at most `perBlock` seeds per block, all passing the base query,
 * deterministic for a seed; plus the recorded `/repositories` block.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFetch, fixtureRoute } from './support/fake-fetch.mjs';
import { fakeClock } from './support/clock.mjs';
import { loadRestFixture } from './support/fixtures.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import { createGovernor } from '../src/github/governor.mjs';
import { createClient } from '../src/github/client.mjs';
import { latestRepositoryId, sampleUniform } from '../src/sources/idwalk.mjs';
import { passesBase } from '../src/sources/seed.mjs';
import { clearSecrets } from '../src/secrets.mjs';

const RATE = { cost: 1, remaining: 4000, resetAt: '2026-09-11T13:00:00Z' };

/**
 * A lean node for `nwo`.
 * @param {string} nwo
 * @param {Record<string, unknown>} [extra]
 */
function lean(nwo, extra = {}) {
  return {
    id: `R_${nwo}`, nameWithOwner: nwo, createdAt: '2026-01-01T00:00:00Z', pushedAt: null, stargazerCount: 0,
    forkCount: 0, diskUsage: 900, isFork: false, isArchived: false, isTemplate: false, isMirror: false,
    description: null, licenseInfo: null, primaryLanguage: { name: 'C' },
    owner: { login: nwo.split('/')[0], __typename: 'User' },
    ...extra,
  };
}

/**
 * A lookup route answering every alias with `answer(nwo)` and recording what was asked.
 * @param {(nwo: string) => unknown} answer
 */
function lookupRoute(answer) {
  /** @type {string[]} */
  const asked = [];
  /** @type {import('./support/fake-fetch.mjs').Route} */
  const route = {
    method: 'POST',
    respond: (call) => {
      const v = /** @type {any} */ (call.variables);
      /** @type {Record<string, unknown>} */
      const data = { rateLimit: RATE };
      for (let i = 0; `o${i}` in v; i++) {
        const nwo = `${v[`o${i}`]}/${v[`n${i}`]}`;
        asked.push(nwo);
        data[`r${i}`] = answer(nwo) ?? null;
      }
      return { status: 200, body: { data } };
    },
  };
  return { route, asked };
}

/**
 * A synthetic GitHub: public repositories are the ids not divisible by 7 up to `maxId`; ids divisible
 * by 11 are forks; lookups vary stars, size and archival so that some fail the base query, and ids
 * divisible by 13 have vanished.
 * @param {number} maxId
 */
function syntheticGitHub(maxId) {
  /** @type {number[]} */
  const sinces = [];
  const lookups = lookupRoute((nwo) => {
    const id = Number(nwo.split('/r')[1]);
    if (id % 13 === 0) return null;
    return lean(nwo, {
      stargazerCount: id % 40, diskUsage: id % 3 === 0 ? 100 : 900, isArchived: id % 17 === 0,
    });
  });
  /** @type {import('./support/fake-fetch.mjs').Route} */
  const listing = {
    method: 'GET',
    url: /\/repositories\?since=\d+$/,
    respond: (call) => {
      const since = Number(new URL(call.url).searchParams.get('since'));
      sinces.push(since);
      const body = [];
      for (let id = since + 1; id <= maxId && body.length < 100; id++) {
        if (id % 7 === 0) continue;
        body.push({ id, node_id: `N_${id}`, full_name: `u${id}/r${id}`, fork: id % 11 === 0 });
      }
      return { status: 200, body };
    },
  };
  return { routes: [listing, lookups.route], sinces, asked: lookups.asked };
}

/**
 * @param {import('./support/fake-fetch.mjs').Route[]} routes
 */
function setup(routes) {
  const clock = fakeClock('2026-09-11T12:00:00Z', { auto: true });
  const fetch = createFakeFetch(routes, { clock });
  const governor = createGovernor({}, { clock });
  const client = createClient({ token: 'idwalk-test-token-1357', governor, fetch });
  return { fetch, client };
}

afterEach(() => clearSecrets());

describe('sampleUniform', () => {
  it('draws n seeds from uniform blocks, a few per block, all passing the base query', async () => {
    const gh = syntheticGitHub(5_000_000);
    const { client } = setup(gh.routes);
    /** @type {Record<string, number>} */
    const stats = {};
    const seeds = await sampleUniform({ client, n: 12, rand: mulberry32(42), maxId: 5_000_000, stats });
    assert.equal(seeds.length, 12);
    assert.equal(new Set(seeds.map((s) => s.id)).size, 12);
    assert.ok(seeds.every((s) => s.source === 'sample' && passesBase(s)));
    assert.equal(stats.calls, gh.sinces.length);
    assert.ok(stats.calls >= 6, 'at most two seeds come from one block');
    assert.ok(gh.asked.every((nwo) => Number(nwo.split('/r')[1]) % 11 !== 0), 'forks are never looked up');

    const again = syntheticGitHub(5_000_000);
    assert.deepEqual(await sampleUniform({ client: setup(again.routes).client, n: 12, rand: mulberry32(42),
      maxId: 5_000_000 }), seeds, 'the same seed draws the same sample');
    const other = syntheticGitHub(5_000_000);
    const different = await sampleUniform({ client: setup(other.routes).client, n: 12, rand: mulberry32(43),
      maxId: 5_000_000 });
    assert.notDeepEqual(different.map((s) => s.id), seeds.map((s) => s.id));
  });

  it('stops at maxCalls with what it has', async () => {
    const gh = syntheticGitHub(1_000);
    const seeds = await sampleUniform({
      client: setup(gh.routes).client, n: 50, rand: mulberry32(1), maxId: 1_000, maxCalls: 3, perBlock: 1,
    });
    assert.ok(seeds.length <= 3);
    assert.equal(gh.sinces.length, 3);
  });

  it('reads the recorded /repositories block and looks up only its non-forks', async () => {
    const fx = loadRestFixture('repositories-since');
    const lookups = lookupRoute((nwo) => lean(nwo));
    const { client, fetch } = setup([fixtureRoute(fx), lookups.route]);
    // maxId 2 × 1,365,300,000 and rand 0.5 draw id 1,365,300,001, so `since` is the recorded 1,365,300,000.
    const seeds = await sampleUniform({ client, n: 2, rand: () => 0.5, maxId: 2_730_600_000, maxCalls: 1 });
    const gets = fetch.calls.filter((c) => c.method === 'GET').map((c) => new URL(c.url).search);
    assert.deepEqual(gets, ['?since=1365300000']);
    /** @type {{fork: boolean, full_name: string}[]} */
    const block = fx.body;
    const nonForks = block.filter((r) => !r.fork).map((r) => r.full_name);
    assert.equal(nonForks.length, 93);
    assert.deepEqual(lookups.asked, nonForks);
    assert.equal(seeds.length, 2);
    assert.ok(seeds.every((s) => nonForks.includes(s.nwo) && s.source === 'sample'));
  });

  it('needs a client and a seeded generator', async () => {
    const { client } = setup([]);
    await assert.rejects(sampleUniform(/** @type {any} */ ({ client, n: 1, maxId: 10 })), TypeError);
    const noClient = /** @type {any} */ ({ n: 1, rand: Math.random, maxId: 10 });
    await assert.rejects(sampleUniform(noClient), TypeError);
  });
});

describe('latestRepositoryId', () => {
  it('finds the newest public id to within 1,000 in a bounded number of calls', async () => {
    const gh = syntheticGitHub(1_365_300_141);
    const id = await latestRepositoryId(setup(gh.routes).client);
    assert.ok(id <= 1_365_300_141 && id > 1_365_300_141 - 1_000, String(id));
    assert.ok(gh.sinces.length <= 40);
    const below = syntheticGitHub(900_000_000);
    const low = await latestRepositoryId(setup(below.routes).client);
    assert.ok(low <= 900_000_000 && low > 900_000_000 - 1_000, String(low));
  });
});
