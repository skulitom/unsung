// @ts-check
/**
 * The `Store` interface of DESIGN §12.3, written once over a storage backend. `store.mjs` supplies
 * a file-system backend (the `data/` layout of §4.2) and `memory.mjs` an in-memory one; both get
 * exactly the behaviour below, which is what `test/store-contract.test.mjs` checks.
 *
 * Calling conventions:
 * - `ledger.*` and `httpCache.*` are **synchronous** (they are handed to WP1 code, which may call
 *   them with or without `await`); every other method returns a Promise.
 * - Values going in are copied and values coming out are copies: callers can never mutate the
 *   store's state by accident.
 * - Time comes from the `now()` given at creation (ISO-8601 UTC).
 */

import { repoPath } from '../core/schema.mjs';
import { redact } from '../secrets.mjs';
import {
  LockError, StoreError, cacheName, clone, createCandidateState, createLedgerState, createOwnerState,
  createVerdictState, dayOf, daysBefore, idSegment, lockIsStale, monthOf, redactValue, retentionOf,
  shaSegment, summaryOf, toMs,
} from './common.mjs';

/** @typedef {import('../core/schema.mjs').Candidate} Candidate */
/** @typedef {import('../core/schema.mjs').CandidatePatch} CandidatePatch */
/** @typedef {import('../core/schema.mjs').Unit} Unit */
/** @typedef {import('../core/schema.mjs').RepoRecord} RepoRecord */
/** @typedef {import('../core/schema.mjs').Feedback} Feedback */
/** @typedef {import('../core/schema.mjs').TasteState} TasteState */
/** @typedef {import('../core/schema.mjs').Verdict} Verdict */
/** @typedef {import('../core/schema.mjs').OwnerMemory} OwnerMemory */
/** @typedef {import('../core/schema.mjs').HttpCacheEntry} HttpCacheEntry */
/** @typedef {import('../core/schema.mjs').RunManifest} RunManifest */
/** @typedef {import('../core/schema.mjs').RunSummary} RunSummary */
/** @typedef {import('../core/schema.mjs').Index} Index */
/** @typedef {import('../core/schema.mjs').ArchiveEvent} ArchiveEvent */
/** @typedef {import('./common.mjs').Retention} Retention */
/** @typedef {import('./common.mjs').QueueOptions} QueueOptions */
/** @typedef {import('./common.mjs').VerdictKey} VerdictKey */
/** @typedef {{pid: number, runId: string, startedAt: string}} LockRecord */

/**
 * What a storage backend provides. Every method is synchronous.
 * @typedef {object} Backend
 * @property {'file' | 'memory'} kind
 * @property {string | null} dir
 * @property {() => any[]} loadCandidateLines Candidate and CandidatePatch lines, oldest first
 * @property {(day: string, lines: any[]) => void} appendCandidateLines
 * @property {(byDay: Map<string, Candidate[]>, opts: {before: string, changedDays: Set<string>}) =>
 *   {partitions: number, gzipped: number}} rewriteCandidatePartitions fold and gzip partitions older
 *   than `before` (a day), deleting those left empty
 * @property {() => Unit[]} loadUnits ledger events, oldest first
 * @property {(u: Unit) => void} appendUnit
 * @property {(beforeMonth: string) => number} collapseUnits keep one event per key in months before
 * @property {() => OwnerMemory[]} loadOwners
 * @property {(m: OwnerMemory) => void} appendOwner
 * @property {(all: OwnerMemory[]) => number} rewriteOwners
 * @property {() => Verdict[]} loadVerdicts
 * @property {(v: Verdict) => void} appendVerdict
 * @property {(ev: Feedback) => void} appendFeedback
 * @property {() => Feedback[]} readFeedback
 * @property {(key: string) => RepoRecord | null} readRepo key is `repoPath(nwo)`
 * @property {(key: string, rec: RepoRecord) => void} writeRepo
 * @property {(key: string) => boolean} deleteRepo
 * @property {() => string[]} listRepoKeys sorted
 * @property {() => Map<string, string>} scanRepoIds id → key
 * @property {(name: string) => any} readDoc `index.json`, `taste.json`, `optout.json`; null if absent
 * @property {(name: string, value: unknown) => void} writeDoc
 * @property {(runId: string, m: RunManifest) => void} writeRun
 * @property {(runId: string) => RunManifest | null} readRun
 * @property {(s: RunSummary) => void} appendRunSummary
 * @property {() => RunSummary[]} readRunSummaries oldest first
 * @property {(name: string, nowMs: number) => HttpCacheEntry | null} httpGet marks the entry used
 * @property {(name: string, entry: HttpCacheEntry, nowMs: number) => void} httpPut
 * @property {(cutoffMs: number) => number} deleteHttpUnused entries last used before the cutoff
 * @property {(sha: string) => any} treeGet
 * @property {(sha: string, tree: unknown) => void} treePut
 * @property {(idSeg: string, oid: string) => any} filesGet
 * @property {(idSeg: string, oid: string, files: unknown) => void} filesPut
 * @property {(name: string, events: unknown[], append: boolean) => void} writeArchive
 * @property {(name: string) => ArchiveEvent[] | null} readArchive
 * @property {(cutoffMs: number) => number} deleteArchiveBefore extracts whose hour starts before
 * @property {() => LockRecord | null} readLock
 * @property {(rec: LockRecord) => boolean} createLock false when a lock already exists
 * @property {() => void} removeLock
 * @property {(pid: number) => boolean} isAlive
 * @property {(count: number, what: string) => void} [reportBadLines]
 */

/**
 * @param {unknown} v
 * @returns {string}
 */
function isoOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || v instanceof Date) return new Date(v).toISOString();
  throw new TypeError('now() must return an ISO string, a Date or milliseconds');
}

/**
 * Normalise a GH Archive hour name: `2026-09-10` + `3` → `2026-09-10-3` (hours are not
 * zero-padded, §3.3).
 * @param {string} date
 * @param {number | string} hour
 * @returns {string}
 */
export function archiveName(date, hour) {
  const h = Number(hour);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !Number.isInteger(h) || h < 0 || h > 23) {
    throw new StoreError(`Not a GH Archive hour: ${String(date)} ${String(hour)}`, 'EINVALID');
  }
  return `${date}-${h}`;
}

/**
 * Start of an archive hour name in milliseconds, or NaN.
 * @param {string} name
 * @returns {number}
 */
export function archiveHourMs(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{1,2})$/.exec(name);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])) : NaN;
}

/**
 * @param {unknown} runId
 * @returns {string}
 */
function checkRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(runId)) {
    throw new StoreError(`Not a valid run id: ${String(runId).slice(0, 40)}`, 'EINVALID');
  }
  return runId;
}

/**
 * Build a Store over a backend.
 * @param {Backend} backend
 * @param {{now?: () => string | number | Date, log?: import('../log.mjs').Log}} [opts]
 */
export function createStore(backend, { now, log } = {}) {
  const clock = now ? () => isoOf(now()) : () => new Date().toISOString();

  // The ledger is loaded eagerly: its methods are synchronous.
  const units = createLedgerState();
  for (const u of backend.loadUnits()) units.apply(u);

  /** @type {ReturnType<typeof createCandidateState> | null} */
  let cands = null;
  /** @type {ReturnType<typeof createOwnerState> | null} */
  let owners = null;
  /** @type {ReturnType<typeof createVerdictState> | null} */
  let verdicts = null;
  /** @type {Map<string, string> | null} */
  let repoIds = null;
  /** @type {LockRecord | null} */
  let held = null;
  /** @type {Set<string>} archive hours written by this store instance */
  const extractsWritten = new Set();

  const C = () => {
    if (!cands) {
      const state = createCandidateState();
      let orphans = 0;
      for (const line of backend.loadCandidateLines()) if (!state.apply(line)) orphans++;
      if (orphans > 0) backend.reportBadLines?.(orphans, 'candidate patches without a candidate');
      cands = state;
    }
    return cands;
  };
  const O = () => {
    if (!owners) {
      owners = createOwnerState();
      for (const m of backend.loadOwners()) owners.apply(m);
    }
    return owners;
  };
  const V = () => {
    if (!verdicts) {
      verdicts = createVerdictState();
      for (const v of backend.loadVerdicts()) verdicts.apply(v);
    }
    return verdicts;
  };
  const ids = () => {
    repoIds ??= backend.scanRepoIds();
    return repoIds;
  };

  /**
   * @param {Unit} u
   * @returns {Unit}
   */
  const persistUnit = (u) => {
    backend.appendUnit(u);
    return clone(u);
  };

  /**
   * @param {{day: string, line: any}[]} lines
   */
  const persistCandidates = (lines) => {
    /** @type {Map<string, any[]>} */
    const byDay = new Map();
    for (const { day, line } of lines) {
      const list = byDay.get(day) ?? [];
      list.push(line);
      byDay.set(day, list);
    }
    for (const [day, list] of byDay) backend.appendCandidateLines(day, list);
  };

  /**
   * @param {unknown} nwo
   * @returns {string | null}
   */
  const keyOf = (nwo) => {
    try {
      return repoPath(/** @type {string} */ (nwo));
    } catch {
      return null;
    }
  };

  const ledger = {
    /** @param {string} key @returns {Unit | null} */
    get: (key) => units.get(key),
    /** @param {string} key @returns {boolean} */
    isDone: (key) => units.isDone(key),
    /**
     * Mark a unit running; `attempts` goes up by one.
     * @param {string} key
     * @param {string} [stage] defaults to the key's prefix
     * @param {string | null} [runId]
     * @returns {Unit}
     */
    start: (key, stage, runId) => persistUnit(units.start(key, stage, runId, clock())),
    /**
     * @param {string} key
     * @param {Record<string, unknown> | null} [out]
     * @returns {Unit}
     */
    done: (key, out) => persistUnit(units.done(key, out, clock())),
    /**
     * Mark a unit failed; it may be retried after `10 min × 2^attempts`, at most 5 attempts.
     * @param {string} key
     * @param {unknown} err
     * @returns {Unit}
     */
    fail: (key, err) => persistUnit(units.fail(key, err, clock())),
    /**
     * Put a unit (back) into the `planned` state.
     * @param {string} key
     * @param {string} [stage]
     * @returns {Unit}
     */
    plan: (key, stage) => persistUnit(units.plan(key, stage, clock())),
    /**
     * @param {{state?: string | string[], stage?: string, prefix?: string}} [filter]
     * @returns {Unit[]}
     */
    list: (filter) => units.list(filter),
    /**
     * Whether a unit may start now (not done or running; a failed unit after its back-off).
     * @param {string} key
     * @param {string} [nowIso]
     * @returns {boolean}
     */
    canStart: (key, nowIso) => units.canStart(key, nowIso ?? clock()),
  };

  const httpCache = {
    /**
     * @param {string} key
     * @returns {HttpCacheEntry | null}
     */
    get(key) {
      return backend.httpGet(cacheName(key), toMs(clock()));
    },
    /**
     * @param {string} key
     * @param {HttpCacheEntry} entry
     */
    put(key, entry) {
      if (!entry || typeof entry !== 'object') {
        throw new StoreError('A cache entry must be an object', 'EINVALID');
      }
      const at = clock();
      /** @type {HttpCacheEntry} */
      const safe = {
        ...clone(entry), url: redact(entry.url ?? ''), at: typeof entry.at === 'string' ? entry.at : at,
      };
      backend.httpPut(cacheName(key), safe, toMs(at));
    },
  };

  const store = {
    /** @type {'file' | 'memory'} */
    kind: backend.kind,
    /** @type {string | null} */
    dir: backend.dir,
    /** Current store time (ISO). */
    now: clock,

    // --- lock (§3.12) --------------------------------------------------------------------------

    /**
     * Take the run lock. A live lock held by another run throws `LockError` (exit 2); a stale one
     * (dead process, or older than 6 h) is taken over. Once the lock is ours, ledger units left
     * `running` by a dead run go back to `planned`.
     * @param {string} runId
     * @returns {Promise<LockRecord>}
     */
    async lock(runId) {
      const rec = { pid: process.pid, runId: String(runId), startedAt: clock() };
      for (let attempt = 0; attempt < 3; attempt++) {
        if (backend.createLock(rec)) {
          held = rec;
          for (const key of units.orphans(rec.runId)) persistUnit(units.plan(key, undefined, clock()));
          return { ...rec };
        }
        const cur = backend.readLock();
        if (cur && !lockIsStale(cur, toMs(clock()), backend.isAlive)) {
          throw new LockError(`Another run holds the lock (run ${cur.runId}, process ${cur.pid}, `
            + `since ${cur.startedAt})`, cur);
        }
        log?.warn('Taking over a stale lock', { runId: cur?.runId ?? null, pid: cur?.pid ?? null });
        backend.removeLock();
      }
      throw new LockError('Could not take the lock');
    },

    /** Release the lock this store took (never someone else's). */
    async unlock() {
      const cur = backend.readLock();
      if (held && cur && cur.runId === held.runId && cur.pid === held.pid) backend.removeLock();
      held = null;
    },

    /**
     * The current lock, if any, and whether it is live.
     * @returns {Promise<(LockRecord & {live: boolean}) | null>}
     */
    async lockInfo() {
      const cur = backend.readLock();
      if (!cur) return null;
      return { ...cur, live: !lockIsStale(cur, toMs(clock()), backend.isAlive) };
    },

    ledger,

    // --- candidates ----------------------------------------------------------------------------

    /**
     * Upsert candidates keyed by id (§3.12): a new id is appended to its partition; a known id
     * gets a patch holding only the fields that changed, in the partition it already lives in.
     * @param {Candidate | Candidate[]} list
     * @returns {Promise<{added: number, updated: number}>}
     */
    async putCandidates(list) {
      const arr = Array.isArray(list) ? list : [list];
      const lines = C().put(arr, clock());
      persistCandidates(lines);
      const added = lines.filter((l) => /** @type {any} */ (l.line).patch !== true).length;
      return { added, updated: lines.length - added };
    },
    /**
     * Append a patch to a known candidate; the latest value of each field wins.
     * @param {Candidate | string} cand the candidate or its id
     * @param {Partial<Candidate>} set
     * @returns {Promise<Candidate>} the updated candidate
     */
    async patchCandidate(cand, set) {
      const { day, line, candidate } = C().patch(cand, /** @type {Record<string, unknown>} */ (set), clock());
      backend.appendCandidateLines(day, [line]);
      return candidate;
    },
    /** @param {string} id @returns {Promise<Candidate | null>} */
    async getCandidate(id) {
      return C().get(id);
    },
    /**
     * Queued candidates best-first (§3.4), with exploration slots filled by uniformly drawn
     * candidates of prior ≤ 1 (marked `explore: true` in the returned copies only).
     * @param {QueueOptions} [opts]
     * @returns {Promise<Candidate[]>}
     */
    async queue(opts) {
      return C().queue(opts);
    },
    /**
     * Deferred candidates whose `nextAt` has passed.
     * @param {string} [nowIso]
     * @returns {Promise<Candidate[]>}
     */
    async dueDeferred(nowIso) {
      return C().dueDeferred(nowIso ?? clock());
    },
    /**
     * @param {{state?: string | string[], day?: string, ids?: Iterable<string>}} [filter]
     * @returns {Promise<Candidate[]>}
     */
    async listCandidates(filter) {
      return C().list(filter);
    },
    /** @returns {Promise<Record<string, number>>} candidates per state */
    async candidateCounts() {
      return C().counts();
    },

    // --- repository records --------------------------------------------------------------------

    /** @param {string} nwo @returns {Promise<RepoRecord | null>} */
    async getRepo(nwo) {
      const key = keyOf(nwo);
      return key ? backend.readRepo(key) : null;
    },
    /** @param {string} id @returns {Promise<RepoRecord | null>} */
    async getRepoById(id) {
      const key = ids().get(id);
      if (!key) return null;
      const rec = backend.readRepo(key);
      if (rec && rec.id === id) return rec;
      ids().delete(id);
      return null;
    },
    /**
     * Write a record atomically at `repos/<repoPath(nwo)>.json`. A renamed repository (same id,
     * new name) moves: the file under its old name is removed.
     * @param {RepoRecord} rec
     * @returns {Promise<void>}
     */
    async putRepo(rec) {
      if (!rec || typeof rec.id !== 'string' || rec.id === '') {
        throw new StoreError('A repository record needs an id', 'EINVALID');
      }
      const key = keyOf(rec.nwo);
      if (!key) {
        const shown = String(rec.nwo).slice(0, 60);
        throw new StoreError(`A repository record needs owner/name, got ${shown}`, 'EINVALID');
      }
      const index = ids();
      const old = index.get(rec.id);
      if (old && old !== key) backend.deleteRepo(old);
      backend.writeRepo(key, clone(rec));
      index.set(rec.id, key);
    },
    /**
     * Remove a repository record.
     * @param {string} nwo
     * @returns {Promise<boolean>} whether a record was removed
     */
    async deleteRepo(nwo) {
      const key = keyOf(nwo);
      if (!key) return false;
      const rec = backend.readRepo(key);
      if (rec) ids().delete(rec.id);
      return backend.deleteRepo(key);
    },
    /** @returns {AsyncGenerator<RepoRecord>} every record, in path order */
    async* listRepos() {
      for (const key of backend.listRepoKeys()) {
        const rec = backend.readRepo(key);
        if (rec) yield rec;
      }
    },

    // --- feedback and taste --------------------------------------------------------------------

    /**
     * Append a feedback event (never compacted, nothing ever deleted).
     * @param {Feedback} ev
     * @returns {Promise<Feedback>}
     */
    async appendFeedback(ev) {
      if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string' || typeof ev.action !== 'string') {
        throw new StoreError('A feedback event needs an id and an action', 'EINVALID');
      }
      backend.appendFeedback(clone(ev));
      return clone(ev);
    },
    /** @returns {Promise<Feedback[]>} every event, oldest first */
    async readFeedback() {
      return backend.readFeedback();
    },
    /** @returns {Promise<TasteState | null>} */
    async readTaste() {
      return backend.readDoc('taste.json');
    },
    /** @param {TasteState} t @returns {Promise<void>} */
    async writeTaste(t) {
      backend.writeDoc('taste.json', clone(t));
    },

    // --- verdicts ------------------------------------------------------------------------------

    /** @param {Verdict} v @returns {Promise<void>} */
    async appendVerdict(v) {
      if (!v || typeof v !== 'object' || typeof v.id !== 'string') {
        throw new StoreError('A verdict needs an id', 'EINVALID');
      }
      const copy = clone(v);
      V().apply(copy);
      backend.appendVerdict(copy);
    },
    /**
     * The latest verdict for a key `id|headOid|rubric|backend|model` (§3.11), or for an object whose
     * present fields must all match.
     * @param {string | VerdictKey} key
     * @returns {Promise<Verdict | null>}
     */
    async getVerdict(key) {
      return V().get(key);
    },

    // --- owner memory --------------------------------------------------------------------------

    /** @param {string} login @returns {Promise<OwnerMemory | null>} case-insensitive */
    async getOwner(login) {
      return O().get(login);
    },
    /**
     * Record what is known about an owner; flags accumulate (`farm` and `streak` are permanent).
     * @param {Partial<OwnerMemory> & {login: string}} m
     * @returns {Promise<OwnerMemory>} the merged record
     */
    async putOwner(m) {
      const merged = O().put(m, clock());
      backend.appendOwner(merged);
      return merged;
    },

    httpCache,

    // --- caches --------------------------------------------------------------------------------

    /** @param {string} sha @returns {Promise<any>} a cached recursive tree, or null */
    async getTree(sha) {
      return backend.treeGet(shaSegment(sha));
    },
    /** @param {string} sha @param {unknown} tree @returns {Promise<void>} */
    async putTree(sha, tree) {
      backend.treePut(shaSegment(sha), clone(tree));
    },
    /** @param {string} id @param {string} oid @returns {Promise<any>} cached pack files, or null */
    async getFiles(id, oid) {
      return backend.filesGet(idSegment(id), shaSegment(oid));
    },
    /** @param {string} id @param {string} oid @param {unknown} files @returns {Promise<void>} */
    async putFiles(id, oid, files) {
      backend.filesPut(idSegment(id), shaSegment(oid), clone(files));
    },

    // --- archive extracts ----------------------------------------------------------------------

    /**
     * Write the extract of one GH Archive hour (`archive/YYYY-MM-DD-H.jsonl`). The first call for
     * an hour in this store instance replaces the file (so a retried hour is not duplicated);
     * further calls append (so an hour may be written in chunks).
     * @param {string} date `YYYY-MM-DD`
     * @param {number | string} hour 0–23
     * @param {ArchiveEvent[]} events
     * @returns {Promise<number>} events written
     */
    async writeArchiveExtract(date, hour, events) {
      const name = archiveName(date, hour);
      const list = Array.isArray(events) ? events : [];
      backend.writeArchive(name, clone(list), extractsWritten.has(name));
      extractsWritten.add(name);
      return list.length;
    },
    /**
     * @param {string} date
     * @param {number | string} hour
     * @returns {Promise<ArchiveEvent[] | null>}
     */
    async readArchiveExtract(date, hour) {
      return backend.readArchive(archiveName(date, hour));
    },

    // --- runs ----------------------------------------------------------------------------------

    /** @param {RunManifest} m @returns {Promise<void>} */
    async startRun(m) {
      backend.writeRun(checkRunId(m?.runId), redactValue(m));
    },
    /** Rewrite the manifest (every 60 s and at the end, §3.12). @param {RunManifest} m */
    async checkpointRun(m) {
      backend.writeRun(checkRunId(m?.runId), redactValue(m));
    },
    /** Write the final manifest and append its summary to `runs.jsonl`. @param {RunManifest} m */
    async endRun(m) {
      const safe = redactValue(m);
      backend.writeRun(checkRunId(m?.runId), safe);
      backend.appendRunSummary(summaryOf(safe));
    },
    /**
     * The most recent run summaries, newest first.
     * @param {number} [n]
     * @returns {Promise<RunSummary[]>}
     */
    async lastRuns(n = 5) {
      const all = backend.readRunSummaries();
      return all.slice(Math.max(0, all.length - Math.max(0, Math.floor(n)))).reverse();
    },
    /** @param {string} runId @returns {Promise<RunManifest | null>} */
    async getRun(runId) {
      return backend.readRun(checkRunId(runId));
    },

    // --- index and opt-out ---------------------------------------------------------------------

    /** @param {Index} i @returns {Promise<void>} */
    async writeIndex(i) {
      backend.writeDoc('index.json', i);
    },
    /** @returns {Promise<Index | null>} */
    async readIndex() {
      return backend.readDoc('index.json');
    },
    /** @returns {Promise<{v: 1, repos: string[], owners: string[]}>} */
    async readOptOut() {
      const doc = backend.readDoc('optout.json');
      return {
        v: 1,
        repos: Array.isArray(doc?.repos) ? doc.repos.map(String) : [],
        owners: Array.isArray(doc?.owners) ? doc.owners.map(String) : [],
      };
    },

    // --- retention -----------------------------------------------------------------------------

    /**
     * Retention and partition compaction (§4.2): dropped and expired candidates older than 30 days
     * are removed and partitions older than 2 days are folded (patches applied) and gzipped;
     * archive extracts older than 14 days, HTTP cache entries unused for 30 days, and `gone`
     * repositories 30 days after they vanished (unless they have feedback) are removed; ledger
     * months older than 90 days collapse to each unit's final state; owner memory is folded.
     * @param {{now?: string, retention?: Partial<Retention>}} [opts]
     */
    async compact({ now: nowIso, retention } = {}) {
      const at = nowIso ?? clock();
      const r = retentionOf(retention);
      const state = C();
      const candidateCut = dayOf(daysBefore(at, r.candidateDays));
      /** @type {Set<string>} */
      const changedDays = new Set();
      const removedIds = state.remove((c) => {
        const old = c.day < candidateCut && (c.state === 'dropped' || c.state === 'expired');
        if (old) changedDays.add(c.day);
        return old;
      });
      const partitions = backend.rewriteCandidatePartitions(state.byDay(), {
        before: dayOf(daysBefore(at, r.gzipAfterDays)), changedDays,
      });

      const feedbackIds = new Set(backend.readFeedback().map((e) => e.id));
      const goneCut = toMs(daysBefore(at, r.goneDays));
      let reposRemoved = 0;
      for (const key of backend.listRepoKeys()) {
        const rec = backend.readRepo(key);
        if (!rec || rec.gone !== true || feedbackIds.has(rec.id)) continue;
        const vanished = Date.parse(rec.checkedAt ?? '');
        if (Number.isFinite(vanished) && vanished < goneCut) {
          backend.deleteRepo(key);
          ids().delete(rec.id);
          reposRemoved++;
        }
      }

      const archiveRemoved = backend.deleteArchiveBefore(toMs(daysBefore(at, r.archiveDays)));
      const httpRemoved = backend.deleteHttpUnused(toMs(daysBefore(at, r.httpDays)));
      const unitsCollapsed = backend.collapseUnits(monthOf(daysBefore(at, r.unitDays)));
      const ownerRecords = backend.rewriteOwners(O().all());
      const report = {
        at,
        candidates: { removed: removedIds.length, ...partitions },
        archive: { removed: archiveRemoved },
        http: { removed: httpRemoved },
        repos: { removed: reposRemoved },
        units: { collapsed: unitsCollapsed },
        owners: { records: ownerRecords },
      };
      log?.debug('Compacted the store', report);
      return report;
    },
  };
  return store;
}

/** @typedef {ReturnType<typeof createStore>} Store */
