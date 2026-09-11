// @ts-check
/**
 * Secret redaction (DESIGN §3.9). Every log line, error message, run manifest and HTTP-cache key
 * passes through `redact()`, which removes registered secrets and anything shaped like a GitHub
 * token. Registered secrets live in memory only and are never written anywhere.
 */

/** Replacement text for anything redacted. */
export const REDACTED = '[REDACTED]';

/** GitHub token shapes (§3.9): classic `gh?_` tokens and fine-grained `github_pat_` tokens. */
const TOKEN_PATTERN = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;

/**
 * Secrets shorter than this are ignored: redacting a two-letter string would shred every log line,
 * and no real token or API key is this short.
 */
const MIN_SECRET_LENGTH = 8;

/** @type {Set<string>} */
const secrets = new Set();

/** @type {string[]} registered secrets, longest first, so a secret containing another wins */
let ordered = [];

/**
 * Register a secret so `redact()` removes it from every string. Blank, non-string and very short
 * values (under 8 characters) are ignored. The URL-encoded form is registered as well when it
 * differs.
 * @param {unknown} value
 * @returns {void}
 */
export function registerSecret(value) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length < MIN_SECRET_LENGTH) return;
  secrets.add(trimmed);
  const encoded = encodeURIComponent(trimmed);
  if (encoded !== trimmed) secrets.add(encoded);
  ordered = [...secrets].sort((a, b) => b.length - a.length);
}

/**
 * Forget every registered secret. Intended for tests.
 * @returns {void}
 */
export function clearSecrets() {
  secrets.clear();
  ordered = [];
}

/**
 * Replace every registered secret and every GitHub-token-shaped substring with `[REDACTED]`.
 * Non-string input is converted with `String()` first; `null` and `undefined` become `''`.
 * @param {unknown} text
 * @returns {string}
 */
export function redact(text) {
  let out = text === null || text === undefined ? '' : typeof text === 'string' ? text : String(text);
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  return out.replace(TOKEN_PATTERN, REDACTED);
}
