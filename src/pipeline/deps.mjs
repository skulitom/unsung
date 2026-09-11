// @ts-check
/**
 * The functions the pipeline takes from other work packages (DESIGN §12.2, §12.4–§12.6), loaded
 * lazily so that the pipeline loads — and its tests run against stubs — before those modules land.
 *
 * `loadDeps(overrides)` returns one object (`Lib`) holding every function by name. A function whose
 * module is missing, fails to load or lacks the export is replaced by a stub that throws
 * `NotAvailableError` (exit 2) when called, naming the module. Tests pass stubs as overrides.
 * `CORE` holds the pure core functions, loaded once when this module is imported, so synchronous
 * helpers such as `applyScore` work without an explicit `deps`.
 */

/** A module another work package provides has not landed (or fails to load); the CLI exits 2. */
export class NotAvailableError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'NotAvailableError';
    this.code = 'ENOTAVAILABLE';
    this.exitCode = 2;
  }
}

/** Where each function comes from (relative to `src/pipeline/`). */
export const PROVIDERS = Object.freeze({
  factsFromEnrich: '../core/facts.mjs',
  mergeDeep: '../core/facts.mjs',
  factsFromRest: '../core/facts.mjs',
  prefilter: '../core/gates.mjs',
  priorOf: '../core/gates.mjs',
  isManifest: '../core/ecosystems.mjs',
  scoreFacts: '../core/score.mjs',
  explain: '../core/explain.mjs',
  verdictSignal: '../core/verdict.mjs',
  ENRICH_FRAGMENT: '../github/queries.mjs',
  DEEP_FRAGMENT: '../github/queries.mjs',
  aliasedRepoQuery: '../github/queries.mjs',
  readmeRepairQuery: '../github/queries.mjs',
  filesQuery: '../github/queries.mjs',
  existsQuery: '../github/queries.mjs',
  runBatched: '../github/batch.mjs',
  recursiveTree: '../github/rest.mjs',
  activity: '../github/rest.mjs',
  starHistory: '../github/rest.mjs',
  restFallback: '../github/rest.mjs',
  createBudget: '../github/governor.mjs',
  scopeKey: '../github/search.mjs',
  seedFromNode: '../sources/seed.mjs',
  passesBase: '../sources/seed.mjs',
  planDays: '../sources/census.mjs',
  censusDay: '../sources/census.mjs',
  completeHours: '../sources/archive.mjs',
  archiveHour: '../sources/archive.mjs',
  sampleUniform: '../sources/idwalk.mjs',
});

/** @typedef {keyof typeof PROVIDERS} DepName */

/**
 * Every provider module, imported with a literal specifier (the layer test checks each one).
 * @type {Record<string, () => Promise<any>>}
 */
const IMPORTERS = {
  '../core/facts.mjs': () => import('../core/facts.mjs'),
  '../core/gates.mjs': () => import('../core/gates.mjs'),
  '../core/ecosystems.mjs': () => import('../core/ecosystems.mjs'),
  '../core/score.mjs': () => import('../core/score.mjs'),
  '../core/explain.mjs': () => import('../core/explain.mjs'),
  '../core/verdict.mjs': () => import('../core/verdict.mjs'),
  '../github/queries.mjs': () => import('../github/queries.mjs'),
  '../github/batch.mjs': () => import('../github/batch.mjs'),
  '../github/rest.mjs': () => import('../github/rest.mjs'),
  '../github/governor.mjs': () => import('../github/governor.mjs'),
  '../github/search.mjs': () => import('../github/search.mjs'),
  '../sources/seed.mjs': () => import('../sources/seed.mjs'),
  '../sources/census.mjs': () => import('../sources/census.mjs'),
  '../sources/archive.mjs': () => import('../sources/archive.mjs'),
  '../sources/idwalk.mjs': () => import('../sources/idwalk.mjs'),
};

/** The pure core functions (no network, no process). */
export const CORE_NAMES = Object.freeze([
  'factsFromEnrich', 'mergeDeep', 'factsFromRest', 'prefilter', 'priorOf', 'isManifest', 'scoreFacts',
  'explain', 'verdictSignal',
]);

/**
 * The functions the pipeline uses, by name (see `PROVIDERS`). Unavailable ones throw when called.
 * @typedef {Record<string, any>} Lib
 */

/** Property on a `Lib` listing what could not be loaded (non-enumerable). */
const MISSING = Symbol('missing');

/**
 * @param {unknown} err
 * @returns {string}
 */
function reasonOf(err) {
  const e = /** @type {{code?: string, message?: string}} */ (err ?? {});
  if (e.code === 'ERR_MODULE_NOT_FOUND') return 'it has not been written yet';
  const msg = String(e.message ?? err);
  return `it failed to load: ${msg.length > 160 ? `${msg.slice(0, 159)}…` : msg}`;
}

/**
 * Load the functions the pipeline needs. Overrides win (tests pass stubs here) and their modules
 * are never imported.
 * @param {Record<string, any>} [overrides]
 * @param {{names?: readonly string[]}} [opts] which functions to load (default all)
 * @returns {Promise<Lib>}
 */
export async function loadDeps(overrides = {}, { names = Object.keys(PROVIDERS) } = {}) {
  /** @type {Record<string, string>} */
  const providers = PROVIDERS;
  const wanted = names.filter((n) => !Object.hasOwn(overrides, n) && providers[n]);
  const files = [...new Set(wanted.map((n) => providers[n]))];
  /** @type {Map<string, {mod?: any, err?: unknown}>} */
  const loaded = new Map();
  await Promise.all(files.map(async (file) => {
    try {
      loaded.set(file, { mod: await IMPORTERS[file]() });
    } catch (err) {
      loaded.set(file, { err });
    }
  }));

  /** @type {Lib} */
  const lib = {};
  /** @type {string[]} */
  const missing = [];
  for (const name of Object.keys(providers)) {
    if (Object.hasOwn(overrides, name)) {
      lib[name] = overrides[name];
      continue;
    }
    const file = providers[name];
    const got = loaded.get(file);
    const value = got?.mod?.[name];
    if (value !== undefined) {
      lib[name] = value;
      continue;
    }
    const where = `src/${file.slice(3)}`;
    const why = !got ? 'it was not asked for' : got.err ? reasonOf(got.err) : `it does not export ${name}`;
    const message = `${name} (from ${where}) is not yet available: ${why}`;
    if (got) missing.push(`${name} (${where}: ${why})`);
    if (/^[A-Z_]+$/.test(name)) {
      Object.defineProperty(lib, name, {
        enumerable: true,
        get() {
          throw new NotAvailableError(message);
        },
      });
    } else {
      lib[name] = () => {
        throw new NotAvailableError(message);
      };
    }
  }
  for (const [k, v] of Object.entries(overrides)) if (!Object.hasOwn(lib, k)) lib[k] = v;
  Object.defineProperty(lib, MISSING, { value: missing, enumerable: false });
  return lib;
}

/**
 * What a `Lib` could not load, as `name (module: reason)` strings.
 * @param {Lib} lib
 * @returns {string[]}
 */
export function missingDeps(lib) {
  return [.../** @type {string[]} */ (lib?.[/** @type {any} */ (MISSING)] ?? [])];
}

/** The pure core functions, loaded when this module is first imported. */
export const CORE = await loadDeps({}, { names: CORE_NAMES });
