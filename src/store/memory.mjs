// @ts-check
/**
 * The in-memory `Store` (DESIGN §12.3): the same behaviour as the file store, with nothing written
 * anywhere. Used by tests, the end-to-end run and anything that needs a throwaway store.
 */

import { archiveHourMs, createStore } from './base.mjs';
import { clone, monthOf } from './common.mjs';

/** @typedef {import('./base.mjs').Backend} Backend */
/** @typedef {import('./base.mjs').Store} Store */

/**
 * @returns {Backend & {rawCandidateLines: () => any[]}}
 */
function memoryBackend() {
  /** @type {Map<string, any[]>} */
  const partitions = new Map();
  /** @type {any[]} */
  let units = [];
  /** @type {any[]} */
  let owners = [];
  /** @type {any[]} */
  const verdicts = [];
  /** @type {any[]} */
  const feedback = [];
  /** @type {Map<string, any>} */
  const repos = new Map();
  /** @type {Map<string, any>} */
  const docs = new Map();
  /** @type {Map<string, any>} */
  const runs = new Map();
  /** @type {any[]} */
  const summaries = [];
  /** @type {Map<string, {entry: any, usedMs: number}>} */
  const http = new Map();
  /** @type {Map<string, any>} */
  const trees = new Map();
  /** @type {Map<string, any>} */
  const files = new Map();
  /** @type {Map<string, any[]>} */
  const archive = new Map();
  /** @type {{pid: number, runId: string, startedAt: string} | null} */
  let lock = null;

  return {
    kind: 'memory',
    dir: null,
    loadCandidateLines: () => [...partitions.keys()].sort().flatMap((d) => clone(partitions.get(d) ?? [])),
    appendCandidateLines(day, lines) {
      const list = partitions.get(day) ?? [];
      list.push(...clone(lines));
      partitions.set(day, list);
    },
    rewriteCandidatePartitions(byDay, { before, changedDays }) {
      let count = 0;
      for (const day of [...partitions.keys()]) {
        if (day >= before) continue;
        const lines = partitions.get(day) ?? [];
        const folded = lines.every((l) => l.patch !== true);
        if (folded && !changedDays.has(day)) continue;
        const list = byDay.get(day) ?? [];
        if (list.length === 0) partitions.delete(day);
        else partitions.set(day, clone(list));
        count++;
      }
      return { partitions: count, gzipped: count };
    },
    rawCandidateLines: () => [...partitions.keys()].sort().flatMap((d) => clone(partitions.get(d) ?? [])),
    loadUnits: () => clone(units),
    appendUnit(u) {
      units.push(clone(u));
    },
    collapseUnits(beforeMonth) {
      const old = units.filter((u) => monthOf(u.at) < beforeMonth);
      const last = new Map(old.map((u) => [u.key, u]));
      const kept = new Set(last.values());
      const before = units.length;
      units = units.filter((u) => monthOf(u.at) >= beforeMonth || kept.has(u));
      return before - units.length;
    },
    loadOwners: () => clone(owners),
    appendOwner(m) {
      owners.push(clone(m));
    },
    rewriteOwners(all) {
      owners = clone(all);
      return owners.length;
    },
    loadVerdicts: () => clone(verdicts),
    appendVerdict(v) {
      verdicts.push(clone(v));
    },
    appendFeedback(ev) {
      feedback.push(clone(ev));
    },
    readFeedback: () => clone(feedback),
    readRepo: (key) => clone(repos.get(key) ?? null),
    writeRepo(key, rec) {
      repos.set(key, clone(rec));
    },
    deleteRepo: (key) => repos.delete(key),
    listRepoKeys: () => [...repos.keys()].sort(),
    scanRepoIds: () => new Map([...repos.entries()].map(([key, rec]) => [rec.id, key])),
    readDoc: (name) => clone(docs.get(name) ?? null),
    writeDoc(name, value) {
      docs.set(name, clone(value));
    },
    writeRun(runId, m) {
      runs.set(runId, clone(m));
    },
    readRun: (runId) => clone(runs.get(runId) ?? null),
    appendRunSummary(s) {
      summaries.push(clone(s));
    },
    readRunSummaries: () => clone(summaries),
    httpGet(name, nowMs) {
      const hit = http.get(name);
      if (!hit) return null;
      hit.usedMs = nowMs;
      return clone(hit.entry);
    },
    httpPut(name, entry, nowMs) {
      http.set(name, { entry: clone(entry), usedMs: nowMs });
    },
    deleteHttpUnused(cutoffMs) {
      let n = 0;
      for (const [name, hit] of http) {
        if (hit.usedMs < cutoffMs) {
          http.delete(name);
          n++;
        }
      }
      return n;
    },
    treeGet: (sha) => clone(trees.get(sha) ?? null),
    treePut(sha, tree) {
      trees.set(sha, clone(tree));
    },
    filesGet: (idSeg, oid) => clone(files.get(`${idSeg}/${oid}`) ?? null),
    filesPut(idSeg, oid, value) {
      files.set(`${idSeg}/${oid}`, clone(value));
    },
    writeArchive(name, events, append) {
      const list = append ? archive.get(name) ?? [] : [];
      list.push(...clone(events));
      archive.set(name, list);
    },
    readArchive: (name) => clone(archive.get(name) ?? null),
    deleteArchiveBefore(cutoffMs) {
      let n = 0;
      for (const name of [...archive.keys()]) {
        if (archiveHourMs(name) < cutoffMs) {
          archive.delete(name);
          n++;
        }
      }
      return n;
    },
    readLock: () => clone(lock),
    createLock(rec) {
      if (lock) return false;
      lock = clone(rec);
      return true;
    },
    removeLock() {
      lock = null;
    },
    // Everything in a memory store lives in this process, so a held lock is always live.
    isAlive: () => true,
  };
}

/**
 * Create an in-memory store with the full `Store` interface.
 * @param {{now?: () => string | number | Date, log?: import('../log.mjs').Log}} [opts]
 * @returns {Store & {rawCandidateLines: () => Promise<any[]>}}
 */
export function createMemoryStore({ now, log } = {}) {
  const backend = memoryBackend();
  const store = createStore(backend, { now, log });
  return Object.assign(store, {
    /**
     * Every Candidate and CandidatePatch line as stored, unfolded (for inspection and tests).
     * @returns {Promise<any[]>}
     */
    async rawCandidateLines() {
      return backend.rawCandidateLines();
    },
  });
}
