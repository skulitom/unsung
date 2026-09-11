// @ts-check
/**
 * REST helpers (DESIGN §3.6, §3.10, §3.1 S0c). Every call is a GET through the client, so it is
 * governed, conditional (ETag) and read-only. Results keep the shapes of the recorded fixtures
 * (test/fixtures/README.md), so live and recorded data feed the same code.
 */

import { GitHubError } from './client.mjs';
import { refOf } from './queries.mjs';

/** Largest number of tree entries kept (§3.6, §9.3 `caps.treeEntries`). */
export const TREE_CAP = 5000;

/** API version for the star-history endpoint (§3.6). */
export const STAR_HISTORY_API_VERSION = '2026-03-10';

/**
 * @typedef {import('./client.mjs').Client} Client
 * @typedef {{path: string, type: string, size?: number}} TreeEntry
 * @typedef {{sha: string | null, truncated: boolean, count: number, tree: TreeEntry[]}} Tree
 * @typedef {{id: number, ref: string, timestamp: string, activity_type: string}} ActivityEvent
 * @typedef {{week: number, total: number, days?: number[]}} StarWeek
 */

/**
 * `/repos/<owner>/<name>` with both parts URL-encoded.
 * @param {string} nwo
 * @returns {string}
 */
export function repoApiPath(nwo) {
  const { owner, name } = refOf(nwo);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

/**
 * Recursive tree at a commit (or tree) SHA: `{sha, truncated, count, tree: [{path, type, size?}]}`,
 * at most `cap` entries. `truncated` is true when GitHub truncated the listing or the cap cut it;
 * `count` is the number of entries GitHub returned. `null` when the tree cannot be read (404, an
 * empty repository).
 * @param {Client} client
 * @param {string} nwo
 * @param {string} sha
 * @param {{cap?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<Tree | null>}
 */
export async function recursiveTree(client, nwo, sha, { cap = TREE_CAP, signal } = {}) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{4,64}$/i.test(sha)) {
    throw new TypeError('recursiveTree needs a commit or tree SHA');
  }
  const r = await client.rest(`${repoApiPath(nwo)}/git/trees/${sha}?recursive=1`, { signal });
  if (r.status !== 200 || !r.data || !Array.isArray(r.data.tree)) return null;
  /** @type {any[]} */
  const all = r.data.tree;
  const tree = all.slice(0, Math.max(0, cap)).map((e) => (e?.type === 'blob' && Number.isFinite(e.size)
    ? { path: String(e.path), type: 'blob', size: Number(e.size) }
    : { path: String(e?.path), type: String(e?.type) }));
  return {
    sha: typeof r.data.sha === 'string' ? r.data.sha : null,
    truncated: Boolean(r.data.truncated) || all.length > cap,
    count: all.length,
    tree,
  };
}

/**
 * One page of repository activity (`per_page=100`, ETag-conditional), reduced to the four fields
 * §3.6 reads. `null` when unavailable.
 * @param {Client} client
 * @param {string} nwo
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<ActivityEvent[] | null>}
 */
export async function activity(client, nwo, { signal } = {}) {
  const r = await client.rest(`${repoApiPath(nwo)}/activity?per_page=100`, { signal });
  if (r.status !== 200 || !Array.isArray(r.data)) return null;
  return r.data.filter((e) => e && typeof e === 'object').map((e) => ({
    id: e.id, ref: e.ref, timestamp: e.timestamp, activity_type: e.activity_type,
  }));
}

/**
 * Weekly star history, newest first (`per_page=8`): GitHub's answer, where `total` is the stars gained
 * that week and `week` a Unix time in seconds. Callers only ask when stars ≥ 3. `null` when
 * unavailable.
 * @param {Client} client
 * @param {string} nwo
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<StarWeek[] | null>}
 */
export async function starHistory(client, nwo, { signal } = {}) {
  const r = await client.rest(`${repoApiPath(nwo)}/stargazers/history?per_page=8`, {
    apiVersion: STAR_HISTORY_API_VERSION, signal,
  });
  if (r.status !== 200 || !Array.isArray(r.data)) return null;
  return r.data.filter((w) => w && Number.isFinite(w.week) && Number.isFinite(w.total));
}

/**
 * The next public repositories after `sinceId` (`GET /repositories?since=`), ascending by id, as
 * `[{id, node_id, full_name, fork}]`.
 * @param {Client} client
 * @param {number} sinceId
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<{id: number, node_id: string, full_name: string, fork: boolean}[]>}
 */
export async function repositoriesSince(client, sinceId, { signal } = {}) {
  if (!Number.isInteger(sinceId) || sinceId < 0) {
    throw new RangeError('repositoriesSince needs a whole id ≥ 0');
  }
  const r = await client.rest(`/repositories?since=${sinceId}`, { signal });
  if (r.status !== 200 || !Array.isArray(r.data)) return [];
  return r.data
    .filter((x) => x && Number.isInteger(x.id) && typeof x.full_name === 'string')
    .map((x) => ({
      id: x.id, node_id: String(x.node_id ?? ''), full_name: x.full_name, fork: Boolean(x.fork),
    }));
}

/**
 * Whether a response's `link` header announces a next page.
 * @param {Record<string, string>} headers
 * @returns {boolean}
 */
function hasNextPage(headers) {
  return /rel="next"/.test(String(headers?.link ?? ''));
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The REST answers `restFallback` gathers. Each body is the parsed JSON, `null` when GitHub said the
 * thing does not exist (404, or 409 for an empty repository), or `undefined` when it could not be
 * read — which leaves the matching node fields absent (unknown).
 * @typedef {object} RestBundle
 * @property {any} repo `GET /repos/{o}/{r}`
 * @property {any} [readme] `GET /repos/{o}/{r}/readme`
 * @property {any} [contents] `GET /repos/{o}/{r}/contents/`
 * @property {any} [releases] `GET /repos/{o}/{r}/releases?per_page=5`
 * @property {any} [commits] `GET /repos/{o}/{r}/commits?per_page=20`
 * @property {boolean} [releasesMore] the releases page has a next page
 * @property {boolean} [commitsMore] the commits page has a next page
 */

/**
 * Assemble an enrich-shaped node (§3.5 field names) from REST answers. Only what REST states is
 * filled in; everything else is left absent, so the signals that need it read as unknown:
 * `languages`, `tags`, owner `createdAt`/`repositories`, `statusCheckRollup`; `wf` and `pkg` unless
 * the root listing proves there are none; the release and commit `totalCount` when there are more
 * pages than the one fetched. The bundle itself is attached as a non-enumerable `bundle` property.
 * @param {RestBundle} bundle
 * @returns {Record<string, any>}
 */
export function nodeFromRest(bundle) {
  const { repo, readme, contents, releases, commits } = bundle;
  if (!repo || typeof repo !== 'object') throw new TypeError('nodeFromRest needs the repository body');
  /** @type {Record<string, any>} */
  const node = {
    id: typeof repo.node_id === 'string' ? repo.node_id : null,
    nameWithOwner: repo.full_name,
    description: typeof repo.description === 'string' ? repo.description : null,
    homepageUrl: typeof repo.homepage === 'string' && repo.homepage ? repo.homepage : null,
    createdAt: repo.created_at ?? null,
    pushedAt: repo.pushed_at ?? null,
    diskUsage: num(repo.size),
    stargazerCount: num(repo.stargazers_count),
    forkCount: num(repo.forks_count),
    isFork: Boolean(repo.fork),
    isArchived: Boolean(repo.archived),
    isTemplate: Boolean(repo.is_template),
    isMirror: Boolean(repo.mirror_url),
    hasIssuesEnabled: Boolean(repo.has_issues),
  };
  if (typeof repo.has_discussions === 'boolean') node.hasDiscussionsEnabled = repo.has_discussions;
  node.licenseInfo = repo.license ? { spdxId: repo.license.spdx_id ?? 'NOASSERTION' } : null;
  node.primaryLanguage = typeof repo.language === 'string' && repo.language ? { name: repo.language } : null;
  node.repositoryTopics = {
    nodes: (Array.isArray(repo.topics) ? repo.topics : []).map((name) => ({ topic: { name: String(name) } })),
  };
  if (Array.isArray(releases)) {
    const nodes = releases.filter((r) => r && !r.draft).map((r) => ({
      tagName: r.tag_name, publishedAt: r.published_at ?? null, isPrerelease: Boolean(r.prerelease),
    }));
    node.releases = bundle.releasesMore ? { nodes } : { totalCount: nodes.length, nodes };
  } else if (releases === null) {
    node.releases = { totalCount: 0, nodes: [] };
  }
  if (Number.isFinite(repo.subscribers_count)) node.watchers = { totalCount: repo.subscribers_count };
  node.owner = {
    login: repo.owner?.login ?? null,
    __typename: repo.owner?.type === 'Organization' ? 'Organization' : 'User',
  };
  if (Array.isArray(commits) && commits.length > 0 && repo.default_branch) {
    /** @type {Record<string, any>} */
    const history = {
      nodes: commits.slice(0, 20).map((c) => ({
        committedDate: c?.commit?.committer?.date ?? c?.commit?.author?.date ?? null,
        messageHeadline: String(c?.commit?.message ?? '').split('\n')[0].trim(),
        author: { user: c?.author?.login ? { login: c.author.login } : null },
      })),
    };
    if (!bundle.commitsMore) history.totalCount = commits.length;
    node.defaultBranchRef = { name: repo.default_branch, target: { oid: commits[0].sha, history } };
  } else if (commits === null || (Array.isArray(commits) && commits.length === 0) || !repo.default_branch) {
    node.defaultBranchRef = null;
  }
  if (Array.isArray(contents)) {
    node.root = {
      entries: contents.filter((e) => e && typeof e.name === 'string').map((e) => ({
        name: e.name, type: e.type === 'dir' ? 'tree' : e.type === 'submodule' ? 'commit' : 'blob',
      })),
    };
    /** @param {string} name */
    const file = (name) => contents.find((e) => e?.name === name && e.type === 'file') ?? null;
    if (!contents.some((e) => e?.name === '.github' && e.type === 'dir')) node.wf = null;
    if (!file('package.json')) node.pkg = null;
    const agents = file('AGENTS.md');
    const claude = file('CLAUDE.md');
    node.agents = agents ? { byteSize: num(agents.size) } : null;
    node.claude = claude ? { byteSize: num(claude.size) } : null;
  } else if (contents === null) {
    Object.assign(node, { root: null, wf: null, pkg: null, agents: null, claude: null });
  }
  const readmePath = String(readme?.path ?? readme?.name ?? '');
  if (readme && typeof readme.content === 'string' && readmePath && !readmePath.includes('/')) {
    const text = readme.encoding === 'base64'
      ? Buffer.from(readme.content, 'base64').toString('utf8')
      : readme.content;
    node.readme = {
      name: String(readme.name ?? readmePath), byteSize: num(readme.size), isTruncated: false, text,
    };
  } else if (readme === null || (readme && readmePath.includes('/'))) {
    node.readme = null;
  }
  Object.defineProperty(node, 'bundle', { value: bundle, enumerable: false });
  return node;
}

/**
 * The REST fallback for a repository whose enrich query still fails alone (§3.10): `GET
 * /repos/{o}/{r}`, `/readme`, `/contents/`, `/releases?per_page=5` and `/commits?per_page=20`,
 * assembled by `nodeFromRest` into an enrich-shaped node. `null` when the repository is gone.
 * @param {Client} client
 * @param {string} nwo
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<Record<string, any> | null>}
 */
export async function restFallback(client, nwo, { signal } = {}) {
  const base = repoApiPath(nwo);
  const repo = await client.rest(base, { signal });
  if ([404, 410, 451].includes(repo.status)) return null;
  if (repo.status !== 200 || !repo.data || typeof repo.data !== 'object') {
    throw new GitHubError(`GitHub answered HTTP ${repo.status} for ${base}`, { status: repo.status });
  }
  const [readme, contents, releases, commits] = await Promise.all([
    client.rest(`${base}/readme`, { signal }),
    client.rest(`${base}/contents/`, { signal }),
    client.rest(`${base}/releases?per_page=5`, { signal }),
    client.rest(`${base}/commits?per_page=20`, { signal }),
  ]);
  /**
   * @param {{status: number, data: any}} r
   * @returns {any}
   */
  const body = (r) => (r.status === 200 ? r.data : r.status === 404 || r.status === 409 ? null : undefined);
  return nodeFromRest({
    repo: repo.data,
    readme: body(readme),
    contents: body(contents),
    releases: body(releases),
    commits: body(commits),
    releasesMore: hasNextPage(releases.headers),
    commitsMore: hasNextPage(commits.headers),
  });
}
