// @ts-check
/**
 * Parsing and validation of a judge's answer (DESIGN §8.5 steps 1–4): pull the verdict JSON out of
 * a backend's output, enforce the local bounds of §8.4, validate it against the schema, and keep
 * only the claims whose path is a file in the pack and whose quote, whitespace-normalised, appears
 * in that file's pack text. A verdict with fewer than two surviving claims is `unsupported`.
 */

import { validateVerdictOutput } from '../core/schema.mjs';
import { clamp, normaliseWs } from '../core/util.mjs';
import { MIN_CLAIMS } from '../core/verdict.mjs';
import { BOUNDS } from './rubric.mjs';

/** @typedef {import('../core/schema.mjs').VerdictOutput} VerdictOutput */
/** @typedef {import('./pack.mjs').Pack} Pack */

/** A quote shorter than this, once whitespace is normalised, verifies nothing and is dropped. */
export const MIN_QUOTE_CHARS = 8;

const DIMENSIONS = ['purpose', 'craft', 'verification', 'honesty', 'originality'];

/** The backend's output held no usable verdict JSON. */
export class ParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ParseError';
    this.code = 'EPARSE';
  }
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The inside of the first Markdown code fence (```json … ``` or ``` … ```), else the text itself.
 * The closing fence must stand on its own line: a line break followed by ``` cannot occur inside a
 * JSON string, so backticks inside the answer's strings (a quoted install block, a summary that
 * mentions fences) never end the fence early.
 * @param {string} text
 * @returns {string}
 */
export function stripFence(text) {
  const s = String(text ?? '');
  const m = /```[\w-]*[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/.exec(s);
  return m ? m[1] : s;
}

/**
 * The last character before `i` that is not white space, or '' at the start of the text.
 * @param {string} s
 * @param {number} i
 * @returns {string}
 */
function charBefore(s, i) {
  let j = i - 1;
  while (j >= 0 && /\s/.test(s[j])) j--;
  return j >= 0 ? s[j] : '';
}

/**
 * Parse the first balanced `{…}` in a text that is valid JSON, skipping braces inside strings.
 * Once an opening brace is found that never closes (a truncated answer), a later brace in a value
 * position (after `:`, `,`, `[` or `{`) belongs to that unfinished object and is not tried, so a
 * truncated answer is a ParseError rather than one of its nested objects.
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function firstJsonObject(text) {
  const s = String(text ?? '');
  let unclosed = false;
  for (let start = s.indexOf('{'); start >= 0; start = s.indexOf('{', start + 1)) {
    const prev = charBefore(s, start);
    if (unclosed && prev !== '' && ':,[{'.includes(prev)) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let closed = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          closed = true;
          try {
            const v = JSON.parse(s.slice(start, i + 1));
            if (isObj(v)) return v;
          } catch {
            // not JSON: try the next opening brace
          }
          break;
        }
      }
    }
    if (!closed) unclosed = true;
  }
  throw new ParseError(unclosed ? 'The answer ends before its JSON object closes'
    : 'The answer holds no JSON object');
}

/**
 * The verdict object in an answer text (§8.5 step 1): the whole text when it is one JSON object;
 * else the first balanced `{…}` inside its first code fence (or in the text when it has none);
 * else, when a fence held something other than the answer, the first balanced `{…}` anywhere.
 * @param {string} text
 * @returns {Record<string, any>}
 */
function parseAnswerText(text) {
  const s = String(text ?? '');
  try {
    const v = JSON.parse(s.trim());
    if (isObj(v)) return v;
  } catch {
    // not a bare JSON object
  }
  const inner = stripFence(s);
  try {
    return firstJsonObject(inner);
  } catch (err) {
    if (inner === s) throw err;
    try {
      return firstJsonObject(s);
    } catch {
      throw err;
    }
  }
}

/**
 * The result object `claude -p --output-format json` prints: the whole of stdout, or failing that
 * the last line of it that parses as a JSON object. Null when there is none.
 * @param {string} stdout
 * @returns {Record<string, any> | null}
 */
export function parseCliEnvelope(stdout) {
  const s = String(stdout ?? '').trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s);
    return isObj(v) ? v : null;
  } catch {
    // fall through to line-by-line
  }
  for (const line of s.split(/\r?\n/).reverse()) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const v = JSON.parse(t);
      if (isObj(v)) return v;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * The verdict object from `claude -p --output-format json` output (§8.5 step 1): the envelope's
 * `.result` text, parsed as one JSON object, else from inside its code fence, else from the first
 * balanced `{…}`. A `structured_output` field (only printed with `--json-schema`, which Unsung no
 * longer passes) is still read first when present. Throws `ParseError` when there is none.
 * @param {string} stdout
 * @returns {Record<string, any>}
 */
export function parseCliOutput(stdout) {
  const env = parseCliEnvelope(stdout);
  if (env) {
    if (isObj(env.structured_output)) return env.structured_output;
    if (typeof env.structured_output === 'string') return parseAnswerText(env.structured_output);
    if (typeof env.result === 'string') return parseAnswerText(env.result);
    if ('category' in env && 'scores' in env) return env;
    throw new ParseError('The claude output has no result');
  }
  return parseAnswerText(String(stdout ?? ''));
}

/**
 * Classify a Messages API response (§8.6): `stop_reason` is checked before any content is read.
 * `refusal` → `refused` with the refusal category; `max_tokens` or anything but `end_turn` →
 * `error`; `end_turn` → the first `text` block (thinking and fallback blocks ignored; after a
 * fallback block, the first text block that follows it) parsed as JSON.
 * @param {any} json the message object
 * @returns {{status: 'ok' | 'refused' | 'error', output?: Record<string, any>,
 *   refusal?: {category: string | null, explanation: string | null}, error?: string}}
 */
export function parseApiResponse(json) {
  if (!isObj(json)) return { status: 'error', error: 'The response is not an object' };
  const stop = json.stop_reason;
  if (stop === 'refusal') {
    const d = isObj(json.stop_details) ? json.stop_details : null;
    return {
      status: 'refused',
      refusal: {
        category: typeof d?.category === 'string' ? d.category : null,
        explanation: typeof d?.explanation === 'string' ? d.explanation.slice(0, 200) : null,
      },
    };
  }
  if (stop === 'max_tokens') {
    return { status: 'error', error: 'The answer reached max_tokens before it ended' };
  }
  if (stop !== 'end_turn') {
    return { status: 'error', error: `Unexpected stop reason: ${String(stop).slice(0, 40)}` };
  }
  const content = Array.isArray(json.content) ? json.content : [];
  let from = 0;
  content.forEach((b, i) => {
    if (b?.type === 'fallback') from = i + 1;
  });
  const block = content.slice(from).find((b) => b?.type === 'text' && typeof b.text === 'string');
  if (!block) return { status: 'error', error: 'The answer has no text block' };
  try {
    return { status: 'ok', output: parseAnswerText(block.text) };
  } catch (err) {
    return { status: 'error', error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Cut a string to `max` characters (code points), keeping a prefix.
 * @param {string} s
 * @param {number} max
 * @returns {string}
 */
function clip(s, max) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join('') : s;
}

/**
 * @param {string} p
 * @returns {string}
 */
function shownPath(p) {
  return JSON.stringify(clip(String(p ?? ''), 80));
}

/**
 * Apply the local bounds of §8.4: strings cut to their caps, scores moved into 1–4,
 * `categoryConfidence` into 0–1, duplicate flags removed, claims beyond twelve dropped.
 * @param {Record<string, any>} output
 * @param {string[]} problems
 * @returns {{value: Record<string, any>, extra: number}}
 */
function applyBounds(output, problems) {
  const o = { ...output };
  for (const [key, max] of /** @type {[string, number][]} */ ([
    ['pitch', BOUNDS.pitch], ['audience', BOUNDS.audience], ['summary', BOUNDS.summary]])) {
    if (typeof o[key] === 'string') {
      const cut = clip(o[key], max);
      if (cut !== o[key]) problems.push(`${key} cut to ${max} characters`);
      o[key] = cut;
    }
  }
  if (isObj(o.scores)) {
    const s = { ...o.scores };
    for (const d of DIMENSIONS) {
      if (typeof s[d] !== 'number' || !Number.isFinite(s[d])) continue;
      const v = clamp(Math.round(s[d]), BOUNDS.scoreMin, BOUNDS.scoreMax);
      if (v !== s[d]) problems.push(`scores.${d} ${s[d]} moved to ${v}`);
      s[d] = v;
    }
    o.scores = s;
  }
  if (typeof o.categoryConfidence === 'number' && Number.isFinite(o.categoryConfidence)) {
    const v = clamp(o.categoryConfidence, BOUNDS.confidenceMin, BOUNDS.confidenceMax);
    if (v !== o.categoryConfidence) problems.push(`categoryConfidence ${o.categoryConfidence} moved to ${v}`);
    o.categoryConfidence = v;
  }
  if (Array.isArray(o.flags)) o.flags = [...new Set(o.flags)];
  let extra = 0;
  if (Array.isArray(o.claims)) {
    if (o.claims.length > BOUNDS.claims) {
      extra = o.claims.length - BOUNDS.claims;
      problems.push(`${extra} claim${extra === 1 ? '' : 's'} beyond the first ${BOUNDS.claims} dropped`);
    }
    o.claims = o.claims.slice(0, BOUNDS.claims).map((c) => {
      if (!isObj(c)) return c;
      const x = { ...c };
      if (typeof x.text === 'string') x.text = clip(x.text, BOUNDS.claimText);
      if (typeof x.quote === 'string') x.quote = clip(x.quote, BOUNDS.quote);
      return x;
    });
  }
  return { value: o, extra };
}

/**
 * Validate a judge's output against the schema, the local bounds and the pack (§8.5 steps 2–4).
 * The returned `output` keeps only verified claims, each with the path as it is in the repository.
 * @param {unknown} output the parsed answer
 * @param {Pick<Pack, 'files'>} pack
 * @returns {{status: 'ok' | 'unsupported' | 'error', output: VerdictOutput | null, kept: number,
 *   dropped: number, problems: string[]}}
 */
export function validateVerdict(output, pack) {
  /** @type {string[]} */
  const problems = [];
  const failed = (/** @type {string[]} */ list) => ({
    status: /** @type {'error'} */ ('error'), output: null, kept: 0, dropped: 0, problems: list,
  });
  if (!isObj(output)) return failed(['The answer is not a JSON object']);
  const { value, extra } = applyBounds(output, problems);
  const errors = validateVerdictOutput(value);
  if (errors.length > 0) return failed([...problems, ...errors.slice(0, 10)]);

  const files = pack?.files ?? [];
  /** @type {Map<string, import('./pack.mjs').PackFile>} */
  const byPath = new Map();
  for (const f of files) {
    if (!byPath.has(f.path)) byPath.set(f.path, f);
    if (!byPath.has(f.realPath)) byPath.set(f.realPath, f);
  }
  /** @type {Map<import('./pack.mjs').PackFile, string>} */
  const normalised = new Map();
  const textOf = (/** @type {import('./pack.mjs').PackFile} */ f) => {
    if (!normalised.has(f)) normalised.set(f, normaliseWs(String(f.text).normalize('NFC')));
    return /** @type {string} */ (normalised.get(f));
  };

  const kept = [];
  let dropped = extra;
  value.claims.forEach((/** @type {any} */ c, /** @type {number} */ i) => {
    const f = byPath.get(c.path) ?? byPath.get(String(c.path).replace(/^\.\//, ''));
    if (!f) {
      dropped++;
      problems.push(`Claim ${i + 1} dropped: ${shownPath(c.path)} is not a file in the pack`);
      return;
    }
    const quote = normaliseWs(String(c.quote).normalize('NFC'));
    if (Array.from(quote).length < MIN_QUOTE_CHARS) {
      dropped++;
      problems.push(`Claim ${i + 1} dropped: its quote is shorter than ${MIN_QUOTE_CHARS} characters`);
      return;
    }
    if (!textOf(f).includes(quote)) {
      dropped++;
      problems.push(`Claim ${i + 1} dropped: its quote is not in ${shownPath(f.path)}`);
      return;
    }
    kept.push({ ...c, path: f.realPath });
  });

  const cleaned = /** @type {VerdictOutput} */ ({ ...value, claims: kept });
  return {
    status: kept.length >= MIN_CLAIMS ? 'ok' : 'unsupported',
    output: cleaned,
    kept: kept.length,
    dropped,
    problems,
  };
}
