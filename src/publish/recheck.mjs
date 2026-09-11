// @ts-check
/**
 * The live re-check that every pick passes just before it is exported (DESIGN §7.6, §11.2, §3.7):
 * does the repository still exist and is it still public, what is it called now, how many stars
 * does it have, and which releases has it shipped (for the digest's "four weeks on"). One read-only
 * GraphQL query per 100 repositories.
 */

/** @typedef {import('../cli/context.mjs').Client} Client */

/** The re-check document: §3.7's fields plus the name, owner, visibility and recent releases. */
export const RECHECK_QUERY = `query($ids: [ID!]!) {
  rateLimit { cost remaining resetAt }
  nodes(ids: $ids) {
    ... on Repository {
      id nameWithOwner stargazerCount forkCount pushedAt isArchived isPrivate
      owner { login }
      releases(first: 10, orderBy: {field: CREATED_AT, direction: DESC}) {
        totalCount nodes { tagName publishedAt isPrerelease }
      }
    }
  }
}`;

/** Repositories per re-check query. */
export const RECHECK_BATCH = 100;

/** @typedef {{tag: string, publishedAt: string | null, prerelease: boolean}} LiveRelease */

/**
 * What the re-check learnt about one repository.
 * @typedef {object} LiveRepo
 * @property {string} id
 * @property {string} nwo current `owner/name`
 * @property {string} owner current owner login
 * @property {number | null} stars
 * @property {number | null} forks
 * @property {string | null} pushedAt
 * @property {boolean} archived
 * @property {{count: number, recent: LiveRelease[]} | null} releases newest first
 */

/** The re-check could not be completed; nothing should be exported on its strength. */
export class RecheckError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'RecheckError';
    this.code = 'ERECHECK';
  }
}

/**
 * @param {any} node
 * @returns {LiveRepo | null}
 */
function liveFrom(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.id !== 'string' || typeof node.nameWithOwner !== 'string') return null;
  if (node.isPrivate === true) return null;
  const rel = node.releases && typeof node.releases === 'object' ? node.releases : null;
  return {
    id: node.id,
    nwo: node.nameWithOwner,
    owner: typeof node.owner?.login === 'string' ? node.owner.login : node.nameWithOwner.split('/')[0],
    stars: typeof node.stargazerCount === 'number' ? node.stargazerCount : null,
    forks: typeof node.forkCount === 'number' ? node.forkCount : null,
    pushedAt: typeof node.pushedAt === 'string' ? node.pushedAt : null,
    archived: node.isArchived === true,
    releases: rel
      ? {
        count: typeof rel.totalCount === 'number' ? rel.totalCount : 0,
        recent: (Array.isArray(rel.nodes) ? rel.nodes : []).filter((r) => r && typeof r.tagName === 'string')
          .map((r) => ({
            tag: String(r.tagName),
            publishedAt: typeof r.publishedAt === 'string' ? r.publishedAt : null,
            prerelease: r.isPrerelease === true,
          })),
      }
      : null,
  };
}

/**
 * @param {any} res
 * @returns {string}
 */
function errorSummary(res) {
  const errors = Array.isArray(res?.errors) ? res.errors : [];
  const text = errors.map((e) => String(e?.type ?? e?.message ?? 'error')).slice(0, 3).join(', ');
  return text || 'no data in the response';
}

/**
 * Re-check repositories by node id. Resolves to a map from each id to what GitHub says now, or to
 * `null` when the repository is gone, private, or no longer a repository. Throws `RecheckError`
 * when a response carries no data at all, and lets client errors (rate limits, authentication)
 * through, so a failed re-check never looks like "every pick vanished".
 * @param {Client} client `graphql(doc, variables) → Promise<{data, errors}>`
 * @param {string[]} ids
 * @param {{batch?: number, signal?: AbortSignal}} [opts]
 * @returns {Promise<Map<string, LiveRepo | null>>}
 */
export async function recheckRepos(client, ids, { batch = RECHECK_BATCH, signal } = {}) {
  const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id !== ''))];
  /** @type {Map<string, LiveRepo | null>} */
  const out = new Map();
  if (unique.length === 0) return out;
  if (!client || typeof client.graphql !== 'function') {
    throw new RecheckError('A GitHub client is needed to re-check picks before they are published');
  }
  const size = Math.max(1, Math.min(RECHECK_BATCH, Math.floor(batch)));
  for (let i = 0; i < unique.length; i += size) {
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    const chunk = unique.slice(i, i + size);
    const res = await client.graphql(RECHECK_QUERY, { ids: chunk });
    const nodes = res?.data?.nodes;
    if (!Array.isArray(nodes)) throw new RecheckError(`The live re-check failed: ${errorSummary(res)}`);
    chunk.forEach((id, k) => {
      const live = liveFrom(nodes[k]);
      out.set(id, live && live.id === id ? live : live ? { ...live, id } : null);
    });
  }
  return out;
}
