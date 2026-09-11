// @ts-check
/**
 * Small helpers shared by the pipeline stages: repository names, time, error classes that must
 * stop a stage, and the metering client wrapper that charges every GitHub call to the current
 * budget phase (DESIGN §3.8) and counts what the run manifest reports (§4.3).
 */

/** @typedef {import('../log.mjs').Log} Log */

/** A silent logger, for callers that pass none. */
export const SILENT_LOG = Object.freeze({
  level: 'silent',
  enabled: () => false,
  debug() {},
  info() {},
  warn() {},
  error() {},
  stage() {},
});

/** Errors that must end the current stage rather than be absorbed per repository. */
const FATAL_NAMES = new Set([
  'AuthError', 'RateLimitError', 'PauseError', 'CircuitOpenError', 'ReadOnlyViolation', 'AbortError',
  'InterruptError', 'NotAvailableError', 'TokenError', 'LockError', 'StoreError',
]);
const FATAL_CODES = new Set([
  'EAUTH', 'ERATELIMIT', 'EPAUSED', 'ECIRCUIT', 'EREADONLY', 'ENOTAVAILABLE', 'ETOKEN', 'ELOCKED',
]);

/** Codes of GitHub and GH Archive failures that fail one unit or item, not the run (WP1). */
const RECOVERABLE_CODES = new Set(['EHEAVY', 'EGITHUB', 'ENETWORK', 'EARCHIVE']);

/** A problem with what the user asked for (bad name, unknown repository); the CLI shows it plainly. */
export class PipelineError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {number} [exitCode]
   */
  constructor(message, code, exitCode = 1) {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

/**
 * `owner/name` → `{owner, name}`; throws `PipelineError` (exit 2) for anything else.
 * @param {string} nwo
 * @returns {{owner: string, name: string}}
 */
export function splitNwo(nwo) {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(String(nwo ?? '').trim());
  if (!m || m[2] === '.' || m[2] === '..') {
    const shown = String(nwo ?? '').slice(0, 60);
    throw new PipelineError(`'${shown}' is not a repository name; write it as owner/name`, 'EINVALID', 2);
  }
  return { owner: m[1], name: m[2] };
}

/**
 * The current time as ISO-8601, from a clock function, a fixed string, or the system clock.
 * @param {(() => string) | string | undefined} now
 * @returns {string}
 */
export function isoNow(now) {
  if (typeof now === 'function') return now();
  if (typeof now === 'string') return now;
  return new Date().toISOString();
}

/**
 * @param {unknown} err
 * @returns {boolean} a rate-limit pause or an open circuit breaker (§3.10)
 */
export function isPause(err) {
  const e = /** @type {{name?: string, code?: string}} */ (err ?? {});
  return e.name === 'RateLimitError' || e.name === 'CircuitOpenError' || isStopPause(err)
    || e.code === 'ERATELIMIT' || e.code === 'ECIRCUIT';
}

/**
 * @param {unknown} err
 * @returns {boolean} a pause the governor decided must not be waited out (`PauseError`, exit 75)
 */
export function isStopPause(err) {
  const e = /** @type {{name?: string, code?: string}} */ (err ?? {});
  return e.name === 'PauseError' || e.code === 'EPAUSED';
}

/**
 * @param {unknown} err
 * @returns {boolean} a GitHub or GH Archive failure of one item or unit that the run survives
 */
export function isRecoverable(err) {
  if (isFatal(err)) return false;
  const e = /** @type {{name?: string, code?: string, status?: unknown}} */ (err ?? {});
  return RECOVERABLE_CODES.has(String(e.code)) || e.name === 'HeavyQueryError' || e.name === 'GitHubError'
    || e.name === 'ArchiveError';
}

/**
 * @param {unknown} err
 * @returns {boolean} an error that must stop the stage (authentication, pause, interrupt, …)
 */
export function isFatal(err) {
  const e = /** @type {{name?: string, code?: string}} */ (err ?? {});
  return FATAL_NAMES.has(String(e.name)) || FATAL_CODES.has(String(e.code));
}

/**
 * @param {unknown} err
 * @returns {boolean} an interrupt (Ctrl-C) or an aborted wait
 */
export function isAbort(err) {
  const e = /** @type {{name?: string}} */ (err ?? {});
  return e.name === 'AbortError' || e.name === 'InterruptError';
}

/**
 * @param {unknown} err
 * @returns {boolean} an HTTP 404 from the client
 */
export function isNotFound(err) {
  const e = /** @type {{status?: number, code?: string}} */ (err ?? {});
  return e.status === 404 || e.code === 'ENOTFOUND';
}

/**
 * When a pause ends, in milliseconds: from `resumeAt` (ISO or ms), `untilMs`, `until`,
 * `retryAfterMs` or `retryAfter` (seconds); otherwise 60 s from now (§3.10's first back-off).
 * @param {unknown} err
 * @param {number} nowMs
 * @returns {number}
 */
export function resumeAtMs(err, nowMs) {
  const e = /** @type {Record<string, unknown>} */ (err ?? {});
  for (const k of ['resumeAt', 'untilMs', 'until', 'pausedUntil']) {
    const v = e[k];
    const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof e.retryAfterMs === 'number') return nowMs + e.retryAfterMs;
  if (typeof e.retryAfter === 'number') return nowMs + e.retryAfter * 1000;
  return nowMs + 60_000;
}

/**
 * British-style thousands separators: 3301 → "3,301".
 * @param {number} n
 * @returns {string}
 */
export function fmt(n) {
  return Number(n ?? 0).toLocaleString('en-GB');
}

/**
 * @typedef {object} PhaseCounts
 * @property {number} calls GraphQL requests answered
 * @property {number} searches of which searches (`kind: 'search'`)
 * @property {number} points GraphQL points (`rateLimit.cost`)
 * @property {number} serverMs GraphQL response time
 * @property {number} heavy HeavyQueryError responses (each halves a batch)
 * @property {number} rest REST requests
 * @property {number} notModified REST 304s
 */

/**
 * A meter: which budget phase GitHub calls count toward, and what they cost (§3.8, §4.3 `rate`).
 * @param {{budget?: any, clock: {ms: () => number}}} opts
 */
export function createMeter({ budget, clock }) {
  let phase = 'census';
  /** @type {Record<string, PhaseCounts>} */
  const phases = {};
  const rate = {
    graphql: { points: 0, serverMs: 0, remaining: /** @type {number | null} */ (null) },
    rest: { calls: 0, notModified: 0, remaining: /** @type {number | null} */ (null) },
  };
  /** @returns {PhaseCounts} */
  const counts = () => {
    phases[phase] ??= { calls: 0, searches: 0, points: 0, serverMs: 0, heavy: 0, rest: 0, notModified: 0 };
    return phases[phase];
  };
  /**
   * @param {number} ms
   * @param {number} points
   */
  const spend = (ms, points) => {
    // Phases without a §3.8 share (re-check, sample, add) spend from whatever is left.
    budget?.spend?.(phase, { ms, points });
  };
  return {
    /** @param {string} p */
    setPhase(p) {
      phase = p;
    },
    get phase() {
      return phase;
    },
    /**
     * @param {any} res `client.graphql()` result
     * @param {{kind?: string} | undefined} opts
     * @param {number} measured wall milliseconds of the call
     */
    graphql(res, opts, measured) {
      const c = counts();
      const ms = typeof res?.ms === 'number' ? res.ms : measured;
      const points = typeof res?.rateLimit?.cost === 'number' ? res.rateLimit.cost : 1;
      c.calls++;
      if (opts?.kind === 'search') c.searches++;
      c.points += points;
      c.serverMs += ms;
      rate.graphql.points += points;
      rate.graphql.serverMs += ms;
      if (typeof res?.rateLimit?.remaining === 'number') rate.graphql.remaining = res.rateLimit.remaining;
      spend(ms, points);
    },
    /**
     * @param {unknown} err
     * @param {number} measured
     */
    graphqlError(err, measured) {
      const c = counts();
      if (/** @type {{name?: string}} */ (err)?.name === 'HeavyQueryError') c.heavy++;
      c.serverMs += measured;
      rate.graphql.serverMs += measured;
      spend(measured, 0);
    },
    /** @param {any} res `client.rest()` result */
    rest(res) {
      const c = counts();
      c.rest++;
      rate.rest.calls++;
      if (res?.notModified || res?.status === 304) {
        c.notModified++;
        rate.rest.notModified++;
      }
      const h = res?.headers;
      const remaining = Number(h?.get?.('x-ratelimit-remaining') ?? h?.['x-ratelimit-remaining']);
      if (Number.isFinite(remaining)) rate.rest.remaining = remaining;
    },
    /**
     * Counts for one phase.
     * @param {string} p
     * @returns {PhaseCounts}
     */
    of(p) {
      const zero = { calls: 0, searches: 0, points: 0, serverMs: 0, heavy: 0, rest: 0, notModified: 0 };
      return { ...zero, ...phases[p] };
    },
    /** @returns {typeof rate} totals for the manifest's `rate` */
    rate() {
      return structuredClone(rate);
    },
  };
}

/** @typedef {ReturnType<typeof createMeter>} Meter */

/**
 * Wrap a GitHub client so that every `graphql()` and `rest()` call is metered. Everything else
 * passes through unchanged.
 * @param {any} client
 * @param {Meter} meter
 * @param {{ms: () => number}} clock
 * @returns {any}
 */
export function meterClient(client, meter, clock) {
  /**
   * @param {string} doc
   * @param {Record<string, unknown>} [variables]
   * @param {{kind?: string}} [opts]
   */
  const graphql = async (doc, variables, opts) => {
    const t0 = clock.ms();
    try {
      const res = await client.graphql(doc, variables, opts);
      meter.graphql(res, opts, Math.max(0, clock.ms() - t0));
      return res;
    } catch (err) {
      meter.graphqlError(err, Math.max(0, clock.ms() - t0));
      throw err;
    }
  };
  /**
   * @param {string} path
   * @param {Record<string, unknown>} [opts]
   */
  const rest = async (path, opts) => {
    const res = await client.rest(path, opts);
    meter.rest(res);
    return res;
  };
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'graphql') return graphql;
      if (prop === 'rest') return rest;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/**
 * Days from `a` to `b` (b − a); NaN when either is not a time.
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {number}
 */
export function daysFrom(a, b) {
  const x = Date.parse(String(a ?? ''));
  const y = Date.parse(String(b ?? ''));
  return (y - x) / 86_400_000;
}
