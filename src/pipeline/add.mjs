// @ts-check
/**
 * `addRepo` (DESIGN §9.1 `unsung add`, §10.1 `POST /api/add`): enrich, deepen and score one named
 * repository now, whatever its lane, and keep its record. It does not take the run lock; the
 * server refuses the request while a run holds it, and `unsung add` takes the lock itself.
 */

import { candidateFromFacts } from './candidates.mjs';
import { deepen } from './deep.mjs';
import { loadDeps } from './deps.mjs';
import { parseAliases, readmeToRepair, settleNode } from './enrich.mjs';
import { PipelineError, SILENT_LOG, isNotFound, isoNow, splitNwo } from './util.mjs';

/** @typedef {import('../core/schema.mjs').RepoRecord} RepoRecord */
/** @typedef {import('./deps.mjs').Lib} Lib */

/**
 * @param {Lib} lib
 * @param {any} facts
 * @returns {number}
 */
function priorOfFacts(lib, facts) {
  try {
    const p = lib.priorOf({
      id: facts.id, nwo: facts.nwo, createdAt: facts.createdAt, pushedAt: facts.pushedAt,
      stars: facts.stars ?? 0, forks: facts.forks ?? 0, diskKB: facts.diskKB ?? 0,
      lang: facts.primaryLanguage ?? null, licence: facts.licence ?? null,
      hasDesc: Boolean(facts.description), description: facts.description ?? null,
      ownerType: facts.ownerInfo?.type ?? null, isFork: Boolean(facts.isFork),
      isArchived: Boolean(facts.isArchived), isTemplate: Boolean(facts.isTemplate),
      isMirror: Boolean(facts.isMirror), source: 'add',
    });
    return Number.isFinite(p) ? p : 0;
  } catch {
    return 0;
  }
}

/**
 * Enrich, deepen (unless `deep` is false) and score a repository, and keep its record.
 * @param {string} nwo `owner/name`
 * @param {object} opts
 * @param {any} opts.client the GitHub client
 * @param {any} opts.store
 * @param {import('../config.mjs').Config} opts.config
 * @param {(() => string) | string} [opts.now]
 * @param {boolean} [opts.deep] default true
 * @param {Lib} [opts.deps] injected functions (default: the real modules)
 * @param {import('../log.mjs').Log} [opts.log]
 * @param {AbortSignal} [opts.signal] Ctrl-C: stops new requests and ends any rate-limit wait
 * @returns {Promise<RepoRecord>} the stored record (a repository caught by a drop gate is scored
 *   and returned but not stored)
 */
export async function addRepo(nwo, {
  client, store, config, now, deep = true, deps, log = SILENT_LOG, signal,
}) {
  const { owner, name } = splitNwo(nwo);
  const lib = deps ?? await loadDeps();
  const at = isoNow(now);

  /** @type {any} */
  let node = null;
  let heavy = false;
  try {
    const { doc, variables } = lib.aliasedRepoQuery('Enrich', lib.ENRICH_FRAGMENT, [{ owner, name }]);
    node = parseAliases(await client.graphql(doc, variables, { kind: 'graphql', signal }), [0])[0];
  } catch (err) {
    if (/** @type {{name?: string}} */ (err)?.name !== 'HeavyQueryError') throw err;
    heavy = true;
    try {
      node = await lib.restFallback(client, `${owner}/${name}`, { signal });
    } catch (e) {
      if (!isNotFound(e)) throw e;
      node = null;
    }
  }
  if (!node) {
    const why = 'it may be private, renamed or deleted';
    throw new PipelineError(`${owner}/${name} was not found on GitHub (${why})`, 'ENOTFOUND', 1);
  }

  /** @type {any} */
  let readmeRepair = null;
  const file = heavy ? null : readmeToRepair(node);
  if (file) {
    const { doc, variables } = lib.readmeRepairQuery([{ owner, name, file, path: file }]);
    const blob = (await client.graphql(doc, variables, { kind: 'graphql', signal }))?.data?.r0?.readme ?? null;
    if (blob) {
      readmeRepair = { ...blob, name: file };
      node = { ...node, readme: readmeRepair };
    }
  }

  const facts = lib.factsFromEnrich(node, { fetchedAt: at, readmeRepair });
  const id = facts?.id ?? node.id;
  const known = id ? await store.getCandidate(id) : null;
  const candidate = known
    ? { ...known, sources: known.sources.includes('add') ? known.sources : [...known.sources, 'add'] }
    : candidateFromFacts({ ...facts, id }, { source: 'add', now: at, prior: priorOfFacts(lib, facts) });
  await store.putCandidates([candidate]);

  const env = { client, store, config, lib, now, log, keepAll: true, signal };
  const settled = await settleNode(node, candidate, env, { heavy, readmeRepair });
  let record = /** @type {RepoRecord} */ (settled.record);
  if (deep && !settled.dropped) {
    for await (const r of deepen([record], { ...env, batch: config.defaults.batch.deep })) record = r;
  }
  log.debug('Added a repository', { nwo: record.nwo, lane: record.score?.lane ?? null });
  return record;
}
