// @ts-check
/**
 * The read-only GitHub client (DESIGN §3.9–§3.11). Every request passes through the governor; REST
 * GETs go through the HTTP cache (`If-None-Match` / `If-Modified-Since`, a 304 costs nothing); the
 * failure taxonomy of §3.10 is applied here:
 *
 * | answer | what happens |
 * |---|---|
 * | GraphQL 502/504, `RESOURCE_LIMITS_EXCEEDED`, no answer in 12 s | HeavyQueryError (batcher halves) |
 * | 403/429 rate limit | RateLimitError: the governor pauses the resource, then the request is retried |
 * | 401 | AuthError (exit 2) |
 * | network error, 5xx other than GraphQL 502/504 | retried after 2 s and 8 s, then GitHubError |
 * | `NOT_FOUND` on an alias or node | returned in `errors`; the alias is `null` |
 *
 * The read-only guard: `graphql()` refuses any document whose first operation is not `query` (or an
 * anonymous `{`) or that contains a mutation or subscription; `rest()` only issues GET. The token
 * goes only into the Authorization header of requests to api.github.com; every error message is
 * redacted; HTTP-cache entries store the redacted URL.
 *
 * An in-flight request is never aborted by Ctrl-C (§3.12: finish the in-flight request); the
 * `signal` option stops the client from *starting* new requests and from waiting.
 */

import { createHash } from 'node:crypto';
import { redact, registerSecret } from '../secrets.mjs';
import { GRAPHQL_TIMEOUT_MS, createGovernor, headerValue, rateLimitInfo } from './governor.mjs';

/** The only GitHub host Unsung talks to (§2 network allowlist). */
export const API_ROOT = 'https://api.github.com';

/** REST API version sent with every REST call (§3.10). */
export const API_VERSION = '2026-03-10';

/** REST media type (§3.10). */
export const REST_ACCEPT = 'application/vnd.github+json';

/** Waits before the two retries of a network error or REST 5xx (§3.10). */
export const RETRY_DELAYS_MS = Object.freeze([2000, 8000]);

/** REST requests that take longer than this count as network errors. */
export const REST_TIMEOUT_MS = 30_000;

/** Rate-limited answers retried (after the governor's pause) before the RateLimitError is thrown. */
export const MAX_RATE_RETRIES = 4;

/** Default User-Agent (§3.10); the CLI passes its own with the package version. */
export const DEFAULT_USER_AGENT = 'unsung/0.1.0 (+local; read-only)';

const MESSAGE_CAP = 200;
const AUTH_MESSAGE = 'GitHub refused the token (HTTP 401): check GITHUB_TOKEN or run `gh auth login`';

/**
 * @param {unknown} text
 * @returns {string}
 */
function short(text) {
  const s = redact(text).replace(/\s+/g, ' ').trim();
  return s.length > MESSAGE_CAP ? `${s.slice(0, MESSAGE_CAP - 1)}…` : s;
}

/** Any failure talking to GitHub. Messages are redacted and never carry repository text. */
export class GitHubError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number | null, code?: string}} [opts]
   */
  constructor(message, { status = null, code = 'EGITHUB' } = {}) {
    super(short(message));
    this.name = 'GitHubError';
    this.code = code;
    this.status = status;
  }
}

/** GitHub could not answer this query in time: not a rate limit; the batcher halves (§3.10). */
export class HeavyQueryError extends GitHubError {
  /**
   * @param {string} message
   * @param {{status?: number | null, reason: 'http-502' | 'http-504' | 'resource-limits' | 'timeout'}} opts
   */
  constructor(message, { status = null, reason }) {
    super(message, { status, code: 'EHEAVY' });
    this.name = 'HeavyQueryError';
    this.reason = reason;
  }
}

/** GitHub rate-limited a request; the governor pauses the resource (§3.10). */
export class RateLimitError extends GitHubError {
  /**
   * @param {string} message
   * @param {{status: number | null, kind: 'retry-after' | 'primary' | 'secondary',
   *   untilMs: number | null}} info
   */
  constructor(message, { status, kind, untilMs }) {
    super(message, { status, code: 'ERATELIMIT' });
    this.name = 'RateLimitError';
    this.kind = kind;
    this.untilMs = untilMs;
  }
}

/** GitHub refused the token (HTTP 401): abort, exit 2. */
export class AuthError extends GitHubError {
  /** @param {string} message */
  constructor(message) {
    super(message, { status: 401, code: 'EAUTH' });
    this.name = 'AuthError';
    this.exitCode = 2;
  }
}

/** A write was attempted. Unsung only reads (§1 pillar 5, §3.10). */
export class ReadOnlyViolation extends Error {
  /** @param {string} message */
  constructor(message) {
    super(short(message));
    this.name = 'ReadOnlyViolation';
    this.code = 'EREADONLY';
  }
}

/**
 * @param {number} c char code
 * @returns {boolean}
 */
const isNameStart = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

/**
 * @param {number} c char code
 * @returns {boolean}
 */
const isNameChar = (c) => isNameStart(c) || (c >= 48 && c <= 57);

/**
 * The keyword (or `{`) that starts each top-level definition of a GraphQL document, skipping
 * comments, strings and block strings.
 * @param {string} doc
 * @returns {string[]}
 */
export function topLevelDefinitions(doc) {
  /** @type {string[]} */
  const defs = [];
  /** @type {string[]} */
  const stack = [];
  let expecting = true;
  let i = 0;
  const n = doc.length;
  while (i < n) {
    const c = doc.charCodeAt(i);
    if (c === 35) { // '#': comment to end of line
      while (i < n && doc[i] !== '\n' && doc[i] !== '\r') i++;
      continue;
    }
    if (c === 34) { // '"'
      if (doc.startsWith('"""', i)) {
        i += 3;
        while (i < n && !doc.startsWith('"""', i)) i += doc.startsWith('\\"""', i) ? 4 : 1;
        i += 3;
      } else {
        i++;
        while (i < n && doc[i] !== '"' && doc[i] !== '\n') i += doc[i] === '\\' ? 2 : 1;
        i++;
      }
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < n && isNameChar(doc.charCodeAt(j))) j++;
      if (stack.length === 0 && expecting) {
        defs.push(doc.slice(i, j));
        expecting = false;
      }
      i = j;
      continue;
    }
    const ch = doc[i];
    if (ch === '{' || ch === '(' || ch === '[') {
      if (stack.length === 0 && expecting && ch === '{') {
        defs.push('{');
        expecting = false;
      }
      stack.push(ch);
    } else if (ch === '}' || ch === ')' || ch === ']') {
      const open = stack.pop();
      if (stack.length === 0 && open === '{') expecting = true;
    }
    i++;
  }
  return defs;
}

/**
 * The read-only guard (§3.10): a document must start with a `query` (or an anonymous `{`) operation
 * and contain nothing but queries and fragments. Throws ReadOnlyViolation otherwise.
 * @param {unknown} doc
 * @returns {void}
 */
export function assertReadOnly(doc) {
  if (typeof doc !== 'string' || doc.trim() === '') {
    throw new ReadOnlyViolation('A GraphQL document must be a non-empty string');
  }
  const defs = topLevelDefinitions(doc);
  const ops = defs.filter((d) => d !== 'fragment');
  if (ops.length === 0) throw new ReadOnlyViolation('The GraphQL document has no query operation');
  if (ops[0] !== 'query' && ops[0] !== '{') {
    const what = ops[0].slice(0, 40);
    throw new ReadOnlyViolation(`Unsung only reads from GitHub; refusing a '${what}' operation`);
  }
  const bad = defs.find((d) => d !== 'query' && d !== '{' && d !== 'fragment');
  if (bad) {
    const what = bad.slice(0, 40);
    throw new ReadOnlyViolation(`Unsung only reads from GitHub; refusing a document containing '${what}'`);
  }
}

/**
 * HTTP-cache key (§3.11): SHA-1 of method, URL, accept and API version, after `redact()`.
 * @param {string} method
 * @param {string} url
 * @param {string} accept
 * @param {string} apiVersion
 * @returns {string} 40 hex characters
 */
export function cacheKey(method, url, accept, apiVersion) {
  return createHash('sha1').update(redact([method, url, accept, apiVersion].join('\n'))).digest('hex');
}

/**
 * @param {string} path
 */
function checkRestPath(path) {
  const ok = typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')
    && path.length <= 2048 && !/[\s#]/.test(path)
    && [...path].every((ch) => ch.charCodeAt(0) > 31 && ch.charCodeAt(0) !== 127);
  if (!ok) throw new TypeError('A REST path must start with a single / and contain no spaces or fragments');
}

/**
 * @param {string} text
 * @returns {any}
 */
function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * @param {Headers} headers
 * @returns {Record<string, string>}
 */
function plainHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errText(err) {
  const e = /** @type {any} */ (err);
  const cause = e?.cause?.code ?? e?.cause?.message;
  return [e?.message ?? String(err), cause].filter(Boolean).join(': ');
}

/**
 * @typedef {object} HttpCache
 * @property {(key: string) => Promise<HttpCacheEntry | null | undefined> | HttpCacheEntry | null
 *   | undefined} get
 * @property {(key: string, entry: HttpCacheEntry) => Promise<void> | void} put
 * @typedef {import('../core/schema.mjs').HttpCacheEntry} HttpCacheEntry
 * @typedef {import('./governor.mjs').Governor} Governor
 * @typedef {import('./governor.mjs').Budget} Budget
 * @typedef {import('./governor.mjs').Clock} Clock
 */

/**
 * @typedef {object} GraphqlResult
 * @property {any} data
 * @property {any[]} errors `[]` when there were none; `NOT_FOUND` entries mark missing aliases
 * @property {{cost: number, remaining: number, resetAt: string} | null} rateLimit
 * @property {number} ms response time
 */

/**
 * @typedef {object} RestResult
 * @property {number} status the cached status for a 304
 * @property {any} data parsed JSON body (from the cache for a 304), or null
 * @property {string | null} etag
 * @property {boolean} notModified
 * @property {Record<string, string>} headers lower-case names
 * @property {number} ms
 */

/**
 * @typedef {object} Client
 * @property {(doc: string, variables?: Record<string, unknown>,
 *   opts?: {kind?: 'graphql' | 'search', phase?: string, signal?: AbortSignal, timeoutMs?: number})
 *   => Promise<GraphqlResult>} graphql
 * @property {(path: string, opts?: {accept?: string, apiVersion?: string, method?: string,
 *   signal?: AbortSignal, timeoutMs?: number, cache?: boolean}) => Promise<RestResult>} rest
 * @property {(budget: Budget | null) => void} setBudget GraphQL response time is then spent against
 *   `budget` under the call's `phase` (default: its kind)
 * @property {Clock} clock
 * @property {Governor} governor
 */

/**
 * Create the client.
 * @param {object} opts
 * @param {string} opts.token
 * @param {Governor} [opts.governor] default: a governor with the §9.3 numbers
 * @param {HttpCache | null} [opts.cache] `store.httpCache`
 * @param {typeof fetch} [opts.fetch] default `globalThis.fetch`
 * @param {{debug(msg: string, fields?: object): void,
 *   warn(msg: string, fields?: object): void} | null} [opts.log]
 * @param {string} [opts.userAgent]
 * @param {Clock} [opts.clock] default: the governor's clock
 * @param {number} [opts.timeoutMs] GraphQL timeout (default 12 s, the governor's reservation)
 * @param {number} [opts.restTimeoutMs]
 * @param {Budget | null} [opts.budget]
 * @param {number} [opts.maxRateRetries]
 * @returns {Client}
 */
export function createClient({
  token, governor, cache = null, fetch: fetchImpl = globalThis.fetch, log = null,
  userAgent = DEFAULT_USER_AGENT, clock, timeoutMs, restTimeoutMs = REST_TIMEOUT_MS, budget = null,
  maxRateRetries = MAX_RATE_RETRIES,
}) {
  if (typeof token !== 'string' || token.trim() === '') throw new AuthError('A GitHub token is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('createClient needs a fetch function');
  registerSecret(token);
  const gov = governor ?? createGovernor({}, clock ? { clock } : {});
  const clk = clock ?? gov.clock;
  const gqlTimeout = timeoutMs ?? gov.limits?.graphqlTimeoutMs ?? GRAPHQL_TIMEOUT_MS;
  const auth = `bearer ${token.trim()}`;
  /** @type {Budget | null} */
  let currentBudget = budget;
  const nowIso = () => (typeof clk.now === 'function' ? clk.now() : new Date(clk.ms()).toISOString());

  /**
   * One HTTP exchange with a real-time abort after `limitMs`; the duration is measured on the
   * injected clock (so a fake clock can simulate a slow answer).
   * @param {string} url
   * @param {RequestInit} init
   * @param {number} limitMs
   * @returns {Promise<{res: Response | null, text: string, ms: number, timedOut: boolean, error: unknown}>}
   */
  const send = async (url, init, limitMs) => {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctl.abort(new Error('Timed out'));
    }, limitMs);
    /** @type {any} */ (timer).unref?.();
    const t0 = clk.ms();
    try {
      const res = await fetchImpl(url, { ...init, signal: ctl.signal });
      const text = await res.text();
      const ms = clk.ms() - t0;
      return { res, text, ms, timedOut: timedOut || ms > limitMs, error: null };
    } catch (error) {
      return { res: null, text: '', ms: clk.ms() - t0, timedOut, error };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * @param {number} status
   * @param {Headers} headers
   * @param {any} json
   * @returns {RateLimitError}
   */
  const rateError = (status, headers, json) => {
    const info = rateLimitInfo(status, headers, clk.ms());
    const text = info.kind === 'retry-after'
      ? `GitHub asked Unsung to wait until ${new Date(Number(info.untilMs)).toISOString()} (HTTP ${status})`
      : info.kind === 'primary'
        ? `GitHub's hourly rate limit is used up (HTTP ${status})`
        : `GitHub's secondary rate limit was hit (HTTP ${status})`;
    const detail = typeof json?.message === 'string' ? `: ${json.message}` : '';
    return new RateLimitError(`${text}${detail}`, { status, ...info });
  };

  /** @type {Client['graphql']} */
  const graphql = async (doc, variables = {}, opts = {}) => {
    assertReadOnly(doc);
    const { kind = 'graphql', phase, signal } = opts;
    const resource = kind === 'search' ? 'search' : 'graphql';
    const limitMs = opts.timeoutMs ?? gqlTimeout;
    const body = JSON.stringify({ query: doc, variables: variables ?? {} });
    const headers = {
      authorization: auth, 'content-type': 'application/json', accept: 'application/json',
      'user-agent': userAgent,
    };
    let transient = 0;
    let rateHits = 0;
    for (;;) {
      const lease = await gov.acquire(resource, { signal });
      const r = await send(`${API_ROOT}/graphql`, { method: 'POST', headers, body }, limitMs);
      /** @param {number} points */
      const spend = (points) => currentBudget?.spend(phase ?? kind, { ms: r.ms, points });

      if (r.timedOut) {
        const e = new HeavyQueryError(`GitHub did not answer the ${kind} query within ${limitMs / 1000} s`,
          { reason: 'timeout' });
        lease.done({ ms: r.ms, error: e });
        spend(0);
        throw e;
      }
      if (!r.res) {
        lease.done({ ms: r.ms, error: r.error });
        spend(0);
        if (transient < RETRY_DELAYS_MS.length) {
          log?.debug('GitHub unreachable; retrying', { attempt: transient + 1 });
          await clk.sleep(RETRY_DELAYS_MS[transient++], { signal });
          continue;
        }
        throw new GitHubError(`Could not reach GitHub: ${errText(r.error)}`, { code: 'ENETWORK' });
      }
      const res = r.res;
      const status = res.status;
      const json = parseJson(r.text);
      const rateLimit = json?.data?.rateLimit ?? null;
      if (status === 401) {
        const e = new AuthError(AUTH_MESSAGE);
        lease.done({ ms: r.ms, headers: res.headers, error: e, status });
        throw e;
      }
      if (status === 403 || status === 429) {
        const e = rateError(status, res.headers, json);
        lease.done({ ms: r.ms, headers: res.headers, error: e, status });
        spend(0);
        if (++rateHits > maxRateRetries) throw e;
        continue;
      }
      if (status === 502 || status === 504) {
        const e = new HeavyQueryError(`GitHub answered HTTP ${status} to a ${kind} query`,
          { status, reason: status === 502 ? 'http-502' : 'http-504' });
        lease.done({ ms: r.ms, headers: res.headers, error: e, status });
        spend(0);
        throw e;
      }
      if (status >= 500) {
        const e = new GitHubError(`GitHub answered HTTP ${status} to a ${kind} query`, { status });
        lease.done({ ms: r.ms, headers: res.headers, error: e, status });
        spend(0);
        if (transient < RETRY_DELAYS_MS.length) {
          await clk.sleep(RETRY_DELAYS_MS[transient++], { signal });
          continue;
        }
        throw e;
      }
      const errors = Array.isArray(json?.errors) ? json.errors : [];
      if (status !== 200) {
        const msg = typeof json?.message === 'string' ? `: ${json.message}` : '';
        const e = new GitHubError(`GitHub answered HTTP ${status} to a ${kind} query${msg}`, { status });
        lease.done({ ms: r.ms, headers: res.headers, error: e, status });
        spend(0);
        throw e;
      }
      if (errors.some((x) => x?.type === 'RESOURCE_LIMITS_EXCEEDED')) {
        const e = new HeavyQueryError(`GitHub ran out of resources for a ${kind} query`,
          { status, reason: 'resource-limits' });
        lease.done({ ms: r.ms, headers: res.headers, error: e, status });
        spend(rateLimit?.cost ?? 0);
        throw e;
      }
      if (errors.some((x) => x?.type === 'RATE_LIMITED')) {
        const reset = Number(headerValue(res.headers, 'x-ratelimit-reset'));
        const untilMs = Number.isFinite(reset) && reset > 0 ? reset * 1000 + 5000 : clk.ms() + 60_000;
        const e = new RateLimitError('GitHub\'s hourly GraphQL rate limit is used up',
          { status, kind: 'primary', untilMs });
        lease.done({ ms: r.ms, headers: res.headers, error: e, status });
        spend(0);
        if (++rateHits > maxRateRetries) throw e;
        continue;
      }
      if (!json || json.data === null || json.data === undefined) {
        const first = typeof errors[0]?.message === 'string' ? `: ${errors[0].message}` : '';
        const e = new GitHubError(`GitHub returned no data for a ${kind} query${first}`, { status });
        lease.done({ ms: r.ms, headers: res.headers, error: e, status });
        spend(0);
        throw e;
      }
      lease.done({ ms: r.ms, headers: res.headers, rateLimit, status });
      spend(Number.isFinite(rateLimit?.cost) ? rateLimit.cost : 1);
      log?.debug('GitHub GraphQL', {
        kind, ms: r.ms, cost: rateLimit?.cost ?? null, remaining: rateLimit?.remaining ?? null,
        errors: errors.length,
      });
      return { data: json.data, errors, rateLimit, ms: r.ms };
    }
  };

  /**
   * @param {number} status
   * @param {Headers} headers
   * @param {any} json
   * @returns {boolean}
   */
  const isRestRateLimit = (status, headers, json) => status === 429
    || headerValue(headers, 'retry-after') !== null
    || headerValue(headers, 'x-ratelimit-remaining') === '0'
    || /rate limit|abuse/i.test(String(json?.message ?? ''));

  /** @type {Client['rest']} */
  const rest = async (path, opts = {}) => {
    const method = String(opts.method ?? 'GET').toUpperCase();
    if (method !== 'GET') {
      throw new ReadOnlyViolation(`Unsung only reads from GitHub; refusing ${method.slice(0, 10)} over REST`);
    }
    checkRestPath(path);
    const url = `${API_ROOT}${path}`;
    const accept = opts.accept ?? REST_ACCEPT;
    const apiVersion = opts.apiVersion ?? API_VERSION;
    const useCache = Boolean(cache) && opts.cache !== false;
    const key = cacheKey('GET', url, accept, apiVersion);
    /** @type {HttpCacheEntry | null} */
    let cached = null;
    if (useCache && cache) {
      try {
        cached = (await cache.get(key)) ?? null;
      } catch (err) {
        log?.warn('Could not read the HTTP cache', { error: err });
      }
    }
    /** @type {Record<string, string>} */
    const headers = {
      authorization: auth, accept, 'x-github-api-version': apiVersion, 'user-agent': userAgent,
    };
    if (cached?.etag) headers['if-none-match'] = cached.etag;
    if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified;
    let transient = 0;
    let rateHits = 0;
    for (;;) {
      const lease = await gov.acquire('rest', { signal: opts.signal });
      const r = await send(url, { method: 'GET', headers }, opts.timeoutMs ?? restTimeoutMs);
      if (!r.res || r.timedOut) {
        lease.done({ ms: r.ms, error: r.error ?? new Error('Timed out') });
        if (transient < RETRY_DELAYS_MS.length) {
          await clk.sleep(RETRY_DELAYS_MS[transient++], { signal: opts.signal });
          continue;
        }
        const why = r.timedOut ? 'no answer in time' : errText(r.error);
        throw new GitHubError(`Could not reach GitHub for ${path}: ${why}`, { code: 'ENETWORK' });
      }
      const res = r.res;
      const status = res.status;
      if (status === 401) {
        const e = new AuthError(AUTH_MESSAGE);
        lease.done({ ms: r.ms, headers: res.headers, error: e, status });
        throw e;
      }
      if (status === 403 || status === 429) {
        const json = parseJson(r.text);
        if (isRestRateLimit(status, res.headers, json)) {
          const e = rateError(status, res.headers, json);
          lease.done({ ms: r.ms, headers: res.headers, error: e, status });
          if (++rateHits > maxRateRetries) throw e;
          continue;
        }
      }
      if (status >= 500) {
        const e = new GitHubError(`GitHub answered HTTP ${status} for ${path}`, { status });
        lease.done({ ms: r.ms, headers: res.headers, error: e, status });
        if (transient < RETRY_DELAYS_MS.length) {
          await clk.sleep(RETRY_DELAYS_MS[transient++], { signal: opts.signal });
          continue;
        }
        throw e;
      }
      lease.done({ ms: r.ms, headers: res.headers, status });
      const hdrs = plainHeaders(res.headers);
      const etag = headerValue(res.headers, 'etag');
      log?.debug('GitHub REST', { path, status, ms: r.ms });
      if (status === 304) {
        if (cached && cache) {
          try {
            await cache.put(key, { ...cached, at: nowIso() });
          } catch (err) {
            log?.warn('Could not write the HTTP cache', { error: err });
          }
          return {
            status: cached.status ?? 200, data: cached.body ?? null, etag: cached.etag ?? etag ?? null,
            notModified: true, headers: hdrs, ms: r.ms,
          };
        }
        return { status, data: null, etag: etag ?? null, notModified: true, headers: hdrs, ms: r.ms };
      }
      const data = parseJson(r.text);
      const lastModified = headerValue(res.headers, 'last-modified');
      if (status === 200 && useCache && cache && (etag || lastModified)) {
        try {
          await cache.put(key, {
            url: redact(url), etag: etag ?? null, lastModified: lastModified ?? null, status, body: data,
            at: nowIso(),
          });
        } catch (err) {
          log?.warn('Could not write the HTTP cache', { error: err });
        }
      }
      return { status, data, etag: etag ?? null, notModified: false, headers: hdrs, ms: r.ms };
    }
  };

  return {
    graphql,
    rest,
    setBudget(b) {
      currentBudget = b ?? null;
    },
    clock: clk,
    governor: gov,
  };
}
