// @ts-check
/**
 * Facts normalisation (DESIGN §4.3): the enrich node of §3.5, the deep responses of §3.6 and the
 * REST fallback of §3.10 become one `Facts` snapshot that every signal reads. `null` means not
 * fetched or not knowable; `[]`, `0` and `false` mean fetched and empty (§4.1). Texts are capped
 * without splitting a character: README 32 KB, workflow and manifest texts 16 KB, description 1 KB,
 * commit headlines 200 characters, trees 5,000 entries.
 */

import { isManifest } from './ecosystems.mjs';
import { countFenceLines } from './readme.mjs';
import { truncateUtf8 } from './util.mjs';

/** @typedef {import('./schema.mjs').Facts} Facts */
/** @typedef {import('./schema.mjs').TreeEntry} TreeEntry */

/** Caps of §4.1 and §9.3. */
export const CAPS = Object.freeze({
  readmeBytes: 32768, fileBytes: 16384, treeEntries: 5000, descriptionBytes: 1024, headlineChars: 200,
});

const ROLLUPS = new Set(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']);
/** Activity types that are server-stamped pushes of work (branch deletions are not). */
const PUSH_ACTIVITY = new Set(['push', 'force_push', 'pr_merge', 'merge_queue_merge', 'branch_creation']);

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function str(v) {
  return typeof v === 'string' ? v : null;
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function nonEmpty(v) {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function count(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * @param {unknown} v
 * @returns {boolean | null}
 */
function flag(v) {
  return typeof v === 'boolean' ? v : null;
}

/**
 * @param {string} s
 * @returns {number}
 */
function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

/**
 * @param {unknown} v
 * @param {string} what
 * @returns {string}
 */
function requireTime(v, what) {
  if (typeof v !== 'string' || !Number.isFinite(Date.parse(v))) {
    throw new TypeError(`${what} must be an ISO-8601 timestamp`);
  }
  return v;
}

/**
 * First line of a commit message, at most `max` characters.
 * @param {unknown} s
 * @param {number} max
 * @returns {string | null}
 */
function headline(s, max) {
  if (typeof s !== 'string') return null;
  const chars = [...s.split(/\r?\n/)[0]];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

/**
 * @param {string | null} text
 * @param {number} bytes
 * @returns {string | null}
 */
function cap(text, bytes) {
  return text === null ? null : truncateUtf8(text, bytes).text;
}

/**
 * @param {string} nwo
 * @returns {boolean}
 */
function isNwo(nwo) {
  return /^[^/\s]+\/[^/\s]+$/.test(nwo);
}

/**
 * Summarise a `package.json` text (§4.3 `packageJson`): its name, the sizes of its four dependency
 * maps, its test script and its script names. `null` when the text is not a JSON object.
 * @param {unknown} text
 * @returns {{name: string | null, private: boolean, deps: number, devDeps: number, peerDeps: number,
 *   optionalDeps: number, testScript: string | null, scripts: string[]} | null}
 */
export function packageJsonSummary(text) {
  if (typeof text !== 'string') return null;
  /** @type {unknown} */
  let pkg;
  try {
    pkg = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return null;
  }
  if (!isObj(pkg)) return null;
  /** @param {unknown} v */
  const size = (v) => (isObj(v) ? Object.keys(v).length : 0);
  const scripts = isObj(pkg.scripts) ? pkg.scripts : {};
  const test = typeof scripts.test === 'string' ? scripts.test : null;
  return {
    name: typeof pkg.name === 'string' ? pkg.name.slice(0, 214) : null,
    private: pkg.private === true,
    deps: size(pkg.dependencies),
    devDeps: size(pkg.devDependencies),
    peerDeps: size(pkg.peerDependencies),
    optionalDeps: size(pkg.optionalDependencies),
    testScript: test === null ? null : test.slice(0, 500),
    scripts: Object.keys(scripts).filter((k) => typeof scripts[k] === 'string').slice(0, 200),
  };
}

// ---------------------------------------------------------------------------------------------
// Pieces shared by the GraphQL and REST mappings
// ---------------------------------------------------------------------------------------------

/**
 * @param {unknown} blob `{name?, byteSize, isTruncated?, text}` (GraphQL) or `{name, bytes, text}`
 * @param {string | null} fallbackName
 * @param {number} capBytes
 * @returns {Facts['readme']}
 */
function readmeOf(blob, fallbackName, capBytes) {
  if (!isObj(blob)) return null;
  const full = str(blob.text);
  const capped = full === null ? { text: null, truncated: false } : truncateUtf8(full, capBytes);
  const bytes = count(blob.byteSize) ?? count(blob.bytes) ?? count(blob.size)
    ?? (full === null ? 0 : byteLength(full));
  /** @type {NonNullable<Facts['readme']> & {fenceLines?: number}} */
  const readme = {
    name: nonEmpty(blob.name) ?? fallbackName ?? 'README.md',
    bytes,
    truncated: capped.truncated || blob.isTruncated === true,
    text: capped.text,
  };
  // Signals read the full text before truncation (§3.5): keep the one count they need from it.
  if (full !== null) readme.fenceLines = countFenceLines(full);
  return readme;
}

/**
 * @param {unknown} info GraphQL `licenseInfo` or REST `license`
 * @returns {string | null}
 */
function licenceOf(info) {
  if (!isObj(info)) return null;
  return nonEmpty(info.spdxId) ?? nonEmpty(info.spdx_id) ?? 'NOASSERTION';
}

/**
 * @param {unknown} conn GraphQL `releases` connection
 * @returns {Facts['releases']}
 */
function releasesOf(conn) {
  if (!isObj(conn)) return null;
  const nodes = Array.isArray(conn.nodes) ? conn.nodes.filter(isObj) : [];
  const recent = nodes.map((r) => ({
    tag: String(r.tagName ?? r.tag_name ?? ''),
    publishedAt: str(r.publishedAt ?? r.published_at),
    prerelease: flag(r.isPrerelease ?? r.prerelease),
  }));
  return { count: count(conn.totalCount) ?? recent.length, recent };
}

/**
 * @param {unknown} obj GraphQL `object(expression: "HEAD:…")` tree
 * @returns {{name: string, type: string}[] | null}
 */
function entriesOf(obj) {
  if (obj === undefined) return null;
  if (!isObj(obj)) return [];
  const entries = Array.isArray(obj.entries) ? obj.entries.filter(isObj) : [];
  return entries
    .map((e) => ({ name: String(e.name ?? ''), type: String(e.type ?? 'blob') }))
    .filter((e) => e.name);
}

/**
 * @param {unknown} obj a `{byteSize}` blob, null when absent, undefined when not fetched
 * @returns {number | null}
 */
function blobBytes(obj) {
  if (obj === undefined) return null;
  if (!isObj(obj)) return 0;
  return count(obj.byteSize) ?? 0;
}

/**
 * @param {unknown} conn GraphQL `languages` connection
 * @returns {{languages: Facts['languages'], codeBytes: number | null}}
 */
function languagesOf(conn) {
  if (!isObj(conn)) return { languages: null, codeBytes: null };
  const edges = Array.isArray(conn.edges) ? conn.edges.filter(isObj) : [];
  const languages = edges
    .map((e) => ({ name: String(e.node?.name ?? ''), bytes: count(e.size) ?? 0 }))
    .filter((l) => l.name);
  const codeBytes = count(conn.totalSize) ?? languages.reduce((a, l) => a + l.bytes, 0);
  return { languages, codeBytes };
}

/**
 * @param {unknown} branch GraphQL `defaultBranchRef`
 * @param {number} maxChars headline cap
 * @returns {Facts['commits']}
 */
function commitsOf(branch, maxChars) {
  if (branch === null) return { total: 0, recent: [] };
  const history = isObj(branch) && isObj(branch.target) && isObj(branch.target.history)
    ? branch.target.history : null;
  if (!history) return null;
  const nodes = Array.isArray(history.nodes) ? history.nodes.filter(isObj) : [];
  return {
    total: count(history.totalCount),
    recent: nodes.slice(0, 20).map((c) => ({
      at: str(c.committedDate),
      headline: headline(c.messageHeadline, maxChars),
      authorLogin: str(c.author?.user?.login),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// factsFromEnrich
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} EnrichOptions
 * @property {string} fetchedAt ISO time of the fetch (required: core never reads the clock)
 * @property {{name?: string, byteSize?: number, isTruncated?: boolean, text?: string | null} | null}
 *   [readmeRepair] the README blob found by the §3.5 repair query, with its root name
 * @property {'graphql' | 'rest' | 'fixture'} [source] default `graphql`
 * @property {boolean} [heavy] default false
 * @property {string} [id] fallback node id when the node has none (converted research fixtures)
 * @property {Partial<typeof CAPS>} [caps]
 */

/**
 * Normalise one §3.5 enrich node (a GraphQL `Repository` selected with the `Enrich` fragment) into
 * Facts. A field the node lacks becomes null (not fetched); an object the node returned as null
 * (no README, no workflows directory, no `package.json`) becomes the empty value.
 * @param {Record<string, any>} node
 * @param {EnrichOptions} opts
 * @returns {Facts}
 */
export function factsFromEnrich(node, opts) {
  if (!isObj(node)) throw new TypeError('factsFromEnrich needs a repository node');
  const o = opts ?? /** @type {EnrichOptions} */ ({});
  const fetchedAt = requireTime(o.fetchedAt, 'fetchedAt');
  const caps = { ...CAPS, ...(o.caps ?? {}) };
  const nwo = str(node.nameWithOwner);
  if (!nwo || !isNwo(nwo)) throw new TypeError('The node has no nameWithOwner');
  const [owner, name] = nwo.split('/');
  const branch = node.defaultBranchRef;
  const target = isObj(branch) && isObj(branch.target) ? branch.target : null;
  const { languages, codeBytes } = languagesOf(node.languages);
  const ownerNode = isObj(node.owner) ? node.owner : null;
  const rollup = str(target?.statusCheckRollup?.state);
  const repair = isObj(o.readmeRepair) ? o.readmeRepair : null;
  const description = str(node.description);
  const workflows = entriesOf(node.wf);
  const topics = isObj(node.repositoryTopics) && Array.isArray(node.repositoryTopics.nodes)
    ? node.repositoryTopics.nodes.map((/** @type {any} */ t) => t?.topic?.name).filter(nonEmpty)
    : null;
  return {
    v: 1,
    id: nonEmpty(node.id) ?? nonEmpty(o.id) ?? `fixture:${nwo}`,
    nwo,
    owner,
    name,
    fetchedAt,
    source: o.source ?? 'graphql',
    stages: ['enrich'],
    headOid: str(target?.oid),
    defaultBranch: str(branch?.name),
    createdAt: str(node.createdAt),
    pushedAt: str(node.pushedAt),
    description: description === null ? null : truncateUtf8(description, caps.descriptionBytes).text,
    homepageUrl: nonEmpty(node.homepageUrl),
    isFork: flag(node.isFork),
    isArchived: flag(node.isArchived),
    isTemplate: flag(node.isTemplate),
    isMirror: flag(node.isMirror),
    hasIssues: flag(node.hasIssuesEnabled),
    hasDiscussions: flag(node.hasDiscussionsEnabled),
    stars: count(node.stargazerCount),
    forks: count(node.forkCount),
    watchers: count(node.watchers?.totalCount),
    diskKB: count(node.diskUsage),
    licence: licenceOf(node.licenseInfo),
    primaryLanguage: str(node.primaryLanguage?.name),
    languages,
    codeBytes,
    topics,
    releases: releasesOf(node.releases),
    tags: count(node.tags?.totalCount),
    ownerInfo: ownerNode ? {
      login: str(ownerNode.login) ?? owner,
      type: str(ownerNode.__typename) ?? 'Unknown',
      createdAt: str(ownerNode.createdAt),
      publicRepos: count(ownerNode.repositories?.totalCount),
      contributionYears: null,
      sponsorsListing: null,
    } : null,
    commits: branch === undefined ? null : commitsOf(branch, caps.headlineChars),
    rollup: rollup !== null && ROLLUPS.has(rollup) ? /** @type {Facts['rollup']} */ (rollup) : null,
    root: entriesOf(node.root),
    workflows: workflows === null ? null : workflows.map((e) => ({ name: e.name, text: null })),
    readme: readmeOf(node.readme ?? repair, str(repair?.name), caps.readmeBytes),
    packageJson: isObj(node.pkg) ? packageJsonSummary(node.pkg.text) : null,
    manifest: null,
    agentsMdBytes: blobBytes(node.agents),
    claudeMdBytes: blobBytes(node.claude),
    tree: null,
    activity: null,
    starHistory: null,
    outsiders: null,
    funding: null,
    heavy: o.heavy === true,
  };
}

// ---------------------------------------------------------------------------------------------
// Deep-stage normalisers
// ---------------------------------------------------------------------------------------------

/**
 * Normalise a tree: the REST body `{sha, truncated, tree: [{path, type, size?}]}`, an array of such
 * entries or of `[path, type, size]` tuples, or an already normalised `{truncated, count, entries}`.
 * At most `maxEntries` entries are kept; `truncated` records a REST truncation or the cap.
 * @param {unknown} tree
 * @param {number} [maxEntries]
 * @returns {Facts['tree']}
 */
export function normaliseTree(tree, maxEntries = CAPS.treeEntries) {
  /** @type {unknown[]} */
  let items;
  let truncated = false;
  /** @type {number | null} */
  let total = null;
  if (Array.isArray(tree)) items = tree;
  else if (isObj(tree) && Array.isArray(tree.entries)) {
    items = tree.entries;
    truncated = tree.truncated === true;
    total = count(tree.count);
  } else if (isObj(tree) && Array.isArray(tree.tree)) {
    items = tree.tree;
    truncated = tree.truncated === true;
  } else return null;
  /** @type {TreeEntry[]} */
  const entries = [];
  for (const it of items) {
    const [p, t, s] = Array.isArray(it) ? it : isObj(it) ? [it.path, it.type, it.size] : [];
    if (typeof p !== 'string' || !p) continue;
    const type = typeof t === 'string' ? t : 'blob';
    entries.push(typeof s === 'number' && s >= 0 ? [p, type, s] : [p, type]);
  }
  return {
    truncated: truncated || entries.length > maxEntries,
    count: Math.max(total ?? 0, entries.length),
    entries: entries.slice(0, maxEntries),
  };
}

/**
 * Reduce one page of `/activity` (§3.6 step 2) to `{pushDays, firstAt, lastAt, forcePushes}`: push
 * days are distinct UTC days with a push, force push, merge or branch creation. An already reduced
 * object is kept.
 * @param {unknown} activity
 * @returns {Facts['activity']}
 */
export function normaliseActivity(activity) {
  if (isObj(activity) && typeof activity.pushDays === 'number') {
    return {
      pushDays: count(activity.pushDays) ?? 0,
      firstAt: str(activity.firstAt),
      lastAt: str(activity.lastAt),
      forcePushes: count(activity.forcePushes),
    };
  }
  if (!Array.isArray(activity)) return null;
  const days = new Set();
  /** @type {string[]} */
  const times = [];
  let forcePushes = 0;
  for (const ev of activity) {
    if (!isObj(ev) || typeof ev.timestamp !== 'string') continue;
    if (!Number.isFinite(Date.parse(ev.timestamp))) continue;
    if (ev.activity_type === 'force_push') forcePushes++;
    if (!PUSH_ACTIVITY.has(String(ev.activity_type))) continue;
    days.add(ev.timestamp.slice(0, 10));
    times.push(ev.timestamp);
  }
  times.sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    pushDays: days.size, firstAt: times[0] ?? null, lastAt: times[times.length - 1] ?? null, forcePushes,
  };
}

/**
 * Normalise `/stargazers/history` (§3.6 step 3): entries `{week, total}` with `week` in Unix seconds
 * (or a date) and `total` the stars gained that week. Weeks are kept newest first as `YYYY-MM-DD`;
 * `gain4w` is the sum of the newest four.
 * @param {unknown} stars
 * @returns {Facts['starHistory']}
 */
export function normaliseStarHistory(stars) {
  /** @type {unknown[] | null} */
  let items = null;
  if (Array.isArray(stars)) items = stars;
  else if (isObj(stars) && Array.isArray(stars.weeks)) items = stars.weeks;
  if (!items) return null;
  const weeks = [];
  for (const it of items) {
    if (!isObj(it)) continue;
    const w = it.week;
    let ms = NaN;
    if (typeof w === 'number') ms = w < 1e12 ? w * 1000 : w;
    else if (typeof w === 'string') ms = Date.parse(w.length === 10 ? `${w}T00:00:00Z` : w);
    if (!Number.isFinite(ms)) continue;
    const gained = typeof it.gained === 'number' ? it.gained : typeof it.total === 'number' ? it.total : 0;
    weeks.push({ ms, week: new Date(ms).toISOString().slice(0, 10), gained });
  }
  weeks.sort((a, b) => b.ms - a.ms);
  const out = weeks.map(({ week, gained }) => ({ week, gained }));
  return { weeks: out, gain4w: out.slice(0, 4).reduce((a, w) => a + w.gained, 0) };
}

/**
 * Non-owner authors of recent issues and pull requests (§4.3 `outsiders`), or undefined when the
 * deep node carries neither connection.
 * @param {Record<string, any>} node
 * @param {string} owner
 * @returns {NonNullable<Facts['outsiders']> | undefined}
 */
function outsidersOf(node, owner) {
  if (!isObj(node.issues) && !isObj(node.pullRequests)) return undefined;
  /** @type {NonNullable<Facts['outsiders']>} */
  const out = [];
  for (const [kind, conn] of /** @type {const} */ ([['issue', node.issues], ['pr', node.pullRequests]])) {
    const nodes = isObj(conn) && Array.isArray(conn.nodes) ? conn.nodes.filter(isObj) : [];
    for (const it of nodes) {
      const login = nonEmpty(it.author?.login);
      const at = str(it.createdAt);
      if (!login || !at || login.toLowerCase() === owner.toLowerCase()) continue;
      out.push({ login, kind, at, accountCreatedAt: str(it.author?.createdAt) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// mergeDeep
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} DeepParts
 * @property {Record<string, any> | null} [node] the §3.6 `Deep` fragment node
 * @property {unknown} [tree] REST recursive tree (see `normaliseTree`)
 * @property {unknown} [activity] REST `/activity` page (see `normaliseActivity`)
 * @property {unknown} [starHistory] REST `/stargazers/history` (see `normaliseStarHistory`)
 * @property {Record<string, {byteSize?: number, text?: string | null} | null> | null} [files]
 *   `{path: blob | null}` from the §3.6 step 5 file query
 */

/**
 * Merge deep-stage responses (§3.6) into Facts, returning a new object with stage `deep` and
 * `deepHeadOid` (the `headOid` the deep data belongs to). Absent parts leave their fields as they
 * were. Releases from the deep node (up to 10, with dates) replace the enrich ones; workflow texts
 * and the first root manifest other than `package.json` come from `files`; a fetched
 * `package.json` refreshes `packageJson`.
 * @param {Facts} facts
 * @param {DeepParts} parts
 * @param {{fetchedAt?: string, caps?: Partial<typeof CAPS>}} [opts]
 * @returns {Facts}
 */
export function mergeDeep(facts, parts, opts = {}) {
  if (!isObj(facts)) throw new TypeError('mergeDeep needs Facts');
  const caps = { ...CAPS, ...(opts.caps ?? {}) };
  const { node = null, tree, activity, starHistory, files = null } = parts ?? {};
  const stages = [...new Set([...(facts.stages ?? []), /** @type {'deep'} */ ('deep')])];
  /** @type {Facts & {deepHeadOid?: string | null}} */
  const out = { ...facts, stages, deepHeadOid: facts.headOid ?? null };
  if (opts.fetchedAt !== undefined) out.fetchedAt = requireTime(opts.fetchedAt, 'fetchedAt');

  if (isObj(node)) {
    if (Array.isArray(node.fundingLinks)) {
      out.funding = node.fundingLinks.filter(isObj)
        .map((l) => ({ platform: String(l.platform ?? ''), url: String(l.url ?? '') }));
    }
    if (isObj(node.owner)) {
      const info = {
        ...(facts.ownerInfo ?? {
          login: facts.owner, type: 'Unknown', createdAt: null, publicRepos: null, contributionYears: null,
          sponsorsListing: null,
        }),
      };
      const sponsors = node.owner.hasSponsorsListing;
      if (typeof sponsors === 'boolean') info.sponsorsListing = sponsors;
      const years = node.owner.contributionsCollection?.contributionYears;
      if (Array.isArray(years)) {
        info.contributionYears = years.filter((y) => Number.isInteger(y)).sort((a, b) => a - b);
      }
      out.ownerInfo = info;
    }
    if (isObj(node.releases)) out.releases = releasesOf(node.releases);
    const outsiders = outsidersOf(node, facts.owner);
    if (outsiders !== undefined) out.outsiders = outsiders;
  }
  if (tree !== undefined && tree !== null) out.tree = normaliseTree(tree, caps.treeEntries);
  if (activity !== undefined && activity !== null) out.activity = normaliseActivity(activity);
  if (starHistory !== undefined && starHistory !== null) out.starHistory = normaliseStarHistory(starHistory);
  if (isObj(files)) mergeFiles(out, facts, files, caps.fileBytes);
  return out;
}

/**
 * Apply the §3.6 step 5 file blobs: workflow texts, the first root manifest other than
 * `package.json`, and a full `package.json`.
 * @param {Facts} out
 * @param {Facts} facts
 * @param {Record<string, {byteSize?: number, text?: string | null} | null>} files
 * @param {number} fileBytes
 * @returns {void}
 */
function mergeFiles(out, facts, files, fileBytes) {
  /** @type {{name: string, text: string | null}[] | null} */
  let workflows = facts.workflows ? facts.workflows.map((w) => ({ ...w })) : null;
  for (const [path, blob] of Object.entries(files)) {
    const m = /^\.github\/workflows\/([^/]+)$/.exec(path);
    if (!m) continue;
    workflows ??= [];
    let w = workflows.find((x) => x.name === m[1]);
    if (!w) {
      w = { name: m[1], text: null };
      workflows.push(w);
    }
    if (isObj(blob) && typeof blob.text === 'string') w.text = cap(blob.text, fileBytes);
  }
  out.workflows = workflows;
  const rootFiles = (facts.root ?? []).filter((e) => e.type !== 'tree').map((e) => e.name);
  const candidates = [...rootFiles, ...Object.keys(files)]
    .filter((p) => !p.includes('/') && p.toLowerCase() !== 'package.json' && isManifest(p));
  for (const p of candidates) {
    const blob = files[p];
    if (isObj(blob) && typeof blob.text === 'string') {
      out.manifest = { path: p, text: cap(blob.text, fileBytes) };
      break;
    }
  }
  const pj = files['package.json'];
  if (isObj(pj) && typeof pj.text === 'string') {
    out.packageJson = packageJsonSummary(pj.text) ?? out.packageJson;
  }
}

// ---------------------------------------------------------------------------------------------
// factsFromRest
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} b64
 * @returns {string}
 */
function decodeBase64(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** @type {Record<string, string>} */
const CONTENT_TYPES = { file: 'blob', dir: 'tree', symlink: 'blob', submodule: 'commit' };

/**
 * @typedef {object} RestBundle
 * @property {Record<string, any>} repo `GET /repos/{o}/{r}`
 * @property {Record<string, any> | null} [readme] `GET /repos/{o}/{r}/readme` (null on 404)
 * @property {Record<string, any>[] | null} [contents] `GET /repos/{o}/{r}/contents/`
 * @property {Record<string, any>[] | null} [releases] `GET /repos/{o}/{r}/releases?per_page=5`
 * @property {Record<string, any>[] | null} [commits] `GET /repos/{o}/{r}/commits?per_page=20`
 * @property {Record<string, number> | null} [languages] `GET /repos/{o}/{r}/languages`, if fetched
 * @property {string | {text?: string} | null} [packageJson] root `package.json` text, if fetched
 * @property {(string | {name: string})[] | null} [workflows] `.github/workflows` entries, if fetched
 */

/**
 * @param {RestBundle} bundle
 * @param {number} capBytes
 * @returns {Facts['readme']}
 */
function restReadme(bundle, capBytes) {
  if (!isObj(bundle.readme)) return null;
  const r = bundle.readme;
  /** @type {string | null} */
  let text = null;
  try {
    const base64 = r.encoding === 'base64' && typeof r.content === 'string';
    text = base64 ? decodeBase64(r.content) : str(r.content);
  } catch {
    text = null;
  }
  return readmeOf({ name: r.name, byteSize: r.size, text }, 'README.md', capBytes);
}

/**
 * Facts from the REST fallback of §3.10 (`heavy` repositories). Accepts either the raw REST bodies
 * (`RestBundle`) or an enrich-shaped node already assembled from them (anything with
 * `nameWithOwner`, as `src/github/rest.mjs#restFallback` returns). Fields REST does not provide
 * (tags, CI state, owner age and size, commit count) are null.
 * @param {RestBundle | Record<string, any>} bundle
 * @param {{fetchedAt: string, heavy?: boolean, caps?: Partial<typeof CAPS>}} opts
 * @returns {Facts}
 */
export function factsFromRest(bundle, opts) {
  if (!isObj(bundle)) throw new TypeError('factsFromRest needs the REST responses');
  const heavy = opts?.heavy ?? true;
  if (typeof bundle.nameWithOwner === 'string') {
    return factsFromEnrich(bundle, { ...opts, source: 'rest', heavy });
  }
  const fetchedAt = requireTime(opts?.fetchedAt, 'fetchedAt');
  const caps = { ...CAPS, ...(opts?.caps ?? {}) };
  const b = /** @type {RestBundle} */ (bundle);
  const repo = b.repo;
  if (!isObj(repo)) throw new TypeError('factsFromRest needs the repository body');
  const nwo = str(repo.full_name);
  if (!nwo || !isNwo(nwo)) throw new TypeError('The repository body has no full_name');
  const [owner, name] = nwo.split('/');

  const contents = Array.isArray(b.contents) ? b.contents.filter(isObj) : null;
  const root = contents
    ? contents.map((e) => ({ name: String(e.name ?? ''), type: CONTENT_TYPES[String(e.type)] ?? 'blob' }))
      .filter((e) => e.name)
    : null;
  /** @param {string} file */
  const rootSize = (file) => {
    if (!contents) return null;
    const lower = file.toLowerCase();
    const hit = contents.find((e) => String(e.name).toLowerCase() === lower && e.type === 'file');
    return hit ? count(hit.size) ?? 0 : 0;
  };
  const rel = Array.isArray(b.releases) ? b.releases.filter((r) => isObj(r) && r.draft !== true) : null;
  const cms = Array.isArray(b.commits) ? b.commits.filter(isObj) : null;
  const langs = isObj(b.languages)
    ? Object.entries(b.languages)
      .filter(([, n]) => typeof n === 'number' && n >= 0)
      .map(([n, bytes]) => ({ name: n, bytes: /** @type {number} */ (bytes) }))
      .sort((x, y) => y.bytes - x.bytes)
    : null;
  const pjText = typeof b.packageJson === 'string' ? b.packageJson
    : isObj(b.packageJson) ? str(b.packageJson.text) : null;
  /** @type {Facts['workflows']} */
  let workflows = null;
  if (Array.isArray(b.workflows)) {
    workflows = b.workflows
      .map((w) => ({ name: String(typeof w === 'string' ? w : w?.name ?? ''), text: null }))
      .filter((w) => w.name);
  } else if (root && !root.some((e) => e.type === 'tree' && e.name === '.github')) workflows = [];
  const description = str(repo.description);
  const ownerNode = isObj(repo.owner) ? repo.owner : {};
  return {
    v: 1,
    id: nonEmpty(repo.node_id) ?? `rest:${repo.id ?? nwo}`,
    nwo,
    owner,
    name,
    fetchedAt,
    source: 'rest',
    stages: ['enrich'],
    headOid: cms && cms[0] ? str(cms[0].sha) : null,
    defaultBranch: str(repo.default_branch),
    createdAt: str(repo.created_at),
    pushedAt: str(repo.pushed_at),
    description: description === null ? null : truncateUtf8(description, caps.descriptionBytes).text,
    homepageUrl: nonEmpty(repo.homepage),
    isFork: flag(repo.fork),
    isArchived: flag(repo.archived),
    isTemplate: flag(repo.is_template),
    isMirror: repo.mirror_url === undefined ? null : Boolean(repo.mirror_url),
    hasIssues: flag(repo.has_issues),
    hasDiscussions: flag(repo.has_discussions),
    stars: count(repo.stargazers_count),
    forks: count(repo.forks_count),
    watchers: count(repo.subscribers_count),
    diskKB: count(repo.size),
    licence: licenceOf(repo.license),
    primaryLanguage: str(repo.language),
    languages: langs,
    codeBytes: langs ? langs.reduce((a, l) => a + l.bytes, 0) : null,
    topics: Array.isArray(repo.topics) ? repo.topics.filter(nonEmpty) : null,
    releases: rel ? {
      count: rel.length,
      recent: rel.slice(0, 5).map((r) => ({
        tag: String(r.tag_name ?? ''), publishedAt: str(r.published_at), prerelease: flag(r.prerelease),
      })),
    } : null,
    tags: null,
    ownerInfo: {
      login: str(ownerNode.login) ?? owner,
      type: str(ownerNode.type) ?? 'Unknown',
      createdAt: null,
      publicRepos: null,
      contributionYears: null,
      sponsorsListing: null,
    },
    commits: cms ? {
      total: null,
      recent: cms.slice(0, 20).map((c) => ({
        at: str(c.commit?.committer?.date) ?? str(c.commit?.author?.date),
        headline: headline(c.commit?.message, caps.headlineChars),
        authorLogin: str(c.author?.login),
      })),
    } : null,
    rollup: null,
    root,
    workflows,
    readme: restReadme(b, caps.readmeBytes),
    packageJson: pjText === null ? null : packageJsonSummary(pjText),
    manifest: null,
    agentsMdBytes: rootSize('AGENTS.md'),
    claudeMdBytes: rootSize('CLAUDE.md'),
    tree: null,
    activity: null,
    starHistory: null,
    outsiders: null,
    funding: null,
    heavy,
  };
}
