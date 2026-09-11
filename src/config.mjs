// @ts-check
/**
 * Configuration loading (DESIGN §4.4, §9.3) and run-profile resolution (§3.8, §9.1).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  validateCalibration, validateDefaults, validateInstitutions, validateWeights,
} from './core/schema.mjs';
import { parseDuration } from './core/util.mjs';

/** @typedef {import('./core/schema.mjs').Defaults} Defaults */
/** @typedef {import('./core/schema.mjs').Weights} Weights */
/** @typedef {import('./core/schema.mjs').Calibration} Calibration */
/** @typedef {import('./core/schema.mjs').Institutions} Institutions */

/**
 * @typedef {object} Config
 * @property {Defaults} defaults
 * @property {Weights} weights
 * @property {Calibration} calibration
 * @property {Institutions} institutions
 */

/**
 * Options for one `unsung run` (§3.8, §9.1), produced by `resolveProfile`.
 * @typedef {object} RunOptions
 * @property {string} profile `quick` or `daily`
 * @property {{wallMs: number | null, graphqlMs: number | null,
 *   shares: {census: number, archive: number, enrichUntil: number}}} budget
 *   wall-clock budget and the GraphQL response-time budget (0.75 × wall); null means uncapped
 * @property {number} lagDays census day is today − lagDays
 * @property {number} backfillDays further days to census, newest first
 * @property {string | null} lang census scope `language:<L>`
 * @property {string | null} topic census scope `topic:<T>`
 * @property {'caught-up' | null} until keep running until every planned unit is done
 * @property {boolean} archive false with `--no-archive`
 * @property {number} archiveHours complete GH Archive hours to process
 * @property {number} deepTopN repositories to deepen
 * @property {number} enrichMax cap on repositories enriched
 * @property {number} recheckTop index entries to re-check
 * @property {boolean} wait false with `--no-wait`: end with exit 75 instead of waiting out a pause
 * @property {boolean} dryRun plan units and print the budget without calling GitHub
 * @property {number} maxStars
 * @property {number} ownerCapPerDay
 * @property {number} explore
 * @property {number} queueTtlDays
 * @property {Defaults['governor']} governor
 * @property {Defaults['batch']} batch
 * @property {Defaults['caps']} caps
 */

/** A configuration or usage problem; the CLI prints it and exits 2. */
export class ConfigError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
    this.code = 'ECONFIG';
    this.exitCode = 2;
  }
}

/** Share of the wall-clock budget that GraphQL response time may use (§3.8). */
export const GRAPHQL_SHARE_OF_WALL = 0.75;

/**
 * @param {string} dir
 * @param {string} file
 * @param {(x: unknown) => string[]} validate
 * @returns {any}
 */
function readConfigFile(dir, file, validate) {
  const full = path.join(dir, file);
  const shown = path.join(path.basename(dir), file);
  /** @type {string} */
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch (err) {
    const code = /** @type {{code?: string}} */ (err).code;
    if (code === 'ENOENT') throw new ConfigError(`Configuration file ${shown} is missing (looked in ${dir})`);
    throw new ConfigError(`Cannot read ${shown}: ${err instanceof Error ? err.message : String(err)}`);
  }
  /** @type {unknown} */
  let value;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new ConfigError(`${shown} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const errs = validate(value);
  if (errs.length > 0) {
    const more = errs.length > 5 ? ` (and ${errs.length - 5} more)` : '';
    throw new ConfigError(`${shown} is not valid: ${errs.slice(0, 5).join('; ')}${more}`);
  }
  return value;
}

/**
 * Load and validate `defaults.json`, `weights.json`, `calibration.json` and `institutions.json`
 * from a configuration directory. Throws `ConfigError` when a file is missing, unreadable, not JSON
 * or fails its validator.
 * @param {string} dir
 * @returns {Config}
 */
export function loadConfig(dir) {
  const d = path.resolve(dir);
  return {
    defaults: readConfigFile(d, 'defaults.json', validateDefaults),
    weights: readConfigFile(d, 'weights.json', validateWeights),
    calibration: readConfigFile(d, 'calibration.json', validateCalibration),
    institutions: readConfigFile(d, 'institutions.json', validateInstitutions),
  };
}

/**
 * The first defined value among the given flag spellings (kebab-case or camelCase).
 * @param {Record<string, unknown>} flags
 * @param {string[]} names
 * @returns {unknown}
 */
function flag(flags, names) {
  for (const n of names) if (flags[n] !== undefined) return flags[n];
  return undefined;
}

/**
 * @param {Record<string, unknown>} flags
 * @param {string[]} names
 * @param {number} fallback
 * @returns {number}
 */
function wholeNumber(flags, names, fallback) {
  const v = flag(flags, names);
  if (v === undefined || v === null) return fallback;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 0) {
    throw new ConfigError(`--${names[0]} expects a whole number of 0 or more, got '${String(v)}'`);
  }
  return n;
}

/**
 * @param {Record<string, unknown>} flags
 * @param {string[]} names
 * @returns {string | null}
 */
function text(flags, names) {
  const v = flag(flags, names);
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * @param {unknown} v
 * @returns {number | null}
 */
function budgetMs(v) {
  if (v === null) return null;
  if (typeof v === 'string' && /^(none|off|unlimited)$/i.test(v.trim())) return null;
  try {
    return parseDuration(/** @type {string | number} */ (v));
  } catch {
    throw new ConfigError(`--budget expects a duration such as 10m or 2h, got '${String(v)}'`);
  }
}

/**
 * Turn a profile from `defaults.json` plus command-line flags into `RunOptions`. Explicit flags win
 * over the profile; a flag whose value is `undefined` (or `null`, except `--budget none`) counts as
 * absent. Flags are read under their kebab-case or camelCase names (`enrich-max` or `enrichMax`).
 * `name` defaults to `flags.profile`, then `quick`.
 * @param {Defaults} defaults
 * @param {string | null | undefined} name
 * @param {Record<string, unknown>} [flags]
 * @returns {RunOptions}
 */
export function resolveProfile(defaults, name, flags = {}) {
  const profileName = String(name ?? flag(flags, ['profile']) ?? 'quick');
  const profile = Object.hasOwn(defaults.profiles, profileName) ? defaults.profiles[profileName] : undefined;
  if (!profile) {
    const choices = Object.keys(defaults.profiles).join(' or ');
    throw new ConfigError(`Unknown profile '${profileName}'; choose ${choices}`);
  }
  const budgetFlag = flag(flags, ['budget']);
  const wallMs = budgetFlag !== undefined ? budgetMs(budgetFlag)
    : profile.budget === null ? null : budgetMs(profile.budget);
  const until = text(flags, ['until']);
  if (until !== null && until !== 'caught-up') {
    throw new ConfigError(`--until accepts only 'caught-up', got '${until}'`);
  }

  const noArchive = flag(flags, ['no-archive', 'noArchive']) === true || flag(flags, ['archive']) === false;
  const noWait = flag(flags, ['no-wait', 'noWait']) === true || flag(flags, ['wait']) === false;

  return {
    profile: profileName,
    budget: {
      wallMs,
      graphqlMs: wallMs === null ? null : Math.round(GRAPHQL_SHARE_OF_WALL * wallMs),
      shares: { ...defaults.shares },
    },
    lagDays: wholeNumber(flags, ['lag', 'lagDays', 'lag-days'], defaults.lagDays),
    backfillDays: wholeNumber(flags, ['backfill', 'backfillDays', 'backfill-days'], defaults.backfillDays),
    lang: text(flags, ['lang']),
    topic: text(flags, ['topic']),
    until: until === 'caught-up' ? 'caught-up' : null,
    archive: !noArchive,
    archiveHours: wholeNumber(flags, ['archive-hours', 'archiveHours'], profile.archiveHours),
    deepTopN: wholeNumber(flags, ['deep', 'deepTopN', 'deep-top-n'], profile.deepTopN),
    enrichMax: wholeNumber(flags, ['enrich-max', 'enrichMax'], profile.enrichMax),
    recheckTop: wholeNumber(flags, ['recheck-top', 'recheckTop'], profile.recheckTop),
    wait: !noWait,
    dryRun: flag(flags, ['dry-run', 'dryRun']) === true,
    maxStars: defaults.maxStars,
    ownerCapPerDay: defaults.ownerCapPerDay,
    explore: defaults.explore,
    queueTtlDays: defaults.queueTtlDays,
    governor: structuredClone(defaults.governor),
    batch: structuredClone(defaults.batch),
    caps: structuredClone(defaults.caps),
  };
}
