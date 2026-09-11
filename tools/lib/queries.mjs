// @ts-check
/**
 * The fixture tools' own copy of the GraphQL documents of DESIGN §3.2 and §3.5–§3.7, kept
 * verbatim, plus the builders that assemble aliased documents from them. The recorder uses
 * this module instead of `src/github/queries.mjs` so that it runs on its own (§12.1: "uses its
 * own minimal fetch code"). `test/fixtures-format.test.mjs` checks that every recorded request
 * contains the §3 text exactly as DESIGN.md states it.
 *
 * Assembly rules (documented in test/fixtures/README.md so that WP1's builders can match them):
 * - the operation comes first and the fragment after it, so the first keyword is `query`;
 * - every document selects `rateLimit { cost remaining resetAt }` first;
 * - repositories are aliased `r0`, `r1`, … with owner and name passed as `$o<i>`/`$n<i>`;
 * - object expressions that come from repository content (README repair, file fetches) are
 *   passed as variables too (`$e<i>`, `$e<i>_<j>`), never interpolated.
 */

/** §3.2 base census query, before the `created:` window and any scope are added. */
export const BASE_QUERY =
  'fork:false archived:false template:false mirror:false stars:0..25 size:>=200';

/** §3.2 search document, verbatim. */
export const SEARCH_QUERY = `query($q: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  search(type: REPOSITORY, query: $q, first: $first, after: $after) {
    repositoryCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on Repository {
      id nameWithOwner createdAt pushedAt stargazerCount forkCount diskUsage
      isFork isArchived isTemplate isMirror description
      licenseInfo { spdxId } primaryLanguage { name } owner { login __typename }
    } }
  }
}`;

/** §3.2/§3.3 lean node fields, as they appear inside the search document. */
export const LEAN_FIELDS = `id nameWithOwner createdAt pushedAt stargazerCount forkCount diskUsage
  isFork isArchived isTemplate isMirror description
  licenseInfo { spdxId } primaryLanguage { name } owner { login __typename }`;

/** Fragment used for the §3.3 archive lookups (aliased `repository(owner:, name:)`). */
export const LEAN_FRAGMENT = `fragment Lean on Repository {
  ${LEAN_FIELDS}
}`;

/** §3.5 enrich fragment, verbatim. */
export const ENRICH_FRAGMENT = `fragment Enrich on Repository {
  id nameWithOwner description homepageUrl createdAt pushedAt diskUsage
  stargazerCount forkCount isFork isArchived isTemplate isMirror
  hasIssuesEnabled hasDiscussionsEnabled
  licenseInfo { spdxId }
  primaryLanguage { name }
  languages(first: 8, orderBy: {field: SIZE, direction: DESC}) { totalSize edges { size node { name } } }
  repositoryTopics(first: 12) { nodes { topic { name } } }
  releases(first: 5, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes { tagName publishedAt isPrerelease } }
  tags: refs(refPrefix: "refs/tags/", first: 1) { totalCount }
  watchers { totalCount }
  owner { login __typename
    ... on User { createdAt repositories { totalCount } }
    ... on Organization { createdAt repositories { totalCount } } }
  defaultBranchRef { name target { ... on Commit { oid
    history(first: 20) { totalCount nodes { committedDate messageHeadline author { user { login } } } }
    statusCheckRollup { state } } } }
  root: object(expression: "HEAD:") { ... on Tree { entries { name type } } }
  wf: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name } } }
  readme: object(expression: "HEAD:README.md") { ... on Blob { byteSize isTruncated text } }
  pkg: object(expression: "HEAD:package.json") { ... on Blob { byteSize text } }
  agents: object(expression: "HEAD:AGENTS.md") { ... on Blob { byteSize } }
  claude: object(expression: "HEAD:CLAUDE.md") { ... on Blob { byteSize } }
}`;

/** §3.6 deep fragment, verbatim. */
export const DEEP_FRAGMENT = `fragment Deep on Repository {
  fundingLinks { platform url }
  owner { ... on User { hasSponsorsListing contributionsCollection { contributionYears } }
          ... on Organization { hasSponsorsListing } }
  releases(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) { totalCount nodes { tagName publishedAt isPrerelease } }
  issues(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { createdAt author { login ... on User { createdAt } } } }
  pullRequests(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { createdAt author { login ... on User { createdAt } } } }
}`;

/** §3.7 re-check selection, verbatim. */
export const EXISTS_SELECTION =
  '... on Repository { id stargazerCount forkCount pushedAt isArchived primaryLanguage { name } }';

/** §3.7 re-check document (`nodes(ids: [...])`, 100 ids per call). */
export const EXISTS_QUERY = `query($ids: [ID!]!) {
  rateLimit { cost remaining resetAt }
  nodes(ids: $ids) { ${EXISTS_SELECTION} }
}`;

/** The rate-limit selection every document carries (§3.5). */
const RATE = '  rateLimit { cost remaining resetAt }';

/**
 * @typedef {{owner: string, name: string}} RepoRef
 * @typedef {{doc: string, variables: Record<string, unknown>}} Built
 */

/**
 * `owner/name` → `{owner, name}`.
 * @param {string} nwo
 * @returns {RepoRef}
 */
export function refOf(nwo) {
  const [owner, name] = nwo.split('/');
  return { owner, name };
}

/**
 * Aliased repository query over a fragment (§3.5 enrich, §3.6 deep, §3.3 lean lookups).
 * @param {string} fragmentName e.g. `Enrich`
 * @param {string} fragment the fragment text, starting with `fragment <name> on Repository {`
 * @param {RepoRef[]} refs
 * @returns {Built}
 */
export function aliasedRepoQuery(fragmentName, fragment, refs) {
  const decl = refs.map((_, i) => `$o${i}: String!, $n${i}: String!`).join(', ');
  const body = refs.map((_, i) => `  r${i}: repository(owner: $o${i}, name: $n${i}) { ...${fragmentName} }`);
  /** @type {Record<string, unknown>} */
  const variables = {};
  refs.forEach((r, i) => {
    variables[`o${i}`] = r.owner;
    variables[`n${i}`] = r.name;
  });
  return { doc: `query(${decl}) {\n${RATE}\n${body.join('\n')}\n}\n${fragment}\n`, variables };
}

/**
 * §3.5 README repair: fetch `HEAD:<exact name>` for up to 20 repositories.
 * @param {Array<RepoRef & {file: string}>} items
 * @returns {Built}
 */
export function readmeRepairQuery(items) {
  const decl = items.map((_, i) => `$o${i}: String!, $n${i}: String!, $e${i}: String!`).join(', ');
  const body = items.map((_, i) => `  r${i}: repository(owner: $o${i}, name: $n${i}) { `
    + `readme: object(expression: $e${i}) { ... on Blob { byteSize isTruncated text } } }`);
  /** @type {Record<string, unknown>} */
  const variables = {};
  items.forEach((it, i) => {
    variables[`o${i}`] = it.owner;
    variables[`n${i}`] = it.name;
    variables[`e${i}`] = `HEAD:${it.file}`;
  });
  return { doc: `query(${decl}) {\n${RATE}\n${body.join('\n')}\n}\n`, variables };
}

/**
 * §3.6 step 5: blobs by path, aliased `f<j>` inside each repository alias.
 * @param {Array<RepoRef & {paths: string[]}>} items
 * @returns {Built}
 */
export function filesQuery(items) {
  const decls = [];
  const body = [];
  /** @type {Record<string, unknown>} */
  const variables = {};
  items.forEach((it, i) => {
    decls.push(`$o${i}: String!, $n${i}: String!`);
    variables[`o${i}`] = it.owner;
    variables[`n${i}`] = it.name;
    const parts = it.paths.map((p, j) => {
      decls.push(`$e${i}_${j}: String!`);
      variables[`e${i}_${j}`] = `HEAD:${p}`;
      return `f${j}: object(expression: $e${i}_${j}) { ... on Blob { byteSize text } }`;
    });
    body.push(`  r${i}: repository(owner: $o${i}, name: $n${i}) { ${parts.join(' ')} }`);
  });
  return { doc: `query(${decls.join(', ')}) {\n${RATE}\n${body.join('\n')}\n}\n`, variables };
}

/**
 * §3.2 crafted cursor for offset `n` (`base64("cursor:" + n)`).
 * @param {number} n
 * @returns {string}
 */
export function cursor(n) {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}

/**
 * §3.2 search string for a created window, with optional scope and star split.
 * @param {string} fromIso `YYYY-MM-DDTHH:MM:SSZ`
 * @param {string} toIso inclusive
 * @param {{scope?: string, stars?: string}} [opts]
 * @returns {string}
 */
export function searchString(fromIso, toIso, opts = {}) {
  const base = opts.stars ? BASE_QUERY.replace('stars:0..25', `stars:${opts.stars}`) : BASE_QUERY;
  const scope = opts.scope ? ` ${opts.scope}` : '';
  return `${base} created:${fromIso}..${toIso}${scope} sort:stars-asc`;
}
