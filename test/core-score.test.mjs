// @ts-check
/**
 * DESIGN §6 and §12.5 `src/core/score.mjs`: points and coverage, Quality, bands, Confidence,
 * Attention, the rank, the lane rules in order, and `scoreFacts` on the fixtures (the §6.9 row of
 * skulitom/london-time-map, verdict effects, the injection gate, schema validity).
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { validateScore } from '../src/core/schema.mjs';
import {
  DEFAULT_CALIBRATION, attention, band, confidence, contribution, countedIds, gemScore, laneOf, points,
  quality, scoreFacts,
} from '../src/core/score.mjs';
import { SIGNALS } from '../src/core/signals.mjs';
import { fixtureFacts } from '../src/eval/labels.mjs';
import { fixturePath, listRepoFixtures, loadRepoFixture } from './support/fixtures.mjs';

/**
 * @param {string} f
 * @returns {any}
 */
function read(f) {
  return JSON.parse(readFileSync(new URL(`../config/${f}`, import.meta.url), 'utf8'));
}
const weights = read('weights.json');
const calibration = read('calibration.json');
const institutions = read('institutions.json');
const OPTS = { weights, calibration, institutions };

/** @typedef {import('../src/core/schema.mjs').Signal} Signal */

/**
 * A scoring signal for unit tests.
 * @param {string} id
 * @param {number} weight
 * @param {'ok' | 'unknown' | 'na'} status
 * @param {boolean | null} [hit]
 * @param {Partial<Signal>} [extra]
 * @returns {Signal}
 */
function sig(id, weight, status, hit = null, extra = {}) {
  const h = status === 'ok' ? hit === true : null;
  return {
    id, kind: weight < 0 ? 'slop' : 'quality', status, hit: h, value: null, weight, points: h ? weight : 0,
    strength: null, group: null, provisional: false, cost: null, label: id, reason: id, evidence: [],
    ...extra,
  };
}

/**
 * A confidence item for unit tests.
 * @param {string} id
 * @param {string} group
 * @param {number} strength
 * @param {'ok' | 'unknown'} [status]
 * @returns {Signal}
 */
function item(id, group, strength, status = 'ok') {
  const ok = status === 'ok';
  return {
    id, kind: 'confidence', status, hit: ok ? strength > 0 : null, value: null, weight: null, points: null,
    strength: ok ? strength : 0, group, provisional: false, cost: 'costly', label: id, reason: id,
    evidence: [],
  };
}

test('points: hits add their weight; misses, unknowns and na add nothing', () => {
  const signals = [
    sig('a', 1, 'ok', true), sig('b', 1, 'ok', false), sig('c', 1, 'unknown'), sig('d', 1, 'na'),
    sig('e', -2, 'ok', true),
  ];
  assert.deepEqual(points(signals), { S: -1, pointsMax: 3, coverage: 4 / 5 });
});

test('points: within a group only the most negative contribution counts', () => {
  const prose = sig('s.prose', -2, 'ok', true, { group: 'prose' });
  const md = sig('s.mdheavy', -1, 'ok', true, { group: 'prose' });
  assert.equal(points([prose, md]).S, -2);
  assert.equal(points([sig('s.prose', -2, 'ok', false, { group: 'prose' }), md]).S, -1);
  assert.deepEqual([...countedIds([prose, md])], ['s.prose']);
  assert.equal(points([md, prose]).S, -2, 'order does not matter');
  const quiet = sig('s.mdheavy', -1, 'ok', false, { group: 'prose' });
  assert.ok(countedIds([prose, quiet]).has('s.mdheavy'), 'a member that adds nothing is not outweighed');
});

test('points: the judge counts toward S and pointsMax but not toward coverage', () => {
  const judge = { ...sig('llm.review', 1, 'ok', true), kind: /** @type {const} */ ('judge') };
  const base = [sig('a', 1, 'ok', true), sig('b', 1, 'unknown')];
  const without = points(base);
  const withJudge = points([...base, judge]);
  assert.equal(withJudge.S, without.S + 1);
  assert.equal(withJudge.pointsMax, without.pointsMax + 1);
  assert.equal(withJudge.coverage, without.coverage);
  assert.equal(points([sig('x', 1, 'na')]).coverage, 0, 'nothing applicable');
  assert.equal(contribution(sig('a', 1, 'ok', true)), 1);
});

test('points: a signal without its own weight takes the weights file', () => {
  const s = { ...sig('q.licence', 1, 'ok', true), weight: null, points: null };
  assert.equal(points([s], { signals: { 'q.licence': { points: 2 } } }).S, 2);
});

// s.incoherent is the retired signal since weights w2 (§4.4, §5.3).
test('points: a retired signal (weight 0) adds nothing to S, pointsMax or coverage', () => {
  const base = [sig('a', 1, 'ok', true), sig('b', -1, 'ok', false), sig('c', 1, 'unknown')];
  const slop = { kind: /** @type {const} */ ('slop') };
  const retired = [
    sig('s.incoherent', 0, 'ok', true, slop), sig('s.incoherent', 0, 'ok', false, slop),
    sig('s.incoherent', 0, 'unknown', null, slop),
  ];
  for (const r of retired) assert.deepEqual(points([...base, r]), points(base), `${r.status} ${r.hit}`);
  assert.equal(contribution(retired[0]), 0);
});

test('quality follows c1 (§6.2) and defaults to it', () => {
  assert.equal(Math.round(100 * quality(7, calibration)), 80);
  assert.equal(quality(8, null), quality(8, DEFAULT_CALIBRATION));
  assert.ok(Math.abs(quality(8, { a: 0, b: 0 }) - 0.5) < 1e-12);
});

test('bands: gem at 7, look at 5 and 6, low at 4 and below (§6.3)', () => {
  const bands = [10, 7, 6, 5, 4, -3].map((S) => band(S, weights));
  assert.deepEqual(bands, ['gem', 'gem', 'look', 'look', 'low', 'low']);
  assert.equal(band(6, { bands: { gem: 6, look: 3 } }), 'gem');
});

test('confidence: K = 1 − Π(1 − strongest in each group), with bands (§6.4)', () => {
  assert.deepEqual(confidence([item('k.owner', 'owner', 0.3)]), { k: 0.3, band: 'medium' });
  const time = confidence([item('k.time', 'time', 0.25), item('k.pushDays', 'time', 0.4)]);
  assert.deepEqual(time, { k: 0.4, band: 'medium' });
  const four = confidence([item('k.owner', 'owner', 0.3), item('k.pushDays', 'time', 0.4),
    item('k.releases', 'releases', 0.3), item('k.ciVerified', 'ci', 0.15)]);
  assert.equal(four.k, 0.7501);
  assert.equal(four.band, 'high');
  assert.deepEqual(confidence([item('k.owner', 'owner', 0.3, 'unknown')]), { k: 0, band: 'low' });
  assert.equal(confidence([item('k.time', 'time', 0.29)]).band, 'low');
  assert.equal(confidence([item('k.time', 'time', 0.6)]).band, 'high');
});

test('attention: stars, forks, watchers other than the owner, gain4w and A (§6.5)', () => {
  const f = /** @type {any} */ ({ stars: 5, forks: 0, watchers: 1, starHistory: null });
  const a = attention(f, weights);
  assert.deepEqual({ ...a, a: undefined }, { stars: 5, forks: 0, watchers: 0, gain4w: null, a: undefined });
  assert.ok(Math.abs(a.a - Math.log(6) / Math.log(26)) < 1e-9);
  assert.equal(attention(/** @type {any} */ ({ stars: 0, forks: 0, watchers: 0 })).a, 0);
  assert.equal(attention(/** @type {any} */ ({ stars: 20, forks: 10 })).a, 1);
  const history = /** @type {any} */ ({
    stars: null, forks: null, watchers: null, starHistory: { gain4w: 12 },
  });
  assert.equal(attention(history).gain4w, 12);
});

test('the rank: gem = S + 1.5·K − 1.5·A (§6.6)', () => {
  assert.equal(gemScore(8, 0.3, 0, weights), 8.45);
  const fiveStars = attention(/** @type {any} */ ({ stars: 5, forks: 0 })).a;
  const ranked = gemScore(10, 0, fiveStars, weights);
  assert.ok(Math.abs(ranked - 9.2) < 0.05, `a 5-star repository at 10 points ranks about 9.2 (${ranked})`);
  assert.ok(ranked > gemScore(9, 0, 0, weights));
});

/**
 * @param {string} action
 * @returns {import('../src/core/schema.mjs').Gate}
 */
function gate(action) {
  return { id: `g.${action}`, action: /** @type {any} */ (action), reason: action, evidence: [] };
}

test('lanes follow the first matching rule of §6.7', () => {
  const base = { band: /** @type {const} */ ('gem'), k: 0.2, attention: { stars: 0, gain4w: null }, weights };
  const noticed = { stars: 99, gain4w: 50 };
  assert.equal(laneOf({ ...base, gates: [gate('quarantine'), gate('institutional')], gone: true }),
    'quarantine');
  assert.equal(laneOf({ ...base, gates: [gate('institutional')], gone: true }), 'gone');
  assert.equal(laneOf({ ...base, gates: [gate('institutional'), gate('doubt')], attention: noticed }),
    'institutional');
  assert.equal(laneOf({ ...base, attention: { stars: 26, gain4w: 50 } }), 'graduated');
  assert.equal(laneOf({ ...base, attention: { stars: 25, gain4w: 10 }, gates: [gate('doubt')] }), 'rising');
  const doubted = { ...base, attention: { stars: 25, gain4w: 9 }, gates: [gate('doubt')], k: 0.9 };
  assert.equal(laneOf(doubted), 'doubted');
  assert.equal(laneOf({ ...base, k: 0.5 }), 'proven');
  assert.equal(laneOf({ ...base, k: 0.49 }), 'promising');
  assert.equal(laneOf({ ...base, band: 'look', k: 0.9 }), 'look');
  assert.equal(laneOf({ ...base, band: 'low' }), 'low');
  assert.equal(laneOf({ ...base, gates: [gate('drop')] }), 'promising', 'a drop gate names no lane');
});

/**
 * A verdict for tests.
 * @param {Record<string, any>} output
 * @param {string} [status]
 * @returns {any}
 */
function verdict(output, status = 'ok') {
  return {
    v: 1, id: 'R_x', nwo: 'o/x', headOid: null, rubric: 'r1', backend: 'claude-cli', model: 'claude-opus-5',
    at: '2026-09-11T12:00:00Z', status, output, validation: null, effect: null, costUsd: null, usage: null,
    packBytes: null, durationMs: null,
  };
}

/**
 * @param {string} supports
 * @returns {{text: string, path: string, quote: string, supports: string}}
 */
function claim(supports) {
  return { text: 'a claim', path: 'README.md', quote: 'quoted', supports };
}

const PROMOTE = {
  category: 'G', categoryConfidence: 0.9,
  scores: { purpose: 4, craft: 3, verification: 3, honesty: 4, originality: 3 },
  claims: [claim('purpose'), claim('craft')], flags: [], pitch: 'A pitch', audience: 'people', summary: 'S',
  injectionSeen: false,
};
const DEMOTE = {
  ...PROMOTE, category: 'C', categoryConfidence: 0.8,
  scores: { purpose: 2, craft: 2, verification: 1, honesty: 2, originality: 1 },
  claims: [claim('category'), claim('originality')],
};

test('a doubting verdict, or malware_suspect on a valid one, puts the repository in Doubted', () => {
  const base = { band: /** @type {const} */ ('gem'), k: 0.9, attention: { stars: 0, gain4w: null }, weights };
  const malware = { ...PROMOTE, flags: ['malware_suspect'] };
  assert.equal(laneOf({ ...base, verdict: verdict(DEMOTE) }), 'doubted');
  assert.equal(laneOf({ ...base, verdict: verdict(PROMOTE) }), 'proven');
  assert.equal(laneOf({ ...base, verdict: verdict(malware) }), 'doubted');
  assert.equal(laneOf({ ...base, verdict: verdict(malware, 'unsupported') }), 'proven');
});

const london = fixtureFacts(loadRepoFixture('skulitom/london-time-map'));

test('§6.9: skulitom/london-time-map scores 7 then 8, Q 0.92, K 0.30, rank 8.45, promising', () => {
  const enrich = scoreFacts(london.enrich, { ...OPTS, now: london.at });
  const s = scoreFacts(london.facts, { ...OPTS, now: london.at });
  assert.equal(enrich.S, 7);
  assert.equal(s.S, 8);
  assert.equal(Math.round(100 * s.quality), 92);
  assert.equal(s.confidence.k, 0.3);
  assert.equal(s.confidence.band, 'medium');
  assert.equal(s.attention.a, 0);
  assert.equal(s.gem, 8.45);
  assert.equal(s.band, 'gem');
  assert.equal(s.lane, 'promising');
  const hit = (/** @type {string} */ id) => s.signals.find((x) => x.id === id)?.hit;
  assert.equal(hit('p.coherent'), true, 'deep adds p.coherent');
  assert.deepEqual(s.gates, []);
});

test('scoreFacts: registry order with the judge last, model versions, scoring time', () => {
  const s = scoreFacts(london.facts, { ...OPTS, now: london.at });
  assert.deepEqual(s.signals.map((x) => x.id), [...SIGNALS.map((d) => d.id), 'llm.review']);
  assert.deepEqual(s.model, { weights: 'w2', calibration: 'c1', rubric: null });
  assert.equal(s.scoredAt, london.at);
  assert.equal(scoreFacts(london.facts, OPTS).scoredAt, london.facts.fetchedAt, 'now defaults to fetchedAt');
  assert.equal(s.id, london.facts.id);
  assert.equal(s.headOid, london.facts.headOid);
  const judge = s.signals[s.signals.length - 1];
  assert.deepEqual([judge.kind, judge.status, judge.weight, judge.points], ['judge', 'unknown', 0, 0]);
});

test('a verdict moves points by +1 or −2 and a demotion sets Doubted (§8.5)', () => {
  const plain = scoreFacts(london.facts, { ...OPTS, now: london.at });
  const up = scoreFacts(london.facts, { ...OPTS, now: london.at, verdict: verdict(PROMOTE) });
  const down = scoreFacts(london.facts, { ...OPTS, now: london.at, verdict: verdict(DEMOTE) });
  assert.equal(up.S, plain.S + 1);
  assert.equal(up.pointsMax, plain.pointsMax + 1);
  assert.equal(up.coverage, plain.coverage, 'the judge is outside coverage');
  assert.equal(up.model.rubric, 'r1');
  assert.equal(down.S, plain.S - 2);
  assert.equal(down.lane, 'doubted');
  assert.equal(down.pointsMax, plain.pointsMax);
});

const REDTEAM = fixturePath('redteam');

/**
 * @param {string} name
 * @returns {any}
 */
function redteam(name) {
  return JSON.parse(readFileSync(path.join(REDTEAM, name), 'utf8'));
}

test('g.injection disables the judge: lane Doubted and no points change (§7.2)', () => {
  for (const name of ['injection-readme.json', 'injection-zero-width.json', 'injection-html-comment.json']) {
    const fx = redteam(name);
    const plain = scoreFacts(fx.facts, { ...OPTS, now: fx.meta.now });
    const judged = scoreFacts(fx.facts, { ...OPTS, now: fx.meta.now, verdict: verdict(PROMOTE) });
    assert.ok(plain.gates.some((g) => g.id === 'g.injection'), name);
    assert.equal(plain.lane, 'doubted', name);
    assert.equal(judged.S, plain.S, `${name}: the verdict is ignored`);
    const judge = judged.signals.find((x) => x.id === 'llm.review');
    assert.equal(judge?.status, 'unknown');
    assert.match(String(judge?.reason), /disabled/);
    assert.equal(judged.model.rubric, null);
  }
});

test('every fixture scores to a valid Score whose S is the sum of what counts', () => {
  let n = 0;
  /**
   * @param {import('../src/core/schema.mjs').Score} s
   * @param {string} name
   */
  const check = (s, name) => {
    assert.deepEqual(validateScore(s), [], name);
    const counted = countedIds(s.signals, weights);
    const sum = s.signals.filter((x) => counted.has(x.id)).reduce((t, x) => t + contribution(x), 0);
    assert.equal(s.S, sum, name);
    assert.ok(s.coverage >= 0 && s.coverage <= 1, name);
    n++;
  };
  for (const nwo of listRepoFixtures()) {
    const { facts, enrich, at } = fixtureFacts(loadRepoFixture(nwo));
    check(scoreFacts(enrich, { ...OPTS, now: at }), `${nwo} (enrich)`);
    if (facts !== enrich) check(scoreFacts(facts, { ...OPTS, now: at }), `${nwo} (deep)`);
  }
  for (const file of readdirSync(REDTEAM).filter((x) => x.endsWith('.json'))) {
    const fx = redteam(file);
    check(scoreFacts(fx.facts, { ...OPTS, now: fx.meta.now }), `redteam/${file}`);
  }
  assert.ok(n > 170, `${n} scores checked`);
});
