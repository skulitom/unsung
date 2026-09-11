// @ts-check
/**
 * The review run of `unsung review` (DESIGN §8.1–§8.6): choose the repositories the heuristics are
 * least sure about, fetch their pack files (one GraphQL query per repository, cached by head
 * commit), build each pack, call the backend one repository at a time within the dollar cap,
 * validate the answer, append a Verdict, and attach valid verdicts to their records.
 *
 * Quarantined repositories are never sent. A repository with `g.injection` is never sent either;
 * it gets a `skipped-injection` verdict. A refusal is recorded and never retried.
 */

import { randomBytes } from 'node:crypto';
import { sampleN, truncateUtf8 } from '../core/util.mjs';
import { verdictEffect, verdictKey } from '../core/verdict.mjs';
import { createBackend } from './backends.mjs';
import { buildPack, choosePackPaths, FILE_FETCH_BYTES } from './pack.mjs';
import { RUBRIC_VERSION } from './rubric.mjs';
import { validateVerdict } from './validate.mjs';

/** @typedef {import('../core/schema.mjs').Index} Index */
/** @typedef {import('../core/schema.mjs').RepoRecord} RepoRecord */
/** @typedef {import('../core/schema.mjs').Verdict} Verdict */
/** @typedef {import('./backends.mjs').Backend} Backend */
/** @typedef {import('./backends.mjs').RawResult} RawResult */
/** @typedef {import('../log.mjs').Log} Log */
/** @typedef {any} Store the `Store` interface of §12.3 */
/** @typedef {any} Client the read-only GitHub client of §12.2 */

/**
 * @typedef {object} IndexEntryLike
 * @property {string} id
 * @property {string} nwo
 * @property {string} lane
 * @property {number} [S]
 * @property {number} [k]
 * @property {number} [gem]
 * @property {string | null} [headOid]
 * @property {(string | {id: string})[]} [gates]
 */

/** Lanes eligible for review (§8.1). */
export const REVIEW_LANES = Object.freeze(['promising', 'proven', 'look']);

/** Eligible repositories have at least this many points (§8.1). */
export const MIN_REVIEW_S = 6;

/** Budget estimate for the first call of a run, in dollars (§8.6). */
export const FIRST_CALL_ESTIMATE_USD = 0.15;

/** Verdict statuses that are final for their cache key; an `error` verdict is retried next run. */
export const FINAL_STATUSES = Object.freeze(['ok', 'unsupported', 'refused', 'skipped-injection']);

/** The run stops after this many backend errors in a row. */
export const MAX_CONSECUTIVE_ERRORS = 3;

/** @type {Log} */
const SILENT = {
  level: 'silent', enabled: () => false, debug() {}, info() {}, warn() {}, error() {}, stage() {},
};

/** @returns {number} a float in [0, 1) from the operating system's random source */
function secureRand() {
  return randomBytes(4).readUInt32BE(0) / 4294967296;
}

/**
 * @param {IndexEntryLike} e
 * @returns {string[]}
 */
function gateIds(e) {
  return (e?.gates ?? []).map((g) => (typeof g === 'string' ? g : g?.id))
    .filter((x) => typeof x === 'string');
}

/**
 * Eligible for the ordered selection (§8.1): lane promising, proven or look with `S ≥ 6`, not
 * quarantined, no `g.injection`.
 * @param {IndexEntryLike} e
 * @returns {boolean}
 */
export function isEligible(e) {
  return Boolean(e) && REVIEW_LANES.includes(e.lane) && typeof e.S === 'number' && e.S >= MIN_REVIEW_S
    && !gateIds(e).includes('g.injection');
}

/**
 * The uncertain band (§8.1): `6 ≤ S ≤ 8` and `K < 0.5`.
 * @param {IndexEntryLike} e
 * @returns {boolean}
 */
export function isUncertain(e) {
  const k = typeof e.k === 'number' ? e.k : 0;
  return typeof e.S === 'number' && e.S >= MIN_REVIEW_S && e.S <= 8 && k < 0.5;
}

/**
 * @param {IndexEntryLike} a
 * @param {IndexEntryLike} b
 * @returns {number}
 */
function byGem(a, b) {
  const d = (b.gem ?? 0) - (a.gem ?? 0);
  if (d !== 0) return d;
  return a.nwo < b.nwo ? -1 : a.nwo > b.nwo ? 1 : 0;
}

/**
 * The review selection split into the ordered picks and the random audit picks (§8.1). Entries
 * whose id is in `exclude` (already reviewed) are left out.
 * @param {Pick<Index, 'entries'> | null | undefined} index
 * @param {{top?: number, rand?: () => number, exclude?: Iterable<string>}} [opts]
 * @returns {{main: IndexEntryLike[], audit: IndexEntryLike[]}}
 */
export function selectionPlan(index, { top = 20, rand = secureRand, exclude } = {}) {
  const skip = new Set(exclude ?? []);
  const entries = /** @type {IndexEntryLike[]} */ (index?.entries ?? []).filter((e) => e && !skip.has(e.id));
  const eligible = entries.filter(isEligible);
  const n = Math.max(0, Math.floor(top));
  const main = [
    ...eligible.filter(isUncertain).sort(byGem),
    ...eligible.filter((e) => !isUncertain(e)).sort(byGem),
  ].slice(0, n);
  const chosen = new Set(main.map((e) => e.id));
  const pool = entries
    .filter((e) => e.lane === 'look' && !chosen.has(e.id) && !gateIds(e).includes('g.injection'))
    .sort(byGem);
  const audit = n > 0 ? sampleN(pool, Math.ceil(0.1 * n), rand) : [];
  return { main, audit };
}

/**
 * Repositories to review, in order (§8.1): the uncertain band (`6 ≤ S ≤ 8`, `K < 0.5`) by `gem`,
 * then the other eligible ones by `gem`, `top` in all, followed by `ceil(0.1 × top)` random audit
 * picks from the `look` lane.
 * @param {Pick<Index, 'entries'> | null | undefined} index
 * @param {{top?: number, rand?: () => number, exclude?: Iterable<string>}} [opts]
 * @returns {IndexEntryLike[]}
 */
export function selectForReview(index, opts = {}) {
  const { main, audit } = selectionPlan(index, opts);
  return [...main, ...audit];
}

/**
 * The GraphQL document for one repository's pack files, assembled as `test/fixtures/README.md`
 * documents (object expressions passed as variables, never interpolated).
 * @param {string} owner
 * @param {string} name
 * @param {string[]} expressions `<oid>:<path>` or `HEAD:<path>`
 * @returns {{doc: string, variables: Record<string, string>}}
 */
export function packFilesQuery(owner, name, expressions) {
  const decls = ['$o0: String!, $n0: String!', ...expressions.map((_, j) => `$e0_${j}: String!`)];
  const parts = expressions
    .map((_, j) => `f${j}: object(expression: $e0_${j}) { ... on Blob { byteSize text } }`);
  /** @type {Record<string, string>} */
  const variables = { o0: owner, n0: name };
  expressions.forEach((e, j) => {
    variables[`e0_${j}`] = e;
  });
  const doc = `query(${decls.join(', ')}) {\n  rateLimit { cost remaining resetAt }\n`
    + `  r0: repository(owner: $o0, name: $n0) { ${parts.join(' ')} }\n}\n`;
  return { doc, variables };
}

/**
 * A repository path fit to become an object-expression variable: relative, at most 1 KB, no
 * control characters, no `..` segment.
 * @param {string} p
 * @returns {boolean}
 */
function isSafePath(p) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || Buffer.byteLength(p) > 1024) return false;
  for (const ch of p) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    if (cp < 0x20 || cp === 0x7f) return false;
  }
  return !p.split('/').includes('..');
}

/**
 * The files a record's pack needs: from `data/cache/files/` when cached for its head commit, else
 * one GraphQL query (§8.2), each text capped at 16 KB and then cached. Resolves to null when the
 * repository no longer exists.
 * @param {RepoRecord} record
 * @param {{client?: Client | null, store?: Store}} deps
 * @returns {Promise<Record<string, import('./pack.mjs').FetchedFile> | null>}
 */
export async function fetchPackFiles(record, { client, store }) {
  const paths = choosePackPaths(record).filter(isSafePath);
  if (paths.length === 0) return {};
  const oid = record.facts?.headOid ?? null;
  if (oid && typeof store?.getFiles === 'function') {
    const cached = await store.getFiles(record.id, oid);
    if (cached && typeof cached === 'object' && paths.every((p) => Object.hasOwn(cached, p))) return cached;
  }
  if (!client || typeof client.graphql !== 'function') {
    throw Object.assign(new Error('The pack files are not cached and no GitHub client is available'),
      { code: 'ENOCLIENT' });
  }
  const [nwoOwner, nwoName] = String(record.nwo).split('/');
  const owner = record.facts?.owner ?? nwoOwner;
  const name = record.facts?.name ?? nwoName;
  const { doc, variables } = packFilesQuery(owner, name, paths.map((p) => `${oid ?? 'HEAD'}:${p}`));
  const res = await client.graphql(doc, variables, { kind: 'files' });
  const repo = res?.data?.r0;
  if (!repo) return null;
  /** @type {Record<string, import('./pack.mjs').FetchedFile>} */
  const files = {};
  paths.forEach((p, j) => {
    const blob = repo[`f${j}`];
    if (!blob || typeof blob.text !== 'string') {
      files[p] = null;
      return;
    }
    const { text, truncated } = truncateUtf8(blob.text, FILE_FETCH_BYTES);
    files[p] = { byteSize: typeof blob.byteSize === 'number' ? blob.byteSize : null, text, truncated };
  });
  if (oid && typeof store?.putFiles === 'function') await store.putFiles(record.id, oid, files);
  return files;
}

/**
 * @param {Store} store
 * @param {{id?: string, nwo?: string}} ref
 * @returns {Promise<RepoRecord | null>}
 */
async function findRecord(store, ref) {
  if (ref.id && typeof store.getRepoById === 'function') {
    const byId = await store.getRepoById(ref.id);
    if (byId) return byId;
  }
  if (ref.nwo) {
    const byName = await store.getRepo(ref.nwo);
    if (byName) return byName;
    const index = typeof store.readIndex === 'function' ? await store.readIndex() : null;
    const want = ref.nwo.toLowerCase();
    const hit = (index?.entries ?? []).find((/** @type {any} */ e) => String(e?.nwo).toLowerCase() === want);
    if (hit && hit.nwo !== ref.nwo) return findRecord(store, { id: hit.id, nwo: hit.nwo });
  }
  return null;
}

/**
 * @param {number} x
 * @returns {number}
 */
function round6(x) {
  return Math.round((Number(x) || 0) * 1e6) / 1e6;
}

/** GitHub errors that end the review run instead of skipping one repository. */
const FATAL_GITHUB = new Set(['AuthError', 'TokenError', 'NotAvailableError']);

/**
 * @typedef {object} ReviewResult
 * @property {string} nwo
 * @property {Verdict['status']} status
 * @property {number} points
 * @property {'doubted' | null} lane
 * @property {number} costUsd
 * @property {boolean} audit
 */

/**
 * @typedef {object} ReviewSummary
 * @property {number} reviewed backend calls that produced a verdict
 * @property {number} skipped repositories passed over (cached, quarantined, injection, missing files…)
 * @property {number} spentUsd
 * @property {number} maxUsd
 * @property {string} backend
 * @property {string | null} model
 * @property {Record<string, number>} counts verdicts by status
 * @property {Record<string, number>} skippedFor skips by reason
 * @property {ReviewResult[]} results
 * @property {number} audit audit picks in the selection
 * @property {null | 'budget' | 'rate-limit' | 'auth' | 'unknown-model' | 'backend' | 'errors' | 'interrupted'
 *   | 'no-index' | 'not-found' | 'disabled' | 'github-rate-limit'} stopReason why the run ended early
 * @property {number} remaining selected repositories left unreviewed when the run stopped
 * @property {string} [error] the message behind an `auth`, `unknown-model` or `backend` stop
 */

/**
 * Run a review (§8). `backend` is a backend name (created with `createBackend`) or a `Backend`.
 * `rescore(record, verdict)` may return the record rescored with the verdict (the CLI passes WP2's
 * `applyScore`); without it the verdict is attached as it is.
 * @param {object} o
 * @param {Store} o.store
 * @param {Client | null} [o.client] needed only when pack files are not cached
 * @param {any} o.config `Config` (`{defaults, weights, …}`) or `defaults.json`
 * @param {'none' | 'claude-cli' | 'anthropic-api' | Backend} o.backend
 * @param {number} [o.top] default 20
 * @param {number} [o.maxUsd] default `llm.maxUsd` (3)
 * @param {string | null} [o.repo] review this `owner/name` only
 * @param {() => string} o.now
 * @param {Log} [o.log]
 * @param {() => number} [o.rand] for the audit picks
 * @param {() => number} [o.packRand] makes pack ids reproducible (tests only)
 * @param {() => number} [o.ms] clock for durations; default derived from `now`
 * @param {AbortSignal} [o.signal]
 * @param {(record: RepoRecord, verdict: Verdict) => RepoRecord | Promise<RepoRecord>} [o.rescore]
 * @param {Record<string, any>} [o.backendOptions] passed to `createBackend`
 * @returns {Promise<ReviewSummary>}
 */
export async function reviewRepos(o) {
  const { store, client = null, config, top = 20, repo = null, now, signal } = o;
  const log = o.log ?? SILENT;
  const rand = o.rand ?? secureRand;
  const llm = config?.defaults?.llm ?? config?.llm ?? {};
  const maxUsd = typeof o.maxUsd === 'number' ? o.maxUsd : typeof llm.maxUsd === 'number' ? llm.maxUsd : 3;
  const clockMs = o.ms ?? (() => Date.parse(now()));
  /** @type {ReviewSummary} */
  const summary = {
    reviewed: 0, skipped: 0, spentUsd: 0, maxUsd, backend: typeof o.backend === 'string' ? o.backend : '',
    model: null, counts: { ok: 0, unsupported: 0, refused: 0, error: 0, 'skipped-injection': 0 },
    skippedFor: {}, results: [], audit: 0, stopReason: null, remaining: 0,
  };
  if (o.backend === 'none' || !o.backend) {
    summary.stopReason = 'disabled';
    return summary;
  }
  /** @type {Backend} */
  const backend = typeof o.backend === 'string'
    ? await createBackend(o.backend, { llm, ...(o.backendOptions ?? {}) })
    : o.backend;
  summary.backend = backend.name;
  summary.model = backend.model;
  const keyOf = (/** @type {string} */ id, /** @type {string | null} */ headOid) => verdictKey({
    id, headOid, rubric: RUBRIC_VERSION, backend: backend.name, model: backend.model,
  });
  const isFinal = (/** @type {any} */ v) => Boolean(v) && FINAL_STATUSES.includes(v.status);
  const skip = (/** @type {string} */ why) => {
    summary.skipped++;
    summary.skippedFor[why] = (summary.skippedFor[why] ?? 0) + 1;
  };

  /** @type {{entry?: IndexEntryLike, record?: RepoRecord, audit: boolean}[]} */
  let targets;
  if (repo) {
    const record = await findRecord(store, { nwo: repo });
    if (!record) {
      log.warn(`No repository ${repo} in the store; add it first with unsung add`);
      skip('not-found');
      summary.stopReason = 'not-found';
      return summary;
    }
    targets = [{ record, audit: false }];
  } else {
    const index = await store.readIndex();
    if (!index || !Array.isArray(index.entries)) {
      log.warn('No index yet: run unsung run first');
      summary.stopReason = 'no-index';
      return summary;
    }
    const exclude = new Set();
    for (const e of /** @type {IndexEntryLike[]} */ (index.entries)) {
      if (!e || !(isEligible(e) || e.lane === 'look')) continue;
      if (isFinal(await store.getVerdict(keyOf(e.id, e.headOid ?? null)))) exclude.add(e.id);
    }
    const { main, audit } = selectionPlan(index, { top, rand, exclude });
    summary.audit = audit.length;
    targets = [
      ...main.map((entry) => ({ entry, audit: false })),
      ...audit.map((entry) => ({ entry, audit: true })),
    ];
  }

  /** @type {number | null} */
  let lastCost = null;
  let errorsInRow = 0;
  const stop = (/** @type {ReviewSummary['stopReason']} */ why, /** @type {number} */ left) => {
    summary.stopReason = why;
    summary.remaining = Math.max(0, left);
  };

  for (let i = 0; i < targets.length; i++) {
    if (signal?.aborted) {
      stop('interrupted', targets.length - i);
      break;
    }
    const target = targets[i];
    const record = target.record ?? await findRecord(store, /** @type {IndexEntryLike} */ (target.entry));
    if (!record || !record.facts) {
      skip('no-record');
      continue;
    }
    const headOid = record.facts.headOid ?? null;
    const key = keyOf(record.id, headOid);
    const gates = record.score?.gates ?? [];
    if (record.score?.lane === 'quarantine' || gates.some((g) => g?.action === 'quarantine')) {
      log.info(`Not reviewing ${record.nwo}: quarantined repositories are never sent to an LLM`);
      skip('quarantined');
      continue;
    }
    const cached = await store.getVerdict(key);
    const attachedKey = record.verdict ? verdictKey(record.verdict) : null;
    if (isFinal(cached) || (isFinal(record.verdict) && attachedKey === key)) {
      skip('already-reviewed');
      continue;
    }
    if (gates.some((g) => g?.id === 'g.injection')) {
      /** @type {Verdict} */
      const skipped = {
        v: 1, id: record.id, nwo: record.nwo, headOid, rubric: RUBRIC_VERSION, backend: backend.name,
        model: backend.model, at: now(), status: 'skipped-injection', output: null, validation: null,
        effect: null, costUsd: 0, usage: null, packBytes: null, durationMs: 0,
      };
      skipped.effect = verdictEffect(skipped);
      await store.appendVerdict(skipped);
      summary.counts['skipped-injection']++;
      skip('injection');
      continue;
    }
    const estimate = lastCost ?? FIRST_CALL_ESTIMATE_USD;
    if (summary.spentUsd + estimate > maxUsd) {
      stop('budget', targets.length - i);
      break;
    }

    /** @type {Record<string, import('./pack.mjs').FetchedFile> | null} */
    let files;
    try {
      files = await fetchPackFiles(record, { client, store });
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (FATAL_GITHUB.has(e?.name) || ['EAUTH', 'ETOKEN', 'ENOTAVAILABLE'].includes(e?.code)) throw err;
      if (e?.name === 'RateLimitError') {
        stop('github-rate-limit', targets.length - i);
        break;
      }
      log.warn(`Skipped ${record.nwo}: could not fetch its pack files`, { error: e?.message ?? String(err) });
      skip('files');
      continue;
    }
    if (files === null) {
      skip('gone');
      continue;
    }

    const pack = buildPack(record, files, o.packRand ? { rand: o.packRand } : {});
    const started = clockMs();
    const raw = await backend.call(pack, { signal });
    const durationMs = Math.max(0, clockMs() - started || 0);
    const cost = round6(raw.costUsd);
    summary.spentUsd = round6(summary.spentUsd + cost);
    if (cost > 0) lastCost = cost;

    const kind = raw.error?.kind;
    if (kind === 'aborted') {
      stop('interrupted', targets.length - i);
      break;
    }
    if (kind === 'auth' || kind === 'model' || kind === 'spawn') {
      stop(kind === 'auth' ? 'auth' : kind === 'model' ? 'unknown-model' : 'backend', targets.length - i);
      summary.error = raw.error?.message;
      break;
    }
    if (kind === 'rate') {
      stop('rate-limit', targets.length - i);
      break;
    }

    /** @type {Verdict['status']} */
    let status;
    /** @type {Verdict['output']} */
    let output = null;
    /** @type {Verdict['validation']} */
    let validation;
    /** @type {Record<string, unknown>} */
    const extra = {};
    if (raw.refusal || raw.stopReason === 'refusal') {
      status = 'refused';
      const category = raw.refusal?.category ?? null;
      extra.refusal = { category };
      const problem = `Refused (category: ${category ?? 'not given'})`;
      validation = { claimsKept: 0, claimsDropped: 0, problems: [problem] };
    } else if (!raw.ok) {
      status = 'error';
      const problem = raw.error?.message ?? 'The backend failed';
      validation = { claimsKept: 0, claimsDropped: 0, problems: [problem] };
    } else {
      const v = validateVerdict(raw.output, pack);
      status = v.status;
      output = v.output;
      validation = { claimsKept: v.kept, claimsDropped: v.dropped, problems: v.problems };
    }
    if (raw.model && raw.model !== backend.model) extra.servedBy = raw.model;
    if (raw.costEstimated === true) extra.costEstimated = true;
    if (target.audit) extra.audit = true;
    /** @type {Verdict} */
    const verdict = {
      v: 1, id: record.id, nwo: record.nwo, headOid, rubric: RUBRIC_VERSION, backend: backend.name,
      model: backend.model, at: now(), status, output, validation, effect: null, costUsd: cost,
      usage: raw.usage ?? { input: 0, output: 0 }, packBytes: pack.bytes, durationMs, ...extra,
    };
    verdict.effect = verdictEffect(verdict, { weights: config?.weights });
    await store.appendVerdict(verdict);
    summary.reviewed++;
    summary.counts[status] = (summary.counts[status] ?? 0) + 1;
    summary.results.push({
      nwo: record.nwo, status, points: verdict.effect.points, lane: verdict.effect.lane, costUsd: cost,
      audit: target.audit,
    });
    log.info(`Reviewed ${record.nwo}: ${status}`, { points: verdict.effect.points, costUsd: cost });

    if (status === 'ok') {
      const attached = { ...record, verdict };
      let next = attached;
      if (typeof o.rescore === 'function') {
        try {
          next = (await o.rescore(attached, verdict)) ?? attached;
        } catch (err) {
          log.warn(`Could not rescore ${record.nwo}; the verdict is attached and counts at the next rescore`,
            { error: err instanceof Error ? err.message : String(err) });
        }
      }
      await store.putRepo(next);
    }
    errorsInRow = status === 'error' ? errorsInRow + 1 : 0;
    if (errorsInRow >= MAX_CONSECUTIVE_ERRORS) {
      stop('errors', targets.length - i - 1);
      break;
    }
  }
  return summary;
}
