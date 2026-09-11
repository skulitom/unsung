// @ts-check
/**
 * LLM backends for the optional review (DESIGN §8.6).
 *
 * - `claude-cli`: headless Claude Code, billed to the user's Claude plan. The executable is spawned
 *   directly with an argument array (never through a shell), in a fresh empty directory, with no
 *   GitHub token in its environment; the pack goes on stdin, so no repository text can reach a
 *   command line.
 * - `anthropic-api`: Anthropic's official SDK, `@anthropic-ai/sdk`, loaded by dynamic `import()` only
 *   when this backend is chosen. It is not a dependency: the user installs it. The loader is
 *   injectable so tests pass a fake module.
 *
 * Both return a `RawResult`; `src/llm/review.mjs` validates the output and decides what to record.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact, registerSecret } from '../secrets.mjs';
import { RUBRIC_TEXT, VERDICT_SCHEMA } from './rubric.mjs';
import { parseApiResponse, parseCliEnvelope, parseCliOutput } from './validate.mjs';

/** @typedef {import('./pack.mjs').Pack} Pack */

/**
 * What a backend call returned, before validation.
 * @typedef {object} RawResult
 * @property {boolean} ok true when an answer was parsed into `output`
 * @property {Record<string, any>} [output] the parsed, not yet validated, verdict JSON
 * @property {string} [text] the raw answer text (repository-influenced: never log it)
 * @property {number} costUsd
 * @property {boolean} [costEstimated] true when `costUsd` is an estimate: a `claude` call killed
 *   by the timeout or an interruption prints no cost, so it is charged its per-call cap
 * @property {{input: number, output: number, cacheRead?: number, cacheWrite?: number}} usage
 *   `input` counts every input token, cached or not
 * @property {string | null} stopReason
 * @property {{category: string | null, explanation?: string | null}} [refusal]
 * @property {{kind: ErrorKind, message: string, status?: number | null, type?: string | null}} [error]
 * @property {string} [model] the model that answered, when the backend says
 */

/**
 * `auth` and `model` disable the backend for the run; `rate` ends the run; `spawn` means the
 * executable could not start; the others make that repository's verdict `error`.
 * @typedef {'auth' | 'model' | 'rate' | 'server' | 'api' | 'timeout' | 'parse' | 'max_tokens' | 'cli'
 *   | 'spawn' | 'aborted'} ErrorKind
 */

/**
 * @typedef {object} Backend
 * @property {'claude-cli' | 'anthropic-api'} name
 * @property {string} model
 * @property {(pack: Pack | string, opts?: {signal?: AbortSignal}) => Promise<RawResult>} call
 */

/** Default model (§9.3). */
export const DEFAULT_MODEL = 'claude-opus-5';

/** Default effort for both backends (`defaults.json#llm.effort`); Claude Code's own default is higher. */
export const DEFAULT_EFFORT = 'high';

/**
 * `claude-cli` time limit; the process tree is killed after it (§8.6). `defaults.json#llm.cliTimeoutMs`
 * overrides it.
 */
export const CLI_TIMEOUT_MS = 180_000;

/** `anthropic-api` client settings (§8.6). */
export const API_TIMEOUT_MS = 300_000;
export const API_MAX_RETRIES = 2;
export const API_MAX_TOKENS = 16000;

/** Beta flag for server-side refusal fallbacks (§8.6); omitted with `--no-fallbacks`. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Prices in dollars per million tokens, used when `defaults.json#llm.prices` lacks a model. */
export const DEFAULT_PRICES = Object.freeze({ 'claude-opus-5': Object.freeze({ input: 5, output: 25 }) });

/** The instruction printed when the SDK is missing (§8.6). */
export const SDK_INSTALL_HINT = 'npm install @anthropic-ai/sdk';

/** Environment variables that hold GitHub tokens; never passed to a child process (§3.9). */
export const GITHUB_TOKEN_VARS = Object.freeze([
  'GITHUB_TOKEN', 'GH_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GITHUB_PAT',
]);
const TOKEN_SHAPE = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/;

const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

/** The official SDK is not installed or cannot be loaded; the CLI prints how to install it and exits 2. */
export class SdkMissingError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'SdkMissingError';
    this.code = 'ESDKMISSING';
    this.exitCode = 2;
  }
}

/** No usable `claude` executable was found; the CLI exits 2. */
export class ClaudeNotFoundError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ClaudeNotFoundError';
    this.code = 'ENOCLAUDE';
    this.exitCode = 2;
  }
}

/**
 * An environment variable, matched case-insensitively (Windows spells `Path`, `SystemRoot`, …).
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {string | undefined}
 */
function envValue(env, name) {
  if (typeof env[name] === 'string') return env[name];
  const upper = name.toUpperCase();
  const hit = Object.keys(env).find((k) => k.toUpperCase() === upper);
  return hit === undefined ? undefined : env[hit];
}

/**
 * @typedef {object} FsLike
 * @property {(p: string) => {isFile(): boolean}} statSync
 * @property {(p: string, enc: 'utf8') => string} readFileSync
 */

/**
 * Find the `claude` executable (§8.6): `UNSUNG_CLAUDE`, else `llm.claudePath`; else the first
 * `claude.exe` (Windows) or `claude` (POSIX) in an absolute `PATH` directory; else
 * `~/.local/bin/claude[.exe]`; else, on Windows, a `claude.cmd` shim whose only command is
 * `"<dir>\claude.exe" %*`, which resolves to that executable. Any other shim is refused. Returns
 * null when nothing usable is found.
 * @param {object} [opts]
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {string} [opts.platform]
 * @param {FsLike} [opts.fs]
 * @param {string | null} [opts.claudePath] `defaults.json#llm.claudePath`
 * @returns {string | null}
 */
export function resolveClaudeExe(opts = {}) {
  const { env = process.env, platform = process.platform, fs = nodeFs, claudePath } = opts;
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const exeName = win ? 'claude.exe' : 'claude';
  const isFile = (/** @type {string} */ p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const readShim = (/** @type {string} */ p) => {
    /** @type {string} */
    let text;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch {
      return null;
    }
    const lines = text.split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !/^@?echo\s+off$/i.test(l) && !/^(@?rem(\s|$)|::)/i.test(l));
    if (lines.length !== 1) return null;
    const m = /^@?"([^"%]+\\claude\.exe)"\s+%\*$/i.exec(lines[0]);
    if (!m || !path.win32.isAbsolute(m[1])) return null;
    return isFile(m[1]) ? m[1] : null;
  };

  const configured = envValue(env, 'UNSUNG_CLAUDE') || claudePath;
  if (configured) {
    const p = String(configured).trim();
    if (!P.isAbsolute(p)) return null;
    if (win && /\.(cmd|bat)$/i.test(p)) return readShim(p);
    return isFile(p) ? p : null;
  }
  const dirs = String(envValue(env, 'PATH') ?? '').split(P.delimiter)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter((d) => d && P.isAbsolute(d));
  for (const d of dirs) {
    const candidate = P.join(d, exeName);
    if (isFile(candidate)) return candidate;
  }
  const home = win ? envValue(env, 'USERPROFILE') : envValue(env, 'HOME');
  if (home && P.isAbsolute(home)) {
    const candidate = P.join(home, '.local', 'bin', exeName);
    if (isFile(candidate)) return candidate;
  }
  if (win) {
    for (const d of dirs) {
      const shim = P.join(d, 'claude.cmd');
      if (isFile(shim)) return readShim(shim);
    }
  }
  return null;
}

/**
 * A copy of the environment for a child process without any GitHub token: the variables in
 * `GITHUB_TOKEN_VARS` (any case) and any variable whose value looks like a GitHub token are left out.
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function childEnv(env) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v !== 'string') continue;
    if (GITHUB_TOKEN_VARS.includes(k.toUpperCase()) || TOKEN_SHAPE.test(v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * The `claude` argument array of §8.6. Nothing in it comes from the repository. There is no
 * `--json-schema`: with it the CLI answers through a structured-output tool round trip (two turns,
 * measured) that overran its budget with no answer. The rubric states the output shape instead,
 * `--tools ""` leaves the model no tool, so the call is one turn, and the answer is validated
 * locally.
 * @param {{model: string, perCallUsd: number, rubricPath: string, effort?: string}} opts
 * @returns {string[]}
 */
export function cliArgs({ model, perCallUsd, rubricPath, effort = DEFAULT_EFFORT }) {
  return ['-p', '--output-format', 'json', '--tools', '', '--safe-mode', '--strict-mcp-config',
    '--no-session-persistence', '--model', model, '--effort', effort, '--max-budget-usd', String(perCallUsd),
    '--system-prompt-file', rubricPath];
}

/**
 * Kill a child and everything it started: `taskkill /T /F` on Windows, the process group elsewhere.
 * @param {any} child
 * @param {string} platform
 * @param {Record<string, string | undefined>} env
 */
function defaultKillTree(child, platform, env) {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined)) return;
  if (platform === 'win32' && child.pid) {
    const root = envValue(env, 'SystemRoot') || 'C:\\Windows';
    try {
      const taskkill = path.win32.join(root, 'System32', 'taskkill.exe');
      const args = ['/pid', String(child.pid), '/T', '/F'];
      const k = nodeSpawn(taskkill, args, { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    if (child.pid) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * @typedef {object} ProcessRun
 * @property {number | null} code
 * @property {string} stdout
 * @property {string} stderr
 * @property {boolean} timedOut
 * @property {boolean} aborted
 * @property {boolean} spawned false when no process was started (already interrupted, or spawn threw)
 * @property {any} [spawnError]
 */

/**
 * @param {object} o
 * @param {typeof nodeSpawn} o.spawn
 * @param {string} o.exe
 * @param {string[]} o.args
 * @param {string} o.cwd
 * @param {Record<string, string>} o.env
 * @param {string} o.input
 * @param {number} o.timeoutMs
 * @param {AbortSignal} [o.signal]
 * @param {string} o.platform
 * @param {(child: any) => void} o.kill
 * @returns {Promise<ProcessRun>}
 */
function runProcess({ spawn, exe, args, cwd, env, input, timeoutMs, signal, platform, kill }) {
  return new Promise((resolve) => {
    const empty = { code: null, stdout: '', stderr: '', timedOut: false, aborted: false, spawned: false };
    if (signal?.aborted) {
      resolve({ ...empty, aborted: true });
      return;
    }
    /** @type {any} */
    let child;
    try {
      child = spawn(exe, args, {
        cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
        detached: platform !== 'win32',
      });
    } catch (err) {
      resolve({ ...empty, spawnError: err });
      return;
    }
    /** @type {Buffer[]} */
    const out = [];
    /** @type {Buffer[]} */
    const errs = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const toBuf = (/** @type {unknown} */ c) => (Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8'));
    const timer = setTimeout(() => {
      timedOut = true;
      kill(child);
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    /** @param {Partial<ProcessRun>} extra */
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({
        ...empty, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errs).toString('utf8'),
        timedOut, aborted, spawned: true, ...extra,
      });
    };
    child.stdout?.on('data', (/** @type {unknown} */ c) => {
      if (outBytes >= MAX_STDOUT) return;
      const b = toBuf(c);
      out.push(b);
      outBytes += b.length;
    });
    child.stderr?.on('data', (/** @type {unknown} */ c) => {
      if (errBytes >= MAX_STDERR) return;
      const b = toBuf(c);
      errs.push(b);
      errBytes += b.length;
    });
    child.stdin?.on('error', () => {
      // EPIPE when the child exits before reading all of stdin; the exit code tells the story.
    });
    child.on('error', (/** @type {any} */ err) => finish({ spawnError: err }));
    child.on('close', (/** @type {number | null} */ code) => finish({ code }));
    child.stdin?.end(input, 'utf8');
  });
}

/**
 * @param {unknown} v
 * @returns {number}
 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Normalise a usage object (API or CLI field names) to `{input, output, cacheRead, cacheWrite}`,
 * where `input` counts every input token.
 * @param {any} u
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}}
 */
export function normaliseUsage(u) {
  if (!u || typeof u !== 'object') return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if ('input_tokens' in u || 'output_tokens' in u) {
    const cacheRead = num(u.cache_read_input_tokens);
    const cacheWrite = num(u.cache_creation_input_tokens);
    const input = num(u.input_tokens) + cacheRead + cacheWrite;
    return { input, output: num(u.output_tokens), cacheRead, cacheWrite };
  }
  return {
    input: num(u.input), output: num(u.output), cacheRead: num(u.cacheRead), cacheWrite: num(u.cacheWrite),
  };
}

/**
 * Cost of a call in dollars (§8.6): input at the model's input price, output at its output price,
 * cache writes at 1.25× and cache reads at 0.1× the input price, all per million tokens. A model
 * missing from `prices` is charged at the most expensive listed price.
 * @param {any} usage API usage, CLI usage, or `{input, output, cacheRead, cacheWrite}`
 * @param {string} model
 * @param {Record<string, {input: number, output: number}>} [prices]
 * @returns {number}
 */
export function estimateCost(usage, model, prices = DEFAULT_PRICES) {
  const table = prices && Object.keys(prices).length > 0 ? prices : DEFAULT_PRICES;
  const listed = Object.values(table);
  const price = table[model] ?? {
    input: Math.max(...listed.map((p) => num(p.input))),
    output: Math.max(...listed.map((p) => num(p.output))),
  };
  const u = normaliseUsage(usage);
  const uncached = Math.max(0, u.input - u.cacheRead - u.cacheWrite);
  const dollars = uncached * price.input + u.cacheWrite * price.input * 1.25 + u.cacheRead * price.input * 0.1
    + u.output * price.output;
  return dollars / 1e6;
}

/**
 * @param {string} stderr
 * @returns {string}
 */
function stderrHint(stderr) {
  const line = redact(String(stderr ?? '').trim().split(/\r?\n/)[0] ?? '').slice(0, 120);
  return line ? `: ${line}` : '';
}

/**
 * Token usage of a `claude` run: summed over `modelUsage` (every model and turn) when it has counts,
 * else the top-level `usage`, which the CLI can leave at zero (measured on 11 September 2026).
 * @param {any} env the result envelope
 * @returns {{input: number, output: number, cacheRead: number, cacheWrite: number}}
 */
function cliUsage(env) {
  const models = env?.modelUsage && typeof env.modelUsage === 'object' ? Object.values(env.modelUsage) : [];
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const m of models) {
    input += num(m?.inputTokens);
    output += num(m?.outputTokens);
    cacheRead += num(m?.cacheReadInputTokens);
    cacheWrite += num(m?.cacheCreationInputTokens);
  }
  if (input + output + cacheRead + cacheWrite > 0) {
    return { input: input + cacheRead + cacheWrite, output, cacheRead, cacheWrite };
  }
  return normaliseUsage(env?.usage);
}

/**
 * Turn a finished `claude` process into a RawResult (§8.5 step 1, §8.6). A call killed by the
 * timeout or an interruption prints no result, so what it spent is unknown, not zero: it is charged
 * `perCallUsd` with `costEstimated: true` (a floor, since one turn can overshoot the cap), unless
 * it managed to print its cost. A call that never started costs nothing.
 * @param {ProcessRun} run
 * @param {{perCallUsd?: number, timeoutMs?: number}} [opts]
 * @returns {RawResult}
 */
function interpretCli(run, { perCallUsd = 0, timeoutMs = CLI_TIMEOUT_MS } = {}) {
  /** @type {RawResult} */
  const base = { ok: false, costUsd: 0, usage: normaliseUsage(null), stopReason: null };
  if (run.spawnError) {
    const code = run.spawnError?.code ? ` (${run.spawnError.code})` : '';
    return { ...base, error: { kind: 'spawn', message: `Could not start claude${code}` } };
  }
  if (run.aborted || run.timedOut) {
    const printed = parseCliEnvelope(run.stdout);
    const reported = typeof printed?.total_cost_usd === 'number' && Number.isFinite(printed.total_cost_usd)
      ? printed.total_cost_usd : null;
    /** @type {{costUsd: number, costEstimated?: boolean}} */
    const charge = run.spawned === false ? { costUsd: 0 }
      : reported !== null ? { costUsd: reported } : { costUsd: num(perCallUsd), costEstimated: true };
    if (run.aborted) return { ...base, ...charge, error: { kind: 'aborted', message: 'Interrupted' } };
    const message = `claude did not answer within ${timeoutMs / 1000} s`;
    return { ...base, ...charge, error: { kind: 'timeout', message } };
  }
  const env = parseCliEnvelope(run.stdout);
  if (!env) {
    const message = `claude exited with code ${run.code} and printed no result${stderrHint(run.stderr)}`;
    return { ...base, error: { kind: 'cli', message } };
  }
  const models = env.modelUsage && typeof env.modelUsage === 'object' ? Object.keys(env.modelUsage) : [];
  /** @type {RawResult} */
  const common = {
    ok: false,
    costUsd: num(env.total_cost_usd),
    usage: cliUsage(env),
    stopReason: typeof env.stop_reason === 'string' ? env.stop_reason : null,
    ...(models.length > 0 ? { model: models[0] } : {}),
  };
  if (common.stopReason === 'refusal') {
    const category = typeof env.stop_details?.category === 'string' ? env.stop_details.category : null;
    return { ...common, refusal: { category } };
  }
  if (common.stopReason === 'max_tokens' && typeof env.api_error_status !== 'number') {
    return { ...common, error: { kind: 'max_tokens', message: 'The answer reached max_tokens before it ended' } };
  }
  if (env.is_error !== false || env.subtype !== 'success') {
    const status = typeof env.api_error_status === 'number' ? env.api_error_status : null;
    /** @type {ErrorKind} */
    const kind = status === 401 || status === 403 ? 'auth' : status === 404 ? 'model'
      : status === 429 ? 'rate' : status !== null && status >= 500 ? 'server' : 'cli';
    const subtype = String(env.subtype ?? 'unknown').slice(0, 40);
    const message = `claude reported an error (${subtype}${status ? `, HTTP ${status}` : ''})`;
    return { ...common, error: { kind, status, message } };
  }
  try {
    const output = parseCliOutput(run.stdout);
    return { ...common, ok: true, output, ...(typeof env.result === 'string' ? { text: env.result } : {}) };
  } catch (err) {
    return { ...common, error: { kind: 'parse', message: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Review one pack with headless Claude Code (§8.6). A fresh temporary directory holds an empty
 * working directory (the child's cwd) and `rubric.md` (the system prompt); it is removed afterwards.
 * @param {Pack | string} pack
 * @param {object} opts
 * @param {string} opts.exe from `resolveClaudeExe`
 * @param {string} [opts.model]
 * @param {number} [opts.perCallUsd] passed as `--max-budget-usd`
 * @param {Record<string, string | undefined>} [opts.env] default `process.env` (GitHub tokens removed)
 * @param {string} [opts.platform]
 * @param {typeof nodeSpawn} [opts.spawn]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.tmpDir] default `os.tmpdir()`
 * @param {AbortSignal} [opts.signal]
 * @param {(child: any) => void} [opts.killTree]
 * @param {string} [opts.rubric]
 * @param {string} [opts.effort] passed as `--effort` (default `high`)
 * @returns {Promise<RawResult>}
 */
export async function callClaudeCli(pack, opts) {
  const {
    exe, model = DEFAULT_MODEL, perCallUsd = 0.5, env = process.env, platform = process.platform,
    spawn = nodeSpawn, timeoutMs = CLI_TIMEOUT_MS, tmpDir = os.tmpdir(), signal, killTree,
    rubric = RUBRIC_TEXT, effort = DEFAULT_EFFORT,
  } = opts ?? {};
  if (!exe) throw new ClaudeNotFoundError('No claude executable was given');
  const input = typeof pack === 'string' ? pack : pack.text;
  const root = nodeFs.mkdtempSync(path.join(tmpDir, 'unsung-review-'));
  try {
    const cwd = path.join(root, 'work');
    nodeFs.mkdirSync(cwd);
    const rubricPath = path.join(root, 'rubric.md');
    nodeFs.writeFileSync(rubricPath, rubric, 'utf8');
    const run = await runProcess({
      spawn, exe, args: cliArgs({ model, perCallUsd, rubricPath, effort }), cwd, env: childEnv(env), input,
      timeoutMs, signal, platform, kill: killTree ?? ((child) => defaultKillTree(child, platform, env)),
    });
    return interpretCli(run, { perCallUsd, timeoutMs });
  } finally {
    try {
      nodeFs.rmSync(root, { recursive: true, force: true });
    } catch {
      // a leftover empty temporary directory is harmless
    }
  }
}

/** Loads the official SDK; the one bare package specifier allowed in the codebase (§8.6). */
export const defaultLoadSdk = () => import('@anthropic-ai/sdk');

/**
 * Load the SDK and return its client class. Throws `SdkMissingError` (exit 2) with the install
 * instruction when the package is missing or unusable.
 * @param {() => Promise<any>} [loadSdk]
 * @returns {Promise<any>}
 */
export async function loadAnthropic(loadSdk = defaultLoadSdk) {
  /** @type {any} */
  let mod;
  try {
    mod = await loadSdk();
  } catch (err) {
    const missing = /** @type {{code?: string}} */ (err)?.code === 'ERR_MODULE_NOT_FOUND';
    const detail = missing ? 'is not installed'
      : `could not be loaded (${redact(String(err)).slice(0, 120)})`;
    throw new SdkMissingError(`The anthropic-api backend needs Anthropic's official SDK, which ${detail}. `
      + `Run '${SDK_INSTALL_HINT}' in the Unsung directory, or use --backend claude-cli.`);
  }
  const Anthropic = mod?.default ?? mod?.Anthropic;
  if (typeof Anthropic !== 'function') {
    throw new SdkMissingError('@anthropic-ai/sdk does not export a client. '
      + `Run '${SDK_INSTALL_HINT}' to reinstall it.`);
  }
  return Anthropic;
}

/**
 * A client with the §8.6 settings. The SDK resolves credentials itself.
 * @param {any} Anthropic the SDK's default export
 * @param {{endpoint?: string | null}} [opts]
 * @returns {any}
 */
export function createApiClient(Anthropic, { endpoint } = {}) {
  return new Anthropic({
    ...(endpoint ? { baseURL: endpoint } : {}), maxRetries: API_MAX_RETRIES, timeout: API_TIMEOUT_MS,
  });
}

/**
 * The request of §8.6, exactly: no sampling parameters, no thinking budget, no assistant prefill.
 * @param {string} packText
 * @param {{model?: string, effort?: string, fallbacks?: boolean}} [opts]
 * @returns {Record<string, any>}
 */
export function apiRequest(packText, { model = DEFAULT_MODEL, effort = 'high', fallbacks = true } = {}) {
  return {
    model,
    max_tokens: API_MAX_TOKENS,
    ...(fallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema: structuredClone(VERDICT_SCHEMA) } },
    system: [{ type: 'text', text: RUBRIC_TEXT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: packText }],
  };
}

/**
 * Map an SDK error to a RawResult, most specific class first, never by message text (§8.6).
 * Anything that is not an SDK error is rethrown.
 * @param {any} Anthropic
 * @param {any} err
 * @param {AbortSignal | undefined} signal
 * @returns {RawResult}
 */
function apiFailure(Anthropic, err, signal) {
  const is = (/** @type {string} */ name) => typeof Anthropic?.[name] === 'function'
    && err instanceof Anthropic[name];
  const status = typeof err?.status === 'number' ? err.status : null;
  const type = typeof err?.type === 'string' ? err.type : null;
  const http = status ? ` (HTTP ${status}${type ? `, ${type}` : ''})` : '';
  /**
   * @param {ErrorKind} kind
   * @param {string} message
   * @returns {RawResult}
   */
  const fail = (kind, message) => ({
    ok: false, costUsd: 0, usage: normaliseUsage(null), stopReason: null,
    error: { kind, status, type, message },
  });
  if (is('AuthenticationError') || is('PermissionDeniedError')) {
    return fail('auth', `The Anthropic API refused the credentials${http}`);
  }
  if (is('NotFoundError')) return fail('model', `Unknown model${http}`);
  if (is('RateLimitError')) {
    return fail('rate', `Rate limited by the Anthropic API after the SDK's retries${http}`);
  }
  if (is('InternalServerError') || is('APIConnectionError')) {
    return fail('server', `The Anthropic API could not answer${http}`);
  }
  if (is('APIUserAbortError') || (signal?.aborted && err?.name === 'AbortError')) {
    return fail('aborted', 'Interrupted');
  }
  if (is('APIError')) return fail('api', `The Anthropic API returned an error${http}`);
  throw err;
}

/**
 * Review one pack through the Messages API (§8.6). `stop_reason` is checked before any content is
 * read; a refusal is returned as such and never retried here.
 * @param {Pack | string} pack
 * @param {object} [opts]
 * @param {() => Promise<any>} [opts.loadSdk] default `() => import('@anthropic-ai/sdk')`
 * @param {any} [opts.Anthropic] an already loaded SDK class (skips `loadSdk`)
 * @param {any} [opts.client] an already created client
 * @param {string} [opts.model]
 * @param {string} [opts.effort]
 * @param {string | null} [opts.endpoint] `baseURL`
 * @param {boolean} [opts.fallbacks] server-side refusal fallbacks (default true)
 * @param {Record<string, {input: number, output: number}>} [opts.prices]
 * @param {Record<string, string | undefined>} [opts.env] its Anthropic keys are registered with redact()
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<RawResult>}
 */
export async function callAnthropicApi(pack, opts = {}) {
  const {
    loadSdk = defaultLoadSdk, model = DEFAULT_MODEL, effort = 'high', endpoint, fallbacks = true, prices,
    env = process.env, signal,
  } = opts;
  registerSecret(envValue(env, 'ANTHROPIC_API_KEY'));
  registerSecret(envValue(env, 'ANTHROPIC_AUTH_TOKEN'));
  const Anthropic = opts.Anthropic ?? await loadAnthropic(loadSdk);
  const client = opts.client ?? createApiClient(Anthropic, { endpoint });
  const params = apiRequest(typeof pack === 'string' ? pack : pack.text, { model, effort, fallbacks });
  /** @type {any} */
  let msg;
  try {
    msg = signal
      ? await client.beta.messages.create(params, { signal })
      : await client.beta.messages.create(params);
  } catch (err) {
    return apiFailure(Anthropic, err, signal);
  }
  const usage = normaliseUsage(msg?.usage);
  const served = typeof msg?.model === 'string' ? msg.model : model;
  const costUsd = estimateCost(usage, prices?.[served] ? served : model, prices ?? DEFAULT_PRICES);
  const stopReason = typeof msg?.stop_reason === 'string' ? msg.stop_reason : null;
  const parsed = parseApiResponse(msg);
  /** @type {RawResult} */
  const common = { ok: false, costUsd, usage, stopReason, model: served };
  if (parsed.status === 'refused') return { ...common, refusal: parsed.refusal };
  if (parsed.status === 'ok') return { ...common, ok: true, output: parsed.output };
  const kind = stopReason === 'max_tokens' ? 'max_tokens' : 'parse';
  return { ...common, error: { kind, message: parsed.error ?? 'The answer could not be read' } };
}

/**
 * Create a backend for a review run: resolves the executable or loads the SDK up front, so a
 * missing one is reported before any work starts.
 * @param {'claude-cli' | 'anthropic-api'} name
 * @param {object} [opts]
 * @param {Record<string, any>} [opts.llm] `defaults.json#llm`
 * @param {string} [opts.model]
 * @param {string} [opts.effort]
 * @param {string | null} [opts.endpoint]
 * @param {boolean} [opts.fallbacks]
 * @param {number} [opts.perCallUsd]
 * @param {number} [opts.timeoutMs] `claude-cli` time limit (default `llm.cliTimeoutMs`, else 180 s)
 * @param {Record<string, string | undefined>} [opts.env]
 * @param {string} [opts.platform]
 * @param {FsLike} [opts.fs]
 * @param {typeof nodeSpawn} [opts.spawn]
 * @param {() => Promise<any>} [opts.loadSdk]
 * @param {string} [opts.exe] skip the executable search
 * @returns {Promise<Backend>}
 */
export async function createBackend(name, opts = {}) {
  const llm = opts.llm ?? {};
  const model = opts.model ?? llm.model ?? DEFAULT_MODEL;
  const env = opts.env ?? process.env;
  if (name === 'claude-cli') {
    const exe = opts.exe ?? resolveClaudeExe({
      env, platform: opts.platform, fs: opts.fs, claudePath: llm.claudePath ?? null,
    });
    if (!exe) {
      throw new ClaudeNotFoundError('Could not find the claude executable. Install Claude Code, or set '
        + 'UNSUNG_CLAUDE (or llm.claudePath in config/defaults.json) to the full path of claude.exe '
        + 'or claude.');
    }
    const perCallUsd = opts.perCallUsd ?? llm.perCallUsd ?? 0.5;
    const effort = opts.effort ?? llm.effort ?? DEFAULT_EFFORT;
    const positive = (/** @type {unknown} */ v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
    const timeoutMs = positive(opts.timeoutMs) ?? positive(llm.cliTimeoutMs) ?? CLI_TIMEOUT_MS;
    return {
      name, model,
      call: (pack, o = {}) => callClaudeCli(pack, {
        exe, model, perCallUsd, effort, timeoutMs, env, platform: opts.platform, spawn: opts.spawn,
        signal: o.signal,
      }),
    };
  }
  if (name === 'anthropic-api') {
    const Anthropic = await loadAnthropic(opts.loadSdk ?? defaultLoadSdk);
    registerSecret(envValue(env, 'ANTHROPIC_API_KEY'));
    registerSecret(envValue(env, 'ANTHROPIC_AUTH_TOKEN'));
    const client = createApiClient(Anthropic, { endpoint: opts.endpoint ?? llm.endpoint ?? null });
    const effort = opts.effort ?? llm.effort ?? DEFAULT_EFFORT;
    const fallbacks = opts.fallbacks ?? llm.fallbacks ?? true;
    return {
      name, model,
      call: (pack, o = {}) => callAnthropicApi(pack, {
        Anthropic, client, model, effort, fallbacks, prices: llm.prices, env, signal: o.signal,
      }),
    };
  }
  throw new TypeError(`Unknown LLM backend '${String(name)}'`);
}
