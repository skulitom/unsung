// @ts-check
/**
 * The read-only client (DESIGN §3.9–§3.11): the read-only guard, the failure taxonomy, conditional
 * REST through the HTTP cache, and a token that never appears in a log line, an error or a URL.
 * Everything runs against `test/support/fake-fetch.mjs` in virtual time.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFetch, fixtureRoute } from './support/fake-fetch.mjs';
import { fakeClock } from './support/clock.mjs';
import { loadGraphqlFixture, loadRestFixture } from './support/fixtures.mjs';
import { createBudget, createGovernor } from '../src/github/governor.mjs';
import {
  API_VERSION, AuthError, GitHubError, HeavyQueryError, RateLimitError, ReadOnlyViolation, REST_ACCEPT,
  assertReadOnly, cacheKey, createClient,
} from '../src/github/client.mjs';
import { createLog } from '../src/log.mjs';
import { clearSecrets } from '../src/secrets.mjs';

const PLAIN = 'unsung-test-token-plain-4242';
const START = '2026-09-11T12:00:00Z';
const Q = 'query { rateLimit { cost remaining resetAt } viewer { login } }';
const RATE = { cost: 1, remaining: 4990, resetAt: '2026-09-11T13:00:00Z' };
const OK = { status: 200, body: { data: { rateLimit: RATE } } };

/** @returns {{map: Map<string, any>, get(k: string): Promise<any>, put(k: string, v: any): Promise<void>}} */
function memoryCache() {
  const map = new Map();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    put: async (k, v) => {
      map.set(k, structuredClone(v));
    },
  };
}

/**
 * @param {object} [opts]
 * @param {import('./support/fake-fetch.mjs').Route[]} [opts.routes]
 * @param {any} [opts.cache]
 * @param {boolean} [opts.wait]
 * @param {Record<string, any>} [opts.client]
 */
function setup({ routes = [], cache = null, wait = true, client: extra = {} } = {}) {
  const clock = fakeClock(START, { auto: true });
  const fetch = createFakeFetch(routes, { clock });
  /** @type {string[]} */
  const lines = [];
  const log = createLog({ level: 'debug', stream: { write: (s) => lines.push(s) }, now: clock.now });
  const governor = createGovernor({}, { clock, log, wait });
  const client = createClient({ token: PLAIN, governor, cache, fetch, log, ...extra });
  return { clock, fetch, client, governor, lines };
}

afterEach(() => clearSecrets());

describe('read-only guard', () => {
  it('refuses mutations, subscriptions and documents that hide one', () => {
    for (const doc of [
      'mutation { addStar(input: {starrableId: "x"}) { clientMutationId } }',
      'subscription { x }',
      'query A { a } mutation B { b }',
      '# query\nmutation { a }',
      'fragment F on Repository { id }',
      '',
    ]) {
      assert.throws(() => assertReadOnly(doc), ReadOnlyViolation, JSON.stringify(doc));
    }
    const allowed = [
      'query { a }', '{ a }', 'fragment F on R { a }\nquery { ...F }', 'query($a: String = "}") { a }',
    ];
    for (const doc of allowed) {
      assertReadOnly(doc);
    }
  });

  it('graphql() refuses a mutation before anything is sent', async () => {
    const { client, fetch } = setup();
    await assert.rejects(client.graphql('mutation { a }'), ReadOnlyViolation);
    assert.equal(fetch.calls.length, 0);
  });

  it('rest() only issues GET, and only to api.github.com paths', async () => {
    const { client, fetch } = setup();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await assert.rejects(client.rest('/user/starred/o/r', { method }), ReadOnlyViolation);
    }
    await assert.rejects(client.rest('https://example.com/x'), TypeError);
    await assert.rejects(client.rest('//example.com/x'), TypeError);
    await assert.rejects(client.rest('/repos/o/r with space'), TypeError);
    assert.equal(fetch.calls.length, 0);
  });
});

describe('GraphQL', () => {
  it('posts the document with the token and returns data, errors, rateLimit and ms', async () => {
    const fx = loadGraphqlFixture('enrich-batch');
    const route = fixtureRoute(fx);
    route.response = { ...(/** @type {object} */ (route.response)), ms: 4_000 };
    const { client, fetch } = setup({ routes: [route] });
    const r = await client.graphql(fx.request.query, fx.request.variables);
    assert.equal(r.ms, 4_000);
    assert.deepEqual(r.errors, []);
    assert.equal(r.rateLimit?.cost, 1);
    assert.equal(r.data.r3.nameWithOwner, 'zaghaghi/toolog');
    const call = fetch.calls[0];
    assert.equal(call.method, 'POST');
    assert.equal(call.url, 'https://api.github.com/graphql');
    assert.equal(call.headers.authorization, `bearer ${PLAIN}`);
    assert.equal(call.headers['user-agent'], 'unsung/0.1.0 (+local; read-only)');
    assert.deepEqual(call.json, { query: fx.request.query, variables: fx.request.variables });
  });

  it('returns NOT_FOUND aliases as null without failing the batch', async () => {
    const fx = loadGraphqlFixture('archive-lookup');
    const { client } = setup({ routes: [fixtureRoute(fx)] });
    const r = await client.graphql(fx.request.query, fx.request.variables);
    assert.equal(r.data.r53, null);
    assert.ok(r.errors.some((e) => e.type === 'NOT_FOUND' && e.path[0] === 'r53'));
    assert.ok(r.data.r0);
  });

  it('classifies 502, 504, RESOURCE_LIMITS_EXCEEDED and slow answers as heavy', async () => {
    const heavy = { errors: [{ type: 'RESOURCE_LIMITS_EXCEEDED', message: 'too big' }], data: null };
    const { client } = setup({
      routes: [{
        method: 'POST', responses: [502, 504, { status: 200, body: heavy }, { ...OK, ms: 13_000 }],
      }],
    });
    /** @type {string[]} */
    const reasons = [];
    for (let i = 0; i < 4; i++) {
      await assert.rejects(client.graphql(Q), (err) => {
        assert.ok(err instanceof HeavyQueryError);
        reasons.push(/** @type {any} */ (err).reason);
        return true;
      });
    }
    assert.deepEqual(reasons, ['http-502', 'http-504', 'resource-limits', 'timeout']);
  });

  it('gives up on a request that never answers (real-time abort)', async () => {
    const { client } = setup({
      routes: [{ method: 'POST', response: { hang: true } }], client: { timeoutMs: 30 },
    });
    await assert.rejects(client.graphql(Q), { name: 'HeavyQueryError', reason: 'timeout' });
  });

  it('401 is an AuthError that exits 2', async () => {
    const { client } = setup({
      routes: [{ method: 'POST', response: { status: 401, body: { message: 'Bad credentials' } } }],
    });
    await assert.rejects(client.graphql(Q), (err) => {
      assert.ok(err instanceof AuthError);
      assert.equal(/** @type {any} */ (err).exitCode, 2);
      assert.equal(/** @type {any} */ (err).code, 'EAUTH');
      return true;
    });
  });

  it('waits out retry-after through the governor, then retries', async () => {
    /** @type {number[]} */
    const at = [];
    const { client, clock, governor } = setup({
      routes: [{
        method: 'POST',
        respond: (_call, n) => {
          at.push(clock.ms());
          return n === 0 ? { status: 403, headers: { 'retry-after': '30' } } : OK;
        },
      }],
    });
    const r = await client.graphql(Q);
    assert.equal(r.rateLimit?.remaining, 4990);
    assert.equal(at.length, 2);
    assert.ok(at[1] - at[0] >= 30_000);
    assert.equal(governor.snapshot().pauses[0].why, 'retry-after');
  });

  it('treats a 200 RATE_LIMITED answer as the primary limit and waits for the reset', async () => {
    const reset = Math.floor(Date.parse(START) / 1000) + 120;
    /** @type {number[]} */
    const at = [];
    const { client, clock } = setup({
      routes: [{
        method: 'POST',
        respond: (_c, n) => {
          at.push(clock.ms());
          return n === 0
            ? { status: 200, headers: { 'x-ratelimit-reset': String(reset) },
              body: { data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] } }
            : OK;
        },
      }],
    });
    await client.graphql(Q);
    assert.equal(at[1], reset * 1000 + 5_000);
  });

  it('secondary limits back off, trip the breaker, and finally surface', async () => {
    const { client, fetch } = setup({
      routes: [{ method: 'POST', response: { status: 403, body: { message: 'secondary rate limit' } } }],
    });
    await assert.rejects(client.graphql(Q), RateLimitError);
    assert.equal(fetch.calls.length, 5, 'the first answer and four retries');
    const withoutWaiting = setup({
      routes: [{ method: 'POST', response: { status: 429 } }], wait: false,
    });
    await assert.rejects(withoutWaiting.client.graphql(Q), { name: 'PauseError', exitCode: 75 });
    assert.equal(withoutWaiting.fetch.calls.length, 3, 'the breaker trips on the third hit');
  });

  it('retries a network error after 2 s and 8 s, then reports it', async () => {
    /** @type {number[]} */
    const at = [];
    const { client, clock } = setup({
      routes: [{ method: 'POST', respond: () => { at.push(clock.ms()); return { error: 'ECONNRESET' }; } }],
    });
    await assert.rejects(client.graphql(Q), { name: 'GitHubError', code: 'ENETWORK' });
    assert.deepEqual([at[1] - at[0], at[2] - at[1]], [2_000, 8_000]);
    const second = setup({ routes: [{ method: 'POST', responses: [{ error: 'ECONNRESET' }, OK] }] });
    assert.equal((await second.client.graphql(Q)).rateLimit?.cost, 1);
  });

  it('retries other 5xx twice and reports an answer without data', async () => {
    const five = setup({ routes: [{ method: 'POST', response: 500 }] });
    await assert.rejects(five.client.graphql(Q), { name: 'GitHubError', status: 500 });
    assert.equal(five.fetch.calls.length, 3);
    const empty = setup({
      routes: [{
        method: 'POST',
        response: { status: 200, body: { data: null, errors: [{ message: 'Parse error on "x"' }] } },
      }],
    });
    await assert.rejects(empty.client.graphql(Q),
      (err) => err instanceof GitHubError && /Parse error/.test(err.message));
  });

  it('spends response time and points against the budget under the call phase', async () => {
    const budgetClock = fakeClock(START);
    const budget = createBudget({ wallMs: 600_000, graphqlMs: 450_000 }, { clock: budgetClock });
    const { client } = setup({
      routes: [{ method: 'POST', response: { ...OK, ms: 3_000 } }], client: { budget },
    });
    await client.graphql(Q, {}, { kind: 'search', phase: 'census' });
    client.setBudget(null);
    await client.graphql(Q);
    const snap = budget.snapshot();
    assert.equal(snap.spentMs, 3_000);
    assert.deepEqual(snap.phases.census, { ms: 3_000, points: 1, calls: 1, capMs: 135_000 });
  });
});

describe('REST', () => {
  it('sends accept, the API version, the user agent and the token; returns the parsed body', async () => {
    const fx = loadRestFixture('repo');
    const { client, fetch } = setup({ routes: [fixtureRoute(fx)] });
    const r = await client.rest('/repos/zaghaghi/toolog');
    assert.equal(r.status, 200);
    assert.equal(r.data.full_name, 'zaghaghi/toolog');
    assert.equal(r.notModified, false);
    assert.equal(r.etag, fx.headers.etag);
    assert.equal(r.headers['x-ratelimit-remaining'], '4916');
    const call = fetch.calls[0];
    assert.equal(call.method, 'GET');
    assert.equal(call.url, 'https://api.github.com/repos/zaghaghi/toolog');
    assert.equal(call.headers.accept, REST_ACCEPT);
    assert.equal(call.headers['x-github-api-version'], API_VERSION);
    assert.equal(call.headers.authorization, `bearer ${PLAIN}`);
  });

  it('conditional GET: If-None-Match goes out and a 304 returns the cached body', async () => {
    const first = loadRestFixture('activity');
    const again = loadRestFixture('activity-304');
    const cache = memoryCache();
    const path = first.request.path;
    const { client, fetch, governor } = setup({
      routes: [{
        method: 'GET', url: path, responses: [fixtureRoute(first).response, fixtureRoute(again).response],
      }],
      cache,
    });
    const a = await client.rest(path);
    const key = cacheKey('GET', `https://api.github.com${path}`, REST_ACCEPT, API_VERSION);
    assert.match(key, /^[0-9a-f]{40}$/);
    const entry = cache.map.get(key);
    assert.equal(entry.etag, first.headers.etag);
    assert.equal(entry.url, `https://api.github.com${path}`);
    assert.equal(entry.status, 200);
    const b = await client.rest(path);
    assert.equal(fetch.calls[1].headers['if-none-match'], first.headers.etag);
    assert.equal(b.notModified, true);
    assert.equal(b.status, 200);
    assert.deepEqual(b.data, a.data);
    assert.equal(b.data.length, 100);
    assert.equal(governor.snapshot().rest.notModified, 1);
  });

  it('returns a 404 as a result, not an error', async () => {
    const fx = loadRestFixture('not-found');
    const { client } = setup({ routes: [fixtureRoute(fx)] });
    const r = await client.rest(fx.request.path);
    assert.equal(r.status, 404);
    assert.equal(r.data.message, 'Not Found');
  });

  it('retries a 5xx after 2 s and 8 s', async () => {
    const { client, fetch } = setup({
      routes: [{ method: 'GET', responses: [502, 503, { status: 200, body: [] }] }],
    });
    const r = await client.rest('/repositories?since=1');
    assert.deepEqual(r.data, []);
    assert.equal(fetch.calls.length, 3);
    const failing = setup({ routes: [{ method: 'GET', response: 500 }] });
    await assert.rejects(failing.client.rest('/x'), { name: 'GitHubError', status: 500 });
  });

  it('pauses REST until the reset when the primary limit is used up, then retries', async () => {
    const reset = Math.floor(Date.parse(START) / 1000) + 300;
    /** @type {number[]} */
    const at = [];
    const { client, clock } = setup({
      routes: [{
        method: 'GET',
        respond: (_c, n) => {
          at.push(clock.ms());
          return n === 0
            ? { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
              body: { message: 'API rate limit exceeded' } }
            : { status: 200, body: { ok: true } };
        },
      }],
    });
    assert.deepEqual((await client.rest('/rate')).data, { ok: true });
    assert.equal(at[1], reset * 1000 + 5_000);
  });

  it('a plain 403 (not a rate limit) is returned as it is', async () => {
    const { client, fetch } = setup({
      routes: [{
        method: 'GET', response: { status: 403, body: { message: 'Resource not accessible by integration' } },
      }],
    });
    const r = await client.rest('/repos/o/r/activity?per_page=100');
    assert.equal(r.status, 403);
    assert.equal(fetch.calls.length, 1);
  });
});

describe('the token stays secret', () => {
  it('never appears in a log line, an error message, a URL or the HTTP cache', async () => {
    const leak = (/** @type {string} */ s) => `${s} (sent with bearer ${PLAIN})`;
    const cache = memoryCache();
    const { client, fetch, lines } = setup({
      cache,
      routes: [
        { method: 'POST', query: 'one', response: { error: new Error(leak('connect ECONNREFUSED')) } },
        {
          method: 'POST', query: 'two', response: { status: 401, body: { message: leak('Bad credentials') } },
        },
        { method: 'POST', query: 'three', response: { status: 500, body: { message: leak('boom') } } },
        {
          method: 'POST', query: 'four',
          response: {
            status: 200, body: { data: null, errors: [{ message: leak('Something went wrong') }] },
          },
        },
        {
          method: 'POST', query: 'five',
          response: { status: 403, body: { message: leak('secondary rate limit') } },
        },
        {
          method: 'GET', url: '/ok',
          response: { status: 200, headers: { etag: '"e1"' }, body: { note: 'fine' } },
        },
        { method: 'GET', url: '/gone', response: { status: 500, body: { message: leak('rest boom') } } },
      ],
      client: { maxRateRetries: 0 },
    });
    /** @type {string[]} */
    const messages = [];
    for (const name of ['one', 'two', 'three', 'four', 'five']) {
      await client.graphql(`query ${name} { a }`).then(
        () => assert.fail(`${name} should fail`),
        (err) => messages.push(`${err.name}: ${err.message} ${JSON.stringify(err)}`),
      );
    }
    await client.rest('/ok');
    await client.rest('/gone').catch((err) => messages.push(`${err.message} ${JSON.stringify(err)}`));
    assert.equal(messages.length, 6);
    const everything = [
      ...messages, ...lines, JSON.stringify([...cache.map]), ...fetch.calls.map((c) => c.url),
    ].join('\n');
    assert.ok(!everything.includes(PLAIN), 'the token leaked');
    assert.ok(lines.length > 0, 'the client logged something');
    assert.ok(messages.some((m) => m.includes('[REDACTED]')),
      'echoed tokens are redacted, not dropped silently');
  });

  it('refuses to start without a token', () => {
    assert.throws(() => createClient({ token: '', fetch: createFakeFetch() }), AuthError);
  });
});
