// @ts-check
/**
 * The GraphQL documents of DESIGN §3.2 and §3.5–§3.7, verbatim, and the builders that assemble the
 * aliased documents Unsung sends (§12.2). Owner, name and every object expression that comes from
 * repository content travel as variables; nothing a repository controls is ever interpolated.
 *
 * Assembly (identical to the recorded fixture requests, test/fixtures/README.md "Query assembly"):
 * the operation comes first (so the read-only guard sees `query`), it selects
 * `rateLimit { cost remaining resetAt }` first, repositories are aliased `r0`, `r1`, … with
 * `$o<i>`/`$n<i>`, and a fragment, when there is one, follows the operation and a final newline.
 *
 * Long lines of the §3 text are joined from pieces so that no source line exceeds 110 characters;
 * the strings themselves are exactly the design's text (test/github-queries.test.mjs checks both the
 * DESIGN.md blocks and the recorded requests).
 */

/** §3.2 base census query, before the `created:` window, any scope and the sort are added. */
export const BASE_QUERY = 'fork:false archived:false template:false mirror:false stars:0..25 size:>=200';

/** The rate-limit selection every document carries (§3.5). */
export const RATE_LIMIT_SELECTION = 'rateLimit { cost remaining resetAt }';

/** §3.2 search document, verbatim (`$after` is omitted from the variables on the probe). */
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

/**
 * §3.2/§3.3 lean node fields: the census node selection, used for the archive and ID-walk lookups.
 * Continuation lines are indented as they appear inside `LEAN_FRAGMENT`.
 */
export const LEAN_FIELDS = `id nameWithOwner createdAt pushedAt stargazerCount forkCount diskUsage
  isFork isArchived isTemplate isMirror description
  licenseInfo { spdxId } primaryLanguage { name } owner { login __typename }`;

/** Fragment wrapping the lean fields for aliased `repository(owner:, name:)` lookups (§3.3). */
export const LEAN_FRAGMENT = `fragment Lean on Repository {
  ${LEAN_FIELDS}
}`;

/** §3.5 enrich fragment, verbatim. */
export const ENRICH_FRAGMENT = [
  'fragment Enrich on Repository {',
  '  id nameWithOwner description homepageUrl createdAt pushedAt diskUsage',
  '  stargazerCount forkCount isFork isArchived isTemplate isMirror',
  '  hasIssuesEnabled hasDiscussionsEnabled',
  '  licenseInfo { spdxId }',
  '  primaryLanguage { name }',
  '  languages(first: 8, orderBy: {field: SIZE, direction: DESC}) '
    + '{ totalSize edges { size node { name } } }',
  '  repositoryTopics(first: 12) { nodes { topic { name } } }',
  '  releases(first: 5, orderBy: {field: CREATED_AT, direction: DESC}) '
    + '{ totalCount nodes { tagName publishedAt isPrerelease } }',
  '  tags: refs(refPrefix: "refs/tags/", first: 1) { totalCount }',
  '  watchers { totalCount }',
  '  owner { login __typename',
  '    ... on User { createdAt repositories { totalCount } }',
  '    ... on Organization { createdAt repositories { totalCount } } }',
  '  defaultBranchRef { name target { ... on Commit { oid',
  '    history(first: 20) { totalCount nodes { committedDate messageHeadline '
    + 'author { user { login } } } }',
  '    statusCheckRollup { state } } } }',
  '  root: object(expression: "HEAD:") { ... on Tree { entries { name type } } }',
  '  wf: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { name } } }',
  '  readme: object(expression: "HEAD:README.md") { ... on Blob { byteSize isTruncated text } }',
  '  pkg: object(expression: "HEAD:package.json") { ... on Blob { byteSize text } }',
  '  agents: object(expression: "HEAD:AGENTS.md") { ... on Blob { byteSize } }',
  '  claude: object(expression: "HEAD:CLAUDE.md") { ... on Blob { byteSize } }',
  '}',
].join('\n');

/** §3.6 deep fragment, verbatim. */
export const DEEP_FRAGMENT = [
  'fragment Deep on Repository {',
  '  fundingLinks { platform url }',
  '  owner { ... on User { hasSponsorsListing contributionsCollection { contributionYears } }',
  '          ... on Organization { hasSponsorsListing } }',
  '  releases(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) '
    + '{ totalCount nodes { tagName publishedAt isPrerelease } }',
  '  issues(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) '
    + '{ nodes { createdAt author { login ... on User { createdAt } } } }',
  '  pullRequests(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) '
    + '{ nodes { createdAt author { login ... on User { createdAt } } } }',
  '}',
].join('\n');

/** §3.7 re-check selection, verbatim. */
export const EXISTS_SELECTION =
  '... on Repository { id stargazerCount forkCount pushedAt isArchived primaryLanguage { name } }';

/** §3.7 re-check document (`nodes(ids: [...])`, up to 100 ids per call). */
export const EXISTS_QUERY = `query($ids: [ID!]!) {
  ${RATE_LIMIT_SELECTION}
  nodes(ids: $ids) { ${EXISTS_SELECTION} }
}`;

/** Most aliases or ids one document may carry (GitHub's `nodes(ids:)` limit and ours). */
export const MAX_PER_QUERY = 100;

/** README repair batches are smaller (§3.5). */
export const MAX_README_REPAIR = 20;

const RATE = `  ${RATE_LIMIT_SELECTION}`;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * @typedef {{owner: string, name: string}} RepoRef
 * @typedef {{doc: string, variables: Record<string, unknown>}} Built
 */

/**
 * `owner/name`, `{owner, name}` or `{nwo}` → `{owner, name}`. Throws a TypeError for anything else.
 * @param {string | {owner?: string, name?: string, nwo?: string}} ref
 * @returns {RepoRef}
 */
export function refOf(ref) {
  let owner;
  let name;
  if (typeof ref === 'string' || (ref && typeof ref === 'object' && typeof ref.nwo === 'string'
    && (typeof ref.owner !== 'string' || typeof ref.name !== 'string'))) {
    const nwo = typeof ref === 'string' ? ref : /** @type {string} */ (ref.nwo);
    const i = nwo.indexOf('/');
    owner = i > 0 ? nwo.slice(0, i) : '';
    name = i > 0 ? nwo.slice(i + 1) : '';
  } else if (ref && typeof ref === 'object') {
    owner = ref.owner;
    name = ref.name;
  }
  if (typeof owner !== 'string' || typeof name !== 'string' || !owner || !name || name.includes('/')) {
    throw new TypeError('A repository reference needs an owner and a name (owner/name)');
  }
  return { owner, name };
}

/**
 * @param {unknown[]} list
 * @param {number} max
 * @param {string} what
 */
function checkCount(list, max, what) {
  if (!Array.isArray(list) || list.length === 0) throw new RangeError(`${what} needs at least one item`);
  if (list.length > max) throw new RangeError(`${what} takes at most ${max} items, got ${list.length}`);
}

/**
 * Aliased repository query over a fragment: §3.5 enrich (`Enrich`), §3.6 deep (`Deep`) and the
 * §3.3 lean lookups (`Lean`). Alias `r<i>` answers for `refs[i]`.
 * @param {string} fragmentName e.g. `Enrich`
 * @param {string} fragment the fragment text, starting `fragment <fragmentName> on Repository {`
 * @param {Array<string | {owner?: string, name?: string, nwo?: string}>} refs
 * @returns {Built}
 */
export function aliasedRepoQuery(fragmentName, fragment, refs) {
  if (!IDENTIFIER.test(String(fragmentName))) throw new TypeError('A fragment name must be a GraphQL name');
  if (typeof fragment !== 'string' || !fragment.startsWith(`fragment ${fragmentName} on Repository {`)) {
    throw new TypeError(`The fragment must start with 'fragment ${fragmentName} on Repository {'`);
  }
  checkCount(refs, MAX_PER_QUERY, 'An aliased repository query');
  const list = refs.map(refOf);
  const decl = list.map((_, i) => `$o${i}: String!, $n${i}: String!`).join(', ');
  const body = list.map((_, i) => `  r${i}: repository(owner: $o${i}, name: $n${i}) { ...${fragmentName} }`);
  /** @type {Record<string, unknown>} */
  const variables = {};
  list.forEach((r, i) => {
    variables[`o${i}`] = r.owner;
    variables[`n${i}`] = r.name;
  });
  return { doc: `query(${decl}) {\n${RATE}\n${body.join('\n')}\n}\n${fragment}\n`, variables };
}

/**
 * A repository path (a README's exact root name, a workflow or manifest path), checked before it
 * becomes the value of an object-expression variable: relative, at most 1 KB, no control characters.
 * @param {unknown} file
 * @returns {string}
 */
function checkPath(file) {
  const s = String(file ?? '');
  if (!s || s.length > 1024 || /[\x00-\x1f\x7f]/.test(s) || s.startsWith('/')) {
    throw new TypeError('A file path must be a non-empty relative path without control characters');
  }
  return s;
}

/**
 * §3.5 README repair: fetch `HEAD:<exact name>` for up to 20 repositories. The expression is a
 * variable (`$e<i>`), never interpolated. Alias `r<i>.readme` answers for `items[i]`.
 * @param {Array<(RepoRef | {nwo: string}) & {file: string}>} items
 * @returns {Built}
 */
export function readmeRepairQuery(items) {
  checkCount(items, MAX_README_REPAIR, 'A README repair query');
  const list = items.map((it) => ({ ...refOf(it), file: checkPath(it.file) }));
  const decl = list.map((_, i) => `$o${i}: String!, $n${i}: String!, $e${i}: String!`).join(', ');
  const body = list.map((_, i) => `  r${i}: repository(owner: $o${i}, name: $n${i}) { `
    + `readme: object(expression: $e${i}) { ... on Blob { byteSize isTruncated text } } }`);
  /** @type {Record<string, unknown>} */
  const variables = {};
  list.forEach((it, i) => {
    variables[`o${i}`] = it.owner;
    variables[`n${i}`] = it.name;
    variables[`e${i}`] = `HEAD:${it.file}`;
  });
  return { doc: `query(${decl}) {\n${RATE}\n${body.join('\n')}\n}\n`, variables };
}

/**
 * §3.6 step 5: blobs by path. Alias `r<i>.f<j>` answers for `items[i].paths[j]`; expressions are
 * variables (`$e<i>_<j>`).
 * @param {Array<(RepoRef | {nwo: string}) & {paths: string[]}>} items
 * @returns {Built}
 */
export function filesQuery(items) {
  checkCount(items, MAX_PER_QUERY, 'A files query');
  /** @type {string[]} */
  const decls = [];
  /** @type {string[]} */
  const body = [];
  /** @type {Record<string, unknown>} */
  const variables = {};
  items.forEach((it, i) => {
    const { owner, name } = refOf(it);
    const paths = Array.isArray(it.paths) ? it.paths.map(checkPath) : [];
    if (paths.length === 0) throw new RangeError(`Files query item ${i} has no paths`);
    decls.push(`$o${i}: String!, $n${i}: String!`);
    variables[`o${i}`] = owner;
    variables[`n${i}`] = name;
    const parts = paths.map((p, j) => {
      decls.push(`$e${i}_${j}: String!`);
      variables[`e${i}_${j}`] = `HEAD:${p}`;
      return `f${j}: object(expression: $e${i}_${j}) { ... on Blob { byteSize text } }`;
    });
    body.push(`  r${i}: repository(owner: $o${i}, name: $n${i}) { ${parts.join(' ')} }`);
  });
  return { doc: `query(${decls.join(', ')}) {\n${RATE}\n${body.join('\n')}\n}\n`, variables };
}

/**
 * §3.7 re-check of up to 100 node ids. `data.nodes[i]` answers for `ids[i]` (`null` = gone).
 * @param {string[]} ids
 * @returns {Built}
 */
export function existsQuery(ids) {
  checkCount(ids, MAX_PER_QUERY, 'A re-check query');
  if (!ids.every((id) => typeof id === 'string' && id.length > 0)) {
    throw new TypeError('Re-check ids must be non-empty strings');
  }
  return { doc: EXISTS_QUERY, variables: { ids: [...ids] } };
}

/**
 * The alias values of an aliased response, in `refs` order (`null` for a missing alias).
 * @param {{data?: any}} result
 * @param {number} n
 * @returns {any[]}
 */
export function aliasValues(result, n) {
  const data = result?.data ?? {};
  return Array.from({ length: n }, (_, i) => data[`r${i}`] ?? null);
}
