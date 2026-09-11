// @ts-check
/**
 * The README's account of a quick run and of `explain`. The quick profile's numbers must match
 * config/defaults.json; the GH Archive lane and the deeper look must not be promised beyond what a
 * ten-minute budget allows (the review of the first live run found an early README promising more);
 * and `explain` must not be credited with the evidence links only the explorer shows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** @param {string} rel */
const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const README = read('README.md');
const DEFAULTS = JSON.parse(read('config/defaults.json'));
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * The text of a `## ` section, with its whitespace folded.
 * @param {string} title
 * @returns {string}
 */
function section(title) {
  const start = README.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `the README has a "${title}" section`);
  const end = README.indexOf('\n## ', start + 4);
  return README.slice(start, end < 0 ? undefined : end).replace(/\s+/g, ' ');
}

test('the quick-start section describes the quick profile without over-promising', () => {
  const quick = DEFAULTS.profiles.quick;
  const text = section('Quick start');
  const minutes = Number(/^(\d+)m$/.exec(String(quick.budget))?.[1]);
  assert.match(text, new RegExp(`${WORDS[minutes]}-minute budget`));
  assert.match(text, new RegExp(`up to the last ${WORDS[quick.archiveHours]} hours of release`));
  assert.match(text, new RegExp(`up to ${quick.deepTopN} of the top-ranked`));
  assert.doesNotMatch(text, /looks deeper at the top \d+/, 'the deeper look is not promised');
});

test('explain and the Why panel are both credited with the evidence links they print', () => {
  // `formatExplanation` prints each chip's github.com evidence under it (test/core-explain.test.mjs).
  const text = section('How Unsung decides');
  const claim = /explain owner\/name` prints([^.]*)\./.exec(text);
  assert.ok(claim, 'the README says what explain prints');
  assert.match(claim[1], /link to its evidence at the exact commit that was scored/);
  assert.match(text, /Why panel also links each point to its evidence/);
});
