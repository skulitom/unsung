// @ts-check
/**
 * Tests for the gallery (DESIGN §11.2, §11.3, §11.6): the export rules, the live re-check, the site
 * that is written, the removal of pages that are no longer published, the file guards, and the
 * `unsung export` and `unsung digest` commands. The store and the GitHub client are in-memory stubs
 * with the documented signatures; nothing touches the network or data/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli/args.mjs';
import { main } from '../bin/unsung.mjs';
import { command as exportCommand } from '../src/cli/export.mjs';
import { command as digestCommand } from '../src/cli/digest.mjs';
import {
  GalleryError, buildGallery, eligiblePicks, everQuarantined, foldFeedback, languageFamily,
  normaliseIssuesUrl, normaliseSiteUrl, pageDir, pageHref, pointChips, resolveBlocksExport, topReasons,
  verdictCarriesDoNotPromote,
} from '../src/publish/gallery.mjs';
import { ExportPathError, removeGenerated, resolveInside, writeFileAtomic } from '../src/publish/files.mjs';
import { RECHECK_QUERY, RecheckError, recheckRepos } from '../src/publish/recheck.mjs';

const NOW = '2026-09-11T12:00:00.000Z';
const SITE = 'https://you.github.io/picks/';
const ISSUES = 'https://github.com/you/picks/issues';
const DAY = 86_400_000;

// ---------------------------------------------------------------------------------------------
// Builders and stubs
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} id
 * @param {string} label
 * @param {string} reason
 * @param {number} points
 * @param {Record<string, any>} [over]
 * @returns {any}
 */
function sig(id, label, reason, points, over = {}) {
  const kind = id.startsWith('p.') ? 'proof' : id.startsWith('s.') ? 'slop' : 'quality';
  return {
    id, kind, status: 'ok', hit: points !== 0, value: null, weight: points || 1, points, strength: null,
    group: null, provisional: false, cost: 'cheap', label, reason, evidence: [], ...over,
  };
}

/**
 * A kept repository record, created on 1 August 2026, scored 8 points in the Promising lane.
 * @param {string} nwo
 * @param {(r: any) => void} [edit]
 * @returns {any}
 */
function record(nwo, edit) {
  const id = `R_${nwo.replace(/[^A-Za-z0-9]/g, '_')}`;
  const [owner, name] = nwo.split('/');
  const r = {
    v: 1, id, nwo,
    candidate: {
      v: 1, id, nwo, day: '2026-08-01', createdAt: '2026-08-01T00:00:00Z', state: 'enriched', lang: 'Rust',
    },
    facts: {
      v: 1, id, nwo, owner, name, createdAt: '2026-08-01T00:00:00Z',
      description: `${name} does one job well.`,
      primaryLanguage: 'Rust', stars: 1, homepageUrl: null, hasIssues: true, hasDiscussions: false,
      releases: { count: 3, recent: [] }, tags: 3, headOid: 'abc123', funding: [],
      readme: { name: 'README.md', bytes: 30, truncated: false, text: `\`cargo install ${name}\`` },
      manifest: { path: 'Cargo.toml', text: `[package]\nname = "${name}"\n` }, packageJson: null,
      ownerInfo: { login: owner, type: 'User', sponsorsListing: false },
    },
    score: {
      v: 1, id, nwo, headOid: 'abc123', scoredAt: NOW,
      model: { weights: 'w1', calibration: 'c1', rubric: null },
      signals: [
        sig('q.licence', 'Has a licence', 'MIT', 1),
        sig('q.readme', 'Substantial README', '4.9 KB', 1),
        sig('q.tests', 'Has tests', '12 test files', 1,
          { evidence: [{ label: 'tests', url: `https://github.com/${nwo}/tree/abc123/tests` }] }),
        sig('q.release', 'Ships releases', '3 releases, latest v0.3.0 on 2 Sep', 1,
          { evidence: [{ label: 'releases', url: `https://github.com/${nwo}/releases` },
            { label: 'elsewhere', url: 'https://evil.example/x' }] }),
        sig('q.examples', 'Has examples', 'no examples directory', 0, { hit: false }),
        sig('q.ci', 'Has CI', 'ci.yml', 1),
      ],
      S: 8, pointsMax: 13, coverage: 0.92, quality: 0.92, band: 'gem',
      confidence: { k: 0.3, band: 'medium', items: [] },
      attention: { stars: 1, forks: 0, watchers: 0, gain4w: null, a: 0.2 },
      gem: 8.45, lane: 'promising', gates: [], descriptors: [],
    },
    firstSeen: { at: '2026-08-02T00:00:00Z', headOid: 'abc123', S: 8, stars: 0 },
    history: [{ at: '2026-08-02T00:00:00Z', headOid: 'abc123', S: 8, quality: 0.92, k: 0.3, gem: 8.45,
      lane: 'promising', stars: 0 }],
    verdict: null, checkedAt: NOW, gone: false,
  };
  if (edit) edit(r);
  return r;
}

/**
 * A feedback event.
 * @param {any} rec
 * @param {string} action
 * @param {string} at
 * @param {Record<string, any>} [over]
 * @returns {any}
 */
function ev(rec, action, at, over = {}) {
  return {
    v: 1, at, id: rec.id, nwo: rec.nwo, action, label: action === 'gem' ? 'G' : null, reason: null, note: '',
    blind: false, undoes: null, snoozeUntil: null, context: { view: 'promising', stars: 0 }, ...over,
  };
}

/**
 * Save as a gem, then publish.
 * @param {any} rec
 * @param {string} at publish time
 * @param {string} [note]
 * @returns {any[]}
 */
function published(rec, at, note = '') {
  const gemAt = new Date(Date.parse(at) - 60_000).toISOString();
  return [ev(rec, 'gem', gemAt), ev(rec, 'publish', at, { note })];
}

/**
 * @param {{repos?: any[], feedback?: any[], optout?: any}} [opts]
 * @returns {any}
 */
function memoryStore({ repos = [], feedback = [], optout = null } = {}) {
  const byId = new Map(repos.map((r) => [r.id, r]));
  return {
    async readFeedback() {
      return feedback.slice();
    },
    async readOptOut() {
      return optout;
    },
    /** @param {string} id */
    async getRepoById(id) {
      return byId.get(id) ?? null;
    },
    /** @param {string} nwo */
    async getRepo(nwo) {
      return repos.find((r) => r.nwo.toLowerCase() === nwo.toLowerCase()) ?? null;
    },
    async* listRepos() {
      yield* repos;
    },
  };
}

/**
 * What the re-check returns for a record.
 * @param {any} rec
 * @param {Record<string, any>} [over]
 * @returns {any}
 */
function liveNode(rec, over = {}) {
  return {
    id: rec.id, nameWithOwner: rec.nwo, stargazerCount: 3, forkCount: 0, pushedAt: NOW, isArchived: false,
    isPrivate: false, owner: { login: rec.nwo.split('/')[0] }, releases: { totalCount: 3, nodes: [] },
    ...over,
  };
}

/**
 * A read-only GitHub client stub answering the re-check from `live` (id → node or null).
 * @param {Record<string, any>} live
 * @returns {{graphql: (doc: string, variables: any) => Promise<any>, calls: {doc: string, variables: any}[]}}
 */
function fakeClient(live) {
  /** @type {{doc: string, variables: any}[]} */
  const calls = [];
  return {
    calls,
    async graphql(doc, variables) {
      calls.push({ doc, variables });
      assert.match(doc.trimStart(), /^query\b/, 'the re-check is a query');
      const nodes = variables.ids.map((/** @type {string} */ id) => live[id] ?? null);
      return { data: { rateLimit: { cost: 1, remaining: 4999, resetAt: NOW }, nodes }, errors: [], ms: 5 };
    },
  };
}

/**
 * A fresh temporary directory, removed when the test ends.
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'unsung-wp7-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * @param {string} root
 * @returns {string[]} every file under root, relative, with forward slashes
 */
function listFiles(root) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/**
 * A command context stub with the documented Ctx surface the two commands use.
 * @param {{store: any, client?: any, flags?: Record<string, any>, now?: string}} opts
 * @returns {{ctx: any, out: string[], warnings: string[]}}
 */
function stubCtx({ store, client = null, flags = {}, now = NOW }) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const warnings = [];
  const noop = () => {};
  const ctx = {
    flags,
    config: { defaults: { maxStars: 25 } },
    log: {
      debug: noop, info: noop, error: noop, stage: noop, warn: (/** @type {string} */ m) => warnings.push(m),
    },
    now: () => now,
    signal: new AbortController().signal,
    print: (/** @type {string} */ line) => out.push(line),
    printJson: (/** @type {unknown} */ v) => out.push(JSON.stringify(v)),
    store: async () => store,
    client: async () => {
      if (!client) throw new Error('no client in this test');
      return client;
    },
  };
  return { ctx, out, warnings };
}

// ---------------------------------------------------------------------------------------------
// Feedback and eligibility (§11.2)
// ---------------------------------------------------------------------------------------------

test('foldFeedback keeps the latest triage and publishing decisions and honours undo', () => {
  const r = record('octo/tool');
  const events = [
    ev(r, 'gem', '2026-09-01T00:00:00Z'), ev(r, 'publish', '2026-09-01T00:01:00Z'),
    ev(r, 'unpublish', '2026-09-02T00:00:00Z'), ev(r, 'publish', '2026-09-03T00:00:00Z'),
    ev(r, 'snooze', '2026-09-03T00:01:00Z'),
    ev(r, 'label', '2026-09-03T00:02:00Z', { label: 'W', blind: true }),
  ];
  let st = foldFeedback(events).get(r.id);
  assert.equal(st?.triage?.action, 'gem');
  assert.equal(st?.publishing?.action, 'publish');
  assert.equal(st?.publishing?.at, '2026-09-03T00:00:00Z');

  const undoByTime = ev(r, 'undo', '2026-09-04T00:00:00Z', { undoes: '2026-09-03T00:00:00Z' });
  st = foldFeedback([...events, undoByTime]).get(r.id);
  assert.equal(st?.publishing?.action, 'unpublish', 'undo by the undone event\'s time');
  st = foldFeedback([...events, ev(r, 'undo', '2026-09-04T00:00:00Z', { undoes: 3 })]).get(r.id);
  assert.equal(st?.publishing?.action, 'unpublish', 'undo by position in the log');
  st = foldFeedback([...events.slice(0, 2), ev(r, 'undo', '2026-09-04T00:00:00Z')]).get(r.id);
  assert.equal(st?.publishing, null, 'an undo without a target reverts the latest event');
  const notgood = ev(r, 'notgood', '2026-09-05T00:00:00Z', { reason: 'clone', label: 'C' });
  st = foldFeedback([...events, notgood]).get(r.id);
  assert.equal(st?.triage?.action, 'notgood');
});

test('eligiblePicks applies every export rule of §11.2 and says why a pick was left out', async () => {
  const good = record('octo/good');
  const young = record('octo/young', (r) => {
    r.facts.createdAt = '2026-09-08T00:00:00Z';
  });
  const unpublished = record('octo/unpublished');
  const demoted = record('octo/demoted');
  const history = record('octo/history', (r) => {
    r.history.push({ ...r.history[0], at: '2026-08-03T00:00:00Z', lane: 'quarantine' });
  });
  const gated = record('octo/gated', (r) => {
    r.score.gates = [{ id: 'g.lure.link', action: 'quarantine', reason: 'x', evidence: [] }];
  });
  const lure = record('octo/lure', (r) => {
    r.candidate.state = 'quarantined';
  });
  const flagged = record('octo/flagged', (r) => {
    r.verdict = { status: 'ok', output: { flags: ['do_not_promote'], pitch: 'x' } };
  });
  const optRepo = record('octo/optrepo');
  const optOwner = record('shy/tool');
  const saved = record('octo/saved');
  const feedback = [
    ...published(good, '2026-09-05T10:00:00Z', 'I use it daily.'),
    ...published(young, '2026-09-09T10:00:00Z'),
    ...published(unpublished, '2026-09-05T10:00:00Z'), ev(unpublished, 'unpublish', '2026-09-06T00:00:00Z'),
    ...published(demoted, '2026-09-05T10:00:00Z'),
    ev(demoted, 'notgood', '2026-09-06T00:00:00Z', { reason: 'slop' }),
    ...published(history, '2026-09-05T10:00:00Z'),
    ...published(gated, '2026-09-05T10:00:00Z'),
    ...published(lure, '2026-09-05T10:00:00Z'),
    ...published(flagged, '2026-09-05T10:00:00Z'),
    ...published(optRepo, '2026-09-05T10:00:00Z'),
    ...published(optOwner, '2026-09-05T10:00:00Z'),
    ev(saved, 'gem', '2026-09-05T10:00:00Z'),
    { ...ev(good, 'gem', '2026-09-05T10:59:00Z'), id: 'R_unknown', nwo: 'octo/unknown' },
    { ...ev(good, 'publish', '2026-09-05T11:00:00Z'), id: 'R_unknown', nwo: 'octo/unknown' },
  ];
  const store = memoryStore({
    repos: [good, young, unpublished, demoted, history, gated, lure, flagged, optRepo, optOwner, saved],
    feedback,
    optout: { v: 1, repos: ['OCTO/OptRepo'], owners: ['Shy'] },
  });
  /** @type {{nwo: string, reason: string}[]} */
  const skipped = [];
  const picks = await eligiblePicks({ store, now: NOW, skipped });
  assert.deepEqual(picks.map((p) => p.nwo), ['octo/good']);
  const reasons = Object.fromEntries(skipped.map((s) => [s.nwo, s.reason]));
  assert.deepEqual(reasons, {
    'octo/young': 'younger than 7 days',
    'octo/demoted': 'no longer saved as a gem',
    'octo/history': 'was quarantined',
    'octo/gated': 'was quarantined',
    'octo/lure': 'was quarantined',
    'octo/flagged': 'its review asked not to promote it',
    'octo/optrepo': 'opted out',
    'shy/tool': 'opted out',
    'octo/unknown': 'no stored record',
  });
  assert.equal(picks[0].publishedAt, '2026-09-05T10:00:00.000Z');
  assert.equal(picks[0].note, 'I use it daily.');
  assert.equal(picks[0].starsAtPublish, 0);
});

test('eligiblePicks: seven days old is old enough, and the newest publish comes first', async () => {
  const exactly = record('octo/seven', (r) => {
    r.facts.createdAt = new Date(Date.parse(NOW) - 7 * DAY).toISOString();
  });
  const almost = record('octo/almost', (r) => {
    r.facts.createdAt = new Date(Date.parse(NOW) - 7 * DAY + 3_600_000).toISOString();
  });
  const later = record('octo/later');
  const store = memoryStore({
    repos: [exactly, almost, later],
    feedback: [...published(exactly, '2026-09-10T09:00:00Z'), ...published(almost, '2026-09-10T09:00:00Z'),
      ...published(later, '2026-09-11T09:00:00Z')],
  });
  const picks = await eligiblePicks({ store, now: NOW });
  assert.deepEqual(picks.map((p) => p.nwo), ['octo/later', 'octo/seven']);
});

test('starsAtPublish comes from the publish event, else the history, else the stored facts', async () => {
  const a = record('octo/a');
  const b = record('octo/b', (r) => {
    r.history.push({ ...r.history[0], at: '2026-09-01T00:00:00Z', stars: 4 });
  });
  const c = record('octo/c', (r) => {
    r.history = [];
    r.facts.stars = 7;
  });
  const noCtx = (/** @type {any} */ e) => ({ ...e, context: null });
  const store = memoryStore({
    repos: [a, b, c],
    feedback: [
      ev(a, 'gem', '2026-09-05T00:00:00Z'),
      ev(a, 'publish', '2026-09-05T01:00:00Z', { context: { stars: 2 } }),
      ev(b, 'gem', '2026-09-05T00:00:00Z'), noCtx(ev(b, 'publish', '2026-09-05T01:00:00Z')),
      ev(c, 'gem', '2026-09-05T00:00:00Z'), noCtx(ev(c, 'publish', '2026-09-05T01:00:00Z')),
    ],
  });
  const picks = await eligiblePicks({ store, now: NOW });
  const stars = Object.fromEntries(picks.map((p) => [p.nwo, p.starsAtPublish]));
  assert.deepEqual(stars, { 'octo/a': 2, 'octo/b': 4, 'octo/c': 7 });
});

test('everQuarantined and the do_not_promote rule', () => {
  assert.equal(everQuarantined(record('octo/x')), false);
  assert.equal(everQuarantined(record('octo/x', (r) => {
    r.score.lane = 'quarantine';
  })), true);
  assert.equal(everQuarantined(record('octo/x', (r) => {
    r.candidate.result = { lane: 'quarantine' };
  })), true);
  assert.equal(verdictCarriesDoNotPromote(null), false);
  const flagged = (/** @type {string[]} */ f) => /** @type {any} */ ({ output: { flags: f } });
  assert.equal(verdictCarriesDoNotPromote(flagged(['tutorial_clone'])), false);
  assert.equal(verdictCarriesDoNotPromote(flagged(['do_not_promote'])), true);
});

test('resolveBlocksExport uses the WP5 rule when it exists and the §8.5 rule otherwise', async () => {
  const missing = Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' });
  assert.equal(await resolveBlocksExport(async () => {
    throw missing;
  }), verdictCarriesDoNotPromote);
  const wp5 = { verdictBlocksExport: (/** @type {any} */ v) => v.status === 'x' };
  const rule = await resolveBlocksExport(async () => wp5);
  assert.equal(rule(/** @type {any} */ ({ status: 'x', output: { flags: [] } })), true);
  assert.equal(rule(/** @type {any} */ ({ status: 'ok', output: { flags: ['do_not_promote'] } })), true);
  assert.equal(rule(/** @type {any} */ ({ status: 'ok', output: { flags: [] } })), false);
  assert.equal(rule(null), false);
  await assert.rejects(resolveBlocksExport(async () => {
    throw new SyntaxError('broken module');
  }), SyntaxError);
});

// ---------------------------------------------------------------------------------------------
// Reasons, chips, families and paths
// ---------------------------------------------------------------------------------------------

test('reasons follow §6.8 order with GitHub evidence only; chips keep the worst of a group', () => {
  const r = record('octo/tool', (rec) => {
    rec.score.signals.push(sig('p.testsRun', 'CI runs the tests', 'go test in ci.yml, green', 1));
    rec.score.signals.push(sig('s.prose', 'Mostly prose', 'README 5x code', -2, { group: 'prose' }));
    rec.score.signals.push(sig('s.mdheavy', 'Markdown-heavy', '4 root .md files', -1, { group: 'prose' }));
  });
  const reasons = topReasons(r.score);
  assert.deepEqual(reasons.map((x) => x.text), [
    'Ships releases: 3 releases, latest v0.3.0 on 2 Sep', 'CI runs the tests: go test in ci.yml, green',
    'Has tests: 12 test files',
  ]);
  assert.deepEqual(reasons[0].evidence,
    [{ label: 'releases', url: 'https://github.com/octo/tool/releases' }]);
  const chips = pointChips(r.score);
  assert.ok(chips.some((c) => c.label === 'Mostly prose' && c.points === -2));
  assert.ok(!chips.some((c) => c.label === 'Markdown-heavy'), 'only the larger penalty of a group counts');
  assert.ok(!chips.some((c) => c.label === 'Has examples'), 'misses are not chips');
  assert.deepEqual(topReasons(null), []);
});

test('language families and gem page paths', () => {
  assert.deepEqual(languageFamily('TypeScript'), { slug: 'javascript', label: 'JavaScript and TypeScript' });
  assert.equal(languageFamily('C++').slug, 'c-cpp');
  assert.equal(languageFamily('Visual Basic .NET').slug, 'dotnet');
  assert.equal(languageFamily('Jupyter Notebook').slug, 'python');
  assert.deepEqual(languageFamily('Zig'), { slug: 'zig', label: 'Zig' });
  assert.deepEqual(languageFamily(null), { slug: 'other', label: 'Other' });
  assert.equal(languageFamily('<b>Weird</b>!').slug, 'b-weird-b');
  assert.equal(pageDir('Octo/Tool'), 'r/octo/tool');
  assert.equal(pageHref('Octo/Tool'), 'r/octo/tool/');
  assert.equal(pageDir('octo/.github'), 'r/octo/%2Egithub');
  assert.equal(pageHref('octo/.github'), 'r/octo/%252Egithub/',
    'the % of the file name is itself encoded in the URL');
});

test('site and issues addresses are validated', () => {
  assert.equal(normaliseSiteUrl('https://you.github.io/picks'), SITE);
  assert.equal(normaliseSiteUrl('http://localhost:8080/?x=1#y'), 'http://localhost:8080/');
  assert.equal(normaliseSiteUrl(''), null);
  assert.throws(() => normaliseSiteUrl('you.github.io'), GalleryError);
  assert.throws(() => normaliseSiteUrl('javascript:alert(1)'), GalleryError);
  assert.equal(normaliseIssuesUrl(ISSUES), ISSUES);
  assert.throws(() => normaliseIssuesUrl('http://example.com/issues'), GalleryError);
  assert.equal(new GalleryError('x').exitCode, 2);
});

// ---------------------------------------------------------------------------------------------
// Building the site
// ---------------------------------------------------------------------------------------------

/** Two good picks, one gone, one private and one renamed into an opted-out account. */
function scenario() {
  const rust = record('octo/rusty');
  const ts = record('octo/typed', (r) => {
    r.facts.primaryLanguage = 'TypeScript';
    r.facts.hasDiscussions = true;
    r.verdict = { status: 'ok', output: { flags: [], pitch: 'Types for your config files' } };
  });
  const gone = record('octo/gone');
  const hidden = record('octo/hidden');
  const moved = record('octo/moved');
  const store = memoryStore({
    repos: [rust, ts, gone, hidden, moved],
    feedback: [
      ...published(rust, '2026-09-04T10:00:00Z', 'Tiny, fast and well tested.'),
      ...published(ts, '2026-09-06T10:00:00Z'),
      ...published(gone, '2026-09-05T10:00:00Z'),
      ...published(hidden, '2026-09-05T10:00:00Z'),
      ...published(moved, '2026-09-05T10:00:00Z'),
    ],
    optout: { v: 1, repos: [], owners: ['elsewhere'] },
  });
  const client = fakeClient({
    [rust.id]: liveNode(rust, { stargazerCount: 3 }),
    [ts.id]: liveNode(ts, { stargazerCount: 30 }),
    [gone.id]: null,
    [hidden.id]: liveNode(hidden, { isPrivate: true }),
    [moved.id]: liveNode(moved, { nameWithOwner: 'elsewhere/moved', owner: { login: 'elsewhere' } }),
  });
  return { store, client, rust, ts, gone, hidden, moved };
}

test('buildGallery exports only what the live re-check finds public, and writes the site', async (t) => {
  const out = path.join(tempDir(t), 'site');
  const { store, client, rust, ts, gone, hidden, moved } = scenario();
  const result = await buildGallery({
    store, client, config: { defaults: { maxStars: 25 } }, outDir: out, siteUrl: SITE, issuesUrl: ISSUES,
    now: NOW,
  });

  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].doc, RECHECK_QUERY);
  const asked = [...client.calls[0].variables.ids].sort();
  assert.deepEqual(asked, [rust.id, ts.id, gone.id, hidden.id, moved.id].sort());
  assert.deepEqual(result.entries.map((e) => e.nwo), ['octo/typed', 'octo/rusty']);
  assert.deepEqual(Object.fromEntries(result.skipped.map((s) => [s.nwo, s.reason])), {
    'octo/gone': 'gone from GitHub or no longer public',
    'octo/hidden': 'gone from GitHub or no longer public',
    'elsewhere/moved': 'opted out',
  });
  assert.deepEqual(listFiles(out), [
    'assets/gallery.mjs', 'assets/style.css', 'data/gallery.json', 'feed.xml', 'feeds/javascript.xml',
    'feeds/rust.xml', 'index.html', 'r/octo/rusty/index.html', 'r/octo/typed/index.html',
  ]);
  assert.deepEqual(result.feeds, ['feed.xml', 'feeds/javascript.xml', 'feeds/rust.xml']);

  const gallery = JSON.parse(readFileSync(path.join(out, 'data/gallery.json'), 'utf8'));
  assert.equal(gallery.v, 1);
  assert.equal(gallery.siteUrl, SITE);
  const typed = gallery.entries[0];
  for (const key of ['nwo', 'url', 'description', 'lang', 'pitch', 'note', 'publishedAt', 'starsAtPublish',
    'starsNow', 'reasons', 'signals', 'quality', 'confidence', 'id', 'page']) {
    assert.ok(key in typed, `GalleryEntry has ${key}`);
  }
  assert.equal(typed.url, 'https://github.com/octo/typed');
  assert.equal(typed.pitch, 'Types for your config files');
  assert.equal(typed.starsNow, 30);
  assert.equal(typed.page, 'r/octo/typed/');
  assert.ok(typed.reasons.length <= 3);
  assert.deepEqual(gallery.generated, ['r/octo/typed/index.html', 'r/octo/rusty/index.html',
    'feeds/javascript.xml', 'feeds/rust.xml']);

  const index = readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(index.indexOf('octo/typed') < index.indexOf('octo/rusty'), 'newest first');
  assert.ok(index.includes('<li class="card" data-family="rust" data-family-label="Rust">'));
  assert.ok(index.includes('<a href="r/octo/rusty/">octo/rusty</a>'));
  assert.ok(index.includes('<a href="feeds/rust.xml">Rust</a>'));
  assert.ok(index.includes('<script type="module" src="assets/gallery.mjs"></script>'));
  assert.ok(index.includes('<nav class="filters" aria-label="Filter by language" hidden></nav>'));
  assert.ok(index.includes(`Maintainer? Open an issue at <a href="${ISSUES}" rel="noopener">${ISSUES}</a>`));
  for (const left of ['octo/gone', 'octo/hidden', 'octo/moved', 'elsewhere/moved']) {
    assert.ok(!index.includes(left), left);
  }
});

test('a gem page has the note, reasons with evidence, stars then and now, the ladder and the opt-out line',
  async (t) => {
    const out = path.join(tempDir(t), 'site');
    const { store, client } = scenario();
    await buildGallery({
      store, client, config: null, outDir: out, siteUrl: SITE, issuesUrl: ISSUES, now: NOW,
    });
    const html = readFileSync(path.join(out, 'r/octo/rusty/index.html'), 'utf8');
    assert.ok(html.includes('<title>octo/rusty · Unsung picks</title>'));
    assert.ok(html.includes('<link rel="canonical" href="https://you.github.io/picks/r/octo/rusty/">'));
    assert.ok(html.includes('<meta property="og:description" content="rusty does one job well.">'));
    assert.doesNotMatch(html, /og:image|og:url/);
    assert.ok(html.includes('<link rel="stylesheet" href="../../../assets/style.css">'));
    assert.ok(html.includes('<blockquote dir="auto"><p>Tiny, fast and well tested.</p></blockquote>'));
    assert.ok(html.includes('<li>Ships releases: 3 releases, latest v0.3.0 on 2 Sep <span class="evidence">'
      + '(<a href="https://github.com/octo/rusty/releases" rel="noopener">releases</a>)</span></li>'));
    assert.ok(!html.includes('evil.example'), 'evidence outside github.com is dropped');
    assert.ok(html.includes('0 stars then, 3 now'));
    assert.ok(html.includes('8 of 13 points · Quality 92'));
    assert.ok(html.includes('<strong>Try it:</strong> <code>cargo install rusty</code>'));
    assert.ok(html.includes('<a href="https://github.com/octo/rusty" rel="noopener">Star it yourself</a>'));
    assert.ok(html.includes('https://github.com/octo/rusty/releases.atom'));
    assert.ok(html.includes('https://github.com/octo/rusty/issues'));
    assert.ok(html.includes('<strong>Share:</strong> <a href="https://you.github.io/picks/r/octo/rusty/"'));
    assert.ok(html.includes('<p class="optout">Maintainer? Open an issue at '
      + `<a href="${ISSUES}" rel="noopener">`
      + `${ISSUES}</a> and it will be removed.</p>`));
    const typed = readFileSync(path.join(out, 'r/octo/typed/index.html'), 'utf8');
    assert.ok(typed.includes('graduated: past 25 stars'));
    assert.ok(typed.includes('written by an AI review'));
    assert.ok(typed.includes('https://github.com/octo/typed/discussions'));
  });

test('the next export removes pages that are no longer published, and nothing else', async (t) => {
  const out = path.join(tempDir(t), 'site');
  const { store, client, ts } = scenario();
  await buildGallery({ store, client, outDir: out, siteUrl: SITE, issuesUrl: ISSUES, now: NOW });
  writeFileSync(path.join(out, 'CNAME'), 'picks.example\n');
  mkdirSync(path.join(out, 'r', 'notes'), { recursive: true });
  writeFileSync(path.join(out, 'r', 'notes', 'mine.txt'), 'kept');
  const optout = { v: 1, repos: ['octo/typed'], owners: ['elsewhere'] };
  const optedOut = { ...store, readOptOut: async () => optout };
  const second = await buildGallery({ store: optedOut, client, outDir: out, siteUrl: SITE, issuesUrl: ISSUES,
    now: NOW });
  assert.deepEqual(second.entries.map((e) => e.nwo), ['octo/rusty']);
  assert.deepEqual(second.removed.sort(), ['feeds/javascript.xml', 'r/octo/typed/index.html']);
  assert.ok(!existsSync(path.join(out, 'r', 'octo', 'typed')), 'the empty directory went with the page');
  assert.ok(existsSync(path.join(out, 'r', 'octo', 'rusty', 'index.html')));
  assert.ok(existsSync(path.join(out, 'CNAME')) && existsSync(path.join(out, 'r', 'notes', 'mine.txt')));
  assert.ok(!readFileSync(path.join(out, 'feed.xml'), 'utf8').includes('octo/typed'));
  assert.equal(ts.nwo, 'octo/typed');
});

test('an export with picks needs --issues-url; with none it builds an empty gallery offline', async (t) => {
  const { store, client } = scenario();
  await assert.rejects(buildGallery({ store, client, outDir: path.join(tempDir(t), 's'), now: NOW }),
    (/** @type {any} */ err) => err instanceof GalleryError && /--issues-url/.test(err.message)
      && err.exitCode === 2);

  const out = path.join(tempDir(t), 'empty');
  const noClient = () => {
    throw new Error('the client must not be needed');
  };
  const result = await buildGallery({ store: memoryStore(), client: noClient, outDir: out, now: NOW });
  assert.equal(result.entries.length, 0);
  const index = readFileSync(path.join(out, 'index.html'), 'utf8');
  assert.ok(index.includes('No picks are published yet.'));
  assert.ok(!index.includes('Maintainer?'));
  const feed = readFileSync(path.join(out, 'feed.xml'), 'utf8');
  assert.ok(feed.includes('<id>tag:unsung.local,2026:local/</id>'));
});

test('a failed re-check aborts the export instead of dropping every pick', async (t) => {
  const out = path.join(tempDir(t), 'site');
  const { store } = scenario();
  const broken = { graphql: async () => ({ data: null, errors: [{ type: 'RATE_LIMITED' }] }) };
  await assert.rejects(buildGallery({ store, client: broken, outDir: out, issuesUrl: ISSUES, now: NOW }),
    (/** @type {any} */ err) => err instanceof RecheckError && /RATE_LIMITED/.test(err.message));
  assert.ok(!existsSync(path.join(out, 'index.html')), 'nothing was written');
});

test('recheckRepos batches by 100, maps missing, private and non-repository nodes to null', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `R_${i}`);
  /** @type {Record<string, any>} */
  const live = {};
  for (const id of ids) live[id] = { id, nameWithOwner: `o/${id}`, stargazerCount: 1, owner: { login: 'o' } };
  live.R_1 = null;
  live.R_2 = { ...live.R_2, isPrivate: true };
  live.R_3 = {};
  const client = fakeClient(live);
  const map = await recheckRepos(/** @type {any} */ (client), [...ids, 'R_0']);
  assert.equal(client.calls.length, 3);
  assert.deepEqual(client.calls.map((c) => c.variables.ids.length), [100, 100, 50]);
  assert.equal(map.size, 250);
  assert.equal(map.get('R_1'), null);
  assert.equal(map.get('R_2'), null);
  assert.equal(map.get('R_3'), null);
  assert.equal(map.get('R_4')?.nwo, 'o/R_4');
  assert.equal(map.get('R_4')?.stars, 1);
  assert.equal((await recheckRepos(/** @type {any} */ (null), [])).size, 0);
  await assert.rejects(recheckRepos(/** @type {any} */ (null), ['R_1']), RecheckError);
});

// ---------------------------------------------------------------------------------------------
// File guards
// ---------------------------------------------------------------------------------------------

test('writes stay inside the export directory', (t) => {
  const root = tempDir(t);
  for (const bad of ['../x', '/abs/x', 'C:/x', 'a/../../x', '', 'a/\0b']) {
    assert.throws(() => resolveInside(root, bad), ExportPathError, JSON.stringify(bad));
  }
  assert.equal(resolveInside(root, 'a/b.html'), path.join(root, 'a', 'b.html'));
  writeFileAtomic(root, 'deep/dir/file.txt', 'hello\n');
  assert.equal(readFileSync(path.join(root, 'deep/dir/file.txt'), 'utf8'), 'hello\n');
  assert.deepEqual(listFiles(root), ['deep/dir/file.txt'], 'no temporary files are left behind');
  assert.equal(removeGenerated(root, 'deep/dir/file.txt', 'deep'), true);
  assert.ok(!existsSync(path.join(root, 'deep', 'dir')) && existsSync(path.join(root, 'deep')));
  assert.equal(removeGenerated(root, 'deep/dir/file.txt', 'deep'), false);
});

test('writes refuse to pass through a symbolic link', (t) => {
  const root = tempDir(t);
  const outside = tempDir(t);
  try {
    symlinkSync(outside, path.join(root, 'link'), 'junction');
  } catch {
    t.skip('this system does not allow creating links here');
    return;
  }
  assert.throws(() => writeFileAtomic(root, 'link/escape.txt', 'x'), ExportPathError);
  assert.deepEqual(listFiles(outside), []);
});

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

test('unsung export writes the site and prints what it did', async (t) => {
  const dir = tempDir(t);
  const out = path.join(dir, 'site');
  const { store, client } = scenario();
  const argv = ['export', '--out', out, '--site-url', SITE, '--issues-url', ISSUES];
  const args = parseArgs(argv, exportCommand.flags);
  const { ctx, out: printed, warnings } = stubCtx({ store, client, flags: args.flags });
  assert.equal(await exportCommand.run(args, ctx), 0);
  assert.match(printed[0], /^export {5}2 picks · 2 gem pages · 3 feeds → /);
  assert.ok(printed.includes('skipped    octo/gone: gone from GitHub or no longer public'));
  assert.deepEqual(warnings, []);
  assert.ok(existsSync(path.join(out, 'index.html')));

  const json = parseArgs(['export', '--out', out, '--issues-url', ISSUES, '--json'], exportCommand.flags);
  const second = stubCtx({ store, client, flags: json.flags });
  assert.equal(await exportCommand.run(json, second.ctx), 0);
  const report = JSON.parse(second.out[0]);
  assert.deepEqual(report.picks, ['octo/typed', 'octo/rusty']);
  assert.equal(second.warnings.length, 1, 'no --site-url: a warning about relative feed links');
  const extra = parseArgs(['export', 'extra'], exportCommand.flags);
  await assert.rejects(exportCommand.run(extra, ctx), /no arguments/);
});

test('unsung export through the CLI: help, and exit 2 without --issues-url', async (t) => {
  /** @type {string[]} */
  const stdout = [];
  /** @type {string[]} */
  const stderr = [];
  const io = {
    stdout: { write: (/** @type {string} */ s) => stdout.push(s) },
    stderr: { write: (/** @type {string} */ s) => stderr.push(s) },
    installSignals: false,
  };
  assert.equal(await main(['export', '--help'], io), 0);
  const help = stdout.join('');
  for (const flag of ['--out', '--site-url', '--issues-url', '--title']) assert.ok(help.includes(flag), flag);

  const out = path.join(tempDir(t), 'site');
  const { store, client } = scenario();
  const createContext = async (/** @type {any} */ o) => stubCtx({ store, client, flags: o.flags }).ctx;
  const withCtx = { ...io, createContext: /** @type {any} */ (createContext) };
  assert.equal(await main(['export', '--out', out], withCtx), 2);
  assert.match(stderr.join(''), /--issues-url/);
});

test('unsung digest writes the week\'s Markdown and HTML after a live re-check', async (t) => {
  const dir = tempDir(t);
  const now = '2026-09-15T12:00:00.000Z';
  const fresh = record('octo/fresh');
  const old = record('octo/old');
  const store = memoryStore({
    repos: [fresh, old],
    feedback: [...published(fresh, '2026-09-09T10:00:00Z', 'Worth a look.'),
      ...published(old, '2026-08-12T10:00:00Z')],
  });
  const client = fakeClient({
    [fresh.id]: liveNode(fresh, { stargazerCount: 2 }),
    [old.id]: liveNode(old, {
      stargazerCount: 9,
      releases: {
        totalCount: 4,
        nodes: [{ tagName: 'v0.4.0', publishedAt: '2026-08-20T00:00:00Z', isPrerelease: false },
          { tagName: 'v0.3.0', publishedAt: '2026-08-01T00:00:00Z', isPrerelease: false }],
      },
    }),
  });
  mkdirSync(path.join(dir, 'site', 'data'), { recursive: true });
  const saved = JSON.stringify({ v: 1, siteUrl: SITE, title: 'My picks' });
  writeFileSync(path.join(dir, 'site', 'data', 'gallery.json'), saved);
  const outDir = path.join(dir, 'site', 'digest');
  const args = parseArgs(['digest', '--out', outDir], digestCommand.flags);
  const { ctx, out } = stubCtx({ store, client, flags: args.flags, now });
  assert.equal(await digestCommand.run(args, ctx), 0);
  assert.equal(client.calls.length, 1);
  assert.deepEqual(listFiles(outDir), ['2026-W37.html', '2026-W37.md']);
  const md = readFileSync(path.join(outDir, '2026-W37.md'), 'utf8');
  assert.ok(md.startsWith('# My picks: week 37, 2026'));
  assert.ok(md.includes('## [octo/fresh](https://you.github.io/picks/r/octo/fresh/)'));
  assert.ok(md.includes('> Worth a look.'));
  assert.ok(md.includes('| [octo/old](https://you.github.io/picks/r/octo/old/) | 0 | 9 | 1 (latest v0.4.0) '
    + '| Still unsung |'));
  assert.match(out[0], /^digest {5}2026-W37 · 1 pick · four weeks on: 1 from 2026-W33$/);

  const bad = parseArgs(['digest', '--week', '2026-37', '--out', outDir], digestCommand.flags);
  await assert.rejects(digestCommand.run(bad, stubCtx({ store, flags: bad.flags, now }).ctx), /ISO week/);
  const loose = parseArgs(['digest', '--week', '2026w37', '--out', outDir, '--json'], digestCommand.flags);
  const second = stubCtx({ store, client, flags: loose.flags, now });
  assert.equal(await digestCommand.run(loose, second.ctx), 0);
  assert.equal(JSON.parse(second.out[0]).week, '2026-W37');
});

test('pages.yml deploys docs/ and the committed site/ (as /picks/) on pushes to main, and runs no Unsung command', () => {
  const file = fileURLToPath(new URL('../.github/workflows/pages.yml', import.meta.url));
  const yml = readFileSync(file, 'utf8');
  assert.match(yml, /push:\n\s+branches: \[main\]\n\s+paths:\n/);
  for (const path of ['docs/**', 'site/**']) assert.ok(yml.includes(`- '${path}'`), `triggers on ${path}`);
  assert.match(yml, /cp -R docs\/\. _site\//, 'the project page is the root of the site');
  assert.match(yml, /cp -R site\/\. _site\/picks\//, 'the gallery lives under /picks/');
  assert.match(yml, /uses: actions\/upload-pages-artifact@v\d+\n\s+with:\n\s+path: _site\n/);
  assert.match(yml, /uses: actions\/deploy-pages@v\d+/);
  assert.match(yml, /pages: write/);
  assert.match(yml, /id-token: write/);
  const code = yml.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(code, /npm|node |unsung|GITHUB_TOKEN|secrets\./,
    'comments aside, nothing is built from data and the census never runs in CI');
});
