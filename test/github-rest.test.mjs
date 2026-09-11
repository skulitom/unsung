// @ts-check
/**
 * REST helpers (DESIGN §3.6, §3.10) on the recorded REST samples: the tree, activity (with a 304 from
 * the HTTP cache), star history, the ID-walk listing, and the REST fallback, whose node agrees with
 * the recorded GraphQL node wherever REST can know the answer.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeFetch, fixtureRoute } from './support/fake-fetch.mjs';
import { fakeClock } from './support/clock.mjs';
import { loadRepoFixture, loadRestFixture } from './support/fixtures.mjs';
import { createGovernor } from '../src/github/governor.mjs';
import { createClient } from '../src/github/client.mjs';
import {
  activity, nodeFromRest, recursiveTree, repoApiPath, repositoriesSince, restFallback, starHistory,
} from '../src/github/rest.mjs';
import { clearSecrets } from '../src/secrets.mjs';

/**
 * @param {import('./support/fake-fetch.mjs').Route[]} routes
 * @param {any} [cache]
 */
function setup(routes, cache = null) {
  const clock = fakeClock('2026-09-11T12:00:00Z', { auto: true });
  const fetch = createFakeFetch(routes, { clock });
  const governor = createGovernor({}, { clock });
  const client = createClient({ token: 'rest-test-token-5555', governor, fetch, cache });
  return { fetch, client };
}

/** @param {string} name */
const route = (name) => fixtureRoute(loadRestFixture(name));

afterEach(() => clearSecrets());

describe('REST helpers', () => {
  it('recursiveTree returns the recorded tree, capped and counted', async () => {
    const fx = loadRestFixture('tree');
    const sha = '20ae2ffee317f5550c6aad57293b5806ed4afe38';
    const { client } = setup([route('tree')]);
    const tree = await recursiveTree(client, 'skulitom/london-time-map', sha);
    assert.deepEqual(tree,
      { sha: fx.body.sha, truncated: false, count: fx.body.tree.length, tree: fx.body.tree });
    const capped = await recursiveTree(client, 'skulitom/london-time-map', sha, { cap: 10 });
    assert.equal(capped?.tree.length, 10);
    assert.equal(capped?.truncated, true);
    assert.equal(capped?.count, 25);
    await assert.rejects(recursiveTree(client, 'o/r', 'main;rm'), TypeError);
    const missing = setup([{ method: 'GET', response: 404 }]);
    assert.equal(await recursiveTree(missing.client, 'o/r', 'abcdef1'), null);
  });

  it('activity keeps the four fields and a second call is served from the cache by a 304', async () => {
    const first = loadRestFixture('activity');
    const again = loadRestFixture('activity-304');
    const map = new Map();
    const cache = {
      get: async (/** @type {string} */ k) => map.get(k),
      put: async (/** @type {string} */ k, /** @type {any} */ v) => {
        map.set(k, v);
      },
    };
    const { client, fetch } = setup([{
      method: 'GET', url: first.request.path,
      responses: [fixtureRoute(first).response, fixtureRoute(again).response],
    }], cache);
    const a = await activity(client, 'codefly-dev/cli');
    assert.equal(a?.length, 100);
    assert.deepEqual(Object.keys(/** @type {any[]} */ (a)[0]), ['id', 'ref', 'timestamp', 'activity_type']);
    const b = await activity(client, 'codefly-dev/cli');
    assert.deepEqual(b, a);
    assert.equal(fetch.calls[1].headers['if-none-match'], first.headers.etag);
  });

  it('starHistory asks for API version 2026-03-10 and returns the weekly gains', async () => {
    const fx = loadRestFixture('stargazers-history');
    const { client, fetch } = setup([route('stargazers-history')]);
    assert.deepEqual(await starHistory(client, 'zaghaghi/toolog'), fx.body);
    assert.equal(fetch.calls[0].headers['x-github-api-version'], '2026-03-10');
  });

  it('repositoriesSince lists the next public repositories', async () => {
    const { client } = setup([route('repositories-since')]);
    const list = await repositoriesSince(client, 1365300000);
    assert.equal(list.length, 100);
    assert.deepEqual(list[0],
      { id: 1365300001, node_id: 'R_kgDOUWDTIQ', full_name: 'Kamilahn-Ervini/jmmiijj', fork: false });
    assert.equal(list.filter((r) => r.fork).length, 7);
    await assert.rejects(repositoriesSince(client, -1), RangeError);
  });

  it('encodes owner and name into the API path', () => {
    assert.equal(repoApiPath('o/r.js'), '/repos/o/r.js');
    assert.equal(repoApiPath('a b/c'), '/repos/a%20b/c');
  });
});

describe('restFallback', () => {
  it('builds an enrich-shaped node that agrees with the recorded GraphQL node', async () => {
    const { client, fetch } = setup(['repo', 'readme', 'contents-root', 'releases', 'commits'].map(route));
    const node = /** @type {any} */ (await restFallback(client, 'zaghaghi/toolog'));
    const enrich = loadRepoFixture('zaghaghi/toolog').enrich;
    const same = ['id', 'nameWithOwner', 'description', 'homepageUrl', 'createdAt', 'pushedAt',
      'diskUsage', 'stargazerCount', 'forkCount', 'isFork', 'isArchived', 'isTemplate', 'isMirror',
      'hasIssuesEnabled', 'hasDiscussionsEnabled', 'licenseInfo', 'primaryLanguage', 'repositoryTopics',
      'releases', 'watchers', 'root', 'pkg', 'agents', 'claude'];
    for (const key of same) {
      assert.deepEqual(node[key], enrich[key], key);
    }
    assert.deepEqual(node.owner, { login: enrich.owner.login, __typename: enrich.owner.__typename });
    assert.equal(node.defaultBranchRef.name, enrich.defaultBranchRef.name);
    assert.equal(node.defaultBranchRef.target.oid, enrich.defaultBranchRef.target.oid);
    assert.deepEqual(node.defaultBranchRef.target.history.nodes.slice(0, 2),
      enrich.defaultBranchRef.target.history.nodes.slice(0, 2));
    assert.equal('totalCount' in node.defaultBranchRef.target.history, false,
      'more commits than one page: unknown');
    assert.equal('statusCheckRollup' in node.defaultBranchRef.target, false, 'CI state unknown over REST');
    assert.deepEqual({ ...node.readme, text: undefined }, { ...enrich.readme, text: undefined });
    assert.equal(node.readme.text, enrich.readme.text);
    for (const unknown of ['wf', 'languages', 'tags']) assert.equal(unknown in node, false, unknown);
    assert.equal(Object.keys(node).includes('bundle'), false);
    assert.equal(node.bundle.repo.full_name, 'zaghaghi/toolog');
    assert.equal(fetch.calls.length, 5);
    assert.ok(fetch.calls.every((c) => c.method === 'GET'));
  });

  it('returns null when the repository is gone', async () => {
    const { client, fetch } = setup([{ method: 'GET', url: '/repos/o/gone', response: 404 }]);
    assert.equal(await restFallback(client, 'o/gone'), null);
    assert.equal(fetch.calls.length, 1);
  });

  it('nodeFromRest: absent when REST cannot tell, null when REST proves there is none', () => {
    const repo = {
      node_id: 'R_x', full_name: 'org/r', size: 300, stargazers_count: 1, forks_count: 0, fork: false,
      default_branch: 'main', owner: { login: 'org', type: 'Organization' }, license: { spdx_id: null },
      language: null, topics: ['a'], homepage: '',
    };
    const node = nodeFromRest({
      repo,
      contents: [
        { name: 'src', type: 'dir' },
        { name: 'AGENTS.md', type: 'file', size: 42 },
        { name: 'mod', type: 'submodule' },
      ],
      releases: [{ tag_name: 'v2', published_at: 'x', prerelease: false }, { tag_name: 'd', draft: true }],
      releasesMore: true,
      commits: null,
      readme: { name: 'README.md', path: 'docs/README.md', content: '', encoding: 'base64', size: 0 },
    });
    assert.deepEqual(node.owner, { login: 'org', __typename: 'Organization' });
    assert.deepEqual(node.licenseInfo, { spdxId: 'NOASSERTION' });
    assert.equal(node.primaryLanguage, null);
    assert.equal(node.homepageUrl, null);
    assert.deepEqual(node.releases, { nodes: [{ tagName: 'v2', publishedAt: 'x', isPrerelease: false }] });
    assert.equal(node.defaultBranchRef, null, 'an empty repository has no default branch commit');
    assert.deepEqual(node.root.entries.map((/** @type {any} */ e) => e.type), ['tree', 'blob', 'commit']);
    assert.equal(node.wf, null, 'no .github directory, so no workflows');
    assert.equal(node.pkg, null);
    assert.deepEqual(node.agents, { byteSize: 42 });
    assert.equal(node.claude, null);
    assert.equal(node.readme, null, 'a README outside the root is not the root README');
    const bare = nodeFromRest({
      repo, contents: undefined, readme: undefined, releases: undefined, commits: undefined,
    });
    for (const k of ['root', 'wf', 'pkg', 'agents', 'claude', 'readme', 'releases', 'defaultBranchRef']) {
      assert.equal(k in bare, false, k);
    }
    assert.throws(() => nodeFromRest(/** @type {any} */ ({})), TypeError);
  });
});
