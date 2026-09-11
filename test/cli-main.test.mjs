// @ts-check
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, commandHelp, helpText, main } from '../bin/unsung.mjs';

const BIN = fileURLToPath(new URL('../bin/unsung.mjs', import.meta.url));
const REPO_CONFIG = fileURLToPath(new URL('../config/', import.meta.url));
const ALL = ['run', 'add', 'explain', 'status', 'recheck', 'sample', 'review', 'export', 'digest', 'eval',
  'calibrate', 'index', 'compact', 'serve', 'feedback'];
const TOKEN = `ghp_${'L'.repeat(36)}`;

/** @type {string[]} */
const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

/**
 * @param {string} prefix
 * @returns {string}
 */
function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A command directory with a working fake `status`, a module without `command`, and a broken one. */
function fakeCliDir() {
  const dir = tempDir('unsung-cli-');
  writeFileSync(path.join(dir, 'status.mjs'), `
export const command = {
  name: 'status',
  summary: 'Fake status for tests',
  flags: {
    top: { type: 'number', default: 5 }, audit: { type: 'boolean' }, mode: { type: 'string', default: 'ok' },
  },
  async run(args, ctx) {
    const mode = args.flags.mode;
    if (mode === 'config') throw Object.assign(new Error('Configuration is broken'), { exitCode: 2 });
    if (mode === 'auth') { const e = new Error('Bad credentials'); e.name = 'AuthError'; throw e; }
    if (mode === 'crash') throw new Error('Something odd happened');
    if (mode === 'token') throw new Error('leaked ' + ${JSON.stringify(TOKEN)});
    if (mode === 'undefined') return undefined;
    if (mode === 'paused') return 75;
    ctx.print(JSON.stringify({
      command: args.command, positionals: args.positionals, top: args.flags.top, audit: args.flags.audit,
      argv: ctx.argv, aborted: ctx.signal.aborted, lagDays: ctx.config?.defaults?.lagDays ?? null,
    }));
    return 0;
  },
};
`);
  writeFileSync(path.join(dir, 'review.mjs'), 'export const nothing = 1;\n');
  writeFileSync(path.join(dir, 'digest.mjs'), 'export const command = {\n');
  return dir;
}

/** A complete throwaway configuration directory. */
function configDir() {
  const dir = tempDir('unsung-main-config-');
  writeFileSync(path.join(dir, 'defaults.json'), readFileSync(path.join(REPO_CONFIG, 'defaults.json')));
  writeFileSync(path.join(dir, 'weights.json'), JSON.stringify({
    version: 'w1', signals: {}, confidence: {}, bands: { gem: 7, look: 5 },
    gem: { kWeight: 1.5, aWeight: 1.5 }, attention: { saturation: 25 },
    eligibility: { maxStars: 25, risingGain4w: 10 }, institutions: { orgMinRepos: 100 },
    confidenceBands: { medium: 0.3, high: 0.6 }, lanes: { provenK: 0.5 }, changelog: [],
  }));
  writeFileSync(path.join(dir, 'calibration.json'), JSON.stringify({
    version: 'c1', method: 'platt', a: -6.403, b: 1.113, fittedOn: {}, fittedAt: '2026-09-11',
  }));
  writeFileSync(path.join(dir, 'institutions.json'), JSON.stringify({ version: 1, allow: [], deny: [] }));
  return dir;
}

/**
 * Run main in-process with captured output.
 * @param {string[]} argv
 * @param {Record<string, any>} [extra]
 */
async function run(argv, extra = {}) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const code = await main(argv, {
    stdout: { write: (s) => { out.push(s); } },
    stderr: { write: (s) => { err.push(s); } },
    installSignals: false,
    env: {},
    ...extra,
  });
  return { code, out: out.join(''), err: err.join('') };
}

/** A createContext stand-in that needs no configuration. */
const fakeContext = async (/** @type {any} */ opts) => ({
  argv: opts.argv, signal: opts.signal, flags: opts.flags,
  print: (/** @type {string} */ t) => { opts.stdout.write(`${t}\n`); },
});

test('the command table lists every command of §9.1', () => {
  assert.deepEqual(COMMANDS.map((c) => c.name), ALL);
  for (const c of COMMANDS) {
    assert.ok(c.usage.startsWith(c.name), c.name);
    assert.ok(c.summary.length > 10, c.name);
  }
});

test('--help lists every command and the global flags', async () => {
  const r = await run(['--help']);
  assert.equal(r.code, 0);
  for (const name of ALL) assert.match(r.out, new RegExp(`^ {2}${name} +\\S`, 'm'), name);
  for (const flag of ['--data', '--config', '--json', '--verbose', '--quiet', '--seed']) {
    assert.ok(r.out.includes(flag), flag);
  }
  assert.equal(r.out, `${helpText()}\n`);
  assert.equal((await run(['-h'])).code, 0);
  assert.equal((await run(['help'])).code, 0);
});

test('no command prints help on stderr and exits 2', async () => {
  const r = await run([]);
  assert.equal(r.code, 2);
  assert.equal(r.out, '');
  assert.match(r.err, /Usage: unsung <command>/);
});

test('--version prints the package version', async () => {
  const r = await run(['--version']);
  assert.deepEqual([r.code, r.out], [0, '0.1.0\n']);
});

test('an unknown command exits 2', async () => {
  const r = await run(['nonsense']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Unknown command 'nonsense'/);
});

test('every command whose module has not landed exits 2 with "not yet available"', async () => {
  const empty = tempDir('unsung-empty-cli-');
  for (const name of ALL) {
    const r = await run([name], { cliDir: empty });
    assert.equal(r.code, 2, name);
    assert.equal(r.err, `unsung ${name}: not yet available\n`, name);
  }
  const help = await run(['run', '--help'], { cliDir: empty });
  assert.equal(help.code, 2);
  assert.match(help.out, /Usage: unsung run \[--budget 10m\]/);
  assert.match(help.out, /not yet available/);
  const viaHelp = await run(['help', 'explain'], { cliDir: empty });
  assert.equal(viaHelp.code, 2);
  assert.match(viaHelp.out, /Usage: unsung explain <owner\/repo>/);
});

test('a command module is loaded, its flags parsed and its exit code returned', async () => {
  const cliDir = fakeCliDir();
  const argv = ['status', 'extra', '--top', '9', '--audit'];
  const r = await run(argv, { cliDir, createContext: fakeContext });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), {
    command: 'status', positionals: ['extra'], top: 9, audit: true, argv, aborted: false, lagDays: null,
  });
  assert.equal((await run(['status', '--mode', 'paused'], { cliDir, createContext: fakeContext })).code, 75);
  const opts = { cliDir, createContext: fakeContext };
  assert.equal((await run(['status', '--mode', 'undefined'], opts)).code, 0);
});

test('the real context is built from --config', async () => {
  const argv = ['status', '--config', configDir(), '--data', tempDir('unsung-data-')];
  const r = await run(argv, { cliDir: fakeCliDir() });
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).lagDays, 3);
  const missing = await run(['status', '--config', tempDir('unsung-noconfig-')], { cliDir: fakeCliDir() });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /defaults\.json is missing/);
});

test('command help comes from the module when it exists', async () => {
  const r = await run(['status', '--help'], { cliDir: fakeCliDir() });
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage: unsung status \[--audit\] \[--units\]/);
  assert.match(r.out, /Fake status for tests/);
  assert.match(r.out, /--top <number> +\(default 5\)/);
  assert.match(r.out, /Global flags:/);
  const entry = /** @type {any} */ (COMMANDS.find((c) => c.name === 'status'));
  assert.match(commandHelp(entry, null), /not yet available/);
});

test('usage errors exit 2 and point at the command help', async () => {
  const r = await run(['status', '--nope'], { cliDir: fakeCliDir(), createContext: fakeContext });
  assert.equal(r.code, 2);
  assert.match(r.err, /unsung status: Unknown flag '--nope'\. Run 'unsung status --help' for its flags\./);
  const bad = await run(['status', '--top', 'many'], { cliDir: fakeCliDir(), createContext: fakeContext });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /expects a number/);
});

test('errors map to exit codes and are redacted', async () => {
  const cliDir = fakeCliDir();
  const opts = { cliDir, createContext: fakeContext };
  const config = await run(['status', '--mode', 'config'], opts);
  assert.deepEqual([config.code, config.err], [2, 'unsung status: Configuration is broken\n']);
  assert.equal((await run(['status', '--mode', 'auth'], opts)).code, 2);
  const crash = await run(['status', '--mode', 'crash'], opts);
  assert.equal(crash.code, 1);
  assert.match(crash.err, /Something odd happened\nRun again with --verbose for details\./);
  const verbose = await run(['status', '--mode', 'crash', '--verbose'], opts);
  assert.match(verbose.err, /at Object\.run/);
  const leak = await run(['status', '--mode', 'token'], opts);
  assert.equal(leak.code, 1);
  assert.ok(!leak.err.includes(TOKEN));
  assert.match(leak.err, /leaked \[REDACTED\]/);
});

test('a module without a command export, or one that fails to load, exits 1', async () => {
  const cliDir = fakeCliDir();
  const none = await run(['review'], { cliDir });
  assert.equal(none.code, 1);
  assert.match(none.err, /does not export a command/);
  const broken = await run(['digest'], { cliDir });
  assert.equal(broken.code, 1);
  assert.match(broken.err, /could not load src\/cli\/digest\.mjs/);
});

test('the script entry point sets the exit code (subprocess, no shell)', () => {
  const opts = /** @type {const} */ ({ encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const help = spawnSync(process.execPath, [BIN, '--help'], opts);
  assert.equal(help.status, 0, help.stderr);
  for (const name of ALL) assert.match(help.stdout, new RegExp(`^ {2}${name} `, 'm'));
  const unknown = spawnSync(process.execPath, [BIN, 'nonsense'], opts);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown command 'nonsense'/);
});

test('run takes no arguments: an unquoted "--lang Jupyter Notebook" fails and creates nothing', async () => {
  const data = path.join(tempDir('unsung-run-args-'), 'data');
  const r = await run(['run', '--lang', 'Jupyter', 'Notebook', '--dry-run', '--data', data]);
  assert.equal(r.code, 2, r.err);
  assert.match(r.err, /unsung run: run takes no arguments, got 'Notebook'/);
  assert.equal(existsSync(path.join(data, 'STORE_VERSION')), false);
  assert.equal(existsSync(data), false, 'the data directory is not created');
});
