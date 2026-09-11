// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ArgsError, GLOBAL_FLAGS, camel, flagHelp, kebab, normaliseSpec, parseArgs,
} from '../src/cli/args.mjs';

test('the first positional is the command; the rest stay positional', () => {
  const r = parseArgs(['add', 'a/b', 'c/d', '--no-deep'], { 'no-deep': { type: 'boolean' } });
  assert.equal(r.command, 'add');
  assert.deepEqual(r.positionals, ['a/b', 'c/d']);
  assert.equal(r.flags['no-deep'], true);
  assert.equal(r.flags.noDeep, true);
  assert.equal(r.flags.deep, false);
  assert.deepEqual(r.given, ['no-deep']);
  assert.equal(parseArgs([], {}).command, null);
});

test('global flags are always available (§9.1)', () => {
  const r = parseArgs(['--data', 'd', 'status', '--json', '--seed', '7', '--config=conf'], {});
  assert.equal(r.command, 'status');
  assert.equal(r.flags.data, 'd');
  assert.equal(r.flags.config, 'conf');
  assert.equal(r.flags.json, true);
  assert.equal(r.flags.seed, 7);
  assert.equal(r.flags.verbose, false);
  assert.equal(r.flags.quiet, false);
  assert.equal(parseArgs(['-h'], {}).flags.help, true);
  assert.deepEqual(Object.keys(GLOBAL_FLAGS).sort(),
    ['config', 'data', 'help', 'json', 'quiet', 'seed', 'verbose']);
});

test('number and duration flags are converted and checked', () => {
  const spec = { top: { type: 'number' }, budget: { type: 'duration' } };
  const r = parseArgs(['recheck', '--top', '25', '--budget', '1h30m'], spec);
  assert.equal(r.flags.top, 25);
  assert.equal(r.flags.budget, 5_400_000);
  assert.equal(parseArgs(['--budget', 'none'], spec).flags.budget, null);
  assert.equal(parseArgs(['--top=-5'], spec).flags.top, -5);
  assert.throws(() => parseArgs(['--top', 'many'], spec), (e) => e instanceof ArgsError && e.exitCode === 2
    && /--top' expects a number/.test(e.message));
  assert.throws(() => parseArgs(['--budget', '10'], spec), /expects a duration such as 10m/);
});

test('defaults apply when a flag is absent, converted by type', () => {
  const spec = {
    top: { type: 'number', default: 100 },
    budget: { type: 'duration', default: '10m' },
    out: { type: 'string', default: 'site' },
    open: { type: 'boolean' },
    week: { type: 'string' },
  };
  const r = parseArgs(['export'], spec);
  assert.equal(r.flags.top, 100);
  assert.equal(r.flags.budget, 600_000);
  assert.equal(r.flags.out, 'site');
  assert.equal(r.flags.open, false);
  assert.equal('week' in r.flags, false);
  assert.deepEqual(r.given, []);
  assert.equal(parseArgs(['--top', '3'], spec).flags.top, 3);
});

test('every boolean can be negated with --no-x; the last occurrence wins', () => {
  const spec = { open: { type: 'boolean', default: true } };
  assert.equal(parseArgs([], spec).flags.open, true);
  assert.equal(parseArgs(['--no-open'], spec).flags.open, false);
  assert.equal(parseArgs(['--open', '--no-open'], spec).flags.open, false);
  assert.equal(parseArgs(['--no-open', '--open'], spec).flags.open, true);
  assert.equal(parseArgs(['--no-json'], {}).flags.json, false);
  assert.throws(() => parseArgs(['--no-open=1'], spec), /does not take a value/);
});

test('a declared no-x boolean also sets x', () => {
  const spec = { 'no-archive': { type: 'boolean' }, 'no-wait': { type: 'boolean' } };
  const r = parseArgs(['run', '--no-archive'], spec);
  assert.equal(r.flags.noArchive, true);
  assert.equal(r.flags.archive, false);
  assert.equal(r.flags.noWait, false);
  assert.equal(r.flags.wait, true);
});

test('names may be declared in camelCase; the command line uses kebab-case', () => {
  const spec = { enrichMax: { type: 'number' }, archiveHours: 'number' };
  const r = parseArgs(['run', '--enrich-max', '5', '--archive-hours=4'], spec);
  assert.equal(r.flags.enrichMax, 5);
  assert.equal(r.flags['enrich-max'], 5);
  assert.equal(r.flags.archiveHours, 4);
  assert.equal(parseArgs(['--enrichMax', '6'], spec).flags.enrichMax, 6);
  assert.equal(kebab('enrichMax'), 'enrich-max');
  assert.equal(camel('enrich-max'), 'enrichMax');
  assert.equal(camel('max-usd'), 'maxUsd');
});

test('the array form of a spec is accepted', () => {
  const r = parseArgs(['review', '--max-usd', '2.5', '--backend', 'claude-cli'], [
    { name: 'max-usd', type: 'number' },
    { name: 'backend', type: 'string', default: 'none' },
  ]);
  assert.equal(r.flags.maxUsd, 2.5);
  assert.equal(r.flags.backend, 'claude-cli');
});

test('unknown flags are rejected unless strict is off', () => {
  assert.throws(() => parseArgs(['run', '--nope'], {}),
    (e) => e instanceof ArgsError && /Unknown flag '--nope'/.test(e.message));
  assert.throws(() => parseArgs(['-z'], {}), /Unknown flag '-z'/);
  const r = parseArgs(['--nope', 'run', '--data', 'x'], {}, { strict: false });
  assert.equal(r.command, 'run');
  assert.equal(r.flags.data, 'x');
});

test('a flag that needs a value must get one', () => {
  const spec = { budget: { type: 'string' } };
  assert.throws(() => parseArgs(['run', '--budget'], spec), /'--budget' needs a value/);
  assert.throws(() => parseArgs(['run', '--budget', '--json'], spec), /needs a value/);
  assert.throws(() => parseArgs(['--json=maybe'], {}), /does not take a value/);
  assert.equal(parseArgs(['--json=false'], {}).flags.json, false);
});

test('multiple collects repeats; -- ends flag parsing', () => {
  const spec = { lang: { type: 'string', multiple: true } };
  assert.deepEqual(parseArgs(['--lang', 'rust', '--lang', 'go'], spec).flags.lang, ['rust', 'go']);
  assert.deepEqual(parseArgs([], spec).flags.lang, []);
  const r = parseArgs(['feedback', 'import', '--', '--not-a-flag.json'], {});
  assert.deepEqual(r.positionals, ['import', '--not-a-flag.json']);
});

test('a command may override a global flag definition', () => {
  assert.equal(parseArgs(['--seed', 'abc'], { seed: { type: 'string' } }).flags.seed, 'abc');
});

test('spec errors are programming errors', () => {
  assert.throws(() => normaliseSpec({ x: { type: /** @type {any} */ ('colour') } }), TypeError);
});

test('flagHelp lists flags with placeholders and defaults', () => {
  const lines = flagHelp({
    budget: { type: 'duration', summary: 'wall-clock budget', default: '10m' },
    deep: { type: 'number', arg: 'N', summary: 'repositories to deepen' },
    'dry-run': { type: 'boolean', summary: 'plan only' },
  });
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^ {2}--budget <duration> +wall-clock budget \(default 10m\)$/);
  assert.match(lines[1], /--deep N +repositories to deepen$/);
  assert.match(lines[2], /--dry-run +plan only$/);
});
