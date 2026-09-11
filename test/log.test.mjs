// @ts-check
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createLog, formatMs } from '../src/log.mjs';
import { clearSecrets, registerSecret } from '../src/secrets.mjs';

afterEach(() => clearSecrets());

/** @returns {{lines: string[], stream: {write(s: string): void}}} */
function capture() {
  /** @type {string[]} */
  const lines = [];
  return { lines, stream: { write: (s) => { lines.push(s); } } };
}

const TOKEN = `ghp_${'Z'.repeat(36)}`;

test('text lines carry the message and key=value fields', () => {
  const { lines, stream } = capture();
  const log = createLog({ stream });
  log.info('hello', { n: 1, s: 'two words', ok: true, list: [1, 2] });
  assert.deepEqual(lines, ['hello n=1 s="two words" ok=true list=[1,2]\n']);
});

test('levels filter lower-severity lines and label the others', () => {
  const { lines, stream } = capture();
  const log = createLog({ level: 'warn', stream });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.deepEqual(lines, ['warning: w\n', 'error: e\n']);
  assert.equal(log.enabled('info'), false);
  assert.equal(log.enabled('error'), true);

  const verbose = capture();
  createLog({ level: 'debug', stream: verbose.stream }).debug('detail');
  assert.deepEqual(verbose.lines, ['debug: detail\n']);

  const silent = capture();
  const quiet = createLog({ level: 'silent', stream: silent.stream });
  quiet.error('nothing');
  quiet.stage('census', { text: 'x' });
  assert.deepEqual(silent.lines, []);
  assert.throws(() => createLog({ level: /** @type {any} */ ('loud') }), TypeError);
});

test('JSON mode writes one parseable object per line', () => {
  const { lines, stream } = capture();
  const log = createLog({ json: true, stream, now: () => '2026-09-11T12:00:00.000Z' });
  log.info('hello', { n: 1, at: 'ignored', nested: { a: [1] } });
  log.stage('census', { pages: 33, ms: 1200 });
  const [a, b] = lines.map((l) => JSON.parse(l));
  const at = '2026-09-11T12:00:00.000Z';
  assert.deepEqual(a, { at, level: 'info', msg: 'hello', n: 1, nested: { a: [1] } });
  assert.deepEqual(b, { at, level: 'info', stage: 'census', pages: 33, ms: 1200 });
  assert.ok(lines.every((l) => l.endsWith('\n') && !l.slice(0, -1).includes('\n')));
});

test('every string is redacted: messages, fields, nested values and errors', () => {
  registerSecret('pa"ss word\\x!');
  for (const json of [false, true]) {
    const { lines, stream } = capture();
    const log = createLog({ json, stream });
    log.info(`token ${TOKEN}`, {
      header: `Bearer ${TOKEN}`,
      deep: { list: [TOKEN, { again: 'pa"ss word\\x!' }] },
      err: new Error(`failed with pa"ss word\\x! and ${TOKEN}`),
      [TOKEN]: 'key',
    });
    log.stage(`stage ${TOKEN}`, { text: `found ${TOKEN}` });
    const all = lines.join('');
    assert.ok(!all.includes(TOKEN), `token leaked (json=${json})`);
    assert.ok(!all.includes('pa"ss'), `secret leaked (json=${json})`);
    assert.ok(!all.includes('pa\\"ss'), `escaped secret leaked (json=${json})`);
    assert.ok(all.includes('[REDACTED]'));
  }
});

test('stage lines follow the §9.2 layout', () => {
  const { lines, stream } = capture();
  const log = createLog({ stream });
  log.stage('census', { text: 'created 2026-09-08 · 9 windows · 33 pages · 3,301 repos', ms: 135_000 });
  log.stage('deep', { repos: 50, restCalls: 116 });
  log.stage('index', { text: 'data/index.json' });
  assert.deepEqual(lines, [
    'census     created 2026-09-08 · 9 windows · 33 pages · 3,301 repos  2m 15s\n',
    'deep       repos=50 restCalls=116\n',
    'index      data/index.json\n',
  ]);
});

test('formatMs', () => {
  assert.equal(formatMs(25_000), '0m 25s');
  assert.equal(formatMs(245_000), '4m 05s');
  assert.equal(formatMs(850), '850ms');
  assert.equal(formatMs(3_720_000), '1h 02m');
  assert.equal(formatMs(-1), '');
});

test('awkward field values never throw', () => {
  const { lines, stream } = capture();
  const log = createLog({ stream });
  /** @type {Record<string, unknown>} */
  const loop = { name: 'loop' };
  loop.self = loop;
  const when = new Date('2026-09-11T00:00:00Z');
  log.info('odd', { loop, big: 10n, when, fn: () => 1, nothing: undefined });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[Circular\]/);
  assert.match(lines[0], /big=10/);
  assert.match(lines[0], /2026-09-11T00:00:00.000Z/);
});

test('a broken stream does not throw', () => {
  const log = createLog({ stream: { write: () => { throw new Error('EPIPE'); } } });
  assert.doesNotThrow(() => log.info('still fine'));
});
