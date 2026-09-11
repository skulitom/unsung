// @ts-check
/**
 * DESIGN §12.5 `src/eval/labels.mjs` and `src/eval/fixtures.mjs`: label rows from the research
 * fixtures (research snapshots where a labelled repository was also recorded), the named sets, and
 * quality labels from feedback.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factsFromEnrich } from '../src/core/facts.mjs';
import { validateFacts } from '../src/core/schema.mjs';
import { scoreFacts } from '../src/core/score.mjs';
import { FixtureError, fixtureLoader } from '../src/eval/fixtures.mjs';
import {
  identityFacts, isGenuine, labelRows, labelledFromFeedback, labelledFromFixtures, namedFromFixtures,
} from '../src/eval/labels.mjs';
import * as fixtures from './support/fixtures.mjs';

const rows = labelledFromFixtures(fixtures);

test('the research labels become 149 rows: 74 genuine, 69 uniform of which 9 genuine', () => {
  assert.equal(rows.length, 149);
  assert.equal(rows.filter(isGenuine).length, 74);
  const uni = rows.filter((r) => r.stratum === 'uniform');
  assert.equal(uni.length, 69);
  assert.equal(uni.filter(isGenuine).length, 9);
  assert.ok(rows.every((r) => r.source === 'fixture' && r.owner === r.nwo.split('/')[0]));
});

test('every row carries valid Facts', () => {
  for (const r of rows) assert.deepEqual(validateFacts(r.facts), [], r.nwo);
});

test('a labelled repository that was also recorded is scored on its research snapshot', () => {
  const row = rows.find((r) => r.nwo === 'codefly-dev/cli');
  assert.ok(row);
  const fx = fixtures.loadRepoFixture('codefly-dev/cli');
  assert.equal(fx.meta.labelledSnapshot, 'enrich.research.json');
  const research = fixtures.loadJsonFixture(`repos/${fx.name}/enrich.research.json`);
  const expected = factsFromEnrich(research, { fetchedAt: fx.meta.researchRecordedAt, source: 'fixture' });
  assert.deepEqual(row.facts, expected);
  assert.equal(row.at, fx.meta.researchRecordedAt);
  assert.deepEqual(row.facts.stages, ['enrich']);
});

test('the two repositories that answered 502 in research are identity-only X rows worth 0 points', () => {
  const empty = rows.filter((r) => r.facts.root === null && r.facts.codeBytes === null
    && r.facts.readme === null);
  assert.equal(empty.length, 2);
  for (const r of empty) {
    assert.equal(r.label, 'X');
    assert.equal(r.stratum, 'uniform');
    assert.deepEqual(r.facts, identityFacts(r.nwo, r.at));
    assert.equal(scoreFacts(r.facts, { now: r.at }).S, 0);
  }
});

test('the runtime fixture loader reads the same rows as the test loader', () => {
  const loader = fixtureLoader(fixtures.FIXTURES_DIR);
  assert.ok(loader.exists());
  const again = labelledFromFixtures(loader);
  assert.deepEqual(again, rows);
  assert.ok(loader.hasRepoFixture('SKULITOM/london-time-map'), 'case-insensitive lookup');
  assert.throws(() => loader.loadJsonFixture('../../package.json'), FixtureError);
  assert.equal(fixtureLoader(`${fixtures.FIXTURES_DIR}/no-such-dir`).exists(), false);
});

test('the named sets of §14.2: 11 seed gems, 5 hard positives, 7 hard negatives, 5 lures and spam', () => {
  const named = namedFromFixtures(fixtures);
  /** @type {Record<string, number>} */
  const sets = {};
  for (const n of named) sets[String(n.set)] = (sets[String(n.set)] ?? 0) + 1;
  assert.deepEqual(sets, { seedGems: 11, hardPositives: 5, hardNegatives: 7, luresAndSpam: 5 });
  for (const n of named.filter((x) => x.set === 'seedGems')) {
    assert.ok(n.facts.stages.includes('deep'), `${n.nwo} has deep facts`);
    assert.deepEqual(n.enrich.stages, ['enrich']);
    assert.ok(n.expect && typeof n.expect === 'object');
  }
});

/**
 * A minimal store: feedback events and records by id.
 * @param {any[]} events
 * @param {Record<string, any>} records
 */
function fakeStore(events, records) {
  return {
    readFeedback: async () => events,
    getRepoById: async (/** @type {string} */ id) => records[id] ?? null,
    getRepo: async (/** @type {string} */ nwo) => Object.values(records).find((r) => r.nwo === nwo) ?? null,
  };
}

/**
 * @param {string} id
 * @param {string} nwo
 */
function record(id, nwo) {
  const facts = { ...identityFacts(nwo, '2026-09-10T00:00:00Z'), id };
  return { v: 1, id, nwo, facts };
}

test('feedback labels: the latest labelled event per repository, undo honoured, strata', async () => {
  const at = (/** @type {number} */ m) => `2026-09-11T10:${String(m).padStart(2, '0')}:00Z`;
  const sample = { stratum: 'sample' };
  const pool = { stratum: 'pool' };
  const events = [
    { v: 1, at: at(1), id: 'R_a', nwo: 'o/a', action: 'gem', label: 'G', blind: false, context: {} },
    { v: 1, at: at(2), id: 'R_b', nwo: 'o/b', action: 'notgood', label: 'S', reason: 'slop', blind: false },
    { v: 1, at: at(3), id: 'R_b', nwo: 'o/b', action: 'undo', label: null, undoes: at(2) },
    { v: 1, at: at(4), id: 'R_c', nwo: 'o/c', action: 'label', label: 'C', blind: true, context: sample },
    { v: 1, at: at(5), id: 'R_d', nwo: 'o/d', action: 'label', label: 'W', blind: true, context: pool },
    { v: 1, at: at(6), id: 'R_e', nwo: 'o/e', action: 'notmine', label: null, blind: false },
    { v: 1, at: at(7), id: 'R_f', nwo: 'o/f', action: 'gem', label: 'G', blind: false },
    { v: 1, at: at(8), id: 'R_a', nwo: 'o/a', action: 'publish', label: null, blind: false },
    { v: 1, at: at(9), id: 'R_d', nwo: 'o/d', action: 'notgood', label: 'E', reason: 'empty', blind: false },
  ];
  /** @type {Record<string, any>} */
  const records = {};
  for (const x of ['a', 'b', 'c', 'd', 'e']) records[`R_${x}`] = record(`R_${x}`, `o/${x}`);
  const got = await labelledFromFeedback(fakeStore(events, records));
  const brief = got.map((r) => [r.id, r.label, r.stratum, r.source]).sort();
  assert.deepEqual(brief, [
    ['R_a', 'G', 'triage', 'feedback'],
    ['R_c', 'C', 'uniform', 'feedback'],
    ['R_d', 'E', 'triage', 'feedback'],
  ]);
  const a = got.find((r) => r.id === 'R_a');
  assert.equal(a?.at, '2026-09-10T00:00:00Z', 'scored when its facts were fetched');
  assert.equal(a?.owner, 'o');
});

test('labelRows reads the sources --labels names', async () => {
  const events = [{ v: 1, at: '2026-09-11T10:00:00Z', id: 'R_a', nwo: 'o/a', action: 'gem', label: 'G' }];
  const store = fakeStore(events, { R_a: record('R_a', 'o/a') });
  const onlyFixtures = await labelRows({ labels: 'fixtures', loader: fixtures, store });
  assert.equal(onlyFixtures.rows.length, 149);
  assert.equal(onlyFixtures.named.length, 28);
  const onlyFeedback = await labelRows({ labels: 'feedback', loader: fixtures, store });
  assert.deepEqual(onlyFeedback.rows.map((r) => r.id), ['R_a']);
  assert.equal(onlyFeedback.named.length, 0);
  const all = await labelRows({ labels: 'all', loader: fixtures, store });
  assert.equal(all.rows.length, 150);
  const nothing = await labelRows({ labels: 'all' });
  assert.deepEqual(nothing, { rows: [], named: [] });
});
