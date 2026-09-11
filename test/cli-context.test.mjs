// @ts-check
import { after, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG_DIR, NotAvailableError, PACKAGE_ROOT, createContext, packageVersion,
} from '../src/cli/context.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import { clearSecrets } from '../src/secrets.mjs';

const REPO_CONFIG = fileURLToPath(new URL('../config/', import.meta.url));
const NOW = '2026-09-11T12:00:00.000Z';
const TOKEN = `ghp_${'T'.repeat(36)}`;

/** @type {string[]} */
const temps = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
afterEach(() => clearSecrets());

/** @returns {string} a complete throwaway configuration directory */
function configDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'unsung-ctx-'));
  temps.push(dir);
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

/** @returns {{text: () => string, stream: {write(s: string): void}}} */
function sink() {
  /** @type {string[]} */
  const chunks = [];
  return { text: () => chunks.join(''), stream: { write: (s) => { chunks.push(s); } } };
}

/**
 * @param {Record<string, any>} [flags]
 * @param {Record<string, any>} [extra]
 */
async function ctxWith(flags = {}, extra = {}) {
  const logs = sink();
  const out = sink();
  const ctx = await createContext({
    flags: { config: configDir(), ...flags }, env: {}, now: () => NOW,
    stream: logs.stream, stdout: out.stream, ...extra,
  });
  return { ctx, logs, out };
}

test('the context carries config, directories, clock and version', async () => {
  const dir = configDir();
  const { ctx } = await ctxWith({ config: dir, data: 'somewhere' });
  assert.equal(ctx.configDir, path.resolve(dir));
  assert.equal(ctx.dataDir, path.resolve('somewhere'));
  assert.equal(ctx.config.defaults.lagDays, 3);
  assert.equal(ctx.config.calibration.version, 'c1');
  assert.equal(ctx.now(), NOW);
  assert.equal(ctx.clock.now(), NOW);
  assert.equal(ctx.clock.ms(), Date.parse(NOW));
  assert.equal(ctx.version, packageVersion());
  assert.equal(ctx.version, '0.1.0');
  assert.equal(ctx.userAgent, 'unsung/0.1.0 (+local; read-only)');
  assert.equal(ctx.signal.aborted, false);
  assert.deepEqual(ctx.argv, []);
});

test('the data directory comes from --data, then UNSUNG_DATA, then ./data', async () => {
  const env = { UNSUNG_DATA: 'env-data' };
  assert.equal((await ctxWith({}, { env })).ctx.dataDir, path.resolve('env-data'));
  assert.equal((await ctxWith({ data: 'flag-data' }, { env })).ctx.dataDir, path.resolve('flag-data'));
  assert.equal((await ctxWith()).ctx.dataDir, path.resolve('data'));
});

test('the default configuration directory is the bundled one', () => {
  assert.equal(DEFAULT_CONFIG_DIR, path.join(PACKAGE_ROOT, 'config'));
  assert.ok(existsSync(path.join(PACKAGE_ROOT, 'package.json')));
  assert.ok(existsSync(path.join(DEFAULT_CONFIG_DIR, 'defaults.json')));
});

test('rand is seeded by --seed, else derived from the start time', async () => {
  const seeded = (await ctxWith({ seed: 7 })).ctx;
  const ref = mulberry32(7);
  assert.equal(seeded.seed, 7);
  assert.deepEqual([seeded.rand(), seeded.rand()], [ref(), ref()]);
  const a = (await ctxWith()).ctx;
  const b = (await ctxWith()).ctx;
  assert.equal(a.seed, b.seed);
  assert.equal(a.rand(), b.rand());
  const later = (await ctxWith({}, { now: () => '2026-09-11T12:00:01.000Z' })).ctx;
  assert.notEqual(later.seed, a.seed);
});

test('an injected clock wins over now', async () => {
  const clock = { now: () => '2030-01-01T00:00:00.000Z', ms: () => 1, sleep: async () => {} };
  const { ctx } = await ctxWith({}, { clock });
  assert.equal(ctx.now(), '2030-01-01T00:00:00.000Z');
  assert.equal(ctx.clock, clock);
});

test('--verbose, --quiet and --json shape the logger', async () => {
  const verbose = await ctxWith({ verbose: true });
  verbose.ctx.log.debug('detail');
  assert.match(verbose.logs.text(), /debug: detail/);
  const quiet = await ctxWith({ quiet: true });
  quiet.ctx.log.info('chatter');
  quiet.ctx.log.warn('careful');
  assert.equal(quiet.logs.text(), 'warning: careful\n');
  const json = await ctxWith({ json: true });
  json.ctx.log.info('hello', { n: 1 });
  assert.deepEqual(JSON.parse(json.logs.text()), { at: NOW, level: 'info', msg: 'hello', n: 1 });
});

test('secrets in the environment are redacted from logs and output', async () => {
  const env = { GITHUB_TOKEN: 'plain-env-secret-1', ANTHROPIC_API_KEY: 'sk-ant-api-key-99' };
  const { ctx, logs, out } = await ctxWith({}, { env });
  ctx.log.info('using plain-env-secret-1 and sk-ant-api-key-99');
  ctx.print(`printed plain-env-secret-1 ${TOKEN}`);
  ctx.printJson({ key: 'sk-ant-api-key-99' });
  const all = logs.text() + out.text();
  assert.ok(!all.includes('plain-env-secret-1'));
  assert.ok(!all.includes('sk-ant-api-key-99'));
  assert.ok(!all.includes(TOKEN));
  assert.match(out.text(), /^printed \[REDACTED\] \[REDACTED\]\n\{\n {2}"key": "\[REDACTED\]"\n\}\n$/);
});

test('store() imports the store lazily, once, and passes now and log', async () => {
  let imports = 0;
  /** @type {any[]} */
  const opened = [];
  const fakeStore = { httpCache: { get() {}, put() {} } };
  const { ctx } = await ctxWith({ data: 'd1' }, {
    imports: {
      store: async () => {
        imports++;
        /** @type {(dir: string, opts: any) => Promise<any>} */
        const openStore = async (dir, opts) => {
          opened.push([dir, opts]);
          return fakeStore;
        };
        return { openStore };
      },
    },
  });
  assert.equal(imports, 0);
  const [s1, s2] = await Promise.all([ctx.store(), ctx.store()]);
  assert.equal(s1, fakeStore);
  assert.equal(s2, fakeStore);
  assert.equal(imports, 1);
  assert.equal(opened.length, 1);
  assert.equal(opened[0][0], path.resolve('d1'));
  assert.equal(opened[0][1].now(), NOW);
  assert.equal(opened[0][1].log, ctx.log);
});

test('a module that has not landed is reported as not yet available (exit 2)', async () => {
  let attempts = 0;
  const missing = async () => {
    attempts++;
    const err = new Error("Cannot find module 'src/store/store.mjs'");
    throw Object.assign(err, { code: 'ERR_MODULE_NOT_FOUND' });
  };
  const { ctx } = await ctxWith({}, { imports: { store: missing } });
  await assert.rejects(ctx.store(),
    (e) => e instanceof NotAvailableError && e.exitCode === 2 && /not yet available/.test(e.message));
  await assert.rejects(ctx.store(), NotAvailableError);
  assert.equal(attempts, 2);
  const broken = async () => { throw new SyntaxError('Unexpected token'); };
  const other = (await ctxWith({}, { imports: { store: broken } })).ctx;
  await assert.rejects(other.store(), SyntaxError);
});

test('github() wires token, governor, store cache and client, and never logs the token', async () => {
  /** @type {Record<string, any>} */
  const seen = {};
  const cache = { get() {}, put() {} };
  const governor = { name: 'governor' };
  const client = { name: 'client' };
  const { ctx, logs } = await ctxWith({ verbose: true }, {
    env: { SOME: 'thing' },
    imports: {
      store: async () => ({ openStore: async () => ({ httpCache: cache }) }),
      token: async () => ({
        getToken: (/** @type {any} */ args) => {
          seen.tokenArgs = args;
          return { token: TOKEN, source: 'gh' };
        },
      }),
      governor: async () => ({
        createGovernor: (/** @type {any} */ opts, /** @type {any} */ deps) => {
          seen.governor = [opts, deps];
          return governor;
        },
      }),
      client: async () => ({
        createClient: (/** @type {any} */ args) => {
          seen.client = args;
          return client;
        },
      }),
    },
  });
  const gh = await ctx.github();
  assert.equal(gh.client, client);
  assert.equal(gh.governor, governor);
  assert.equal(gh.tokenSource, 'gh');
  assert.equal(await ctx.client(), client);
  assert.equal(await ctx.governor(), governor);
  assert.deepEqual(seen.tokenArgs, { env: { SOME: 'thing' } });
  assert.deepEqual(seen.governor[0], ctx.config.defaults.governor);
  assert.equal(seen.governor[1].clock, ctx.clock);
  assert.equal(seen.client.token, TOKEN);
  assert.equal(seen.client.governor, governor);
  assert.equal(seen.client.cache, cache);
  assert.equal(seen.client.fetch, globalThis.fetch);
  assert.equal(seen.client.log, ctx.log);
  assert.equal(seen.client.userAgent, 'unsung/0.1.0 (+local; read-only)');
  ctx.log.info(`echo ${TOKEN}`);
  assert.ok(!logs.text().includes(TOKEN));
  assert.match(logs.text(), /GitHub client ready tokenSource=gh/);
});
