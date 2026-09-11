// @ts-check
/**
 * AIMD batching (DESIGN §3.10): a recorded enrich batch where one repository keeps answering 502 is
 * halved down to that single repository, which then falls back to REST; sizes grow after fast
 * batches and halve after slow ones; errors are per item unless they must end the run.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFetch, fixtureRoute } from './support/fake-fetch.mjs';
import { fakeClock } from './support/clock.mjs';
import { loadGraphqlFixture, loadRestFixture } from './support/fixtures.mjs';
import { createGovernor } from '../src/github/governor.mjs';
import { createClient } from '../src/github/client.mjs';
import { runBatched } from '../src/github/batch.mjs';
import { ENRICH_FRAGMENT, LEAN_FRAGMENT, aliasedRepoQuery } from '../src/github/queries.mjs';
import { restFallback } from '../src/github/rest.mjs';
import { clearSecrets } from '../src/secrets.mjs';

const RATE = { cost: 1, remaining: 4900, resetAt: '2026-09-11T13:00:00Z' };

/**
 * @param {import('./support/fake-fetch.mjs').Route[]} routes
 */
function setup(routes) {
  const clock = fakeClock('2026-09-11T12:00:00Z', { auto: true });
  const fetch = createFakeFetch(routes, { clock });
  const governor = createGovernor({}, { clock });
  const client = createClient({ token: 'batch-test-token-1234', governor, fetch });
  return { clock, fetch, client };
}

/**
 * The owner/name pairs of an aliased request, in alias order.
 * @param {Record<string, unknown> | null} v
 * @returns {string[]}
 */
function nwosOf(v) {
  const out = [];
  for (let i = 0; v && `o${i}` in v; i++) out.push(`${v[`o${i}`]}/${v[`n${i}`]}`);
  return out;
}

/**
 * A GraphQL route answering each alias with `answer(nwo)`, or `status` when `fail(nwos)` says so.
 * @param {(nwo: string) => unknown} answer
 * @param {{fail?: (nwos: string[]) => number | null, ms?: (n: number) => number}} [opts]
 * @returns {import('./support/fake-fetch.mjs').Route}
 */
function aliasRoute(answer, { fail = () => null, ms = () => 2_000 } = {}) {
  return {
    method: 'POST',
    url: 'https://api.github.com/graphql',
    respond: (call) => {
      const nwos = nwosOf(call.variables);
      const status = fail(nwos);
      if (status) return { status, body: 'Bad Gateway', ms: 1_000 };
      /** @type {Record<string, unknown>} */
      const data = { rateLimit: RATE };
      /** @type {any[]} */
      const errors = [];
      nwos.forEach((nwo, i) => {
        const v = answer(nwo);
        data[`r${i}`] = v ?? null;
        if (!v) errors.push({ type: 'NOT_FOUND', path: [`r${i}`], message: 'Could not resolve' });
      });
      return { status: 200, body: errors.length ? { data, errors } : { data }, ms: ms(nwos.length) };
    },
  };
}

afterEach(() => clearSecrets());

describe('runBatched', () => {
  it('halves a batch hit by 502 down to the one repository, then falls back to REST', async () => {
    const recorded = loadGraphqlFixture('enrich-batch');
    const items = nwosOf(recorded.request.variables);
    assert.equal(items.length, 11);
    /** @type {Map<string, any>} */
    const byNwo = new Map(items.map((nwo, i) => [nwo.toLowerCase(), recorded.body.data[`r${i}`]]));
    const heavyOne = 'zaghaghi/toolog';
    const rest = ['repo', 'readme', 'contents-root', 'releases', 'commits']
      .map((n) => fixtureRoute(loadRestFixture(n)));
    const { client, fetch } = setup([
      aliasRoute((nwo) => byNwo.get(nwo.toLowerCase()),
        { fail: (nwos) => (nwos.includes(heavyOne) ? 502 : null) }),
      ...rest,
    ]);
    /** @type {Record<string, number>} */
    const stats = {};
    /** @type {string[]} */
    const heavyCalls = [];
    const results = [];
    for await (const r of runBatched(items, {
      client,
      build: (chunk) => aliasedRepoQuery('Enrich', ENRICH_FRAGMENT, chunk),
      size: 12, min: 1, max: 20, targetMs: 6_000, phase: 'enrich', stats,
      onHeavy: (item) => {
        heavyCalls.push(item);
        return restFallback(client, item);
      },
    })) results.push(r);

    const sizes = fetch.calls.filter((c) => c.method === 'POST').map((c) => nwosOf(c.variables).length);
    assert.deepEqual(sizes, [11, 6, 3, 3, 2, 1, 1, 1, 5]);
    assert.deepEqual(heavyCalls, [heavyOne]);
    assert.deepEqual(stats.halvings, 5);
    assert.deepEqual(stats.heavy, 1);
    assert.deepEqual(results.map((r) => r.item).sort(), [...items].sort());
    const heavy = /** @type {any} */ (results.find((r) => r.item === heavyOne));
    assert.equal(heavy.heavy, true);
    assert.equal(heavy.error, null);
    assert.equal(heavy.value.nameWithOwner, heavyOne);
    assert.equal(heavy.value.stargazerCount, 5);
    assert.equal(heavy.value.defaultBranchRef.target.oid, byNwo.get(heavyOne).defaultBranchRef.target.oid);
    const gets = fetch.calls.filter((c) => c.method === 'GET')
      .map((c) => new URL(c.url).pathname + new URL(c.url).search);
    assert.deepEqual(gets.sort(), [
      '/repos/zaghaghi/toolog', '/repos/zaghaghi/toolog/commits?per_page=20',
      '/repos/zaghaghi/toolog/contents/', '/repos/zaghaghi/toolog/readme',
      '/repos/zaghaghi/toolog/releases?per_page=5',
    ]);
    for (const r of results.filter((x) => x.item !== heavyOne)) {
      assert.equal(r.heavy, false);
      assert.deepEqual(r.value, byNwo.get(String(r.item).toLowerCase()));
    }
  });

  it('grows by one after fast batches, up to max', async () => {
    const { client, fetch } = setup([aliasRoute((nwo) => ({ nameWithOwner: nwo }), { ms: () => 1_000 })]);
    const items = Array.from({ length: 60 }, (_, i) => `o/r${i}`);
    let n = 0;
    for await (const r of runBatched(items, {
      client, build: (c) => aliasedRepoQuery('Lean', LEAN_FRAGMENT, c),
      size: 12, min: 1, max: 14, targetMs: 6_000,
    })) {
      assert.equal(/** @type {any} */ (r.value).nameWithOwner, r.item);
      n++;
    }
    assert.equal(n, 60);
    assert.deepEqual(fetch.calls.map((c) => nwosOf(c.variables).length), [12, 13, 14, 14, 7]);
  });

  it('halves after a slow success, and never below min for new batches', async () => {
    const slow = setup([aliasRoute((nwo) => ({ nameWithOwner: nwo }), { ms: () => 10_000 })]);
    const items = Array.from({ length: 24 }, (_, i) => `o/r${i}`);
    for await (const r of runBatched(items, {
      client: slow.client, build: (c) => aliasedRepoQuery('Lean', LEAN_FRAGMENT, c),
      size: 12, targetMs: 6_000,
    })) assert.ok(r.value);
    assert.deepEqual(slow.fetch.calls.map((c) => nwosOf(c.variables).length), [12, 6, 3, 1, 1, 1]);

    const floor = setup([aliasRoute((nwo) => ({ nameWithOwner: nwo }),
      { fail: (n) => (n.includes('o/r0') ? 502 : null) })]);
    const many = Array.from({ length: 150 }, (_, i) => `o/r${i}`);
    for await (const r of runBatched(many, {
      client: floor.client, build: (c) => aliasedRepoQuery('Lean', LEAN_FRAGMENT, c),
      size: 100, min: 10, max: 100,
      targetMs: 5_000,
    })) if (r.item === 'o/r0') assert.equal(r.heavy, true);
    const sizes = floor.fetch.calls.map((c) => nwosOf(c.variables).length);
    assert.equal(sizes[0], 100);
    assert.ok(sizes.includes(1), 'the failing repository is isolated');
    assert.ok(sizes[sizes.length - 1] >= 10, 'new batches keep the minimum size');
  });

  it('reports NOT_FOUND as a null value', async () => {
    const { client } = setup([aliasRoute((nwo) => (nwo === 'o/gone' ? null : { nameWithOwner: nwo }))]);
    const out = [];
    for await (const r of runBatched(['o/a', 'o/gone', 'o/b'], {
      client, build: (c) => aliasedRepoQuery('Lean', LEAN_FRAGMENT, c),
    })) out.push([r.item, r.value === null, r.error]);
    assert.deepEqual(out, [['o/a', false, null], ['o/gone', true, null], ['o/b', false, null]]);
  });

  it('a heavy item without a fallback comes back with its error', async () => {
    const { client } = setup([aliasRoute((nwo) => ({ nameWithOwner: nwo }), { fail: () => 502 })]);
    const out = [];
    const lean = (/** @type {string[]} */ c) => aliasedRepoQuery('Lean', LEAN_FRAGMENT, c);
    for await (const r of runBatched(['o/a'], { client, build: lean })) {
      out.push(r);
    }
    assert.equal(out.length, 1);
    assert.equal(out[0].heavy, true);
    assert.equal(/** @type {any} */ (out[0].error).name, 'HeavyQueryError');
  });

  it('reports a persistent server error on each item and carries on', async () => {
    const { client } = setup([
      aliasRoute((nwo) => ({ nameWithOwner: nwo }), { fail: (nwos) => (nwos.includes('o/a') ? 500 : null) }),
    ]);
    const out = [];
    for await (const r of runBatched(['o/a', 'o/b', 'o/c', 'o/d'], {
      client, build: (c) => aliasedRepoQuery('Lean', LEAN_FRAGMENT, c), size: 2, min: 2, max: 2,
    })) out.push([r.item, r.error ? r.error.name : null]);
    assert.deepEqual(out, [['o/a', 'GitHubError'], ['o/b', 'GitHubError'], ['o/c', null], ['o/d', null]]);
  });

  it('lets errors that must end the run propagate', async () => {
    const auth = setup([{ method: 'POST', response: 401 }]);
    const lean = (/** @type {string[]} */ c) => aliasedRepoQuery('Lean', LEAN_FRAGMENT, c);
    const gen = runBatched(['o/a'], { client: auth.client, build: lean });
    await assert.rejects(gen.next(), { name: 'AuthError' });
    const bug = setup([]);
    const broken = runBatched(['o/a'], { client: bug.client, build: () => { throw new TypeError('bug'); } });
    await assert.rejects(broken.next(), TypeError);
  });
});
