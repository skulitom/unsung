// @ts-check
/**
 * The governor and the run budget (DESIGN §3.8, §3.10), in virtual time: the GraphQL ledger never
 * holds more than 45 s of response time in any 60 s window, searches start ≥ 2.1 s apart,
 * `retry-after` is followed, secondary back-off doubles, the breaker trips on the third hit, and the
 * budget shares roll forward.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fakeClock } from './support/clock.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import {
  BREAKER_MS, PauseError, createBudget, createGovernor, rateLimitInfo, worstLoad,
} from '../src/github/governor.mjs';

const T0 = '2026-09-11T12:00:00Z';
const T0_MS = Date.parse(T0);

/**
 * A RateLimitError as the client builds it.
 * @param {'retry-after' | 'primary' | 'secondary'} kind
 * @param {number | null} untilMs
 */
function rateErr(kind, untilMs) {
  const props = { name: 'RateLimitError', code: 'ERATELIMIT', kind, untilMs };
  return Object.assign(new Error('rate limited'), props);
}

/**
 * Largest response time inside any 60 s window, measured by overlap with the intervals.
 * @param {[number, number][]} intervals
 */
function worstWindow(intervals) {
  const busy = (/** @type {number} */ from, /** @type {number} */ to) => intervals
    .reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
  let worst = 0;
  for (const [a, b] of intervals) worst = Math.max(worst, busy(b - 60_000, b), busy(a, a + 60_000));
  return worst;
}

describe('GraphQL pacing', () => {
  it('never lets any 60 s window hold more than 45 s of GraphQL response time', async () => {
    const clock = fakeClock(T0, { auto: true });
    const gov = createGovernor({}, { clock });
    const rand = mulberry32(20260911);
    /** @type {[number, number][]} */
    const intervals = [];
    const worker = async (/** @type {number} */ n) => {
      for (let i = 0; i < n; i++) {
        const lease = await gov.acquire(rand() < 0.3 ? 'search' : 'graphql');
        const start = clock.ms();
        const d = 200 + Math.floor(rand() * 11_800); // up to the 12 s timeout
        await clock.sleep(d);
        intervals.push([start, start + d]);
        lease.done({ ms: d });
      }
    };
    await Promise.all([worker(70), worker(70), worker(70)]);
    intervals.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < intervals.length; i++) {
      assert.ok(intervals[i][0] >= intervals[i - 1][1], 'one GraphQL request in flight at a time');
    }
    const worst = worstWindow(intervals);
    assert.ok(worst <= 45_000, `a 60 s window held ${worst} ms`);
    const total = intervals.reduce((s, [a, b]) => s + b - a, 0);
    const elapsed = intervals[intervals.length - 1][1] - intervals[0][0];
    const busy = total / elapsed;
    assert.ok(busy > 0.55, `the governor should not idle needlessly (${busy.toFixed(2)})`);
  });

  it('holds back a request that could push the window over the limit, then lets it go', async () => {
    const clock = fakeClock(T0);
    const gov = createGovernor({}, { clock });
    for (const d of [11_000, 11_000, 11_000]) {
      const lease = await gov.acquire('graphql');
      clock.advance(d);
      lease.done({ ms: d });
    }
    // 33 s in the window; one more request of up to 12 s would make 45 s: still allowed.
    const lease = await gov.acquire('graphql');
    clock.advance(11_000);
    lease.done({ ms: 11_000 });
    // 44 s in the window: the next request must wait until enough has aged out.
    let granted = false;
    const next = gov.acquire('graphql').then((l) => {
      granted = true;
      return l;
    });
    await clock.advanceAsync(1_000);
    assert.equal(granted, false);
    await clock.advanceAsync(60_000);
    assert.equal(granted, true);
    (await next).done({ ms: 0 });
  });

  it('worstLoad counts the entries still inside the window when the request could end', () => {
    const entries = [{ at: 0, ms: 10_000 }, { at: 20_000, ms: 10_000 }];
    assert.equal(worstLoad(entries, 30_000, 12_000), 32_000);
    // An old entry that ages out during the request no longer counts at d = reserve.
    assert.equal(worstLoad([{ at: 0, ms: 45_000 }], 60_000, 12_000), 12_000);
    assert.equal(worstLoad([{ at: 0, ms: 45_000 }], 50_000, 12_000), 55_000);
    assert.equal(worstLoad([], 0, 12_000), 12_000);
  });

  it('keeps one GraphQL request and two REST requests in flight', async () => {
    const clock = fakeClock(T0, { auto: true });
    const gov = createGovernor({}, { clock });
    const live = { graphql: 0, rest: 0 };
    const peak = { graphql: 0, rest: 0 };
    const job = async (/** @type {'graphql' | 'rest'} */ res) => {
      const lease = await gov.acquire(res);
      live[res]++;
      peak[res] = Math.max(peak[res], live[res]);
      await clock.sleep(1_000);
      live[res]--;
      lease.done({ ms: 1_000 });
    };
    await Promise.all([...Array(6)].flatMap(() => [job('graphql'), job('rest')]));
    assert.deepEqual(peak, { graphql: 1, rest: 2 });
  });

  it('starts searches at least 2.1 s apart, without delaying other GraphQL', async () => {
    const clock = fakeClock(T0, { auto: true });
    const gov = createGovernor({}, { clock });
    const starts = [];
    for (let i = 0; i < 12; i++) {
      const lease = await gov.acquire('search');
      starts.push(clock.ms());
      await clock.sleep(300);
      lease.done({ ms: 300 });
    }
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 2_100);
    const before = clock.ms();
    const lease = await gov.acquire('graphql');
    assert.equal(clock.ms(), before, 'a non-search query is not held by the search gap');
    lease.done({ ms: 10 });
  });
});

describe('rate limits', () => {
  it('classifies rate-limited answers', () => {
    assert.deepEqual(rateLimitInfo(403, { 'retry-after': '30' }, 1_000),
      { kind: 'retry-after', untilMs: 31_000 });
    const spent = new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '100' });
    assert.deepEqual(rateLimitInfo(403, spent, 0),
      { kind: 'primary', untilMs: 105_000 });
    assert.deepEqual(rateLimitInfo(429, {}, 0), { kind: 'secondary', untilMs: null });
  });

  it('follows retry-after for that resource only', async () => {
    const clock = fakeClock(T0);
    const gov = createGovernor({}, { clock });
    const lease = await gov.acquire('graphql');
    clock.advance(100);
    lease.done({ ms: 100, error: rateErr('retry-after', clock.ms() + 30_000) });
    let granted = false;
    const next = gov.acquire('graphql').then((l) => {
      granted = true;
      return l;
    });
    const rest = await gov.acquire('rest');
    assert.equal(clock.ms(), T0_MS + 100, 'REST is not paused by a GraphQL retry-after');
    rest.done({ ms: 5 });
    await clock.advanceAsync(29_999);
    assert.equal(granted, false);
    await clock.advanceAsync(1);
    assert.equal(granted, true);
    (await next).done({ ms: 5 });
    const pause = gov.snapshot().pauses[0];
    assert.deepEqual({ resource: pause.resource, ms: pause.ms, why: pause.why },
      { resource: 'graphql', ms: 30_000, why: 'retry-after' });
  });

  it('doubles the secondary back-off and trips the breaker on the third hit', async () => {
    const clock = fakeClock(T0, { auto: true });
    const gov = createGovernor({}, { clock });
    const hit = async () => {
      const lease = await gov.acquire('graphql');
      const at = clock.ms();
      lease.done({ ms: 0, error: rateErr('secondary', null) });
      return at;
    };
    const t1 = await hit();
    const t2 = await hit();
    const t3 = await hit();
    assert.equal(t2 - t1, 60_000);
    assert.equal(t3 - t2, 120_000);
    const snap = gov.snapshot();
    assert.equal(snap.breaker.trips, 1);
    assert.equal(snap.breaker.until, new Date(t3 + BREAKER_MS).toISOString());
    const rest = await gov.acquire('rest');
    assert.equal(clock.ms() - t3, BREAKER_MS, 'the breaker stops all GitHub work, REST included');
    rest.done({ ms: 10 });
    assert.equal(gov.snapshot().breaker.consecutive, 0, 'a success resets the count');
    assert.deepEqual(gov.snapshot().pauses.map((p) => p.why), ['secondary', 'secondary', 'breaker']);
  });

  it('resets the secondary count after a success', async () => {
    const clock = fakeClock(T0, { auto: true });
    const gov = createGovernor({}, { clock });
    let lease = await gov.acquire('graphql');
    lease.done({ ms: 0, error: rateErr('secondary', null) });
    lease = await gov.acquire('graphql');
    lease.done({ ms: 10 });
    const at = clock.ms();
    lease = await gov.acquire('graphql');
    lease.done({ ms: 0, error: rateErr('secondary', null) });
    lease = await gov.acquire('graphql');
    assert.equal(clock.ms() - at, 60_000, 'back to the first step: 60 s, not 120 s');
    lease.done({ ms: 1 });
  });

  it('ends the run (PauseError, exit 75, resumeAt) when the breaker trips and waiting is off', async () => {
    const clock = fakeClock(T0, { auto: true });
    const gov = createGovernor({}, { clock, wait: false });
    let last = 0;
    for (let i = 0; i < 3; i++) {
      const lease = await gov.acquire('graphql');
      last = clock.ms();
      lease.done({ ms: 0, error: rateErr('secondary', null) });
    }
    await assert.rejects(gov.acquire('rest'), (err) => {
      assert.ok(err instanceof PauseError);
      assert.equal(err.exitCode, 75);
      assert.equal(err.why, 'breaker');
      assert.equal(err.resumeAt, new Date(last + BREAKER_MS).toISOString());
      return true;
    });
  });

  it('does not wait out a pause that ends after the deadline', async () => {
    const clock = fakeClock(T0, { auto: true });
    const gov = createGovernor({}, { clock });
    gov.configure({ deadlineMs: T0_MS + 30_000 });
    const lease = await gov.acquire('rest');
    lease.done({ ms: 1, error: rateErr('retry-after', T0_MS + 60_000) });
    await assert.rejects(gov.acquire('rest'),
      { name: 'PauseError', resumeAt: new Date(T0_MS + 60_000).toISOString() });
    gov.configure({ deadlineMs: null });
    const later = await gov.acquire('rest');
    assert.equal(clock.ms(), T0_MS + 60_000);
    later.done({ ms: 1 });
  });

  it('pauses GraphQL when rateLimit.remaining drops under 200, until resetAt + 5 s', async () => {
    const clock = fakeClock(T0, { auto: true });
    const gov = createGovernor({}, { clock });
    const lease = await gov.acquire('graphql');
    lease.done({ ms: 50, rateLimit: { cost: 1, remaining: 150, resetAt: '2026-09-11T12:30:00Z' } });
    const next = await gov.acquire('graphql');
    assert.equal(new Date(clock.ms()).toISOString(), '2026-09-11T12:30:05.000Z');
    next.done({ ms: 1, rateLimit: { cost: 1, remaining: 4999, resetAt: '2026-09-11T13:30:00Z' } });
    const snap = gov.snapshot();
    assert.equal(snap.graphql.points, 2);
    assert.equal(snap.graphql.remaining, 4999);
  });

  it('pauses REST when x-ratelimit-remaining drops under 50, until the reset + 5 s', async () => {
    const clock = fakeClock(T0, { auto: true });
    const gov = createGovernor({}, { clock });
    const reset = Math.floor(T0_MS / 1000) + 600;
    const lease = await gov.acquire('rest');
    const headers = { 'x-ratelimit-remaining': '40', 'x-ratelimit-reset': String(reset) };
    lease.done({ ms: 20, status: 200, headers });
    const g = await gov.acquire('graphql');
    assert.equal(clock.ms(), T0_MS, 'GraphQL is unaffected');
    g.done({ ms: 1 });
    const next = await gov.acquire('rest');
    assert.equal(clock.ms(), reset * 1000 + 5_000);
    next.done({ ms: 1, status: 304 });
    assert.equal(gov.snapshot().rest.notModified, 1);
  });

  it('an abort rejects a waiting acquire', async () => {
    const clock = fakeClock(T0);
    const gov = createGovernor({}, { clock });
    gov.pause('graphql', T0_MS + 60_000, 'test');
    const ctl = new AbortController();
    const waiting = gov.acquire('graphql', { signal: ctl.signal });
    ctl.abort();
    await assert.rejects(waiting);
    await assert.rejects(gov.acquire(/** @type {any} */ ('write')), TypeError);
  });
});

describe('createBudget', () => {
  const shares = { census: 0.30, archive: 0.05, enrichUntil: 0.85 };

  it('shares the GraphQL response-time budget out in pipeline order', () => {
    const clock = fakeClock(T0);
    const b = createBudget({ wallMs: 600_000, graphqlMs: 450_000, shares }, { clock });
    assert.ok(b.allows('census'));
    b.spend('census', { ms: 135_000, points: 33 });
    assert.equal(b.allows('census'), false, 'census stops at 30 %');
    assert.ok(b.allows('archive'));
    b.spend('archive', { ms: 22_500, points: 2 });
    assert.equal(b.allows('archive'), false, 'archive stops at 35 % in all');
    assert.ok(b.allows('enrich'));
    b.spend('enrich', { ms: 225_000, points: 39 });
    assert.equal(b.allows('enrich'), false, 'enrich stops at 85 %');
    assert.ok(b.allows('deep'));
    b.spend('deep', { ms: 67_500, points: 20 });
    assert.equal(b.allows('deep'), false);
    assert.ok(b.exhausted());
    const snap = b.snapshot();
    assert.equal(snap.spentMs, 450_000);
    assert.equal(snap.points, 94);
    assert.equal(snap.phases.census.capMs, 135_000);
    assert.equal(snap.phases.enrich.calls, 1);
    assert.equal(snap.remainingMs, 0);
  });

  it('rolls an unused share forward', () => {
    const clock = fakeClock(T0);
    const b = createBudget({ wallMs: 600_000, graphqlMs: 450_000, shares }, { clock });
    b.spend('census', { ms: 45_000 });
    b.spend('enrich', { ms: 330_000 });
    assert.ok(b.allows('enrich'), 'enrich may use what census left, up to 85 % in all');
    b.spend('enrich', { ms: 7_500 });
    assert.equal(b.allows('enrich'), false);
    assert.ok(b.allows('recheck'), 'other phases may use what is left');
  });

  it('ends on the wall clock, and is uncapped without budgets', () => {
    const clock = fakeClock(T0);
    const b = createBudget({ wallMs: 600_000, graphqlMs: 450_000, shares }, { clock });
    assert.equal(b.deadlineMs(), T0_MS + 600_000);
    clock.advance(600_000);
    assert.ok(b.exhausted());
    assert.equal(b.allows('census'), false);
    const free = createBudget({ wallMs: null, graphqlMs: null, shares }, { clock });
    free.spend('enrich', { ms: 1e9 });
    assert.ok(free.allows('census') && !free.exhausted());
    assert.equal(free.deadlineMs(), null);
    assert.equal(free.snapshot().remainingMs, null);
  });

  it('keeps archive its own 5 % when census overshot 30 %; enrich absorbs the difference', () => {
    const clock = fakeClock(T0);
    const b = createBudget({ wallMs: 600_000, graphqlMs: 100_000, shares }, { clock });
    b.spend('census', { ms: 40_000 });
    assert.equal(b.allows('census'), false);
    assert.ok(b.allows('archive'), 'census used 40 % but archive has used none of its 5 %');
    b.spend('archive', { ms: 5_000 });
    assert.equal(b.allows('archive'), false, 'archive stops at its own 5 %');
    assert.ok(b.allows('enrich'), 'enrich still runs to 85 % in all');
    b.spend('enrich', { ms: 40_000 });
    assert.equal(b.allows('enrich'), false);
    assert.ok(b.allows('deep'));
    clock.advance(600_000);
    assert.equal(b.allows('archive'), false, 'never past the wall clock');
  });
});
