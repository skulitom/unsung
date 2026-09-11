// @ts-check
/**
 * The file-system `Store` (DESIGN §4.2, §12.3): `openStore(dir, {now, log})` over a `data/`
 * directory laid out as §4.2 describes.
 *
 *   STORE_VERSION · .lock · units/YYYY-MM.jsonl · runs.jsonl · runs/<runId>.json
 *   candidates/<day>.jsonl[.gz] · repos/<owner>/<name>.json · index.json · feedback.jsonl
 *   taste.json · verdicts.jsonl · owners.jsonl · optout.json · archive/YYYY-MM-DD-H.jsonl
 *   cache/http/<sha1>.json.gz · cache/trees/<sha>.json.gz · cache/files/<id>/<headOid>.json.gz
 *
 * A candidate partition may exist as both `<day>.jsonl.gz` (compacted) and `<day>.jsonl` (lines
 * appended since); readers take the gzipped part first. Records the store cannot parse are skipped
 * and reported once. File names under `cache/files/` hold the node id in hex, because node ids are
 * case-sensitive and Windows file names are not.
 */

import fs from 'node:fs';
import path from 'node:path';
import { STORE_VERSION } from '../core/schema.mjs';
import { archiveHourMs, createStore } from './base.mjs';
import { StoreError, monthOf, pidAlive } from './common.mjs';
import {
  appendJsonlSync, readJsonSync, readJsonlSync, writeFileAtomicSync, writeJsonAtomicSync,
  writeJsonGzAtomicSync, writeJsonlAtomicSync,
} from './jsonl.mjs';

export { LockError, StoreError, DEFAULT_RETENTION, verdictKey } from './common.mjs';

/** @typedef {import('./base.mjs').Backend} Backend */
/** @typedef {import('./base.mjs').Store} Store */
/** @typedef {import('../log.mjs').Log} Log */

const PARTITION = /^(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/;
const MONTH_FILE = /^(\d{4}-\d{2})\.jsonl$/;
const ID_AT_START = /^\{"v":[^,]{0,8},"id":"((?:[^"\\]|\\.){1,200})"/;

/**
 * @param {string} dir
 * @returns {string[]} directory entries, or [] when it does not exist
 */
function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * @param {string} file
 * @returns {boolean} whether a file was removed
 */
function removeFile(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Check `STORE_VERSION` (§4.1): absent → written; higher than ours → refused; lower → refused
 * unless migrating.
 * @param {string} root
 * @param {{migrate?: boolean, log?: Log}} opts
 */
function checkVersion(root, { migrate = false, log }) {
  const file = path.join(root, 'STORE_VERSION');
  /** @type {string | null} */
  let text = null;
  try {
    text = fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== 'ENOENT') throw err;
  }
  if (text === null) {
    writeFileAtomicSync(file, `${STORE_VERSION}\n`);
    return;
  }
  const found = Number(text);
  if (!Number.isInteger(found) || found < 0) {
    const shown = text.slice(0, 20);
    throw new StoreError(`${file} does not hold a store version (found '${shown}')`, 'ESTOREVERSION', 2);
  }
  if (found > STORE_VERSION) {
    const msg = `This data directory was written by a newer Unsung (store version ${found}; this one reads `
      + `${STORE_VERSION}). Upgrade Unsung or use another --data directory.`;
    throw new StoreError(msg, 'ESTOREVERSION', 2);
  }
  if (found < STORE_VERSION) {
    if (!migrate) {
      throw new StoreError(`This data directory uses store version ${found}; run 'unsung compact --migrate' `
        + 'to bring it up to date.', 'ESTOREOLD', 2);
    }
    log?.info('Migrated the data directory', { from: found, to: STORE_VERSION });
    writeFileAtomicSync(file, `${STORE_VERSION}\n`);
  }
}

/**
 * @param {string} root absolute data directory
 * @param {Log | undefined} log
 * @returns {Backend & {rawCandidateLines: () => any[]}}
 */
function fileBackend(root, log) {
  /** @param {...string} parts */
  const P = (...parts) => path.join(root, ...parts);
  const candDir = P('candidates');
  const unitDir = P('units');
  let bad = 0;
  const onBadLine = () => {
    bad++;
  };
  /** @param {string} where */
  const reportBad = (where) => {
    if (bad > 0) log?.warn(`Skipped ${bad} unreadable line${bad === 1 ? '' : 's'} in ${where}`);
    bad = 0;
  };
  /**
   * @param {string} file
   * @param {string} where
   * @returns {any[]}
   */
  const readLines = (file, where) => {
    const out = readJsonlSync(file, { onBadLine });
    reportBad(where);
    return out;
  };
  /**
   * @param {string} file
   * @returns {any}
   */
  const readDocSafe = (file) => {
    try {
      return readJsonSync(file, null);
    } catch (err) {
      if (/** @type {{code?: string}} */ (err).code !== 'EBADJSON') throw err;
      log?.warn(`Ignoring an unreadable file: ${path.relative(root, file)}`);
      return null;
    }
  };

  /** @returns {string[]} partition days present on disk, sorted */
  const partitionDays = () => {
    const days = new Set();
    for (const f of listDir(candDir)) {
      const m = PARTITION.exec(f);
      if (m) days.add(m[1]);
    }
    return [...days].sort();
  };
  /** @returns {any[]} */
  const allCandidateLines = () => {
    /** @type {any[]} */
    const out = [];
    for (const day of partitionDays()) {
      for (const f of [`${day}.jsonl.gz`, `${day}.jsonl`]) {
        for (const line of readJsonlSync(path.join(candDir, f), { onBadLine })) out.push(line);
      }
    }
    reportBad('data/candidates');
    return out;
  };

  /** @returns {string[]} month files, sorted */
  const unitMonths = () => listDir(unitDir).filter((f) => MONTH_FILE.test(f)).sort();
  let lastMonth = unitMonths().map((f) => f.slice(0, 7)).pop() ?? '';

  /** @param {string} key */
  const repoFile = (key) => `${path.join(root, 'repos', ...key.split('/'))}.json`;
  /** @param {string} name */
  const httpFile = (name) => P('cache', 'http', `${name}.json.gz`);
  /**
   * @param {string} file
   * @param {number} ms
   */
  const touch = (file, ms) => {
    try {
      const t = new Date(ms);
      fs.utimesSync(file, t, t);
    } catch {
      // Best effort: a failed touch only makes the entry look older to compaction.
    }
  };

  const lockFile = P('.lock');

  /** @returns {string[]} `owner/name` keys (repoPath form) of every record file, sorted */
  const listRepoKeys = () => {
    /** @type {string[]} */
    const keys = [];
    const base = P('repos');
    for (const owner of listDir(base)) {
      const dir = path.join(base, owner);
      /** @type {string[]} */
      let entries;
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        entries = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        if (f.endsWith('.json') && !f.includes('.tmp-')) keys.push(`${owner}/${f.slice(0, -5)}`);
      }
    }
    return keys.sort();
  };

  return {
    kind: 'file',
    dir: root,
    loadCandidateLines: allCandidateLines,
    rawCandidateLines: allCandidateLines,
    appendCandidateLines(day, lines) {
      appendJsonlSync(path.join(candDir, `${day}.jsonl`), lines);
    },
    rewriteCandidatePartitions(byDay, { before, changedDays }) {
      let partitions = 0;
      let gzipped = 0;
      for (const day of partitionDays()) {
        if (day >= before) continue;
        const plain = path.join(candDir, `${day}.jsonl`);
        const gz = `${plain}.gz`;
        if (!fs.existsSync(plain) && !changedDays.has(day)) continue;
        const list = byDay.get(day) ?? [];
        partitions++;
        if (list.length === 0) {
          removeFile(gz);
          removeFile(plain);
          continue;
        }
        // Write the folded partition first: a crash before the plain file is removed leaves lines
        // that fold to the same state again.
        writeJsonlAtomicSync(gz, list, { gzip: true });
        removeFile(plain);
        gzipped++;
      }
      return { partitions, gzipped };
    },
    loadUnits() {
      /** @type {any[]} */
      const out = [];
      for (const f of unitMonths()) {
        for (const u of readJsonlSync(path.join(unitDir, f), { onBadLine })) out.push(u);
      }
      reportBad('data/units');
      return out;
    },
    appendUnit(u) {
      const month = monthOf(u.at);
      if (month > lastMonth) lastMonth = month;
      appendJsonlSync(path.join(unitDir, `${lastMonth}.jsonl`), u);
    },
    collapseUnits(beforeMonth) {
      let removed = 0;
      for (const f of unitMonths()) {
        if (f.slice(0, 7) >= beforeMonth) continue;
        const file = path.join(unitDir, f);
        const events = readLines(file, `data/units/${f}`);
        /** @type {Map<string, any>} */
        const last = new Map();
        for (const u of events) if (u && typeof u.key === 'string') last.set(u.key, u);
        const kept = events.filter((u) => u && last.get(u.key) === u);
        if (kept.length < events.length) {
          writeJsonlAtomicSync(file, kept);
          removed += events.length - kept.length;
        }
      }
      return removed;
    },
    loadOwners: () => readLines(P('owners.jsonl'), 'data/owners.jsonl'),
    appendOwner(m) {
      appendJsonlSync(P('owners.jsonl'), m);
    },
    rewriteOwners(all) {
      if (all.length === 0 && !fs.existsSync(P('owners.jsonl'))) return 0;
      writeJsonlAtomicSync(P('owners.jsonl'), all);
      return all.length;
    },
    loadVerdicts: () => readLines(P('verdicts.jsonl'), 'data/verdicts.jsonl'),
    appendVerdict(v) {
      appendJsonlSync(P('verdicts.jsonl'), v);
    },
    appendFeedback(ev) {
      appendJsonlSync(P('feedback.jsonl'), ev);
    },
    readFeedback: () => readLines(P('feedback.jsonl'), 'data/feedback.jsonl'),
    readRepo: (key) => readDocSafe(repoFile(key)),
    writeRepo(key, rec) {
      // Identity first, so the id can be read from the start of the file (see scanRepoIds).
      writeJsonAtomicSync(repoFile(key), { v: rec.v, id: rec.id, nwo: rec.nwo, ...rec });
    },
    deleteRepo(key) {
      const file = repoFile(key);
      const removed = removeFile(file);
      try {
        fs.rmdirSync(path.dirname(file));
      } catch {
        // The owner directory still holds other repositories.
      }
      return removed;
    },
    listRepoKeys,
    scanRepoIds() {
      /** @type {Map<string, string>} */
      const ids = new Map();
      const head = Buffer.alloc(512);
      for (const key of listRepoKeys()) {
        const file = repoFile(key);
        /** @type {string | null} */
        let id = null;
        try {
          const fd = fs.openSync(file, 'r');
          let n = 0;
          try {
            n = fs.readSync(fd, head, 0, head.length, 0);
          } finally {
            fs.closeSync(fd);
          }
          const m = ID_AT_START.exec(head.subarray(0, n).toString('utf8'));
          id = m ? JSON.parse(`"${m[1]}"`) : readDocSafe(file)?.id ?? null;
        } catch {
          id = null;
        }
        if (typeof id === 'string') ids.set(id, key);
      }
      return ids;
    },
    readDoc: (name) => readDocSafe(P(name)),
    writeDoc(name, value) {
      writeJsonAtomicSync(P(name), value);
    },
    writeRun(runId, m) {
      writeJsonAtomicSync(P('runs', `${runId}.json`), m, { space: 2 });
    },
    readRun: (runId) => readDocSafe(P('runs', `${runId}.json`)),
    appendRunSummary(s) {
      appendJsonlSync(P('runs.jsonl'), s);
    },
    readRunSummaries: () => readLines(P('runs.jsonl'), 'data/runs.jsonl'),
    httpGet(name, nowMs) {
      const file = httpFile(name);
      /** @type {any} */
      let entry = null;
      try {
        entry = readJsonSync(file, null);
      } catch {
        entry = null;
      }
      if (entry) touch(file, nowMs);
      return entry;
    },
    httpPut(name, entry, nowMs) {
      const file = httpFile(name);
      writeJsonGzAtomicSync(file, entry);
      touch(file, nowMs);
    },
    deleteHttpUnused(cutoffMs) {
      let n = 0;
      const dir = P('cache', 'http');
      for (const f of listDir(dir)) {
        const file = path.join(dir, f);
        try {
          if (fs.statSync(file).mtimeMs < cutoffMs && removeFile(file)) n++;
        } catch {
          // Removed meanwhile.
        }
      }
      return n;
    },
    treeGet: (sha) => readDocSafe(P('cache', 'trees', `${sha}.json.gz`)),
    treePut(sha, tree) {
      writeJsonGzAtomicSync(P('cache', 'trees', `${sha}.json.gz`), tree);
    },
    filesGet: (idSeg, oid) => readDocSafe(P('cache', 'files', idSeg, `${oid}.json.gz`)),
    filesPut(idSeg, oid, value) {
      writeJsonGzAtomicSync(P('cache', 'files', idSeg, `${oid}.json.gz`), value);
    },
    writeArchive(name, events, append) {
      const file = P('archive', `${name}.jsonl`);
      if (append) appendJsonlSync(file, events);
      else writeJsonlAtomicSync(file, events);
    },
    readArchive(name) {
      const file = P('archive', `${name}.jsonl`);
      return fs.existsSync(file) ? readLines(file, `data/archive/${name}.jsonl`) : null;
    },
    deleteArchiveBefore(cutoffMs) {
      let n = 0;
      const dir = P('archive');
      for (const f of listDir(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        if (archiveHourMs(f.slice(0, -6)) < cutoffMs && removeFile(path.join(dir, f))) n++;
      }
      return n;
    },
    readLock() {
      /** @type {string} */
      let text;
      try {
        text = fs.readFileSync(lockFile, 'utf8');
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return null;
        throw err;
      }
      try {
        const rec = JSON.parse(text);
        return rec && typeof rec === 'object' ? rec : { pid: 0, runId: '?', startedAt: '' };
      } catch {
        return { pid: 0, runId: '?', startedAt: '' };
      }
    },
    createLock(rec) {
      try {
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(lockFile, `${JSON.stringify(rec)}\n`, { flag: 'wx' });
        return true;
      } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EEXIST') return false;
        throw err;
      }
    },
    removeLock() {
      removeFile(lockFile);
    },
    isAlive: pidAlive,
    reportBadLines(count, what) {
      log?.warn(`Skipped ${count} ${what}`);
    },
  };
}

/**
 * Whether a data directory already holds a store (its `STORE_VERSION`), without creating anything.
 * A dry run and `status` use it so that they never create a data directory (§9.1).
 * @param {string} dir
 * @returns {boolean}
 */
export function hasStore(dir) {
  return typeof dir === 'string' && dir !== '' && fs.existsSync(path.join(path.resolve(dir), 'STORE_VERSION'));
}

/**
 * Open (creating if needed) the file store in `dir`.
 * @param {string} dir the data directory (`--data`, `UNSUNG_DATA`, or `./data`)
 * @param {{now?: () => string | number | Date, log?: Log, migrate?: boolean}} [opts] `migrate`
 *   upgrades an older store version instead of refusing it (`unsung compact --migrate`)
 * @returns {Promise<Store & {rawCandidateLines: () => Promise<any[]>}>}
 */
export async function openStore(dir, { now, log, migrate = false } = {}) {
  if (typeof dir !== 'string' || dir === '') {
    throw new StoreError('A data directory is required', 'EINVALID', 2);
  }
  const root = path.resolve(dir);
  fs.mkdirSync(root, { recursive: true });
  checkVersion(root, { migrate, log });
  const backend = fileBackend(root, log);
  const store = createStore(backend, { now, log });
  return Object.assign(store, {
    /**
     * Every Candidate and CandidatePatch line on disk, unfolded (for inspection and tests).
     * @returns {Promise<any[]>}
     */
    async rawCandidateLines() {
      return backend.rawCandidateLines();
    },
  });
}
