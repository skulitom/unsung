// @ts-check
/**
 * Census windows (DESIGN §3.2): adaptive `created:` windows searched through GraphQL and paged with
 * crafted cursors.
 *
 * 1. Probe a window with `first: 100` (the probe is page 1).
 * 2. Up to 800 hits: fetch pages 2…n with `after = base64("cursor:" + 100·k)`, never letting
 *    `after + first` exceed 1,000. An empty page past the real end is not an error.
 * 3. More than 800 hits in a window longer than 60 s: split it into `ceil(count / 750)` equal
 *    sub-windows (whole seconds) and recurse. Leaves of at most 8 pages are paged within 60 s of
 *    their probe's answer under the governor's pacing (about 5–5.5 s a page); 9 pages are not.
 * 4. A window of at most 60 s: up to 1,000 hits are paged whole; more than 1,000 are split by star
 *    value (`stars:0`, `stars:1`, `stars:2..25`), and a star leaf still over 1,000 keeps its first
 *    1,000 and is recorded as `saturated` with the reported count.
 * 5. Leaves are paged straight after their probe; nodes are de-duplicated by id and any node whose
 *    live values violate the base query is dropped (the search index drifts).
 *
 * Each leaf is one ledger unit, `census:<day>:<scope>:<FROM>..<TO>` (plus `:stars=<v>` for a star
 * leaf). Windows already covered by `done` units are skipped without a probe, so a resumed run
 * costs nothing for the work it has done. A leaf is marked done only when the consumer asks for the
 * next one, i.e. after it has handled the leaf's nodes.
 */

import { BASE_QUERY, SEARCH_QUERY } from './queries.mjs';

/** Results per search page. */
export const PAGE_SIZE = 100;

/** GitHub serves at most this many results per search. */
export const RESULT_CAP = 1000;

/** A window with at most this many hits is a leaf: at most 8 pages, paged within 60 s. */
export const LEAF_MAX = 800;

/** Target hits per sub-window when splitting. */
export const SPLIT_TARGET = 750;

/** Windows no longer than this (seconds) are never split by time. */
export const MIN_SPLIT_SECONDS = 60;

/** A leaf should be paged within this long of its probe. */
export const PAGE_WINDOW_MS = 60_000;

/** A search page that fails as heavy is retried this many times before the leaf fails. */
export const PAGE_RETRIES = 2;

const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z';

/**
 * @typedef {{lang: string | null, topic: string | null}} Scope
 * @typedef {{fromIso: string, toIso: string}} Window
 * @typedef {import('./client.mjs').Client} Client
 */

/**
 * @typedef {object} Ledger the `Store.ledger` interface (§12.3); every method may be async
 * @property {(key: string) => unknown} [get]
 * @property {(key: string) => boolean | Promise<boolean>} [isDone]
 * @property {(key: string, stage: string, runId: string | null) => unknown} [start]
 * @property {(key: string, out: Record<string, unknown>) => unknown} [done]
 * @property {(key: string, err: Record<string, unknown> | string) => unknown} [fail]
 * @property {(q: {state?: string}) => unknown} [list] units (or keys), as an array or async iterable
 */

/**
 * @typedef {object} CensusLeaf
 * @property {string} key ledger unit key
 * @property {string} fromIso
 * @property {string} toIso
 * @property {string | null} stars star split value, or null
 * @property {number} count hits the probe reported
 * @property {any[]} nodes lean search nodes that pass the base query, not seen before in this walk
 * @property {number} pages search requests made for this leaf, the probe included
 * @property {boolean} saturated the count exceeded 1,000 and only the first 1,000 were read
 * @property {number} dropped nodes whose live values violate the base query
 * @property {number} ms GraphQL response time spent on the leaf
 * @property {number} points GraphQL points spent on the leaf
 * @property {number} spanMs from the probe to the last page
 */

/**
 * @typedef {object} CensusStats
 * @property {number} probes
 * @property {number} pages
 * @property {number} leaves
 * @property {number} saturated
 * @property {number} skipped windows or leaves skipped because their units are done
 * @property {number} failed windows or leaves whose search failed (recorded as failed units)
 * @property {number} dropped
 * @property {number} duplicates
 */

/**
 * `base64("cursor:" + n)`: the crafted cursor for offset `n` (§3.2).
 * @param {number} n
 * @returns {string}
 */
export function cursor(n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('A cursor offset must be a whole number ≥ 0');
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

/**
 * @param {unknown} v
 * @param {string} what
 * @returns {string | null}
 */
function scopeValue(v, what) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!s || s.length > 100 || /[:,="\\]|[\x00-\x1f\x7f]/.test(s)) {
    throw new RangeError(`A census ${what} must be a plain name (no : , = or quotes)`);
  }
  return s;
}

/**
 * A scope as `{lang, topic}`. Accepts `null`, `'all'`, `'lang=rust,topic=cli'`, or an object with
 * `lang` (or `language`) and `topic`.
 * @param {unknown} scope
 * @returns {Scope}
 */
export function normaliseScope(scope) {
  if (scope === null || scope === undefined || scope === '' || scope === 'all') {
    return { lang: null, topic: null };
  }
  if (typeof scope === 'string') {
    /** @type {Record<string, string>} */
    const parts = {};
    for (const part of scope.split(',')) {
      const i = part.indexOf('=');
      const k = i > 0 ? part.slice(0, i).trim() : '';
      if (k !== 'lang' && k !== 'topic') throw new RangeError(`Unknown census scope '${scope.slice(0, 60)}'`);
      parts[k] = part.slice(i + 1);
    }
    return { lang: scopeValue(parts.lang, 'language'), topic: scopeValue(parts.topic, 'topic') };
  }
  if (typeof scope === 'object') {
    const o = /** @type {Record<string, unknown>} */ (scope);
    return { lang: scopeValue(o.lang ?? o.language, 'language'), topic: scopeValue(o.topic, 'topic') };
  }
  throw new RangeError('A census scope must be null, a string or {lang, topic}');
}

/**
 * The scope part of a unit key: `all`, `lang=rust`, `topic=cli` or `lang=rust,topic=cli`.
 * @param {unknown} scope
 * @returns {string}
 */
export function scopeKey(scope) {
  const s = normaliseScope(scope);
  const parts = [];
  if (s.lang) parts.push(`lang=${s.lang.toLowerCase()}`);
  if (s.topic) parts.push(`topic=${s.topic.toLowerCase()}`);
  return parts.length > 0 ? parts.join(',') : 'all';
}

/**
 * @param {string} v
 * @returns {string}
 */
function qualifier(v) {
  return /^[A-Za-z0-9_.+#-]+$/.test(v) ? v : `"${v}"`;
}

/**
 * The search qualifiers of a scope: `language:rust topic:cli`, or `''`.
 * @param {unknown} scope
 * @returns {string}
 */
export function scopeQualifiers(scope) {
  const s = normaliseScope(scope);
  const parts = [];
  if (s.lang) parts.push(`language:${qualifier(s.lang)}`);
  if (s.topic) parts.push(`topic:${qualifier(s.topic)}`);
  return parts.join(' ');
}

/**
 * @param {string} iso
 * @returns {number}
 */
function parseIso(iso) {
  if (typeof iso !== 'string' || !ISO_SECOND.test(iso)) {
    const got = String(iso).slice(0, 30);
    throw new RangeError(`A census window bound must look like 2026-09-08T13:00:00Z, got '${got}'`);
  }
  return Date.parse(iso);
}

/**
 * @param {number} ms
 * @returns {string}
 */
function fmt(ms) {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/**
 * The search string of a window (§3.2): the base query, an optional star override, the inclusive
 * `created:` window, the scope and the sort.
 * @param {string | null | undefined} base default `BASE_QUERY`
 * @param {unknown} scope
 * @param {string} fromIso `YYYY-MM-DDTHH:MM:SSZ`
 * @param {string} toIso inclusive
 * @param {string | number | null} [stars] replaces the base query's `stars:` range
 * @returns {string}
 */
export function searchString(base, scope, fromIso, toIso, stars) {
  let b = String(base ?? BASE_QUERY).trim();
  if (stars !== undefined && stars !== null) {
    const v = String(stars);
    if (!/^\d+(\.\.\d+)?$/.test(v)) throw new RangeError('A star split must look like 0, 1 or 2..25');
    b = /(^|\s)stars:\S+/.test(b) ? b.replace(/(^|\s)stars:\S+/, `$1stars:${v}`) : `${b} stars:${v}`;
  }
  parseIso(fromIso);
  parseIso(toIso);
  const sc = scopeQualifiers(scope);
  return `${b} created:${fromIso}..${toIso}${sc ? ` ${sc}` : ''} sort:stars-asc`;
}

/**
 * What the base query demands of a node's live values.
 * @param {string | null | undefined} base
 * @returns {{minStars: number, maxStars: number, minKB: number, noFork: boolean, noArchived: boolean,
 *   noTemplate: boolean, noMirror: boolean}}
 */
export function baseCriteria(base) {
  const b = String(base ?? BASE_QUERY);
  const stars = /(?:^|\s)stars:(\d+)\.\.(\d+)(?=\s|$)/.exec(b);
  const size = /(?:^|\s)size:>=(\d+)(?=\s|$)/.exec(b);
  return {
    minStars: stars ? Number(stars[1]) : 0,
    maxStars: stars ? Number(stars[2]) : Number.POSITIVE_INFINITY,
    minKB: size ? Number(size[1]) : 0,
    noFork: /(?:^|\s)fork:false(?=\s|$)/.test(b),
    noArchived: /(?:^|\s)archived:false(?=\s|$)/.test(b),
    noTemplate: /(?:^|\s)template:false(?=\s|$)/.test(b),
    noMirror: /(?:^|\s)mirror:false(?=\s|$)/.test(b),
  };
}

/**
 * Whether a lean node's live values still satisfy the base query (and the window and language, when
 * given).
 * @param {any} node
 * @param {ReturnType<typeof baseCriteria>} crit
 * @param {Window | null} [win]
 * @param {string | null} [lang]
 * @returns {boolean}
 */
export function nodeMatchesBase(node, crit, win = null, lang = null) {
  if (!node || typeof node !== 'object' || typeof node.id !== 'string') return false;
  if ((crit.noFork && node.isFork) || (crit.noArchived && node.isArchived)
    || (crit.noTemplate && node.isTemplate) || (crit.noMirror && node.isMirror)) return false;
  const stars = Number(node.stargazerCount);
  if (!(stars >= crit.minStars && stars <= crit.maxStars)) return false;
  if (!(Number(node.diskUsage) >= crit.minKB)) return false;
  if (win) {
    const t = Date.parse(String(node.createdAt ?? ''));
    if (!(t >= Date.parse(win.fromIso) && t < Date.parse(win.toIso) + 1000)) return false;
  }
  if (lang && String(node.primaryLanguage?.name ?? '').toLowerCase() !== lang.toLowerCase()) return false;
  return true;
}

/**
 * The star values a window of at most 60 s is split into: `0`, `1`, `2..25` for the base range
 * `0..25` (fewer when the range is narrower).
 * @param {ReturnType<typeof baseCriteria>} crit
 * @returns {string[]}
 */
export function starSplits(crit) {
  const lo = crit.minStars;
  const hi = crit.maxStars;
  if (!Number.isFinite(hi)) return [`${lo}`];
  if (hi <= lo) return [`${lo}`];
  if (hi === lo + 1) return [`${lo}`, `${hi}`];
  return [`${lo}`, `${lo + 1}`, `${lo + 2}..${hi}`];
}

/**
 * Number of whole seconds in an inclusive window.
 * @param {string} fromIso
 * @param {string} toIso
 * @returns {number}
 */
export function windowSeconds(fromIso, toIso) {
  return Math.round((parseIso(toIso) - parseIso(fromIso)) / 1000) + 1;
}

/**
 * Split an inclusive window into `parts` equal sub-windows on whole seconds (never more parts than
 * seconds).
 * @param {string} fromIso
 * @param {string} toIso
 * @param {number} parts
 * @returns {Window[]}
 */
export function splitWindow(fromIso, toIso, parts) {
  const from = parseIso(fromIso);
  const secs = windowSeconds(fromIso, toIso);
  if (secs < 1) throw new RangeError('A census window must end after it starts');
  const n = Math.max(1, Math.min(Math.floor(parts), secs));
  /** @type {Window[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * secs) / n);
    const b = Math.floor(((i + 1) * secs) / n) - 1;
    out.push({ fromIso: fmt(from + a * 1000), toIso: fmt(from + b * 1000) });
  }
  return out;
}

/**
 * The 24 hourly windows of a created-day (UTC), oldest first.
 * @param {string} day `YYYY-MM-DD`
 * @returns {Window[]}
 */
export function hourWindows(day) {
  if (typeof day !== 'string' || !DAY.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`))) {
    throw new RangeError(`A census day must look like 2026-09-08, got '${String(day).slice(0, 30)}'`);
  }
  return Array.from({ length: 24 }, (_, h) => {
    const hh = String(h).padStart(2, '0');
    return { fromIso: `${day}T${hh}:00:00Z`, toIso: `${day}T${hh}:59:59Z` };
  });
}

/**
 * The ledger key of a census leaf (§3.12).
 * @param {string} day
 * @param {unknown} scope
 * @param {string} fromIso
 * @param {string} toIso
 * @param {string | null} [stars]
 * @returns {string}
 */
export function windowKey(day, scope, fromIso, toIso, stars) {
  return `census:${day}:${scopeKey(scope)}:${fromIso}..${toIso}${stars ? `:stars=${stars}` : ''}`;
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function recoverable(err) {
  const code = /** @type {any} */ (err)?.code;
  return code === 'EHEAVY' || code === 'EGITHUB' || code === 'ENETWORK';
}

/**
 * @param {unknown} err
 * @returns {{name: string, code: string | null, message: string}}
 */
function errInfo(err) {
  const e = /** @type {any} */ (err);
  return { name: String(e?.name ?? 'Error'), code: e?.code ?? null, message: String(e?.message ?? err) };
}

/**
 * Intervals (ms, inclusive) covered by done units with the given key prefix. A star-split window
 * counts once all of its star leaves are done.
 * @param {Ledger | null} ledger
 * @param {string} prefix `census:<day>:<scope>:`
 * @param {string[]} splits
 * @returns {Promise<[number, number][]>}
 */
async function doneIntervals(ledger, prefix, splits) {
  if (!ledger || typeof ledger.list !== 'function') return [];
  /** @type {string[]} */
  const keys = [];
  try {
    const units = /** @type {any} */ (await ledger.list({ state: 'done' }));
    /** @param {any} u */
    const add = (u) => {
      const key = typeof u === 'string' ? u : u?.key;
      const isDoneUnit = typeof u === 'string' || !u.state || u.state === 'done';
      if (typeof key === 'string' && key.startsWith(prefix) && isDoneUnit) {
        keys.push(key);
      }
    };
    if (units && typeof units[Symbol.asyncIterator] === 'function') for await (const u of units) add(u);
    else if (units && typeof units[Symbol.iterator] === 'function') for (const u of units) add(u);
  } catch {
    return [];
  }
  /** @type {[number, number][]} */
  const out = [];
  /** @type {Map<string, Set<string>>} */
  const starred = new Map();
  const re = new RegExp(`^(${STAMP})\\.\\.(${STAMP})(?::stars=(\\S+))?$`);
  for (const key of keys) {
    const m = re.exec(key.slice(prefix.length));
    if (!m) continue;
    if (m[3] === undefined) out.push([Date.parse(m[1]), Date.parse(m[2])]);
    else {
      const span = `${m[1]}..${m[2]}`;
      if (!starred.has(span)) starred.set(span, new Set());
      /** @type {Set<string>} */ (starred.get(span)).add(m[3]);
    }
  }
  for (const [span, got] of starred) {
    if (splits.every((s) => got.has(s))) {
      const [a, b] = span.split('..');
      out.push([Date.parse(a), Date.parse(b)]);
    }
  }
  out.sort((x, y) => x[0] - y[0]);
  /** @type {[number, number][]} */
  const merged = [];
  for (const iv of out) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1] + 1000) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }
  return merged;
}

/**
 * @param {[number, number][]} intervals merged
 * @param {Window} win
 * @returns {boolean}
 */
function isCovered(intervals, win) {
  const a = Date.parse(win.fromIso);
  const b = Date.parse(win.toIso);
  return intervals.some(([x, y]) => x <= a && y >= b);
}

/**
 * Walk one created window adaptively and yield its leaf windows (§3.2).
 * @param {object} opts
 * @param {Client} opts.client
 * @param {string} [opts.base] default `BASE_QUERY`
 * @param {unknown} [opts.scope] `null`/`'all'`, `'lang=rust'`, or `{lang, topic}`
 * @param {string} opts.fromIso
 * @param {string} opts.toIso inclusive
 * @param {Ledger | null} [opts.ledger]
 * @param {{debug(msg: string, f?: object): void, warn(msg: string, f?: object): void} | null} [opts.log]
 * @param {string} [opts.day] the created-day of the unit keys (default: the day of `fromIso`)
 * @param {string | null} [opts.runId]
 * @param {{ms(): number}} [opts.clock] default: the client's clock
 * @param {string} [opts.phase] budget phase (default `census`)
 * @param {AbortSignal} [opts.signal]
 * @param {Set<string>} [opts.seen] node ids already yielded (shared across windows of a day)
 * @param {Partial<CensusStats>} [opts.stats]
 * @returns {AsyncGenerator<CensusLeaf>}
 */
export async function* censusWindows(opts) {
  const {
    client, base = BASE_QUERY, scope = null, fromIso, toIso, ledger = null, log = null, runId = null,
    phase = 'census', signal, seen = new Set(),
  } = opts;
  if (!client || typeof client.graphql !== 'function') throw new TypeError('censusWindows needs a client');
  if (windowSeconds(fromIso, toIso) < 1) throw new RangeError('A census window must end after it starts');
  const day = opts.day ?? fromIso.slice(0, 10);
  const sc = normaliseScope(scope);
  const crit = baseCriteria(base);
  const splits = starSplits(crit);
  const clock = opts.clock ?? client.clock ?? { ms: () => Date.now() };
  const stats = /** @type {CensusStats} */ (Object.assign(opts.stats ?? {}, {
    probes: opts.stats?.probes ?? 0, pages: opts.stats?.pages ?? 0, leaves: opts.stats?.leaves ?? 0,
    saturated: opts.stats?.saturated ?? 0, skipped: opts.stats?.skipped ?? 0, failed: opts.stats?.failed ?? 0,
    dropped: opts.stats?.dropped ?? 0, duplicates: opts.stats?.duplicates ?? 0,
  }));
  const intervals = await doneIntervals(ledger, `census:${day}:${scopeKey(sc)}:`, splits);

  /**
   * @param {string} key
   * @returns {Promise<boolean>}
   */
  const isDone = async (key) => Boolean(ledger && typeof ledger.isDone === 'function'
    && await ledger.isDone(key));

  /**
   * One search page.
   * @param {Window} win
   * @param {string | null} stars
   * @param {number} offset
   */
  const page = async (win, stars, offset) => {
    const q = searchString(base, sc, win.fromIso, win.toIso, stars);
    const variables = offset > 0 ? { q, first: PAGE_SIZE, after: cursor(offset) } : { q, first: PAGE_SIZE };
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await client.graphql(SEARCH_QUERY, variables, { kind: 'search', phase, signal });
        stats.pages++;
        const s = r.data?.search;
        if (!s || typeof s.repositoryCount !== 'number') {
          const e = new Error('GitHub search returned no result');
          Object.assign(e, { name: 'GitHubError', code: 'EGITHUB' });
          throw e;
        }
        const raw = Array.isArray(s.nodes) ? s.nodes : [];
        return {
          count: s.repositoryCount,
          raw: raw.length,
          nodes: raw.filter((/** @type {any} */ n) => n && typeof n.id === 'string'),
          hasNextPage: s.pageInfo?.hasNextPage ?? null,
          ms: r.ms,
          cost: Number.isFinite(r.rateLimit?.cost) ? Number(r.rateLimit?.cost) : 1,
        };
      } catch (err) {
        const heavy = /** @type {any} */ (err)?.code === 'EHEAVY';
        if (heavy && attempt < PAGE_RETRIES) {
          log?.debug('Census page was heavy; retrying', { attempt: attempt + 1 });
          continue;
        }
        throw err;
      }
    }
  };

  /**
   * Page a leaf and yield it; mark it done when the consumer comes back.
   * @param {Window} win
   * @param {Awaited<ReturnType<typeof page>>} first the leaf's own probe
   * @param {string | null} stars
   * @param {number} probeAt
   * @returns {AsyncGenerator<CensusLeaf>}
   */
  async function* leaf(win, first, stars, probeAt) {
    const key = windowKey(day, sc, win.fromIso, win.toIso, stars);
    if (await isDone(key)) {
      stats.skipped++;
      return;
    }
    await ledger?.start?.(key, 'census', runId);
    const count = first.count;
    const wanted = Math.min(count, RESULT_CAP);
    /** @type {Map<string, any>} */
    const found = new Map();
    for (const n of first.nodes) found.set(n.id, n);
    let pages = 1;
    let ms = first.ms;
    let points = first.cost;
    let last = first;
    try {
      for (let k = 1; k * PAGE_SIZE < wanted && k * PAGE_SIZE + PAGE_SIZE <= RESULT_CAP; k++) {
        if (last.raw === 0 || (last.hasNextPage === false && last.raw < PAGE_SIZE)) break;
        last = await page(win, stars, k * PAGE_SIZE);
        pages++;
        ms += last.ms;
        points += last.cost;
        for (const n of last.nodes) if (!found.has(n.id)) found.set(n.id, n);
      }
    } catch (err) {
      if (!recoverable(err)) throw err;
      stats.failed++;
      await ledger?.fail?.(key, errInfo(err));
      log?.warn('Census window failed; it will be retried on a later run', { key, error: err });
      return;
    }
    const spanMs = clock.ms() - probeAt;
    if (spanMs > PAGE_WINDOW_MS) {
      log?.warn('Census window took more than 60 s to page after its probe', {
        key, seconds: Math.round(spanMs / 1000),
      });
    }
    /** @type {any[]} */
    const nodes = [];
    let dropped = 0;
    for (const n of found.values()) {
      if (!nodeMatchesBase(n, crit, win, sc.lang)) {
        dropped++;
        continue;
      }
      if (seen.has(n.id)) {
        stats.duplicates++;
        continue;
      }
      seen.add(n.id);
      nodes.push(n);
    }
    const saturated = count > RESULT_CAP;
    stats.leaves++;
    stats.dropped += dropped;
    if (saturated) {
      stats.saturated++;
      log?.warn('Census window saturated: kept the first 1,000 results', { key, count });
    }
    yield {
      key, fromIso: win.fromIso, toIso: win.toIso, stars, count, nodes, pages, saturated, dropped, ms, points,
      spanMs,
    };
    await ledger?.done?.(key, { count, pages, saturated, seeds: nodes.length });
  }

  /**
   * @param {Window} win
   * @returns {AsyncGenerator<CensusLeaf>}
   */
  async function* walk(win) {
    if (isCovered(intervals, win)) {
      stats.skipped++;
      return;
    }
    /** @type {Awaited<ReturnType<typeof page>>} */
    let first;
    try {
      first = await page(win, null, 0);
    } catch (err) {
      if (!recoverable(err)) throw err;
      stats.failed++;
      const key = windowKey(day, sc, win.fromIso, win.toIso);
      await ledger?.fail?.(key, errInfo(err));
      log?.warn('Census probe failed; the window will be retried on a later run', { key, error: err });
      return;
    }
    stats.probes++;
    // The span runs from the probe's answer: time the governor held the probe back is not drift.
    const probeAt = clock.ms();
    const secs = windowSeconds(win.fromIso, win.toIso);
    if (first.count <= LEAF_MAX || (secs <= MIN_SPLIT_SECONDS && first.count <= RESULT_CAP)) {
      yield* leaf(win, first, null, probeAt);
      return;
    }
    if (secs > MIN_SPLIT_SECONDS) {
      for (const sub of splitWindow(win.fromIso, win.toIso, Math.ceil(first.count / SPLIT_TARGET))) {
        yield* walk(sub);
      }
      return;
    }
    if (splits.length < 2) {
      yield* leaf(win, first, null, probeAt);
      return;
    }
    for (const stars of splits) {
      const key = windowKey(day, sc, win.fromIso, win.toIso, stars);
      if (await isDone(key)) {
        stats.skipped++;
        continue;
      }
      /** @type {Awaited<ReturnType<typeof page>>} */
      let probe;
      try {
        probe = await page(win, stars, 0);
      } catch (err) {
        if (!recoverable(err)) throw err;
        stats.failed++;
        await ledger?.fail?.(key, errInfo(err));
        log?.warn('Census probe failed; the window will be retried on a later run', { key, error: err });
        continue;
      }
      stats.probes++;
      yield* leaf(win, probe, stars, clock.ms());
    }
  }

  yield* walk({ fromIso, toIso });
}
