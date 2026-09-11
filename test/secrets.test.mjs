// @ts-check
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, clearSecrets, redact, registerSecret } from '../src/secrets.mjs';

afterEach(() => clearSecrets());

test('redacts every GitHub token shape of §3.9', () => {
  for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_']) {
    const token = `${prefix}A1b2C3d4E5f6G7h8I9j0K1l2`;
    assert.equal(redact(`token ${token} end`), `token ${REDACTED} end`);
  }
  // Built from parts so the source never holds a token-shaped literal that secret scanners flag.
  const pat = 'github_' + 'pat_11ABCDEFG0_abcdefghijklmnopqrstuvwxyz';
  assert.equal(redact(`Authorization: Bearer ${pat}`), `Authorization: Bearer ${REDACTED}`);
  const two = 'a ghp_AAAAAAAAAAAAAAAAAAAAAAAA and ghs_BBBBBBBBBBBBBBBBBBBBBBBB';
  assert.equal(redact(two), `a ${REDACTED} and ${REDACTED}`);
});

test('leaves text that only resembles a token alone', () => {
  assert.equal(redact('ghp_short'), 'ghp_short');
  assert.equal(redact('ghx_AAAAAAAAAAAAAAAAAAAAAAAAAAAA'), 'ghx_AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(redact('plain words, nothing secret'), 'plain words, nothing secret');
});

test('registered secrets are removed wherever they appear, URL-encoded too', () => {
  registerSecret('s3cret-value/with spaces');
  assert.equal(redact('x=s3cret-value/with spaces;'), `x=${REDACTED};`);
  assert.equal(redact(`q=${encodeURIComponent('s3cret-value/with spaces')}`), `q=${REDACTED}`);
  const twice = 's3cret-value/with spaces and s3cret-value/with spaces';
  assert.equal(redact(twice), `${REDACTED} and ${REDACTED}`);
});

test('blank, short and non-string values are ignored', () => {
  registerSecret('');
  registerSecret('   ');
  registerSecret('abc');
  registerSecret(undefined);
  registerSecret(12345678901);
  assert.equal(redact('abc 12345678901'), 'abc 12345678901');
});

test('the longest registered secret wins when one contains another', () => {
  registerSecret('abcdefgh');
  registerSecret('abcdefghijkl');
  assert.equal(redact('abcdefghijkl'), REDACTED);
});

test('non-string input is converted', () => {
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
  assert.equal(redact(42), '42');
  registerSecret('object-secret-1');
  assert.equal(redact({ toString: () => 'has object-secret-1' }), `has ${REDACTED}`);
});

test('clearSecrets forgets registered values', () => {
  registerSecret('forget-me-please');
  clearSecrets();
  assert.equal(redact('forget-me-please'), 'forget-me-please');
});
