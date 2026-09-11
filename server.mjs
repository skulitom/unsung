#!/usr/bin/env node
// @ts-check
/**
 * The explorer's local server (DESIGN §10.1). It binds 127.0.0.1 only, serves `web/` and the pure
 * `src/core/` modules read-only, and answers a small JSON API over the store. Guards: the Host
 * header must name this server (against DNS rebinding); a POST needs JSON, the `x-unsung: 1` header
 * and, when the browser sends one, an Origin equal to the server's; bodies are capped at 64 KB;
 * static paths are resolved and prefix-checked (no traversal, no listings); and every response
 * carries the §10.1 security headers. The server never runs the census.
 *
 * Before any run (no `data/index.json`) it shows the seed examples from `test/fixtures/` (§9.2) and
 * marks the index `examples: true`, so the page can say so; decisions on them stay in the browser.
 */

import http from 'node:http';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import { loadConfig } from './src/config.mjs';
import { createLog } from './src/log.mjs';
import { redact, registerSecret } from './src/secrets.mjs';
import { labelFromFeedback, validateFeedback } from './src/core/schema.mjs';
import { fnv1a, mulberry32, sampleN } from './src/core/util.mjs';
import { activeFeedback, emptyTaste, pinsOf, rebuildTaste, setPin } from './src/core/taste.mjs';
import {
  SNOOZE_DAYS, blindItem, foldFeedback, isNwo, labelledIds, lastAction, overlayFeedback, plusDays,
} from './src/core/views.mjs';

/** @typedef {import('./src/config.mjs').Config} Config */
/** @typedef {import('./src/log.mjs').Log} Log */
/** @typedef {import('./src/core/schema.mjs').Index} Index */
/** @typedef {import('./src/core/schema.mjs').IndexEntry} IndexEntry */
/** @typedef {import('./src/core/schema.mjs').Feedback} Feedback */
/** @typedef {import('./src/core/schema.mjs').RepoRecord} RepoRecord */
/** @typedef {import('./src/core/schema.mjs').TasteState} TasteState */
/** @typedef {any} Store the `Store` interface of src/store/store.mjs (§12.3) */

/** The package root (the directory holding this file). */
export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The Content-Security-Policy of §10.1, exactly. */
export const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');

/** Headers on every response: the three of §10.1, and three that only tighten them. */
export const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
});

/** Largest request body accepted (§10.1). */
export const BODY_LIMIT = 64 * 1024;

/** Port when neither `--port` nor `config/defaults.json` says otherwise (§9.3). */
export const DEFAULT_PORT = 8750;

/** A lock older than this is stale (§3.12). */
export const LOCK_STALE_MS = 6 * 60 * 60 * 1000;

/** Most blind items one Calibrate request returns. */
const CALIBRATE_MAX = 50;

/**
 * How many items `/api/calibrate` has handed out are remembered, so that a blind label on one is
 * known even if its record is renamed or compacted before the label arrives (§10.1).
 */
const CALIBRATE_REMEMBER = 1000;

/** Content types of the files the server will serve; anything else is a 404. */
const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
});

/** API paths and the methods they answer; `/api/repo/:owner/:name` is matched separately. */
const API_ROUTES = Object.freeze({
  '/api/index': ['GET'],
  '/api/model': ['GET'],
  '/api/taste': ['GET', 'POST'],
  '/api/status': ['GET'],
  '/api/calibrate': ['GET'],
  '/api/feedback': ['POST'],
  '/api/add': ['POST'],
});

const EXAMPLES_ONLY = 'The explorer is showing the examples: decisions on them stay in your browser, '
  + 'not in data/';
const NO_STORE = 'The store is not available yet, so nothing can be saved';
const UNIT_STATES = Object.freeze(['planned', 'running', 'done', 'failed']);

/** An HTTP error answer: `{error, ...extra}` with the given status. */
export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   * @param {Record<string, unknown>} [extra] more fields for the JSON body
   * @param {Record<string, string>} [headers]
   */
  constructor(status, message, extra = {}, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.code = 'EHTTP';
    this.status = status;
    this.extra = extra;
    this.headers = headers;
  }
}

/** The port is taken; the CLI exits 2. */
export class PortError extends Error {
  /** @param {number} port */
  constructor(port) {
    super(`Port ${port} is already in use: stop the other explorer, or pass --port with another number`);
    this.name = 'PortError';
    this.code = 'EPORT';
    this.exitCode = 2;
  }
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

/**
 * Whether a socket address is this computer (IPv4 127/8, IPv6 ::1, or IPv4-mapped loopback).
 * @param {unknown} address
 * @returns {boolean}
 */
export function isLoopback(address) {
  if (typeof address !== 'string') return false;
  const a = address.replace(/^::ffff:/i, '');
  return a === '::1' || /^127(\.\d{1,3}){3}$/.test(a);
}

/**
 * Whether a Host header names this server: `127.0.0.1:<port>` or `localhost:<port>` (§10.1).
 * @param {unknown} host
 * @param {number | null | undefined} port
 * @returns {boolean}
 */
export function hostAllowed(host, port) {
  if (typeof host !== 'string' || !Number.isInteger(port)) return false;
  const h = host.trim().toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  return redact(err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/**
 * Every item of an array, an iterable or an async iterable (the store may return any of them).
 * @param {unknown} source
 * @returns {AsyncGenerator<any>}
 */
async function* iterate(source) {
  const s = /** @type {any} */ (await source);
  if (!s) return;
  if (typeof s[Symbol.asyncIterator] === 'function' || typeof s[Symbol.iterator] === 'function') {
    for await (const v of s) yield v;
  }
}

/**
 * @param {unknown} source
 * @returns {Promise<any[]>}
 */
async function collect(source) {
  const out = [];
  for await (const v of iterate(source)) out.push(v);
  return out;
}

/**
 * @param {string} text
 * @returns {any[]}
 */
function parseJsonl(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A crash can leave a partial last line (§4.1).
    }
  }
  return out;
}

/**
 * @param {string} text
 * @returns {any}
 */
function parseJson(text) {
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/**
 * @param {unknown} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || /** @type {number} */ (pid) <= 0) return false;
  try {
    process.kill(/** @type {number} */ (pid), 0);
    return true;
  } catch (err) {
    return /** @type {{code?: string}} */ (err)?.code === 'EPERM';
  }
}

/**
 * Whether a repository record is quarantined (§6.7 rule 1).
 * @param {any} record
 * @returns {boolean}
 */
function isQuarantined(record) {
  if (!record) return false;
  if (record.quarantined === true || record.lane === 'quarantine') return true;
  if (record.score?.lane === 'quarantine') return true;
  const gates = Array.isArray(record.score?.gates) ? record.score.gates : [];
  return gates.some((/** @type {any} */ g) => g?.action === 'quarantine');
}

/**
 * What the explorer may know of a quarantined repository: identity, lane and gate reasons (§7.6).
 * @param {{id: string, nwo: string, gates?: unknown[], score?: any, checkedAt?: unknown,
 *   gone?: unknown}} source
 * @returns {Record<string, unknown>}
 */
function quarantinedView(source) {
  const scoreGates = Array.isArray(source.score?.gates) ? source.score.gates : null;
  const gates = scoreGates ?? (Array.isArray(source.gates) ? source.gates : []);
  /** @param {any} g */
  const gateView = (g) => (typeof g === 'string' ? { id: g, action: 'quarantine', reason: '' } : {
    id: String(g?.id ?? ''), action: String(g?.action ?? 'quarantine'), reason: String(g?.reason ?? ''),
  });
  return {
    v: 1, id: source.id, nwo: source.nwo, quarantined: true, lane: 'quarantine',
    gates: gates.map(gateView),
    checkedAt: typeof source.checkedAt === 'string' ? source.checkedAt : null,
    gone: source.gone === true,
  };
}

/**
 * Facts for the detail pane from a recorded enrich node and the deep files (the examples, §9.2).
 * Only what the explorer displays; scores for the examples come from the index sample.
 * @param {string} nwo
 * @param {any} node a §3.5 enrich node
 * @param {{deep?: any, tree?: any, stars?: any, fetchedAt?: string}} [extra]
 * @returns {Record<string, unknown>}
 */
export function displayFacts(nwo, node, extra = {}) {
  const n = isObj(node) ? node : {};
  const [owner, name] = nwo.split('/');
  const target = n.defaultBranchRef?.target;
  const history = target?.history;
  const tree = isObj(extra.tree) && Array.isArray(extra.tree.tree) ? extra.tree : null;
  const deep = isObj(extra.deep) ? extra.deep : null;
  const weeks = Array.isArray(extra.stars) ? extra.stars.slice().reverse().map((w) => ({
    week: new Date(Number(w?.week) * 1000).toISOString().slice(0, 10), gained: Number(w?.total) || 0,
  })) : null;
  /** @param {unknown} v */
  const orNull = (v) => (v === undefined ? null : v);
  return {
    v: 1, id: String(n.id ?? ''), nwo, owner, name, fetchedAt: extra.fetchedAt ?? '', source: 'fixture',
    stages: tree ? ['enrich', 'deep'] : ['enrich'],
    headOid: orNull(target?.oid), defaultBranch: orNull(n.defaultBranchRef?.name),
    createdAt: orNull(n.createdAt), pushedAt: orNull(n.pushedAt), description: orNull(n.description),
    homepageUrl: n.homepageUrl || null,
    isFork: orNull(n.isFork), isArchived: orNull(n.isArchived), isTemplate: orNull(n.isTemplate),
    isMirror: orNull(n.isMirror), hasIssues: orNull(n.hasIssuesEnabled),
    hasDiscussions: orNull(n.hasDiscussionsEnabled),
    stars: orNull(n.stargazerCount), forks: orNull(n.forkCount), watchers: orNull(n.watchers?.totalCount),
    diskKB: orNull(n.diskUsage), licence: orNull(n.licenseInfo?.spdxId),
    primaryLanguage: orNull(n.primaryLanguage?.name),
    languages: Array.isArray(n.languages?.edges)
      ? n.languages.edges.map((/** @type {any} */ e) => ({
        name: String(e?.node?.name ?? ''), bytes: Number(e?.size) || 0,
      }))
      : null,
    codeBytes: orNull(n.languages?.totalSize),
    topics: Array.isArray(n.repositoryTopics?.nodes)
      ? n.repositoryTopics.nodes.map((/** @type {any} */ t) => t?.topic?.name).filter(Boolean) : null,
    releases: isObj(n.releases) ? {
      count: Number(n.releases.totalCount) || 0,
      recent: (Array.isArray(n.releases.nodes) ? n.releases.nodes : []).map((/** @type {any} */ r) => ({
        tag: String(r?.tagName ?? ''), publishedAt: orNull(r?.publishedAt),
        prerelease: orNull(r?.isPrerelease),
      })),
    } : null,
    tags: orNull(n.tags?.totalCount),
    ownerInfo: isObj(n.owner) ? {
      login: String(n.owner.login ?? owner), type: String(n.owner.__typename ?? ''),
      createdAt: orNull(n.owner.createdAt),
      publicRepos: orNull(n.owner.repositories?.totalCount),
      contributionYears: orNull(deep?.owner?.contributionsCollection?.contributionYears),
      sponsorsListing: orNull(deep?.owner?.hasSponsorsListing),
    } : null,
    commits: isObj(history) ? {
      total: orNull(history.totalCount),
      recent: (Array.isArray(history.nodes) ? history.nodes : []).slice(0, 20)
        .map((/** @type {any} */ c) => ({
          at: orNull(c?.committedDate), headline: orNull(c?.messageHeadline),
          authorLogin: orNull(c?.author?.user?.login),
        })),
    } : null,
    rollup: orNull(target?.statusCheckRollup?.state),
    root: Array.isArray(n.root?.entries)
      ? n.root.entries.map((/** @type {any} */ e) => ({
        name: String(e?.name ?? ''), type: String(e?.type ?? ''),
      })) : null,
    workflows: Array.isArray(n.wf?.entries)
      ? n.wf.entries.map((/** @type {any} */ e) => ({ name: String(e?.name ?? ''), text: null })) : null,
    readme: isObj(n.readme) ? {
      name: String(n.readme.name ?? 'README.md'), bytes: Number(n.readme.byteSize) || 0,
      truncated: Boolean(n.readme.isTruncated),
      text: typeof n.readme.text === 'string' ? n.readme.text : null,
    } : null,
    packageJson: null, manifest: null, agentsMdBytes: null, claudeMdBytes: null,
    tree: tree ? {
      truncated: Boolean(tree.truncated), count: tree.tree.length,
      entries: tree.tree.map((/** @type {any} */ t) => [
        String(t?.path ?? ''), String(t?.type ?? ''), t?.size ?? null,
      ]),
    } : null,
    activity: null,
    starHistory: weeks ? { weeks, gain4w: weeks.slice(-4).reduce((s, w) => s + w.gained, 0) } : null,
    outsiders: null,
    funding: Array.isArray(deep?.fundingLinks)
      ? deep.fundingLinks.map((/** @type {any} */ f) => ({
        platform: String(f?.platform ?? ''), url: String(f?.url ?? ''),
      }))
      : null,
    heavy: false,
  };
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} ServerOptions
 * @property {string} dataDir
 * @property {Config | null} [config] null while the configuration is incomplete (the index's model is used)
 * @property {((dir: string, opts: {now: () => string, log: Log}) => any) | null} [openStore]
 *   `openStore` of src/store/store.mjs; may resolve to null when the store is not available
 * @property {((nwo: string, deps: Record<string, unknown>) => Promise<RepoRecord>) | null} [addRepo]
 * @property {(() => Promise<any>) | null} [getClient] the read-only GitHub client, for `POST /api/add`
 * @property {() => string} [now] ISO time
 * @property {Log} [log]
 * @property {string} [webDir]
 * @property {string} [coreDir]
 * @property {string | null} [examplesIndex] the Index shown before any run
 * @property {string | null} [examplesRepos] fixture directories behind the examples' detail panes
 */

/**
 * Create the explorer server (not yet listening). Routes and guards are those of §10.1, plus
 * `POST /api/taste` to pin, mute or reset a facet.
 * @param {ServerOptions} opts
 * @returns {http.Server}
 */
export function createServer(opts) {
  const dataDir = path.resolve(opts.dataDir);
  const config = opts.config ?? null;
  const openStore = opts.openStore ?? null;
  const addRepo = opts.addRepo ?? null;
  const getClient = opts.getClient ?? null;
  const now = opts.now ?? (() => new Date().toISOString());
  const log = opts.log ?? createLog({ level: 'warn' });
  const webDir = path.resolve(opts.webDir ?? path.join(ROOT, 'web'));
  const coreDir = path.resolve(opts.coreDir ?? path.join(ROOT, 'src', 'core'));
  const examplesIndex = opts.examplesIndex === undefined
    ? path.join(ROOT, 'test', 'fixtures', 'index.sample.json') : opts.examplesIndex;
  const examplesRepos = opts.examplesRepos === undefined
    ? path.join(ROOT, 'test', 'fixtures', 'repos') : opts.examplesRepos;

  /** @type {Promise<Store | null> | null} */
  let storePromise = null;
  /** @type {{stamp: string, index: Index, examples: boolean} | null} */
  let indexCache = null;
  /** @type {{stamp: string, events: Feedback[]} | null} */
  let feedbackCache = null;
  /**
   * @type {{key: string, body: Buffer, gz: Buffer | null, etag: string, examples: boolean,
   *   entries: IndexEntry[], byId: Map<string, IndexEntry>, model: any} | null}
   */
  let viewCache = null;
  let chain = Promise.resolve();
  let lastAt = 0;
  let adding = false;
  /**
   * Items `/api/calibrate` has handed out: id → lower-case nwo, oldest first.
   * @type {Map<string, string>}
   */
  const calibrateServed = new Map();

  /**
   * Remember the blind items `/api/calibrate` hands out (at most `CALIBRATE_REMEMBER`, the oldest
   * forgotten first), so a label on one is known even if its record moves or goes before it arrives.
   * @param {{id: string, nwo: string}[]} items
   */
  function rememberServed(items) {
    for (const it of items) {
      calibrateServed.delete(it.id);
      calibrateServed.set(it.id, String(it.nwo).toLowerCase());
    }
    for (const id of calibrateServed.keys()) {
      if (calibrateServed.size <= CALIBRATE_REMEMBER) break;
      calibrateServed.delete(id);
    }
  }

  /**
   * Whether a feedback event's `id` and `nwo` together name a repository this server knows (§10.1):
   * an entry of the index it serves (the examples' index included), a stored RepoRecord, for action
   * `undo` the logged decision it takes back (accepted earlier, so still known when its record has
   * gone or moved since, as a blind label on a Calibrate draw may; whether that decision is still in
   * force is `checkDecision`'s 409), or — for action `label` only — an item `/api/calibrate` has
   * handed out. Names compare without case.
   * @param {Feedback} ev
   * @param {Map<string, IndexEntry>} byId the served index's entries
   * @param {Store | null} store
   * @param {Feedback[]} events the feedback log, for an undo
   * @returns {Promise<boolean>}
   */
  async function knownTarget(ev, byId, store, events) {
    const nwo = String(ev.nwo).toLowerCase();
    /** @param {{id?: unknown, nwo?: unknown} | null | undefined} x */
    const names = (x) => !!x && x.id === ev.id && typeof x.nwo === 'string' && x.nwo.toLowerCase() === nwo;
    if (names(byId.get(ev.id))) return true;
    if (typeof store?.getRepo === 'function' && names(await store.getRepo(ev.nwo))) return true;
    if (typeof store?.getRepoById === 'function' && names(await store.getRepoById(ev.id))) return true;
    if (ev.action === 'undo' && events.some((x) => x.at === ev.undoes && names(x))) return true;
    return ev.action === 'label' && calibrateServed.get(ev.id) === nwo;
  }

  /** @returns {Promise<Store | null>} */
  function getStore() {
    if (!openStore) return Promise.resolve(null);
    storePromise ??= Promise.resolve()
      .then(() => openStore(dataDir, { now, log }))
      .then((s) => s ?? null)
      .catch((err) => {
        log.warn(`The store could not be opened: ${messageOf(err)}`);
        storePromise = null;
        return null;
      });
    return storePromise;
  }

  /**
   * Run write handlers one at a time.
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function serial(fn) {
    const run = chain.then(fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** @returns {string} the current time, later than any time already issued */
  function stampNow() {
    let t = Date.parse(now());
    if (!Number.isFinite(t)) t = 0;
    if (t <= lastAt) t = lastAt + 1;
    lastAt = t;
    return new Date(t).toISOString();
  }

  /**
   * @param {string} file
   * @returns {Promise<string | null>} `mtime:size`, or null when there is no such file
   */
  async function stampOf(file) {
    try {
      const st = await stat(file);
      return st.isFile() ? `${st.mtimeMs}:${st.size}` : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<{stamp: string, index: Index, examples: boolean}>} */
  async function currentIndex() {
    const file = path.join(dataDir, 'index.json');
    const stamp = await stampOf(file);
    if (stamp !== null) {
      if (indexCache && indexCache.stamp === stamp) return indexCache;
      /** @type {any} */
      let index = null;
      const store = await getStore();
      try {
        index = typeof store?.readIndex === 'function' ? await store.readIndex() : null;
      } catch (err) {
        log.warn(`The store could not read the index: ${messageOf(err)}`);
      }
      if (!index) index = parseJson(await readFile(file, 'utf8'));
      if (!index || !Array.isArray(index.entries)) throw new HttpError(500, 'data/index.json is malformed');
      indexCache = { stamp, index, examples: false };
      return indexCache;
    }
    if (indexCache?.examples) return indexCache;
    /** @type {any} */
    let index = null;
    try {
      index = examplesIndex ? parseJson(await readFile(examplesIndex, 'utf8')) : null;
    } catch {
      index = null;
    }
    if (!index || !Array.isArray(index.entries)) {
      index = {
        v: 1, generatedAt: now(), model: { weights: null, calibration: null }, counts: {}, lastRun: null,
        entries: [],
      };
    }
    indexCache = { stamp: 'examples', index, examples: true };
    return indexCache;
  }

  /** @returns {Promise<{stamp: string, events: Feedback[]}>} */
  async function currentFeedback() {
    const file = path.join(dataDir, 'feedback.jsonl');
    const stamp = (await stampOf(file)) ?? 'none';
    if (feedbackCache && feedbackCache.stamp === stamp) return feedbackCache;
    /** @type {Feedback[]} */
    let events = [];
    const store = await getStore();
    if (typeof store?.readFeedback === 'function') events = await collect(store.readFeedback());
    else if (stamp !== 'none') events = parseJsonl(await readFile(file, 'utf8'));
    feedbackCache = { stamp, events };
    return feedbackCache;
  }

  /** The index as served: feedback laid over the entries, serialised once per change. */
  async function indexView() {
    const idx = await currentIndex();
    const fb = idx.examples ? { stamp: 'examples', events: [] } : await currentFeedback();
    const key = `${idx.stamp}|${fb.stamp}|${fb.events.length}`;
    if (viewCache && viewCache.key === key) return viewCache;
    const entries = idx.examples
      ? idx.index.entries : overlayFeedback(idx.index.entries, foldFeedback(fb.events));
    const served = idx.examples ? { ...idx.index, examples: true } : { ...idx.index, entries };
    const body = Buffer.from(JSON.stringify(served));
    viewCache = {
      key, body, gz: null, etag: `"${createHash('sha1').update(body).digest('hex').slice(0, 24)}"`,
      examples: idx.examples, entries, byId: new Map(entries.map((e) => [e.id, e])),
      model: idx.index.model ?? null,
    };
    return viewCache;
  }

  /** @returns {Promise<Record<string, unknown> | null>} data/.lock, and whether it is live (§3.12) */
  async function readLock() {
    try {
      const lock = parseJson(await readFile(path.join(dataDir, '.lock'), 'utf8'));
      const started = Date.parse(lock?.startedAt);
      const fresh = Number.isFinite(started) && Date.parse(now()) - started < LOCK_STALE_MS;
      return {
        pid: Number.isInteger(lock?.pid) ? lock.pid : null,
        runId: typeof lock?.runId === 'string' ? lock.runId : null,
        startedAt: typeof lock?.startedAt === 'string' ? lock.startedAt : null,
        live: fresh && pidAlive(lock?.pid),
      };
    } catch {
      return null;
    }
  }

  /**
   * @param {string} nwo
   * @returns {Promise<string | null>} the fixture directory of an example, matched without case
   */
  async function fixtureDir(nwo) {
    if (!examplesRepos) return null;
    const want = nwo.replace('/', '__').toLowerCase();
    try {
      const hit = (await readdir(examplesRepos)).find((d) => d.toLowerCase() === want);
      return hit ? path.join(examplesRepos, hit) : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} dir
   * @param {string} name
   * @returns {Promise<any>}
   */
  async function readFixture(dir, name) {
    try {
      return parseJson(await readFile(path.join(dir, `${name}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  /**
   * @param {IndexEntry} entry
   * @returns {Promise<Record<string, unknown> | null>} display facts for an example, or null
   */
  async function exampleFacts(entry) {
    const dir = await fixtureDir(entry.nwo);
    if (!dir) return null;
    const [meta, enrich, deep, tree, stars] = await Promise.all(
      ['meta', 'enrich', 'deep', 'tree', 'stars'].map((f) => readFixture(dir, f)));
    if (!enrich) return null;
    const fetchedAt = typeof meta?.recordedAt === 'string' ? meta.recordedAt : '';
    return displayFacts(entry.nwo, { ...enrich, id: entry.id }, { deep, tree, stars, fetchedAt });
  }

  /**
   * @param {string} nwo
   * @param {Awaited<ReturnType<typeof indexView>>} view
   * @returns {Promise<Record<string, unknown> | null>}
   */
  async function exampleRecord(nwo, view) {
    const entry = view.entries.find((e) => e.nwo.toLowerCase() === nwo.toLowerCase());
    if (!entry) return null;
    if (entry.lane === 'quarantine') return quarantinedView(entry);
    const facts = await exampleFacts(entry);
    if (!facts) return null;
    return {
      v: 1, id: entry.id, nwo: entry.nwo, candidate: null, facts, score: null, firstSeen: null, history: [],
      verdict: null, checkedAt: null, gone: false, example: true,
    };
  }

  // --- GET handlers ---------------------------------------------------------------------------

  /**
   * @param {string} ownerRaw
   * @param {string} nameRaw
   * @returns {Promise<unknown>}
   */
  async function getRepo(ownerRaw, nameRaw) {
    let nwo;
    try {
      nwo = `${decodeURIComponent(ownerRaw)}/${decodeURIComponent(nameRaw)}`;
    } catch {
      throw new HttpError(400, 'Bad repository name');
    }
    if (!isNwo(nwo)) throw new HttpError(400, 'Write the repository as owner/name');
    const view = await indexView();
    const store = view.examples ? null : await getStore();
    /** @type {any} */
    let record = null;
    if (typeof store?.getRepo === 'function') record = await store.getRepo(nwo);
    if (!record && view.examples) record = await exampleRecord(nwo, view);
    if (!record) throw new HttpError(404, `There is no record for ${nwo}`);
    const entry = view.byId.get(record.id);
    if (isQuarantined(record) || entry?.lane === 'quarantine') {
      return quarantinedView({ ...record, gates: record.score?.gates ?? entry?.gates });
    }
    return record;
  }

  async function getModel() {
    if (config?.weights && config?.calibration) {
      return { weights: config.weights, calibration: config.calibration };
    }
    const view = await indexView();
    return { weights: view.model?.weights ?? null, calibration: view.model?.calibration ?? null };
  }

  /** @returns {Promise<TasteState>} */
  async function getTaste() {
    const view = await indexView();
    if (view.examples) return emptyTaste();
    const store = await getStore();
    /** @type {TasteState | null} */
    let taste = null;
    try {
      taste = typeof store?.readTaste === 'function' ? await store.readTaste() : null;
    } catch (err) {
      log.warn(`The store could not read taste.json: ${messageOf(err)}`);
    }
    if (taste) return taste;
    const fb = await currentFeedback();
    return rebuildTaste(fb.events, view.byId);
  }

  async function getStatus() {
    const view = await indexView();
    const store = view.examples && (await stampOf(path.join(dataDir, 'STORE_VERSION'))) === null
      ? null : await getStore();
    /** @type {any[]} */
    let runs = [];
    try {
      if (typeof store?.lastRuns === 'function') runs = await collect(store.lastRuns(5));
    } catch (err) {
      log.warn(`The store could not list the runs: ${messageOf(err)}`);
    }
    // The examples' index carries the fixture's run; it is not a run of this store, so it is not
    // listed (the Status screen says there are no runs yet).
    /** @type {Record<string, number>} */
    const units = {};
    if (typeof store?.ledger?.list === 'function') {
      for (const state of UNIT_STATES) {
        try {
          const n = (await collect(store.ledger.list({ state }))).length;
          if (n > 0) units[state] = n;
        } catch {
          // A ledger that cannot list by state reports nothing.
        }
      }
    }
    return {
      runs: runs.slice(0, 5), units, lock: await readLock(), rate: runs[0]?.rate ?? null,
      examples: view.examples,
      store: Boolean(store), canAdd: Boolean(addRepo && getClient && openStore),
      generatedAt: indexCache?.index.generatedAt ?? null, entries: view.entries.length,
    };
  }

  /**
   * @param {URLSearchParams} params
   * @returns {Promise<{items: unknown[], seed: number, examples?: boolean}>}
   */
  async function getCalibrate(params) {
    const nRaw = Number(params.get('n') ?? 20);
    const n = Number.isFinite(nRaw) ? Math.min(CALIBRATE_MAX, Math.max(1, Math.floor(nRaw))) : 20;
    const seedRaw = Number(params.get('seed'));
    const seed = params.has('seed') && Number.isInteger(seedRaw) ? seedRaw : fnv1a(now().slice(0, 10));
    const rand = mulberry32(seed);
    const view = await indexView();
    if (view.examples) {
      const pool = view.entries.filter((e) => e.lane !== 'quarantine');
      const items = [];
      for (const entry of sampleN(pool, pool.length, rand)) {
        if (items.length >= n) break;
        const facts = await exampleFacts(entry);
        if (facts) items.push(blindItem({ id: entry.id, nwo: entry.nwo, facts }, 'pool'));
      }
      rememberServed(items);
      return { items, seed, examples: true };
    }
    const store = await getStore();
    if (typeof store?.listRepos !== 'function') return { items: [], seed };
    const labelled = labelledIds((await currentFeedback()).events);
    /** @type {{nwo: string, seenAt: string}[]} */
    const sample = [];
    /** @type {string[]} */
    const pool = [];
    for await (const rec of iterate(store.listRepos())) {
      if (!rec || rec.gone || !rec.facts || labelled.has(rec.id) || isQuarantined(rec)) continue;
      if (view.byId.get(rec.id)?.lane === 'quarantine') continue;
      const sources = Array.isArray(rec.candidate?.sources) ? rec.candidate.sources : [];
      if (sources.some((/** @type {unknown} */ s) => s === 'sample' || String(s).startsWith('sample:'))) {
        sample.push({ nwo: rec.nwo, seenAt: String(rec.candidate?.seenAt ?? '') });
      } else pool.push(rec.nwo);
    }
    sample.sort((a, b) => (a.seenAt < b.seenAt ? 1 : a.seenAt > b.seenAt ? -1 : 0));
    const picks = [
      ...sample.slice(0, n).map((s) => ({ nwo: s.nwo, stratum: /** @type {const} */ ('sample') })),
      ...sampleN(pool, Math.max(0, n - Math.min(n, sample.length)), rand)
        .map((nwo) => ({ nwo, stratum: /** @type {const} */ ('pool') })),
    ];
    const items = [];
    for (const pick of picks) {
      const rec = await store.getRepo(pick.nwo);
      if (rec?.facts) items.push(blindItem(rec, pick.stratum));
    }
    rememberServed(items);
    return { items, seed };
  }

  // --- POST handlers --------------------------------------------------------------------------

  /**
   * Refuse decisions that make no sense: an undo of nothing, publishing what is not a saved gem, or
   * triaging a quarantined repository (§7.6: it is shown, never triaged; an undo or an unpublish
   * that tidies up an earlier decision is still accepted).
   * @param {Feedback} ev
   * @param {Feedback[]} events
   * @param {IndexEntry | undefined} entry
   */
  function checkDecision(ev, events, entry) {
    if (ev.action === 'undo' && !activeFeedback(events).some((x) => x.id === ev.id && x.at === ev.undoes)) {
      throw new HttpError(409, 'There is no standing decision at that time to undo');
    }
    if (entry?.lane === 'quarantine' && ev.action !== 'undo' && ev.action !== 'unpublish') {
      throw new HttpError(409, ev.action === 'publish' ? 'A quarantined repository is never published'
        : 'Quarantined repositories are shown, never triaged');
    }
    if (ev.action === 'publish') {
      if (lastAction(foldFeedback(events)[ev.id]) !== 'gem') {
        throw new HttpError(409, 'Only a saved gem can be published: save it with g first');
      }
    }
  }

  /**
   * @param {Record<string, any>} body
   * @param {string} at
   * @returns {Feedback}
   */
  function feedbackFrom(body, at) {
    const context = isObj(body.context) ? Object.fromEntries(Object.entries(body.context).filter(([k]) => [
      'view', 'position', 'S', 'quality', 'gem', 'k', 'stars', 'weights', 'calibration', 'stratum',
    ].includes(k))) : null;
    /** @type {any} */
    const ev = {
      v: 1, at, id: body.id, nwo: body.nwo, action: body.action, label: null, reason: body.reason ?? null,
      note: body.note ?? '', blind: body.blind ?? false, undoes: body.undoes ?? null,
      snoozeUntil: body.snoozeUntil ?? null, context,
    };
    ev.label = ev.action === 'label' ? body.label ?? null : labelFromFeedback(ev);
    if ((ev.action === 'wip' || ev.action === 'snooze') && !ev.snoozeUntil) {
      ev.snoozeUntil = plusDays(at, SNOOZE_DAYS);
    }
    return ev;
  }

  /**
   * @param {unknown} body
   * @returns {Promise<{taste: TasteState, entry: IndexEntry | null, event: Feedback}>}
   */
  async function postFeedback(body) {
    if (!isObj(body)) throw new HttpError(400, 'Send one feedback object');
    const view = await indexView();
    if (view.examples) throw new HttpError(409, EXAMPLES_ONLY);
    const store = await getStore();
    if (typeof store?.appendFeedback !== 'function') throw new HttpError(503, NO_STORE);
    return serial(async () => {
      const fb = await currentFeedback();
      const ev = feedbackFrom(body, stampNow());
      const problems = validateFeedback(ev);
      if (problems.length > 0) {
        throw new HttpError(400, `That feedback is not valid: ${problems[0]}`, { problems });
      }
      if (!(await knownTarget(ev, view.byId, store, fb.events))) {
        const from = ev.action === 'label' ? 'the index, the store or a Calibrate draw'
          : ev.action === 'undo' ? 'the index, the store or the decision it undoes'
            : 'the index or the store';
        throw new HttpError(422, `Unsung does not know ${String(ev.nwo).slice(0, 120)} with that id: `
          + `feedback must name a repository from ${from}, so nothing was saved`);
      }
      checkDecision(ev, fb.events, view.byId.get(ev.id));
      await store.appendFeedback(ev);
      const events = [...fb.events, ev];
      feedbackCache = { stamp: (await stampOf(path.join(dataDir, 'feedback.jsonl'))) ?? 'none', events };
      viewCache = null;
      /** @type {TasteState | null} */
      let before = null;
      try {
        before = typeof store.readTaste === 'function' ? await store.readTaste() : null;
      } catch {
        before = null;
      }
      const taste = rebuildTaste(events, view.byId, { pins: pinsOf(before), updatedAt: ev.at });
      if (typeof store.writeTaste === 'function') await store.writeTaste(taste);
      const base = view.byId.get(ev.id);
      const fold = foldFeedback(events);
      const entry = base
        ? { ...base, feedback: fold[ev.id] ?? { last: null, published: false, snoozeUntil: null } } : null;
      return { taste, entry, event: ev };
    });
  }

  /**
   * Pin (1), mute (−1) or reset (0) one taste facet (§10.2 Taste).
   * @param {unknown} body
   * @returns {Promise<{taste: TasteState}>}
   */
  async function postTaste(body) {
    const facet = isObj(body) && typeof body.facet === 'string' ? body.facet.trim().toLowerCase() : '';
    const pin = isObj(body) ? body.pin : undefined;
    if (!/^[a-z]+:\S{1,80}$/.test(facet) || ![1, 0, -1].includes(pin)) {
      throw new HttpError(400, 'Send {facet, pin} with pin 1 (pin), -1 (mute) or 0 (reset)');
    }
    const view = await indexView();
    if (view.examples) throw new HttpError(409, EXAMPLES_ONLY);
    const store = await getStore();
    if (typeof store?.writeTaste !== 'function') throw new HttpError(503, NO_STORE);
    return serial(async () => {
      /** @type {TasteState | null} */
      let taste = null;
      try {
        taste = typeof store.readTaste === 'function' ? await store.readTaste() : null;
      } catch {
        taste = null;
      }
      taste ??= rebuildTaste((await currentFeedback()).events, view.byId);
      const next = setPin(taste, facet, /** @type {-1 | 0 | 1} */ (pin), stampNow());
      await store.writeTaste(next);
      return { taste: next };
    });
  }

  /**
   * Add a repository now (§10.1): 409 while a run holds the lock.
   * @param {unknown} body
   * @returns {Promise<{record: unknown}>}
   */
  async function postAdd(body) {
    const raw = isObj(body) && typeof body.nwo === 'string' ? body.nwo.trim() : '';
    const nwo = raw.replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
    if (!isNwo(nwo)) throw new HttpError(400, 'Write the repository as owner/name');
    if (!addRepo) throw new HttpError(503, 'Adding repositories is not available yet');
    const store = await getStore();
    if (!store) throw new HttpError(503, NO_STORE);
    if (!getClient || !config) {
      throw new HttpError(503, 'Adding repositories needs GitHub access and the full configuration');
    }
    if (adding) throw new HttpError(409, 'Already adding a repository: wait for it to finish');
    const lock = await readLock();
    if (lock?.live) {
      const run = lock.runId ?? 'unknown run';
      throw new HttpError(409, `A run holds the lock (${run}): try again when it finishes`);
    }
    adding = true;
    let locked = false;
    try {
      if (typeof store.lock === 'function') {
        const stampText = now().replace(/[-:]/g, '').replace(/\.\d+/, '').slice(0, 16);
        const runId = `${stampText}-${(fnv1a(`${nwo}${now()}`) & 0xffff).toString(16).padStart(4, '0')}`;
        try {
          await store.lock(runId);
          locked = true;
        } catch (err) {
          const e = /** @type {{name?: string, code?: string}} */ (err);
          if (e?.name === 'LockError' || e?.code === 'ELOCKED') {
            throw new HttpError(409, 'A run holds the lock: try again when it finishes');
          }
          throw err;
        }
      }
      /** @type {any} */
      let client;
      try {
        client = await getClient();
      } catch (err) {
        throw new HttpError(503, `GitHub access is not available: ${messageOf(err)}`);
      }
      /** @type {any} */
      let record;
      try {
        record = await addRepo(nwo, { client, store, config, now, deep: true });
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, `Could not add ${nwo}: ${messageOf(err)}`);
      }
      indexCache = null;
      viewCache = null;
      return { record: record && isQuarantined(record) ? quarantinedView(record) : record ?? null };
    } finally {
      adding = false;
      if (locked) {
        try {
          await store.unlock();
        } catch (err) {
          log.warn(`Could not release the lock: ${messageOf(err)}`);
        }
      }
    }
  }

  // --- plumbing -------------------------------------------------------------------------------

  /**
   * @param {http.ServerResponse} res
   * @param {number} status
   * @param {string | Buffer | null} body
   * @param {Record<string, string>} [headers]
   * @param {boolean} [head] send the headers only
   */
  function send(res, status, body, headers = {}, head = false) {
    if (res.headersSent) return;
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.statusCode = status;
    if (body !== null) res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(head || body === null ? undefined : body);
  }

  /**
   * @param {http.ServerResponse} res
   * @param {number} status
   * @param {unknown} value
   * @param {{head?: boolean, headers?: Record<string, string>}} [opts]
   */
  function sendJson(res, status, value, { head = false, headers = {} } = {}) {
    send(res, status, JSON.stringify(value), {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers,
    }, head);
  }

  /**
   * @param {http.ServerResponse} res
   * @param {string} etag
   */
  function notModified(res, etag) {
    res.statusCode = 304;
    res.setHeader('ETag', etag);
    res.end();
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {string} etag
   * @returns {boolean}
   */
  function fresh(req, etag) {
    const inm = req.headers['if-none-match'];
    return typeof inm === 'string' && inm.split(',').map((s) => s.trim()).includes(etag);
  }

  /** @param {http.ServerResponse} res */
  function secure(res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  }

  /**
   * @param {http.IncomingMessage} req
   * @returns {Promise<unknown>}
   */
  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      const tooBig = () => new HttpError(413, `Request bodies are limited to ${BODY_LIMIT / 1024} KB`);
      if (Number.isFinite(declared) && declared > BODY_LIMIT) {
        reject(tooBig());
        req.resume();
        return;
      }
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      let done = false;
      req.on('data', (/** @type {Buffer} */ chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > BODY_LIMIT) {
          done = true;
          reject(tooBig());
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (done) return;
        done = true;
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          reject(new HttpError(400, 'The request body is not valid JSON'));
        }
      });
      req.on('error', (err) => {
        if (!done) {
          done = true;
          reject(err);
        }
      });
    });
  }

  /** @param {http.IncomingMessage} req */
  function guardPost(req) {
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') throw new HttpError(415, 'Send JSON (content-type: application/json)');
    if (req.headers['x-unsung'] !== '1') {
      throw new HttpError(403, 'Requests from the explorer carry x-unsung: 1');
    }
    const origin = req.headers.origin;
    const self = `http://${String(req.headers.host).toLowerCase()}`;
    if (origin !== undefined && String(origin).toLowerCase() !== self) {
      throw new HttpError(403, 'Requests from other sites are refused');
    }
  }

  /**
   * The §10.1 `Sec-Fetch-Site` guard, for every request: a browser that says the request comes from
   * another site (a page's script, image or fetch) gets 403, so no other page can make the browser
   * drive the API. The header may be absent (curl, older browsers). A link from elsewhere that opens
   * the explorer's page itself, as a top-level navigation, is let through.
   * @param {http.IncomingMessage} req
   * @param {string} method
   * @param {string} p the path
   */
  function guardSite(req, method, p) {
    const site = req.headers['sec-fetch-site'];
    if (site === undefined || site === 'same-origin' || site === 'none') return;
    const opensPage = (method === 'GET' || method === 'HEAD') && (p === '/' || p === '/index.html')
      && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document';
    if (!opensPage) throw new HttpError(403, 'Requests from other sites are refused');
  }

  /**
   * Serve one file under `root`, after resolving and prefix-checking its path (§10.1).
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} root
   * @param {string[]} segs
   * @param {boolean} head
   */
  async function serveFile(req, res, root, segs, head) {
    const file = path.resolve(root, ...segs);
    if (!file.startsWith(root + path.sep)) throw new HttpError(404, 'Not found');
    const type = TYPES[/** @type {keyof typeof TYPES} */ (path.extname(file).toLowerCase())];
    if (!type) throw new HttpError(404, 'Not found');
    /** @type {import('node:fs').Stats} */
    let st;
    try {
      st = await stat(file);
    } catch {
      throw new HttpError(404, 'Not found');
    }
    if (!st.isFile()) throw new HttpError(404, 'Not found');
    const [real, realRoot] = await Promise.all([realpath(file), realpath(root)]);
    if (!real.startsWith(realRoot + path.sep)) throw new HttpError(404, 'Not found');
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (fresh(req, etag)) return notModified(res, etag);
    const headers = { 'Content-Type': type, ETag: etag, 'Cache-Control': 'no-cache' };
    send(res, 200, await readFile(real), headers, head);
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} root
   * @param {string} rel the still-encoded path below `root`
   * @param {boolean} head
   */
  async function serveStatic(req, res, root, rel, head) {
    /** @type {string[]} */
    const segs = [];
    for (const part of rel.split('/')) {
      let s;
      try {
        s = decodeURIComponent(part);
      } catch {
        throw new HttpError(400, 'Bad request path');
      }
      if (!s || s.startsWith('.') || /[\\/\0:*?"<>|]/.test(s)) throw new HttpError(404, 'Not found');
      segs.push(s);
    }
    return serveFile(req, res, root, segs, head);
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @param {string} method
   * @param {string} p
   * @param {URLSearchParams} params
   */
  async function api(req, res, method, p, params) {
    const head = method === 'HEAD';
    const m = head ? 'GET' : method;
    const repo = /^\/api\/repo\/([^/]+)\/([^/]+)$/.exec(p);
    const known = Object.hasOwn(API_ROUTES, p) ? API_ROUTES[/** @type {'/api/index'} */ (p)] : null;
    const allowed = repo ? ['GET'] : known;
    if (!allowed) throw new HttpError(404, 'There is no such API route');
    if (!allowed.includes(m)) {
      const allow = allowed.flatMap((x) => (x === 'GET' ? ['GET', 'HEAD'] : [x])).join(', ');
      throw new HttpError(405, `Use ${allowed.join(' or ')} here`, {}, { Allow: allow });
    }
    if (m === 'POST') {
      guardPost(req);
      const body = await readJsonBody(req);
      if (p === '/api/feedback') return sendJson(res, 200, await postFeedback(body));
      if (p === '/api/add') return sendJson(res, 200, await postAdd(body));
      return sendJson(res, 200, await postTaste(body));
    }
    if (repo) return sendJson(res, 200, await getRepo(repo[1], repo[2]), { head });
    if (p === '/api/index') {
      const view = await indexView();
      if (fresh(req, view.etag)) return notModified(res, view.etag);
      const gzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? '')) && view.body.length > 2048;
      /** @type {Record<string, string>} */
      const headers = {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: view.etag,
        Vary: 'Accept-Encoding',
      };
      if (gzip) {
        view.gz ??= gzipSync(view.body);
        headers['Content-Encoding'] = 'gzip';
      }
      return send(res, 200, gzip ? /** @type {Buffer} */ (view.gz) : view.body, headers, head);
    }
    if (p === '/api/model') return sendJson(res, 200, await getModel(), { head });
    if (p === '/api/taste') return sendJson(res, 200, await getTaste(), { head });
    if (p === '/api/status') return sendJson(res, 200, await getStatus(), { head });
    return sendJson(res, 200, await getCalibrate(params), { head });
  }

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handle(req, res) {
    secure(res);
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : null;
    if (!isLoopback(req.socket?.remoteAddress)) {
      throw new HttpError(403, 'The explorer answers this computer only');
    }
    if (!hostAllowed(req.headers.host, port)) {
      throw new HttpError(421, `This is Unsung's explorer: open it at http://127.0.0.1:${port}/`);
    }
    const raw = String(req.url ?? '/');
    if (!raw.startsWith('/') || raw.startsWith('//')) throw new HttpError(400, 'Bad request path');
    const url = new URL(raw, `http://127.0.0.1:${port}`);
    const method = String(req.method ?? 'GET').toUpperCase();
    const p = url.pathname;
    guardSite(req, method, p);
    if (p.startsWith('/api/')) return api(req, res, method, p, url.searchParams);
    if (method !== 'GET' && method !== 'HEAD') {
      throw new HttpError(405, 'Only GET and HEAD are allowed here', {}, { Allow: 'GET, HEAD' });
    }
    const head = method === 'HEAD';
    if (p === '/' || p === '/index.html') return serveFile(req, res, webDir, ['index.html'], head);
    if (p.startsWith('/web/')) return serveStatic(req, res, webDir, p.slice('/web/'.length), head);
    if (p.startsWith('/src/core/')) {
      const name = p.slice('/src/core/'.length);
      if (!/^[a-z][a-z0-9-]*\.mjs$/.test(name)) throw new HttpError(404, 'Not found');
      return serveStatic(req, res, coreDir, name, head);
    }
    throw new HttpError(404, 'Not found');
  }

  /**
   * @param {http.ServerResponse} res
   * @param {unknown} err
   */
  function fail(res, err) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    secure(res);
    if (err instanceof HttpError) {
      if (err.status === 413) res.setHeader('Connection', 'close');
      sendJson(res, err.status, { error: err.message, ...err.extra }, { headers: err.headers });
      return;
    }
    log.error('The explorer server hit an unexpected error', { error: err });
    sendJson(res, 500, { error: 'Something went wrong in the explorer server; its log has the details' });
  }

  // A request without a Host header is refused here (421, with the security headers), not by
  // Node's parser (a bare 400 without them).
  const server = http.createServer({ requireHostHeader: false }, (req, res) => {
    handle(req, res).catch((err) => fail(res, err));
  });
  return server;
}

/**
 * Create the server and listen on 127.0.0.1 — never any other interface (§10.1).
 * @param {ServerOptions & {port?: number}} opts port 0 picks a free one
 * @returns {Promise<{server: http.Server, port: number, url: string, close: () => Promise<void>}>}
 */
export async function startServer(opts) {
  const server = createServer(opts);
  const port = opts.port ?? DEFAULT_PORT;
  await new Promise((resolve, reject) => {
    /** @param {Error & {code?: string}} err */
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err.code === 'EADDRINUSE' ? new PortError(port) : err);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(undefined);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
  const address = server.address();
  const actual = address && typeof address === 'object' ? address.port : port;
  /** @type {Promise<void> | null} */
  let closing = null;
  const close = () => {
    closing ??= new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    return closing;
  };
  return { server, port: actual, url: `http://127.0.0.1:${actual}/`, close };
}

// ---------------------------------------------------------------------------------------------
// `node server.mjs` (npm start)
// ---------------------------------------------------------------------------------------------

/**
 * A module's named export, or null while it (or a module it needs) has not landed.
 * @param {() => Promise<any>} loader
 * @param {string} name
 * @returns {Promise<any>}
 */
async function optional(loader, name) {
  try {
    const mod = await loader();
    return typeof mod?.[name] === 'function' ? mod[name] : null;
  } catch (err) {
    if (/** @type {{code?: string}} */ (err)?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}

/**
 * @param {number} ms
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<void>}
 */
function sleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

/**
 * The read-only GitHub client for `POST /api/add` when the server runs on its own. The token is
 * taken inside this process, registered for redaction, and never printed.
 * @param {Config} config
 * @param {() => Promise<Store | null>} store
 * @param {Log} log
 * @returns {Promise<any>}
 */
async function githubClient(config, store, log) {
  const [tokenMod, governorMod, clientMod] = await Promise.all([
    import('./src/github/token.mjs'), import('./src/github/governor.mjs'), import('./src/github/client.mjs'),
  ]);
  const { token } = await tokenMod.getToken({ env: process.env });
  registerSecret(token);
  const clock = { now: () => new Date().toISOString(), ms: () => Date.now(), sleep };
  const governor = governorMod.createGovernor(config.defaults.governor, { clock });
  let version = '0.0.0';
  try {
    version = String(parseJson(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version);
  } catch {
    // The user agent says 0.0.0.
  }
  return clientMod.createClient({
    token, governor, cache: (await store())?.httpCache, fetch: globalThis.fetch, log,
    userAgent: `unsung/${version} (+local; read-only)`,
  });
}

/**
 * `node server.mjs [--port 8750] [--data ./data] [--config ./config]` — the explorer, as `npm start`.
 * An incomplete configuration is not fatal: the explorer then uses the model stored in the index.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  /** @type {{port?: string, data?: string, config?: string}} */
  let values;
  try {
    ({ values } = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: { port: { type: 'string' }, data: { type: 'string' }, config: { type: 'string' } },
    }));
  } catch (err) {
    console.error(`unsung explorer: ${messageOf(err)}`);
    return 2;
  }
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    registerSecret(process.env[name]);
  }
  const log = createLog({ level: 'info' });
  const configDir = path.resolve(values.config ?? path.join(ROOT, 'config'));
  const dataDir = path.resolve(values.data ?? process.env.UNSUNG_DATA ?? 'data');
  /** @type {Config | null} */
  let config = null;
  try {
    config = loadConfig(configDir);
  } catch (err) {
    log.warn(`${messageOf(err)}. The explorer uses the model stored in the index.`);
  }
  let port = config?.defaults?.server?.port ?? DEFAULT_PORT;
  if (values.port !== undefined) port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`unsung explorer: --port expects a whole number from 0 to 65535, got '${values.port}'`);
    return 2;
  }
  const openStoreFn = await optional(() => import('./src/store/store.mjs'), 'openStore');
  const addRepo = await optional(() => import('./src/pipeline/add.mjs'), 'addRepo');
  /** @type {Promise<Store | null> | null} */
  let storeOnce = null;
  const store = () => {
    if (!storeOnce) {
      const nowIso = () => new Date().toISOString();
      storeOnce = Promise.resolve(openStoreFn ? openStoreFn(dataDir, { now: nowIso, log }) : null);
    }
    return storeOnce;
  };
  const cfg = config;
  let url;
  let close;
  try {
    ({ url, close } = await startServer({
      dataDir, config, log, port, addRepo,
      openStore: openStoreFn ? () => store() : null,
      getClient: cfg ? () => githubClient(cfg, store, log) : null,
    }));
  } catch (err) {
    console.error(`unsung explorer: ${messageOf(err)}`);
    return /** @type {{exitCode?: number}} */ (err)?.exitCode ?? 1;
  }
  console.log(`Unsung explorer: ${url}`);
  console.log(openStoreFn ? 'Press Ctrl-C to stop.' : 'The store is not available yet: showing the examples. '
    + 'Press Ctrl-C to stop.');
  await new Promise((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await close();
  return 0;
}

/** @returns {boolean} whether this file is the script node was asked to run */
function isEntryPoint() {
  const script = process.argv[1];
  if (!script) return false;
  try {
    const a = realpathSync(script);
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(redact(err instanceof Error ? err.stack ?? err.message : String(err)));
      process.exitCode = 1;
    },
  );
}
