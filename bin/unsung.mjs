#!/usr/bin/env node
// @ts-check
/**
 * `unsung` command-line entry point (DESIGN §9.1, §12.1). Maps a command name to
 * `src/cli/<name>.mjs` (which exports `command = {name, summary, flags, run(args, ctx)}`), prints
 * help, and turns errors into exit codes: 0 finished, 1 unexpected, 2 configuration or usage,
 * 75 paused, 130 interrupted (§3.12).
 */

import { existsSync, realpathSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ArgsError, GLOBAL_FLAGS, flagHelp, parseArgs } from '../src/cli/args.mjs';
import { createContext, packageVersion } from '../src/cli/context.mjs';
import { redact } from '../src/secrets.mjs';

/** Every command of §9.1, with the usage and summary shown by `--help`. */
export const COMMANDS = Object.freeze([
  {
    name: 'run',
    usage: 'run [--budget 10m] [--profile quick|daily] [--lag 3] [--backfill 0] [--lang <L>] [--topic <T>] '
      + '[--until caught-up] [--no-archive] [--archive-hours N] [--deep N] [--enrich-max N] '
      + '[--no-wait] [--dry-run]',
    summary: 'Discover, filter, enrich, score and index new repositories within a budget',
  },
  {
    name: 'add', usage: 'add <owner/repo>… [--no-deep]',
    summary: 'Enrich, deepen, score and explain named repositories now',
  },
  {
    name: 'explain', usage: 'explain <owner/repo>',
    summary: 'Print the score, chips, why-not-higher and confidence explanation',
  },
  {
    name: 'status',
    usage: 'status [--audit] [--units]',
    summary: 'Show recent runs, the ledger, budget spent and source health',
  },
  {
    name: 'recheck', usage: 'recheck [--top 100]',
    summary: 'Refresh existence and traction for the top of the index',
  },
  {
    name: 'sample', usage: 'sample [--n 20]',
    summary: 'Draw a uniform sample of repositories for blind labelling',
  },
  {
    name: 'review',
    usage: 'review [--top 20] [--backend none|claude-cli|anthropic-api] [--model claude-opus-5] '
      + '[--effort high] [--max-usd 3] [--repo <o/r>] [--endpoint <url>] [--no-fallbacks]',
    summary: 'Optional LLM review of the repositories the heuristics are least sure about',
  },
  {
    name: 'export',
    usage: 'export [--out site] [--site-url <url>] [--issues-url <url>] [--title "Unsung picks"]',
    summary: 'Build the static gallery and Atom feeds from the picks you published',
  },
  {
    name: 'digest', usage: 'digest [--week YYYY-Www] [--out site/digest]',
    summary: 'Build the weekly digest',
  },
  {
    name: 'eval', usage: 'eval [--labels fixtures|feedback|all]',
    summary: 'Measure ranking and calibration against labels',
  },
  { name: 'calibrate', usage: 'calibrate [--write]', summary: 'Refit the quality calibration from labels' },
  {
    name: 'index', usage: 'index [--rescore]',
    summary: 'Rebuild the index; --rescore recomputes every kept score offline',
  },
  { name: 'compact', usage: 'compact [--migrate]', summary: 'Apply retention and compact old partitions' },
  { name: 'serve', usage: 'serve [--port 8750] [--open]', summary: 'Start the local explorer' },
  { name: 'feedback', usage: 'feedback import <file>', summary: 'Merge feedback exported from a Pages copy' },
]);

/** Directory holding the command modules. */
const CLI_DIR = fileURLToPath(new URL('../src/cli/', import.meta.url));

/** Error names and codes that mean a configuration, usage or authentication problem (exit 2). */
const EXIT_2_NAMES = new Set([
  'ArgsError', 'ConfigError', 'NotAvailableError', 'AuthError', 'TokenError', 'LockError',
]);
const EXIT_2_CODES = new Set(['EARGS', 'ECONFIG', 'ENOTAVAILABLE', 'EAUTH', 'ETOKEN', 'ELOCKED']);

/**
 * The general help text.
 * @param {string} [version]
 * @returns {string}
 */
export function helpText(version = packageVersion()) {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    `unsung ${version}: finds genuinely good GitHub repositories that almost nobody has noticed`,
    '',
    'Usage: unsung <command> [flags]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'Global flags:',
    ...flagHelp(GLOBAL_FLAGS),
    '',
    "Run 'unsung <command> --help' for the flags of one command.",
  ].join('\n');
}

/**
 * Help for one command, from its module when it has landed, else from the table above.
 * @param {{name: string, usage: string, summary: string}} entry
 * @param {{summary?: string, flags?: import('../src/cli/args.mjs').FlagSpec} | null} command
 * @returns {string}
 */
export function commandHelp(entry, command) {
  const lines = [`Usage: unsung ${entry.usage}`, '', command?.summary ?? entry.summary];
  const own = command ? flagHelp(command.flags ?? {}) : [];
  if (own.length > 0) lines.push('', 'Flags:', ...own);
  if (!command) lines.push('', 'This command is not yet available.');
  lines.push('', 'Global flags:', ...flagHelp(GLOBAL_FLAGS));
  return lines.join('\n');
}

/**
 * @param {unknown} err
 * @returns {number}
 */
function exitCodeOf(err) {
  const e = /** @type {{exitCode?: unknown, name?: unknown, code?: unknown}} */ (err ?? {});
  if (typeof e.exitCode === 'number' && Number.isInteger(e.exitCode)) return e.exitCode;
  if (EXIT_2_NAMES.has(String(e.name)) || EXIT_2_CODES.has(String(e.code))) return 2;
  if (e.name === 'AbortError' || e.name === 'InterruptError') return 130;
  return 1;
}

/**
 * @typedef {object} MainIo
 * @property {{write(chunk: string): unknown}} [stdout]
 * @property {{write(chunk: string): unknown}} [stderr]
 * @property {Record<string, string | undefined>} [env]
 * @property {string} [cliDir] where command modules live (tests point this at a temporary directory)
 * @property {typeof createContext} [createContext]
 * @property {boolean} [installSignals] handle Ctrl-C (default true)
 */

/**
 * Run the CLI with `argv` (without the node executable and script path) and resolve to the exit
 * code. The script entry point assigns it to `process.exitCode`.
 * @param {string[]} argv
 * @param {MainIo} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  /** @param {string} t */
  const out = (t) => stdout.write(`${redact(t)}\n`);
  /** @param {string} t */
  const err = (t) => stderr.write(`${redact(t)}\n`);

  /** @type {import('../src/cli/args.mjs').ParsedArgs} */
  let first;
  try {
    first = parseArgs(argv, null, { strict: false });
  } catch (e) {
    err(`unsung: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const name = first.command;

  if (name === null && (argv.includes('--version') || argv.includes('-V'))) {
    out(packageVersion());
    return 0;
  }
  if (name === null || name === 'help') {
    const topic = name === 'help' ? first.positionals[0] : undefined;
    if (topic === undefined) {
      if (name === null && !first.flags.help) {
        err(helpText());
        return 2;
      }
      out(helpText());
      return 0;
    }
    return main([topic, '--help'], io);
  }

  const entry = COMMANDS.find((c) => c.name === name);
  if (!entry) {
    err(`Unknown command '${name}'. Run 'unsung --help' to see the commands.`);
    return 2;
  }

  const file = path.join(io.cliDir ?? CLI_DIR, `${name}.mjs`);
  if (!existsSync(file)) {
    if (first.flags.help) out(commandHelp(entry, null));
    err(`unsung ${name}: not yet available`);
    return 2;
  }

  /** @type {any} */
  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    err(`unsung ${name}: could not load src/cli/${name}.mjs: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const command = mod?.command;
  if (!command || typeof command.run !== 'function') {
    err(`unsung ${name}: src/cli/${name}.mjs does not export a command`);
    return 1;
  }
  if (first.flags.help) {
    out(commandHelp(entry, command));
    return 0;
  }

  /** @type {import('../src/cli/args.mjs').ParsedArgs} */
  let args;
  try {
    args = parseArgs(argv, command.flags ?? {});
  } catch (e) {
    if (e instanceof ArgsError) {
      err(`unsung ${name}: ${e.message}. Run 'unsung ${name} --help' for its flags.`);
      return 2;
    }
    throw e;
  }

  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = () => {
    interrupts++;
    if (interrupts > 1 || getEventListeners(controller.signal, 'abort').length === 0) process.exit(130);
    err('Interrupted: finishing the request in flight and saving progress '
      + '(press Ctrl-C again to stop at once).');
    const reason = new Error('Interrupted');
    reason.name = 'InterruptError';
    controller.abort(reason);
  };
  const installSignals = io.installSignals !== false;
  if (installSignals) process.on('SIGINT', onSigint);
  try {
    const ctx = await (io.createContext ?? createContext)({
      flags: args.flags, env: io.env ?? process.env, argv, signal: controller.signal, stdout,
    });
    const code = await command.run(args, ctx);
    return Number.isInteger(code) ? code : 0;
  } catch (e) {
    const code = exitCodeOf(e);
    err(`unsung ${name}: ${e instanceof Error ? e.message : String(e)}`);
    if (code === 1) {
      if (args.flags.verbose && e instanceof Error && e.stack) err(e.stack);
      else err('Run again with --verbose for details.');
    }
    return code;
  } finally {
    if (installSignals) process.off('SIGINT', onSigint);
  }
}

/** @returns {boolean} whether this file is the script node was asked to run */
function isEntryPoint() {
  const script = process.argv[1];
  if (!script) return false;
  try {
    const a = realpathSync(script);
    const b = realpathSync(fileURLToPath(import.meta.url));
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(redact(e instanceof Error ? e.stack ?? e.message : String(e)));
      process.exitCode = 1;
    },
  );
}
