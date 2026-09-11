// @ts-check
/**
 * Record shapes, constants and validators (DESIGN §4). Every validator has the signature
 * `(x: unknown) → string[]`; an empty array means valid. Validators check types, enums, presence
 * and simple invariants; timestamps are checked to be strings only (writers own the ISO-8601 `Z`
 * convention of §4.1). Unknown extra properties are allowed everywhere except in `VerdictOutput`,
 * whose schema sets `additionalProperties: false` (§8.4).
 */

import { parseDuration } from './util.mjs';

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Version of the `data/` layout (§4.1). */
export const STORE_VERSION = 1;

/** Labelling categories (§1.2). */
export const LABELS = Object.freeze(['G', 'W', 'C', 'P', 'S', 'D', 'X', 'E']);

/** Lanes, in the order in which §6.7 tests them. */
export const LANES = Object.freeze([
  'quarantine', 'gone', 'institutional', 'graduated', 'rising', 'doubted', 'proven', 'promising',
  'look', 'low',
]);

/** Quality bands (§6.3). */
export const BANDS = Object.freeze(['gem', 'look', 'low']);

/** Candidate states (§4.3). */
export const CANDIDATE_STATES = Object.freeze([
  'queued', 'deferred', 'dropped', 'quarantined', 'enriched', 'gone', 'heavy', 'expired',
]);

/** Feedback actions (§4.3, §10.4). */
export const FEEDBACK_ACTIONS = Object.freeze([
  'gem', 'wip', 'notgood', 'notmine', 'snooze', 'undo', 'publish', 'unpublish', 'label',
]);

/** Signal kinds (§5.1). */
export const SIGNAL_KINDS = Object.freeze(['quality', 'proof', 'slop', 'judge', 'confidence', 'descriptor']);

/** Kinds whose points count toward `S` (§6.1). */
export const SCORING_KINDS = Object.freeze(['quality', 'proof', 'slop', 'judge']);

/** Signal statuses (§5.1). */
export const SIGNAL_STATUSES = Object.freeze(['ok', 'unknown', 'na']);

/** How hard a signal is to fake (§5.1). */
export const SIGNAL_COSTS = Object.freeze(['cheap', 'effort', 'costly']);

/** Gate actions (§4.3). */
export const GATE_ACTIONS = Object.freeze(['quarantine', 'drop', 'doubt', 'institutional']);

/** Confidence bands (§6.4). */
export const CONFIDENCE_BANDS = Object.freeze(['low', 'medium', 'high']);

/** Status-check rollup states (§4.3 `Facts.rollup`). */
export const ROLLUP_STATES = Object.freeze(['SUCCESS', 'FAILURE', 'PENDING', 'ERROR', 'EXPECTED']);

/** Ledger unit states (§3.12). */
export const UNIT_STATES = Object.freeze(['planned', 'running', 'done', 'failed']);

/** Reasons a `notgood` decision carries (§4.3) and the label each implies (§10.3). */
export const NOTGOOD_REASONS = Object.freeze(['slop', 'clone', 'personal', 'spam', 'dump', 'empty']);

/** @type {Readonly<Record<string, Label>>} */
export const NOTGOOD_LABELS = Object.freeze({
  slop: 'S', clone: 'C', personal: 'P', spam: 'X', dump: 'D', empty: 'E',
});

/** LLM backends (§8.6). */
export const LLM_BACKENDS = Object.freeze(['none', 'claude-cli', 'anthropic-api']);

/** Verdict statuses (§4.3). */
export const VERDICT_STATUSES = Object.freeze(['ok', 'unsupported', 'refused', 'error', 'skipped-injection']);

/** Verdict flags (§8.4). */
export const VERDICT_FLAGS = Object.freeze([
  'tutorial_clone', 're_upload', 'template_unmodified', 'prompt_ware', 'misleading_readme', 'malware_suspect',
  'do_not_promote',
]);

/** Rubric dimensions (§8.3) and what a claim may support (§8.4). */
export const SCORE_DIMENSIONS = Object.freeze(['purpose', 'craft', 'verification', 'honesty', 'originality']);
export const CLAIM_SUPPORTS = Object.freeze([...SCORE_DIMENSIONS, 'category']);

/** Process exit codes (§3.12). */
export const EXIT_CODES = Object.freeze({ ok: 0, unexpected: 1, config: 2, paused: 75, interrupted: 130 });

// ---------------------------------------------------------------------------------------------
// Types (§4.3)
// ---------------------------------------------------------------------------------------------

/** @typedef {'G' | 'W' | 'C' | 'P' | 'S' | 'D' | 'X' | 'E'} Label */
/**
 * @typedef {'quarantine' | 'gone' | 'institutional' | 'graduated' | 'rising' | 'doubted' | 'proven'
 *   | 'promising' | 'look' | 'low'} Lane
 */
/** @typedef {'gem' | 'look' | 'low'} Band */
/**
 * @typedef {'queued' | 'deferred' | 'dropped' | 'quarantined' | 'enriched' | 'gone' | 'heavy'
 *   | 'expired'} CandidateState
 */
/**
 * @typedef {'gem' | 'wip' | 'notgood' | 'notmine' | 'snooze' | 'undo' | 'publish' | 'unpublish'
 *   | 'label'} FeedbackAction
 */
/** @typedef {'quality' | 'proof' | 'slop' | 'judge' | 'confidence' | 'descriptor'} SignalKind */

/**
 * What a source yields (§4.3).
 * @typedef {object} CandidateSeed
 * @property {string} id GraphQL node id
 * @property {string} nwo `owner/name`
 * @property {string} createdAt
 * @property {string | null} pushedAt
 * @property {number} stars
 * @property {number} forks
 * @property {number} diskKB
 * @property {string | null} lang
 * @property {string | null} licence
 * @property {boolean} hasDesc
 * @property {string | null} description
 * @property {string | null} ownerType `User` or `Organization`
 * @property {boolean} isFork
 * @property {boolean} isArchived
 * @property {boolean} isTemplate
 * @property {boolean} isMirror
 * @property {string} source `census:<day>`, `archive:<YYYY-MM-DD-H>:<Release|Public>`, `add` or `sample`
 */

/**
 * @typedef {object} CandidateResult
 * @property {string | null} headOid
 * @property {number} S
 * @property {Band} band
 * @property {Lane} lane
 * @property {number} gem
 * @property {string} at
 */

/**
 * A candidate line in `candidates/<day>.jsonl` (§4.3).
 * @typedef {object} Candidate
 * @property {1} v
 * @property {string} id
 * @property {string} nwo
 * @property {string} day partition day, `YYYY-MM-DD`
 * @property {string} createdAt
 * @property {string | null} pushedAt
 * @property {number} stars
 * @property {number} forks
 * @property {number} diskKB
 * @property {string | null} lang
 * @property {string | null} licence
 * @property {boolean} hasDesc
 * @property {string | null} ownerType
 * @property {string[]} sources
 * @property {string} seenAt
 * @property {number} prior
 * @property {boolean} explore
 * @property {CandidateState} state
 * @property {string | null} reason
 * @property {string | null} nextAt
 * @property {CandidateResult | null} result
 */

/**
 * A patch line appended to a candidate partition; the latest value of each field wins (§4.3).
 * @typedef {object} CandidatePatch
 * @property {1} v
 * @property {true} patch
 * @property {string} id
 * @property {string} day
 * @property {string} at
 * @property {Partial<Candidate>} set
 */

/** @typedef {{name: string, bytes: number}} LanguageShare */
/** @typedef {{tag: string, publishedAt?: string | null, prerelease?: boolean | null}} ReleaseRef */
/**
 * @typedef {object} OwnerInfo
 * @property {string} login
 * @property {string} type
 * @property {string | null} [createdAt]
 * @property {number | null} [publicRepos]
 * @property {number[] | null} [contributionYears] deep, else null
 * @property {boolean | null} [sponsorsListing] deep, else null
 */
/** @typedef {{at?: string | null, headline?: string | null, authorLogin?: string | null}} CommitRef */
/** @typedef {[string, string, (number | null)?]} TreeEntry `[path, type, size]` */

/**
 * The normalised snapshot every signal reads (§4.3). `null` means not fetched or not knowable;
 * `[]`, `0` and `false` mean fetched and empty.
 * @typedef {object} Facts
 * @property {1} v
 * @property {string} id
 * @property {string} nwo
 * @property {string} owner
 * @property {string} name
 * @property {string} fetchedAt
 * @property {'graphql' | 'rest' | 'fixture'} source
 * @property {('enrich' | 'deep')[]} stages
 * @property {string | null} headOid
 * @property {string | null} defaultBranch
 * @property {string | null} createdAt
 * @property {string | null} pushedAt
 * @property {string | null} description
 * @property {string | null} homepageUrl
 * @property {boolean | null} isFork
 * @property {boolean | null} isArchived
 * @property {boolean | null} isTemplate
 * @property {boolean | null} isMirror
 * @property {boolean | null} hasIssues
 * @property {boolean | null} hasDiscussions
 * @property {number | null} stars
 * @property {number | null} forks
 * @property {number | null} watchers
 * @property {number | null} diskKB
 * @property {string | null} licence spdxId, `NOASSERTION`, or null when no licence was detected
 * @property {string | null} primaryLanguage
 * @property {LanguageShare[] | null} languages
 * @property {number | null} codeBytes
 * @property {string[] | null} topics
 * @property {{count: number, recent: ReleaseRef[]} | null} releases
 * @property {number | null} tags
 * @property {OwnerInfo | null} ownerInfo
 * @property {{total: number | null, recent: CommitRef[]} | null} commits newest first, ≤ 20
 * @property {'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | null} rollup
 * @property {{name: string, type: string}[] | null} root
 * @property {{name: string, text: string | null}[] | null} workflows
 * @property {{name: string, bytes: number, truncated: boolean, text: string | null} | null} readme
 * @property {{name?: string | null, deps?: number | null, devDeps?: number | null,
 *   testScript?: string | null, scripts?: unknown} | null} packageJson
 * @property {{path: string, text: string | null} | null} manifest
 * @property {number | null} agentsMdBytes
 * @property {number | null} claudeMdBytes
 * @property {{truncated: boolean, count: number, entries: TreeEntry[]} | null} tree
 * @property {{pushDays: number, firstAt?: string | null, lastAt?: string | null,
 *   forcePushes?: number | null} | null} activity
 * @property {{weeks: {week: string, gained: number}[], gain4w: number | null} | null} starHistory
 * @property {{login: string, kind: string, at: string, accountCreatedAt?: string | null}[] | null} outsiders
 * @property {{platform: string, url: string}[] | null} funding
 * @property {boolean} heavy
 */

/** @typedef {{label: string, url: string, quote?: string}} Evidence */

/**
 * @typedef {object} Signal
 * @property {string} id
 * @property {SignalKind} kind
 * @property {'ok' | 'unknown' | 'na'} status
 * @property {boolean | null} hit null unless status is ok
 * @property {unknown} value the measured quantity
 * @property {number | null} weight
 * @property {number | null} points `hit ? weight : 0` for scoring kinds
 * @property {number | null} strength confidence items only, 0…1
 * @property {string | null} group
 * @property {boolean} provisional
 * @property {'cheap' | 'effort' | 'costly' | null} cost
 * @property {string} label
 * @property {string} reason
 * @property {Evidence[]} evidence
 */

/**
 * @typedef {object} Gate
 * @property {string} id
 * @property {'quarantine' | 'drop' | 'doubt' | 'institutional'} action
 * @property {string} reason
 * @property {Evidence[]} evidence
 */
/** @typedef {{id: string, label: string, detail: string | null}} Descriptor */

/**
 * @typedef {object} Score
 * @property {1} v
 * @property {string} id
 * @property {string} nwo
 * @property {string | null} headOid
 * @property {string} scoredAt
 * @property {{weights: string, calibration: string, rubric: string | null}} model
 * @property {Signal[]} signals in registry order
 * @property {number} S
 * @property {number} pointsMax
 * @property {number} coverage
 * @property {number} quality
 * @property {Band} band
 * @property {{k: number, band: 'low' | 'medium' | 'high', items: Signal[]}} confidence
 * @property {{stars: number, forks: number, watchers: number, gain4w: number | null, a: number}} attention
 * @property {number} gem
 * @property {Lane} lane
 * @property {Gate[]} gates
 * @property {Descriptor[]} descriptors
 */

/**
 * @typedef {object} HistoryPoint
 * @property {string} at
 * @property {string | null} headOid
 * @property {number} S
 * @property {number} quality
 * @property {number} k
 * @property {number} gem
 * @property {Lane} lane
 * @property {number} stars
 */

/**
 * @typedef {object} RepoRecord
 * @property {1} v
 * @property {string} id
 * @property {string} nwo
 * @property {Candidate | null} candidate
 * @property {Facts} facts
 * @property {Score | null} score
 * @property {{at: string, headOid: string | null, S: number, stars: number} | null} firstSeen
 * @property {HistoryPoint[]} history ≤ 50
 * @property {Verdict | null} verdict latest valid verdict for the current headOid
 * @property {string | null} checkedAt
 * @property {boolean} gone
 */

/** @typedef {{text: string, path: string, quote: string, supports: string}} Claim */

/**
 * The LLM's structured answer (§8.4).
 * @typedef {object} VerdictOutput
 * @property {Label} category
 * @property {number} categoryConfidence 0…1
 * @property {{purpose: number, craft: number, verification: number, honesty: number,
 *   originality: number}} scores 1…4
 * @property {Claim[]} claims
 * @property {string[]} flags
 * @property {string} pitch
 * @property {string} audience
 * @property {string} summary
 * @property {boolean} injectionSeen
 */

/**
 * @typedef {object} Verdict
 * @property {1} v
 * @property {string} id
 * @property {string} nwo
 * @property {string | null} headOid
 * @property {string} rubric
 * @property {'none' | 'claude-cli' | 'anthropic-api'} backend
 * @property {string | null} model
 * @property {string} at
 * @property {'ok' | 'unsupported' | 'refused' | 'error' | 'skipped-injection'} status
 * @property {VerdictOutput | null} output
 * @property {{claimsKept: number, claimsDropped: number, problems: unknown[]} | null} validation
 * @property {{points: number, lane: string | null, reason: string} | null} effect
 * @property {number | null} costUsd
 * @property {{input?: number, output?: number} | null} usage
 * @property {number | null} packBytes
 * @property {number | null} durationMs
 */

/**
 * @typedef {object} FeedbackContext
 * @property {string | null} [view]
 * @property {number | null} [position]
 * @property {number | null} [S]
 * @property {number | null} [quality]
 * @property {number | null} [gem]
 * @property {number | null} [k]
 * @property {number | null} [stars]
 * @property {string | null} [weights]
 * @property {string | null} [calibration]
 */

/**
 * @typedef {object} Feedback
 * @property {1} v
 * @property {string} at
 * @property {string} id
 * @property {string} nwo
 * @property {FeedbackAction} action
 * @property {Label | null} label derived quality label (see `labelFromFeedback`)
 * @property {'slop' | 'clone' | 'personal' | 'spam' | 'dump' | 'empty' | null} reason notgood only
 * @property {string} note ≤ 280 characters
 * @property {boolean} blind
 * @property {string | number | null} undoes the event an `undo` reverts
 * @property {string | null} snoozeUntil
 * @property {FeedbackContext | null} context
 */

/**
 * @typedef {object} TasteState
 * @property {1} v
 * @property {string} updatedAt
 * @property {Record<string, {gems: number, notmine: number, pin: -1 | 0 | 1}>} facets
 */

/**
 * @typedef {object} Unit
 * @property {1} v
 * @property {string} key `census:<YYYY-MM-DD>:<scope>:<FROM>..<TO>` or `archive:<YYYY-MM-DD-H>`
 * @property {string} stage
 * @property {'planned' | 'running' | 'done' | 'failed'} state
 * @property {number} attempts
 * @property {string} at
 * @property {string | null} runId
 * @property {Record<string, unknown> | null} out
 * @property {string | Record<string, unknown> | null} err
 * @property {string | null} nextAt
 */

/**
 * `RunManifest` (`runs/<runId>.json`); a `RunSummary` is the same object without `units`.
 * @typedef {object} RunManifest
 * @property {1} v
 * @property {string} runId `YYYYMMDDTHHMMSSZ-xxxx`
 * @property {string} startedAt
 * @property {string | null} endedAt
 * @property {string[]} argv
 * @property {string | null} profile
 * @property {{wallMs: number | null, graphqlMs: number | null}} budget
 * @property {Record<string, Record<string, unknown>>} stages a stage skipped before its first unit
 *   carries `skipped` (`budget`, `wall`, `time`, `interrupted` or `paused`; §3.8)
 * @property {{graphql?: Record<string, unknown>, rest?: Record<string, unknown>,
 *   pauses?: Record<string, unknown>[]}} rate
 * @property {{code: number | null, reason: string | null, resumeAt: string | null} | null} exit
 * @property {unknown} [units]
 */
/** @typedef {Omit<RunManifest, 'units'>} RunSummary */

/**
 * @typedef {object} IndexEntry
 * @property {string} id
 * @property {string} nwo
 * @property {string | null} [description] ≤ 300 characters
 * @property {string | null} [lang]
 * @property {string[]} [topics]
 * @property {string | null} [createdAt]
 * @property {string | null} [pushedAt]
 * @property {number | null} [ageDays]
 * @property {Lane} lane
 * @property {Band} [band]
 * @property {number} [S]
 * @property {number} [pointsMax]
 * @property {number} [coverage]
 * @property {number} [quality]
 * @property {number} [k]
 * @property {'low' | 'medium' | 'high'} [kBand]
 * @property {number} [a]
 * @property {number} [gem]
 * @property {number} [stars]
 * @property {number} [forks]
 * @property {number | null} [gain4w]
 * @property {number[] | null} [spark] weekly gains, oldest to newest
 * @property {{id: string, points: number, status: string, hit: boolean | null, label: string}[]} [chips]
 * @property {string[]} [top]
 * @property {string[]} [negatives]
 * @property {string[]} [descriptors]
 * @property {(string | {id: string, reason?: string})[]} gates
 * @property {{category: Label, pitch: string | null, points: number} | null} [verdict]
 * @property {string[]} [facets]
 * @property {{last: unknown, published: boolean, snoozeUntil: string | null}} [feedback]
 * @property {string | null} [headOid]
 */

/**
 * @typedef {object} Index
 * @property {1} v
 * @property {string} generatedAt
 * @property {{weights: Record<string, unknown> | null, calibration: Record<string, unknown> | null}} model
 * @property {Record<string, number>} counts
 * @property {RunSummary | null} lastRun
 * @property {IndexEntry[]} entries ≤ 20,000
 */

/**
 * @typedef {object} ArchiveEvent
 * @property {string} type
 * @property {number} repoId
 * @property {string} nwo
 * @property {string} actor
 * @property {string} at
 * @property {string | null} tag
 * @property {boolean | null} prerelease
 */

/**
 * @typedef {object} OwnerMemory
 * @property {1} v
 * @property {string} login
 * @property {string} type
 * @property {string[]} flags
 * @property {string} evidence
 * @property {number} publicRepos
 * @property {string} checkedAt
 */

/**
 * @typedef {object} HttpCacheEntry
 * @property {string} url stored after `redact()`
 * @property {string | null} etag
 * @property {string | null} lastModified
 * @property {number} status
 * @property {unknown} body
 * @property {string} at
 */

/**
 * `config/defaults.json` (§9.3).
 * @typedef {object} Defaults
 * @property {number} version
 * @property {Record<string, {budget: string | null, archiveHours: number, deepTopN: number,
 *   enrichMax: number, recheckTop: number}>} profiles
 * @property {number} lagDays
 * @property {number} backfillDays
 * @property {number} maxStars
 * @property {number} ownerCapPerDay
 * @property {number} explore
 * @property {number} queueTtlDays
 * @property {{census: number, archive: number, enrichUntil: number}} shares
 * @property {{graphqlMsPerMin: number, restMsPerMin: number, searchGapMs: number,
 *   restConcurrency: number}} governor
 * @property {Record<'enrich' | 'deep' | 'lookup',
 *   {size: number, min: number, max: number, targetMs: number}>} batch
 * @property {{readmeBytes: number, fileBytes: number, treeEntries: number, indexEntries: number}} caps
 * @property {{port: number}} server
 * @property {{backend: string, model: string, effort: string, maxUsd: number, perCallUsd: number,
 *   cliTimeoutMs?: number, endpoint: string, claudePath: string | null, fallbacks: boolean,
 *   prices: Record<string, {input: number, output: number}>}} llm `cliTimeoutMs` (optional, positive
 *   ms; default 180,000) limits one claude-cli call (§8.6)
 */

/**
 * `config/weights.json` (§4.4).
 * @typedef {object} Weights
 * @property {string} version
 * @property {Record<string, {points: number, kind: SignalKind, group?: string | null,
 *   provisional?: boolean}>} signals
 * @property {Record<string, unknown>} confidence
 * @property {{gem: number, look: number}} bands
 * @property {{kWeight: number, aWeight: number}} gem
 * @property {{saturation: number}} attention
 * @property {{maxStars: number, risingGain4w: number}} eligibility
 * @property {{orgMinRepos: number}} institutions
 * @property {{medium: number, high: number}} confidenceBands
 * @property {{provenK: number}} lanes
 * @property {{version: string, date: string, change: string, evidence?: unknown}[]} changelog
 */

/**
 * `config/calibration.json` (§4.4).
 * @typedef {object} Calibration
 * @property {string} version
 * @property {string} method
 * @property {number} a
 * @property {number} b
 * @property {Record<string, unknown>} fittedOn
 * @property {string} fittedAt
 */

/** @typedef {{version: string | number, allow: string[], deny: string[]}} Institutions */

// ---------------------------------------------------------------------------------------------
// Checker combinators
// ---------------------------------------------------------------------------------------------

/** @typedef {(v: any, path: string, errs: string[]) => void} Check */

/**
 * @param {unknown} v
 * @returns {v is Record<string, any>}
 */
function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Short, safe description of a value for an error message (never more than 30 characters of text).
 * @param {unknown} v
 * @returns {string}
 */
function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'nothing';
  if (Array.isArray(v)) return 'an array';
  if (typeof v === 'string') {
    return `the string ${JSON.stringify(v.length > 30 ? `${v.slice(0, 30)}…` : v)}`;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return `${typeof v} ${String(v)}`;
  return typeof v === 'object' ? 'an object' : typeof v;
}

/**
 * @param {string} want
 * @param {(v: any) => boolean} test
 * @returns {Check}
 */
function is(want, test) {
  return (v, p, e) => {
    if (!test(v)) e.push(`${p}: expected ${want}, got ${describe(v)}`);
  };
}

/** @type {Check} */ const any = () => {};
const str = is('a string', (v) => typeof v === 'string');
const nonEmptyStr = is('a non-empty string', (v) => typeof v === 'string' && v.length > 0);
const num = is('a finite number', (v) => typeof v === 'number' && Number.isFinite(v));
const int = is('an integer', (v) => Number.isInteger(v));
const nonNegNum = is('a number ≥ 0', (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
const nonNegInt = is('an integer ≥ 0', (v) => Number.isInteger(v) && v >= 0);
const posInt = is('an integer ≥ 1', (v) => Number.isInteger(v) && v >= 1);
const positive = is('a number > 0', (v) => typeof v === 'number' && Number.isFinite(v) && v > 0);
const bool = is('a boolean', (v) => typeof v === 'boolean');
const obj = is('an object', isObj);
const TIME = str; // ISO-8601 UTC by convention (§4.1); only the type is checked
const ID = nonEmptyStr;
const NWO = is('owner/name', (v) => typeof v === 'string' && /^[^/\s]+\/[^/\s]+$/.test(v));
const DAY = is('a YYYY-MM-DD day', (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v));
const V1 = is('schema version 1', (v) => v === 1);

/**
 * @param {number} lo
 * @param {number} hi
 * @returns {Check}
 */
function range(lo, hi) {
  return is(`a number from ${lo} to ${hi}`, (v) => typeof v === 'number' && v >= lo && v <= hi);
}
const unit01 = range(0, 1);

/**
 * @param {readonly unknown[]} values
 * @returns {Check}
 */
function oneOf(values) {
  return is(`one of ${values.join(', ')}`, (v) => values.includes(v));
}

/**
 * @param {number} max
 * @returns {Check}
 */
function maxChars(max) {
  return is(`a string of at most ${max} characters`, (v) => typeof v === 'string' && [...v].length <= max);
}

/**
 * @param {Check} check
 * @returns {Check}
 */
function nullable(check) {
  return (v, p, e) => {
    if (v !== null) check(v, p, e);
  };
}

/**
 * @param {...Check} checks
 * @returns {Check}
 */
function all(...checks) {
  return (v, p, e) => {
    for (const c of checks) {
      const before = e.length;
      c(v, p, e);
      if (e.length > before) return;
    }
  };
}

/**
 * Passes when any alternative passes; otherwise reports the first alternative's problems.
 * @param {...Check} checks
 * @returns {Check}
 */
function anyOf(...checks) {
  return (v, p, e) => {
    /** @type {string[] | null} */
    let first = null;
    for (const c of checks) {
      /** @type {string[]} */
      const errs = [];
      c(v, p, errs);
      if (errs.length === 0) return;
      if (!first) first = errs;
    }
    e.push(...(first ?? []));
  };
}

/**
 * @param {Check} check
 * @param {number} [maxLen]
 * @returns {Check}
 */
function arrayOf(check, maxLen = Infinity) {
  return (v, p, e) => {
    if (!Array.isArray(v)) {
      e.push(`${p}: expected an array, got ${describe(v)}`);
      return;
    }
    if (v.length > maxLen) e.push(`${p}: expected at most ${maxLen} items, got ${v.length}`);
    v.forEach((x, i) => check(x, `${p}[${i}]`, e));
  };
}

/**
 * An object used as a map: every own value must pass `check`.
 * @param {Check} check
 * @returns {Check}
 */
function recordOf(check) {
  return (v, p, e) => {
    if (!isObj(v)) {
      e.push(`${p}: expected an object, got ${describe(v)}`);
      return;
    }
    for (const [k, x] of Object.entries(v)) check(x, `${p}.${k}`, e);
  };
}

/**
 * An object with required and optional properties. A required property must be present (it may
 * still be `null` when its check allows). `strict` rejects unknown properties.
 * @param {Record<string, Check>} required
 * @param {Record<string, Check>} [optional]
 * @param {{strict?: boolean}} [opts]
 * @returns {Check}
 */
function shape(required, optional = {}, { strict = false } = {}) {
  return (v, p, e) => {
    if (!isObj(v)) {
      e.push(`${p}: expected an object, got ${describe(v)}`);
      return;
    }
    for (const [k, c] of Object.entries(required)) {
      if (v[k] === undefined) e.push(`${p}.${k}: required`);
      else c(v[k], `${p}.${k}`, e);
    }
    for (const [k, c] of Object.entries(optional)) {
      if (v[k] !== undefined) c(v[k], `${p}.${k}`, e);
    }
    if (strict) {
      for (const k of Object.keys(v)) {
        if (!(k in required) && !(k in optional)) e.push(`${p}.${k}: unexpected property`);
      }
    }
  };
}

/**
 * @param {Check} check
 * @param {string} root
 * @returns {(x: unknown) => string[]}
 */
function validator(check, root) {
  return (x) => {
    /** @type {string[]} */
    const errs = [];
    check(x, root, errs);
    return errs;
  };
}

// ---------------------------------------------------------------------------------------------
// Record checks
// ---------------------------------------------------------------------------------------------

const candidateResult = shape({
  headOid: nullable(str), S: num, band: oneOf(BANDS), lane: oneOf(LANES), gem: num, at: TIME,
});

/** @type {Record<string, Check>} */
const CANDIDATE_FIELDS = {
  v: V1, id: ID, nwo: NWO, day: DAY, createdAt: TIME, pushedAt: nullable(TIME),
  stars: nonNegInt, forks: nonNegInt, diskKB: nonNegNum, lang: nullable(str), licence: nullable(str),
  hasDesc: bool, ownerType: nullable(str), sources: arrayOf(str), seenAt: TIME, prior: int,
  explore: bool, state: oneOf(CANDIDATE_STATES), reason: nullable(str), nextAt: nullable(TIME),
  result: nullable(candidateResult),
};
const candidate = shape(CANDIDATE_FIELDS);

/** @type {Check} */
const patchSet = (v, p, e) => {
  if (!isObj(v)) {
    e.push(`${p}: expected an object, got ${describe(v)}`);
    return;
  }
  for (const [k, x] of Object.entries(v)) {
    if (k === 'v' || k === 'id' || k === 'patch') e.push(`${p}.${k}: a patch may not set ${k}`);
    else if (CANDIDATE_FIELDS[k]) CANDIDATE_FIELDS[k](x, `${p}.${k}`, e);
  }
};
const candidatePatch = shape({
  v: V1, patch: is('true', (v) => v === true), id: ID, day: DAY, at: TIME, set: patchSet,
});

const evidence = shape({ label: str, url: str }, { quote: maxChars(120) });

/** @type {Check} */
const signalRules = (v, p, e) => {
  if (v.status !== 'ok' && v.hit !== null) e.push(`${p}.hit: must be null unless status is ok`);
  const scoring = SCORING_KINDS.includes(v.kind);
  if (scoring && v.status === 'ok' && typeof v.hit !== 'boolean') {
    e.push(`${p}.hit: must be a boolean when status is ok`);
  }
  if (scoring && typeof v.points === 'number' && typeof v.weight === 'number') {
    const expected = v.status === 'ok' && v.hit === true ? v.weight : 0;
    if (v.points !== expected) {
      e.push(`${p}.points: expected ${expected} (hit ? weight : 0), got ${v.points}`);
    }
  }
  if (v.kind !== 'confidence' && v.strength !== null) e.push(`${p}.strength: confidence items only`);
};

const signal = all(shape({
  id: nonEmptyStr, kind: oneOf(SIGNAL_KINDS), status: oneOf(SIGNAL_STATUSES), hit: nullable(bool), value: any,
  weight: nullable(num), points: nullable(num), strength: nullable(unit01), group: nullable(str),
  provisional: bool, cost: nullable(oneOf(SIGNAL_COSTS)), label: str, reason: str,
  evidence: arrayOf(evidence),
}), signalRules);

const confidenceItem = all(signal, is('a confidence item', (v) => v.kind === 'confidence'));
const gate = shape({
  id: nonEmptyStr, action: oneOf(GATE_ACTIONS), reason: str, evidence: arrayOf(evidence),
});
const descriptor = shape({ id: nonEmptyStr, label: str, detail: nullable(str) });

const treeEntry = is('a [path, type, size] tuple', (v) => Array.isArray(v) && v.length >= 2 && v.length <= 3
  && typeof v[0] === 'string' && typeof v[1] === 'string'
  && (v[2] === undefined || v[2] === null || (typeof v[2] === 'number' && v[2] >= 0)));

const facts = shape({
  v: V1, id: ID, nwo: NWO, owner: nonEmptyStr, name: nonEmptyStr, fetchedAt: TIME,
  source: oneOf(['graphql', 'rest', 'fixture']), stages: arrayOf(oneOf(['enrich', 'deep'])),
  headOid: nullable(str), defaultBranch: nullable(str), createdAt: nullable(TIME), pushedAt: nullable(TIME),
  description: nullable(str), homepageUrl: nullable(str),
  isFork: nullable(bool), isArchived: nullable(bool), isTemplate: nullable(bool), isMirror: nullable(bool),
  hasIssues: nullable(bool), hasDiscussions: nullable(bool),
  stars: nullable(nonNegInt), forks: nullable(nonNegInt), watchers: nullable(nonNegInt),
  diskKB: nullable(nonNegNum),
  licence: nullable(str), primaryLanguage: nullable(str),
  languages: nullable(arrayOf(shape({ name: str, bytes: nonNegNum }))), codeBytes: nullable(nonNegNum),
  topics: nullable(arrayOf(str)),
  releases: nullable(shape({
    count: nonNegInt,
    recent: arrayOf(shape({ tag: str }, { publishedAt: nullable(TIME), prerelease: nullable(bool) })),
  })),
  tags: nullable(nonNegInt),
  ownerInfo: nullable(shape({ login: str, type: str }, {
    createdAt: nullable(TIME), publicRepos: nullable(nonNegInt), contributionYears: nullable(arrayOf(int)),
    sponsorsListing: nullable(bool),
  })),
  commits: nullable(shape({
    total: nullable(nonNegInt),
    recent: arrayOf(shape({}, { at: nullable(TIME), headline: nullable(str), authorLogin: nullable(str) })),
  })),
  rollup: nullable(oneOf(ROLLUP_STATES)),
  root: nullable(arrayOf(shape({ name: str, type: str }))),
  workflows: nullable(arrayOf(shape({ name: str }, { text: nullable(str) }))),
  readme: nullable(shape({ name: str, bytes: nonNegNum, truncated: bool, text: nullable(str) })),
  packageJson: nullable(shape({}, {
    name: nullable(str), deps: nullable(nonNegInt), devDeps: nullable(nonNegInt), testScript: nullable(str),
    scripts: any,
  })),
  manifest: nullable(shape({ path: str }, { text: nullable(str) })),
  agentsMdBytes: nullable(nonNegNum), claudeMdBytes: nullable(nonNegNum),
  tree: nullable(shape({ truncated: bool, count: nonNegInt, entries: arrayOf(treeEntry) })),
  activity: nullable(shape({ pushDays: nonNegInt }, {
    firstAt: nullable(TIME), lastAt: nullable(TIME), forcePushes: nullable(nonNegInt),
  })),
  starHistory: nullable(shape({ weeks: arrayOf(shape({ week: str, gained: num })), gain4w: nullable(num) })),
  outsiders: nullable(arrayOf(shape({ login: str, kind: str, at: TIME }, {
    accountCreatedAt: nullable(TIME),
  }))),
  funding: nullable(arrayOf(shape({ platform: str, url: str }))),
  heavy: bool,
});

const score = shape({
  v: V1, id: ID, nwo: NWO, headOid: nullable(str), scoredAt: TIME,
  model: shape({ weights: str, calibration: str, rubric: nullable(str) }),
  signals: arrayOf(signal), S: num, pointsMax: num, coverage: unit01, quality: unit01, band: oneOf(BANDS),
  confidence: shape({ k: unit01, band: oneOf(CONFIDENCE_BANDS), items: arrayOf(confidenceItem) }),
  attention: shape({ stars: nonNegNum, forks: nonNegNum, watchers: num, gain4w: nullable(num), a: unit01 }),
  gem: num, lane: oneOf(LANES), gates: arrayOf(gate), descriptors: arrayOf(descriptor),
});

const score14 = all(int, range(1, 4));
const verdictOutput = shape({
  category: oneOf(LABELS),
  categoryConfidence: unit01,
  scores: shape({
    purpose: score14, craft: score14, verification: score14, honesty: score14, originality: score14,
  }, {}, { strict: true }),
  claims: arrayOf(shape({
    text: str, path: str, quote: str, supports: oneOf(CLAIM_SUPPORTS),
  }, {}, { strict: true })),
  flags: arrayOf(oneOf(VERDICT_FLAGS)),
  pitch: str, audience: str, summary: str, injectionSeen: bool,
}, {}, { strict: true });

const verdict = shape({
  v: V1, id: ID, nwo: NWO, headOid: nullable(str), rubric: str, backend: oneOf(LLM_BACKENDS),
  model: nullable(str),
  at: TIME, status: oneOf(VERDICT_STATUSES), output: nullable(verdictOutput),
  validation: nullable(shape({ claimsKept: nonNegInt, claimsDropped: nonNegInt, problems: arrayOf(any) })),
  effect: nullable(shape({ points: num, lane: nullable(str), reason: str })),
  costUsd: nullable(nonNegNum), usage: nullable(shape({}, { input: nonNegNum, output: nonNegNum })),
  packBytes: nullable(nonNegNum), durationMs: nullable(nonNegNum),
});

const historyPoint = shape({
  at: TIME, headOid: nullable(str), S: num, quality: unit01, k: unit01, gem: num, lane: oneOf(LANES),
  stars: nonNegNum,
});

const repoRecord = shape({
  v: V1, id: ID, nwo: NWO, candidate: nullable(candidate), facts, score: nullable(score),
  firstSeen: nullable(shape({ at: TIME, headOid: nullable(str), S: num, stars: nonNegNum })),
  history: arrayOf(historyPoint, 50), verdict: nullable(verdict), checkedAt: nullable(TIME), gone: bool,
});

/** @type {Check} */
const feedbackRules = (v, p, e) => {
  if (v.action === 'notgood' && v.reason === null) e.push(`${p}.reason: required for notgood`);
  if (v.action !== 'notgood' && v.reason !== null) e.push(`${p}.reason: only notgood carries a reason`);
  if (v.action === 'label') {
    if (v.label === null) e.push(`${p}.label: required for label`);
  } else {
    const expected = labelFromFeedback(v);
    const want = expected === null ? 'null' : expected;
    if (v.label !== expected) e.push(`${p}.label: expected ${want} for ${v.action}`);
  }
  if (v.action === 'undo' && v.undoes === null) e.push(`${p}.undoes: required for undo`);
  if (v.action === 'snooze' && v.snoozeUntil === null) e.push(`${p}.snoozeUntil: required for snooze`);
};

const feedback = all(shape({
  v: V1, at: TIME, id: ID, nwo: NWO, action: oneOf(FEEDBACK_ACTIONS), label: nullable(oneOf(LABELS)),
  reason: nullable(oneOf(NOTGOOD_REASONS)), note: maxChars(280), blind: bool,
  undoes: nullable(anyOf(str, num)), snoozeUntil: nullable(TIME),
  context: nullable(shape({}, {
    view: nullable(str), position: nullable(num), S: nullable(num), quality: nullable(num),
    gem: nullable(num),
    k: nullable(num), stars: nullable(num), weights: nullable(str), calibration: nullable(str),
  })),
}), feedbackRules);

const taste = shape({
  v: V1, updatedAt: TIME,
  facets: recordOf(shape({ gems: nonNegInt, notmine: nonNegInt, pin: oneOf([-1, 0, 1]) })),
});

const ISO_SECOND = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z';
// The scope segment may hold a space: GitHub language names such as "Jupyter Notebook" do, and
// `scopeKey` keeps them (`lang=jupyter notebook`). Scope values never contain `:` (§3.2).
const CENSUS_KEY = new RegExp(
  `^census:\\d{4}-\\d{2}-\\d{2}:[^:\\s](?:[^:]*[^:\\s])?:${ISO_SECOND}\\.\\.${ISO_SECOND}(:\\S+)?$`,
);
const ARCHIVE_KEY = /^archive:\d{4}-\d{2}-\d{2}-\d{1,2}$/;

/** @type {Check} */
const unitRules = (v, p, e) => {
  if (!v.key.startsWith(`${v.stage}:`)) e.push(`${p}.key: must start with '${v.stage}:'`);
  else if (v.stage === 'census' && !CENSUS_KEY.test(v.key)) {
    e.push(`${p}.key: expected census:<YYYY-MM-DD>:<scope>:<FROM>..<TO>`);
  } else if (v.stage === 'archive' && !ARCHIVE_KEY.test(v.key)) {
    e.push(`${p}.key: expected archive:<YYYY-MM-DD-H>`);
  }
};

const unit = all(shape({
  v: V1, key: nonEmptyStr, stage: nonEmptyStr, state: oneOf(UNIT_STATES), attempts: nonNegInt, at: TIME,
  runId: nullable(str), out: nullable(obj), err: nullable(anyOf(str, obj)), nextAt: nullable(TIME),
}), unitRules);

const runManifest = shape({
  v: V1, runId: nonEmptyStr, startedAt: TIME, endedAt: nullable(TIME), argv: arrayOf(str),
  profile: nullable(str),
  budget: shape({ wallMs: nullable(nonNegNum), graphqlMs: nullable(nonNegNum) }),
  // A stage skipped before its first unit says why (§3.8): `budget`, `wall`, `time`, `interrupted`, …
  stages: recordOf(shape({}, { skipped: nonEmptyStr })),
  rate: shape({}, { graphql: obj, rest: obj, pauses: arrayOf(obj) }),
  exit: nullable(shape({ code: nullable(int), reason: nullable(str), resumeAt: nullable(TIME) })),
}, { units: any });

const gateRef = anyOf(str, shape({ id: nonEmptyStr }, { action: oneOf(GATE_ACTIONS), reason: str }));

/** @type {Record<string, Check>} */
const ENTRY_DETAIL = {
  description: nullable(maxChars(300)), lang: nullable(str), topics: arrayOf(str),
  createdAt: nullable(TIME), pushedAt: nullable(TIME), ageDays: nullable(num),
  band: oneOf(BANDS), S: num, pointsMax: num, coverage: unit01, quality: unit01, k: unit01,
  kBand: oneOf(CONFIDENCE_BANDS), a: unit01, gem: num, stars: nonNegNum, forks: nonNegNum,
  gain4w: nullable(num), spark: nullable(arrayOf(num)),
  chips: arrayOf(shape({
    id: str, points: num, status: oneOf(SIGNAL_STATUSES), hit: nullable(bool), label: str,
  })),
  top: arrayOf(str), negatives: arrayOf(str), descriptors: arrayOf(str),
  verdict: nullable(shape({ category: oneOf(LABELS), pitch: nullable(str), points: num })),
  facets: arrayOf(str),
  feedback: shape({ last: any, published: bool, snoozeUntil: nullable(TIME) }),
  headOid: nullable(str),
};
const IDENTITY = { id: ID, nwo: NWO, lane: oneOf(LANES), gates: arrayOf(gateRef) };
const quarantinedEntry = shape(IDENTITY, ENTRY_DETAIL);
const fullEntry = shape({ ...IDENTITY, ...ENTRY_DETAIL });

/** Quarantined entries carry only identity, lane and gate reasons (§4.3). @type {Check} */
const indexEntry = (v, p, e) => (isObj(v) && v.lane === 'quarantine' ? quarantinedEntry : fullEntry)(v, p, e);

const index = shape({
  v: V1, generatedAt: TIME,
  model: shape({ weights: nullable(obj), calibration: nullable(obj) }),
  counts: recordOf(nonNegNum), lastRun: nullable(runManifest), entries: arrayOf(indexEntry, 20000),
});

// --- configuration ---------------------------------------------------------------------------

/** @type {Check} */
const weightSignal = (v, p, e) => {
  if (!isObj(v)) {
    e.push(`${p}: expected an object, got ${describe(v)}`);
    return;
  }
  // The judge (`llm.review`, +1 / −2) may express its two weights as an array or an object.
  const points = v.kind === 'judge' ? anyOf(num, arrayOf(num), recordOf(num)) : num;
  shape({ points, kind: oneOf(SIGNAL_KINDS) }, { group: nullable(str), provisional: bool })(v, p, e);
};

/** @type {Check} */
const weightsRules = (v, p, e) => {
  if (!(v.bands.gem > v.bands.look)) e.push(`${p}.bands: gem must be greater than look`);
  if (!(v.confidenceBands.medium < v.confidenceBands.high)) {
    e.push(`${p}.confidenceBands: medium must be below high`);
  }
};

const weights = all(shape({
  version: nonEmptyStr, signals: recordOf(weightSignal), confidence: obj,
  bands: shape({ gem: num, look: num }), gem: shape({ kWeight: num, aWeight: num }),
  attention: shape({ saturation: positive }),
  eligibility: shape({ maxStars: nonNegInt, risingGain4w: nonNegNum }),
  institutions: shape({ orgMinRepos: nonNegInt }), confidenceBands: shape({ medium: unit01, high: unit01 }),
  lanes: shape({ provenK: unit01 }),
  changelog: arrayOf(shape({ version: str, date: str, change: str }, { evidence: any })),
}), weightsRules);

const calibration = shape({
  version: nonEmptyStr, method: str, a: num, b: num,
  fittedOn: shape({}, {
    labels: nonNegInt, uniform: nonNegInt, positives: nonNegInt, uniformPositives: nonNegInt,
    base: unit01, weights: str,
  }),
  fittedAt: str,
});

const institutions = shape({ version: anyOf(str, num), allow: arrayOf(str), deny: arrayOf(str) });

const durationText = is('a duration such as 10m', (v) => {
  if (typeof v !== 'string') return false;
  try {
    parseDuration(v);
    return true;
  } catch {
    return false;
  }
});

const profile = shape({
  budget: nullable(durationText), archiveHours: nonNegInt, deepTopN: nonNegInt, enrichMax: nonNegInt,
  recheckTop: nonNegInt,
});

const batchConfig = all(
  shape({ size: posInt, min: posInt, max: posInt, targetMs: positive }),
  is('min ≤ size ≤ max', (v) => v.min <= v.size && v.size <= v.max),
);

/** Every profile is checked; `quick` and `daily` must exist (§9.3). @type {Check} */
const profiles = (v, p, e) => {
  if (!isObj(v)) {
    e.push(`${p}: expected an object, got ${describe(v)}`);
    return;
  }
  for (const k of ['quick', 'daily']) if (v[k] === undefined) e.push(`${p}.${k}: required`);
  for (const [k, x] of Object.entries(v)) profile(x, `${p}.${k}`, e);
};

const defaults = shape({
  version: posInt,
  profiles,
  lagDays: nonNegInt, backfillDays: nonNegInt, maxStars: nonNegInt, ownerCapPerDay: posInt, explore: unit01,
  queueTtlDays: posInt,
  shares: shape({ census: unit01, archive: unit01, enrichUntil: unit01 }),
  governor: shape({
    graphqlMsPerMin: positive, restMsPerMin: positive, searchGapMs: nonNegNum, restConcurrency: posInt,
  }),
  batch: shape({ enrich: batchConfig, deep: batchConfig, lookup: batchConfig }),
  caps: shape({ readmeBytes: posInt, fileBytes: posInt, treeEntries: posInt, indexEntries: posInt }),
  server: shape({ port: all(int, range(1, 65535)) }),
  llm: shape({
    backend: oneOf(LLM_BACKENDS), model: nonEmptyStr, effort: nonEmptyStr, maxUsd: nonNegNum,
    perCallUsd: nonNegNum,
    endpoint: is('an http(s) URL', (v) => typeof v === 'string' && /^https?:\/\/\S+$/.test(v)),
    claudePath: nullable(str), fallbacks: bool,
    prices: recordOf(shape({ input: nonNegNum, output: nonNegNum })),
  }, { cliTimeoutMs: positive }),
});

// ---------------------------------------------------------------------------------------------
// Exported validators — each `(x) → string[]`, empty when valid
// ---------------------------------------------------------------------------------------------

const candidateOnly = validator(candidate, 'candidate');
const patchOnly = validator(candidatePatch, 'patch');

/**
 * Validate a `Candidate`, or a `CandidatePatch` when `x.patch === true` (both share a partition).
 * @param {unknown} x
 * @returns {string[]}
 */
export function validateCandidate(x) {
  return isObj(x) && x.patch === true ? patchOnly(x) : candidateOnly(x);
}

/** @type {(x: unknown) => string[]} */ export const validateFacts = validator(facts, 'facts');
/** @type {(x: unknown) => string[]} */ export const validateSignal = validator(signal, 'signal');
/** @type {(x: unknown) => string[]} */ export const validateGate = validator(gate, 'gate');
/** @type {(x: unknown) => string[]} */ export const validateDescriptor = validator(descriptor, 'descriptor');
/** @type {(x: unknown) => string[]} */ export const validateScore = validator(score, 'score');
/** @type {(x: unknown) => string[]} */ export const validateRepoRecord = validator(repoRecord, 'record');
/**
 * Validate an LLM answer against §8.4: types, enums, required keys, no extra keys, scores 1–4 and
 * `categoryConfidence` 0–1. Length caps (12 claims, 240/200/140/80/400 characters) are applied by
 * truncation in `src/llm/validate.mjs`, not rejected here.
 * @type {(x: unknown) => string[]}
 */
export const validateVerdictOutput = validator(verdictOutput, 'output');
/** @type {(x: unknown) => string[]} */ export const validateVerdict = validator(verdict, 'verdict');
/** @type {(x: unknown) => string[]} */ export const validateFeedback = validator(feedback, 'feedback');
/** @type {(x: unknown) => string[]} */ export const validateTaste = validator(taste, 'taste');
/** @type {(x: unknown) => string[]} */ export const validateUnit = validator(unit, 'unit');
/** Accepts a `RunManifest` or a `RunSummary` (no `units`). @type {(x: unknown) => string[]} */
export const validateRunManifest = validator(runManifest, 'run');
/** @type {(x: unknown) => string[]} */ export const validateIndex = validator(index, 'index');
/** @type {(x: unknown) => string[]} */ export const validateWeights = validator(weights, 'weights');
/** @type {(x: unknown) => string[]} */
export const validateCalibration = validator(calibration, 'calibration');
/** @type {(x: unknown) => string[]} */
export const validateInstitutions = validator(institutions, 'institutions');
/** @type {(x: unknown) => string[]} */ export const validateDefaults = validator(defaults, 'defaults');

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Windows device names, reserved with or without an extension. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/**
 * @param {string} segment
 * @returns {string}
 */
function safeSegment(segment) {
  let s = segment.toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  s = s.replace(/^\.+/, (m) => '%2E'.repeat(m.length)).replace(/\.+$/, (m) => '%2E'.repeat(m.length));
  if (WINDOWS_RESERVED.test(s.split('.')[0])) {
    s = `%${s.charCodeAt(0).toString(16).toUpperCase()}${s.slice(1)}`;
  }
  return s;
}

/**
 * Relative storage path of a repository, `owner/name` with each segment made file-system safe
 * (§4.1): lower-cased, every character outside `[a-z0-9._-]` replaced by `_`, leading and trailing
 * dots replaced by `%2E`, and a Windows device name (`con`, `nul`, `com1`, …) escaped by writing its
 * first character as `%XX`. Segments are joined with `/`; callers add the extension.
 * @param {string} nwo
 * @returns {string}
 */
export function repoPath(nwo) {
  const parts = typeof nwo === 'string' ? nwo.split('/') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new TypeError(`Expected owner/name, got ${describe(nwo)}`);
  }
  return `${safeSegment(parts[0])}/${safeSegment(parts[1])}`;
}

/**
 * The quality label a feedback event implies (§10.4): `gem` → G, `wip` → W, `notgood` → the label
 * of its reason (S, C, P, X, D or E), `label` → its own label; every other action → null.
 * @param {{action?: unknown, reason?: unknown, label?: unknown} | null | undefined} ev
 * @returns {Label | null}
 */
export function labelFromFeedback(ev) {
  if (!ev || typeof ev !== 'object') return null;
  switch (ev.action) {
    case 'gem': return 'G';
    case 'wip': return 'W';
    case 'notgood':
      return typeof ev.reason === 'string' && NOTGOOD_LABELS[ev.reason] ? NOTGOOD_LABELS[ev.reason] : null;
    case 'label':
      return LABELS.includes(/** @type {Label} */ (ev.label)) ? /** @type {Label} */ (ev.label) : null;
    default: return null;
  }
}
