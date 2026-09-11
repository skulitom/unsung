// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BANDS, CANDIDATE_STATES, FEEDBACK_ACTIONS, LABELS, LANES, SIGNAL_KINDS, STORE_VERSION,
  labelFromFeedback, repoPath, validateCalibration, validateCandidate, validateDefaults, validateFacts,
  validateFeedback, validateIndex, validateRepoRecord, validateRunManifest, validateScore, validateSignal,
  validateTaste, validateUnit, validateVerdict, validateVerdictOutput, validateWeights,
} from '../src/core/schema.mjs';

// The §4.3 examples. "…" is kept wherever the contract elides a plain string; `nwo` gets a real
// owner/name and `/* … */` placeholders are filled with the other examples.

const SIGNAL = {
  id: 'q.release', kind: 'quality', status: 'ok', hit: true, value: 3, weight: 1, points: 1, strength: null,
  group: null, provisional: false, cost: 'cheap', label: 'Ships releases',
  reason: '3 releases, latest v0.3.0 on 2 Sep',
  evidence: [{ label: 'releases', url: 'https://github.com/o/r/releases' }],
};
const CONFIDENCE_ITEM = {
  id: 'k.owner', kind: 'confidence', status: 'ok', hit: true, value: 10, weight: null, points: null,
  strength: 0.3, group: 'owner', provisional: false, cost: 'costly', label: 'Owner history',
  reason: '10 contribution years before 2024',
  evidence: [],
};
const GATE = { id: 'g.lure.link', action: 'quarantine', reason: '…', evidence: [] };
const DESCRIPTOR = { id: 'd.agent', label: 'Agent-assisted', detail: 'CLAUDE.md, AGENTS.md' };

const CANDIDATE = {
  v: 1, id: 'R_…', nwo: 'zaghaghi/toolog', day: '2026-09-08',
  createdAt: '…', pushedAt: '…', stars: 5, forks: 0, diskKB: 812,
  lang: 'Rust', licence: 'MIT', hasDesc: true, ownerType: 'User',
  sources: ['census:2026-09-08'],
  seenAt: '…', prior: 3, explore: false,
  state: 'queued', reason: null, nextAt: null, result: null,
};
const PATCH = {
  v: 1, patch: true, id: 'R_…', day: '2026-09-08', at: '…',
  set: {
    state: 'enriched',
    result: { headOid: '9f3c…', S: 8, band: 'gem', lane: 'promising', gem: 8.45, at: '…' },
  },
};

const FACTS = {
  v: 1, id: 'R_…', nwo: 'owner/name', owner: 'owner', name: 'name',
  fetchedAt: '…', source: 'graphql', stages: ['enrich', 'deep'],
  headOid: '9f3c…', defaultBranch: 'main',
  createdAt: '…', pushedAt: '…', description: '…', homepageUrl: null,
  isFork: false, isArchived: false, isTemplate: false, isMirror: false,
  hasIssues: true, hasDiscussions: false,
  stars: 5, forks: 0, watchers: 1, diskKB: 812,
  licence: 'MIT', primaryLanguage: 'Rust',
  languages: [{ name: 'Rust', bytes: 148213 }], codeBytes: 150021,
  topics: ['mcp', 'cli'],
  releases: { count: 3, recent: [{ tag: 'v0.3.0', publishedAt: '…', prerelease: false }] },
  tags: 3,
  ownerInfo: {
    login: '…', type: 'User', createdAt: '…', publicRepos: 12, contributionYears: [2012, 2015, 2026],
    sponsorsListing: false,
  },
  commits: { total: 42, recent: [{ at: '…', headline: '…', authorLogin: '…' }] },
  rollup: 'SUCCESS',
  root: [{ name: 'src', type: 'tree' }, { name: 'README.md', type: 'blob' }],
  workflows: [{ name: 'ci.yml', text: null }],
  readme: { name: 'README.md', bytes: 7890, truncated: false, text: '…' },
  packageJson: { name: 'toolog', deps: 0, devDeps: 2, testScript: 'node --test' },
  manifest: { path: 'Cargo.toml', text: '…' },
  agentsMdBytes: 0, claudeMdBytes: 0,
  tree: { truncated: false, count: 128, entries: [['src/main.rs', 'blob', 1234]] },
  activity: { pushDays: 12, firstAt: '…', lastAt: '…', forcePushes: 0 },
  starHistory: { weeks: [{ week: '2026-09-06', gained: 1 }], gain4w: 2 },
  outsiders: [{ login: '…', kind: 'issue', at: '…', accountCreatedAt: '…' }],
  funding: [{ platform: 'GITHUB', url: '…' }],
  heavy: false,
};

const SCORE = {
  v: 1, id: 'R_…', nwo: 'owner/name', headOid: '…', scoredAt: '…',
  model: { weights: 'w1', calibration: 'c1', rubric: null },
  signals: [SIGNAL],
  S: 8, pointsMax: 13, coverage: 0.92,
  quality: 0.92, band: 'gem',
  confidence: { k: 0.30, band: 'medium', items: [CONFIDENCE_ITEM] },
  attention: { stars: 0, forks: 0, watchers: 0, gain4w: null, a: 0 },
  gem: 8.45,
  lane: 'promising',
  gates: [GATE], descriptors: [DESCRIPTOR],
};

const VERDICT_OUTPUT = {
  category: 'G', categoryConfidence: 0.8,
  scores: { purpose: 4, craft: 3, verification: 3, honesty: 4, originality: 3 },
  claims: [{
    text: 'Parses the log format', path: 'src/main.rs', quote: 'fn parse_line(', supports: 'craft',
  }],
  flags: [], pitch: '…', audience: '…', summary: '…', injectionSeen: false,
};

const VERDICT = {
  v: 1, id: 'R_…', nwo: 'owner/name', headOid: '…', rubric: 'r1',
  backend: 'claude-cli', model: 'claude-opus-5', at: '…',
  status: 'ok',
  output: VERDICT_OUTPUT,
  validation: { claimsKept: 4, claimsDropped: 1, problems: [] },
  effect: { points: 1, lane: null, reason: 'Judged genuine (mean 3.4/4) with 4 verified claims' },
  costUsd: 0.12, usage: { input: 12004, output: 2210 }, packBytes: 41234, durationMs: 53000,
};

const RECORD = {
  v: 1, id: 'R_…', nwo: 'owner/name',
  candidate: { ...CANDIDATE, nwo: 'owner/name' }, facts: FACTS, score: SCORE,
  firstSeen: { at: '…', headOid: '…', S: 7, stars: 0 },
  history: [
    { at: '…', headOid: '…', S: 8, quality: 0.92, k: 0.3, gem: 8.45, lane: 'promising', stars: 0 },
  ],
  verdict: null,
  checkedAt: '…', gone: false,
};

const FEEDBACK = {
  v: 1, at: '…', id: 'R_…', nwo: 'owner/name',
  action: 'gem', label: 'G', reason: null, note: '',
  blind: false, undoes: null, snoozeUntil: null,
  context: {
    view: 'promising', position: 3, S: 8, quality: 0.92, gem: 8.45, k: 0.3, stars: 0, weights: 'w1',
    calibration: 'c1',
  },
};

const TASTE = { v: 1, updatedAt: '…', facets: { 'lang:rust': { gems: 3, notmine: 1, pin: 0 } } };

const UNIT = {
  v: 1, key: 'census:2026-09-08:all:2026-09-08T13:00:00Z..2026-09-08T13:59:59Z',
  stage: 'census', state: 'done', attempts: 1, at: '…', runId: '…',
  out: { count: 612, pages: 7, saturated: false, seeds: 611 }, err: null, nextAt: null,
};

const RUN_SUMMARY = {
  v: 1, runId: '…', startedAt: '…', endedAt: '…', argv: ['run', '--budget', '10m'],
  profile: 'quick', budget: { wallMs: 600000, graphqlMs: 450000 },
  stages: {
    census: { days: ['2026-09-08'], units: 9, pages: 33, seeds: 3301, saturated: 0 },
    archive: { hours: ['2026-09-11-14'], events: 302, lookups: 2, seeds: 71 },
    prefilter: {
      in: 3372, queued: 2610, deferred: 120, quarantined: 3, dropped: { 'no-language': 402, 'owner-cap': 41 },
    },
    enrich: { repos: 462, calls: 39, halvings: 1, heavy: 0, gone: 7, explore: 23 },
    deep: { repos: 50, graphqlCalls: 20, restCalls: 116 },
    score: { gem: 51, look: 88, low: 323, lanes: { promising: 44, proven: 7 } },
    recheck: { checked: 100, gone: 2, requeued: 5 },
  },
  rate: {
    graphql: { points: 98, serverMs: 447100, remaining: 4812 },
    rest: { calls: 116, notModified: 4, remaining: 4870 },
    pauses: [{ resource: 'graphql', ms: 60000, why: 'secondary' }],
  },
  exit: { code: 0, reason: 'finished', resumeAt: null },
};

const ENTRY = {
  id: 'R_…', nwo: 'owner/name', description: '…',
  lang: 'Rust', topics: ['mcp'], createdAt: '…', pushedAt: '…', ageDays: 3,
  lane: 'promising', band: 'gem', S: 8, pointsMax: 13, coverage: 0.92,
  quality: 0.92, k: 0.3, kBand: 'medium', a: 0, gem: 8.45,
  stars: 0, forks: 0, gain4w: null, spark: null,
  chips: [{ id: 'q.release', points: 1, status: 'ok', hit: true, label: 'Ships releases' }],
  top: ['Ships releases: 3 releases, latest v0.3.0 on 2 Sep'], negatives: [],
  descriptors: ['d.agent'], gates: [],
  verdict: null,
  facets: ['lang:rust', 'topic:mcp', 'owner:user', 'script:latin'],
  feedback: { last: null, published: false, snoozeUntil: null },
  headOid: '…',
};

const INDEX = {
  v: 1, generatedAt: '…',
  model: { weights: {}, calibration: {} },
  counts: {
    promising: 44, proven: 7, look: 88, institutional: 12, doubted: 3, rising: 1, graduated: 0, quarantine: 3,
  },
  lastRun: RUN_SUMMARY,
  entries: [ENTRY, {
    id: 'R_q', nwo: 'islna637/crush-flake', lane: 'quarantine', gates: [{ id: 'g.lure.link', reason: '…' }],
  }],
};

const WEIGHTS = {
  version: 'w1',
  signals: {
    'q.licence': { points: 1, kind: 'quality' },
    'p.testsRun': { points: 1, kind: 'proof', provisional: true },
    's.prose': { points: -2, kind: 'slop', group: 'prose' },
    'llm.review': { points: [1, -2], kind: 'judge' },
  },
  confidence: { 'k.owner': { group: 'owner' } },
  bands: { gem: 7, look: 5 }, gem: { kWeight: 1.5, aWeight: 1.5 }, attention: { saturation: 25 },
  eligibility: { maxStars: 25, risingGain4w: 10 }, institutions: { orgMinRepos: 100 },
  confidenceBands: { medium: 0.3, high: 0.6 }, lanes: { provenK: 0.5 }, changelog: [],
};

const CALIBRATION = {
  version: 'c1', method: 'platt-pooled-slope-uniform-intercept', a: -6.403, b: 1.113,
  fittedOn: { labels: 149, uniform: 69, positives: 74, uniformPositives: 9, base: 0.141, weights: 'w1' },
  fittedAt: '2026-09-11',
};

/** §9.3, verbatim. */
const DEFAULTS_9_3 = {
  version: 1,
  profiles: {
    quick: { budget: '10m', archiveHours: 3, deepTopN: 50, enrichMax: 1000, recheckTop: 100 },
    daily: { budget: null, archiveHours: 24, deepTopN: 400, enrichMax: 12000, recheckTop: 2000 },
  },
  lagDays: 3, backfillDays: 0, maxStars: 25, ownerCapPerDay: 5, explore: 0.05, queueTtlDays: 14,
  shares: { census: 0.30, archive: 0.05, enrichUntil: 0.85 },
  governor: { graphqlMsPerMin: 45000, restMsPerMin: 20000, searchGapMs: 2100, restConcurrency: 2 },
  batch: {
    enrich: { size: 12, min: 1, max: 20, targetMs: 6000 },
    deep: { size: 5, min: 1, max: 10, targetMs: 5000 },
    lookup: { size: 100, min: 10, max: 100, targetMs: 5000 },
  },
  caps: { readmeBytes: 32768, fileBytes: 16384, treeEntries: 5000, indexEntries: 20000 },
  server: { port: 8750 },
  llm: {
    backend: 'none', model: 'claude-opus-5', effort: 'high', maxUsd: 3.0, perCallUsd: 0.5,
    cliTimeoutMs: 180000, endpoint: 'https://api.anthropic.com', claudePath: null, fallbacks: true,
    prices: { 'claude-opus-5': { input: 5, output: 25 } },
  },
};

/**
 * @template T
 * @param {T} x
 * @returns {any}
 */
const clone = (x) => structuredClone(x);

/**
 * @param {string[]} errs
 * @param {RegExp} pattern
 */
function hasError(errs, pattern) {
  const message = `expected an error matching ${pattern}, got ${JSON.stringify(errs)}`;
  assert.ok(errs.some((e) => pattern.test(e)), message);
}

test('constants match the contract', () => {
  assert.equal(STORE_VERSION, 1);
  assert.deepEqual(LABELS, ['G', 'W', 'C', 'P', 'S', 'D', 'X', 'E']);
  assert.deepEqual(BANDS, ['gem', 'look', 'low']);
  assert.deepEqual(LANES, ['quarantine', 'gone', 'institutional', 'graduated', 'rising', 'doubted', 'proven',
    'promising', 'look', 'low']);
  assert.deepEqual(CANDIDATE_STATES,
    ['queued', 'deferred', 'dropped', 'quarantined', 'enriched', 'gone', 'heavy', 'expired']);
  assert.deepEqual(FEEDBACK_ACTIONS,
    ['gem', 'wip', 'notgood', 'notmine', 'snooze', 'undo', 'publish', 'unpublish', 'label']);
  assert.deepEqual(SIGNAL_KINDS, ['quality', 'proof', 'slop', 'judge', 'confidence', 'descriptor']);
  assert.ok(Object.isFrozen(LANES));
});

test('every §4.3 and §4.4 example is valid', () => {
  assert.deepEqual(validateCandidate(CANDIDATE), []);
  assert.deepEqual(validateCandidate(PATCH), []);
  assert.deepEqual(validateFacts(FACTS), []);
  assert.deepEqual(validateSignal(SIGNAL), []);
  assert.deepEqual(validateSignal(CONFIDENCE_ITEM), []);
  assert.deepEqual(validateScore(SCORE), []);
  assert.deepEqual(validateRepoRecord(RECORD), []);
  assert.deepEqual(validateRepoRecord({ ...RECORD, verdict: VERDICT }), []);
  assert.deepEqual(validateVerdictOutput(VERDICT_OUTPUT), []);
  assert.deepEqual(validateVerdict(VERDICT), []);
  assert.deepEqual(validateFeedback(FEEDBACK), []);
  assert.deepEqual(validateTaste(TASTE), []);
  assert.deepEqual(validateUnit(UNIT), []);
  assert.deepEqual(validateRunManifest(RUN_SUMMARY), []);
  assert.deepEqual(validateRunManifest({ ...RUN_SUMMARY, units: [UNIT] }), []);
  assert.deepEqual(validateIndex(INDEX), []);
  assert.deepEqual(validateWeights(WEIGHTS), []);
  assert.deepEqual(validateCalibration(CALIBRATION), []);
  assert.deepEqual(validateDefaults(DEFAULTS_9_3), []);
});

test('config/defaults.json is exactly §9.3 and valid', () => {
  const file = JSON.parse(readFileSync(new URL('../config/defaults.json', import.meta.url), 'utf8'));
  assert.deepEqual(file, DEFAULTS_9_3);
  assert.deepEqual(validateDefaults(file), []);
});

test('a scored candidate result and later states validate', () => {
  const c = { ...clone(CANDIDATE), state: 'enriched', result: PATCH.set.result };
  assert.deepEqual(validateCandidate(c), []);
  const deferred = { ...clone(CANDIDATE), state: 'deferred', reason: 'no-language-yet', nextAt: '…' };
  assert.deepEqual(validateCandidate(deferred), []);
});

test('validators reject what is not a record', () => {
  assert.deepEqual(validateFacts(null), ['facts: expected an object, got null']);
  assert.deepEqual(validateCandidate([]), ['candidate: expected an object, got an array']);
  hasError(validateScore('score'), /^score: expected an object, got the string "score"$/);
});

test('validateCandidate names the offending field', () => {
  const c = clone(CANDIDATE);
  c.state = 'weird';
  c.stars = -1;
  c.nwo = 'no-slash';
  delete c.seenAt;
  const errs = validateCandidate(c);
  hasError(errs, /^candidate\.state: expected one of queued/);
  hasError(errs, /^candidate\.stars: expected an integer ≥ 0/);
  hasError(errs, /^candidate\.nwo: expected owner\/name/);
  hasError(errs, /^candidate\.seenAt: required$/);
  hasError(validateCandidate({ ...clone(CANDIDATE), v: 2 }), /candidate\.v: expected schema version 1/);
  hasError(validateCandidate({ ...clone(CANDIDATE), result: { S: 8 } }), /candidate\.result\.band: required/);
});

test('validateCandidate checks patches', () => {
  hasError(validateCandidate({ ...clone(PATCH), set: { state: 'nope' } }),
    /^patch\.set\.state: expected one of/);
  hasError(validateCandidate({ ...clone(PATCH), set: { id: 'R_other' } }),
    /patch\.set\.id: a patch may not set id/);
  hasError(validateCandidate({ ...clone(PATCH), day: 'yesterday' }), /patch\.day: expected a YYYY-MM-DD day/);
});

test('validateFacts keeps null and empty apart and checks nested shapes', () => {
  const nulls = clone(FACTS);
  const nullable = ['readme', 'tree', 'activity', 'starHistory', 'outsiders', 'funding', 'rollup',
    'workflows', 'manifest', 'ownerInfo'];
  for (const k of nullable) nulls[k] = null;
  assert.deepEqual(validateFacts(nulls), []);
  const empties = {
    ...clone(FACTS), topics: [], root: [], workflows: [], outsiders: [], funding: [], agentsMdBytes: 0,
  };
  assert.deepEqual(validateFacts(empties), []);

  const f = clone(FACTS);
  delete f.heavy;
  f.rollup = 'GREEN';
  f.readme.bytes = '7890';
  f.tree.entries.push(['src/lib.rs']);
  f.source = 'scraped';
  const errs = validateFacts(f);
  hasError(errs, /^facts\.heavy: required$/);
  hasError(errs, /^facts\.rollup: expected one of SUCCESS/);
  hasError(errs, /^facts\.readme\.bytes: expected a number ≥ 0/);
  hasError(errs, /^facts\.tree\.entries\[1\]: expected a \[path, type, size\] tuple/);
  hasError(errs, /^facts\.source: expected one of graphql, rest, fixture/);
  const missingKey = clone(FACTS);
  delete missingKey.starHistory;
  hasError(validateFacts(missingKey), /facts\.starHistory: required/);
  // Research-derived facts have no release dates or contribution years (§14.2).
  const research = clone(FACTS);
  research.releases.recent = [{ tag: 'v1' }];
  research.ownerInfo = { login: 'o', type: 'User', createdAt: null, publicRepos: 3 };
  research.source = 'fixture';
  assert.deepEqual(validateFacts(research), []);
});

test('validateSignal enforces status, hit, points and strength rules', () => {
  hasError(validateSignal({ ...SIGNAL, status: 'unknown' }), /signal\.hit: must be null unless status is ok/);
  assert.deepEqual(validateSignal({ ...SIGNAL, status: 'unknown', hit: null, points: 0 }), []);
  assert.deepEqual(validateSignal({ ...SIGNAL, status: 'na', hit: null, points: 0 }), []);
  hasError(validateSignal({ ...SIGNAL, points: 2 }), /signal\.points: expected 1 \(hit \? weight : 0\)/);
  hasError(validateSignal({ ...SIGNAL, hit: false }), /signal\.points: expected 0/);
  const slop = { ...SIGNAL, id: 's.webui', kind: 'slop', weight: -2, points: -2, cost: null };
  assert.deepEqual(validateSignal(slop), []);
  hasError(validateSignal({ ...SIGNAL, hit: null }), /signal\.hit: must be a boolean when status is ok/);
  hasError(validateSignal({ ...SIGNAL, strength: 0.5 }), /signal\.strength: confidence items only/);
  hasError(validateSignal({ ...CONFIDENCE_ITEM, strength: 1.5 }),
    /signal\.strength: expected a number from 0 to 1/);
  hasError(validateSignal({ ...SIGNAL, kind: 'vibe' }), /signal\.kind: expected one of/);
  const longQuote = { ...SIGNAL, evidence: [{ label: 'readme', url: 'https://x', quote: 'q'.repeat(121) }] };
  hasError(validateSignal(longQuote),
    /signal\.evidence\[0\]\.quote: expected a string of at most 120 characters/);
});

test('validateScore and validateRepoRecord check nested records', () => {
  hasError(validateScore({ ...SCORE, coverage: 1.2 }), /score\.coverage: expected a number from 0 to 1/);
  hasError(validateScore({ ...SCORE, confidence: { ...SCORE.confidence, items: [SIGNAL] } }),
    /score\.confidence\.items\[0\]: expected a confidence item/);
  hasError(validateScore({ ...SCORE, lane: 'shelf' }), /score\.lane/);
  hasError(validateScore({ ...SCORE, gates: [{ ...GATE, action: 'ban' }] }), /score\.gates\[0\]\.action/);
  const r = clone(RECORD);
  r.history = Array.from({ length: 51 }, () => clone(RECORD.history[0]));
  r.facts.stars = -3;
  const errs = validateRepoRecord(r);
  hasError(errs, /record\.history: expected at most 50 items, got 51/);
  hasError(errs, /record\.facts\.stars/);
  const bare = { ...clone(RECORD), candidate: null, score: null, firstSeen: null };
  assert.deepEqual(validateRepoRecord(bare), []);
});

test('validateVerdictOutput follows §8.4 strictly', () => {
  hasError(validateVerdictOutput({ ...VERDICT_OUTPUT, mood: 'happy' }), /output\.mood: unexpected property/);
  const craft = (/** @type {number} */ c) => ({
    ...VERDICT_OUTPUT, scores: { ...VERDICT_OUTPUT.scores, craft: c },
  });
  hasError(validateVerdictOutput(craft(5)), /output\.scores\.craft: expected a number from 1 to 4/);
  hasError(validateVerdictOutput(craft(2.5)), /output\.scores\.craft: expected an integer/);
  hasError(validateVerdictOutput({ ...VERDICT_OUTPUT, categoryConfidence: 1.5 }), /categoryConfidence/);
  hasError(validateVerdictOutput({ ...VERDICT_OUTPUT, category: 'Q' }), /output\.category/);
  hasError(validateVerdictOutput({ ...VERDICT_OUTPUT, flags: ['nice'] }), /output\.flags\[0\]/);
  const badClaim = {
    ...VERDICT_OUTPUT, claims: [{ ...VERDICT_OUTPUT.claims[0], supports: 'vibes', extra: 1 }],
  };
  const errs = validateVerdictOutput(badClaim);
  hasError(errs, /output\.claims\[0\]\.supports/);
  hasError(errs, /output\.claims\[0\]\.extra: unexpected property/);
  const missing = clone(VERDICT_OUTPUT);
  delete missing.injectionSeen;
  hasError(validateVerdictOutput(missing), /output\.injectionSeen: required/);
  const allFlags = {
    ...VERDICT_OUTPUT, category: 'X', flags: ['malware_suspect', 'do_not_promote', 're_upload'],
  };
  assert.deepEqual(validateVerdictOutput(allFlags), []);
});

test('validateFeedback ties labels, reasons and actions together (§10.4)', () => {
  assert.deepEqual(validateFeedback({ ...FEEDBACK, action: 'notgood', reason: 'clone', label: 'C' }), []);
  assert.deepEqual(validateFeedback({ ...FEEDBACK, action: 'notmine', label: null }), []);
  const blind = { ...FEEDBACK, action: 'label', label: 'S', blind: true, context: null };
  assert.deepEqual(validateFeedback(blind), []);
  assert.deepEqual(validateFeedback({ ...FEEDBACK, action: 'snooze', label: null, snoozeUntil: '…' }), []);
  const undo = { ...FEEDBACK, action: 'undo', label: null, undoes: '2026-09-11T10:00:00Z' };
  assert.deepEqual(validateFeedback(undo), []);
  hasError(validateFeedback({ ...FEEDBACK, label: 'W' }), /feedback\.label: expected G for gem/);
  hasError(validateFeedback({ ...FEEDBACK, action: 'notgood', label: 'S' }),
    /feedback\.reason: required for notgood/);
  hasError(validateFeedback({ ...FEEDBACK, action: 'notgood', reason: 'clone', label: 'S' }),
    /feedback\.label: expected C for notgood/);
  hasError(validateFeedback({ ...FEEDBACK, reason: 'spam' }), /only notgood carries a reason/);
  hasError(validateFeedback({ ...FEEDBACK, action: 'label', label: null }),
    /feedback\.label: required for label/);
  hasError(validateFeedback({ ...FEEDBACK, note: 'n'.repeat(281) }),
    /feedback\.note: expected a string of at most 280 characters/);
  assert.deepEqual(validateFeedback({ ...FEEDBACK, note: '✓'.repeat(280) }), []);
  hasError(validateFeedback({ ...FEEDBACK, action: 'snooze', label: null }),
    /snoozeUntil: required for snooze/);
  hasError(validateFeedback({ ...FEEDBACK, action: 'undo', label: null }), /undoes: required for undo/);
});

test('validateUnit checks ledger keys against their stage (§3.12)', () => {
  const scoped = 'census:2026-09-08:lang=rust:2026-09-08T13:00:00Z..2026-09-08T13:00:59Z';
  assert.deepEqual(validateUnit({ ...UNIT, key: scoped }), []);
  // GitHub language names may hold a space, and `scopeKey` keeps it.
  const spaced = 'census:2026-09-08:lang=jupyter notebook:2026-09-08T13:00:00Z..2026-09-08T13:59:59Z';
  assert.deepEqual(validateUnit({ ...UNIT, key: spaced }), []);
  const padded = 'census:2026-09-08: lang=rust:2026-09-08T13:00:00Z..2026-09-08T13:59:59Z';
  hasError(validateUnit({ ...UNIT, key: padded }), /unit\.key: expected census/);
  assert.deepEqual(validateUnit({ ...UNIT, key: 'archive:2026-09-10-3', stage: 'archive', out: null }), []);
  const failed = { ...UNIT, state: 'failed', attempts: 2, err: 'HTTP 502', nextAt: '…' };
  assert.deepEqual(validateUnit(failed), []);
  hasError(validateUnit({ ...UNIT, stage: 'archive' }), /unit\.key: must start with 'archive:'/);
  hasError(validateUnit({ ...UNIT, key: 'census:2026-09-08:all:13:00..14:00' }),
    /unit\.key: expected census:/);
  hasError(validateUnit({ ...UNIT, key: 'archive:2026-09-10-03x', stage: 'archive' }),
    /unit\.key: expected archive:/);
  hasError(validateUnit({ ...UNIT, state: 'paused' }), /unit\.state/);
});

test('v1.2 additions: a stage may say why it was skipped; llm.cliTimeoutMs is optional and positive', () => {
  const skipped = { ...RUN_SUMMARY, stages: { archive: { hours: [], skipped: 'time' } } };
  assert.deepEqual(validateRunManifest(skipped), []);
  hasError(validateRunManifest({ ...RUN_SUMMARY, stages: { archive: { skipped: 3 } } }),
    /stages\.archive\.skipped/);
  const d = clone(DEFAULTS_9_3);
  delete d.llm.cliTimeoutMs;
  assert.deepEqual(validateDefaults(d), [], 'without it claude-cli keeps its 180 s limit');
  d.llm.cliTimeoutMs = 0;
  hasError(validateDefaults(d), /llm\.cliTimeoutMs/);
});

test('validateRunManifest and validateIndex', () => {
  hasError(validateRunManifest({ ...RUN_SUMMARY, exit: { code: '0', reason: 'finished', resumeAt: null } }),
    /run\.exit\.code: expected an integer/);
  assert.deepEqual(validateRunManifest({ ...RUN_SUMMARY, endedAt: null, exit: null }), []);
  hasError(validateIndex({ ...INDEX, entries: {} }), /index\.entries: expected an array/);
  const noScore = clone(ENTRY);
  delete noScore.S;
  hasError(validateIndex({ ...INDEX, entries: [noScore] }), /index\.entries\[0\]\.S: required/);
  hasError(validateIndex({ ...INDEX, entries: [{ ...ENTRY, description: 'd'.repeat(301) }] }), /description/);
  hasError(validateIndex({ ...INDEX, entries: [{ ...ENTRY, kBand: 'huge' }] }), /kBand/);
});

test('validateWeights, validateCalibration and validateDefaults', () => {
  hasError(validateWeights({ ...WEIGHTS, bands: { gem: 5, look: 5 } }),
    /weights\.bands: gem must be greater than look/);
  hasError(validateWeights({ ...WEIGHTS, signals: { 'q.x': { points: 1, kind: 'magic' } } }),
    /weights\.signals\.q\.x\.kind/);
  hasError(validateWeights({ ...WEIGHTS, signals: { 'q.x': { points: [1], kind: 'quality' } } }),
    /weights\.signals\.q\.x\.points/);
  hasError(validateCalibration({ ...CALIBRATION, a: '-6.4' }), /calibration\.a: expected a finite number/);
  const d = clone(DEFAULTS_9_3);
  d.batch.enrich.min = 13;
  d.profiles.quick.budget = '10';
  d.server.port = 70000;
  delete d.profiles.daily;
  d.llm.backend = 'openai';
  const errs = validateDefaults(d);
  hasError(errs, /defaults\.batch\.enrich: expected min ≤ size ≤ max/);
  hasError(errs, /defaults\.profiles\.quick\.budget: expected a duration/);
  hasError(errs, /defaults\.server\.port/);
  hasError(errs, /defaults\.profiles\.daily: required/);
  hasError(errs, /defaults\.llm\.backend/);
});

test('repoPath makes each segment file-system safe (§4.1)', () => {
  assert.equal(repoPath('zaghaghi/toolog'), 'zaghaghi/toolog');
  assert.equal(repoPath('Owner/Repo.Name'), 'owner/repo.name');
  assert.equal(repoPath('owner/.github'), 'owner/%2Egithub');
  assert.equal(repoPath('a/b..'), 'a/b%2E%2E');
  assert.equal(repoPath('a/..'), 'a/%2E%2E');
  assert.equal(repoPath('x/c++ lib'), 'x/c___lib');
  assert.equal(repoPath('ünï/ß'), '_n_/_');
  assert.equal(repoPath('skulitom/london-time-map'), 'skulitom/london-time-map');
  // Windows device names, with or without an extension.
  assert.equal(repoPath('nul/con'), '%6Eul/%63on');
  assert.equal(repoPath('aux/COM1.js'), '%61ux/%63om1.js');
  assert.equal(repoPath('console/nullable'), 'console/nullable');
  for (const bad of ['noslash', 'a/b/c', '/b', 'a/', '', null, 42]) {
    assert.throws(() => repoPath(/** @type {any} */ (bad)), TypeError, String(bad));
  }
});

test('labelFromFeedback derives the quality label (§10.4)', () => {
  assert.equal(labelFromFeedback({ action: 'gem' }), 'G');
  assert.equal(labelFromFeedback({ action: 'wip' }), 'W');
  const reasons = { slop: 'S', clone: 'C', personal: 'P', spam: 'X', dump: 'D', empty: 'E' };
  for (const [reason, label] of Object.entries(reasons)) {
    assert.equal(labelFromFeedback({ action: 'notgood', reason }), label);
  }
  assert.equal(labelFromFeedback({ action: 'notgood', reason: null }), null);
  assert.equal(labelFromFeedback({ action: 'label', label: 'X' }), 'X');
  assert.equal(labelFromFeedback({ action: 'label', label: 'Z' }), null);
  for (const action of ['notmine', 'snooze', 'undo', 'publish', 'unpublish']) {
    assert.equal(labelFromFeedback({ action, label: 'G' }), null, action);
  }
  assert.equal(labelFromFeedback(null), null);
});
