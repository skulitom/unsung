// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSignal, validateVerdict } from '../src/core/schema.mjs';
import {
  ADVERSE_CATEGORIES, JUDGE_POINTS, judgePoints, meanScore, verdictBlocksExport, verdictEffect, verdictKey,
  verdictLane, verdictSignal,
} from '../src/core/verdict.mjs';

/**
 * @param {string} supports
 * @param {string} [path]
 * @param {string} [quote]
 */
const claim = (supports, path = 'src/main.rs', quote = 'fn main() { tide::run() }') => ({
  text: `Evidence for ${supports}`, path, quote, supports,
});

/**
 * @param {string} a
 * @param {string} b
 */
const pair = (a, b) => [claim(a), claim(b)];

/**
 * A stored verdict; every claim in `output` counts as verified.
 * @param {Record<string, any>} [output]
 * @param {Record<string, any>} [extra]
 * @returns {any}
 */
function verdict(output = {}, extra = {}) {
  return {
    v: 1, id: 'R_kgDOtest01', nwo: 'octo/tidewatch', headOid: 'abc123def456', rubric: 'r1',
    backend: 'claude-cli', model: 'claude-opus-5', at: '2026-09-11T12:00:00Z', status: 'ok',
    output: {
      category: 'G', categoryConfidence: 0.9,
      scores: { purpose: 4, craft: 3, verification: 3, honesty: 4, originality: 3 },
      claims: [claim('purpose'), claim('verification', 'tests/tide.rs')],
      flags: [], pitch: 'Tide tables offline', audience: 'Sailors', summary: 'Solid.', injectionSeen: false,
      ...output,
    },
    validation: { claimsKept: 2, claimsDropped: 0, problems: [] }, effect: null, costUsd: 0.12,
    usage: { input: 12004, output: 2210 }, packBytes: 41234, durationMs: 53000, ...extra,
  };
}

test('a genuine verdict with mean ≥ 3.0 and two verified claims earns +1', () => {
  const v = verdict();
  assert.deepEqual(verdictEffect(v), {
    points: 1, lane: null, reason: 'Judged genuine (mean 3.4/4) with 2 verified claims',
  });
  const s = verdictSignal(v);
  assert.equal(s.id, 'llm.review');
  assert.equal(s.kind, 'judge');
  assert.equal(s.status, 'ok');
  assert.equal(s.hit, true);
  assert.equal(s.weight, 1);
  assert.equal(s.points, 1);
  assert.deepEqual(validateSignal(s), []);
  assert.equal(s.evidence.length, 2);
  assert.equal(s.evidence[0].url, 'https://github.com/octo/tidewatch/blob/abc123def456/src/main.rs');
  assert.equal(verdictLane(v), null);
});

test('the +1 needs category G and a mean of at least 3.0 (boundary included)', () => {
  const at3 = verdict({ scores: { purpose: 3, craft: 3, verification: 3, honesty: 3, originality: 3 } });
  assert.equal(verdictEffect(at3).points, 1);
  const below = verdict({ scores: { purpose: 3, craft: 3, verification: 3, honesty: 3, originality: 2 } });
  assert.equal(verdictEffect(below).points, 0);
  assert.equal(verdictSignal(below).hit, false);
  assert.deepEqual(validateSignal(verdictSignal(below)), []);
  assert.equal(verdictEffect(verdict({ category: 'W' })).points, 0);
});

test('a confident adverse category backed by a category or originality claim costs −2 and doubts', () => {
  for (const category of ADVERSE_CATEGORIES) {
    for (const supports of ['category', 'originality']) {
      const v = verdict({ category, categoryConfidence: 0.7, claims: [claim('purpose'), claim(supports)] });
      const e = verdictEffect(v);
      assert.equal(e.points, -2, `${category} via ${supports}`);
      assert.equal(e.lane, 'doubted');
      const s = verdictSignal(v);
      assert.equal(s.points, -2);
      assert.equal(s.weight, -2);
      assert.deepEqual(validateSignal(s), []);
    }
  }
});

test('an adverse category below 0.7 confidence, or without a backing claim, has no effect', () => {
  const unsure = verdict({ category: 'C', categoryConfidence: 0.69, claims: pair('purpose', 'category') });
  assert.deepEqual([verdictEffect(unsure).points, verdictEffect(unsure).lane], [0, null]);
  const unbacked = verdict({ category: 'S', categoryConfidence: 0.95, claims: pair('purpose', 'craft') });
  assert.deepEqual([verdictEffect(unbacked).points, verdictEffect(unbacked).lane], [0, null]);
});

test('category X doubts without changing points', () => {
  const v = verdict({ category: 'X', categoryConfidence: 0.5 });
  assert.deepEqual([verdictEffect(v).points, verdictLane(v)], [0, 'doubted']);
});

test('malware_suspect, re_upload and tutorial_clone doubt only when a verified claim backs them', () => {
  for (const flag of ['malware_suspect', 're_upload', 'tutorial_clone']) {
    const backed = verdict({ flags: [flag], claims: [claim('purpose'), claim('category')] });
    assert.equal(verdictLane(backed), 'doubted', flag);
    assert.equal(verdictEffect(backed).points, 0, `${flag}: no points`);
    const unbacked = verdict({ flags: [flag], claims: [claim('purpose'), claim('craft')] });
    assert.equal(verdictLane(unbacked), null, `${flag} without a backing claim`);
  }
  assert.equal(verdictLane(verdict({ flags: ['prompt_ware'], claims: pair('purpose', 'category') })), null);
});

test('injectionSeen doubts and changes no points, whatever the category', () => {
  const genuine = verdict({ injectionSeen: true });
  assert.deepEqual([verdictEffect(genuine).points, verdictLane(genuine)], [0, 'doubted']);
  const s = verdictSignal(genuine);
  assert.equal(s.points, 0);
  assert.equal(s.hit, false);
  assert.deepEqual(validateSignal(s), []);
  const adverse = verdict({
    injectionSeen: true, category: 'C', categoryConfidence: 0.9, claims: pair('category', 'purpose'),
  });
  assert.deepEqual([verdictEffect(adverse).points, verdictLane(adverse)], [0, 'doubted']);
});

test('verdicts that are not ok have no effect and give an unknown signal', () => {
  for (const status of ['unsupported', 'refused', 'error', 'skipped-injection']) {
    const adverse = { category: 'C', categoryConfidence: 1, claims: pair('category', 'category') };
    const v = verdict(adverse, { status });
    const e = verdictEffect(v);
    assert.deepEqual([e.points, e.lane], [0, null], status);
    const s = verdictSignal(v);
    assert.equal(s.status, 'unknown');
    assert.equal(s.hit, null);
    assert.equal(s.points, 0);
    assert.equal(s.weight, 0);
    assert.deepEqual(validateSignal(s), [], status);
    assert.equal(verdictLane(v), null);
  }
});

test('an ok verdict with fewer than two claims has no effect', () => {
  const v = verdict({ claims: [claim('purpose')], injectionSeen: true });
  assert.deepEqual([verdictEffect(v).points, verdictEffect(v).lane], [0, null]);
});

test('no verdict gives an unknown judge signal with weight 0, so it never counts toward pointsMax', () => {
  for (const none of [null, undefined]) {
    const s = verdictSignal(none);
    assert.deepEqual([s.status, s.hit, s.weight, s.points], ['unknown', null, 0, 0]);
    assert.deepEqual(validateSignal(s), []);
    assert.equal(verdictLane(none), null);
    assert.equal(verdictBlocksExport(none), false);
  }
});

test('do_not_promote and malware_suspect block export whatever the status', () => {
  assert.equal(verdictBlocksExport(verdict({ flags: ['do_not_promote'] })), true);
  assert.equal(verdictBlocksExport(verdict({ flags: ['do_not_promote'] }, { status: 'unsupported' })), true);
  assert.equal(verdictBlocksExport(verdict({ flags: ['malware_suspect'] })), true);
  assert.equal(verdictBlocksExport(verdict({ flags: ['tutorial_clone'] })), false);
  assert.equal(verdictBlocksExport(verdict({}, { status: 'refused', output: null })), false);
});

test('the verdict cache key is (id, headOid, rubric, backend, model)', () => {
  assert.equal(verdictKey(verdict()), 'R_kgDOtest01|abc123def456|r1|claude-cli|claude-opus-5');
  assert.equal(verdictKey({ id: 'R_x', headOid: null, rubric: 'r1', backend: 'anthropic-api', model: 'm' }),
    'R_x|HEAD|r1|anthropic-api|m');
  assert.notEqual(verdictKey(verdict()), verdictKey(verdict({}, { model: 'claude-sonnet-5' })));
});

test('the judge points come from weights.json when given; 0 turns the judge off (§8.5 demotion)', () => {
  assert.deepEqual(judgePoints(undefined), { ...JUDGE_POINTS });
  const w = (/** @type {unknown} */ points) => ({ signals: { 'llm.review': { points, kind: 'judge' } } });
  assert.deepEqual(judgePoints(w(0)), { promote: 0, demote: 0 });
  assert.deepEqual(judgePoints(w([1, -2])), { promote: 1, demote: -2 });
  assert.deepEqual(judgePoints(w({ promote: 1, demote: -1 })), { promote: 1, demote: -1 });
  const off = verdictSignal(verdict(), { weights: w(0) });
  assert.deepEqual([off.status, off.hit, off.points], ['ok', false, 0]);
  const adverse = verdict({ category: 'D', categoryConfidence: 0.9, claims: pair('category', 'purpose') });
  assert.equal(verdictEffect(adverse, { weights: w(0) }).lane, 'doubted', 'lanes survive the demotion');
});

test('evidence quotes are cut to 120 characters and paths are encoded', () => {
  const long = 'x'.repeat(300);
  const s = verdictSignal(verdict({ claims: [claim('purpose', 'src/a b#c.rs', long), claim('craft')] }));
  assert.ok(Array.from(/** @type {string} */ (s.evidence[0].quote)).length <= 120);
  assert.match(s.evidence[0].url, /\/blob\/abc123def456\/src\/a%20b%23c\.rs$/);
  assert.deepEqual(validateSignal(s), []);
});

test('meanScore averages the five dimensions', () => {
  assert.equal(meanScore({ purpose: 4, craft: 3, verification: 2, honesty: 4, originality: 2 }), 3);
  assert.equal(meanScore(null), null);
});

test('a verdict record with its effect validates against the §4.3 schema', () => {
  const v = verdict();
  v.effect = verdictEffect(v);
  assert.deepEqual(validateVerdict(v), []);
});
