// @ts-check
/**
 * DESIGN §6.8, §6.9 and §13 (WP4): `explain(score, weights)` gives the headline, chips, top
 * reasons, penalties, why not higher, what would raise confidence and the rank line, and every
 * chip, band, lane and rank number of a Score has an explanation.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  LANE_LABELS, TOP_ORDER, explain, formatExplanation, signedPoints, stageLine,
} from '../src/core/explain.mjs';
import { points, scoreFacts } from '../src/core/score.mjs';
import { fixtureFacts } from '../src/eval/labels.mjs';
import { fixturePath, listRepoFixtures, loadJsonFixture, loadRepoFixture } from './support/fixtures.mjs';

/**
 * @param {string} f
 * @returns {any}
 */
function read(f) {
  return JSON.parse(readFileSync(new URL(`../config/${f}`, import.meta.url), 'utf8'));
}
const weights = read('weights.json');
const calibration = read('calibration.json');
const OPTS = { weights, calibration, institutions: read('institutions.json') };

/** @typedef {import('../src/core/schema.mjs').Score} Score */

const london = fixtureFacts(loadRepoFixture('skulitom/london-time-map'));
const score = scoreFacts(london.facts, { ...OPTS, now: london.at });
const ex = explain(score, weights, { calibration });

test('§6.8 and §6.9: the headline, rank and lane of skulitom/london-time-map', () => {
  assert.equal(ex.headline, '8 points · Quality 92 · Confidence medium · 0 stars');
  assert.equal(ex.rankLine, 'Rank 8.45 = 8 points + 0.45 confidence − 0.00 attention');
  assert.equal(ex.pointsLine, '8 of 13 points · evidence coverage 100%');
  assert.ok(ex.qualityLine.startsWith('Quality 92: the estimated share of genuine repositories among '));
  assert.ok(ex.qualityLine.includes('labelled ones with 8 points'));
  assert.match(ex.qualityLine, /149 labels, 9 genuine in the uniform sample/);
  assert.equal(ex.laneLine, 'Promising: in the gem band; confidence 0.30 is below the 0.50 Proven needs');
  assert.equal(ex.bandLine, 'Gem band: 8 points reaches the 7 a gem needs');
  assert.equal(ex.confidenceLine, 'Confidence 0.30 (medium): Owner history 0.30');
});

test('§6.9: why not higher lists a release, CI running tests, releases on two days and tests', () => {
  assert.deepEqual(ex.whyNotHigher.map((h) => h.id),
    ['q.release', 'p.testsRun', 'p.shipped', 'q.tests', 'q.examples']);
  for (const h of ex.whyNotHigher) {
    assert.equal(h.points, 1);
    assert.equal(h.status, 'miss');
    assert.match(h.hint, /^\+1 /);
  }
  assert.deepEqual(ex.top.map((t) => t.id), ['p.coherent', 'q.usage', 'q.ci']);
  assert.deepEqual(ex.negatives, []);
});

test('what would raise confidence: items below their strength, owner history already at 0.30', () => {
  assert.deepEqual(ex.raiseConfidence.map((h) => h.id), ['k.time', 'k.pushDays', 'k.releases', 'k.outsiders',
    'k.ciVerified']);
  for (const h of ex.raiseConfidence) assert.ok(h.strength < h.max && h.hint.length > 0, h.id);
});

test('the stage line shows what deep facts added', () => {
  const enrich = scoreFacts(london.enrich, { ...OPTS, now: london.at });
  assert.equal(stageLine(enrich, score), '7 points at enrich; 8 at deep (+1 README matches the code)');
});

test('an unknown positive signal says it is not known yet', () => {
  const enrich = explain(scoreFacts(london.enrich, { ...OPTS, now: london.at }), weights);
  const coherent = enrich.whyNotHigher.find((h) => h.id === 'p.coherent');
  assert.equal(coherent?.status, 'unknown');
  assert.match(String(coherent?.hint), /not known yet \(file tree not fetched yet\)/);
});

/**
 * The London score with some signals forced to hit.
 * @param {string[]} ids
 * @returns {Score}
 */
function withHits(ids) {
  const signals = score.signals.map((s) => (ids.includes(s.id)
    ? { ...s, status: /** @type {const} */ ('ok'), hit: true, points: s.weight } : s));
  return { ...score, signals };
}

test('negatives: counted slop penalties, most negative first, at most two', () => {
  const x = explain(withHits(['s.prose', 's.mdheavy', 's.junk', 's.farm']), weights);
  assert.deepEqual(x.negatives.map((n) => n.id), ['s.prose', 's.junk']);
  const chip = (/** @type {string} */ id) => x.chips.find((c) => c.id === id);
  assert.equal(chip('s.mdheavy')?.counted, false, 'the smaller penalty of the prose group does not count');
  assert.equal(chip('s.prose')?.counted, true);
  assert.equal(chip('s.junk')?.counted, true);
  assert.equal(explain(score, weights).chips.find((c) => c.id === 's.mdheavy')?.counted, true,
    'a group member that did not fire is not marked as outweighed');
});

test('chips carry what the explorer and the index read', () => {
  assert.equal(ex.chips.length, score.signals.length, 'every quality, proof, slop and judge signal');
  assert.deepEqual(ex.chips.map((c) => c.id), score.signals.map((s) => s.id));
  for (const c of ex.chips) {
    assert.ok(['hit', 'miss', 'unknown', 'na'].includes(c.status), c.id);
    assert.ok(c.label && c.reason, c.id);
  }
  for (const t of ex.top) assert.ok(`${t.label}: ${t.reason}`.length > 4);
  assert.equal(signedPoints(1), '+1');
  assert.equal(signedPoints(-2), '−2');
  assert.equal(signedPoints(0), '0');
});

/**
 * Every repository and red-team fixture, scored.
 * @returns {{name: string, score: Score}[]}
 */
function allScores() {
  const out = [];
  for (const nwo of listRepoFixtures()) {
    const { facts, enrich, at } = fixtureFacts(loadRepoFixture(nwo));
    out.push({ name: `${nwo} (enrich)`, score: scoreFacts(enrich, { ...OPTS, now: at }) });
    if (facts !== enrich) out.push({ name: `${nwo} (deep)`, score: scoreFacts(facts, { ...OPTS, now: at }) });
  }
  const dir = fixturePath('redteam');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const fx = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    out.push({ name: `redteam/${file}`, score: scoreFacts(fx.facts, { ...OPTS, now: fx.meta.now }) });
  }
  return out;
}

const BAND_WORDS = { gem: 'Gem band', look: 'Worth a look', low: 'Low' };
const f2 = (/** @type {number} */ x) => x.toFixed(2);

test('every chip, band, lane and rank number in a Score has an explanation', () => {
  const lanes = new Set();
  for (const { name, score: s } of allScores()) {
    const x = explain(s, weights, { calibration });
    lanes.add(s.lane);
    const scoring = s.signals.filter((g) => ['quality', 'proof', 'slop', 'judge'].includes(g.kind));
    assert.deepEqual(x.chips.map((c) => c.id), scoring.map((g) => g.id), name);
    for (const c of x.chips) assert.ok(c.label.length > 0 && c.reason.length > 0, `${name} ${c.id}`);
    const pct = Math.round(100 * s.quality);
    assert.ok(x.headline.startsWith(`${s.S} point`), name);
    assert.ok(x.headline.includes(`Quality ${pct}`), name);
    assert.ok(x.headline.includes(`Confidence ${s.confidence.band}`), name);
    assert.ok(x.pointsLine.startsWith(`${s.S} of ${s.pointsMax} point`), name);
    assert.ok(x.pointsLine.includes(`${Math.round(100 * s.coverage)}%`), name);
    assert.ok(x.qualityLine.startsWith(`Quality ${pct}:`), name);
    assert.ok(x.bandLine.startsWith(BAND_WORDS[s.band]), name);
    assert.ok(x.confidenceLine.startsWith(`Confidence ${f2(s.confidence.k)} (${s.confidence.band})`), name);
    assert.ok(x.attentionLine.startsWith(`Attention ${f2(s.attention.a)}: ${s.attention.stars} star`), name);
    assert.equal(x.rankLine, `Rank ${f2(s.gem)} = ${s.S} point${Math.abs(s.S) === 1 ? '' : 's'} + `
      + `${f2(1.5 * s.confidence.k)} confidence − ${f2(1.5 * s.attention.a)} attention`, name);
    const label = /** @type {Record<string, string>} */ (LANE_LABELS)[s.lane];
    assert.ok(x.laneLine.startsWith(`${label}:`), `${name}: ${x.laneLine}`);
    assert.equal(x.gateLines.length, s.gates.length, name);
    assert.equal(x.descriptorLines.length, s.descriptors.length, name);
    const hitPositives = TOP_ORDER
      .filter((id) => s.signals.some((g) => g.id === id && g.status === 'ok' && g.hit));
    assert.deepEqual(x.top.map((t) => t.id), hitPositives.slice(0, 3), name);
  }
  for (const lane of ['promising', 'proven', 'look', 'low', 'quarantine', 'doubted', 'institutional']) {
    assert.ok(lanes.has(lane), `the fixtures reach lane ${lane}`);
  }
});

/** The red-team control: a genuine Rust tool on which every positive signal fires. */
const BASE = loadJsonFixture('redteam/clean-baseline.json').facts;
const NOW = '2026-09-11T16:00:00Z';

/**
 * The control's explanation after a change to its facts.
 * @param {(f: any) => void} mutate
 */
function explainBase(mutate) {
  const f = structuredClone(BASE);
  mutate(f);
  const s = scoreFacts(f, { ...OPTS, now: NOW });
  return { score: s, ex: explain(s, weights, { calibration }) };
}

test('hints keep acronyms: CI and README are not lower-cased mid-sentence', () => {
  const { ex: red } = explainBase((f) => { f.rollup = null; });
  const ci = red.raiseConfidence.find((h) => h.id === 'k.ciVerified');
  assert.equal(ci?.status, 'unknown');
  assert.ok(String(ci?.hint).includes('(CI test run not verified)'), ci?.hint);
  const run = red.whyNotHigher.find((h) => h.id === 'p.testsRun');
  assert.ok(String(run?.hint).includes('not known yet (CI runs cargo test'), run?.hint);
  assert.ok(!/cI|rEADME/.test(JSON.stringify(red)), 'no mangled acronym anywhere');

  const { ex: textless } = explainBase((f) => { f.readme.text = null; });
  const usage = textless.whyNotHigher.find((h) => h.id === 'q.usage');
  assert.equal(usage?.status, 'unknown');
  assert.ok(String(usage?.hint).includes('(README text not fetched)'), usage?.hint);

  const { ex: none } = explainBase((f) => { f.workflows = null; });
  const wf = none.whyNotHigher.find((h) => h.id === 'p.testsRun');
  assert.ok(String(wf?.hint).includes('(workflow files not fetched)'), 'an ordinary word is still lower-cased');
});

test('an organisation already at its 0.15 owner ceiling is not asked to raise it (§5.4)', () => {
  const { ex: old } = explainBase((f) => {
    Object.assign(f.ownerInfo, { type: 'Organization', createdAt: '2022-04-26T00:00:00Z' });
  });
  assert.equal(old.raiseConfidence.find((h) => h.id === 'k.owner'), undefined);

  const { score: s, ex: young } = explainBase((f) => {
    Object.assign(f.ownerInfo, { type: 'Organization', createdAt: '2026-01-01T00:00:00Z' });
  });
  const owner = young.raiseConfidence.find((h) => h.id === 'k.owner');
  assert.equal(owner?.max, 0.15);
  assert.equal(owner?.strength, 0);
  assert.ok(formatExplanation(s, young).includes(`    Owner history (0.00 of 0.15): ${owner?.hint}`));

  const { ex: user } = explainBase((f) => { f.ownerInfo.contributionYears = [2020, 2025]; });
  const one = user.raiseConfidence.find((h) => h.id === 'k.owner');
  assert.equal(one?.max, 0.3, 'a user can still reach 0.30');
  assert.equal(one?.strength, 0.15);
});

test('formatExplanation prints every section', () => {
  const lines = formatExplanation(score, ex, { extra: ['Stages: 7 points at enrich; 8 at deep'] });
  const text = lines.join('\n');
  for (const part of [ex.headline, ex.rankLine, ex.laneLine, 'Chips:', 'Why not higher:',
    'What would raise confidence:', 'Descriptors:', 'Gates: none', 'Stages: 7 points']) {
    assert.ok(text.includes(part), part);
  }
  assert.equal(lines[0], 'skulitom/london-time-map · Promising');
});

test('formatExplanation prints each chip\'s GitHub evidence, pinned to the scored commit, under it', () => {
  const lines = formatExplanation(score, ex);
  const evidenceLine = /^ {9}https:\/\//;
  const SHA = '20ae2ffee317f5550c6aad57293b5806ed4afe38';
  const blob = new RegExp(`^ {9}https://github\\.com/skulitom/london-time-map/blob/${SHA}/`);
  assert.ok(lines.some((l) => blob.test(l)), 'a blob link at the scored commit');
  const chipsAt = lines.indexOf('  Chips:');
  const chipsEnd = lines.findIndex((l, i) => i > chipsAt && !l.startsWith('    '));
  for (const [i, l] of lines.entries()) {
    if (!evidenceLine.test(l)) continue;
    assert.ok(i > chipsAt && i < chipsEnd, 'evidence lines sit among the chips');
    const own = /^ {9}https:\/\/github\.com\/skulitom\/london-time-map\//;
    assert.match(l, own, 'only the repository\'s own links');
  }
  // A chip's github.com evidence comes right under its line, each URL once.
  const licence = /** @type {any} */ (ex.chips.find((c) => c.id === 'q.licence'));
  const urls = [...new Set(licence.evidence.map((/** @type {any} */ e) => e.url))];
  assert.deepEqual(urls, [`https://github.com/skulitom/london-time-map/blob/${SHA}/LICENSE`]);
  const at = lines.findIndex((l, i) => i > chipsAt && l.includes(`${licence.label}: `));
  assert.deepEqual(lines.slice(at + 1, at + 2), [`         ${urls[0]}`]);

  // A URL that is not on github.com is never printed.
  const hostile = structuredClone(ex);
  hostile.chips[0].evidence = [{ label: 'x', url: 'https://example.com/tool.exe' }];
  assert.ok(!formatExplanation(score, hostile).some((l) => l.includes('example.com')));
});

/** Five of six cited paths are missing from the control's tree, so `s.incoherent` fires. */
const MISSING = '# tool\n\nCode in `src/a.rs`, `src/b.rs`, `src/c.rs`, `lib/d.rs`, `lib/e.rs` and '
  + '`src/main.rs`.\n';

test('a retired signal (s.incoherent, weight 0 since w2) is a chip that neither scores nor counts', () => {
  const { score: s, ex: x } = explainBase((f) => { f.readme.text = MISSING; });
  const sig = s.signals.find((g) => g.id === 's.incoherent');
  assert.deepEqual([sig?.status, sig?.hit, sig?.weight, sig?.points], ['ok', true, 0, 0]);
  const chip = x.chips.find((c) => c.id === 's.incoherent');
  assert.deepEqual([chip?.status, chip?.points, chip?.weight, chip?.label],
    ['hit', 0, 0, 'README cites missing files'], 'still measured and shown');
  assert.ok(!x.negatives.some((n) => n.id === 's.incoherent'), 'not a penalty');
  assert.ok(!x.whyNotHigher.some((h) => h.id === 's.incoherent'));
  assert.deepEqual(points(s.signals), points(s.signals.filter((g) => g.id !== 's.incoherent')),
    'nothing toward S, pointsMax or coverage');
  const line = formatExplanation(s, x).find((l) => l.includes('README cites missing files'));
  assert.match(String(line),
    /^ {6}0 {2}README cites missing files: \d+ of \d+ cited paths and scripts exist \(noted, not scored\)$/);
});
