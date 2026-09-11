// @ts-check
/**
 * DESIGN §13 (WP4) and §5.1, §0: `S` and Quality never change when stars, forks, watchers,
 * `commits.total`, topics, age or agent-file sizes change, or when scoring happens later. Attention
 * and confidence move only the rank and the lane. Metamorphic relations over every fixture snapshot:
 * recorded enrich and deep facts, the research snapshots, and the red-team Facts.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { factsFromEnrich } from '../src/core/facts.mjs';
import { scoreFacts } from '../src/core/score.mjs';
import { fixtureFacts } from '../src/eval/labels.mjs';
import { fixturePath, listRepoFixtures, loadJsonFixture, loadRepoFixture } from './support/fixtures.mjs';

/** @param {string} f */
const read = (f) => JSON.parse(readFileSync(new URL(`../config/${f}`, import.meta.url), 'utf8'));
const OPTS = { weights: read('weights.json'), calibration: read('calibration.json'),
  institutions: read('institutions.json') };
const DAY = 86_400_000;

/**
 * @param {string | null} iso
 * @param {number} days
 * @returns {string | null}
 */
const shift = (iso, days) => (iso ? new Date(Date.parse(iso) + days * DAY).toISOString() : iso);

/** The invariance mutations of §13 (WP3 and WP4). @type {[string, (f: any) => any][]} */
const MUTATIONS = [
  ['stars', (f) => ({ ...f, stars: (f.stars ?? 0) * 100 + 7 })],
  ['no stars', (f) => ({ ...f, stars: 0 })],
  ['forks', (f) => ({ ...f, forks: (f.forks ?? 0) * 50 + 3 })],
  ['watchers', (f) => ({ ...f, watchers: (f.watchers ?? 0) * 20 + 9 })],
  ['commit count', (f) => (f.commits
    ? { ...f, commits: { ...f.commits, total: (f.commits.total ?? 0) * 10 + 999 } } : f)],
  ['one commit', (f) => (f.commits ? { ...f, commits: { ...f.commits, total: 1 } } : f)],
  ['topics', (f) => ({ ...f, topics: ['awesome', 'ai', 'agents', 'mcp'] })],
  ['no topics', (f) => ({ ...f, topics: [] })],
  ['older', (f) => ({ ...f, createdAt: shift(f.createdAt, -900), pushedAt: shift(f.pushedAt, -900) })],
  ['younger', (f) => ({ ...f, createdAt: shift(f.createdAt, 3), pushedAt: shift(f.pushedAt, 3) })],
  ['large agent files', (f) => ({ ...f, agentsMdBytes: 50000, claudeMdBytes: 12000 })],
  ['no agent files', (f) => ({ ...f, agentsMdBytes: 0, claudeMdBytes: 0 })],
  ['star history', (f) => ({
    ...f, starHistory: { weeks: [{ week: '2026-09-06', gained: 40 }], gain4w: 40 },
  })],
];

/** @returns {{name: string, facts: any, at: string}[]} */
function corpus() {
  const out = [];
  for (const nwo of listRepoFixtures()) {
    const fx = loadRepoFixture(nwo);
    if (!fx.enrich) continue;
    const { facts, enrich, at } = fixtureFacts(fx);
    out.push({ name: `${nwo} (enrich)`, facts: enrich, at });
    if (facts !== enrich) out.push({ name: `${nwo} (deep)`, facts, at });
    if (fx.meta?.labelledSnapshot) {
      const research = loadJsonFixture(`repos/${fx.name}/${fx.meta.labelledSnapshot}`);
      const when = fx.meta.researchRecordedAt ?? at;
      const facts2 = factsFromEnrich(research, { fetchedAt: when, source: 'fixture' });
      out.push({ name: `${nwo} (research)`, facts: facts2, at: when });
    }
  }
  const redteam = fixturePath('redteam');
  for (const file of readdirSync(redteam).filter((n) => n.endsWith('.json'))) {
    const fx = JSON.parse(readFileSync(path.join(redteam, file), 'utf8'));
    out.push({ name: `redteam/${file}`, facts: fx.facts, at: fx.meta.now });
  }
  return out;
}

const CORPUS = corpus();
/** @param {any} facts @param {string} at */
const score = (facts, at) => scoreFacts(facts, { ...OPTS, now: at });
const BASE = CORPUS.map((c) => score(c.facts, c.at));

test('the metamorphic corpus covers every fixture', () => {
  assert.ok(CORPUS.length > 200, `${CORPUS.length} snapshots`);
});

for (const [label, mutate] of MUTATIONS) {
  test(`S and Quality ignore: ${label}`, () => {
    CORPUS.forEach((c, i) => {
      const m = score(mutate(c.facts), c.at);
      const b = BASE[i];
      const got = [m.S, m.quality, m.band, m.pointsMax, m.coverage];
      const want = [b.S, b.quality, b.band, b.pointsMax, b.coverage];
      assert.deepEqual(got, want, `${c.name} changed under ${label}`);
    });
  });
}

test('S and Quality ignore the time of scoring', () => {
  CORPUS.forEach((c, i) => {
    const later = score(c.facts, '2031-01-01T00:00:00Z');
    assert.deepEqual([later.S, later.quality], [BASE[i].S, BASE[i].quality], c.name);
  });
});

test('more attention never raises the rank; it moves only attention, the rank and the lane', () => {
  CORPUS.forEach((c, i) => {
    const more = { ...c.facts, stars: (c.facts.stars ?? 0) + 30, forks: (c.facts.forks ?? 0) + 5 };
    const noticed = score(more, c.at);
    assert.ok(noticed.gem <= BASE[i].gem, c.name);
    assert.ok(noticed.attention.a >= BASE[i].attention.a, c.name);
    assert.equal(noticed.confidence.k, BASE[i].confidence.k, c.name);
  });
});

test('corroboration raises confidence and the rank, never S', () => {
  const outsider = {
    login: 'an-outsider', kind: 'issue', at: '2026-09-01T00:00:00Z', accountCreatedAt: '2015-01-01T00:00:00Z',
  };
  CORPUS.forEach((c, i) => {
    const seen = score({ ...c.facts, outsiders: [...(c.facts.outsiders ?? []), outsider] }, c.at);
    assert.equal(seen.S, BASE[i].S, c.name);
    assert.ok(seen.confidence.k >= BASE[i].confidence.k, c.name);
    assert.ok(seen.gem >= BASE[i].gem, c.name);
  });
});

test('the relations are not vacuous: removing a licence costs exactly one point', () => {
  let checked = 0;
  CORPUS.forEach((c, i) => {
    if (c.facts.licence === null) return;
    const without = score({ ...c.facts, licence: null }, c.at);
    assert.equal(without.S, BASE[i].S - 1, c.name);
    assert.ok(without.quality < BASE[i].quality, c.name);
    checked++;
  });
  assert.ok(checked > 50, `${checked} licensed snapshots`);
});
