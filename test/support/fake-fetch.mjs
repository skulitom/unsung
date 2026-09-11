// @ts-check
/**
 * A scripted `fetch` for tests (DESIGN §12.1). Routes match by method, URL, GraphQL-document hash,
 * query text or variables; each route answers with one response, a sequence (the last repeats), or
 * a function. Every call is recorded. Responses are real WHATWG `Response` objects, so streaming
 * bodies, `headers.get()` and `json()` behave as they do against GitHub.
 *
 *   const fetch = createFakeFetch([
 *     { method: 'POST', hash: documentHash(SEARCH_QUERY), responses: [502, { status: 200, body }] },
 *     { url: '/repos/o/r/activity?per_page=100',
 *       response: { status: 403, headers: { 'retry-after': '60' } } },
 *   ], { clock });
 *
 * This file is a helper: `node --test` loads it, and it only exports functions.
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

/**
 * @typedef {object} ResponseSpec
 * @property {number} [status] default 200
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body] a string or bytes are sent as they are; anything else as JSON
 * @property {number} [ms] simulated server time: advances the fake clock (`opts.clock`) first
 * @property {Error | string} [error] reject like a network failure instead of answering
 * @property {boolean} [hang] never answer; rejects with an AbortError when the request is aborted
 */

/** @typedef {ResponseSpec | number} Reply a response, or just its status */

/**
 * A recorded exchange from `test/fixtures/github/` (§14.2).
 * @typedef {object} RecordedFixture
 * @property {{query?: string, variables?: Record<string, unknown>, path?: string}} [request]
 * @property {number} [status]
 * @property {Record<string, string>} [headers]
 * @property {unknown} [body]
 */

/**
 * @typedef {object} RecordedCall
 * @property {number} n position among all calls, from 0
 * @property {string} method upper case
 * @property {string} url
 * @property {Record<string, string>} headers lower-case names
 * @property {string | undefined} body
 * @property {any} json the body parsed as JSON, or null
 * @property {string | null} query the GraphQL document, when the body has one
 * @property {Record<string, unknown> | null} variables GraphQL variables
 * @property {string | null} hash `documentHash(query)`
 * @property {string | number | null} route the matching route's name, else its index
 */

/**
 * @typedef {object} Route
 * @property {string} [name]
 * @property {string} [method] any method when absent
 * @property {string | RegExp | ((url: string, call: RecordedCall) => boolean)} [url] a full URL, or a
 *   string starting with `/` that must equal the URL's path and query
 * @property {string} [hash] GraphQL document hash
 * @property {string | RegExp} [query] substring or pattern of the GraphQL document
 * @property {Record<string, unknown> | ((variables: Record<string, unknown> | null) => boolean)} [variables]
 *   GraphQL variables that must be present with these values (or a predicate)
 * @property {ResponseSpec | number} [response]
 * @property {(ResponseSpec | number)[]} [responses] one per call; the last one repeats
 * @property {(call: RecordedCall, n: number) => Reply | Promise<Reply>} [respond]
 * @property {number} [times] stop matching after this many calls
 */

/**
 * @typedef {object} FakeFetchOptions
 * @property {{advance(ms: number): unknown}} [clock] advanced by each response's `ms`
 * @property {'throw' | ResponseSpec | number} [onUnmatched] default: reject with a descriptive error
 */

/**
 * @typedef {((input: string | URL | Request, init?: RequestInit) => Promise<Response>) & {
 *   calls: RecordedCall[], reset(): void, add(...routes: Route[]): void, unused(): Route[]
 * }} FakeFetch
 */

/**
 * Hash of a GraphQL document with whitespace collapsed: 12 hex characters of SHA-1.
 * @param {string} query
 * @returns {string}
 */
export function documentHash(query) {
  return createHash('sha1').update(String(query).replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);
}

/** @returns {Error} */
function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * @param {unknown} body
 * @returns {Promise<string | undefined>}
 */
async function bodyText(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return new TextDecoder().decode(/** @type {ArrayBuffer} */ (body));
  }
  return new Response(/** @type {BodyInit} */ (body)).text();
}

/**
 * @param {number} status
 * @param {ResponseSpec} spec
 * @param {string} url
 * @returns {Response}
 */
function makeResponse(status, spec, url) {
  const headers = new Headers(spec.headers ?? {});
  /** @type {BodyInit | null} */
  let body = null;
  const nullBody = [101, 204, 205, 304].includes(status);
  if (!nullBody && spec.body !== undefined && spec.body !== null) {
    if (typeof spec.body === 'string' || spec.body instanceof ArrayBuffer || ArrayBuffer.isView(spec.body)) {
      body = /** @type {BodyInit} */ (spec.body);
    } else {
      body = JSON.stringify(spec.body);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
    }
  }
  const res = new Response(body, { status, headers });
  Object.defineProperty(res, 'url', { value: url });
  return res;
}

/**
 * Build a route from a recorded fixture — `{request: {query, variables}, status, headers, body}` for
 * GraphQL or `{request: {path}, status, headers, body}` for REST (§14.2).
 * @param {RecordedFixture} fx
 * @param {{matchVariables?: boolean, name?: string}} [opts]
 * @returns {Route}
 */
export function fixtureRoute(fx, { matchVariables = false, name } = {}) {
  const req = fx.request ?? {};
  const response = { status: fx.status ?? 200, headers: fx.headers ?? {}, body: fx.body };
  if (typeof req.query === 'string') {
    /** @type {Route} */
    const route = { name, method: 'POST', hash: documentHash(req.query), response };
    if (matchVariables && req.variables) route.variables = req.variables;
    return route;
  }
  if (typeof req.path === 'string') return { name, method: 'GET', url: req.path, response };
  throw new TypeError('A fixture needs request.query (GraphQL) or request.path (REST)');
}

/**
 * Create a scripted fetch.
 * @param {Route[]} [routes]
 * @param {FakeFetchOptions} [opts]
 * @returns {FakeFetch}
 */
export function createFakeFetch(routes = [], { clock, onUnmatched = 'throw' } = {}) {
  const table = [...routes];
  /** @type {RecordedCall[]} */
  const calls = [];
  /** @type {Map<Route, number>} */
  const counts = new Map();

  /**
   * @param {Route} route
   * @param {RecordedCall} call
   * @returns {boolean}
   */
  const matches = (route, call) => {
    if (route.times !== undefined && (counts.get(route) ?? 0) >= route.times) return false;
    if (route.method && route.method.toUpperCase() !== call.method) return false;
    if (route.url !== undefined) {
      if (typeof route.url === 'function') {
        if (!route.url(call.url, call)) return false;
      } else if (route.url instanceof RegExp) {
        if (!route.url.test(call.url)) return false;
      } else if (route.url.startsWith('/')) {
        const u = new URL(call.url);
        if (`${u.pathname}${u.search}` !== route.url) return false;
      } else if (route.url !== call.url) return false;
    }
    if (route.hash !== undefined && route.hash !== call.hash) return false;
    if (route.query !== undefined) {
      if (call.query === null) return false;
      const q = route.query;
      if (q instanceof RegExp ? !q.test(call.query) : !call.query.includes(q)) return false;
    }
    if (route.variables !== undefined) {
      if (typeof route.variables === 'function') return route.variables(call.variables);
      const vars = call.variables ?? {};
      for (const [k, v] of Object.entries(route.variables)) if (!isDeepStrictEqual(vars[k], v)) return false;
    }
    return true;
  };

  /**
   * @param {string | URL | Request} input
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  const fakeFetch = async (input, init = {}) => {
    const isRequest = typeof input === 'object' && input !== null && !(input instanceof URL);
    const request = /** @type {Request} */ (isRequest ? input : null);
    const url = request ? request.url : String(input);
    const method = String(init.method ?? request?.method ?? 'GET').toUpperCase();
    const headerInit = init.headers ?? request?.headers ?? {};
    /** @type {Record<string, string>} */
    const headers = {};
    new Headers(/** @type {HeadersInit} */ (headerInit)).forEach((v, k) => {
      headers[k] = v;
    });
    const body = await bodyText(init.body ?? (request?.body ? await request.text() : undefined));
    /** @type {any} */
    let json = null;
    if (body !== undefined) {
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
    }
    const query = json && typeof json.query === 'string' ? json.query : null;
    /** @type {RecordedCall} */
    const call = {
      n: calls.length, method, url, headers, body, json, query,
      variables: json && typeof json.variables === 'object' ? json.variables : null,
      hash: query === null ? null : documentHash(query), route: null,
    };
    calls.push(call);

    const signal = init.signal ?? request?.signal ?? null;
    if (signal?.aborted) throw signal.reason ?? abortError();

    const route = table.find((r) => matches(r, call));
    /** @type {ResponseSpec | number} */
    let spec;
    if (!route) {
      if (onUnmatched === 'throw') throw new Error(`fake-fetch: no route for ${method} ${url}`);
      spec = onUnmatched;
    } else {
      const n = counts.get(route) ?? 0;
      counts.set(route, n + 1);
      call.route = route.name ?? table.indexOf(route);
      if (route.respond) spec = await route.respond(call, n);
      else if (route.responses && route.responses.length > 0) {
        spec = route.responses[Math.min(n, route.responses.length - 1)];
      } else spec = route.response ?? 200;
    }
    const s = typeof spec === 'number' ? { status: spec } : spec;
    if (typeof s.ms === 'number' && s.ms > 0 && clock) clock.advance(s.ms);
    if (s.hang) {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason ?? abortError()), { once: true });
      });
    }
    if (signal?.aborted) throw signal.reason ?? abortError();
    if (s.error !== undefined) {
      if (s.error instanceof Error) throw s.error;
      throw new TypeError('fetch failed', { cause: new Error(String(s.error)) });
    }
    return makeResponse(s.status ?? 200, s, url);
  };

  return Object.assign(fakeFetch, {
    calls,
    reset() {
      calls.length = 0;
      counts.clear();
    },
    /** @param {...Route} more */
    add(...more) {
      table.push(...more);
    },
    unused() {
      return table.filter((r) => !counts.has(r));
    },
  });
}
