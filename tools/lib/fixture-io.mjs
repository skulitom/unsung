// @ts-check
/**
 * Shared helpers for the fixture tools (WP0): fixture naming, JSON output, UTF-8-safe
 * truncation, and the README excerpt that keeps every fixture within the 8 KB README cap of
 * DESIGN §14.2 without changing what the §5.3 and §7.2 rules see.
 *
 * Why an excerpt rather than a plain cut: a plain 8 KB cut removed the second code block from
 * 16 of the 49 long research READMEs, which would flip `q.usage` on 11 genuine repositories and
 * break the §5.3 evidence counts. The excerpt keeps the first 4 KB exactly (the template, spam
 * and script rules read the start), then keeps later lines by priority, in their original order:
 * every fence line, lines that matter to a gate (clone URLs, archive links, file hosts, HTML
 * comments, invisible characters, reviewer-addressing and drainer phrases, gambling words), the
 * opening lines of each fenced block, the rest of the fenced blocks, and then prose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root (tools/lib/ → ../..). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Default fixture directory. */
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');
/** README text cap for every fixture (§14.2). */
export const README_CAP = 8192;
/** Bytes at the start of a long README that are kept verbatim. */
export const README_HEAD = 4096;
/** Workflow and manifest text cap (§4.1, §3.6). */
export const TEXT_CAP = 16384;

/** Lines of a long README that a gate or slop rule could read (see module comment). */
const SALIENT = new RegExp([
  'git clone', 'pass(word)?\\s*[:=]', '<!--', '-->',
  '[\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\uFEFF]',
  'send \\d', 'wallet', 'ignore (all )?(previous|prior|above) instructions',
  '(rate|score|rank) this (repo|repository|project)', 'as an? (ai|llm|language model)',
  'you are (chatgpt|claude|an ai)',
  '\\.(zip|rar|7z|exe|msi|dmg|apk|scr|bat|cmd|ps1|vbs|jar)\\b',
  'mediafire\\.com|mega\\.nz|dropbox\\.com|cdn\\.discordapp\\.com|t\\.me/|gofile\\.io',
  'pixeldrain\\.com|bit\\.ly|tinyurl\\.com|is\\.gd|cutt\\.ly',
  '\\b(slot|gacor|judi|togel|casino|maxwin|situs|bandar|jackpot|toto|poker)\\b',
].join('|'), 'i');

/**
 * `owner/name` → `owner__name` (original case), the fixture directory name.
 * @param {string} nwo
 * @returns {string}
 */
export function fixtureDirName(nwo) {
  const [owner, name, ...rest] = nwo.split('/');
  if (!owner || !name || rest.length) throw new Error(`Not an owner/name pair: ${nwo.slice(0, 120)}`);
  return `${owner}__${name}`;
}

/**
 * UTF-8-safe truncation to at most `maxBytes` bytes.
 * @param {string} s
 * @param {number} maxBytes
 * @returns {{text: string, truncated: boolean}}
 */
export function truncateUtf8(s, maxBytes) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return { text: buf.subarray(0, cut).toString('utf8'), truncated: true };
}

/**
 * @param {string} s
 * @returns {number}
 */
export function byteLength(s) {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * True for a fence line (§5.3 `q.usage`: trimmed start is three backticks or tildes).
 * @param {string} line
 * @returns {boolean}
 */
export function isFenceLine(line) {
  const t = line.trimStart();
  return t.startsWith('```') || t.startsWith('~~~');
}

/**
 * @typedef {{text: string, excerpt: boolean, originalBytes: number, keptBytes: number}} Excerpt
 */

/**
 * Cap README text at `cap` bytes, keeping what the signals and gates read (module comment).
 * The result is the text itself when it already fits.
 * @param {string} text
 * @param {{cap?: number, headBytes?: number}} [opts]
 * @returns {Excerpt}
 */
export function readmeExcerpt(text, opts = {}) {
  const cap = opts.cap ?? README_CAP;
  const headBytes = Math.min(opts.headBytes ?? README_HEAD, cap);
  const originalBytes = byteLength(text);
  if (originalBytes <= cap) return { text, excerpt: false, originalBytes, keptBytes: originalBytes };

  const head = truncateUtf8(text, headBytes).text;
  // The line the head cuts through is dropped; later lines are candidates.
  const nl = text.indexOf('\n', head.length);
  const lines = nl === -1 ? [] : text.slice(nl + 1).split('\n');
  let inFence = head.split('\n').filter(isFenceLine).length % 2 === 1;

  /** @type {number[]} */ const fences = [];
  /** @type {number[]} */ const salient = [];
  /** @type {number[][]} */ const blocks = [];
  /** @type {number[]} */ const prose = [];
  /** @type {number[] | null} */ let block = inFence ? [] : null;
  if (block) blocks.push(block);
  lines.forEach((line, i) => {
    if (isFenceLine(line)) {
      fences.push(i);
      inFence = !inFence;
      block = inFence ? [] : null;
      if (block) blocks.push(block);
      return;
    }
    if (SALIENT.test(line)) salient.push(i);
    else if (block) block.push(i);
    else prose.push(i);
  });

  let budget = cap - byteLength(head);
  /** @type {(string | null)[]} */
  const keep = lines.map(() => null);
  /**
   * @param {number} i
   * @param {number} maxLine
   */
  const take = (i, maxLine) => {
    if (keep[i] !== null) return;
    const s = truncateUtf8(lines[i], maxLine).text;
    const cost = byteLength(s) + 1;
    if (cost > budget) return;
    keep[i] = s;
    budget -= cost;
  };
  for (const i of fences) take(i, 200);
  for (const i of salient) take(i, 512);
  for (const b of blocks) for (const i of b.slice(0, 3)) take(i, 400);
  for (const b of blocks) for (const i of b.slice(3)) take(i, 400);
  for (const i of prose) take(i, 2048);

  const out = head + keep.filter((s) => s !== null).map((s) => `\n${s}`).join('');
  const capped = truncateUtf8(out, cap).text;
  return { text: capped, excerpt: true, originalBytes, keptBytes: byteLength(capped) };
}

/**
 * Write JSON with a trailing newline, creating directories. `compact` drops indentation.
 * @param {string} file
 * @param {unknown} value
 * @param {{compact?: boolean}} [opts]
 */
export function writeJson(file, value, opts = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = opts.compact ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  fs.writeFileSync(file, `${text}\n`, 'utf8');
}

/**
 * Read JSON, or return `fallback` when the file does not exist.
 * @template T
 * @param {string} file
 * @param {T} fallback
 * @returns {any}
 */
export function readJsonIf(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return fallback;
    throw err;
  }
}

/**
 * Deterministic PRNG (mulberry32), the tools' own copy.
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
