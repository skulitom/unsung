// @ts-check
/**
 * `getToken` (DESIGN §3.9): environment first, then `gh auth token` with an argv array, no shell and
 * a hidden window; the token is registered with `redact()` and never appears in an error.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TokenError, getToken } from '../src/github/token.mjs';
import { clearSecrets, redact } from '../src/secrets.mjs';

const PATTERN_TOKEN = `ghp_${'A1b2C3d4'.repeat(5)}`;
const PLAIN_TOKEN = 'plain-secret-token-value-7731';

/**
 * @param {Record<string, unknown>} props
 * @returns {Error}
 */
function execError(props) {
  return Object.assign(new Error(`Command failed: gh auth token ${PLAIN_TOKEN}`), props);
}

describe('getToken', () => {
  afterEach(() => clearSecrets());

  it('prefers GITHUB_TOKEN, then GH_TOKEN, trimmed, and never runs gh then', () => {
    const exec = () => assert.fail('gh must not run when the environment has a token');
    const env = { GITHUB_TOKEN: ` ${PLAIN_TOKEN}\n`, GH_TOKEN: 'other-token-000' };
    assert.deepEqual(getToken({ env, exec }),
      { token: PLAIN_TOKEN, source: 'GITHUB_TOKEN' });
    assert.deepEqual(getToken({ env: { GITHUB_TOKEN: '   ', GH_TOKEN: PLAIN_TOKEN }, exec }),
      { token: PLAIN_TOKEN, source: 'GH_TOKEN' });
  });

  it('asks `gh auth token` with an argv array, no shell, a hidden window and a 5 s timeout', () => {
    /** @type {{file: string, args: string[], opts: any}[]} */
    const calls = [];
    const exec = (/** @type {string} */ file, /** @type {string[]} */ args, /** @type {any} */ opts) => {
      calls.push({ file, args, opts });
      return `${PLAIN_TOKEN}\n`;
    };
    assert.deepEqual(getToken({ env: {}, exec }), { token: PLAIN_TOKEN, source: 'gh' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'gh');
    assert.deepEqual(calls[0].args, ['auth', 'token']);
    assert.equal(calls[0].opts.windowsHide, true);
    assert.equal(calls[0].opts.timeout, 5000);
    assert.equal(calls[0].opts.encoding, 'utf8');
    assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(calls[0].opts.shell, undefined);
    assert.equal(calls[0].opts.env, undefined, 'gh is not handed an environment of our making');
  });

  it('registers the token with redact(), whatever its shape', () => {
    getToken({ env: { GITHUB_TOKEN: PLAIN_TOKEN } });
    assert.equal(redact(`token=${PLAIN_TOKEN}.`), 'token=[REDACTED].');
    clearSecrets();
    getToken({ env: {}, exec: () => PATTERN_TOKEN });
    assert.equal(redact(`a ${PATTERN_TOKEN} b`), 'a [REDACTED] b');
  });

  it('explains a missing GitHub CLI', () => {
    const exec = () => {
      throw execError({ code: 'ENOENT' });
    };
    assert.throws(() => getToken({ env: {}, exec }), (err) => {
      assert.ok(err instanceof TokenError);
      assert.equal(err.code, 'ETOKEN');
      assert.equal(/** @type {any} */ (err).exitCode, 2);
      assert.match(err.message, /install GitHub CLI or set GITHUB_TOKEN/);
      return true;
    });
  });

  it('explains a logged-out gh, a timeout and empty output', () => {
    assert.throws(() => getToken({ env: {}, exec: () => { throw execError({ status: 1 }); } }),
      /run `gh auth login`/);
    assert.throws(() => getToken({ env: {}, exec: () => { throw execError({ code: 'ETIMEDOUT' }); } }),
      /did not answer within 5 s/);
    assert.throws(() => getToken({ env: {}, exec: () => ' \n' }), /printed nothing/);
  });

  it('never repeats what gh printed, or its error message, in the error', () => {
    const exec = () => {
      throw execError({ status: 1, stdout: PATTERN_TOKEN, stderr: PLAIN_TOKEN });
    };
    try {
      getToken({ env: {}, exec });
      assert.fail('expected a TokenError');
    } catch (err) {
      const text = `${/** @type {Error} */ (err).message} ${String(/** @type {any} */ (err).cause ?? '')}`;
      assert.ok(!text.includes(PLAIN_TOKEN) && !text.includes(PATTERN_TOKEN));
      assert.equal(/** @type {any} */ (err).cause, undefined);
    }
  });
});
