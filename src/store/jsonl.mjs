// @ts-check
/**
 * JSON Lines and atomic JSON files (DESIGN §4.1, §12.3).
 *
 * - One record per line, UTF-8, `\n`. Lines are split by hand, never with `readline`, which also
 *   breaks at U+2028 and would corrupt records holding that character.
 * - Readers skip lines that fail to parse (a crash can leave a partial last line) and report them
 *   through `onBadLine`. Appenders first finish such a partial line with a newline, so a new record
 *   is never glued onto it.
 * - Atomic writes go to `<file>.tmp-<pid>-<rand>`, are fsynced, then renamed over the target
 *   (retried briefly on Windows, where a reader holding the target open makes rename fail).
 *
 * Writes are synchronous underneath: the store relies on each write being complete, in order,
 * before the next one starts. The async exports simply wrap them.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';

/**
 * @typedef {(line: string, lineNo: number, error: Error) => void} BadLineHandler
 *   called once per line that is not valid JSON; the line is skipped
 */

/** Error codes on which a rename over an existing file is retried (Windows sharing violations). */
const RETRY_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * @param {string} file
 */
function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

/**
 * @param {unknown} records
 * @returns {unknown[]}
 */
function asArray(records) {
  return Array.isArray(records) ? records : [records];
}

/**
 * Block the thread for a few milliseconds (only used between rename retries).
 * @param {number} ms
 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serialise records as JSON Lines text, each line ending in `\n`.
 * @param {unknown} records one record or an array of them
 * @returns {string}
 */
export function toJsonl(records) {
  return asArray(records).map((r) => `${JSON.stringify(r)}\n`).join('');
}

/**
 * Whether a non-empty file lacks its final newline.
 * @param {string} file
 * @returns {boolean}
 */
function endsWithoutNewline(file) {
  /** @type {number} */
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return false;
    throw err;
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append records to a JSON Lines file, creating it and its directory as needed.
 * @param {string} file
 * @param {unknown} records one record or an array
 * @returns {number} how many records were written
 */
export function appendJsonlSync(file, records) {
  const list = asArray(records);
  if (list.length === 0) return 0;
  ensureDir(file);
  const text = toJsonl(list);
  fs.appendFileSync(file, endsWithoutNewline(file) ? `\n${text}` : text, 'utf8');
  return list.length;
}

/**
 * Append records to a JSON Lines file (async form of `appendJsonlSync`).
 * @param {string} file
 * @param {unknown} records one record or an array
 * @returns {Promise<number>}
 */
export async function appendJsonl(file, records) {
  return appendJsonlSync(file, records);
}

/**
 * Parse one line; undefined for a blank or bad line.
 * @param {string} raw
 * @param {number} lineNo
 * @param {BadLineHandler | undefined} onBadLine
 * @returns {unknown}
 */
function parseLine(raw, lineNo, onBadLine) {
  const line = lineNo === 1 && raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  if (line.trim() === '') return undefined;
  try {
    return JSON.parse(line);
  } catch (err) {
    onBadLine?.(line, lineNo, err instanceof Error ? err : new Error(String(err)));
    return undefined;
  }
}

/**
 * Read a JSON Lines file, plain or gzipped (by the `.gz` extension), streaming. A missing file
 * yields nothing.
 * @param {string} file
 * @param {{onBadLine?: BadLineHandler}} [opts]
 * @returns {AsyncGenerator<any>}
 */
export async function* readJsonl(file, { onBadLine } = {}) {
  if (!fs.existsSync(file)) return;
  const raw = fs.createReadStream(file);
  /** @type {AsyncIterable<Buffer>} */
  const input = file.endsWith('.gz') ? raw.pipe(zlib.createGunzip()) : raw;
  const decoder = new TextDecoder('utf-8');
  let rest = '';
  let lineNo = 0;
  for await (const chunk of input) {
    const parts = (rest + decoder.decode(chunk, { stream: true })).split('\n');
    rest = /** @type {string} */ (parts.pop());
    for (const part of parts) {
      lineNo++;
      const rec = parseLine(part, lineNo, onBadLine);
      if (rec !== undefined) yield rec;
    }
  }
  rest += decoder.decode();
  if (rest.length > 0) {
    lineNo++;
    const rec = parseLine(rest, lineNo, onBadLine);
    if (rec !== undefined) yield rec;
  }
}

/**
 * Read a whole JSON Lines file (plain or `.gz`) into an array. A missing file gives `[]`.
 * @param {string} file
 * @param {{onBadLine?: BadLineHandler}} [opts]
 * @returns {any[]}
 */
export function readJsonlSync(file, { onBadLine } = {}) {
  /** @type {Buffer} */
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return [];
    throw err;
  }
  const text = (file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8');
  /** @type {any[]} */
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rec = parseLine(lines[i], i + 1, onBadLine);
    if (rec !== undefined) out.push(rec);
  }
  return out;
}

/**
 * Write bytes or text atomically: temporary file, fsync, rename over the target.
 * @param {string} file
 * @param {string | Uint8Array} data
 */
export function writeFileAtomicSync(file, data) {
  ensureDir(file);
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    if (typeof data === 'string') fs.writeSync(fd, data, null, 'utf8');
    else fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? '';
      if (attempt < 8 && RETRY_RENAME.has(code)) {
        sleepSync(5 * 2 ** attempt);
        continue;
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        // The temporary file is gone already.
      }
      throw err;
    }
  }
}

/**
 * Write a value as JSON, atomically.
 * @param {string} file
 * @param {unknown} value
 * @param {{space?: number}} [opts]
 */
export function writeJsonAtomicSync(file, value, { space } = {}) {
  writeFileAtomicSync(file, `${JSON.stringify(value, null, space)}\n`);
}

/**
 * Write a value as JSON, atomically (async form).
 * @param {string} file
 * @param {unknown} value
 * @param {{space?: number}} [opts]
 * @returns {Promise<void>}
 */
export async function writeJsonAtomic(file, value, opts) {
  writeJsonAtomicSync(file, value, opts);
}

/**
 * Replace a JSON Lines file atomically, optionally gzipped.
 * @param {string} file
 * @param {unknown[]} records
 * @param {{gzip?: boolean}} [opts]
 */
export function writeJsonlAtomicSync(file, records, { gzip = false } = {}) {
  const text = toJsonl(records);
  writeFileAtomicSync(file, gzip ? zlib.gzipSync(Buffer.from(text, 'utf8')) : text);
}

/**
 * Replace a JSON Lines file atomically, optionally gzipped (async form).
 * @param {string} file
 * @param {unknown[]} records
 * @param {{gzip?: boolean}} [opts]
 * @returns {Promise<void>}
 */
export async function writeJsonlAtomic(file, records, opts) {
  writeJsonlAtomicSync(file, records, opts);
}

/**
 * Read a JSON file (plain, or gzipped by the `.gz` extension); `fallback` when it does not exist.
 * A file that exists but is not JSON throws an error with code `EBADJSON`.
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {any | T}
 */
export function readJsonSync(file, fallback) {
  /** @type {Buffer} */
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return fallback;
    throw err;
  }
  const text = (file.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8');
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const e = new Error(`${path.basename(file)} is not valid JSON: ${why}`);
    throw Object.assign(e, { code: 'EBADJSON' });
  }
}

/**
 * Read a JSON file; `fallback` when it does not exist (async form of `readJsonSync`).
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {Promise<any | T>}
 */
export async function readJson(file, fallback) {
  return readJsonSync(file, fallback);
}

/**
 * Write a value as gzipped JSON, atomically.
 * @param {string} file
 * @param {unknown} value
 */
export function writeJsonGzAtomicSync(file, value) {
  writeFileAtomicSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8')));
}
