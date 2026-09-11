// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { mulberry32 } from '../src/core/util.mjs';
import {
  API_MAX_TOKENS, ClaudeNotFoundError, FALLBACK_BETA, SDK_INSTALL_HINT, SdkMissingError, apiRequest,
  callAnthropicApi, callClaudeCli, childEnv, cliArgs, createBackend, estimateCost, loadAnthropic,
  resolveClaudeExe,
} from '../src/llm/backends.mjs';
import { buildPack } from '../src/llm/pack.mjs';
import { RUBRIC_TEXT, VERDICT_SCHEMA } from '../src/llm/rubric.mjs';
import { redact } from '../src/secrets.mjs';
import { loadJsonFixture } from './support/fixtures.mjs';

const packFixture = loadJsonFixture('llm/pack-record.json');
const pack = buildPack(packFixture.record, packFixture.files, { rand: mulberry32(7) });
const cliResult = loadJsonFixture('llm/cli-result.json');
const FAKE_GH = `ghp_${'a1B2'.repeat(9)}`;

// ---------------------------------------------------------------------------------------------
// resolveClaudeExe
// ---------------------------------------------------------------------------------------------

/**
 * @param {Record<string, string | true>} files path → text (shims) or true (executables)
 */
function fakeFs(files) {
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    statSync(/** @type {string} */ p) {
      if (!(p in files)) throw missing();
      return { isFile: () => true };
    },
    readFileSync(/** @type {string} */ p) {
      const v = files[p];
      if (typeof v !== 'string') throw missing();
      return v;
    },
  };
}
const SHIM = '@echo off \r\n"C:\\Users\\artem\\.local\\bin\\claude.exe" %* \r\n';
const win = (/** @type {Record<string, string>} */ env, /** @type {Record<string, string | true>} */ files) =>
  resolveClaudeExe({ env, platform: 'win32', fs: fakeFs(files) });

test('resolveClaudeExe takes the first claude.exe in an absolute PATH directory', () => {
  const files = { 'C:\\tools\\claude.exe': true, 'D:\\bin\\claude.exe': true, '.\\claude.exe': true };
  assert.equal(win({ Path: '.;C:\\none;"C:\\tools";D:\\bin' }, files), 'C:\\tools\\claude.exe');
});

test('resolveClaudeExe falls back to %USERPROFILE%\\.local\\bin\\claude.exe', () => {
  const files = { 'C:\\Users\\me\\.local\\bin\\claude.exe': true };
  assert.equal(win({ PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\me' }, files),
    'C:\\Users\\me\\.local\\bin\\claude.exe');
});

test('resolveClaudeExe reads a .cmd shim of the measured form and uses its executable', () => {
  const files = { 'C:\\windows\\claude.cmd': SHIM, 'C:\\Users\\artem\\.local\\bin\\claude.exe': true };
  assert.equal(win({ PATH: 'C:\\windows', USERPROFILE: 'C:\\Users\\other' }, files),
    'C:\\Users\\artem\\.local\\bin\\claude.exe');
});

test('resolveClaudeExe refuses any other shim', () => {
  const exe = 'C:\\Users\\artem\\.local\\bin\\claude.exe';
  for (const body of [
    '@echo off\r\nnode "%~dp0\\node_modules\\claude\\cli.js" %*\r\n',
    `@echo off\r\n"${exe}" %*\r\ndel C:\\x\r\n`,
    `"${exe}" --dangerous %*\r\n`,
    '"relative\\claude.exe" %*\r\n',
    '"%LOCALAPPDATA%\\claude.exe" %*\r\n',
  ]) {
    assert.equal(win({ PATH: 'C:\\windows' }, { 'C:\\windows\\claude.cmd': body, [exe]: true }), null, body);
  }
  assert.equal(win({ PATH: 'C:\\windows' }, { 'C:\\windows\\claude.cmd': SHIM }), null, 'target missing');
});

test('UNSUNG_CLAUDE wins over llm.claudePath; both must be absolute', () => {
  const files = { 'E:\\a\\claude.exe': true, 'F:\\b\\claude.exe': true, 'C:\\tools\\claude.exe': true };
  const opts = { platform: 'win32', fs: fakeFs(files), claudePath: 'F:\\b\\claude.exe' };
  const fromEnv = resolveClaudeExe({ ...opts, env: { UNSUNG_CLAUDE: 'E:\\a\\claude.exe' } });
  assert.equal(fromEnv, 'E:\\a\\claude.exe');
  assert.equal(resolveClaudeExe({ ...opts, env: { PATH: 'C:\\tools' } }), 'F:\\b\\claude.exe');
  assert.equal(resolveClaudeExe({ ...opts, env: { UNSUNG_CLAUDE: 'claude.exe' } }), null);
});

test('resolveClaudeExe on POSIX searches PATH, then ~/.local/bin', () => {
  const fs = fakeFs({ '/opt/claude/bin/claude': true, '/home/me/.local/bin/claude': true });
  assert.equal(resolveClaudeExe({ env: { PATH: '/usr/bin:/opt/claude/bin' }, platform: 'linux', fs }),
    '/opt/claude/bin/claude');
  assert.equal(resolveClaudeExe({ env: { PATH: '/usr/bin', HOME: '/home/me' }, platform: 'linux', fs }),
    '/home/me/.local/bin/claude');
  assert.equal(resolveClaudeExe({ env: { PATH: '' }, platform: 'linux', fs }), null);
});

// ---------------------------------------------------------------------------------------------
// callClaudeCli
// ---------------------------------------------------------------------------------------------

/**
 * A fake `spawn` that records each call and answers through `behave(child)` once stdin ends.
 * @param {(child: any) => void} behave
 */
function fakeSpawn(behave) {
  /** @type {any[]} */
  const calls = [];
  const spawn = (/** @type {string} */ exe, /** @type {string[]} */ args, /** @type {any} */ opts) => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.pid = 4242;
    child.exitCode = null;
    /** @type {Buffer[]} */
    const input = [];
    child.stdin.on('data', (/** @type {Buffer} */ c) => input.push(c));
    const rubricFile = args[args.indexOf('--system-prompt-file') + 1];
    const call = {
      exe, args, opts, child, cwdEntries: readdirSync(opts.cwd), rubric: readFileSync(rubricFile, 'utf8'),
      stdin: () => Buffer.concat(input).toString('utf8'),
    };
    calls.push(call);
    child.stdin.on('finish', () => behave(child));
    return child;
  };
  return Object.assign(spawn, { calls });
}

/**
 * @param {string} stdout
 * @param {number} [code]
 * @param {string} [stderr]
 */
const answer = (stdout, code = 0, stderr = '') => (/** @type {any} */ child) => {
  child.stdout.on('end', () => setImmediate(() => {
    child.exitCode = code;
    child.emit('close', code);
  }));
  child.stderr.end(stderr);
  child.stdout.end(stdout);
};

const EXE = 'C:\\Users\\artem\\.local\\bin\\claude.exe';

test('callClaudeCli spawns claude.exe with exactly the §8.6 arguments and the pack on stdin', async () => {
  const spawn = fakeSpawn(answer(cliResult.stdout));
  const opts0 = { exe: EXE, spawn: /** @type {any} */ (spawn), perCallUsd: 0.5, env: {} };
  const raw = await callClaudeCli(pack, opts0);
  assert.equal(spawn.calls.length, 1);
  const { exe, args, opts } = spawn.calls[0];
  assert.equal(exe, EXE);
  const rubricPath = args[args.length - 1];
  assert.deepEqual(args, ['-p', '--output-format', 'json', '--tools', '', '--safe-mode',
    '--strict-mcp-config',
    '--no-session-persistence', '--model', 'claude-opus-5', '--effort', 'high', '--max-budget-usd', '0.5',
    '--system-prompt-file', rubricPath]);
  assert.deepEqual(args, cliArgs({ model: 'claude-opus-5', perCallUsd: 0.5, rubricPath }));
  assert.equal(spawn.calls[0].stdin(), pack.text);
  assert.equal(spawn.calls[0].rubric, RUBRIC_TEXT);
  assert.equal(opts.windowsHide, true);
  assert.equal(raw.ok, true, JSON.stringify(raw.error));
  assert.equal(raw.output?.category, 'G');
  assert.equal(raw.stopReason, 'end_turn');
  assert.equal(raw.model, 'claude-opus-5');
  assert.match(String(raw.text), /^```json\n/, 'the answer text is kept, fence and all');
  assert.equal(raw.costUsd, 0.1123);
  assert.deepEqual(raw.usage, { input: 12200, output: 2100, cacheRead: 0, cacheWrite: 2400 },
    'usage comes from modelUsage; the top-level usage is all zeros');
});

test('the claude arguments never carry --json-schema or --bare; --effort follows the configuration', async () => {
  for (const o of [{}, { effort: 'low' }, { effort: 'max' }]) {
    const args = cliArgs({ model: 'm', perCallUsd: 1, rubricPath: 'r.md', ...o });
    assert.ok(!args.includes('--json-schema'), 'no --json-schema: it forces a two-turn tool round trip');
    assert.ok(!args.includes('--bare'), 'no --bare: it ignores the login');
    assert.ok(!args.some((a) => a.includes('additionalProperties')), 'no schema on the command line');
    assert.equal(args[args.indexOf('--effort') + 1], o.effort ?? 'high');
    assert.deepEqual(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2), ['--tools', '']);
  }
  const spawn = fakeSpawn(answer(cliResult.stdout));
  const common = { exe: EXE, spawn: /** @type {any} */ (spawn), env: {}, llm: { effort: 'medium' } };
  await (await createBackend('claude-cli', common)).call(pack);
  await (await createBackend('claude-cli', { ...common, effort: 'xhigh' })).call(pack);
  await (await createBackend('claude-cli', { ...common, llm: {} })).call(pack);
  assert.deepEqual(spawn.calls.map((c) => c.args[c.args.indexOf('--effort') + 1]), ['medium', 'xhigh', 'high']);
  for (const c of spawn.calls) assert.ok(!c.args.includes('--json-schema'));
});

test('a claude answer cut at max_tokens is a max_tokens error, not a parse of half an answer', async () => {
  const stdout = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, stop_reason: 'max_tokens', num_turns: 1,
    result: '{"category": "G", "scores": {"purpose": 3, "craft": 3}, "claims": [', total_cost_usd: 0.2,
  });
  const raw = await callClaudeCli(pack, { exe: EXE, spawn: /** @type {any} */ (fakeSpawn(answer(stdout))), env: {} });
  assert.equal(raw.ok, false);
  assert.equal(raw.error?.kind, 'max_tokens');
  assert.equal(raw.costUsd, 0.2);
});

test('no spawned argument ever contains pack text, and no shell is used', async () => {
  const spawn = fakeSpawn(answer(cliResult.stdout));
  await callClaudeCli(pack, { exe: EXE, spawn: /** @type {any} */ (spawn), env: {} });
  const { exe, args, opts } = spawn.calls[0];
  const joined = args.join('\n');
  assert.ok(!joined.includes(pack.id), 'the pack id');
  for (const f of pack.files) {
    for (const line of f.text.split('\n').filter((l) => l.trim().length >= 12)) {
      assert.ok(!joined.includes(line.trim()), `pack text on the command line: ${line.slice(0, 40)}`);
    }
  }
  assert.ok(!/tidewatch|OWNER|harmonic/i.test(joined));
  assert.equal(opts.shell, false);
  assert.doesNotMatch(exe, /\.(cmd|bat)$/i);
  assert.doesNotMatch(exe, /cmd\.exe$|powershell|\bsh$/i);
});

test('the child runs in a fresh empty directory that is removed afterwards', async () => {
  const spawn = fakeSpawn(answer(cliResult.stdout));
  await callClaudeCli(pack, { exe: EXE, spawn: /** @type {any} */ (spawn), env: {} });
  const { opts, cwdEntries, args } = spawn.calls[0];
  assert.deepEqual(cwdEntries, []);
  assert.ok(!existsSync(opts.cwd));
  assert.ok(!existsSync(args[args.length - 1]));
  assert.ok(!existsSync(path.dirname(opts.cwd)));
});

test('the child environment holds no GitHub token', async () => {
  const spawn = fakeSpawn(answer(cliResult.stdout));
  const env = {
    GITHUB_TOKEN: FAKE_GH, GH_TOKEN: FAKE_GH, Github_Pat: 'x'.repeat(20), GH_ENTERPRISE_TOKEN: 'y'.repeat(20),
    SNEAKY: `prefix ${FAKE_GH}`, FINE_GRAINED: `github_pat_${'Z'.repeat(30)}`,
    PATH: 'C:\\Windows', HOME_DIR: 'ok',
  };
  await callClaudeCli(pack, { exe: EXE, spawn: /** @type {any} */ (spawn), env });
  const childEnvSeen = spawn.calls[0].opts.env;
  assert.deepEqual(Object.keys(childEnvSeen).sort(), ['HOME_DIR', 'PATH']);
  assert.doesNotMatch(JSON.stringify(childEnvSeen), /gh[pousr]_|github_pat_/);
  assert.deepEqual(childEnv({ GITHUB_TOKEN: 'abc', A: 'b', U: undefined }), { A: 'b' });
});

test('claude errors map to error kinds; stderr in messages is redacted and short', async () => {
  const envelope = (/** @type {Record<string, unknown>} */ o) => JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, ...o,
  });
  const cases = [
    [envelope({ is_error: true, api_error_status: 401 }), 'auth'],
    [envelope({ is_error: true, api_error_status: 429 }), 'rate'],
    [envelope({ subtype: 'error_max_budget_usd', total_cost_usd: 0.5 }), 'cli'],
    [envelope({ result: 'No JSON at all.' }), 'parse'],
  ];
  for (const [stdout, kind] of cases) {
    const spawn = /** @type {any} */ (fakeSpawn(answer(stdout)));
    const raw = await callClaudeCli(pack, { exe: EXE, spawn, env: {} });
    assert.equal(raw.ok, false);
    assert.equal(raw.error?.kind, kind, stdout);
  }
  const noisy = fakeSpawn(answer('not json', 1, `fatal: bad token ${FAKE_GH} ${'z'.repeat(400)}`));
  const raw = await callClaudeCli(pack, { exe: EXE, spawn: /** @type {any} */ (noisy), env: {} });
  assert.equal(raw.error?.kind, 'cli');
  assert.ok(!String(raw.error?.message).includes(FAKE_GH));
  assert.ok(String(raw.error?.message).length < 250);
});

test('a refusal from claude is reported as a refusal', async () => {
  const stdout = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'refusal',
    stop_details: { category: 'cyber' }, result: '', total_cost_usd: 0.01 });
  const spawn = /** @type {any} */ (fakeSpawn(answer(stdout)));
  const raw = await callClaudeCli(pack, { exe: EXE, spawn, env: {} });
  assert.equal(raw.ok, false);
  assert.deepEqual(raw.refusal, { category: 'cyber' });
});

test('the recorded budget-exhausted envelope is an error, with its cost and per-model usage', async () => {
  const fx = loadJsonFixture('llm/cli-budget-exhausted.json');
  const spawn = /** @type {any} */ (fakeSpawn(answer(fx.stdout)));
  const raw = await callClaudeCli(pack, { exe: EXE, spawn, env: {} });
  assert.equal(raw.ok, false);
  assert.equal(raw.error?.kind, 'cli');
  assert.match(String(raw.error?.message), /error_max_budget_usd/);
  assert.equal(raw.costUsd, 0.074795);
  assert.deepEqual(raw.usage, { input: 3605, output: 14238, cacheRead: 0, cacheWrite: 0 });
  assert.equal(raw.model, 'claude-haiku-4-5-20251001');
});

test('a call that outlasts the timeout kills the process tree and is charged its per-call cap (llm-3)', async () => {
  const spawn = fakeSpawn(() => {});
  /** @type {any[]} */
  const killed = [];
  const raw = await callClaudeCli(pack, {
    exe: EXE, spawn: /** @type {any} */ (spawn), env: {}, timeoutMs: 30, perCallUsd: 0.5,
    killTree: (child) => {
      killed.push(child);
      child.emit('close', null);
    },
  });
  assert.equal(killed.length, 1);
  assert.equal(raw.error?.kind, 'timeout');
  assert.match(String(raw.error?.message), /within 0\.03 s/);
  assert.equal(raw.costUsd, 0.5, 'what a killed call spent is unknown, not zero');
  assert.equal(raw.costEstimated, true);
});

test('an interrupted call is charged once started, not before; a cost it printed wins (llm-3)', async () => {
  const controller = new AbortController();
  const started = fakeSpawn(() => setImmediate(() => controller.abort()));
  const raw = await callClaudeCli(pack, {
    exe: EXE, spawn: /** @type {any} */ (started), env: {}, perCallUsd: 0.25, signal: controller.signal,
    killTree: (child) => child.emit('close', null),
  });
  assert.equal(raw.error?.kind, 'aborted');
  assert.equal(raw.costUsd, 0.25);
  assert.equal(raw.costEstimated, true);
  const early = new AbortController();
  early.abort();
  const never = fakeSpawn(() => {});
  const none = await callClaudeCli(pack, { exe: EXE, spawn: /** @type {any} */ (never), env: {}, signal: early.signal });
  assert.equal(never.calls.length, 0, 'nothing was started');
  assert.equal(none.error?.kind, 'aborted');
  assert.equal(none.costUsd, 0);
  assert.equal(none.costEstimated, undefined);
  const printed = fakeSpawn((child) => child.stdout.write(JSON.stringify({ type: 'result', total_cost_usd: 0.07 })));
  const late = await callClaudeCli(pack, {
    exe: EXE, spawn: /** @type {any} */ (printed), env: {}, timeoutMs: 30, perCallUsd: 0.5,
    killTree: (child) => child.emit('close', null),
  });
  assert.equal(late.error?.kind, 'timeout');
  assert.equal(late.costUsd, 0.07, 'the cost the CLI printed before the kill');
  assert.equal(late.costEstimated, undefined);
});

test('llm.cliTimeoutMs sets the claude-cli time limit', async () => {
  const silent = () => {
    const child = /** @type {any} */ (new EventEmitter());
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = () => child.emit('close', null);
    return child;
  };
  const backend = await createBackend('claude-cli', {
    exe: '/opt/claude/bin/claude', spawn: /** @type {any} */ (silent), env: {}, platform: 'linux',
    llm: { cliTimeoutMs: 20, perCallUsd: 0.3 },
  });
  const raw = await backend.call(pack);
  assert.equal(raw.error?.kind, 'timeout');
  assert.match(String(raw.error?.message), /within 0\.02 s/);
  assert.equal(raw.costUsd, 0.3);
});

test('an abort kills the child and reports an interruption; a failed spawn reports spawn', async () => {
  const controller = new AbortController();
  const spawn = fakeSpawn(() => setImmediate(() => controller.abort()));
  const raw = await callClaudeCli(pack, {
    exe: EXE, spawn: /** @type {any} */ (spawn), env: {}, signal: controller.signal,
    killTree: (child) => child.emit('close', null),
  });
  assert.equal(raw.error?.kind, 'aborted');
  const throwing = () => {
    throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  };
  const failed = await callClaudeCli(pack, { exe: EXE, spawn: /** @type {any} */ (throwing), env: {} });
  assert.equal(failed.error?.kind, 'spawn');
  await assert.rejects(() => callClaudeCli(pack, /** @type {any} */ ({ exe: '' })), ClaudeNotFoundError);
});

// ---------------------------------------------------------------------------------------------
// callAnthropicApi
// ---------------------------------------------------------------------------------------------

/**
 * A fake `@anthropic-ai/sdk` module with the SDK's error class names.
 * @param {(params: any, n: number) => any} respond returns a message or throws
 */
function fakeSdk(respond) {
  class APIError extends Error {
    /** @param {number | undefined} status @param {string | undefined} type @param {string} [message] */
    constructor(status, type, message = 'API error') {
      super(message);
      this.status = status;
      this.type = type;
    }
  }
  class AuthenticationError extends APIError {}
  class PermissionDeniedError extends APIError {}
  class NotFoundError extends APIError {}
  class RateLimitError extends APIError {}
  class InternalServerError extends APIError {}
  class APIConnectionError extends APIError {}
  class APIUserAbortError extends APIError {}
  /** @type {any[]} */
  const calls = [];
  /** @type {any[]} */
  const clients = [];
  class Anthropic {
    /** @param {any} opts */
    constructor(opts) {
      this.opts = opts;
      clients.push(this);
      this.beta = {
        messages: {
          create: async (/** @type {any} */ params, /** @type {any} */ reqOpts) => {
            calls.push({ params, reqOpts });
            return respond(params, calls.length);
          },
        },
      };
    }
  }
  Object.assign(Anthropic, {
    APIError, AuthenticationError, PermissionDeniedError, NotFoundError, RateLimitError, InternalServerError,
    APIConnectionError, APIUserAbortError,
  });
  return { module: { default: Anthropic }, Anthropic: /** @type {any} */ (Anthropic), calls, clients };
}

const apiSuccess = loadJsonFixture('llm/api-success.json').message;

test('the SDK request matches §8.6 exactly: no sampling parameters, no budget, no prefill', async () => {
  const sdk = fakeSdk(() => apiSuccess);
  const raw = await callAnthropicApi(pack, { loadSdk: async () => sdk.module, env: {} });
  assert.equal(raw.ok, true);
  assert.equal(sdk.calls.length, 1);
  assert.deepEqual(sdk.calls[0].params, {
    model: 'claude-opus-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: VERDICT_SCHEMA } },
    system: [{ type: 'text', text: RUBRIC_TEXT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: pack.text }],
  });
  const text = JSON.stringify(sdk.calls[0].params);
  for (const banned of ['temperature', 'top_p', 'top_k', 'budget_tokens']) {
    assert.ok(!text.includes(banned), banned);
  }
  assert.ok(sdk.calls[0].params.messages.every((/** @type {any} */ m) => m.role === 'user'));
  assert.equal(sdk.calls[0].reqOpts, undefined);
  assert.deepEqual(sdk.clients[0].opts, { maxRetries: 2, timeout: 300_000 });
});

test('--no-fallbacks omits the beta flag and the fallbacks parameter; --endpoint sets baseURL', async () => {
  const sdk = fakeSdk(() => apiSuccess);
  await callAnthropicApi(pack, {
    loadSdk: async () => sdk.module, env: {}, fallbacks: false, effort: 'medium',
    endpoint: 'https://proxy.local',
  });
  const p = sdk.calls[0].params;
  assert.ok(!('betas' in p) && !('fallbacks' in p));
  assert.equal(p.output_config.effort, 'medium');
  assert.equal(p.max_tokens, API_MAX_TOKENS);
  assert.deepEqual(sdk.clients[0].opts, { baseURL: 'https://proxy.local', maxRetries: 2, timeout: 300_000 });
  assert.deepEqual(apiRequest('x').betas, [FALLBACK_BETA]);
});

test('a successful answer is parsed and costed', async () => {
  const sdk = fakeSdk(() => apiSuccess);
  const raw = await callAnthropicApi(pack, { Anthropic: sdk.Anthropic, env: {} });
  assert.equal(raw.output?.category, 'G');
  assert.equal(raw.stopReason, 'end_turn');
  assert.deepEqual(raw.usage, { input: 5700, output: 1900, cacheRead: 2600, cacheWrite: 0 });
  assert.equal(Math.round(raw.costUsd * 1e6), 64300);
});

test('a refusal is returned with its category and never retried', async () => {
  const sdk = fakeSdk(() => loadJsonFixture('llm/api-refusal.json').message);
  const raw = await callAnthropicApi(pack, { Anthropic: sdk.Anthropic, env: {} });
  assert.equal(raw.ok, false);
  assert.equal(raw.stopReason, 'refusal');
  assert.equal(raw.refusal?.category, 'cyber');
  assert.equal(sdk.calls.length, 1);
});

test('max_tokens is an error; a fallback answer reports the model that served it', async () => {
  const max = await callAnthropicApi(pack, {
    Anthropic: fakeSdk(() => loadJsonFixture('llm/api-max-tokens.json').message).Anthropic, env: {},
  });
  assert.equal(max.error?.kind, 'max_tokens');
  const fb = await callAnthropicApi(pack, {
    Anthropic: fakeSdk(() => loadJsonFixture('llm/api-fallback.json').message).Anthropic, env: {},
  });
  assert.equal(fb.ok, true);
  assert.equal(fb.model, 'claude-opus-4-8');
});

test('SDK errors are caught by class, most specific first', async () => {
  const cases = [
    ['AuthenticationError', 401, 'auth'], ['PermissionDeniedError', 403, 'auth'],
    ['NotFoundError', 404, 'model'],
    ['RateLimitError', 429, 'rate'], ['InternalServerError', 529, 'server'],
    ['APIConnectionError', undefined, 'server'], ['APIError', 400, 'api'],
  ];
  for (const [name, status, kind] of cases) {
    // The error must be an instance of the class the call's own SDK module exports.
    const own = fakeSdk(() => {
      throw new own.Anthropic[/** @type {string} */ (name)](status, 'some_error_type', 'boom');
    });
    const raw = await callAnthropicApi(pack, { Anthropic: own.Anthropic, env: {} });
    assert.equal(raw.ok, false);
    assert.equal(raw.error?.kind, kind, String(name));
    if (kind === 'api') assert.match(String(raw.error?.message), /HTTP 400, some_error_type/);
  }
  const bug = fakeSdk(() => {
    throw new TypeError('a bug');
  });
  await assert.rejects(() => callAnthropicApi(pack, { Anthropic: bug.Anthropic, env: {} }), TypeError);
});

test('the Anthropic keys in the environment are registered for redaction', async () => {
  const key = `sk-ant-fake-${'k'.repeat(24)}`;
  const { Anthropic } = fakeSdk(() => apiSuccess);
  await callAnthropicApi(pack, { Anthropic, env: { ANTHROPIC_API_KEY: key } });
  assert.equal(redact(`key ${key}`), 'key [REDACTED]');
});

test('a missing SDK gives the install instruction, exit code 2', async () => {
  const missing = async () => {
    const err = new Error("Cannot find package '@anthropic-ai/sdk'");
    throw Object.assign(err, { code: 'ERR_MODULE_NOT_FOUND' });
  };
  await assert.rejects(() => loadAnthropic(missing), (err) => {
    assert.ok(err instanceof SdkMissingError);
    assert.equal(/** @type {any} */ (err).exitCode, 2);
    assert.ok(/** @type {Error} */ (err).message.includes(SDK_INSTALL_HINT));
    return true;
  });
  await assert.rejects(() => loadAnthropic(async () => ({ notTheClient: 1 })), SdkMissingError);
  await assert.rejects(() => callAnthropicApi(pack, { loadSdk: missing, env: {} }), SdkMissingError);
});

test('the default loader imports @anthropic-ai/sdk, which this repository does not install', async (t) => {
  let installed = true;
  try {
    await import('@anthropic-ai/sdk');
  } catch {
    installed = false;
  }
  if (installed) {
    t.skip('the SDK is installed here');
    return;
  }
  await assert.rejects(() => loadAnthropic(), SdkMissingError);
});

test('estimateCost follows §8.6: $5 in, $25 out per million, cache writes 1.25×, reads 0.1×', () => {
  assert.equal(Math.round(estimateCost({ input: 12004, output: 2210 }, 'claude-opus-5') * 1e5), 11527);
  const api = {
    input_tokens: 1000, cache_creation_input_tokens: 1000, cache_read_input_tokens: 10000, output_tokens: 0,
  };
  assert.equal(estimateCost(api, 'claude-opus-5'), (1000 * 5 + 1000 * 5 * 1.25 + 10000 * 0.5) / 1e6);
  const prices = { a: { input: 1, output: 2 }, b: { input: 10, output: 50 } };
  const unknown = estimateCost({ input: 1e6, output: 0 }, 'unknown', prices);
  assert.equal(unknown, 10, 'the dearest price when unknown');
  assert.equal(estimateCost(null, 'claude-opus-5'), 0);
});

test('createBackend resolves the executable or the SDK before any work', async () => {
  await assert.rejects(() => createBackend('claude-cli', {
    env: { PATH: '' }, platform: 'win32', fs: fakeFs({}), llm: { claudePath: null },
  }), ClaudeNotFoundError);
  const spawn = fakeSpawn(answer(cliResult.stdout));
  const cli = await createBackend('claude-cli', {
    exe: EXE, spawn: /** @type {any} */ (spawn), env: {}, llm: { model: 'claude-opus-5', perCallUsd: 0.25 },
  });
  assert.equal(cli.name, 'claude-cli');
  const raw = await cli.call(pack);
  assert.equal(raw.ok, true);
  assert.equal(spawn.calls[0].args[spawn.calls[0].args.indexOf('--max-budget-usd') + 1], '0.25');
  const sdk = fakeSdk(() => apiSuccess);
  const api = await createBackend('anthropic-api', {
    loadSdk: async () => sdk.module, env: {},
    llm: { model: 'claude-opus-5', effort: 'high', fallbacks: false },
  });
  assert.equal((await api.call(pack)).ok, true);
  assert.ok(!('fallbacks' in sdk.calls[0].params));
  await assert.rejects(() => createBackend(/** @type {any} */ ('gpt'), {}), TypeError);
});
