// @ts-check
/**
 * DESIGN §5.1 and §13 (WP3): no quality, proof or slop signal may change when stars, forks,
 * watchers, `commits.total`, topics, age or agent-file sizes change, or when scoring happens later.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { factsFromEnrich, mergeDeep } from '../src/core/facts.mjs';
import { evaluateSignals } from '../src/core/signals.mjs';
import { fixturePath, listRepoFixtures, loadJsonFixture, loadRepoFixture } from './support/fixtures.mjs';

const NOW = '2026-09-11T16:00:00Z';
const DAY = 86_400_000;
const weights = JSON.parse(readFileSync(new URL('../config/weights.json', import.meta.url), 'utf8'));

/**
 * @param {string | null} iso
 * @param {number} days
 * @returns {string | null}
 */
const shift = (iso, days) => (iso ? new Date(Date.parse(iso) + days * DAY).toISOString() : iso);

/** @type {[string, (f: any) => any][]} */
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
];

/**
 * @param {any} f
 * @param {string} [now]
 */
function scoring(f, now = NOW) {
  return evaluateSignals(f, { weights, now })
    .filter((s) => ['quality', 'proof', 'slop'].includes(s.kind))
    .map((s) => [s.id, s.status, s.hit, s.weight, s.points]);
}

/** @returns {{name: string, facts: any}[]} */
function corpus() {
  const out = [];
  for (const nwo of listRepoFixtures()) {
    const fx = loadRepoFixture(nwo);
    if (!fx.enrich) continue;
    const at = fx.meta?.recordedAt ?? NOW;
    const enrich = factsFromEnrich(fx.enrich, { fetchedAt: at, source: 'fixture' });
    out.push({ name: `${nwo} (enrich)`, facts: enrich });
    if (fx.tree || fx.deep || fx.files) {
      const deep = mergeDeep(enrich, {
        node: fx.deep, tree: fx.tree, activity: fx.activity, starHistory: fx.stars, files: fx.files,
      });
      out.push({ name: `${nwo} (deep)`, facts: deep });
    }
    if (fx.meta?.labelledSnapshot) {
      const research = loadJsonFixture(`repos/${fx.name}/${fx.meta.labelledSnapshot}`);
      const facts = factsFromEnrich(research, { fetchedAt: at, source: 'fixture' });
      out.push({ name: `${nwo} (research)`, facts });
    }
  }
  const redteam = fixturePath('redteam');
  for (const file of readdirSync(redteam).filter((n) => n.endsWith('.json'))) {
    const fx = JSON.parse(readFileSync(path.join(redteam, file), 'utf8'));
    out.push({ name: `redteam/${file}`, facts: fx.facts });
  }
  return out;
}

const CORPUS = corpus();

test('the invariance corpus covers every fixture', () => {
  assert.ok(CORPUS.length > 200, `${CORPUS.length} snapshots`);
});

for (const [label, mutate] of MUTATIONS) {
  test(`quality, proof and slop signals ignore: ${label}`, () => {
    for (const { name, facts } of CORPUS) {
      assert.deepEqual(scoring(mutate(facts)), scoring(facts), `${name} changed under ${label}`);
    }
  });
}

test('quality, proof and slop signals ignore the time of scoring', () => {
  for (const { name, facts } of CORPUS) {
    assert.deepEqual(scoring(facts, '2031-01-01T00:00:00Z'), scoring(facts), name);
  }
});

test('the invariance check is not vacuous: a licence does change q.licence', () => {
  const { facts } = CORPUS.find((c) => c.facts.licence !== null) ?? CORPUS[0];
  const without = scoring({ ...facts, licence: null });
  assert.notDeepEqual(without, scoring(facts));
});
