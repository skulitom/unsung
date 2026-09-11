// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clamp, daysBetween, fnv1a, isoWeek, logit, mulberry32, normaliseWs, parseDuration, sampleN, sat, sigmoid,
  stableStringify, truncateUtf8,
} from '../src/core/util.mjs';

test('sat saturates logarithmically at T (§6.5)', () => {
  assert.equal(sat(0, 25), 0);
  assert.equal(sat(-3, 25), 0);
  assert.equal(sat(25, 25), 1);
  assert.equal(sat(400, 25), 1);
  assert.ok(Math.abs(sat(5, 25) - Math.log(6) / Math.log(26)) < 1e-12);
  assert.throws(() => sat(1, 0), RangeError);
});

test('clamp', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
  assert.equal(clamp(0.25, 0, 1), 0.25);
});

test('sigmoid and logit are inverse and stable', () => {
  assert.equal(sigmoid(0), 0.5);
  assert.equal(sigmoid(1000), 1);
  assert.equal(sigmoid(-1000), 0);
  assert.ok(Math.abs(logit(sigmoid(1.3)) - 1.3) < 1e-12);
  assert.equal(logit(0), -Infinity);
  // The §6.2 table: Q = σ(−6.403 + 1.113·S).
  const q = (/** @type {number} */ s) => Math.round(100 * sigmoid(-6.403 + 1.113 * s)) / 100;
  assert.deepEqual([3, 4, 5, 6, 7, 8, 9].map(q), [0.04, 0.12, 0.30, 0.57, 0.80, 0.92, 0.97]);
});

test('isoWeek follows ISO-8601 week numbering in UTC', () => {
  assert.equal(isoWeek('2026-09-11T00:00:00Z'), '2026-W37');
  assert.equal(isoWeek('2026-01-01'), '2026-W01');
  assert.equal(isoWeek('2021-01-03T23:59:59Z'), '2020-W53');
  assert.equal(isoWeek('2024-12-30T00:00:00Z'), '2025-W01');
  assert.equal(isoWeek(Date.UTC(2026, 8, 7)), '2026-W37');
  assert.equal(isoWeek(new Date('2026-09-13T23:00:00Z')), '2026-W37');
  assert.throws(() => isoWeek('not a date'), RangeError);
});

test('daysBetween is b − a in fractional days', () => {
  assert.equal(daysBetween('2026-09-01T00:00:00Z', '2026-09-11T12:00:00Z'), 10.5);
  assert.equal(daysBetween('2026-09-11T00:00:00Z', '2026-09-10T00:00:00Z'), -1);
  assert.throws(() => daysBetween('nope', '2026-09-10T00:00:00Z'), RangeError);
});

test('fnv1a matches the published 32-bit test vectors', () => {
  assert.equal(fnv1a(''), 0x811c9dc5);
  assert.equal(fnv1a('a'), 0xe40c292c);
  assert.equal(fnv1a('foobar'), 0xbf9cf968);
  assert.equal(typeof fnv1a('é'), 'number');
});

test('stableStringify sorts keys recursively and keeps array order', () => {
  const a = { b: 1, a: { d: 2, c: [3, { f: 1, e: 2 }] }, u: undefined };
  const b = { a: { c: [3, { e: 2, f: 1 }], d: 2 }, b: 1 };
  assert.equal(stableStringify(a), '{"a":{"c":[3,{"e":2,"f":1}],"d":2},"b":1}');
  assert.equal(stableStringify(a), stableStringify(b));
  assert.equal(stableStringify([2, 1]), '[2,1]');
  assert.equal(stableStringify({ b: 1, a: 2 }, 1), '{\n "a": 2,\n "b": 1\n}');
});

test('truncateUtf8 never splits a code point', () => {
  assert.deepEqual(truncateUtf8('hello', 10), { text: 'hello', truncated: false });
  assert.deepEqual(truncateUtf8('hello', 5), { text: 'hello', truncated: false });
  assert.deepEqual(truncateUtf8('hello', 3), { text: 'hel', truncated: true });
  assert.deepEqual(truncateUtf8('héllo', 2), { text: 'h', truncated: true });
  assert.deepEqual(truncateUtf8('😀x', 3), { text: '', truncated: true });
  assert.deepEqual(truncateUtf8('😀x', 4), { text: '😀', truncated: true });
  assert.deepEqual(truncateUtf8('日本語', 7), { text: '日本', truncated: true });
  assert.deepEqual(truncateUtf8('abc', 0), { text: '', truncated: true });
  const big = 'é'.repeat(40000);
  const cut = truncateUtf8(big, 32768);
  assert.equal(new TextEncoder().encode(cut.text).length, 32768);
  assert.equal(cut.truncated, true);
});

test('normaliseWs collapses Unicode whitespace', () => {
  assert.equal(normaliseWs('  a\n\t b c  d  '), 'a b c d');
  assert.equal(normaliseWs(''), '');
});

test('parseDuration accepts units and combinations', () => {
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('1h 30m'), 5_400_000);
  assert.equal(parseDuration('1.5h'), 5_400_000);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('45s'), 45_000);
  assert.equal(parseDuration('2d'), 172_800_000);
  assert.equal(parseDuration('1w'), 604_800_000);
  assert.equal(parseDuration(' 10M '), 600_000);
  assert.equal(parseDuration('0'), 0);
  assert.equal(parseDuration(1234), 1234);
  for (const bad of ['10', 'abc', '', '10m foo', '-5m', 'm10']) {
    assert.throws(() => parseDuration(bad), RangeError, bad);
  }
  assert.throws(() => parseDuration(-1), RangeError);
});

test('mulberry32 is deterministic and uniform-ish', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  assert.ok(Math.abs(mean - 0.5) < 0.05);
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
  assert.equal(mulberry32('run-1')(), mulberry32(fnv1a('run-1'))());
});

test('sampleN draws without replacement and leaves the input alone', () => {
  const arr = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const s = sampleN(arr, 4, mulberry32(7));
  assert.equal(s.length, 4);
  assert.equal(new Set(s).size, 4);
  assert.ok(s.every((x) => arr.includes(x)));
  assert.deepEqual(s, sampleN(arr, 4, mulberry32(7)));
  assert.deepEqual(sampleN(arr, 50, mulberry32(1)).sort((x, y) => x - y), [...arr]);
  assert.deepEqual(sampleN(arr, 0, mulberry32(1)), []);
  assert.deepEqual(sampleN([], 3, mulberry32(1)), []);
});
