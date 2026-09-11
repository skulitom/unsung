// @ts-check
/**
 * DESIGN §7.7 and §12.5 `src/eval/goodhart.mjs`: `dress(facts)` adds the eight cheap artefacts —
 * and only those — and `goodhartAuc` measures the dressed ranking. The §14.6 floors themselves are
 * asserted in test/eval-labelled.test.mjs.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { countFenceLines } from '../src/core/readme.mjs';
import { scoreFacts } from '../src/core/score.mjs';
import { CHEAP_SIGNALS, dress, goodhartAuc } from '../src/eval/goodhart.mjs';
import { fixtureFacts, identityFacts, labelledFromFixtures } from '../src/eval/labels.mjs';
import * as fixtures from './support/fixtures.mjs';

/** @param {string} f */
const read = (f) => JSON.parse(readFileSync(new URL(`../config/${f}`, import.meta.url), 'utf8'));
const config = { weights: read('weights.json'), calibration: read('calibration.json'),
  institutions: read('institutions.json') };
/** @param {any} facts @param {string} at */
const score = (facts, at) => scoreFacts(facts, { ...config, now: at });

/**
 * @param {import('../src/core/schema.mjs').Score} s
 * @param {string} id
 */
const hit = (s, id) => s.signals.some((x) => x.id === id && x.status === 'ok' && x.hit === true);

test('dressing an empty repository earns exactly the eight cheap signals', () => {
  const at = '2026-09-11T00:00:00Z';
  const bare = identityFacts('someone/empty', at);
  const s = score(dress(bare), at);
  for (const id of CHEAP_SIGNALS) assert.ok(hit(s, id), id);
  assert.equal(s.S, 8);
  assert.equal(CHEAP_SIGNALS.length, 8);
});

test('dress returns a new object and leaves its input alone', () => {
  const { facts } = fixtureFacts(fixtures.loadRepoFixture('gbazad93/AirFlow-ML-Data-Integration'));
  const before = structuredClone(facts);
  const dressed = dress(facts);
  assert.notEqual(dressed, facts);
  assert.deepEqual(facts, before);
});

test('artefacts already present are kept as they are', () => {
  const { facts } = fixtureFacts(fixtures.loadRepoFixture('skulitom/london-time-map'));
  const d = dress(facts);
  assert.equal(d.licence, facts.licence);
  assert.equal(d.readme?.text, facts.readme?.text, 'a README of 1 KB with two code blocks is not touched');
  for (const e of facts.root ?? []) {
    assert.ok(d.root?.some((x) => x.name === e.name && x.type === e.type), e.name);
  }
  assert.deepEqual(d.releases?.recent, facts.releases?.recent);
  assert.equal(d.releases?.count, Math.max(1, facts.releases?.count ?? 0));
});

test('a dressed README has two code blocks and at least 1,000 bytes', () => {
  const at = '2026-09-11T00:00:00Z';
  const f = { ...identityFacts('someone/tiny', at), readme: /** @type {any} */ ({
    name: 'README.md', bytes: 12, truncated: false, text: '# tiny\nhello\n', fenceLines: 0,
  }) };
  const r = /** @type {any} */ (dress(f).readme);
  assert.ok(r.bytes >= 1000, `${r.bytes} bytes`);
  assert.ok(countFenceLines(r.text) >= 4);
  assert.ok(r.fenceLines >= 4, 'the stored fence count is updated');
  assert.ok(r.text.startsWith('# tiny\nhello\n'), 'the original text stays first');
});

test('dressing a non-genuine labelled repository earns the eight cheap signals; only s.prose moves', () => {
  const rows = labelledFromFixtures(fixtures).filter((r) => r.label !== 'G');
  let prose = 0;
  for (const r of rows) {
    const before = score(r.facts, r.at);
    const after = score(dress(r.facts), r.at);
    for (const id of CHEAP_SIGNALS) assert.ok(hit(after, id), `${r.nwo}: ${id}`);
    const moved = after.signals
      .filter((s, i) => !CHEAP_SIGNALS.includes(s.id) && s.points !== before.signals[i].points);
    for (const s of moved) {
      assert.equal(s.id, 's.prose', `${r.nwo}: only a README grown over too little code may add a penalty`);
      assert.equal(s.points, -2);
      prose++;
    }
  }
  assert.equal(rows.length, 75);
  assert.ok(prose <= 10, `${prose} dressed repositories carry s.prose`);
});

test('goodhartAuc leaves genuine rows undressed', () => {
  const at = '2026-09-11T00:00:00Z';
  const empty = identityFacts('someone/empty', at);
  const rows = [
    { facts: empty, label: 'G', stratum: 'uniform', at },
    { facts: empty, label: 'C', stratum: 'uniform', at },
  ];
  assert.deepEqual(goodhartAuc(rows, config), { all: 0, uniform: 0 }, 'the dressed C outscores the bare G');
});
