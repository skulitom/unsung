// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CAPS, factsFromEnrich, factsFromRest, mergeDeep, normaliseActivity, normaliseStarHistory, normaliseTree,
  packageJsonSummary,
} from '../src/core/facts.mjs';
import { validateFacts } from '../src/core/schema.mjs';
import { listRepoFixtures, loadJsonFixture, loadRepoFixture, loadRestFixture } from './support/fixtures.mjs';

const AT = '2026-09-11T16:00:00Z';

/**
 * A minimal enrich node; fields can be overridden or removed with `undefined`.
 * @param {Record<string, unknown>} [over]
 * @returns {Record<string, any>}
 */
function node(over = {}) {
  /** @type {Record<string, any>} */
  const n = {
    id: 'R_1', nameWithOwner: 'acme/tool', description: 'A tool', homepageUrl: '',
    createdAt: '2026-01-01T00:00:00Z', pushedAt: '2026-09-01T00:00:00Z', diskUsage: 900, stargazerCount: 3,
    forkCount: 1, isFork: false, isArchived: false, isTemplate: false, isMirror: false,
    hasIssuesEnabled: true,
    hasDiscussionsEnabled: false, licenseInfo: { spdxId: 'MIT' }, primaryLanguage: { name: 'Rust' },
    languages: {
      totalSize: 60000,
      edges: [{ size: 59000, node: { name: 'Rust' } }, { size: 1000, node: { name: 'Shell' } }],
    },
    repositoryTopics: { nodes: [{ topic: { name: 'cli' } }] },
    releases: {
      totalCount: 1, nodes: [{ tagName: 'v1', publishedAt: '2026-08-01T00:00:00Z', isPrerelease: false }],
    },
    tags: { totalCount: 1 }, watchers: { totalCount: 2 },
    owner: {
      login: 'acme', __typename: 'User', createdAt: '2015-01-01T00:00:00Z', repositories: { totalCount: 12 },
    },
    defaultBranchRef: {
      name: 'main',
      target: {
        oid: 'abc', statusCheckRollup: { state: 'SUCCESS' },
        history: {
          totalCount: 2,
          nodes: [
            {
              committedDate: '2026-09-01T00:00:00Z', messageHeadline: 'Add parser',
              author: { user: { login: 'acme' } },
            },
            {
              committedDate: '2026-01-01T00:00:00Z', messageHeadline: 'Initial commit',
              author: { user: null },
            },
          ],
        },
      },
    },
    root: { entries: [{ name: 'src', type: 'tree' }, { name: 'Cargo.toml', type: 'blob' }] },
    wf: { entries: [{ name: 'ci.yml' }] },
    readme: { byteSize: 20, isTruncated: false, text: '# Tool\n```\nx\n```\n' },
    pkg: null, agents: null, claude: { byteSize: 120 },
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete n[k];
    else n[k] = v;
  }
  return n;
}

test('factsFromEnrich maps every §3.5 field and validates', () => {
  const f = factsFromEnrich(node(), { fetchedAt: AT });
  assert.deepEqual(validateFacts(f), []);
  assert.equal(f.id, 'R_1');
  assert.equal(f.nwo, 'acme/tool');
  assert.equal(f.owner, 'acme');
  assert.equal(f.name, 'tool');
  assert.equal(f.source, 'graphql');
  assert.deepEqual(f.stages, ['enrich']);
  assert.equal(f.headOid, 'abc');
  assert.equal(f.defaultBranch, 'main');
  assert.equal(f.homepageUrl, null, 'an empty homepage is no homepage');
  assert.equal(f.licence, 'MIT');
  assert.deepEqual(f.languages, [{ name: 'Rust', bytes: 59000 }, { name: 'Shell', bytes: 1000 }]);
  assert.equal(f.codeBytes, 60000);
  assert.deepEqual(f.topics, ['cli']);
  assert.deepEqual(f.releases, {
    count: 1, recent: [{ tag: 'v1', publishedAt: '2026-08-01T00:00:00Z', prerelease: false }],
  });
  assert.equal(f.tags, 1);
  assert.deepEqual(f.ownerInfo, {
    login: 'acme', type: 'User', createdAt: '2015-01-01T00:00:00Z', publicRepos: 12, contributionYears: null,
    sponsorsListing: null,
  });
  assert.deepEqual(f.commits, {
    total: 2,
    recent: [
      { at: '2026-09-01T00:00:00Z', headline: 'Add parser', authorLogin: 'acme' },
      { at: '2026-01-01T00:00:00Z', headline: 'Initial commit', authorLogin: null },
    ],
  });
  assert.equal(f.rollup, 'SUCCESS');
  assert.deepEqual(f.root, [{ name: 'src', type: 'tree' }, { name: 'Cargo.toml', type: 'blob' }]);
  assert.deepEqual(f.workflows, [{ name: 'ci.yml', text: null }]);
  assert.equal(f.readme?.name, 'README.md');
  assert.equal(f.readme?.bytes, 20);
  assert.equal(/** @type {any} */ (f.readme).fenceLines, 2);
  assert.equal(f.packageJson, null);
  assert.equal(f.agentsMdBytes, 0);
  assert.equal(f.claudeMdBytes, 120);
  for (const k of ['manifest', 'tree', 'activity', 'starHistory', 'outsiders', 'funding']) {
    assert.equal(/** @type {any} */ (f)[k], null, k);
  }
  assert.equal(f.heavy, false);
});

test('null means not fetched; null objects from GitHub mean fetched and empty (§4.1)', () => {
  const absent = factsFromEnrich(node({
    root: undefined, wf: undefined, readme: undefined, agents: undefined, languages: undefined,
    releases: undefined, defaultBranchRef: undefined, owner: undefined, licenseInfo: undefined,
  }), { fetchedAt: AT });
  assert.deepEqual(validateFacts(absent), []);
  const nulls = [
    'root', 'workflows', 'readme', 'agentsMdBytes', 'languages', 'codeBytes', 'releases', 'commits',
    'ownerInfo', 'licence', 'headOid',
  ];
  for (const k of nulls) assert.equal(/** @type {any} */ (absent)[k], null, k);
  const empty = factsFromEnrich(node({
    root: null, wf: null, readme: null, agents: null, defaultBranchRef: null, licenseInfo: null,
  }), { fetchedAt: AT });
  assert.deepEqual(empty.root, []);
  assert.deepEqual(empty.workflows, []);
  assert.equal(empty.readme, null);
  assert.equal(empty.agentsMdBytes, 0);
  assert.deepEqual(empty.commits, { total: 0, recent: [] });
  assert.equal(empty.licence, null);
  const other = factsFromEnrich(node({ licenseInfo: { spdxId: null } }), { fetchedAt: AT });
  assert.equal(other.licence, 'NOASSERTION');
  const research = factsFromEnrich(node({ releases: { totalCount: 7 } }), { fetchedAt: AT });
  assert.deepEqual(research.releases, { count: 7, recent: [] }, 'release dates absent in research snapshots');
});

test('texts are capped UTF-8-safely and the README fence count reads the full text', () => {
  const big = `${'```\ncode\n```\n'.repeat(3)}${'é'.repeat(40000)}\n${'```\n'.repeat(4)}`;
  const f = factsFromEnrich(node({
    readme: { byteSize: 90000, isTruncated: false, text: big },
    description: 'd'.repeat(3000),
    defaultBranchRef: { name: 'main', target: { oid: 'x', history: { totalCount: 1, nodes: [
      { committedDate: AT, messageHeadline: 'h'.repeat(500), author: null },
    ] } } },
  }), { fetchedAt: AT });
  assert.ok(f.readme && f.readme.truncated);
  assert.ok(new TextEncoder().encode(f.readme.text ?? '').length <= CAPS.readmeBytes);
  assert.ok(!(f.readme.text ?? '').includes('\u{FFFD}'));
  assert.equal(/** @type {any} */ (f.readme).fenceLines, 10);
  assert.equal(f.readme.bytes, 90000);
  assert.equal(f.description?.length, 1024);
  assert.equal(f.commits?.recent[0].headline?.length, 200);
});

test('README repair, fallback ids and required options', () => {
  const repaired = factsFromEnrich(node({ readme: null, id: undefined }), {
    fetchedAt: AT,
    readmeRepair: { name: 'README.rst', byteSize: 4000, isTruncated: false, text: 'Tool\n====\n' },
  });
  assert.equal(repaired.readme?.name, 'README.rst');
  assert.equal(repaired.readme?.bytes, 4000);
  assert.equal(repaired.id, 'fixture:acme/tool');
  assert.equal(factsFromEnrich(node({ id: undefined }), { fetchedAt: AT, id: 'R_x' }).id, 'R_x');
  assert.throws(() => factsFromEnrich(node(), /** @type {any} */ ({})), TypeError);
  assert.throws(() => factsFromEnrich(node({ nameWithOwner: 'bad' }), { fetchedAt: AT }), TypeError);
  assert.throws(() => factsFromEnrich(/** @type {any} */ (null), { fetchedAt: AT }), TypeError);
});

test('every repository fixture converts to valid Facts, research snapshots included', () => {
  let n = 0;
  for (const nwo of listRepoFixtures()) {
    const fx = loadRepoFixture(nwo);
    if (!fx.enrich) continue;
    const at = fx.meta?.recordedAt ?? AT;
    for (const snapshot of [fx.enrich, fx.meta?.labelledSnapshot
      ? loadJsonFixture(`repos/${fx.name}/${fx.meta.labelledSnapshot}`) : null]) {
      if (!snapshot) continue;
      const f = factsFromEnrich(snapshot, { fetchedAt: at, source: 'fixture' });
      assert.deepEqual(validateFacts(f), [], nwo);
      n++;
    }
  }
  assert.ok(n >= 170, `converted ${n} snapshots`);
});

test('a real enrich node: skulitom/london-time-map', () => {
  const fx = loadRepoFixture('skulitom/london-time-map');
  const f = factsFromEnrich(fx.enrich, { fetchedAt: fx.meta.recordedAt });
  assert.equal(f.nwo, 'skulitom/london-time-map');
  assert.equal(f.readme?.bytes, 4898);
  assert.deepEqual(f.workflows, [{ name: 'deploy.yml', text: null }]);
  assert.ok(f.root?.some((e) => e.name === 'src' && e.type === 'tree'));
  assert.deepEqual(f.packageJson, {
    name: 'london-time-map', private: true, deps: 0, devDeps: 0, peerDeps: 0, optionalDeps: 0,
    testScript: null, scripts: ['build:data', 'serve'],
  });
  assert.equal(f.commits?.total, 2);
});

test('mergeDeep folds the §3.6 responses into new Facts and leaves the input untouched', () => {
  const fx = loadRepoFixture('codefly-dev/cli');
  const base = factsFromEnrich(fx.enrich, { fetchedAt: fx.meta.recordedAt });
  const before = JSON.stringify(base);
  const f = mergeDeep(base, {
    node: fx.deep, tree: fx.tree, activity: fx.activity, starHistory: fx.stars, files: fx.files,
  }, { fetchedAt: AT });
  assert.equal(JSON.stringify(base), before);
  assert.deepEqual(validateFacts(f), []);
  assert.deepEqual(f.stages, ['enrich', 'deep']);
  assert.equal(f.fetchedAt, AT);
  assert.equal(/** @type {any} */ (f).deepHeadOid, base.headOid);
  assert.equal(f.releases?.recent.length, 10);
  assert.equal(f.ownerInfo?.sponsorsListing, false);
  assert.equal(f.ownerInfo?.contributionYears, null, 'organisations have no contribution years');
  assert.deepEqual(f.funding, []);
  assert.ok(f.outsiders && f.outsiders.length > 0);
  assert.ok(f.outsiders.every((o) => o.login.toLowerCase() !== 'codefly-dev'));
  assert.ok(f.tree && f.tree.count === fx.tree.tree.length && !f.tree.truncated);
  assert.ok(f.activity && f.activity.pushDays > 0);
  assert.equal(f.manifest?.path, 'go.mod');
  assert.ok(f.workflows?.filter((w) => w.text !== null).length === 3);
  const stars = loadRepoFixture('zaghaghi/toolog');
  const withStars = mergeDeep(factsFromEnrich(stars.enrich, { fetchedAt: AT }), { starHistory: stars.stars });
  assert.deepEqual(withStars.starHistory, {
    weeks: [{ week: '2026-09-06', gained: 5 }, { week: '2026-08-30', gained: 0 }], gain4w: 5,
  });
});

test('mergeDeep reads contribution years for users and fills missing workflow entries', () => {
  const base = factsFromEnrich(node({ wf: undefined }), { fetchedAt: AT });
  const f = mergeDeep(base, {
    node: {
      fundingLinks: [{ platform: 'GITHUB', url: 'https://github.com/sponsors/acme' }],
      owner: { hasSponsorsListing: true, contributionsCollection: { contributionYears: [2026, 2012, 2015] } },
      issues: { nodes: [
        { createdAt: AT, author: { login: 'acme', createdAt: '2015-01-01T00:00:00Z' } },
        { createdAt: AT, author: { login: 'friend', createdAt: '2019-01-01T00:00:00Z' } },
        { createdAt: AT, author: null },
      ] },
      pullRequests: { nodes: [{ createdAt: AT, author: { login: 'dependabot' } }] },
    },
    files: {
      '.github/workflows/test.yml': { byteSize: 30, text: 'jobs: {}' }, 'Cargo.toml': { text: '[package]' },
    },
  });
  assert.deepEqual(f.ownerInfo?.contributionYears, [2012, 2015, 2026]);
  assert.equal(f.ownerInfo?.sponsorsListing, true);
  assert.deepEqual(f.funding, [{ platform: 'GITHUB', url: 'https://github.com/sponsors/acme' }]);
  assert.deepEqual(f.outsiders, [
    { login: 'friend', kind: 'issue', at: AT, accountCreatedAt: '2019-01-01T00:00:00Z' },
    { login: 'dependabot', kind: 'pr', at: AT, accountCreatedAt: null },
  ]);
  assert.deepEqual(f.workflows, [{ name: 'test.yml', text: 'jobs: {}' }]);
  assert.deepEqual(f.manifest, { path: 'Cargo.toml', text: '[package]' });
  assert.deepEqual(validateFacts(f), []);
});

test('deep normalisers: trees, activity and star history', () => {
  const rest = {
    sha: 's', truncated: false,
    tree: [{ path: 'a', type: 'tree' }, { path: 'a/b.js', type: 'blob', size: 5 }],
  };
  assert.deepEqual(normaliseTree(rest),
    { truncated: false, count: 2, entries: [['a', 'tree'], ['a/b.js', 'blob', 5]] });
  const capped = normaliseTree(Array.from({ length: 7 }, (_, i) => [`f${i}`, 'blob', i]), 5);
  assert.equal(capped?.count, 7);
  assert.equal(capped?.entries.length, 5);
  assert.equal(capped?.truncated, true);
  assert.equal(normaliseTree({ sha: 's', truncated: true, tree: [] })?.truncated, true);
  assert.equal(normaliseTree('nonsense'), null);
  const act = normaliseActivity([
    { timestamp: '2026-09-01T10:00:00Z', activity_type: 'push' },
    { timestamp: '2026-09-01T12:00:00Z', activity_type: 'push' },
    { timestamp: '2026-08-01T12:00:00Z', activity_type: 'force_push' },
    { timestamp: '2026-07-01T12:00:00Z', activity_type: 'branch_deletion' },
    { timestamp: 'bad', activity_type: 'push' },
  ]);
  assert.deepEqual(act,
    { pushDays: 2, firstAt: '2026-08-01T12:00:00Z', lastAt: '2026-09-01T12:00:00Z', forcePushes: 1 });
  assert.deepEqual(normaliseActivity([]), { pushDays: 0, firstAt: null, lastAt: null, forcePushes: 0 });
  const reduced = { pushDays: 3, firstAt: null, lastAt: null, forcePushes: 0 };
  assert.deepEqual(normaliseActivity(reduced)?.pushDays, 3);
  const stars = normaliseStarHistory([{ week: '2026-08-30', total: 2 }, { week: 1788652800, total: 4 }]);
  assert.deepEqual(stars,
    { weeks: [{ week: '2026-09-06', gained: 4 }, { week: '2026-08-30', gained: 2 }], gain4w: 6 });
  assert.equal(normaliseStarHistory(null), null);
});

test('packageJsonSummary counts dependency maps and keeps script names', () => {
  const text = JSON.stringify({
    name: 'x', dependencies: { a: '1' }, devDependencies: { b: '1', c: '1' }, peerDependencies: {},
    scripts: { test: 'node --test', build: 'tsc', odd: 3 },
  });
  assert.deepEqual(packageJsonSummary(`\u{FEFF}${text}`), {
    name: 'x', private: false, deps: 1, devDeps: 2, peerDeps: 0, optionalDeps: 0, testScript: 'node --test',
    scripts: ['test', 'build'],
  });
  assert.equal(packageJsonSummary('{nope'), null);
  assert.equal(packageJsonSummary('[1]'), null);
  assert.equal(packageJsonSummary(null), null);
});

test('factsFromRest maps the §3.10 REST fallback bodies', () => {
  const body = (/** @type {string} */ name) => loadRestFixture(name).body;
  const f = factsFromRest({
    repo: body('repo'), readme: body('readme'), contents: body('contents-root'), releases: body('releases'),
    commits: body('commits'),
  }, { fetchedAt: AT });
  assert.deepEqual(validateFacts(f), []);
  assert.equal(f.nwo, 'zaghaghi/toolog');
  assert.equal(f.source, 'rest');
  assert.equal(f.heavy, true);
  assert.ok(f.readme?.text?.startsWith('# Toolog'));
  assert.ok(f.root?.some((e) => e.name === '.claude' && e.type === 'tree'));
  assert.equal(f.workflows, null, 'a .github directory whose workflows were not listed');
  assert.equal(f.releases?.recent[0].tag, 'v1.2.0');
  assert.equal(f.headOid, 'a8da25030982889eb28dc51b6673d8efdc5b0dcd');
  assert.equal(f.commits?.total, null);
  assert.equal(f.tags, null);
  assert.equal(f.codeBytes, null);
  const shaped = factsFromRest(node(), { fetchedAt: AT });
  assert.equal(shaped.source, 'rest');
  assert.equal(shaped.heavy, true);
  assert.throws(() => factsFromRest({ repo: null }, { fetchedAt: AT }), TypeError);
});
