// @ts-check
/**
 * The governor and the run budget (DESIGN §3.8, §3.10). One governor per process paces every GitHub
 * request:
 *
 * - GraphQL: exactly one request in flight, and a rolling 60 s ledger of response durations that
 *   never exceeds `graphqlMsPerMin` (45 s). A request may start at time s only if, for every
 *   duration d it could take up to its timeout E, the entries still inside the window when it ends
 *   plus d stay within the limit: max over d ≤ E of [load(s − 60 s + d, s] + d] ≤ limit. With the
 *   client aborting at E (12 s), no 60 s window — measured by overlap with the response intervals —
 *   can then hold more than 45 s of GraphQL response time.
 * - Search: GraphQL searches additionally start at least `searchGapMs` (2.1 s) apart.
 * - REST: at most `restConcurrency` (2) in flight; the ledger of response durations stays under
 *   `restMsPerMin` (when full, wait until the oldest entry ages out).
 * - Primary limits: GraphQL `rateLimit.remaining` < 200, or REST `x-ratelimit-remaining` < 50, pause
 *   that resource until the reset time + 5 s.
 * - Rate-limit answers (`Lease.done({error})` with a RateLimitError): `retry-after` pauses for that
 *   long; `x-ratelimit-remaining: 0` pauses until the reset (+ 5 s); any other 403/429 is a secondary
 *   limit and pauses 60 s, doubling per consecutive hit up to 15 min. The third consecutive hit trips
 *   the circuit breaker: all GitHub work stops for 15 min. A success resets the count.
 *
 * When the breaker trips and waiting is off (`--no-wait`), or a pause would outlast the run's
 * deadline, `acquire()` rejects with a PauseError (exit code 75, `resumeAt`).
 *
 * All waiting goes through the injected clock, so tests run in virtual time.
 */

/** Width of the rolling ledgers. */
export const WINDOW_MS = 60_000;

/** First secondary-limit pause; doubles per consecutive hit. */
export const SECONDARY_BASE_MS = 60_000;

/** Longest secondary pause, and the circuit breaker's pause. */
export const SECONDARY_MAX_MS = 15 * 60_000;

/** Consecutive rate-limit hits that trip the circuit breaker. */
export const BREAKER_HITS = 3;

/** How long the breaker stops all GitHub work. */
export const BREAKER_MS = 15 * 60_000;

/** Margin added to a primary reset time. */
export const RESET_MARGIN_MS = 5_000;

/** Pause GraphQL when `rateLimit.remaining` drops below this. */
export const GRAPHQL_MIN_REMAINING = 200;

/** Pause REST when `x-ratelimit-remaining` drops below this. */
export const REST_MIN_REMAINING = 50;

/** A GraphQL request that has not answered by then is a HeavyQueryError (§3.10). */
export const GRAPHQL_TIMEOUT_MS = 12_000;

/** §9.3 `governor` defaults. */
export const DEFAULT_GOVERNOR = Object.freeze({
  graphqlMsPerMin: 45_000, restMsPerMin: 20_000, searchGapMs: 2_100, restConcurrency: 2,
});

/** Run-budget phases in pipeline order; each may spend up to its cumulative share (§3.8). */
export const BUDGET_PHASES = Object.freeze(['census', 'archive', 'enrich', 'deep']);

/** A rate-limit pause the run should not wait out: exit 75 and resume later (§3.12). */
export class PauseError extends Error {
  /**
   * @param {string} message
   * @param {{resource: string, why: string, resumeAt: string}} info
   */
  constructor(message, { resource, why, resumeAt }) {
    super(message);
    this.name = 'PauseError';
    this.code = 'EPAUSED';
    this.exitCode = 75;
    this.resource = resource;
    this.why = why;
    this.resumeAt = resumeAt;
  }
}

/**
 * @typedef {object} Clock
 * @property {() => number} ms
 * @property {() => string} [now]
 * @property {(ms: number, opts?: {signal?: AbortSignal}) => Promise<void>} sleep
 */

/**
 * @typedef {'graphql' | 'search' | 'rest'} Resource
 * @typedef {'retry-after' | 'primary' | 'secondary'} RateKind
 */

/**
 * What a rate-limited answer asks for.
 * @typedef {object} RateInfo
 * @property {RateKind} kind
 * @property {number | null} untilMs when the resource may be used again (`null` for a secondary
 *   limit, whose pause the governor chooses)
 */

/**
 * @typedef {object} LeaseResult
 * @property {number} [ms] response time; defaults to the time since the lease was granted
 * @property {Headers | Record<string, string>} [headers] response headers
 * @property {{cost?: number, remaining?: number, resetAt?: string} | null} [rateLimit] GraphQL
 * @property {unknown} [error] the failure, if any (a RateLimitError pauses the resource)
 * @property {number} [status] HTTP status (a 304 is counted as not modified)
 */

/**
 * @typedef {object} Lease
 * @property {Resource} resource
 * @property {number} grantedAt clock ms
 * @property {(result?: LeaseResult) => void} done call exactly once when the response is read
 */

/**
 * @typedef {object} Governor
 * @property {(resource: Resource, opts?: {signal?: AbortSignal}) => Promise<Lease>} acquire
 * @property {(resource: Resource | 'all', untilMs: number, why: string) => void} pause
 * @property {(policy: {wait?: boolean, deadlineMs?: number | null}) => void} configure
 * @property {() => GovernorSnapshot} snapshot
 * @property {Clock} clock
 * @property {{graphqlMsPerMin: number, restMsPerMin: number, searchGapMs: number,
 *   restConcurrency: number, graphqlTimeoutMs: number}} limits
 */

/**
 * @typedef {object} GovernorSnapshot
 * @property {{inFlight: number, windowMs: number, pausedUntil: string | null, calls: number,
 *   points: number, serverMs: number, remaining: number | null}} graphql
 * @property {{calls: number, lastAt: string | null}} search
 * @property {{inFlight: number, windowMs: number, pausedUntil: string | null, calls: number,
 *   notModified: number, serverMs: number, remaining: number | null}} rest
 * @property {{consecutive: number, trips: number, until: string | null}} breaker
 * @property {{resource: string, ms: number, why: string, at: string}[]} pauses
 */

/** @returns {Clock} */
function systemClock() {
  return {
    ms: () => Date.now(),
    now: () => new Date().toISOString(),
    sleep: (ms, { signal } = {}) => new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Aborted'));
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      function onAbort() {
        clearTimeout(timer);
        reject(signal?.reason ?? new Error('Aborted'));
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  };
}

/**
 * @param {number} ms
 * @returns {string}
 */
function iso(ms) {
  return new Date(ms).toISOString();
}

/**
 * A header value from a `Headers` object or a plain object (any case), or null.
 * @param {Headers | Record<string, string> | null | undefined} headers
 * @param {string} name lower case
 * @returns {string | null}
 */
export function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof /** @type {any} */ (headers).get === 'function') {
    return /** @type {Headers} */ (headers).get(name);
  }
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return String(v);
  return null;
}

/**
 * Classify a rate-limited answer (§3.10). The caller has already decided the answer is a rate limit
 * (any GraphQL 403/429; a REST 429, or a REST 403 that carries these headers or says so).
 * @param {number} status
 * @param {Headers | Record<string, string> | null | undefined} headers
 * @param {number} nowMs
 * @returns {RateInfo}
 */
export function rateLimitInfo(status, headers, nowMs) {
  const retryAfter = headerValue(headers, 'retry-after');
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const secs = Number(retryAfter);
    const at = Number.isFinite(secs) ? nowMs + Math.max(0, secs) * 1000 : Date.parse(retryAfter);
    if (Number.isFinite(at)) return { kind: 'retry-after', untilMs: at };
  }
  if (headerValue(headers, 'x-ratelimit-remaining') === '0') {
    const reset = Number(headerValue(headers, 'x-ratelimit-reset'));
    const untilMs = Number.isFinite(reset) && reset > 0
      ? reset * 1000 + RESET_MARGIN_MS
      : nowMs + SECONDARY_BASE_MS;
    return { kind: 'primary', untilMs };
  }
  return { kind: 'secondary', untilMs: null };
}

/**
 * @typedef {{at: number, ms: number}} Entry
 */

/**
 * Sum of `ms` over entries completing in `(from, to]`.
 * @param {Entry[]} entries sorted by `at`
 * @param {number} from
 * @param {number} to
 * @returns {number}
 */
function loadIn(entries, from, to) {
  let sum = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.at <= from) break;
    if (e.at <= to) sum += e.ms;
  }
  return sum;
}

/**
 * The worst window load a request started at `s` could produce if it takes up to `reserve` ms:
 * max over d in (0, reserve] of [load(s − W + d, s] + d]. Non-increasing in `s` while no entry is
 * added, which makes the earliest start a binary search.
 * @param {Entry[]} entries sorted by `at`, all at or before `s`
 * @param {number} s
 * @param {number} reserve
 * @returns {number}
 */
export function worstLoad(entries, s, reserve) {
  const floor = s - WINDOW_MS;
  let suffix = 0;
  let afterReserve = 0;
  let best = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.at <= floor) break;
    suffix += e.ms;
    if (e.at > floor + reserve) afterReserve = suffix;
    else best = Math.max(best, e.at - floor + suffix);
  }
  return Math.max(best, reserve + afterReserve);
}

/**
 * @typedef {object} Group
 * @property {'graphql' | 'rest'} name
 * @property {number} cap requests in flight
 * @property {number} limitMs ledger limit per window
 * @property {number} reserveMs longest a request may take (0: plain ledger rule)
 * @property {number} inFlight
 * @property {Entry[]} ledger
 * @property {number} pausedUntil
 * @property {string | null} pauseWhy
 * @property {Set<() => void>} waiters woken whenever a lease of this group is done
 * @property {Promise<unknown>} tail acquisitions are granted in order
 * @property {{calls: number, points: number, serverMs: number, notModified: number,
 *   remaining: number | null}} stats
 */

/**
 * Create the governor.
 * @param {Partial<typeof DEFAULT_GOVERNOR> & {graphqlTimeoutMs?: number}} [opts] `config.defaults.governor`
 * @param {object} [deps]
 * @param {Clock} [deps.clock] default: the system clock
 * @param {boolean} [deps.wait] false (`--no-wait`): a tripped breaker rejects instead of waiting
 * @param {number | null} [deps.deadlineMs] clock ms after which no pause is waited out
 * @param {{warn(msg: string, fields?: object): void, debug(msg: string, fields?: object): void}} [deps.log]
 * @returns {Governor}
 */
export function createGovernor(opts = {}, deps = {}) {
  const { clock = systemClock(), wait = true, deadlineMs = null, log } = deps;
  const cfg = { ...DEFAULT_GOVERNOR, ...opts };
  const graphqlTimeoutMs = Number(opts.graphqlTimeoutMs) > 0
    ? Number(opts.graphqlTimeoutMs)
    : GRAPHQL_TIMEOUT_MS;
  const numeric = /** @type {const} */ ([
    'graphqlMsPerMin', 'restMsPerMin', 'searchGapMs', 'restConcurrency',
  ]);
  for (const k of numeric) {
    if (!(Number(cfg[k]) >= 0)) throw new RangeError(`governor.${k} must be a number ≥ 0`);
  }
  const policy = { wait, deadlineMs };

  /**
   * @param {'graphql' | 'rest'} name
   * @param {number} cap
   * @param {number} limitMs
   * @param {number} reserveMs
   * @returns {Group}
   */
  const group = (name, cap, limitMs, reserveMs) => ({
    name, cap: Math.max(1, Math.floor(cap)), limitMs, reserveMs: Math.min(reserveMs, limitMs),
    inFlight: 0, ledger: [], pausedUntil: 0, pauseWhy: null, waiters: new Set(), tail: Promise.resolve(),
    stats: { calls: 0, points: 0, serverMs: 0, notModified: 0, remaining: null },
  });
  const groups = {
    graphql: group('graphql', 1, cfg.graphqlMsPerMin, graphqlTimeoutMs),
    rest: group('rest', cfg.restConcurrency, cfg.restMsPerMin, 0),
  };
  let lastSearchAt = -Infinity;
  let searchCalls = 0;
  let consecutive = 0;
  let trips = 0;
  let breakerUntil = 0;
  /** @type {{resource: string, ms: number, why: string, at: string}[]} */
  const pauses = [];

  /**
   * @param {Resource} resource
   * @returns {Group}
   */
  const groupOf = (resource) => (resource === 'rest' ? groups.rest : groups.graphql);

  /**
   * @param {Group} g
   * @param {number} s
   * @returns {boolean}
   */
  const fits = (g, s) => (g.reserveMs > 0
    ? worstLoad(g.ledger, s, g.reserveMs) <= g.limitMs
    : loadIn(g.ledger, s - WINDOW_MS, s) < g.limitMs);

  /**
   * Earliest time ≥ now at which the ledger lets a request start.
   * @param {Group} g
   * @param {number} now
   * @returns {number}
   */
  const earliestStart = (g, now) => {
    if (g.ledger.length === 0 || fits(g, now)) return now;
    let lo = now;
    let hi = g.ledger[g.ledger.length - 1].at + WINDOW_MS;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (fits(g, mid)) hi = mid;
      else lo = mid;
    }
    return hi;
  };

  /**
   * @param {Group} g
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<void>}
   */
  const nextRelease = (g, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const wake = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    function onAbort() {
      g.waiters.delete(wake);
      reject(signal?.reason ?? new Error('Aborted'));
    }
    g.waiters.add(wake);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  /** @param {Group} g */
  const notify = (g) => {
    const list = [...g.waiters];
    g.waiters.clear();
    for (const wake of list) wake();
  };

  /**
   * @param {Resource | 'all'} resource
   * @param {number} untilMs
   * @param {string} why
   */
  const pause = (resource, untilMs, why) => {
    const now = clock.ms();
    if (!Number.isFinite(untilMs) || untilMs <= now) return;
    const targets = resource === 'all' ? [groups.graphql, groups.rest] : [groupOf(resource)];
    for (const g of targets) {
      if (untilMs > g.pausedUntil) {
        g.pausedUntil = untilMs;
        g.pauseWhy = why;
      }
    }
    const name = resource === 'all' ? 'all' : groupOf(resource).name;
    pauses.push({ resource: name, ms: untilMs - now, why, at: iso(now) });
    log?.warn('GitHub asked Unsung to slow down; pausing', {
      resource: name, why, seconds: Math.round((untilMs - now) / 1000),
    });
  };

  /**
   * @param {Group} g
   * @param {Resource} resource
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<Lease>}
   */
  const waitForSlot = async (g, resource, signal) => {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
      const now = clock.ms();
      const pauseEnd = Math.max(g.pausedUntil, breakerUntil);
      if (pauseEnd > now) {
        const breaker = breakerUntil >= g.pausedUntil;
        const why = breaker ? 'breaker' : String(g.pauseWhy ?? 'pause');
        const pastDeadline = policy.deadlineMs !== null && policy.deadlineMs !== undefined
          && pauseEnd > policy.deadlineMs;
        if ((breaker && !policy.wait) || pastDeadline) {
          throw new PauseError(
            `GitHub work is paused (${why}) until ${iso(pauseEnd)}; run again after that time`,
            { resource: g.name, why, resumeAt: iso(pauseEnd) },
          );
        }
        await clock.sleep(pauseEnd - now, { signal });
        continue;
      }
      if (g.inFlight >= g.cap) {
        await nextRelease(g, signal);
        continue;
      }
      if (resource === 'search') {
        const gapEnd = lastSearchAt + cfg.searchGapMs;
        if (gapEnd > now) {
          await clock.sleep(gapEnd - now, { signal });
          continue;
        }
      }
      const start = earliestStart(g, now);
      if (start > now) {
        await clock.sleep(start - now, { signal });
        continue;
      }
      g.inFlight++;
      if (resource === 'search') {
        lastSearchAt = now;
        searchCalls++;
      }
      return makeLease(g, resource, now);
    }
  };

  /**
   * @param {Group} g
   * @param {RateInfo & {kind: RateKind}} info
   * @param {number} now
   */
  const applyRateLimit = (g, info, now) => {
    if (info.kind === 'primary') {
      pause(g.name, info.untilMs ?? now + SECONDARY_BASE_MS, 'primary');
      return;
    }
    consecutive++;
    if (consecutive >= BREAKER_HITS) {
      trips++;
      breakerUntil = Math.max(breakerUntil, now + BREAKER_MS);
      pauses.push({ resource: 'all', ms: BREAKER_MS, why: 'breaker', at: iso(now) });
      log?.warn('Circuit breaker: GitHub rate-limited Unsung three times in a row; stopping for 15 min', {
        until: iso(breakerUntil),
      });
      return;
    }
    if (info.kind === 'retry-after') {
      pause(g.name, info.untilMs ?? now + SECONDARY_BASE_MS, 'retry-after');
      return;
    }
    const ms = Math.min(SECONDARY_BASE_MS * 2 ** (consecutive - 1), SECONDARY_MAX_MS);
    pause(g.name, now + ms, 'secondary');
  };

  /**
   * @param {unknown} error
   * @returns {RateInfo | null}
   */
  const rateOf = (error) => {
    const e = /** @type {any} */ (error);
    if (!e || (e.name !== 'RateLimitError' && e.code !== 'ERATELIMIT')) return null;
    const kind = ['retry-after', 'primary', 'secondary'].includes(e.kind) ? e.kind : 'secondary';
    return { kind, untilMs: Number.isFinite(e.untilMs) ? e.untilMs : null };
  };

  /**
   * @param {Group} g
   * @param {Resource} resource
   * @param {number} grantedAt
   * @returns {Lease}
   */
  const makeLease = (g, resource, grantedAt) => {
    let finished = false;
    return {
      resource,
      grantedAt,
      done(result = {}) {
        if (finished) return;
        finished = true;
        const now = clock.ms();
        const ms = Number.isFinite(result.ms) ? Math.max(0, Number(result.ms)) : Math.max(0, now - grantedAt);
        g.inFlight = Math.max(0, g.inFlight - 1);
        const entry = { at: now, ms };
        let i = g.ledger.length;
        while (i > 0 && g.ledger[i - 1].at > now) i--;
        g.ledger.splice(i, 0, entry);
        while (g.ledger.length > 0 && g.ledger[0].at <= now - WINDOW_MS) g.ledger.shift();
        g.stats.calls++;
        g.stats.serverMs += ms;
        if (result.status === 304) g.stats.notModified++;

        const rate = rateOf(result.error);
        if (rate) applyRateLimit(g, rate, now);
        else if (!result.error) consecutive = 0;

        const rl = result.rateLimit;
        if (g.name === 'graphql' && rl && typeof rl === 'object') {
          if (Number.isFinite(rl.cost)) g.stats.points += Number(rl.cost);
          if (Number.isFinite(rl.remaining)) {
            g.stats.remaining = Number(rl.remaining);
            if (Number(rl.remaining) < GRAPHQL_MIN_REMAINING) {
              const reset = Date.parse(String(rl.resetAt ?? ''));
              pause('graphql', Number.isFinite(reset) ? reset + RESET_MARGIN_MS : now + SECONDARY_BASE_MS,
                'primary');
            }
          }
        }
        if (g.name === 'rest' && result.headers) {
          const rem = headerValue(result.headers, 'x-ratelimit-remaining');
          if (rem !== null && Number.isFinite(Number(rem))) {
            g.stats.remaining = Number(rem);
            if (Number(rem) < REST_MIN_REMAINING && !rate) {
              const reset = Number(headerValue(result.headers, 'x-ratelimit-reset'));
              pause('rest', Number.isFinite(reset) && reset > 0 ? reset * 1000 + RESET_MARGIN_MS
                : now + SECONDARY_BASE_MS, 'primary');
            }
          }
        }
        notify(g);
      },
    };
  };

  return {
    clock,
    limits: {
      graphqlMsPerMin: cfg.graphqlMsPerMin,
      restMsPerMin: cfg.restMsPerMin,
      searchGapMs: cfg.searchGapMs,
      restConcurrency: groups.rest.cap,
      graphqlTimeoutMs,
    },
    acquire(resource, { signal } = {}) {
      if (resource !== 'graphql' && resource !== 'search' && resource !== 'rest') {
        return Promise.reject(new TypeError(`Unknown GitHub resource '${String(resource)}'`));
      }
      const g = groupOf(resource);
      const turn = g.tail.then(() => waitForSlot(g, resource, signal));
      g.tail = turn.then(() => undefined, () => undefined);
      return turn;
    },
    pause,
    configure(next) {
      if (typeof next.wait === 'boolean') policy.wait = next.wait;
      if (next.deadlineMs === null || Number.isFinite(next.deadlineMs)) {
        policy.deadlineMs = next.deadlineMs ?? null;
      }
    },
    snapshot() {
      const now = clock.ms();
      /**
       * @param {Group} g
       */
      const common = (g) => {
        const until = Math.max(g.pausedUntil, breakerUntil);
        return {
          inFlight: g.inFlight,
          windowMs: loadIn(g.ledger, now - WINDOW_MS, now),
          pausedUntil: until > now ? iso(until) : null,
          calls: g.stats.calls,
          serverMs: g.stats.serverMs,
          remaining: g.stats.remaining,
        };
      };
      return {
        graphql: { ...common(groups.graphql), points: groups.graphql.stats.points },
        search: { calls: searchCalls, lastAt: Number.isFinite(lastSearchAt) ? iso(lastSearchAt) : null },
        rest: { ...common(groups.rest), notModified: groups.rest.stats.notModified },
        breaker: { consecutive, trips, until: breakerUntil > now ? iso(breakerUntil) : null },
        pauses: pauses.map((p) => ({ ...p })),
      };
    },
  };
}

/**
 * @typedef {object} Budget
 * @property {(phase: string) => boolean} allows whether `phase` may start another GraphQL request
 * @property {(phase: string, used: {ms?: number, points?: number}) => void} spend
 * @property {() => boolean} exhausted wall clock or GraphQL response time used up
 * @property {() => number | null} deadlineMs clock ms at which the wall budget ends
 * @property {() => BudgetSnapshot} snapshot
 */

/**
 * @typedef {object} BudgetSnapshot
 * @property {number | null} wallMs
 * @property {number | null} graphqlMs
 * @property {string} startedAt
 * @property {number} elapsedMs
 * @property {number} spentMs GraphQL response time spent
 * @property {number} points
 * @property {number | null} remainingMs GraphQL response time left (null: uncapped)
 * @property {boolean} exhausted
 * @property {Record<string, {ms: number, points: number, calls: number, capMs: number | null}>} phases
 */

/**
 * The run budget (§3.8): the wall-clock budget and the GraphQL response-time budget
 * (`graphqlMs`, normally 0.75 × wall), shared out in pipeline order — census up to 30 %, archive
 * lookups the next 5 %, enrich until 85 % is used, deep the rest. The caps are cumulative, so a
 * share one phase leaves unused rolls forward to the phases after it. Census is checked between
 * leaf windows and may overshoot its 30 %; archive then still gets its own 5 % (its own spend, not
 * the cumulative total, is held to the share), and enrich's cumulative cap absorbs the difference.
 * Other phases (re-check, sample, add) may use whatever is left. `null` budgets are uncapped.
 * @param {{wallMs?: number | null, graphqlMs?: number | null,
 *   shares?: {census?: number, archive?: number, enrichUntil?: number}}} opts
 * @param {{clock?: Clock}} [deps]
 * @returns {Budget}
 */
export function createBudget(opts = {}, { clock = systemClock() } = {}) {
  const { wallMs = null, graphqlMs = null, shares = {} } = opts;
  const census = shares.census ?? 0.30;
  const archive = shares.archive ?? 0.05;
  const enrichUntil = shares.enrichUntil ?? 0.85;
  /** @type {Record<string, number>} */
  const caps = { census, archive: census + archive, enrich: enrichUntil, deep: 1 };
  const startMs = clock.ms();
  let spentMs = 0;
  let points = 0;
  /** @type {Record<string, {ms: number, points: number, calls: number}>} */
  const phases = {};
  const capped = (/** @type {unknown} */ v) => typeof v === 'number' && Number.isFinite(v);
  const wall = capped(wallMs) ? Number(wallMs) : null;
  const gq = capped(graphqlMs) ? Number(graphqlMs) : null;

  const exhausted = () => (wall !== null && clock.ms() - startMs >= wall) || (gq !== null && spentMs >= gq);
  /** @param {string} phase */
  const capOf = (phase) => (gq === null ? null : Math.round((caps[phase] ?? 1) * gq));

  return {
    allows(phase) {
      if (exhausted()) return false;
      const cap = capOf(phase);
      if (cap === null || spentMs < cap) return true;
      // A census that overshot its share must not starve the archive lane (§3.3): archive keeps
      // its own share of the budget whatever census used.
      return phase === 'archive' && gq !== null && (phases.archive?.ms ?? 0) < Math.round(archive * gq);
    },
    spend(phase, used = {}) {
      const ms = Number.isFinite(used.ms) ? Math.max(0, Number(used.ms)) : 0;
      const pts = Number.isFinite(used.points) ? Math.max(0, Number(used.points)) : 0;
      spentMs += ms;
      points += pts;
      const p = (phases[phase] ??= { ms: 0, points: 0, calls: 0 });
      p.ms += ms;
      p.points += pts;
      p.calls++;
    },
    exhausted,
    deadlineMs: () => (wall === null ? null : startMs + wall),
    snapshot() {
      /** @type {BudgetSnapshot['phases']} */
      const out = {};
      for (const name of new Set([...BUDGET_PHASES, ...Object.keys(phases)])) {
        const p = phases[name] ?? { ms: 0, points: 0, calls: 0 };
        out[name] = { ...p, capMs: capOf(name) };
      }
      return {
        wallMs: wall,
        graphqlMs: gq,
        startedAt: iso(startMs),
        elapsedMs: clock.ms() - startMs,
        spentMs,
        points,
        remainingMs: gq === null ? null : Math.max(0, gq - spentMs),
        exhausted: exhausted(),
        phases: out,
      };
    },
  };
}
