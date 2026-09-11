// @ts-check
/**
 * Logging (DESIGN §12.1, §16). Every string that reaches the stream — messages, field values and
 * the finished line — passes through `redact()`, so no token can be logged by accident. Logs go to
 * stderr by default; `--json` switches to one JSON object per line.
 */

import { redact } from './secrets.mjs';

/** Numeric severity of each level; `silent` suppresses everything. */
export const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40, silent: 100 });

/** @typedef {'debug' | 'info' | 'warn' | 'error' | 'silent'} LogLevel */
/** @typedef {Record<string, unknown>} Fields */

/**
 * @typedef {object} Log
 * @property {LogLevel} level
 * @property {(level: LogLevel) => boolean} enabled whether a line at `level` would be written
 * @property {(msg: string, fields?: Fields) => void} debug
 * @property {(msg: string, fields?: Fields) => void} info
 * @property {(msg: string, fields?: Fields) => void} warn
 * @property {(msg: string, fields?: Fields) => void} error
 * @property {(name: string, fields?: Fields) => void} stage one progress line per pipeline stage
 *   (§9.2). In text mode `fields.text` is the line's body (else the other fields as `key=value`)
 *   and `fields.ms` a duration printed at the end, such as `2m 15s`. Logged at level info.
 */

/**
 * @typedef {object} LogOptions
 * @property {LogLevel} [level] default `info`
 * @property {boolean} [json] one JSON object per line instead of text
 * @property {{write(chunk: string): unknown}} [stream] default `process.stderr`
 * @property {() => string} [now] ISO timestamp for JSON lines; defaults to the system clock
 */

/**
 * Copy a value for logging: strings redacted, errors reduced to name/code/message, cycles and
 * excessive depth cut.
 * @param {unknown} value
 * @param {WeakSet<object>} seen
 * @param {number} depth
 * @returns {unknown}
 */
function clean(value, seen, depth) {
  if (typeof value === 'string') return redact(value);
  const kind = typeof value;
  if (kind === 'bigint' || kind === 'symbol' || kind === 'function') return String(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : 'Invalid Date';
  if (value instanceof Error) {
    /** @type {Record<string, unknown>} */
    const err = { name: value.name, message: redact(value.message) };
    const code = /** @type {{code?: unknown}} */ (value).code;
    if (code !== undefined) err.code = clean(code, seen, depth + 1);
    return err;
  }
  if (seen.has(value)) return '[Circular]';
  if (depth >= 8) return '[Too deep]';
  seen.add(value);
  /** @type {unknown} */
  let out;
  if (Array.isArray(value)) out = value.map((v) => clean(v, seen, depth + 1));
  else {
    /** @type {Record<string, unknown>} */
    const o = {};
    for (const [k, v] of Object.entries(value)) o[redact(k)] = clean(v, seen, depth + 1);
    out = o;
  }
  seen.delete(value);
  return out;
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function textValue(v) {
  if (typeof v === 'string') return /^[^\s"'=]+$/.test(v) ? v : JSON.stringify(v);
  if (v === undefined) return 'undefined';
  if (v === null || typeof v !== 'object') return String(v);
  return JSON.stringify(v);
}

/**
 * Format a duration for stage lines: `0m 25s`, `4m 05s`, `1h 02m`, or `850ms` under a second.
 * @param {number} ms
 * @returns {string}
 */
export function formatMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = Math.round(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * Create a logger.
 * @param {LogOptions} [opts]
 * @returns {Log}
 */
export function createLog({ level = 'info', json = false, stream, now } = {}) {
  if (!(level in LEVELS)) throw new TypeError(`Unknown log level '${String(level)}'`);
  const out = stream ?? process.stderr;
  const clock = now ?? (() => new Date().toISOString());
  const threshold = LEVELS[level];

  /** @param {string} line */
  const write = (line) => {
    try {
      out.write(`${redact(line)}\n`);
    } catch {
      // A closed stream (EPIPE) must never take the process down.
    }
  };

  /**
   * @param {Exclude<LogLevel, 'silent'>} lvl
   * @param {string | null} msg
   * @param {Fields | undefined} fields
   * @param {string | null} stageName
   */
  const emit = (lvl, msg, fields, stageName) => {
    if (LEVELS[lvl] < threshold) return;
    const f = /** @type {Record<string, unknown>} */ (clean(fields ?? {}, new WeakSet(), 0) ?? {});
    if (json) {
      /** @type {Record<string, unknown>} */
      const rec = { at: clock(), level: lvl };
      if (stageName !== null) rec.stage = redact(stageName);
      if (msg !== null) rec.msg = redact(msg);
      for (const [k, v] of Object.entries(f)) if (!(k in rec)) rec[k] = v;
      write(JSON.stringify(rec));
      return;
    }
    if (stageName !== null) {
      const { text, ms, ...rest } = f;
      const body = typeof text === 'string'
        ? text
        : Object.entries(rest).map(([k, v]) => `${k}=${textValue(v)}`).join(' ');
      const tail = typeof ms === 'number' ? `  ${formatMs(ms)}` : '';
      write(`${redact(stageName).padEnd(10)} ${body}${tail}`.trimEnd());
      return;
    }
    const prefix = { debug: 'debug: ', info: '', warn: 'warning: ', error: 'error: ' }[lvl];
    const pairs = Object.entries(f).map(([k, v]) => `${k}=${textValue(v)}`).join(' ');
    write(`${prefix}${redact(msg ?? '')}${pairs ? ` ${pairs}` : ''}`);
  };

  return {
    level,
    enabled: (lvl) => lvl !== 'silent' && LEVELS[lvl] >= threshold,
    debug: (msg, fields) => emit('debug', String(msg), fields, null),
    info: (msg, fields) => emit('info', String(msg), fields, null),
    warn: (msg, fields) => emit('warn', String(msg), fields, null),
    error: (msg, fields) => emit('error', String(msg), fields, null),
    stage: (name, fields) => emit('info', null, fields, String(name)),
  };
}
