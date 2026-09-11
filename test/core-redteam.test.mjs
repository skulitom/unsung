// @ts-check
/**
 * The red-team fixtures of DESIGN §14.2 (`test/fixtures/redteam/*.json`): synthetic Facts, each with
 * `meta.expect`. Keys of `expect`:
 *   signals        {id: {status?, hit?, points?}} that must hold
 *   gates          gate ids that must fire
 *   noGates        no quarantine, drop or doubt gate fires
 *   noPenalty      no slop signal fires
 *   descriptors    descriptor ids that must be present; descriptorsExact: exactly these
 *   S              the §6.1 points, exactly
 *   notProven      S < 7 or K < 0.5 (so the Proven lane of §6.7 is out of reach)
 *   lane           'doubted': a doubt gate and nothing that §6.7 tests earlier
 *   sameAsTwin, pointsUnchangedFromTwin, sDeltaFromTwin   compared with the fixture's `twin`
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { evaluateGates } from '../src/core/gates.mjs';
import { validateFacts } from '../src/core/schema.mjs';
import { describe, evaluateConfidence, evaluateSignals } from '../src/core/signals.mjs';
import { fixturePath } from './support/fixtures.mjs';

/** @param {string} name */
const readConfig = (name) => JSON.parse(readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8'));
const weights = readConfig('weights.json');
const institutions = readConfig('institutions.json');
const DIR = fixturePath('redteam');
const FILES = readdirSync(DIR).filter((n) => n.endsWith('.json')).sort();

/**
 * Score what WP3 can see: §6.1 points, §6.4 K, gates and descriptors.
 * @param {any} facts
 * @param {string} now
 */
function assess(facts, now) {
  const signals = evaluateSignals(facts, { weights, now });
  const items = evaluateConfidence(facts, signals, { weights, now });
  let S = 0;
  /** @type {Record<string, number>} */
  const groups = {};
  for (const s of signals) {
    const c = s.status === 'ok' && s.hit ? /** @type {number} */ (s.weight) : 0;
    if (s.group) groups[s.group] = Math.min(groups[s.group] ?? 0, c);
    else S += c;
  }
  for (const v of Object.values(groups)) S += v;
  /** @type {Record<string, number>} */
  const best = {};
  for (const it of items) {
    const g = String(it.group);
    best[g] = Math.max(best[g] ?? 0, it.strength ?? 0);
  }
  const K = 1 - Object.values(best).reduce((p, s) => p * (1 - s), 1);
  const gates = evaluateGates(facts, signals, { institutions, now, weights });
  return { signals, S, K, gates, descriptors: describe(facts) };
}

test('the red-team set covers every attack of §14.2', () => {
  for (const name of [
    'clean-baseline', 'dressed-scaffold', 'echo-only-ci', 'neutralised-or-true', 'neutralised-continue',
    'npm-default-test', 'injection-readme', 'injection-zero-width', 'injection-html-comment',
    'lure-archive-tests',
    'lure-bat-payload', 'lure-drainer', 'spam-streak', 'spam-gambling', 'spam-farm-owner', 'clone-url',
    'vite-template', 'badge-wall', 'squashed-agent', 'chinese-readme',
  ]) assert.ok(FILES.includes(`${name}.json`), name);
});

for (const file of FILES) {
  const fx = JSON.parse(readFileSync(path.join(DIR, file), 'utf8'));
  test(`red team ${file.replace(/\.json$/, '')}: ${fx.meta.attack}`, () => {
    const e = fx.meta.expect;
    const now = fx.meta.now;
    assert.deepEqual(validateFacts(fx.facts), []);
    const r = assess(fx.facts, now);
    for (const [id, want] of Object.entries(e.signals ?? {})) {
      const s = r.signals.find((x) => x.id === id);
      assert.ok(s, id);
      for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (want))) {
        assert.equal(/** @type {any} */ (s)[k], v, `${id}.${k}: ${s.reason}`);
      }
    }
    for (const id of e.gates ?? []) {
      assert.ok(r.gates.some((g) => g.id === id), `${id} should fire; got ${r.gates.map((g) => g.id)}`);
    }
    if (e.noGates) {
      assert.deepEqual(r.gates.filter((g) => g.action !== 'institutional').map((g) => g.id), []);
    }
    if (e.noPenalty) {
      assert.deepEqual(r.signals.filter((s) => s.kind === 'slop' && s.hit).map((s) => s.id), []);
    }
    for (const id of e.descriptors ?? []) assert.ok(r.descriptors.some((d) => d.id === id), id);
    if (e.descriptorsExact) assert.deepEqual(r.descriptors.map((d) => d.id), e.descriptorsExact);
    if (e.S !== undefined) assert.equal(r.S, e.S);
    if (e.notProven) assert.ok(r.S < 7 || r.K < 0.5, `S ${r.S}, K ${r.K.toFixed(2)}`);
    if (e.lane === 'doubted') {
      assert.ok(r.gates.some((g) => g.action === 'doubt'));
      assert.ok(!r.gates.some((g) => g.action === 'quarantine' || g.action === 'institutional'));
    }
    if (fx.twin) {
      assert.deepEqual(validateFacts(fx.twin), []);
      const t = assess(fx.twin, now);
      if (e.sameAsTwin) assert.equal(r.S, t.S);
      if (e.pointsUnchangedFromTwin) {
        assert.deepEqual(r.signals.map((s) => [s.id, s.points]), t.signals.map((s) => [s.id, s.points]));
      }
      if (e.sDeltaFromTwin !== undefined) assert.equal(r.S - t.S, e.sDeltaFromTwin);
    }
  });
}
