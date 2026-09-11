// @ts-check
/**
 * Small pure helpers shared by every layer (DESIGN §12.1). Nothing here touches the network, the
 * file system, the clock or randomness: time and seeds are always parameters.
 */

const DAY_MS = 86_400_000;

/**
 * Logarithmic saturation: 0 at `x ≤ 0`, rising to 1 at `x ≥ T` (§6.5:
 * `log(1 + x) / log(1 + max(x, T))`).
 * @param {number} x
 * @param {number} T saturation point, > 0
 * @returns {number}
 */
export function sat(x, T) {
  if (!(T > 0)) throw new RangeError('Saturation point must be greater than zero');
  if (!(x > 0)) return 0;
  return Math.log1p(x) / Math.log1p(Math.max(x, T));
}

/**
 * Clamp `x` into `[lo, hi]`.
 * @param {number} x
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * Logistic function `1 / (1 + e^(−z))`, numerically stable for large |z|.
 * @param {number} z
 * @returns {number}
 */
export function sigmoid(z) {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * Inverse of `sigmoid`: `ln(p / (1 − p))`. Returns ±Infinity at 0 and 1.
 * @param {number} p probability in [0, 1]
 * @returns {number}
 */
export function logit(p) {
  return Math.log(p / (1 - p));
}

/**
 * Milliseconds since the epoch of an ISO string, a Date or a number.
 * @param {string | number | Date} t
 * @returns {number}
 */
function toMs(t) {
  const ms = typeof t === 'number' ? t : t instanceof Date ? t.getTime() : Date.parse(t);
  if (!Number.isFinite(ms)) throw new RangeError(`Not a valid time: ${String(t).slice(0, 40)}`);
  return ms;
}

/**
 * ISO-8601 week of a timestamp, as `YYYY-Www` (UTC), e.g. `2026-W37` for 11 September 2026.
 * @param {string | number | Date} iso
 * @returns {string}
 */
export function isoWeek(iso) {
  const d = new Date(toMs(iso));
  const day = d.getUTCDay() || 7; // Monday 1 … Sunday 7
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 4 - day);
  const year = new Date(thursday).getUTCFullYear();
  const week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/**
 * Days from `a` to `b` (`b − a`), fractional; negative when `b` is earlier.
 * @param {string | number | Date} a
 * @param {string | number | Date} b
 * @returns {number}
 */
export function daysBetween(a, b) {
  return (toMs(b) - toMs(a)) / DAY_MS;
}

/**
 * 32-bit FNV-1a hash of the UTF-8 bytes of a string, as an unsigned integer.
 * @param {string} s
 * @returns {number}
 */
export function fnv1a(s) {
  const bytes = new TextEncoder().encode(String(s));
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * `JSON.stringify` with object keys sorted recursively, so equal values always serialise to the
 * same text (cache keys, hashes, golden files). Arrays keep their order.
 * @param {unknown} v
 * @param {number | string} [space]
 * @returns {string}
 */
export function stableStringify(v, space) {
  return JSON.stringify(v, (_key, val) => {
    if (!isPlainObject(val)) return val;
    /** @type {Record<string, unknown>} */
    const sorted = {};
    for (const k of Object.keys(val).sort()) sorted[k] = val[k];
    return sorted;
  }, space);
}

/**
 * Truncate a string to at most `bytes` UTF-8 bytes without splitting a code point (§4.1).
 * @param {string} s
 * @param {number} bytes
 * @returns {{text: string, truncated: boolean}}
 */
export function truncateUtf8(s, bytes) {
  const text = String(s ?? '');
  const limit = Math.max(0, Math.floor(bytes));
  // Fast path: every UTF-16 code unit encodes to at most 3 bytes.
  if (text.length * 3 <= limit) return { text, truncated: false };
  const buf = new TextEncoder().encode(text);
  if (buf.length <= limit) return { text, truncated: false };
  let cut = limit;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return { text: new TextDecoder().decode(buf.subarray(0, cut)), truncated: true };
}

/**
 * Collapse every run of whitespace (Unicode-aware, line and paragraph separators included) to one
 * space and trim both ends.
 * @param {string} s
 * @returns {string}
 */
export function normaliseWs(s) {
  return String(s ?? '').replace(/\s+/gu, ' ').trim();
}

/** @type {Record<string, number>} */
const DURATION_UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: DAY_MS, w: 7 * DAY_MS };

/**
 * Parse a duration such as `500ms`, `30s`, `10m`, `2h`, `1d`, `1w`, `1.5h` or `1h30m` into
 * milliseconds. A number is taken to be milliseconds already. The only unitless string accepted is
 * `0`. Throws a RangeError for anything else.
 * @param {string | number} s
 * @returns {number}
 */
export function parseDuration(s) {
  if (typeof s === 'number') {
    if (!Number.isFinite(s) || s < 0) throw new RangeError(`Not a valid duration: ${s}`);
    return Math.round(s);
  }
  const text = String(s ?? '').trim().toLowerCase();
  if (text === '0') return 0;
  const re = /(\d+(?:\.\d+)?|\.\d+)\s*(ms|s|m|h|d|w)/gy;
  let total = 0;
  let pos = 0;
  let parts = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    total += Number(m[1]) * DURATION_UNITS[m[2]];
    pos = re.lastIndex;
    parts++;
    while (text[pos] === ' ') pos++;
    re.lastIndex = pos;
  }
  if (parts === 0 || pos !== text.length) {
    throw new RangeError(`Not a valid duration: '${String(s).slice(0, 40)}' (use a unit, such as 10m or 2h)`);
  }
  return Math.round(total);
}

/**
 * Mulberry32 seeded generator: returns a function yielding floats in [0, 1). A string seed is
 * hashed with `fnv1a` first.
 * @param {number | string} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = (typeof seed === 'string' ? fnv1a(seed) : Math.floor(Number(seed) || 0)) >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Uniform sample of `min(n, arr.length)` items without replacement (partial Fisher–Yates on a
 * copy). The input is never modified; the result is in draw order.
 * @template T
 * @param {readonly T[]} arr
 * @param {number} n
 * @param {() => number} rand generator yielding floats in [0, 1)
 * @returns {T[]}
 */
export function sampleN(arr, n, rand) {
  const copy = arr.slice();
  const k = Math.max(0, Math.min(Math.floor(n), copy.length));
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rand() * (copy.length - i));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, k);
}
