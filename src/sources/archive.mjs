// @ts-check
/**
 * The GH Archive lane (DESIGN §3.3). One hour of public GitHub events is streamed from
 * data.gharchive.org — fetch → `node:zlib` gunzip → split on `\n` by hand, never `readline`, which
 * also breaks lines at U+2028 and so breaks `JSON.parse` — and only lines containing
 * `"type":"ReleaseEvent"` or `"type":"PublicEvent"` are parsed. A line that fails to parse is counted
 * and skipped. The file never touches the disk and costs no API budget; its compact extract is
 * handed to `writeExtract`. The repositories named by non-prerelease events are then looked up with
 * aliased lean queries (100 per query) and those that pass the base query become seeds with source
 * `archive:<YYYY-MM-DD-H>:<Release|Public>`.
 *
 * No token is ever sent to data.gharchive.org: `archiveHour` takes its own plain `fetch`.
 */

import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { runBatched } from '../github/batch.mjs';
import { LEAN_FRAGMENT, aliasedRepoQuery, refOf } from '../github/queries.mjs';
import { DEFAULT_MAX_STARS, passesBase, seedFromNode } from './seed.mjs';

/** Where GH Archive files live (§2 network allowlist). */
export const ARCHIVE_HOST = 'https://data.gharchive.org';

/** Event types the lane reads. */
export const ARCHIVE_TYPES = Object.freeze(['ReleaseEvent', 'PublicEvent']);

/** An hour is complete when `now ≥ hour end + 15 min` (§3.3). */
export const COMPLETE_AFTER_MS = 15 * 60_000;

/** §9.3 `batch.lookup`. */
export const LOOKUP_BATCH = Object.freeze({ size: 100, min: 10, max: 100, targetMs: 5000 });

const HOUR_MS = 3_600_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {import('../core/schema.mjs').ArchiveEvent} ArchiveEvent
 * @typedef {import('../core/schema.mjs').CandidateSeed} CandidateSeed
 * @typedef {import('../github/client.mjs').Client} Client
 * @typedef {import('../github/search.mjs').Ledger} Ledger
 */

/** The archive file could not be read (not yet published, network, corrupt). */
export class ArchiveError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number | null}} [opts]
   */
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = 'ArchiveError';
    this.code = 'EARCHIVE';
    this.status = status;
  }
}

/**
 * @param {string} date
 * @param {unknown} hour
 * @returns {number}
 */
function checkHour(date, hour) {
  if (typeof date !== 'string' || !DAY.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
    throw new RangeError(`A GH Archive date must look like 2026-09-10, got '${String(date).slice(0, 30)}'`);
  }
  const h = Number(hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) throw new RangeError('A GH Archive hour must be 0 to 23');
  return h;
}

/**
 * The file of one hour. Hours are not zero-padded: `2026-09-10-3`.
 * @param {string} date `YYYY-MM-DD`
 * @param {number | string} hour 0–23
 * @returns {string}
 */
export function hourUrl(date, hour) {
  return `${ARCHIVE_HOST}/${date}-${checkHour(date, hour)}.json.gz`;
}

/**
 * The `n` most recent complete hours at `now`, newest first.
 * @param {string | number | Date} now
 * @param {number} n
 * @returns {{date: string, hour: number}[]}
 */
export function completeHours(now, n) {
  const t = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : Date.parse(String(now));
  if (!Number.isFinite(t)) throw new RangeError('completeHours needs the current time');
  const count = Math.max(0, Math.floor(Number(n) || 0));
  const latest = Math.floor((t - HOUR_MS - COMPLETE_AFTER_MS) / HOUR_MS) * HOUR_MS;
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(latest - i * HOUR_MS);
    return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
  });
}

/**
 * @typedef {object} StreamStats
 * @property {number} lines non-empty lines read
 * @property {number} matched lines containing a wanted type
 * @property {number} bad matched lines that failed to parse (skipped)
 * @property {number} bytes decompressed bytes
 */

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbort(err) {
  return /** @type {any} */ (err)?.name === 'AbortError';
}

/**
 * Stream one GH Archive file and yield the parsed events of the wanted types. `types: null` parses
 * every line.
 * @param {string} url must be on data.gharchive.org
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetch] default `globalThis.fetch`
 * @param {readonly string[] | null} [opts.types] default Release and Public events
 * @param {Partial<StreamStats>} [opts.stats] filled in as the file is read
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.userAgent]
 * @returns {AsyncGenerator<any>}
 */
export async function* streamEvents(url, opts = {}) {
  const { fetch: fetchImpl = globalThis.fetch, types = ARCHIVE_TYPES, signal, userAgent } = opts;
  const stats = /** @type {StreamStats} */ (Object.assign(opts.stats ?? {}, {
    lines: 0, matched: 0, bad: 0, bytes: 0,
  }));
  if (typeof url !== 'string' || !url.startsWith(`${ARCHIVE_HOST}/`)) {
    throw new TypeError('GH Archive files are read only from https://data.gharchive.org/');
  }
  /** @type {Response} */
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'GET', headers: userAgent ? { 'user-agent': userAgent } : {}, signal,
    });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new ArchiveError(`Could not download ${url}: ${/** @type {Error} */ (err)?.message ?? err}`);
  }
  if (!res.ok) {
    await res.body?.cancel?.().catch(() => undefined);
    throw new ArchiveError(`GH Archive answered HTTP ${res.status} for ${url}`, { status: res.status });
  }
  if (!res.body) throw new ArchiveError(`GH Archive sent an empty body for ${url}`);
  const needles = types === null ? null : types.map((t) => `"type":"${t}"`);
  const body = /** @type {any} */ (res.body);
  const source = typeof body.getReader === 'function' ? Readable.fromWeb(body) : Readable.from(body);
  const gunzip = createGunzip();
  source.on('error', (err) => gunzip.destroy(err));
  source.pipe(gunzip);
  const decoder = new TextDecoder('utf-8');
  let carry = '';

  /**
   * @param {string[]} lines
   * @returns {any[]}
   */
  const parseLines = (lines) => {
    const out = [];
    for (let line of lines) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') continue;
      stats.lines++;
      if (needles && !needles.some((n) => line.includes(n))) continue;
      stats.matched++;
      try {
        out.push(JSON.parse(line));
      } catch {
        stats.bad++;
      }
    }
    return out;
  };

  try {
    for await (const chunk of gunzip) {
      stats.bytes += chunk.length;
      const text = carry + decoder.decode(chunk, { stream: true });
      // Split on "\n" only. String#split does not treat U+2028 or U+2029 as line breaks.
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const event of parseLines(lines)) yield event;
    }
    const tail = carry + decoder.decode();
    carry = '';
    for (const event of parseLines([tail])) yield event;
  } catch (err) {
    if (isAbort(err) || err instanceof ArchiveError) throw err;
    throw new ArchiveError(`Could not read ${url}: ${/** @type {Error} */ (err)?.message ?? err}`);
  } finally {
    source.destroy();
    gunzip.destroy();
  }
}

/**
 * The compact extract of one event (§3.3), or null for other types and malformed events.
 * @param {any} e
 * @returns {ArchiveEvent | null}
 */
export function extractEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const type = e.type;
  if (type !== 'ReleaseEvent' && type !== 'PublicEvent') return null;
  const repoId = e.repo?.id;
  const nwo = e.repo?.name;
  const actor = e.actor?.login;
  const at = e.created_at;
  if (!Number.isInteger(repoId) || typeof nwo !== 'string' || !nwo.includes('/')) return null;
  if (typeof actor !== 'string' || typeof at !== 'string') return null;
  const release = e.payload?.release;
  return {
    type,
    repoId,
    nwo,
    actor,
    at,
    tag: typeof release?.tag_name === 'string' ? release.tag_name : null,
    prerelease: typeof release?.prerelease === 'boolean' ? release.prerelease : null,
  };
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function recoverable(err) {
  const code = /** @type {any} */ (err)?.code;
  return code === 'EARCHIVE' || code === 'EHEAVY' || code === 'EGITHUB' || code === 'ENETWORK';
}

/**
 * @typedef {object} ArchiveStats
 * @property {number} lines
 * @property {number} bad
 * @property {number} events Release and Public events extracted
 * @property {number} prereleases ignored for seeding
 * @property {number} repos unique repositories looked up
 * @property {number} lookups GraphQL lookup queries
 * @property {number} gone `NOT_FOUND` aliases
 * @property {number} errors lookups that failed
 * @property {number} seeds
 */

/**
 * Process one GH Archive hour (§3.3): skip it if its unit `archive:<YYYY-MM-DD-H>` is done; stream
 * and extract its events; hand the extract to `writeExtract`; look up the repositories of
 * non-prerelease events (a Release beats a Public event for the same repository); yield their seeds
 * in arrays of at most 100; and mark the unit done when the consumer asks for more. A file or lookup
 * failure marks the unit failed (it is retried with back-off by a later run) and yields nothing.
 * @param {object} opts
 * @param {Client} opts.client
 * @param {string} opts.date `YYYY-MM-DD`
 * @param {number} opts.hour 0–23
 * @param {typeof fetch} [opts.fetch] plain fetch for data.gharchive.org (never carries the token)
 * @param {Ledger | null} [opts.ledger]
 * @param {((date: string, hour: number, events: ArchiveEvent[]) => unknown) | null} [opts.writeExtract]
 *   `store.writeArchiveExtract`
 * @param {{debug(msg: string, f?: object): void, warn(msg: string, f?: object): void} | null} [opts.log]
 * @param {string | null} [opts.runId]
 * @param {number} [opts.maxStars]
 * @param {{size: number, min: number, max: number, targetMs: number}} [opts.batch] default §9.3 lookup
 * @param {string} [opts.phase] budget phase (default `archive`)
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.userAgent]
 * @param {Partial<ArchiveStats>} [opts.stats]
 * @returns {AsyncGenerator<CandidateSeed[]>}
 */
export async function* archiveHour(opts) {
  const {
    client, date, fetch: fetchImpl = globalThis.fetch, ledger = null, writeExtract = null, log = null,
    runId = null, maxStars = DEFAULT_MAX_STARS, batch = LOOKUP_BATCH, phase = 'archive', signal, userAgent,
  } = opts;
  const hour = checkHour(date, opts.hour);
  const key = `archive:${date}-${hour}`;
  const url = hourUrl(date, hour);
  const stats = /** @type {ArchiveStats} */ (Object.assign(opts.stats ?? {}, {
    lines: 0, bad: 0, events: 0, prereleases: 0, repos: 0, lookups: 0, gone: 0, errors: 0, seeds: 0,
  }));
  if (ledger && typeof ledger.isDone === 'function' && await ledger.isDone(key)) {
    log?.debug('GH Archive hour already done', { key });
    return;
  }
  await ledger?.start?.(key, 'archive', runId);

  /** @type {CandidateSeed[]} */
  const seeds = [];
  try {
    /** @type {ArchiveEvent[]} */
    const events = [];
    /** @type {Partial<StreamStats>} */
    const streamStats = {};
    for await (const raw of streamEvents(url, { fetch: fetchImpl, stats: streamStats, signal, userAgent })) {
      const ev = extractEvent(raw);
      if (ev) events.push(ev);
    }
    stats.lines = streamStats.lines ?? 0;
    stats.bad = streamStats.bad ?? 0;
    stats.events = events.length;
    if (stats.bad > 0) log?.warn('Skipped GH Archive lines that did not parse', { key, lines: stats.bad });
    await writeExtract?.(date, hour, events);

    /** @type {Map<string, {nwo: string, kind: 'Release' | 'Public'}>} */
    const wanted = new Map();
    for (const ev of events) {
      if (ev.prerelease === true) {
        stats.prereleases++;
        continue;
      }
      const kind = ev.type === 'ReleaseEvent' ? 'Release' : 'Public';
      const k = ev.nwo.toLowerCase();
      const prev = wanted.get(k);
      if (!prev || (prev.kind === 'Public' && kind === 'Release')) wanted.set(k, { nwo: ev.nwo, kind });
    }
    const items = [...wanted.values()].filter((it) => {
      try {
        refOf(it.nwo);
        return true;
      } catch {
        return false;
      }
    });
    stats.repos = items.length;
    /** @type {Partial<import('../github/batch.mjs').BatchStats>} */
    const batchStats = {};
    const results = runBatched(items, {
      client,
      build: (chunk) => aliasedRepoQuery('Lean', LEAN_FRAGMENT, chunk.map((it) => it.nwo)),
      size: batch.size, min: batch.min, max: batch.max, targetMs: batch.targetMs,
      phase, signal, stats: batchStats,
    });
    for await (const r of results) {
      if (r.error) {
        stats.errors++;
        continue;
      }
      if (!r.value) {
        stats.gone++;
        continue;
      }
      /** @type {CandidateSeed} */
      let seed;
      try {
        seed = seedFromNode(r.value, `archive:${date}-${hour}:${r.item.kind}`);
      } catch {
        stats.errors++;
        continue;
      }
      if (passesBase(seed, { maxStars })) seeds.push(seed);
    }
    stats.lookups = batchStats.calls ?? 0;
    if (items.length > 0 && stats.errors >= items.length) {
      throw new ArchiveError(`Every repository lookup for ${key} failed`);
    }
  } catch (err) {
    if (!recoverable(err)) throw err;
    const e = /** @type {any} */ (err);
    await ledger?.fail?.(key, {
      name: String(e?.name), code: e?.code ?? null, message: String(e?.message ?? err),
    });
    log?.warn('GH Archive hour failed; it will be retried on a later run', { key, error: err });
    return;
  }
  stats.seeds = seeds.length;
  for (let i = 0; i < seeds.length; i += 100) yield seeds.slice(i, i + 100);
  await ledger?.done?.(key, {
    events: stats.events, lookups: stats.lookups, seeds: stats.seeds, gone: stats.gone, bad: stats.bad,
    errors: stats.errors,
  });
}
