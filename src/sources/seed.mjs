// @ts-check
/**
 * Candidate seeds (DESIGN §4.3 CandidateSeed): what every discovery source yields, built from a lean
 * search node or any richer repository node, and the base-query check on live values (§3.2, §3.3).
 */

import { truncateUtf8 } from '../core/util.mjs';

/** Smallest repository kept by the base query (`size:>=200`, in KB). */
export const MIN_DISK_KB = 200;

/** Default `maxStars` (§9.3). */
export const DEFAULT_MAX_STARS = 25;

/** Description cap (§4.1 text caps). */
export const DESCRIPTION_BYTES = 1024;

/** @typedef {import('../core/schema.mjs').CandidateSeed} CandidateSeed */

/**
 * @param {unknown} v
 * @returns {number}
 */
function count(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

/**
 * A CandidateSeed from a GraphQL repository node (the §3.2 lean fields or the §3.5 enrich shape).
 * @param {any} node
 * @param {string} source `census:<day>`, `archive:<YYYY-MM-DD-H>:<Release|Public>`, `add` or `sample`
 * @returns {CandidateSeed}
 */
export function seedFromNode(node, source) {
  if (!node || typeof node !== 'object') throw new TypeError('seedFromNode needs a repository node');
  const nwo = node.nameWithOwner;
  if (typeof node.id !== 'string' || typeof nwo !== 'string' || !nwo.includes('/')) {
    throw new TypeError('A repository node needs an id and a nameWithOwner');
  }
  if (typeof node.createdAt !== 'string') throw new TypeError('A repository node needs createdAt');
  if (typeof source !== 'string' || source === '') throw new TypeError('A seed needs a source');
  const description = typeof node.description === 'string'
    ? truncateUtf8(node.description, DESCRIPTION_BYTES).text
    : null;
  const lic = node.licenseInfo && typeof node.licenseInfo === 'object'
    ? (typeof node.licenseInfo.spdxId === 'string' ? node.licenseInfo.spdxId : 'NOASSERTION')
    : null;
  const lang = node.primaryLanguage?.name;
  const ownerType = node.owner?.__typename;
  return {
    id: node.id,
    nwo: node.nameWithOwner,
    createdAt: node.createdAt,
    pushedAt: typeof node.pushedAt === 'string' ? node.pushedAt : null,
    stars: count(node.stargazerCount),
    forks: count(node.forkCount),
    diskKB: count(node.diskUsage),
    lang: typeof lang === 'string' && lang ? lang : null,
    licence: lic,
    hasDesc: Boolean(description && description.trim()),
    description,
    ownerType: typeof ownerType === 'string' ? ownerType : null,
    isFork: Boolean(node.isFork),
    isArchived: Boolean(node.isArchived),
    isTemplate: Boolean(node.isTemplate),
    isMirror: Boolean(node.isMirror),
    source,
  };
}

/**
 * Whether a seed's live values pass the base-query filters: not a fork, archive, template or mirror;
 * at most `maxStars` stars; at least 200 KB.
 * @param {CandidateSeed} seed
 * @param {{maxStars?: number, minKB?: number}} [opts]
 * @returns {boolean}
 */
export function passesBase(seed, { maxStars = DEFAULT_MAX_STARS, minKB = MIN_DISK_KB } = {}) {
  if (!seed || typeof seed !== 'object') return false;
  if (seed.isFork || seed.isArchived || seed.isTemplate || seed.isMirror) return false;
  if (!(seed.stars >= 0 && seed.stars <= maxStars)) return false;
  return seed.diskKB >= minKB;
}
