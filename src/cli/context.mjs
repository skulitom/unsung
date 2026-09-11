// @ts-check
/**
 * The context every command receives (DESIGN §12.1): configuration, data directory, logger, clock,
 * seeded randomness, and lazy access to the store (WP2) and the GitHub client (WP1). The store and
 * client modules are imported only when first asked for, so commands that need neither never load
 * them, and a missing module is reported as "not yet available".
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { createLog } from '../log.mjs';
import { redact, registerSecret } from '../secrets.mjs';
import { fnv1a, mulberry32 } from '../core/util.mjs';

/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('../log.mjs').Log} Log */
/** @typedef {any} Store the `Store` interface of `src/store/store.mjs` (§12.3) */
/** @typedef {any} Client the `Client` of `src/github/client.mjs` (§12.2) */
/** @typedef {any} Governor the `Governor` of `src/github/governor.mjs` (§12.2) */

/**
 * @typedef {object} Clock
 * @property {() => string} now ISO-8601 UTC
 * @property {() => number} ms milliseconds since the epoch
 * @property {(ms: number, opts?: {signal?: AbortSignal}) => Promise<void>} sleep
 */

/**
 * @typedef {object} Ctx
 * @property {Config} config
 * @property {string} configDir absolute
 * @property {string} dataDir absolute
 * @property {Log} log
 * @property {() => string} now current time, ISO-8601 UTC
 * @property {() => number} rand seeded generator, floats in [0, 1)
 * @property {number} seed the seed behind `rand` (`--seed`, else derived from the start time)
 * @property {Clock} clock the same time source as `now`, with `ms()` and `sleep()`
 * @property {Record<string, any>} flags parsed flags
 * @property {Record<string, string | undefined>} env
 * @property {string[]} argv the raw arguments, for the run manifest
 * @property {string} version package version
 * @property {string} userAgent `unsung/<version> (+local; read-only)` (§3.10)
 * @property {AbortSignal} signal aborted on the first Ctrl-C; long work should listen and stop cleanly
 * @property {(text: string) => void} print a line on stdout (redacted)
 * @property {(value: unknown) => void} printJson pretty JSON on stdout (redacted)
 * @property {() => Promise<Store>} store `openStore(dataDir, {now, log})`, opened once
 * @property {() => Promise<Client>} client the read-only GitHub client, created once
 * @property {() => Promise<Governor>} governor the client's governor
 * @property {() => Promise<{client: Client, governor: Governor, tokenSource: string}>} github
 */

/**
 * Loaders for the lazily imported modules; tests replace them.
 * @typedef {object} Imports
 * @property {() => Promise<any>} [store] `src/store/store.mjs`
 * @property {() => Promise<any>} [token] `src/github/token.mjs`
 * @property {() => Promise<any>} [governor] `src/github/governor.mjs`
 * @property {() => Promise<any>} [client] `src/github/client.mjs`
 */

/** Root of the package (the directory holding `package.json`). */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The bundled configuration directory, used when `--config` is not given. */
export const DEFAULT_CONFIG_DIR = path.join(PACKAGE_ROOT, 'config');

/** Environment variables whose values are secrets and must never be logged (§3.9, §8.6). */
export const SECRET_ENV = Object.freeze([
  'GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
]);

/** A module another work package provides has not landed yet; the CLI exits 2. */
export class NotAvailableError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'NotAvailableError';
    this.code = 'ENOTAVAILABLE';
    this.exitCode = 2;
  }
}

/** @returns {string} the version in package.json */
export function packageVersion() {
  try {
    return String(JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version);
  } catch {
    return '0.0.0';
  }
}

/** @type {Required<Imports>} */
const DEFAULT_IMPORTS = {
  store: () => import('../store/store.mjs'),
  token: () => import('../github/token.mjs'),
  governor: () => import('../github/governor.mjs'),
  client: () => import('../github/client.mjs'),
};

/**
 * @param {() => Promise<any>} importer
 * @param {string} what
 * @returns {Promise<any>}
 */
async function load(importer, what) {
  try {
    return await importer();
  } catch (err) {
    const code = /** @type {{code?: string}} */ (err)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND') {
      const detail = err instanceof Error ? err.message : String(err);
      throw new NotAvailableError(`${what} is not yet available (${detail})`);
    }
    throw err;
  }
}

/**
 * @param {unknown} v
 * @returns {string}
 */
function toIso(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || v instanceof Date) return new Date(v).toISOString();
  throw new TypeError('now() must return an ISO string, a Date or milliseconds');
}

/**
 * @param {number} ms
 * @param {{signal?: AbortSignal}} [opts]
 * @returns {Promise<void>}
 */
function sleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @param {unknown} now
 * @param {Clock | undefined} clock
 * @returns {Clock}
 */
function makeClock(now, clock) {
  if (clock) return clock;
  if (now === undefined || now === null) {
    return { now: () => new Date().toISOString(), ms: () => Date.now(), sleep };
  }
  const nowFn = typeof now === 'function' ? () => toIso(now()) : () => toIso(now);
  return { now: nowFn, ms: () => Date.parse(nowFn()), sleep };
}

/**
 * Build the command context.
 * @param {object} [opts]
 * @param {Record<string, any>} [opts.flags] parsed flags (global flags included)
 * @param {Record<string, string | undefined>} [opts.env] default `process.env`
 * @param {(() => string | number | Date) | string} [opts.now] fixed or injected time
 * @param {Clock} [opts.clock] a whole clock (for example a fake one); wins over `now`
 * @param {string[]} [opts.argv]
 * @param {AbortSignal} [opts.signal]
 * @param {Log} [opts.log] replaces the logger built from the flags
 * @param {{write(chunk: string): unknown}} [opts.stream] where logs go (default stderr)
 * @param {{write(chunk: string): unknown}} [opts.stdout] where output goes (default stdout)
 * @param {Imports} [opts.imports]
 * @returns {Promise<Ctx>}
 */
export async function createContext(opts = {}) {
  const {
    flags = {}, env = process.env, now, clock, argv = [], signal, log, stream, stdout, imports = {},
  } = opts;
  for (const name of SECRET_ENV) registerSecret(env[name]);

  const theClock = makeClock(now, clock);
  const configDir = path.resolve(typeof flags.config === 'string' ? flags.config : DEFAULT_CONFIG_DIR);
  const dataDir = path.resolve(typeof flags.data === 'string' ? flags.data : env.UNSUNG_DATA || 'data');
  const logger = log ?? createLog({
    level: flags.verbose ? 'debug' : flags.quiet ? 'warn' : 'info',
    json: Boolean(flags.json),
    stream: stream ?? process.stderr,
    now: theClock.now,
  });
  const config = loadConfig(configDir);
  const seed = typeof flags.seed === 'number' && Number.isFinite(flags.seed)
    ? flags.seed
    : fnv1a(theClock.now());
  const rand = mulberry32(seed);
  const version = packageVersion();
  const userAgent = `unsung/${version} (+local; read-only)`;
  const out = stdout ?? process.stdout;
  const loaders = { ...DEFAULT_IMPORTS, ...imports };

  /** @type {Promise<Store> | null} */
  let storePromise = null;
  /** @type {Promise<{client: Client, governor: Governor, tokenSource: string}> | null} */
  let githubPromise = null;

  /** @type {Ctx} */
  const ctx = {
    config,
    configDir,
    dataDir,
    log: logger,
    now: theClock.now,
    rand,
    seed,
    clock: theClock,
    flags,
    env,
    argv,
    version,
    userAgent,
    signal: signal ?? new AbortController().signal,
    print: (line) => {
      out.write(`${redact(line)}\n`);
    },
    printJson: (value) => {
      out.write(`${redact(JSON.stringify(value, null, 2))}\n`);
    },
    store() {
      storePromise ??= (async () => {
        const mod = await load(loaders.store, 'The store (src/store/store.mjs)');
        return mod.openStore(dataDir, { now: theClock.now, log: logger });
      })();
      storePromise.catch(() => {
        storePromise = null;
      });
      return storePromise;
    },
    github() {
      githubPromise ??= (async () => {
        const [tokenMod, governorMod, clientMod] = await Promise.all([
          load(loaders.token, 'GitHub access (src/github/token.mjs)'),
          load(loaders.governor, 'GitHub access (src/github/governor.mjs)'),
          load(loaders.client, 'GitHub access (src/github/client.mjs)'),
        ]);
        const { token, source } = await tokenMod.getToken({ env });
        registerSecret(token);
        const governor = governorMod.createGovernor(config.defaults.governor, { clock: theClock });
        const store = await ctx.store();
        const client = clientMod.createClient({
          token, governor, cache: store.httpCache, fetch: globalThis.fetch, log: logger, userAgent,
        });
        logger.debug('GitHub client ready', { tokenSource: source });
        return { client, governor, tokenSource: String(source) };
      })();
      githubPromise.catch(() => {
        githubPromise = null;
      });
      return githubPromise;
    },
    async client() {
      return (await ctx.github()).client;
    },
    async governor() {
      return (await ctx.github()).governor;
    },
  };
  return ctx;
}
