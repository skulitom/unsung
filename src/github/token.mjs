// @ts-check
/**
 * The GitHub token (DESIGN §3.9): `GITHUB_TOKEN`, else `GH_TOKEN`, else `gh auth token`. The token
 * is held in memory only and registered with `redact()` the moment it is read; it is never written
 * to `data/`, never put in a URL, never passed to a child process and never shown in an error.
 */

import { execFileSync } from 'node:child_process';
import { registerSecret } from '../secrets.mjs';

/** Environment variables consulted, in order. */
export const TOKEN_ENV = Object.freeze(['GITHUB_TOKEN', 'GH_TOKEN']);

/** How long `gh auth token` may take. */
export const GH_TIMEOUT_MS = 5000;

/** No usable token: the CLI exits 2 (§3.12). */
export class TokenError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'TokenError';
    this.code = 'ETOKEN';
    this.exitCode = 2;
  }
}

/**
 * @typedef {(file: string, args: string[], opts: object) => string | Buffer} Exec
 *   `execFileSync`-shaped; never given a shell
 */

/**
 * Find the token. Synchronous; callers may `await` it all the same.
 * @param {object} [opts]
 * @param {Record<string, string | undefined>} [opts.env] default `process.env`
 * @param {Exec} [opts.exec] default `execFileSync` (tests inject a fake)
 * @returns {{token: string, source: 'GITHUB_TOKEN' | 'GH_TOKEN' | 'gh'}}
 */
export function getToken({ env = process.env, exec = execFileSync } = {}) {
  for (const name of TOKEN_ENV) {
    const raw = env[name];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value) {
      registerSecret(value);
      return { token: value, source: /** @type {'GITHUB_TOKEN' | 'GH_TOKEN'} */ (name) };
    }
  }
  /** @type {string | Buffer} */
  let out;
  try {
    out = exec('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: GH_TIMEOUT_MS,
    });
  } catch (err) {
    // The child's message and output are deliberately not repeated: they could carry the token.
    const code = /** @type {{code?: unknown}} */ (err)?.code;
    if (code === 'ENOENT') throw new TokenError('No GitHub token: install GitHub CLI or set GITHUB_TOKEN');
    if (code === 'ETIMEDOUT') {
      throw new TokenError('`gh auth token` did not answer within 5 s: '
        + 'run `gh auth login` or set GITHUB_TOKEN');
    }
    throw new TokenError('GitHub CLI has no token: run `gh auth login` or set GITHUB_TOKEN');
  }
  const token = String(out ?? '').trim();
  if (!token) {
    throw new TokenError('`gh auth token` printed nothing: run `gh auth login` or set GITHUB_TOKEN');
  }
  registerSecret(token);
  return { token, source: 'gh' };
}
