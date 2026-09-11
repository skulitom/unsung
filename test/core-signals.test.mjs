// @ts-check
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { factsFromEnrich, mergeDeep } from '../src/core/facts.mjs';
import { validateInstitutions, validateSignal, validateWeights } from '../src/core/schema.mjs';
import {
  CONFIDENCE_ITEMS, DESCRIPTOR_LABELS, JUDGE_ID, ORG_OWNER_MAX, SIGNALS, describe, evaluateConfidence,
  evaluateSignals,
} from '../src/core/signals.mjs';
import { loadJsonFixture, loadLabelled, loadRepoFixture } from './support/fixtures.mjs';

const NOW = '2026-09-11T16:00:00Z';
const FENCE = '```';
/** @param {string} name */
const readConfig = (name) => JSON.parse(readFileSync(new URL(`../config/${name}`, import.meta.url), 'utf8'));
const weights = readConfig('weights.json');
const institutions = readConfig('institutions.json');
/** The red-team control: a genuine Rust tool on which every positive signal fires. */
const BASE = loadJsonFixture('redteam/clean-baseline.json').facts;

const ORDER = [
  'q.licence', 'q.readme', 'q.usage', 'q.ci', 'q.manifest', 'q.deps', 'q.tests', 'q.code', 'q.release',
  'q.examples', 'p.testsRun', 'p.shipped', 'p.coherent', 's.incoherent', 's.webui', 's.template', 's.prose',
  's.mdheavy', 's.junk', 's.farm', 's.cloneUrl',
];

/** §5.3 points (weights w2: `s.incoherent` retired to 0). @type {Record<string, number>} */
const POINTS = {
  'q.licence': 1, 'q.readme': 1, 'q.usage': 1, 'q.ci': 1, 'q.manifest': 1, 'q.deps': 1, 'q.tests': 1,
  'q.code': 1, 'q.release': 1, 'q.examples': 1, 'p.testsRun': 1, 'p.shipped': 1, 'p.coherent': 1,
  's.incoherent': 0, 's.webui': -2, 's.template': -2, 's.prose': -2, 's.mdheavy': -1, 's.junk': -1,
  's.farm': -1, 's.cloneUrl': -1,
};

/**
 * @param {(f: any) => void} [mutate]
 * @returns {any}
 */
function facts(mutate) {
  const f = structuredClone(BASE);
  if (mutate) mutate(f);
  return f;
}

/**
 * @param {any} f
 * @param {string} id
 */
function signalOf(f, id) {
  const s = evaluateSignals(f, { weights, now: NOW }).find((x) => x.id === id);
  assert.ok(s, id);
  return s;
}

/**
 * Remove a root entry and everything under it from the tree.
 * @param {any} f
 * @param {string} name
 */
function dropRoot(f, name) {
  f.root = f.root.filter((/** @type {any} */ e) => e.name !== name);
  f.tree.entries = f.tree.entries
    .filter((/** @type {any} */ e) => e[0] !== name && !e[0].startsWith(`${name}/`));
}

/**
 * A one-job workflow with the given step lines.
 * @param {string[]} steps
 */
const workflow = (steps) => [{
  name: 'ci.yml',
  text: ['jobs:', '  t:', '    runs-on: ubuntu-latest', '    steps:', ...steps.map((s) => `      - ${s}`), '']
    .join('\n'),
}];

/** README whose cited paths mostly do not exist (1 of 6). */
const MISSING = '# tool\n\nCode in `src/a.rs`, `src/b.rs`, `src/c.rs`, `lib/d.rs`, `lib/e.rs` and '
  + '`src/main.rs`.\n';

/**
 * @param {number} deps
 * @returns {Record<string, unknown>}
 */
const pkg = (deps) => ({
  name: 't', deps, devDeps: 0, peerDeps: 0, optionalDeps: 0, testScript: null, scripts: [],
});

/** @typedef {[string, string, ((f: any) => void) | null, 'ok' | 'unknown' | 'na', boolean | null]} Case */

/** [signal, case, mutation, status, hit] @type {Case[]} */
const CASES = [
  ['q.licence', 'a detected licence', null, 'ok', true],
  ['q.licence', 'NOASSERTION is a licence', (f) => { f.licence = 'NOASSERTION'; }, 'ok', true],
  ['q.licence', 'no licence detected', (f) => { f.licence = null; }, 'ok', false],

  ['q.readme', 'a README over 1 KB', null, 'ok', true],
  ['q.readme', 'a README of 999 bytes', (f) => { f.readme.bytes = 999; }, 'ok', false],
  ['q.readme', 'no README', (f) => { f.readme = null; }, 'ok', false],

  ['q.usage', 'two fenced blocks', null, 'ok', true],
  ['q.usage', 'one fenced block', (f) => { f.readme.text = `x\n${FENCE}\ny\n${FENCE}\n`; }, 'ok', false],
  ['q.usage', 'no README', (f) => { f.readme = null; }, 'ok', false],
  ['q.usage', 'README text not fetched', (f) => { f.readme.text = null; }, 'unknown', null],

  ['q.ci', 'a GitHub Actions workflow', null, 'ok', true],
  ['q.ci', 'no CI at all', (f) => {
    f.workflows = [];
    dropRoot(f, '.github');
  }, 'ok', false],
  ['q.ci', 'a root .travis.yml', (f) => {
    f.workflows = [];
    f.root.push({ name: '.travis.yml', type: 'blob' });
  }, 'ok', true],
  ['q.ci', 'a .circleci directory', (f) => {
    f.workflows = [];
    f.root.push({ name: '.circleci', type: 'tree' });
  }, 'ok', true],
  ['q.ci', 'no YAML in the workflows directory', (f) => {
    f.workflows = [{ name: 'notes.md', text: null }];
  }, 'ok', false],
  ['q.ci', 'workflow directory not fetched', (f) => { f.workflows = null; }, 'unknown', null],
  ['q.ci', 'nothing fetched', (f) => {
    f.workflows = null;
    f.root = null;
  }, 'unknown', null],

  ['q.manifest', 'Cargo.toml at the root', null, 'ok', true],
  ['q.manifest', 'no manifest', (f) => { dropRoot(f, 'Cargo.toml'); }, 'ok', false],
  ['q.manifest', 'root not fetched', (f) => { f.root = null; }, 'unknown', null],

  ['q.deps', 'Cargo.lock committed', null, 'ok', true],
  ['q.deps', 'a Rust crate without Cargo.lock', (f) => { dropRoot(f, 'Cargo.lock'); }, 'na', null],
  ['q.deps', 'a zero-dependency package.json', (f) => {
    dropRoot(f, 'Cargo.lock');
    dropRoot(f, 'Cargo.toml');
    f.root.push({ name: 'package.json', type: 'blob' });
    f.primaryLanguage = 'JavaScript';
    f.packageJson = pkg(0);
  }, 'ok', true],
  ['q.deps', 'dependencies without a lockfile', (f) => {
    dropRoot(f, 'Cargo.lock');
    f.root.push({ name: 'package.json', type: 'blob' });
    f.packageJson = pkg(3);
  }, 'ok', false],
  ['q.deps', 'package.json not read', (f) => {
    dropRoot(f, 'Cargo.lock');
    f.root.push({ name: 'package.json', type: 'blob' });
    f.packageJson = null;
  }, 'unknown', null],
  ['q.deps', 'root not fetched', (f) => { f.root = null; }, 'unknown', null],

  ['q.tests', 'test files in the tree', null, 'ok', true],
  ['q.tests', 'no tests anywhere', (f) => { dropRoot(f, 'tests'); }, 'ok', false],
  ['q.tests', 'enrich stage: a root tests directory', (f) => { f.tree = null; }, 'ok', true],
  ['q.tests', 'enrich stage: no test directory', (f) => {
    dropRoot(f, 'tests');
    f.tree = null;
  }, 'ok', false],
  ['q.tests', 'nothing fetched', (f) => {
    f.root = null;
    f.tree = null;
  }, 'unknown', null],

  ['q.code', '70 KB of code', null, 'ok', true],
  ['q.code', 'just under 50,000 bytes', (f) => { f.codeBytes = 49999; }, 'ok', false],
  ['q.code', 'language sizes not fetched', (f) => { f.codeBytes = null; }, 'unknown', null],

  ['q.release', 'three releases', null, 'ok', true],
  ['q.release', 'tags only', (f) => {
    f.releases = { count: 0, recent: [] };
    f.tags = 2;
  }, 'ok', true],
  ['q.release', 'neither releases nor tags', (f) => {
    f.releases = { count: 0, recent: [] };
    f.tags = 0;
  }, 'ok', false],
  ['q.release', 'releases not fetched', (f) => {
    f.releases = null;
    f.tags = 0;
  }, 'unknown', null],

  ['q.examples', 'an examples directory', null, 'ok', true],
  ['q.examples', 'no examples directory', (f) => { dropRoot(f, 'examples'); }, 'ok', false],
  ['q.examples', 'root not fetched', (f) => { f.root = null; }, 'unknown', null],

  ['p.testsRun', 'cargo test in CI and a green rollup', null, 'ok', true],
  ['p.testsRun', 'a red rollup is unknown, never negative', (f) => {
    f.rollup = 'FAILURE';
  }, 'unknown', null],
  ['p.testsRun', 'no rollup', (f) => { f.rollup = null; }, 'unknown', null],
  ['p.testsRun', 'no workflows', (f) => { f.workflows = []; }, 'ok', false],
  ['p.testsRun', 'workflow text not fetched', (f) => {
    f.workflows = [{ name: 'ci.yml', text: null }];
  }, 'unknown', null],
  ['p.testsRun', 'echo-only CI', (f) => { f.workflows = workflow(['run: echo ok']); }, 'ok', false],
  ['p.testsRun', 'neutralised tests', (f) => {
    f.workflows = workflow(['run: cargo test || true']);
  }, 'ok', false],
  ['p.testsRun', 'workflows not fetched', (f) => { f.workflows = null; }, 'unknown', null],
  ['p.testsRun', 'the workflow that may run tests was not fetched', (f) => {
    f.workflows = [
      { name: 'lint.yml', text: workflow(['run: cargo clippy'])[0].text }, { name: 'test.yml', text: null },
    ];
  }, 'unknown', null],

  ['p.shipped', 'releases over nine weeks', null, 'ok', true],
  ['p.shipped', 'two releases on one day', (f) => {
    f.releases = { count: 2, recent: [
      { tag: 'v2', publishedAt: '2026-09-02T10:00:00Z', prerelease: false },
      { tag: 'v1', publishedAt: '2026-09-02T08:00:00Z', prerelease: false },
    ] };
  }, 'ok', false],
  ['p.shipped', 'releases six days apart', (f) => {
    f.releases = { count: 2, recent: [
      { tag: 'v2', publishedAt: '2026-09-08T10:00:00Z', prerelease: false },
      { tag: 'v1', publishedAt: '2026-09-02T10:00:00Z', prerelease: false },
    ] };
  }, 'ok', false],
  ['p.shipped', 'no releases', (f) => { f.releases = { count: 0, recent: [] }; }, 'ok', false],
  ['p.shipped', 'prereleases only', (f) => {
    for (const r of f.releases.recent) r.prerelease = true;
  }, 'ok', false],
  ['p.shipped', 'release dates not fetched', (f) => {
    f.releases = { count: 5, recent: [] };
  }, 'unknown', null],
  ['p.shipped', 'releases not fetched', (f) => { f.releases = null; }, 'unknown', null],

  ['p.coherent', 'every cited path exists', null, 'ok', true],
  ['p.coherent', 'most cited paths are missing', (f) => { f.readme.text = MISSING; }, 'ok', false],
  ['p.coherent', 'tree not fetched yet', (f) => { f.tree = null; }, 'unknown', null],
  ['p.coherent', 'README text not fetched', (f) => { f.readme.text = null; }, 'unknown', null],
  ['p.coherent', 'truncated tree', (f) => {
    f.readme.text = MISSING;
    f.tree.truncated = true;
  }, 'unknown', null],
  ['p.coherent', 'no README', (f) => { f.readme = null; }, 'na', null],
  ['p.coherent', 'fewer than five references', (f) => { f.readme.text = 'Just prose.\n'; }, 'na', null],

  ['s.incoherent', 'cited paths exist', null, 'ok', false],
  ['s.incoherent', 'most cited paths are missing', (f) => { f.readme.text = MISSING; }, 'ok', true],
  ['s.incoherent', 'tree not fetched yet', (f) => { f.tree = null; }, 'unknown', null],
  ['s.incoherent', 'truncated tree', (f) => {
    f.readme.text = MISSING;
    f.tree.truncated = true;
  }, 'unknown', null],
  ['s.incoherent', 'no README', (f) => { f.readme = null; }, 'na', null],

  ['s.webui', 'ordinary commit messages', null, 'ok', false],
  ['s.webui', 'twelve of twenty web-editor headlines', (f) => {
    f.commits.recent.slice(0, 12).forEach((/** @type {any} */ c, /** @type {number} */ i) => {
      c.headline = i % 2 ? 'Add files via upload' : 'Update README.md';
    });
  }, 'ok', true],
  ['s.webui', 'three commits are too few to judge', (f) => {
    f.commits.recent = f.commits.recent.slice(0, 3)
      .map((/** @type {any} */ c) => ({ ...c, headline: 'Create x.js' }));
  }, 'na', null],
  ['s.webui', 'history not fetched', (f) => { f.commits = null; }, 'unknown', null],

  ['s.template', 'no template marks', null, 'ok', false],
  ['s.template', 'the Vite template README', (f) => {
    f.readme.text = '# React + TypeScript + Vite\n\n'
      + 'This template provides a minimal setup to get React working.\n';
  }, 'ok', true],
  ['s.template', '.replit at the root', (f) => {
    f.root.push({ name: '.replit', type: 'blob' });
  }, 'ok', true],
  ['s.template', 'root not fetched', (f) => { f.root = null; }, 'unknown', null],

  ['s.prose', 'README small beside the code', null, 'ok', false],
  ['s.prose', 'README more than five times the code', (f) => { f.readme.bytes = 400000; }, 'ok', true],
  ['s.prose', 'language sizes not fetched', (f) => { f.codeBytes = null; }, 'unknown', null],

  ['s.mdheavy', 'one Markdown file', null, 'ok', false],
  ['s.mdheavy', 'four Markdown files over 10 KB of code', (f) => {
    for (const n of ['A.md', 'B.md', 'C.md']) f.root.push({ name: n, type: 'blob' });
    f.codeBytes = 10000;
  }, 'ok', true],
  ['s.mdheavy', 'root not fetched', (f) => { f.root = null; }, 'unknown', null],

  ['s.junk', 'nothing committed that should not be', null, 'ok', false],
  ['s.junk', 'node_modules at the root', (f) => {
    f.root.push({ name: 'node_modules', type: 'tree' });
  }, 'ok', true],
  ['s.junk', '__pycache__ deep in the tree', (f) => {
    f.tree.entries.push(['pkg/__pycache__/a.pyc', 'blob', 10]);
  }, 'ok', true],
  ['s.junk', '.env under examples/ is allowed', (f) => {
    f.tree.entries.push(['examples/.env', 'blob', 10]);
  }, 'ok', false],
  ['s.junk', '.env elsewhere', (f) => { f.tree.entries.push(['config/.env', 'blob', 10]); }, 'ok', true],
  ['s.junk', 'nothing fetched', (f) => {
    f.root = null;
    f.tree = null;
  }, 'unknown', null],

  ['s.farm', 'thirty repositories', null, 'ok', false],
  ['s.farm', 'a user with 250 repositories', (f) => { f.ownerInfo.publicRepos = 250; }, 'ok', true],
  ['s.farm', 'an organisation with 500', (f) => {
    f.ownerInfo.type = 'Organization';
    f.ownerInfo.publicRepos = 500;
  }, 'ok', false],
  ['s.farm', 'repository count unknown', (f) => { f.ownerInfo.publicRepos = null; }, 'unknown', null],
  ['s.farm', 'owner unknown', (f) => { f.ownerInfo = null; }, 'unknown', null],

  ['s.cloneUrl', 'no clone of another repository', null, 'ok', false],
  ['s.cloneUrl', 'git clone of a same-named repository elsewhere', (f) => {
    f.readme.text += `\n${FENCE}\ngit clone https://github.com/else/Tool.git\n${FENCE}\n`;
  }, 'ok', true],
  ['s.cloneUrl', 'git clone of this repository', (f) => {
    f.readme.text += `\n${FENCE}\ngit clone git@github.com:acme/tool.git\n${FENCE}\n`;
  }, 'ok', false],
  ['s.cloneUrl', 'no README', (f) => { f.readme = null; }, 'ok', false],
  ['s.cloneUrl', 'README text not fetched', (f) => { f.readme.text = null; }, 'unknown', null],
];

for (const [id, name, mutate, status, hit] of CASES) {
  test(`${id}: ${name}`, () => {
    const s = signalOf(facts(mutate ?? undefined), id);
    assert.equal(s.status, status, s.reason);
    assert.equal(s.hit, hit, s.reason);
    assert.equal(s.points, hit ? POINTS[id] : 0);
    assert.ok(s.reason.length > 0);
  });
}

test('every signal has hit, miss and unknown cases, and na where §5 defines it', () => {
  // §4.3: a null licence or README means none, so those two have no unknown state.
  const noUnknown = new Set(['q.licence', 'q.readme']);
  const withNa = new Set(['q.deps', 'p.coherent', 's.incoherent', 's.webui']);
  for (const id of ORDER) {
    const mine = CASES.filter((c) => c[0] === id);
    assert.ok(mine.some((c) => c[3] === 'ok' && c[4] === true), `${id} hit`);
    assert.ok(mine.some((c) => c[3] === 'ok' && c[4] === false), `${id} miss`);
    if (!noUnknown.has(id)) assert.ok(mine.some((c) => c[3] === 'unknown'), `${id} unknown`);
    if (withNa.has(id)) assert.ok(mine.some((c) => c[3] === 'na'), `${id} na`);
  }
});

test('config/weights.json holds the values of §5 and §6 and validates', () => {
  assert.deepEqual(validateWeights(weights), []);
  assert.equal(weights.version, 'w2');
  assert.deepEqual(Object.keys(weights.signals), [...ORDER, JUDGE_ID]);
  for (const def of SIGNALS) {
    const w = weights.signals[def.id];
    assert.equal(w.points, POINTS[def.id], def.id);
    assert.equal(w.points, def.points, def.id);
    assert.equal(w.kind, def.kind, def.id);
    assert.equal(w.group ?? null, def.group, def.id);
    assert.equal(w.provisional ?? false, def.provisional, def.id);
  }
  // w2 retired s.incoherent to 0 (§5.3), so the calibration step has decided it: no longer provisional.
  assert.deepEqual(ORDER.filter((id) => weights.signals[id].provisional),
    ['p.testsRun', 'p.shipped', 'p.coherent', 's.cloneUrl']);
  assert.deepEqual(weights.signals[JUDGE_ID], { points: { promote: 1, demote: -2 }, kind: 'judge' });
  const { bands, gem, attention, eligibility, confidenceBands, lanes } = weights;
  const model = {
    bands, gem, attention, eligibility, institutions: weights.institutions, confidenceBands, lanes,
  };
  assert.deepEqual(model, {
    bands: { gem: 7, look: 5 }, gem: { kWeight: 1.5, aWeight: 1.5 }, attention: { saturation: 25 },
    eligibility: { maxStars: 25, risingGain4w: 10 }, institutions: { orgMinRepos: 100 },
    confidenceBands: { medium: 0.3, high: 0.6 }, lanes: { provenK: 0.5 },
  });
  for (const item of CONFIDENCE_ITEMS) {
    assert.equal(weights.confidence[item.id].group, item.group, item.id);
    assert.equal(weights.confidence[item.id].max, item.max, item.id);
  }
  assert.ok(weights.changelog.some((/** @type {any} */ c) => c.version === 'w1' && c.date && c.change));
  const w2 = weights.changelog.find((/** @type {any} */ c) => c.version === 'w2');
  assert.ok(w2?.date && /s\.incoherent/.test(w2.change) && w2.evidence, 'w2 records its change and evidence');
});

test('config/institutions.json validates; names are lower-case', () => {
  assert.deepEqual(validateInstitutions(institutions), []);
  for (const n of [...institutions.allow, ...institutions.deny]) assert.equal(n, n.toLowerCase());
  for (const n of ['nasa', 'ibm', 'nvidia', 'elastic', 'alphagov']) {
    assert.ok(institutions.allow.includes(n), n);
  }
  assert.deepEqual(institutions.deny, []);
});

test('registry: §5.3 order, labels, hints and costs; the judge follows elsewhere', () => {
  assert.deepEqual(SIGNALS.map((s) => s.id), ORDER);
  assert.equal(JUDGE_ID, 'llm.review');
  for (const s of SIGNALS) {
    assert.ok(Object.isFrozen(s));
    assert.ok(s.label && s.hint, s.id);
    assert.equal(s.cost === null, s.kind === 'slop' && s.id !== 's.incoherent', s.id);
  }
  assert.deepEqual(CONFIDENCE_ITEMS.map((c) => [c.id, c.group, c.max]), [
    ['k.owner', 'owner', 0.3], ['k.time', 'time', 0.25], ['k.pushDays', 'time', 0.4],
    ['k.releases', 'releases', 0.3], ['k.outsiders', 'people', 0.45], ['k.ciVerified', 'ci', 0.15],
  ]);
  const american = /\b(organization|color|behavior|analyze|recognize|license)\b/i;
  const texts = [...SIGNALS, ...CONFIDENCE_ITEMS].flatMap((s) => [s.label, s.hint]);
  for (const t of [...texts, ...Object.values(DESCRIPTOR_LABELS)]) assert.ok(!american.test(t), t);
});

test('signals validate, evidence points at the scored commit, and weights override the registry', () => {
  const f = facts();
  const sigs = evaluateSignals(f, { weights, now: NOW });
  for (const s of sigs) assert.deepEqual(validateSignal(s), [], s.id);
  assert.equal(sigs.reduce((a, s) => a + /** @type {number} */ (s.points), 0), 13);
  const readme = sigs.find((s) => s.id === 'q.readme');
  assert.equal(readme?.evidence[0].url, 'https://github.com/acme/tool/blob/4f1c2e9d0b7a/README.md');
  assert.deepEqual(evaluateSignals(f), sigs, 'the registry defaults equal weights.json');
  const heavier = structuredClone(weights);
  heavier.signals['q.code'].points = 2;
  const code = evaluateSignals(f, { weights: heavier }).find((s) => s.id === 'q.code');
  assert.equal(code?.weight, 2);
  assert.equal(code?.points, 2);
  const broken = evaluateSignals(/** @type {any} */ ({ ...f, root: 'not an array', tree: 7 }), { weights });
  assert.equal(broken.length, ORDER.length, 'odd facts never throw');
});

/** §5.3 evidence columns: firing counts of the root-level rules on the pooled labels (G / rest). */
/** @type {Record<string, [number, number]>} */
const EVIDENCE = {
  'q.licence': [65, 27], 'q.readme': [71, 36], 'q.usage': [64, 20], 'q.ci': [60, 23], 'q.manifest': [71, 25],
  'q.deps': [52, 17], 'q.tests': [36, 8], 'q.code': [70, 41], 'q.release': [62, 7], 'q.examples': [12, 1],
  's.webui': [0, 9], 's.template': [0, 3], 's.prose': [0, 9], 's.mdheavy': [0, 2], 's.junk': [0, 5],
  's.farm': [2, 4], 's.cloneUrl': [0, 0],
};

/**
 * Two evidence columns were measured with rules other than the ones §5.2/§5.3 state; the fixtures
 * reproduce the rules as written, exactly (reported as contract deviations):
 * - q.tests 36 / 8 counted extra directory names (`specs/`, `integration_test/`, `test-support/`),
 *   which §5.2 does not list; the three genuine repositories that differ are jonny981/obversa,
 *   LayerZero-Labs/akita and openshift/assisted-image-service.
 * - s.webui 0 / 9 ignored the rule's own "at least 4 commits" floor; the two coursework
 *   repositories with 1 and 2 commits do not fire under the rule as written.
 * @type {Record<string, [number, number]>}
 */
const AS_WRITTEN = { 'q.tests': [33, 8], 's.webui': [0, 7] };

test('firing counts on the labelled fixtures match the §5.3 evidence columns (±1)', () => {
  const labels = loadLabelled();
  /** @type {Record<string, [number, number]>} */
  const counts = {};
  let genuine = 0;
  let rest = 0;
  for (const [nwo, lab] of Object.entries(labels)) {
    const fx = loadRepoFixture(nwo);
    const snapshot = fx.meta?.labelledSnapshot
      ? loadJsonFixture(`repos/${fx.name}/${fx.meta.labelledSnapshot}`) : fx.enrich;
    if (!snapshot) continue; // the two meta-only fixtures that answered 502 in research
    const at = fx.meta?.researchRecordedAt ?? fx.meta?.recordedAt ?? NOW;
    const f = factsFromEnrich(snapshot, { fetchedAt: at, source: 'fixture' });
    const g = lab.cat === 'G';
    if (g) genuine++;
    else rest++;
    for (const s of evaluateSignals(f, { weights, now: NOW })) {
      counts[s.id] ??= [0, 0];
      if (s.hit) counts[s.id][g ? 0 : 1]++;
    }
  }
  assert.deepEqual([genuine, rest], [74, 73]);
  for (const [id, column] of Object.entries(EVIDENCE)) {
    const got = counts[id];
    const exact = AS_WRITTEN[id];
    const want = exact ?? column;
    const tolerance = exact ? 0 : 1;
    const ok = Math.abs(got[0] - want[0]) <= tolerance && Math.abs(got[1] - want[1]) <= tolerance;
    assert.ok(ok, `${id}: measured ${got.join(' / ')}, expected ${want.join(' / ')}`);
  }
  for (const id of ['p.testsRun', 'p.shipped', 'p.coherent', 's.incoherent']) {
    assert.deepEqual(counts[id], [0, 0], `${id} is not observable on research snapshots`);
  }
});

/**
 * §6.4 K from confidence items.
 * @param {import('../src/core/schema.mjs').Signal[]} items
 */
function kOf(items) {
  /** @type {Record<string, number>} */
  const best = {};
  for (const it of items) {
    const g = String(it.group);
    best[g] = Math.max(best[g] ?? 0, it.strength ?? 0);
  }
  return 1 - Object.values(best).reduce((p, s) => p * (1 - s), 1);
}

test('§6.9 worked example: skulitom/london-time-map scores 7 at enrich and 8 at deep, K 0.30', () => {
  const fx = loadRepoFixture('skulitom/london-time-map');
  const enrich = factsFromEnrich(fx.enrich, { fetchedAt: fx.meta.recordedAt });
  /** @param {any} f */
  const hits = (f) => evaluateSignals(f, { weights, now: NOW }).filter((s) => s.hit).map((s) => s.id);
  const seven = ['q.licence', 'q.readme', 'q.usage', 'q.ci', 'q.manifest', 'q.deps', 'q.code'];
  assert.deepEqual(hits(enrich), seven);
  const deep = mergeDeep(enrich, { node: fx.deep, tree: fx.tree, activity: fx.activity, files: fx.files });
  const sigs = evaluateSignals(deep, { weights, now: NOW });
  assert.deepEqual(sigs.filter((s) => s.hit).map((s) => s.id), [...seven, 'p.coherent']);
  /** @type {Record<string, import('../src/core/schema.mjs').Signal>} */
  const by = Object.fromEntries(sigs.map((s) => [s.id, s]));
  assert.equal(by['s.webui'].status, 'na', 'two commits are never penalised');
  for (const id of ['q.tests', 'q.release', 'p.shipped', 'p.testsRun']) assert.notEqual(by[id].hit, true, id);
  const k = kOf(evaluateConfidence(deep, sigs, { weights, now: NOW }));
  assert.equal(Math.round(k * 100) / 100, 0.3);
});

test('§6.9 worked example: codefly-dev/cli proves its tests and its releases at deep', () => {
  const fx = loadRepoFixture('codefly-dev/cli');
  const enrich = factsFromEnrich(fx.enrich, { fetchedAt: fx.meta.recordedAt });
  const deep = mergeDeep(enrich, { node: fx.deep, tree: fx.tree, activity: fx.activity, files: fx.files });
  const by = Object.fromEntries(evaluateSignals(deep, { weights, now: NOW }).map((s) => [s.id, s]));
  assert.equal(by['p.testsRun'].hit, true);
  assert.match(String(by['p.testsRun'].value), /go test/);
  assert.equal(by['p.shipped'].hit, true);
  const quality = ORDER.filter((id) => id.startsWith('q.') && by[id].hit);
  assert.equal(quality.length, 9, 'nine quality points, as in the fixtures');
  // Weights w2 retired s.incoherent (§5.3): it still fires here and is shown, but is worth nothing.
  const incoherent = by['s.incoherent'];
  assert.deepEqual([incoherent.status, incoherent.hit, incoherent.weight, incoherent.points],
    ['ok', true, 0, 0]);
  assert.deepEqual(incoherent.value, { cited: 11, resolved: 3 });
  const S = Object.values(by).reduce((a, s) => a + /** @type {number} */ (s.points), 0);
  assert.equal(S, 11, 'nine quality points and two proof points = 11 (§6.9; 10 under w1)');
});

/**
 * [item, case, mutation, status, strength, now]
 * @typedef {[string, string, ((f: any) => void) | null, 'ok' | 'unknown', number, string | null]} ItemCase
 */

/** @type {ItemCase[]} */
const ITEMS = [
  ['k.owner', 'three contribution years before 2024', null, 'ok', 0.3, NOW],
  ['k.owner', 'one year before 2024', (f) => {
    f.ownerInfo.contributionYears = [2020, 2025];
  }, 'ok', 0.15, NOW],
  ['k.owner', 'only recent years', (f) => { f.ownerInfo.contributionYears = [2024, 2025]; }, 'ok', 0, NOW],
  ['k.owner', 'contribution years not fetched', (f) => {
    f.ownerInfo.contributionYears = null;
  }, 'unknown', 0, NOW],
  ['k.owner', 'an organisation of 2020', (f) => {
    Object.assign(f.ownerInfo, { type: 'Organization', createdAt: '2020-05-01T00:00:00Z' });
  }, 'ok', 0.15, NOW],
  ['k.owner', 'an organisation of 2026', (f) => {
    Object.assign(f.ownerInfo, { type: 'Organization', createdAt: '2026-01-01T00:00:00Z' });
  }, 'ok', 0, NOW],
  ['k.owner', 'organisation age without a clock', (f) => {
    Object.assign(f.ownerInfo, { type: 'Organization', createdAt: '2020-05-01T00:00:00Z' });
  }, 'unknown', 0, null],

  ['k.time', 'pushed 238 days after creation', null, 'ok', 0.25, NOW],
  ['k.time', 'pushed 40 days after creation', (f) => {
    f.pushedAt = '2026-02-19T09:00:00Z';
  }, 'ok', 0.1, NOW],
  ['k.time', 'pushed 10 days after creation', (f) => { f.pushedAt = '2026-01-20T09:00:00Z'; }, 'ok', 0, NOW],
  ['k.time', 'creation time unknown', (f) => { f.createdAt = null; }, 'unknown', 0, NOW],

  ['k.pushDays', '25 push days over eight months', null, 'ok', 0.4, NOW],
  ['k.pushDays', '6 push days over 40 days', (f) => {
    f.activity = {
      pushDays: 6, firstAt: '2026-08-01T00:00:00Z', lastAt: '2026-09-10T00:00:00Z', forcePushes: 0,
    };
  }, 'ok', 0.25, NOW],
  ['k.pushDays', '3 push days', (f) => {
    f.activity = {
      pushDays: 3, firstAt: '2026-01-01T00:00:00Z', lastAt: '2026-09-10T00:00:00Z', forcePushes: 0,
    };
  }, 'ok', 0, NOW],
  ['k.pushDays', 'activity not fetched', (f) => { f.activity = null; }, 'unknown', 0, NOW],

  ['k.releases', 'three releases over 63 days', null, 'ok', 0.3, NOW],
  ['k.releases', 'three releases over 20 days', (f) => {
    f.releases.recent[1].publishedAt = '2026-08-25T10:00:00Z';
    f.releases.recent[2].publishedAt = '2026-08-13T10:00:00Z';
  }, 'ok', 0, NOW],
  ['k.releases', 'no releases', (f) => { f.releases = { count: 0, recent: [] }; }, 'ok', 0, NOW],
  ['k.releases', 'releases not fetched', (f) => { f.releases = null; }, 'unknown', 0, NOW],

  ['k.outsiders', 'one established outsider', null, 'ok', 0.15, NOW],
  ['k.outsiders', 'four established outsiders are capped', (f) => {
    f.outsiders = ['a', 'b', 'c', 'd'].map((login) => ({
      login, kind: 'pr', at: '2026-08-01T00:00:00Z', accountCreatedAt: '2019-01-01T00:00:00Z',
    }));
  }, 'ok', 0.45, NOW],
  ['k.outsiders', 'the owner, a committer and a new account do not count', (f) => {
    const at = '2026-08-01T00:00:00Z';
    f.outsiders = [
      { login: 'ACME', kind: 'issue', at, accountCreatedAt: '2012-01-01T00:00:00Z' },
      { login: 'helper', kind: 'pr', at, accountCreatedAt: '2012-01-01T00:00:00Z' },
      { login: 'fresh', kind: 'issue', at, accountCreatedAt: '2026-03-01T00:00:00Z' },
    ];
    f.commits.recent[0].authorLogin = 'helper';
  }, 'ok', 0, NOW],
  ['k.outsiders', 'authors not fetched', (f) => { f.outsiders = null; }, 'unknown', 0, NOW],

  ['k.ciVerified', 'CI runs the tests and passes', null, 'ok', 0.15, NOW],
  ['k.ciVerified', 'no workflows', (f) => { f.workflows = []; }, 'ok', 0, NOW],
  ['k.ciVerified', 'CI state red', (f) => { f.rollup = 'FAILURE'; }, 'unknown', 0, NOW],
];

for (const [id, name, mutate, status, strength, now] of ITEMS) {
  test(`${id}: ${name}`, () => {
    const f = facts(mutate ?? undefined);
    const items = evaluateConfidence(f, evaluateSignals(f, { weights, now }), { weights, now });
    const it = items.find((x) => x.id === id);
    assert.ok(it);
    assert.deepEqual(validateSignal(it), []);
    assert.equal(it.status, status, it.reason);
    assert.equal(it.strength, strength, it.reason);
    assert.equal(it.hit, status === 'ok' ? strength > 0 : null);
  });
}

/** A workflow whose only test step sets `continue-on-error: true` (modavis-project/omaro's audit). */
const AUDIT = {
  name: 'upstream-audit.yml',
  text: ['jobs:', '  audit:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4',
    '      - id: candidate-tests', '        continue-on-error: true', '        run: pytest', ''].join('\n'),
};

test('p.testsRun: a neutralised test step is unknown while another workflow is unfetched (§5.2)', () => {
  const partial = facts((f) => {
    f.workflows = [AUDIT, { name: 'validate.yml', text: null }, { name: 'notes.md', text: null }];
  });
  const tr = signalOf(partial, 'p.testsRun');
  assert.equal(tr.status, 'unknown', tr.reason);
  assert.equal(tr.hit, null);
  assert.equal(tr.points, 0);
  assert.equal(tr.reason, 'CI runs pytest but ignores its failures; 1 workflow not fetched');
  assert.equal(tr.value, 'pytest');
  const two = facts((f) => {
    f.workflows = [AUDIT, { name: 'validate.yml', text: null }, { name: 'verify.yaml', text: null }];
  });
  assert.equal(signalOf(two, 'p.testsRun').reason, 'CI runs pytest but ignores its failures; 2 workflows not fetched');
  const ci = evaluateConfidence(partial, evaluateSignals(partial, { weights, now: NOW }), { weights, now: NOW })
    .find((x) => x.id === 'k.ciVerified');
  assert.equal(ci?.status, 'unknown', 'k.ciVerified is not a known 0');
  assert.equal(ci?.strength, 0);

  // Every workflow fetched: the neutralised step is the only test step, so it is still a miss.
  const whole = facts((f) => { f.workflows = [AUDIT]; });
  const miss = signalOf(whole, 'p.testsRun');
  assert.equal(miss.status, 'ok');
  assert.equal(miss.hit, false);
  assert.equal(miss.reason, 'CI runs pytest but ignores its failures');
  const known = evaluateConfidence(whole, null, { weights, now: NOW }).find((x) => x.id === 'k.ciVerified');
  assert.equal(known?.status, 'ok');
  assert.equal(known?.strength, 0);
  // A test step that is not neutralised, fetched, still wins over an unfetched workflow.
  const plain = facts((f) => { f.workflows = [...workflow(['run: cargo test']), { name: 'x.yml', text: null }]; });
  assert.equal(signalOf(plain, 'p.testsRun').hit, true);
});

test('k.owner reports the owner type for an organisation; the organisation ceiling is 0.15 (§5.4)', () => {
  assert.equal(ORG_OWNER_MAX, 0.15);
  /** @param {any} f */
  const owner = (f, now = NOW) => evaluateConfidence(f, null, { weights, now }).find((x) => x.id === 'k.owner');
  const old = facts((f) => {
    Object.assign(f.ownerInfo, { type: 'Organization', createdAt: '2022-04-26T00:00:00Z' });
  });
  const it = owner(old);
  assert.equal(it?.strength, ORG_OWNER_MAX);
  assert.deepEqual(it?.value, { ownerType: 'Organization', days: 1599 });
  const young = facts((f) => {
    Object.assign(f.ownerInfo, { type: 'Organization', createdAt: '2026-01-01T00:00:00Z' });
  });
  assert.deepEqual(owner(young)?.value, { ownerType: 'Organization', days: 253 });
  assert.equal(owner(young)?.strength, 0);
  const clockless = owner(old, /** @type {any} */ (null));
  assert.equal(clockless?.status, 'unknown');
  assert.deepEqual(clockless?.value, { ownerType: 'Organization', days: null });
  assert.equal(owner(facts())?.value, 3, 'a user still reports contribution years before 2024');
});

test('confidence without signals evaluates p.testsRun itself; the control reaches K of 0.79', () => {
  const f = facts();
  const items = evaluateConfidence(f, null, { weights, now: NOW });
  assert.equal(items.find((i) => i.id === 'k.ciVerified')?.strength, 0.15);
  assert.equal(Math.round(kOf(items) * 100) / 100, 0.79);
});

test('descriptors of §5.6 are neutral and fire on their rules', () => {
  assert.deepEqual(describe(facts()), []);
  const agent = describe(facts((f) => {
    f.root.push({ name: 'CLAUDE.md', type: 'blob' }, { name: '.cursor', type: 'tree' });
    f.agentsMdBytes = 900;
  }));
  assert.deepEqual(agent,
    [{ id: 'd.agent', label: 'Agent-assisted', detail: 'CLAUDE.md, .cursor/, AGENTS.md' }]);
  const copilot = describe(facts((f) => {
    f.tree.entries.push(['.github/copilot-instructions.md', 'blob', 10]);
  }));
  assert.deepEqual(copilot.map((d) => d.id), ['d.agent']);
  /** @param {(f: any) => void} m */
  const ids = (m) => describe(facts(m)).map((d) => d.id);
  assert.deepEqual(ids((f) => { f.commits.total = 3; }), ['d.squashed']);
  const chinese = '这是一个中文的自述文件，介绍这个日志工具如何安装和使用，以及它能做什么。';
  assert.deepEqual(ids((f) => { f.readme.text = chinese; }), ['d.script']);
  assert.deepEqual(ids((f) => { f.homepageUrl = 'https://tool.example'; }), ['d.demo']);
  assert.deepEqual(ids((f) => { f.commits.recent[19].at = '2025-06-01T00:00:00Z'; }), ['d.imported']);
  assert.deepEqual(ids((f) => {
    f.commits.total = 250;
    f.tree.count = 2500;
  }), ['d.sprawl']);
  const sponsor = [{ platform: 'GITHUB', url: 'https://github.com/sponsors/acme' }];
  assert.deepEqual(ids((f) => { f.funding = sponsor; }), ['d.funding']);
  assert.deepEqual(ids((f) => { f.ownerInfo.sponsorsListing = true; }), ['d.funding']);
  const before = evaluateSignals(facts(), { weights, now: NOW }).map((s) => s.points);
  const after = evaluateSignals(facts((f) => {
    f.homepageUrl = 'https://tool.example';
    f.funding = sponsor;
  }), { weights, now: NOW }).map((s) => s.points);
  assert.deepEqual(after, before, 'descriptors never change points');
});
