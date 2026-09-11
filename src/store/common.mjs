// @ts-check
/**
 * State and rules shared by both `Store` implementations (DESIGN §3.12, §4.2, §12.3). The file store
 * (`store.mjs`) and the memory store (`memory.mjs`) keep the same in-memory state objects defined
 * here; the file store additionally appends every change to disk. Keeping the rules in one place is
 * what lets one contract suite run against both.
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sampleN } from '../core/util.mjs';
import { redact } from '../secrets.mjs';

/** @typedef {import('../core/schema.mjs').Candidate} Candidate */
/** @typedef {import('../core/schema.mjs').CandidatePatch} CandidatePatch */
/** @typedef {import('../core/schema.mjs').Unit} Unit */
/** @typedef {import('../core/schema.mjs').OwnerMemory} OwnerMemory */
/** @typedef {import('../core/schema.mjs').Verdict} Verdict */
/** @typedef {import('../core/schema.mjs').RunManifest} RunManifest */
/** @typedef {import('../core/schema.mjs').RunSummary} RunSummary */

export const DAY_MS = 86_400_000;

/**
 * Retention of `unsung compact` (§4.2), in days.
 * @typedef {object} Retention
 * @property {number} candidateDays dropped and expired candidate lines older than this are removed
 * @property {number} archiveDays archive extracts older than this are removed
 * @property {number} httpDays HTTP cache entries unused for this long are removed
 * @property {number} goneDays gone repositories without feedback are removed this long after vanishing
 * @property {number} unitDays ledger events older than this collapse to each unit's final state
 * @property {number} gzipAfterDays candidate partitions older than this are folded and gzipped
 */

/** @type {Readonly<Retention>} */
export const DEFAULT_RETENTION = Object.freeze({
  candidateDays: 30, archiveDays: 14, httpDays: 30, goneDays: 30, unitDays: 90, gzipAfterDays: 2,
});

/** A lock older than this is stale even if its process is alive (§3.12). */
export const LOCK_STALE_MS = 6 * 3_600_000;

/** A failed ledger unit is retried at most this many times in total (§3.12). */
export const UNIT_MAX_ATTEMPTS = 5;

/** Base of the failed-unit back-off: `10 min × 2^attempts` (§3.12). */
export const UNIT_BACKOFF_MS = 10 * 60_000;

/** Error texts kept in ledger units are cut to this many characters. */
const ERR_CHARS = 500;

/** A storage problem. `exitCode` 2 marks one the user must fix (version, lock). */
export class StoreError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {number} [exitCode]
   */
  constructor(message, code, exitCode = 1) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** A live lock is held by another run (§3.12); the CLI exits 2. */
export class LockError extends Error {
  /**
   * @param {string} message
   * @param {{pid: number, runId: string, startedAt: string} | null} [lock]
   */
  constructor(message, lock = null) {
    super(message);
    this.name = 'LockError';
    this.code = 'ELOCKED';
    this.exitCode = 2;
    this.lock = lock;
  }
}

/**
 * `YYYY-MM-DD` of an ISO timestamp.
 * @param {string} iso
 * @returns {string}
 */
export function dayOf(iso) {
  return new Date(toMs(iso)).toISOString().slice(0, 10);
}

/**
 * `YYYY-MM` of an ISO timestamp.
 * @param {string} iso
 * @returns {string}
 */
export function monthOf(iso) {
  return dayOf(iso).slice(0, 7);
}

/**
 * Milliseconds of an ISO timestamp; throws on nonsense.
 * @param {string | number} iso
 * @returns {number}
 */
export function toMs(iso) {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) throw new RangeError(`Not a valid time: ${String(iso).slice(0, 40)}`);
  return ms;
}

/**
 * ISO timestamp `days` before `nowIso`.
 * @param {string} nowIso
 * @param {number} days
 * @returns {string}
 */
export function daysBefore(nowIso, days) {
  return new Date(toMs(nowIso) - days * DAY_MS).toISOString();
}

/**
 * @template T
 * @param {T} v
 * @returns {T}
 */
export function clone(v) {
  return v === null || v === undefined ? v : structuredClone(v);
}

/**
 * Fill retention with defaults.
 * @param {Partial<Retention>} [r]
 * @returns {Retention}
 */
export function retentionOf(r = {}) {
  const given = Object.entries(r).filter(([, v]) => v !== undefined);
  return { ...DEFAULT_RETENTION, ...Object.fromEntries(given) };
}

/**
 * A value made safe to store: every string passes through `redact()` (§3.9).
 * @template T
 * @param {T} value
 * @returns {T}
 */
export function redactValue(value) {
  return JSON.parse(redact(JSON.stringify(value)));
}

/**
 * File name for an HTTP-cache key: the key itself when it is already a SHA-1, else its SHA-1.
 * @param {string} key
 * @returns {string}
 */
export function cacheName(key) {
  const k = String(key);
  return /^[0-9a-f]{40}$/.test(k) ? k : createHash('sha1').update(k).digest('hex');
}

/**
 * A node id as a file-system-safe, case-insensitive name (hex of its UTF-8 bytes; node ids are
 * case-sensitive and Windows file names are not).
 * @param {string} id
 * @returns {string}
 */
export function idSegment(id) {
  if (typeof id !== 'string' || id === '') throw new StoreError('A repository id is required', 'EINVALID');
  return Buffer.from(id, 'utf8').toString('hex');
}

/**
 * A commit or tree SHA as a file name (lower-cased hex; anything else is hashed).
 * @param {string} sha
 * @returns {string}
 */
export function shaSegment(sha) {
  const s = String(sha ?? '');
  if (s === '') throw new StoreError('A SHA is required', 'EINVALID');
  return /^[0-9a-f]{4,64}$/i.test(s) ? s.toLowerCase() : createHash('sha1').update(s).digest('hex');
}

/**
 * The stage of a ledger key: the text before its first colon.
 * @param {string} key
 * @returns {string}
 */
export function stageOf(key) {
  const i = String(key).indexOf(':');
  return i > 0 ? key.slice(0, i) : String(key);
}

/**
 * A `RunSummary` is the manifest without `units` (§4.3).
 * @param {RunManifest} manifest
 * @returns {RunSummary}
 */
export function summaryOf(manifest) {
  const { units: _units, ...summary } = manifest;
  return summary;
}

/**
 * Whether a lock may be taken over: unreadable, older than 6 h, or its process is gone (§3.12).
 * @param {any} lock
 * @param {number} nowMs
 * @param {(pid: number) => boolean} isAlive
 * @returns {boolean}
 */
export function lockIsStale(lock, nowMs, isAlive) {
  if (!lock || typeof lock !== 'object') return true;
  const started = Date.parse(lock.startedAt);
  if (!Number.isFinite(started) || nowMs - started >= LOCK_STALE_MS) return true;
  return !isAlive(Number(lock.pid));
}

/**
 * Whether a process exists (`process.kill(pid, 0)`; EPERM means it exists but is not ours).
 * @param {number} pid
 * @returns {boolean}
 */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------------------------

/** Fields a patch may never set. */
const PATCH_FORBIDDEN = new Set(['v', 'id', 'patch', 'day']);

/**
 * @param {unknown} set
 * @returns {Record<string, unknown>}
 */
function cleanSet(set) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!set || typeof set !== 'object') return out;
  for (const [k, v] of Object.entries(set)) if (!PATCH_FORBIDDEN.has(k) && v !== undefined) out[k] = v;
  return out;
}

/**
 * Queue order (§3.4): prior descending, then `createdAt` descending, then id for a stable order.
 * @param {Candidate} a
 * @param {Candidate} b
 * @returns {number}
 */
export function queueOrder(a, b) {
  return (b.prior - a.prior)
    || (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * @typedef {object} QueueOptions
 * @property {number} [limit] how many candidates to return (default 20)
 * @property {number} [explore] share of exploration slots, e.g. 0.05 (§3.4); needs `rand`
 * @property {() => number} [rand] the run's seeded generator
 * @property {Iterable<string>} [exclude] ids to leave out (already attempted in this run)
 */

/**
 * @typedef {object} CandidateLine
 * @property {string} day partition the line belongs to
 * @property {Candidate | CandidatePatch} line
 */

/**
 * In-memory candidates, folded from Candidate and CandidatePatch lines (§4.3).
 */
export function createCandidateState() {
  /** @type {Map<string, Candidate>} */
  const byId = new Map();
  /** @type {Candidate[] | null} queued candidates in queue order; entries may be stale */
  let ordered = null;

  /**
   * @param {Candidate | undefined} before
   * @param {Candidate} after
   */
  const touch = (before, after) => {
    if (after.state !== 'queued') return;
    const same = before && before.state === 'queued' && before.prior === after.prior
      && before.createdAt === after.createdAt;
    if (!same) ordered = null;
  };

  /**
   * Fold one stored line into the state. Returns false for lines that cannot be applied (a patch
   * for an unknown id, or a line without an id).
   * @param {any} line
   * @returns {boolean}
   */
  function apply(line) {
    if (!line || typeof line !== 'object' || typeof line.id !== 'string') return false;
    const cur = byId.get(line.id);
    if (line.patch === true) {
      if (!cur) return false;
      const next = /** @type {Candidate} */ ({ ...cur, ...cleanSet(line.set) });
      byId.set(line.id, next);
      touch(cur, next);
      return true;
    }
    const { patch: _p, ...rest } = line;
    const next = /** @type {Candidate} */ (cur ? { ...rest, day: cur.day } : rest);
    byId.set(line.id, next);
    touch(cur, next);
    return true;
  }

  /**
   * Upsert candidates keyed by id: a new id becomes a Candidate line in its own partition; a known
   * id becomes a patch (only the fields that changed) in the partition it already lives in. Returns
   * the lines to persist, already applied.
   * @param {Candidate[]} cands
   * @param {string} at
   * @returns {CandidateLine[]}
   */
  function put(cands, at) {
    /** @type {CandidateLine[]} */
    const lines = [];
    for (const c of cands) {
      if (!c || typeof c !== 'object' || typeof c.id !== 'string' || c.id === '') {
        throw new StoreError('A candidate needs an id', 'EINVALID');
      }
      const cur = byId.get(c.id);
      if (!cur) {
        if (typeof c.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.day)) {
          throw new StoreError(`Candidate ${c.id} needs a partition day`, 'EINVALID');
        }
        const line = /** @type {Candidate} */ ({ ...clone(c), v: 1 });
        apply(line);
        lines.push({ day: line.day, line });
        continue;
      }
      /** @type {Record<string, unknown>} */
      const set = {};
      for (const [k, v] of Object.entries(c)) {
        if (PATCH_FORBIDDEN.has(k) || v === undefined) continue;
        if (!isDeepStrictEqual(/** @type {any} */ (cur)[k], v)) set[k] = clone(v);
      }
      if (Object.keys(set).length === 0) continue;
      const line = /** @type {CandidatePatch} */ ({ v: 1, patch: true, id: c.id, day: cur.day, at, set });
      apply(line);
      lines.push({ day: cur.day, line });
    }
    return lines;
  }

  /**
   * A patch line for a known candidate, already applied.
   * @param {string | {id: string}} cand
   * @param {Record<string, unknown>} set
   * @param {string} at
   * @returns {{day: string, line: CandidatePatch, candidate: Candidate}}
   */
  function patch(cand, set, at) {
    const id = typeof cand === 'string' ? cand : cand?.id;
    const cur = typeof id === 'string' ? byId.get(id) : undefined;
    if (!cur) throw new StoreError(`No candidate with id ${String(id).slice(0, 60)}`, 'ENOENT');
    const line = /** @type {CandidatePatch} */ ({
      v: 1, patch: true, id: cur.id, day: cur.day, at, set: clone(cleanSet(set)),
    });
    apply(line);
    return { day: cur.day, line, candidate: clone(/** @type {Candidate} */ (byId.get(cur.id))) };
  }

  /**
   * @param {QueueOptions} [opts]
   * @returns {Candidate[]}
   */
  function queue({ limit = 20, explore = 0, rand, exclude } = {}) {
    const n = Math.max(0, Math.floor(Number(limit) || 0));
    if (n === 0) return [];
    const skip = new Set(exclude ?? []);
    if (!ordered) ordered = [...byId.values()].filter((c) => c.state === 'queued').sort(queueOrder);
    /** @type {Candidate[]} */
    const live = [];
    for (const c of ordered) {
      const cur = byId.get(c.id);
      if (cur && cur.state === 'queued') live.push(cur);
    }
    ordered = live;
    const eligible = live.filter((c) => !skip.has(c.id));
    const m = Math.min(n, eligible.length);
    let slots = 0;
    if (explore > 0 && typeof rand === 'function') {
      slots = Math.min(m, Math.max(Math.round(explore * m), Math.floor(m / 20)));
    }
    // Exploration picks are drawn uniformly from every eligible candidate of prior ≤ 1 (§3.4).
    const pool = eligible.filter((c) => c.prior <= 1);
    const picks = slots > 0 ? sampleN(pool, slots, /** @type {() => number} */ (rand)) : [];
    const picked = new Set(picks.map((c) => c.id));
    const head = eligible.filter((c) => !picked.has(c.id)).slice(0, m - picks.length);
    // Spread the exploration picks evenly: with 5 picks in 100, one at every 20th position.
    const every = picks.length > 0 ? Math.max(1, Math.floor(m / picks.length)) : Infinity;
    /** @type {Candidate[]} */
    const out = [];
    let h = 0;
    let p = 0;
    while (out.length < m && (h < head.length || p < picks.length)) {
      const pickNow = p < picks.length && ((out.length + 1) % every === 0 || h >= head.length);
      if (pickNow) out.push({ ...clone(picks[p++]), explore: true });
      else out.push(clone(head[h++]));
    }
    return out;
  }

  /**
   * @param {{state?: string | string[], day?: string, ids?: Iterable<string>}} [filter]
   * @returns {Candidate[]}
   */
  function list({ state, day, ids } = {}) {
    const states = state === undefined ? null : new Set(Array.isArray(state) ? state : [state]);
    const wanted = ids ? new Set(ids) : null;
    /** @type {Candidate[]} */
    const out = [];
    for (const c of byId.values()) {
      if (states && !states.has(c.state)) continue;
      if (day !== undefined && c.day !== day) continue;
      if (wanted && !wanted.has(c.id)) continue;
      out.push(clone(c));
    }
    return out;
  }

  return {
    apply,
    put,
    patch,
    queue,
    list,
    /** @param {string} id */
    get: (id) => clone(byId.get(id) ?? null),
    /** @param {string} id */
    has: (id) => byId.has(id),
    /**
     * Deferred candidates whose `nextAt` has passed.
     * @param {string} nowIso
     * @returns {Candidate[]}
     */
    dueDeferred(nowIso) {
      const now = toMs(nowIso);
      return [...byId.values()]
        .filter((c) => c.state === 'deferred' && typeof c.nextAt === 'string' && Date.parse(c.nextAt) <= now)
        .map((c) => clone(c));
    },
    /** @returns {Record<string, number>} candidates per state */
    counts() {
      /** @type {Record<string, number>} */
      const out = {};
      for (const c of byId.values()) out[c.state] = (out[c.state] ?? 0) + 1;
      return out;
    },
    /**
     * Remove candidates matching a predicate; returns their ids.
     * @param {(c: Candidate) => boolean} pred
     * @returns {string[]}
     */
    remove(pred) {
      const gone = [];
      for (const c of byId.values()) if (pred(c)) gone.push(c.id);
      for (const id of gone) byId.delete(id);
      if (gone.length > 0) ordered = null;
      return gone;
    },
    /** @returns {Map<string, Candidate[]>} folded candidates by partition day */
    byDay() {
      /** @type {Map<string, Candidate[]>} */
      const out = new Map();
      for (const c of byId.values()) {
        const list = out.get(c.day) ?? [];
        list.push(c);
        out.set(c.day, list);
      }
      return out;
    },
    size: () => byId.size,
  };
}

// ---------------------------------------------------------------------------------------------
// Ledger units
// ---------------------------------------------------------------------------------------------

/**
 * @param {unknown} err
 * @returns {string | null}
 */
function errText(err) {
  if (err === null || err === undefined) return null;
  /** @type {string} */
  let text;
  if (err instanceof Error) {
    const code = /** @type {{code?: unknown}} */ (err).code;
    text = `${err.name}${code ? ` (${String(code)})` : ''}: ${err.message}`;
  } else if (typeof err === 'string') text = err;
  else {
    try {
      text = JSON.stringify(err);
    } catch {
      text = String(err);
    }
  }
  const safe = redact(text);
  return safe.length > ERR_CHARS ? `${safe.slice(0, ERR_CHARS - 1)}…` : safe;
}

/**
 * In-memory ledger (§3.12): the latest event of each unit.
 */
export function createLedgerState() {
  /** @type {Map<string, Unit>} */
  const units = new Map();

  /**
   * @param {string} key
   * @param {Unit | undefined} prev
   * @param {Partial<Unit>} fields
   * @param {string} at
   * @returns {Unit}
   */
  const make = (key, prev, fields, at) => /** @type {Unit} */ ({
    v: 1,
    key,
    stage: prev?.stage ?? stageOf(key),
    state: 'planned',
    attempts: prev?.attempts ?? 0,
    at,
    runId: prev?.runId ?? null,
    out: null,
    err: null,
    nextAt: null,
    ...fields,
  });

  /**
   * @param {string} key
   */
  const checkKey = (key) => {
    if (typeof key !== 'string' || key === '') throw new StoreError('A ledger key is required', 'EINVALID');
  };

  return {
    /** @param {any} u */
    apply(u) {
      if (u && typeof u === 'object' && typeof u.key === 'string') units.set(u.key, u);
    },
    /** @param {string} key */
    get: (key) => clone(units.get(key) ?? null),
    /** @param {string} key */
    isDone: (key) => units.get(key)?.state === 'done',
    /**
     * @param {string} key
     * @param {string | undefined} stage
     * @param {string | null | undefined} runId
     * @param {string} at
     * @returns {Unit}
     */
    start(key, stage, runId, at) {
      checkKey(key);
      const prev = units.get(key);
      const u = make(key, prev, {
        stage: stage ?? prev?.stage ?? stageOf(key), state: 'running', attempts: (prev?.attempts ?? 0) + 1,
        runId: runId ?? null,
      }, at);
      units.set(key, u);
      return clone(u);
    },
    /**
     * @param {string} key
     * @param {Record<string, unknown> | null | undefined} out
     * @param {string} at
     * @returns {Unit}
     */
    done(key, out, at) {
      checkKey(key);
      const prev = units.get(key);
      const u = make(key, prev, {
        state: 'done', attempts: Math.max(prev?.attempts ?? 0, 1), out: out ? clone(out) : null,
      }, at);
      units.set(key, u);
      return clone(u);
    },
    /**
     * @param {string} key
     * @param {unknown} err
     * @param {string} at
     * @returns {Unit}
     */
    fail(key, err, at) {
      checkKey(key);
      const prev = units.get(key);
      const attempts = Math.max(prev?.attempts ?? 0, 1);
      const nextAt = attempts < UNIT_MAX_ATTEMPTS
        ? new Date(toMs(at) + UNIT_BACKOFF_MS * 2 ** attempts).toISOString()
        : null;
      const u = make(key, prev, { state: 'failed', attempts, err: errText(err), nextAt }, at);
      units.set(key, u);
      return clone(u);
    },
    /**
     * @param {string} key
     * @param {string | undefined} stage
     * @param {string} at
     * @returns {Unit}
     */
    plan(key, stage, at) {
      checkKey(key);
      const prev = units.get(key);
      const u = make(key, prev, {
        stage: stage ?? prev?.stage ?? stageOf(key), state: 'planned', runId: null,
      }, at);
      units.set(key, u);
      return clone(u);
    },
    /**
     * Whether a unit may be started now: not done, not running, and if it failed, its back-off has
     * passed and it has attempts left.
     * @param {string} key
     * @param {string} nowIso
     * @returns {boolean}
     */
    canStart(key, nowIso) {
      const u = units.get(key);
      if (!u) return true;
      if (u.state === 'done' || u.state === 'running') return false;
      if (u.state === 'failed') {
        if (u.attempts >= UNIT_MAX_ATTEMPTS) return false;
        return u.nextAt === null || Date.parse(u.nextAt) <= toMs(nowIso);
      }
      return true;
    },
    /**
     * Units matching a filter, sorted by key.
     * @param {{state?: string | string[], stage?: string, prefix?: string}} [filter]
     * @returns {Unit[]}
     */
    list({ state, stage, prefix } = {}) {
      const states = state === undefined ? null : new Set(Array.isArray(state) ? state : [state]);
      return [...units.values()]
        .filter((u) => (!states || states.has(u.state)) && (stage === undefined || u.stage === stage)
          && (prefix === undefined || u.key.startsWith(prefix)))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((u) => clone(u));
    },
    /**
     * Keys of `running` units that belong to another run (a dead one, once the lock is ours).
     * @param {string} runId
     * @returns {string[]}
     */
    orphans(runId) {
      return [...units.values()].filter((u) => u.state === 'running' && u.runId !== runId).map((u) => u.key);
    },
    size: () => units.size,
  };
}

// ---------------------------------------------------------------------------------------------
// Owner memory and verdicts
// ---------------------------------------------------------------------------------------------

/**
 * Merge an owner memory update into what is known: flags only accumulate (`farm` and `streak` are
 * permanent, §3.11), other fields take the newer value when it is present.
 * @param {OwnerMemory | undefined} prev
 * @param {Partial<OwnerMemory> & {login: string}} next
 * @param {string} at
 * @returns {OwnerMemory}
 */
export function mergeOwner(prev, next, at) {
  const flags = [...new Set([...(prev?.flags ?? []), ...(Array.isArray(next.flags) ? next.flags : [])])];
  const fresh = typeof next.evidence === 'string' && next.evidence !== '';
  const evidence = fresh ? /** @type {string} */ (next.evidence) : prev?.evidence ?? '';
  return {
    v: 1,
    login: next.login ?? prev?.login,
    type: next.type ?? prev?.type ?? 'User',
    flags,
    evidence,
    publicRepos: typeof next.publicRepos === 'number' ? next.publicRepos : prev?.publicRepos ?? 0,
    checkedAt: next.checkedAt ?? at,
  };
}

/**
 * In-memory owner memory keyed by lower-cased login.
 */
export function createOwnerState() {
  /** @type {Map<string, OwnerMemory>} */
  const byLogin = new Map();
  return {
    /**
     * Fold a stored record (merging, so permanent flags survive).
     * @param {any} m
     */
    apply(m) {
      if (!m || typeof m.login !== 'string') return;
      const k = m.login.toLowerCase();
      byLogin.set(k, mergeOwner(byLogin.get(k), m, m.checkedAt ?? ''));
    },
    /** @param {string} login */
    get: (login) => clone(byLogin.get(String(login ?? '').toLowerCase()) ?? null),
    /**
     * @param {Partial<OwnerMemory> & {login: string}} m
     * @param {string} at
     * @returns {OwnerMemory}
     */
    put(m, at) {
      if (!m || typeof m.login !== 'string' || m.login === '') {
        throw new StoreError('Owner memory needs a login', 'EINVALID');
      }
      const k = m.login.toLowerCase();
      const merged = mergeOwner(byLogin.get(k), m, at);
      byLogin.set(k, merged);
      return clone(merged);
    },
    /** @returns {OwnerMemory[]} */
    all: () => [...byLogin.values()].map((m) => clone(m)),
  };
}

/**
 * @typedef {object} VerdictKey
 * @property {string} [id]
 * @property {string | null} [headOid]
 * @property {string} [rubric]
 * @property {string} [backend]
 * @property {string | null} [model]
 */

/** Fields of the verdict cache key (§3.11), in key-string order. */
const VERDICT_KEY_FIELDS = /** @type {const} */ (['id', 'headOid', 'rubric', 'backend', 'model']);

/**
 * One field as it appears in a key string: a missing head is `HEAD` (as `src/core/verdict.mjs`
 * writes it), any other missing field is empty.
 * @param {string} field
 * @param {unknown} value
 * @returns {string}
 */
function keyPart(field, value) {
  const missing = value === null || value === undefined || value === '';
  if (field === 'headOid') return missing ? 'HEAD' : String(value);
  return missing ? '' : String(value);
}

/**
 * The cache key of a verdict (§3.11): `id|headOid|rubric|backend|model`, the same string
 * `src/core/verdict.mjs#verdictKey` builds.
 * @param {VerdictKey} v
 * @returns {string}
 */
export function verdictKey(v) {
  return VERDICT_KEY_FIELDS.map((f) => keyPart(f, v?.[f])).join('|');
}

/**
 * @param {string | VerdictKey} key
 * @returns {VerdictKey}
 */
function parseVerdictKey(key) {
  if (typeof key !== 'string') return key ?? {};
  const parts = key.split('|');
  /** @type {Record<string, string>} */
  const out = {};
  VERDICT_KEY_FIELDS.forEach((f, i) => {
    if (parts[i] !== undefined) out[f] = parts[i];
  });
  return out;
}

/**
 * In-memory verdicts, in append order.
 */
export function createVerdictState() {
  /** @type {Verdict[]} */
  const list = [];
  return {
    /** @param {any} v */
    apply(v) {
      if (v && typeof v === 'object' && typeof v.id === 'string') list.push(v);
    },
    /**
     * The latest verdict matching a key: a string `id|headOid|rubric|backend|model`, or an object
     * whose present fields must all match (so `{id}` gives the latest verdict of a repository).
     * @param {string | VerdictKey} key
     * @returns {Verdict | null}
     */
    get(key) {
      const want = parseVerdictKey(key);
      const fields = VERDICT_KEY_FIELDS.filter((f) => want[f] !== undefined);
      for (let i = list.length - 1; i >= 0; i--) {
        const v = list[i];
        if (fields.every((f) => keyPart(f, v[f]) === keyPart(f, want[f]))) return clone(v);
      }
      return null;
    },
    /** @returns {Verdict[]} */
    all: () => list.map((v) => clone(v)),
  };
}
