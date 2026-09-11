// @ts-check
/**
 * The explorer server (DESIGN §10.1) and the `serve` and `feedback import` commands (§9.1, §10.5).
 * Every test starts a real server on 127.0.0.1 with a free port, a throwaway data directory and an
 * in-memory stand-in for the store; nothing reaches the network or reads data/.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BODY_LIMIT, CSP, displayFacts, hostAllowed, isLoopback, startServer,
} from '../server.mjs';
import { command as feedbackCommand } from '../src/cli/feedback.mjs';
import { command as serveCommand, openBrowser } from '../src/cli/serve.mjs';
import { createLog } from '../src/log.mjs';
import { validateFeedback, validateTaste } from '../src/core/schema.mjs';
import { blindItem, pickHelpCalibrate } from '../src/core/views.mjs';
import { loadJsonFixture, loadRepoFixture } from './support/fixtures.mjs';

/** @typedef {import('../src/core/schema.mjs').Feedback} Feedback */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SAMPLE = loadJsonFixture('index.sample.json');
const NOW = '2026-09-11T16:00:00.000Z';
const silent = createLog({ level: 'silent' });
const TMP = mkdtempSync(path.join(os.tmpdir(), 'unsung-server-'));
let dirCount = 0;

after(() => rmSync(TMP, { recursive: true, force: true }));

const CONFIG = /** @type {any} */ ({
  defaults: JSON.parse(readFileSync(path.join(ROOT, 'config', 'defaults.json'), 'utf8')),
  weights: SAMPLE.model.weights,
  calibration: SAMPLE.model.calibration,
  institutions: { version: 1, allow: [], deny: [] },
});

/**
 * A fresh data directory, optionally holding an index.json.
 * @param {{index?: any}} [opts]
 * @returns {string}
 */
function dataDir({ index } = {}) {
  const dir = path.join(TMP, `data-${++dirCount}`);
  mkdirSync(dir, { recursive: true });
  if (index) writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index));
  return dir;
}

/**
 * An in-memory stand-in for the Store interface (§12.3), with just what the server calls.
 * @param {{index?: any, records?: Record<string, any>, feedback?: Feedback[], taste?: any,
 *   lockError?: boolean, runs?: any[], units?: any[]}} [opts]
 */
function memoryStore(opts = {}) {
  const s = {
    index: opts.index ?? null,
    records: new Map(Object.entries(opts.records ?? {})),
    feedback: /** @type {Feedback[]} */ ([...(opts.feedback ?? [])]),
    taste: opts.taste ?? null,
    /** @type {string | false} */
    locked: false,
    async readIndex() {
      return s.index;
    },
    /** @param {string} nwo */
    async getRepo(nwo) {
      return s.records.get(nwo) ?? null;
    },
    async *listRepos() {
      for (const r of s.records.values()) yield r;
    },
    /** @param {Feedback} ev */
    async appendFeedback(ev) {
      s.feedback.push(ev);
    },
    async readFeedback() {
      return s.feedback.slice();
    },
    async readTaste() {
      return s.taste;
    },
    /** @param {any} t */
    async writeTaste(t) {
      s.taste = t;
    },
    /** @param {number} n */
    async lastRuns(n) {
      return (opts.runs ?? []).slice(0, n);
    },
    ledger: {
      /** @param {{state: string}} q */
      list: ({ state }) => (opts.units ?? []).filter((u) => u.state === state),
    },
    /** @param {string} runId */
    async lock(runId) {
      if (opts.lockError) {
        const e = new Error('Locked');
        e.name = 'LockError';
        throw e;
      }
      s.locked = runId;
    },
    async unlock() {
      s.locked = false;
    },
    httpCache: { get() {}, put() {} },
  };
  return s;
}

/**
 * Start a server for one test; it is closed after the test file.
 * @param {Partial<import('../server.mjs').ServerOptions>} [opts]
 */
async function serve(opts = {}) {
  const started = await startServer({
    dataDir: opts.dataDir ?? dataDir(), config: null, now: () => NOW, log: silent, port: 0, ...opts,
  });
  after(() => started.close());
  return started;
}

/**
 * @typedef {{status: number, headers: http.IncomingHttpHeaders, text: string, json: any}} Reply
 */

/**
 * @param {number} port
 * @param {{method?: string, path?: string, headers?: Record<string, string>, body?: string | Buffer | null,
 *   host?: string | null}} [opts] `host: null` sends no Host header at all
 * @returns {Promise<Reply>}
 */
function request(port, { method = 'GET', path: p = '/', headers = {}, body = null, host } = {}) {
  return new Promise((resolve, reject) => {
    const hostHeader = host === null ? {} : { host: host ?? `127.0.0.1:${port}` };
    const req = http.request({
      host: '127.0.0.1', port, method, path: p, agent: false, setHost: false,
      headers: { ...hostHeader, ...headers },
    }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        /** @type {any} */
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          json = null;
        }
        resolve({ status: /** @type {number} */ (res.statusCode), headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

/**
 * @param {number} port
 * @param {string} p
 * @param {unknown} value
 * @param {Record<string, string>} [headers]
 */
function post(port, p, value, headers = {}) {
  return request(port, {
    method: 'POST', path: p, body: JSON.stringify(value),
    headers: { 'content-type': 'application/json', 'x-unsung': '1', ...headers },
  });
}

/** @param {Reply} r */
function assertSecure(r) {
  assert.equal(r.headers['content-security-policy'], CSP);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['referrer-policy'], 'no-referrer');
}

const codefly = SAMPLE.entries.find((/** @type {any} */ e) => e.nwo === 'codefly-dev/cli');

/**
 * A feedback body as the explorer sends it (no v, no at).
 * @param {any} entry
 * @param {string} action
 * @param {Record<string, unknown>} [extra]
 */
function body(entry, action, extra = {}) {
  return { id: entry.id, nwo: entry.nwo, action, note: '', blind: false, undoes: null, snoozeUntil: null,
    reason: null, context: { view: 'promising', position: 0 }, ...extra };
}

test('the CSP is exactly the one of §10.1', () => {
  assert.equal(CSP, "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
});

test('loopback addresses and Host names', () => {
  for (const ok of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) assert.ok(isLoopback(ok), ok);
  for (const bad of ['10.0.0.2', '192.168.1.5', '::ffff:10.0.0.1', 'fe80::1', '', undefined]) {
    assert.ok(!isLoopback(bad), String(bad));
  }
  assert.ok(hostAllowed('127.0.0.1:8750', 8750));
  assert.ok(hostAllowed('LOCALHOST:8750', 8750));
  for (const bad of ['127.0.0.1', 'localhost', '127.0.0.1:8751', 'evil.example:8750', '0.0.0.0:8750',
    '[::1]:8750', 'localhost.evil.example:8750']) {
    assert.ok(!hostAllowed(bad, 8750), bad);
  }
});

test('foreign Host headers are refused with 421, and every answer carries the security headers', async () => {
  const { port } = await serve();
  const ok = await request(port, { path: '/' });
  assert.equal(ok.status, 200);
  assert.match(String(ok.headers['content-type']), /^text\/html/);
  assertSecure(ok);
  assert.equal((await request(port, { path: '/', host: `localhost:${port}` })).status, 200);
  for (const host of ['evil.example', `evil.example:${port}`, '127.0.0.1:1', `127.0.0.1.nip.io:${port}`]) {
    const r = await request(port, { path: '/api/index', host });
    assert.equal(r.status, 421, host);
    assertSecure(r);
  }
  assert.equal((await request(port, { path: '/', host: null })).status, 421, 'no Host header at all');
  const missing = await request(port, { path: '/nothing-here' });
  assert.equal(missing.status, 404);
  assertSecure(missing);
  const put = await request(port, { method: 'PUT', path: '/' });
  assert.equal(put.status, 405);
  assert.equal(put.headers.allow, 'GET, HEAD');
  assertSecure(put);
});

test('only web/ and the core modules are served: no traversal, no listings', async () => {
  const { port } = await serve();
  for (const [p, type] of [['/web/app.mjs', /javascript/], ['/web/style.css', /text\/css/],
    ['/web/views/queue.mjs', /javascript/], ['/src/core/views.mjs', /javascript/], ['/index.html', /html/]]) {
    const r = await request(port, { path: /** @type {string} */ (p) });
    assert.equal(r.status, 200, String(p));
    assert.match(String(r.headers['content-type']), /** @type {RegExp} */ (type));
  }
  const refused = [
    '/web/../server.mjs', '/web/%2e%2e/server.mjs', '/web/..%2fserver.mjs', '/web/..%5cserver.mjs',
    '/web/%2e%2e%5cserver.mjs', '/src/core/../../server.mjs', '/src/core/..%2f..%2fserver.mjs',
    '/src/cli/args.mjs', '/src/config.mjs', '/src/core/', '/web/', '/web/views/',
    '/test/fixtures/index.sample.json', '/data/index.json', '/package.json', '/server.mjs', '/web/.hidden',
    '/web/index.html::$DATA', '/web/app.mjs%00.css', '/src/core/schema.mjs.bak', '/src/core/Views.MJS',
    '/config/defaults.json', '/.git/config',
  ];
  for (const p of refused) {
    const r = await request(port, { path: p });
    assert.ok(r.status === 404 || r.status === 400, `${p} answered ${r.status}`);
    assert.ok(!r.text.includes('import'), `${p} leaked a file`);
  }
  const first = await request(port, { path: '/web/style.css' });
  const again = await request(port, { path: '/web/style.css',
    headers: { 'if-none-match': String(first.headers.etag) } });
  assert.equal(again.status, 304);
  assertSecure(again);
  const head = await request(port, { method: 'HEAD', path: '/web/app.mjs' });
  assert.equal(head.status, 200);
  assert.equal(head.text, '');
});

test('before any run the index is the examples, marked as such, with an ETag', async () => {
  const { port } = await serve();
  const r = await request(port, { path: '/api/index' });
  assert.equal(r.status, 200);
  assert.equal(r.json.examples, true);
  assert.equal(r.json.entries.length, SAMPLE.entries.length);
  assert.ok(r.headers.etag);
  const etag = String(r.headers.etag);
  const again = await request(port, { path: '/api/index', headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  const zipped = await request(port, { path: '/api/index', headers: { 'accept-encoding': 'gzip, deflate' } });
  assert.equal(zipped.headers['content-encoding'], 'gzip');
  assert.equal((await request(port, { path: '/api/taste' })).json.facets.constructor, Object);
  const fb = await post(port, '/api/feedback', body(codefly, 'gem'));
  assert.equal(fb.status, 409, 'examples keep their feedback in the browser');
});

test('POSTs need JSON, x-unsung: 1, a same-origin Origin, and at most 64 KB', async () => {
  const store = memoryStore({ index: SAMPLE });
  const { port } = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => store });
  const good = JSON.stringify(body(codefly, 'snooze'));
  const cases = [
    [{ 'x-unsung': '1' }, 415],
    [{ 'content-type': 'text/plain', 'x-unsung': '1' }, 415],
    [{ 'content-type': 'application/x-www-form-urlencoded', 'x-unsung': '1' }, 415],
    [{ 'content-type': 'application/json' }, 403],
    [{ 'content-type': 'application/json', 'x-unsung': '0' }, 403],
    [{ 'content-type': 'application/json', 'x-unsung': '1', origin: 'https://evil.example' }, 403],
    [{ 'content-type': 'application/json', 'x-unsung': '1', origin: 'null' }, 403],
    [{ 'content-type': 'application/json', 'x-unsung': '1', origin: `http://localhost:${port}` }, 403],
    [{ 'content-type': 'application/json', 'x-unsung': '1', 'sec-fetch-site': 'cross-site' }, 403],
  ];
  for (const [headers, status] of cases) {
    const r = await request(port, { method: 'POST', path: '/api/feedback', body: good,
      headers: /** @type {Record<string, string>} */ (headers) });
    assert.equal(r.status, status, JSON.stringify(headers));
    assertSecure(r);
  }
  assert.equal(store.feedback.length, 0, 'nothing refused was stored');
  const same = await post(port, '/api/feedback', body(codefly, 'snooze'), {
    origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin',
    'content-type': 'application/json; charset=utf-8',
  });
  assert.equal(same.status, 200);
  assert.equal(same.json.event.snoozeUntil, '2026-10-11T16:00:00.000Z', 'a snooze defaults to 30 days');
  const big = await request(port, { method: 'POST', path: '/api/feedback', body: 'x'.repeat(BODY_LIMIT + 1),
    headers: { 'content-type': 'application/json', 'x-unsung': '1' } });
  assert.equal(big.status, 413);
  assertSecure(big);
  const bad = await request(port, { method: 'POST', path: '/api/feedback', body: '{"id":',
    headers: { 'content-type': 'application/json', 'x-unsung': '1' } });
  assert.equal(bad.status, 400);
  const wrongMethod = await request(port, { path: '/api/feedback' });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  assert.equal((await request(port, { path: '/api/nothing' })).status, 404);
});

test('POST /api/feedback validates, appends, rebuilds taste and answers {taste, entry, event}', async () => {
  const store = memoryStore({ index: SAMPLE, taste: { v: 1, updatedAt: NOW, facets: {
    'lang:rust': { gems: 0, notmine: 0, pin: -1 } } } });
  const { port } = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => store });
  const r = await post(port, '/api/feedback', { ...body(codefly, 'gem'), label: 'X', extra: 'dropped' });
  assert.equal(r.status, 200);
  const { taste, entry, event } = r.json;
  assert.equal(event.v, 1);
  assert.equal(event.at, NOW);
  assert.equal(event.label, 'G', 'the label is derived, not taken from the client');
  assert.equal(event.extra, undefined);
  assert.deepEqual(validateFeedback(event), []);
  assert.deepEqual(store.feedback, [event]);
  assert.deepEqual(validateTaste(taste), []);
  assert.equal(taste.facets['lang:go'].gems, 1);
  assert.equal(taste.facets['lang:rust'].pin, -1, 'pins survive the rebuild');
  assert.deepEqual(store.taste, taste);
  assert.equal(entry.feedback.last.action, 'gem');

  const index = (await request(port, { path: '/api/index' })).json;
  assert.equal(index.examples, undefined);
  assert.equal(index.entries.find((/** @type {any} */ e) => e.id === codefly.id).feedback.last.action, 'gem');

  const publish = await post(port, '/api/feedback', body(codefly, 'publish', { note: 'Lovely' }));
  assert.equal(publish.status, 200);
  assert.equal(publish.json.entry.feedback.published, true);
  assert.ok(publish.json.event.at > event.at, 'times are unique and increasing');

  const undo = await post(port, '/api/feedback', body(codefly, 'undo', { undoes: event.at }));
  assert.equal(undo.status, 200);
  assert.equal(undo.json.entry.feedback.last, null);
  assert.equal(undo.json.taste.facets['lang:go'], undefined);
  assert.equal((await post(port, '/api/feedback', body(codefly, 'undo', { undoes: event.at }))).status, 409);

  const other = SAMPLE.entries.find((/** @type {any} */ e) => e.nwo === 'zaghaghi/toolog');
  const early = await post(port, '/api/feedback', body(other, 'publish'));
  assert.equal(early.status, 409, 'publish needs a gem');
  const invalid = await post(port, '/api/feedback', body(other, 'notgood'));
  assert.equal(invalid.status, 400);
  assert.ok(Array.isArray(invalid.json.problems));
  assert.equal((await post(port, '/api/feedback', [1, 2])).status, 400);
  const tooLong = await post(port, '/api/feedback', body(other, 'gem', { note: 'x'.repeat(281) }));
  assert.equal(tooLong.status, 400);
});

test('POST /api/taste pins, mutes and resets a facet', async () => {
  const store = memoryStore({ index: SAMPLE });
  const { port } = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => store });
  const r = await post(port, '/api/taste', { facet: 'Lang:Go', pin: 1 });
  assert.equal(r.status, 200);
  assert.equal(r.json.taste.facets['lang:go'].pin, 1);
  assert.deepEqual(validateTaste(store.taste), []);
  const reset = await post(port, '/api/taste', { facet: 'lang:go', pin: 0 });
  assert.equal(reset.json.taste.facets['lang:go'], undefined);
  for (const bad of [{ facet: 'go', pin: 1 }, { facet: 'lang:go', pin: 2 }, { facet: 'lang:go' }, null]) {
    assert.equal((await post(port, '/api/taste', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await request(port, { path: '/api/taste' })).json.facets['lang:go'], undefined);
});

test('GET /api/repo: the record, 404, or only identity and gate reasons when quarantined', async () => {
  const record = { v: 1, id: 'R_1', nwo: 'o/r', facts: { readme: { text: '# hi' } },
    score: { lane: 'promising' } };
  const bad = { v: 1, id: 'R_2', nwo: 'o/lure', facts: { readme: { text: 'download crack.zip' } },
    score: { lane: 'quarantine', gates: [{ id: 'g.lure.link', action: 'quarantine', reason: 'Links a zip',
      evidence: [{ label: 'x', url: 'https://x' }] }] } };
  const store = memoryStore({ index: SAMPLE, records: { 'o/r': record, 'o/lure': bad } });
  const { port } = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => store });
  assert.deepEqual((await request(port, { path: '/api/repo/o/r' })).json, record);
  assert.equal((await request(port, { path: '/api/repo/o/missing' })).status, 404);
  const q = await request(port, { path: '/api/repo/o/lure' });
  assert.equal(q.status, 200);
  assert.equal(q.json.quarantined, true);
  assert.equal(q.json.facts, undefined);
  assert.ok(!q.text.includes('crack.zip'));
  assert.deepEqual(q.json.gates, [{ id: 'g.lure.link', action: 'quarantine', reason: 'Links a zip' }]);
  assert.equal((await request(port, { path: '/api/repo/o%2Fx/y' })).status, 400);
  assert.equal((await request(port, { path: '/api/repo/-o/r' })).status, 400);
});

test('the examples have detail records built from the fixtures, without scores', async () => {
  const { port } = await serve();
  const r = await request(port, { path: '/api/repo/skulitom/london-time-map' });
  assert.equal(r.status, 200);
  assert.equal(r.json.example, true);
  assert.equal(r.json.score, null);
  assert.ok(r.json.facts.readme.text.length > 100);
  assert.ok(r.json.facts.tree.entries.length > 10);
  assert.ok(r.json.facts.commits.recent.length >= 1);
  const q = await request(port, { path: '/api/repo/TigerSeparate/zaPReTTeLeGrAM' });
  assert.equal(q.json.quarantined, true);
  assert.equal(q.json.facts, undefined);
});

test('displayFacts maps a recorded node onto the Facts fields the explorer shows', () => {
  const fx = loadRepoFixture('montezuma-p/harken');
  const facts = displayFacts(fx.nwo, fx.enrich, { deep: fx.deep, tree: fx.tree, stars: fx.stars });
  assert.equal(facts.primaryLanguage, 'Rust');
  assert.equal(facts.readme && /** @type {any} */ (facts.readme).name, 'README.md');
  assert.ok(/** @type {any} */ (facts.releases).count >= 1);
  const weeks = /** @type {any} */ (facts.starHistory).weeks;
  assert.ok(weeks.length > 0 && weeks[0].week < weeks[weeks.length - 1].week, 'oldest first');
  assert.equal(/** @type {any} */ (facts.starHistory).gain4w, 13);
  const item = blindItem({ id: 'R_h', nwo: fx.nwo, facts: /** @type {any} */ (facts) }, 'pool');
  assert.equal(item.lang, 'Rust');
  assert.ok(item.tree && item.tree.top.length > 0);
});

test('GET /api/model uses the configuration, else the model stored in the index', async () => {
  const withConfig = await serve({ config: CONFIG });
  assert.equal((await request(withConfig.port, { path: '/api/model' })).json.weights.version,
    CONFIG.weights.version);
  const without = await serve();
  const m = (await request(without.port, { path: '/api/model' })).json;
  assert.deepEqual(m, { weights: SAMPLE.model.weights, calibration: SAMPLE.model.calibration });
});

test('GET /api/status reports runs, units, the lock and the budget', async () => {
  const run = { ...SAMPLE.lastRun, runId: '20260911T155000Z-aaaa' };
  const store = memoryStore({ index: SAMPLE, runs: [run], units: [
    { key: 'a', state: 'done' }, { key: 'b', state: 'done' }, { key: 'c', state: 'failed' }] });
  const dir = dataDir({ index: SAMPLE });
  writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: process.pid, runId: 'r1', startedAt: NOW }));
  const { port } = await serve({ dataDir: dir, openStore: () => store });
  const s = (await request(port, { path: '/api/status' })).json;
  assert.deepEqual(s.units, { done: 2, failed: 1 });
  assert.equal(s.runs[0].runId, run.runId);
  assert.deepEqual(s.rate, run.rate);
  assert.equal(s.lock.live, true);
  assert.equal(s.examples, false);
  writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: process.pid, runId: 'r1',
    startedAt: '2026-09-11T08:00:00.000Z' }));
  const stale = (await request(port, { path: '/api/status' })).json;
  assert.equal(stale.lock.live, false, 'older than 6 h is stale');
  const examples = (await request((await serve()).port, { path: '/api/status' })).json;
  assert.equal(examples.examples, true);
  assert.deepEqual(examples.runs, [], 'the examples\' fixture run is not a run of this store');
  assert.equal(examples.rate, null);
});

test('every request refuses a browser that says it comes from another site (§10.1)', async () => {
  const record = { v: 1, id: 'R_1', nwo: 'o/n', facts: { description: 'x' }, score: { lane: 'promising' } };
  const store = memoryStore({ index: SAMPLE, records: { 'o/n': record } });
  const { port } = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => store });
  const paths = ['/api/index', '/api/status', '/api/calibrate?n=1', '/api/repo/o/n', '/api/model', '/api/taste',
    '/web/app.mjs', '/src/core/views.mjs', '/', '/index.html'];
  for (const site of ['cross-site', 'same-site']) {
    for (const p of paths) {
      for (const method of ['GET', 'HEAD']) {
        const r = await request(port, { method, path: p, headers: { 'sec-fetch-site': site, 'sec-fetch-mode': 'no-cors' } });
        assert.equal(r.status, 403, `${method} ${p} (${site})`);
        assertSecure(r);
      }
    }
  }
  for (const headers of [{ 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-site': 'none' }, {}]) {
    for (const p of paths) {
      const r = await request(port, { path: p, headers });
      assert.equal(r.status, 200, `${p} ${JSON.stringify(headers)}`);
    }
  }
  const navigate = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  assert.equal((await request(port, { path: '/', headers: navigate })).status, 200,
    'a link from elsewhere still opens the explorer');
  assert.equal((await request(port, { path: '/api/index', headers: navigate })).status, 403,
    'only the page itself opens that way');
  assert.equal((await request(port, { path: '/', headers: { ...navigate, 'sec-fetch-dest': 'iframe' } })).status,
    403, 'not in a frame');
  const cross = await post(port, '/api/feedback', body(codefly, 'snooze'), { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 403);
  assert.equal(store.feedback.length, 0);
});

test('POST /api/feedback refuses to triage a quarantined repository, but an undo may tidy up', async () => {
  const q = SAMPLE.entries.find((/** @type {any} */ e) => e.lane === 'quarantine');
  const gem = { v: 1, at: '2026-09-10T10:00:00.000Z', id: q.id, nwo: q.nwo, action: 'gem', label: 'G',
    reason: null, note: '', blind: false, undoes: null, snoozeUntil: null, context: null };
  const store = memoryStore({ index: SAMPLE, feedback: [/** @type {any} */ (gem)] });
  const { port } = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => store });
  for (const action of ['gem', 'wip', 'notmine', 'snooze', 'publish']) {
    const r = await post(port, '/api/feedback', body(q, action));
    assert.equal(r.status, 409, action);
  }
  assert.match((await post(port, '/api/feedback', body(q, 'publish'))).json.error, /never published/);
  const label = await post(port, '/api/feedback', body(q, 'label', { label: 'X', blind: true }));
  assert.equal(label.status, 409);
  assert.equal(store.feedback.length, 1, 'nothing refused was stored');
  const undo = await post(port, '/api/feedback', body(q, 'undo', { undoes: gem.at }));
  assert.equal(undo.status, 200, 'an earlier decision can still be undone');
});

test('POST /api/feedback answers 422 unless its id and nwo name a known repository (§10.1)', async () => {
  const kept = { v: 1, id: 'R_kept', nwo: 'o/kept', gone: false,
    candidate: { sources: ['census:2026-09-08'], seenAt: '' },
    facts: { description: 'kept but not indexed', primaryLanguage: 'Go', readme: null, root: [] },
    score: { lane: 'low' } };
  const store = memoryStore({ index: SAMPLE, records: { 'o/kept': kept } });
  const { port } = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => store });
  assert.equal((await post(port, '/api/feedback', body(codefly, 'snooze'))).status, 200, 'an index entry');
  assert.equal((await post(port, '/api/feedback', body(kept, 'notmine'))).status, 200,
    'a stored record the index does not list');
  const shouted = { id: codefly.id, nwo: codefly.nwo.toUpperCase() };
  assert.equal((await post(port, '/api/feedback', body(shouted, 'notmine'))).status, 200,
    'names compare without case');
  const stored = store.feedback.length;
  assert.equal(stored, 3);
  /** @type {[string, {id: string, nwo: string}, string][]} */
  const refused = [
    ['an unknown id and name', { id: 'R_nobody', nwo: 'nobody/nothing' }, 'gem'],
    ['an indexed id under another name', { id: codefly.id, nwo: 'someone/else' }, 'gem'],
    ['an indexed name under another id', { id: 'R_other', nwo: codefly.nwo }, 'notmine'],
    ['a stored name under another id', { id: 'R_other', nwo: kept.nwo }, 'snooze'],
    ['a stored id under another name', { id: kept.id, nwo: 'o/moved' }, 'wip'],
    ['a blind label on an item nobody drew', { id: 'R_nobody', nwo: 'nobody/nothing' }, 'label'],
  ];
  for (const [what, target, action] of refused) {
    const extra = action === 'label'
      ? { label: 'G', blind: true, context: { view: 'calibrate', stratum: 'pool' } } : {};
    const r = await post(port, '/api/feedback', body(target, action, extra));
    assert.equal(r.status, 422, what);
    assert.match(r.json.error,
      /^Unsung does not know \S+ with that id: feedback must name a repository from the /, what);
    assert.ok(r.json.error.endsWith('so nothing was saved'), what);
    assertSecure(r);
  }
  assert.match((await post(port, '/api/feedback', body(refused[5][1], 'label', { label: 'G', blind: true })))
    .json.error, /from the index, the store or a Calibrate draw/);
  assert.equal(store.feedback.length, stored, 'nothing refused was stored');
  const examples = await serve();
  assert.equal((await post(examples.port, '/api/feedback', body(refused[0][1], 'gem'))).status, 409,
    'the examples still keep every decision in the browser');
});

test('blind labels on Calibrate draws and help-calibrate cards stay known (§10.6, §10.7)', async () => {
  /** @param {string} id */
  const rec = (id) => ({ v: 1, id, nwo: `o/${id}`, gone: false,
    candidate: { sources: ['sample'], seenAt: '2026-09-10T00:00:00Z' },
    facts: { description: `about ${id}`, primaryLanguage: 'Go', root: [],
      readme: { name: 'README.md', bytes: 9, truncated: false, text: '# readme' } },
    score: { lane: 'look' } });
  const store = memoryStore({ index: SAMPLE, records: { 'o/c1': rec('c1'), 'o/c2': rec('c2') } });
  const { port } = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => store });
  const items = (await request(port, { path: '/api/calibrate?n=2&seed=3' })).json.items;
  assert.deepEqual(items.map((/** @type {any} */ i) => i.id).sort(), ['c1', 'c2']);
  /** @param {any} target @param {string} view @param {string} stratum */
  const label = (target, view, stratum) => body(target, 'label', { label: 'G', blind: true,
    context: { view, stratum } });
  const [a, b] = items;
  assert.equal((await post(port, '/api/feedback', label(a, 'calibrate', a.stratum))).status, 200,
    'a Calibrate draw');
  store.records.delete(b.nwo); // its record is compacted away before the label arrives
  assert.equal((await post(port, '/api/feedback', label(b, 'calibrate', b.stratum))).status, 200,
    'a draw stays known for its blind label');
  assert.equal((await post(port, '/api/feedback', body(b, 'notmine'))).status, 422,
    'only a label may rest on the draw alone');
  const help = pickHelpCalibrate(SAMPLE.entries);
  assert.ok(help, 'the examples have an entry in the uncertain band');
  assert.equal((await post(port, '/api/feedback', label(help, 'help', 'pool'))).status, 200,
    'a help-calibrate card');
  assert.deepEqual(store.feedback.map((e) => [e.id, e.action, e.label, e.context?.view]),
    [[a.id, 'label', 'G', 'calibrate'], [b.id, 'label', 'G', 'calibrate'], [help.id, 'label', 'G', 'help']]);
  const examples = await serve();
  const drawn = (await request(examples.port, { path: '/api/calibrate?n=2' })).json;
  assert.equal(drawn.examples, true);
  assert.equal(drawn.items.length, 2, 'Calibrate still draws from the examples');
});

test('an undo is known through the decision it takes back, even once its record has gone', async () => {
  /** @param {string} id */
  const rec = (id) => ({ v: 1, id, nwo: `o/${id}`, gone: false,
    candidate: { sources: ['sample'], seenAt: '2026-09-10T00:00:00Z' },
    facts: { description: `about ${id}`, primaryLanguage: 'Go', root: [],
      readme: { name: 'README.md', bytes: 9, truncated: false, text: '# readme' } },
    score: { lane: 'look' } });
  const store = memoryStore({ index: SAMPLE, records: { 'o/u1': rec('u1'), 'o/u2': rec('u2') } });
  const { port } = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => store });
  const items = (await request(port, { path: '/api/calibrate?n=2&seed=3' })).json.items;
  assert.equal(items.length, 2);
  for (const it of items) {
    store.records.delete(it.nwo); // compacted away before the label arrives
    const labelled = await post(port, '/api/feedback', body(it, 'label', { label: 'G', blind: true,
      context: { view: 'calibrate', stratum: it.stratum } }));
    assert.equal(labelled.status, 200, 'the label rests on the draw');
    const undoes = labelled.json.event.at;
    const elsewhere = await post(port, '/api/feedback', body({ id: it.id, nwo: 'someone/else' }, 'undo',
      { undoes }));
    assert.equal(elsewhere.status, 422, 'an undo under another name is still unknown');
    assert.match(elsewhere.json.error, /from the index, the store or the decision it undoes/);
    const undone = await post(port, '/api/feedback', body(it, 'undo', { undoes }));
    assert.equal(undone.status, 200, 'its undo rests on the logged label it takes back');
    const again = await post(port, '/api/feedback', body(it, 'undo', { undoes }));
    assert.equal(again.status, 409, 'a second undo is a decision no longer in force, not an unknown one');
  }
  const stranger = await post(port, '/api/feedback', body({ id: 'R_nobody', nwo: 'nobody/nothing' }, 'undo',
    { undoes: store.feedback[0].at }));
  assert.equal(stranger.status, 422, 'an undo cannot bring in a repository nobody knows');
  assert.deepEqual(store.feedback.map((e) => e.action), ['label', 'undo', 'label', 'undo']);
});

test('GET /api/calibrate: a fresh seed draws other items, the same seed the same ones', async () => {
  /** @type {Record<string, any>} */
  const records = {};
  for (let i = 0; i < 30; i++) {
    records[`o/p${i}`] = { v: 1, id: `p${i}`, nwo: `o/p${i}`, gone: false,
      candidate: { sources: ['census:2026-09-08'], seenAt: '' },
      facts: { description: `about ${i}`, primaryLanguage: 'Go', readme: null, root: [] }, score: { lane: 'look' } };
  }
  const store = memoryStore({ index: SAMPLE, records });
  const { port } = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => store });
  /** @param {string} q */
  const ids = async (q) => (await request(port, { path: `/api/calibrate?${q}` })).json.items
    .map((/** @type {any} */ i) => i.id);
  const daily = await ids('n=5');
  assert.equal(daily.length, 5);
  assert.deepEqual(await ids('n=5'), daily, 'without a seed, the draw of the day');
  const one = await ids('n=5&seed=1');
  assert.deepEqual(await ids('n=5&seed=1'), one, 'the same seed repeats the draw');
  assert.notDeepEqual(await ids('n=5&seed=2'), one, 'another seed draws other items');
  assert.notDeepEqual(await ids('n=5&seed=4294967295'), one);
});

test('GET /api/calibrate draws blind items: sample first, then a seeded draw from the pool', async () => {
  /**
   * @param {string} id
   * @param {string[]} sources
   * @param {string} seenAt
   */
  const rec = (id, sources, seenAt) => ({
    v: 1, id, nwo: `o/${id}`, gone: false, verdict: { output: { category: 'G', pitch: 'secret pitch' } },
    candidate: { sources, seenAt, stars: 7 },
    facts: { description: `about ${id}`, primaryLanguage: 'Go', stars: 7,
      readme: { name: 'README.md', bytes: 9, truncated: false, text: '# readme' },
      root: [{ name: 'main.go', type: 'blob' }] },
    score: { S: 9, quality: 0.97, signals: [{ id: 'q.release' }], lane: 'proven' },
  });
  const records = {
    'o/s1': rec('s1', ['sample'], '2026-09-10T00:00:00Z'),
    'o/s2': rec('s2', ['sample'], '2026-09-11T00:00:00Z'),
    'o/s3': rec('s3', ['sample'], '2026-09-09T00:00:00Z'),
    'o/p1': rec('p1', ['census:2026-09-08'], ''),
    'o/p2': rec('p2', ['census:2026-09-08'], ''),
    'o/p3': rec('p3', ['archive:2026-09-10-15:Release'], ''),
  };
  const labelled = { v: 1, at: NOW, id: 's3', nwo: 'o/s3', action: 'label', label: 'G', reason: null,
    note: '', blind: true, undoes: null, snoozeUntil: null, context: null };
  const store = memoryStore({ index: SAMPLE, records, feedback: [/** @type {any} */ (labelled)] });
  const { port } = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => store });
  const r = await request(port, { path: '/api/calibrate?n=4&seed=7' });
  assert.equal(r.status, 200);
  const ids = r.json.items.map((/** @type {any} */ i) => i.id);
  assert.deepEqual(ids.slice(0, 2), ['s2', 's1'], 'newest unlabelled sample items first');
  assert.equal(ids.length, 4);
  assert.ok(!ids.includes('s3'), 'already labelled');
  const strata = r.json.items.map((/** @type {any} */ i) => i.stratum);
  assert.deepEqual(strata, ['sample', 'sample', 'pool', 'pool']);
  const leaks = ['"S":', '"quality":', '"stars":', '"verdict":', 'secret pitch', '"signals":', '"lane":'];
  for (const leak of leaks) {
    assert.ok(!r.text.includes(leak), `leaked ${leak}`);
  }
  const again = await request(port, { path: '/api/calibrate?n=4&seed=7' });
  assert.deepEqual(again.json.items, r.json.items, 'the draw is seeded');
  const ex = (await request((await serve()).port, { path: '/api/calibrate?n=3' })).json;
  assert.equal(ex.items.length, 3);
  assert.ok(ex.items.every((/** @type {any} */ i) => i.stratum === 'pool' && i.readme));
});

test('POST /api/add: 409 while a run holds the lock, 503 without addRepo, else the new record', async () => {
  /** @type {any[]} */
  const calls = [];
  /** @param {string} nwo @param {any} deps */
  const addRepo = async (nwo, deps) => {
    calls.push({ nwo, deps });
    return { v: 1, id: 'R_new', nwo, facts: {}, score: { lane: 'promising', S: 8 } };
  };
  const getClient = async () => ({ client: true });
  const none = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => memoryStore(),
    config: CONFIG });
  assert.equal((await post(none.port, '/api/add', { nwo: 'o/r' })).status, 503);

  const locked = await serve({ dataDir: dataDir({ index: SAMPLE }),
    openStore: () => memoryStore({ lockError: true }), addRepo, getClient, config: CONFIG });
  assert.equal((await post(locked.port, '/api/add', { nwo: 'o/r' })).status, 409);

  const dir = dataDir({ index: SAMPLE });
  writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: process.pid, runId: 'r9', startedAt: NOW }));
  const live = await serve({ dataDir: dir, openStore: () => memoryStore(), addRepo, getClient,
    config: CONFIG });
  const busy = await post(live.port, '/api/add', { nwo: 'o/r' });
  assert.equal(busy.status, 409);
  assert.match(busy.json.error, /r9/);

  const store = memoryStore();
  const ok = await serve({ dataDir: dataDir({ index: SAMPLE }), openStore: () => store, addRepo, getClient,
    config: CONFIG });
  assert.equal((await post(ok.port, '/api/add', { nwo: 'not a repo' })).status, 400);
  const r = await post(ok.port, '/api/add', { nwo: 'https://github.com/Some-One/tool.js.git' });
  assert.equal(r.status, 200);
  assert.equal(r.json.record.nwo, 'Some-One/tool.js');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].deps.client, { client: true });
  assert.equal(calls[0].deps.deep, true);
  assert.equal(calls[0].deps.store, store);
  assert.equal(store.locked, false, 'the lock is released');
});

test('unsung serve starts on 127.0.0.1, prints the address, and stops on Ctrl-C', async () => {
  const controller = new AbortController();
  /** @type {string[]} */
  const printed = [];
  const notAvailable = Object.assign(new Error('not yet available'), { code: 'ENOTAVAILABLE' });
  const ctx = /** @type {any} */ ({
    config: CONFIG, dataDir: dataDir(), log: silent, now: () => NOW, signal: controller.signal,
    print: (/** @type {string} */ line) => printed.push(line), store: () => Promise.reject(notAvailable),
    client: () => Promise.reject(notAvailable),
  });
  const runArgs = /** @type {any} */ ({ flags: { port: 0, open: false }, positionals: [] });
  const running = serveCommand.run(runArgs, ctx);
  for (let i = 0; i < 200 && printed.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  const url = printed[0]?.replace('Unsung explorer: ', '') ?? '';
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  const port = Number(new URL(url).port);
  const r = await request(port, { path: '/api/index' });
  assert.equal(r.json.examples, true, 'without the store the explorer shows the examples');
  controller.abort();
  assert.equal(await running, 0);
  const badPort = /** @type {any} */ ({ flags: { port: 70000 }, positionals: [] });
  await assert.rejects(serveCommand.run(badPort, ctx), { name: 'ArgsError' });
});

test('openBrowser uses no shell and opens only the local explorer', () => {
  /** @type {any[]} */
  const spawned = [];
  /**
   * @param {string} cmd
   * @param {string[]} args
   * @param {any} o
   */
  const fakeSpawn = (cmd, args, o) => {
    spawned.push({ cmd, args, o });
    return { on() {}, unref() {} };
  };
  const spawnFn = /** @type {any} */ (fakeSpawn);
  assert.equal(openBrowser('https://evil.example/', { spawnFn }), false);
  assert.equal(openBrowser('http://127.0.0.1:8750/ & calc', { spawnFn }), false);
  assert.equal(openBrowser('http://127.0.0.1:8750/', { platform: 'win32', spawnFn }), true);
  assert.equal(openBrowser('http://127.0.0.1:8750/', { platform: 'linux', spawnFn }), true);
  assert.deepEqual(spawned.map((s) => [s.cmd, s.args, s.o.shell, s.o.windowsHide]), [
    ['explorer.exe', ['http://127.0.0.1:8750/'], false, true],
    ['xdg-open', ['http://127.0.0.1:8750/'], false, true],
  ]);
});

test('unsung feedback import merges an export, skips duplicates, reports invalid events and rebuilds taste',
  async () => {
    const stored = { v: 1, at: '2026-09-10T10:00:00.000Z', id: codefly.id, nwo: codefly.nwo, action: 'gem',
      label: 'G', reason: null, note: '', blind: false, undoes: null, snoozeUntil: null, context: null };
    const fresh = { ...stored, at: '2026-09-11T09:00:00.000Z', action: 'notmine', label: undefined };
    const invalid = { ...stored, at: '2026-09-11T09:30:00.000Z', action: 'notgood' };
    const file = path.join(TMP, 'export.json');
    writeFileSync(file, JSON.stringify({ v: 1, kind: 'unsung-feedback', exportedAt: NOW,
      events: [stored, fresh, invalid], pins: { 'topic:mcp': 1 } }));
    const store = memoryStore({ index: SAMPLE, feedback: [/** @type {any} */ (stored)] });
    /** @type {string[]} */
    const printed = [];
    const ctx = /** @type {any} */ ({
      store: async () => store, now: () => NOW, flags: {}, log: silent,
      print: (/** @type {string} */ l) => printed.push(l), printJson: () => {},
    });
    const importArgs = /** @type {any} */ ({ positionals: ['import', file], flags: {} });
    const code = await feedbackCommand.run(importArgs, ctx);
    assert.equal(code, 0);
    assert.equal(store.feedback.length, 2);
    assert.equal(store.feedback[1].action, 'notmine');
    assert.equal(store.feedback[1].label, null);
    assert.equal(store.taste.facets['topic:mcp'].pin, 1);
    assert.equal(store.taste.facets['lang:go'].gems, 1);
    assert.equal(store.taste.facets['lang:go'].notmine, 1);
    assert.match(printed.join('\n'), /Imported 1 feedback event/);
    assert.match(printed.join('\n'), /1 event was already stored/);

    const args = (/** @type {string[]} */ ...positionals) => /** @type {any} */ ({ positionals, flags: {} });
    await assert.rejects(feedbackCommand.run(args('import'), ctx), { name: 'ArgsError' });
    await assert.rejects(feedbackCommand.run(args('export', file), ctx), { name: 'ArgsError' });
    await assert.rejects(feedbackCommand.run(args('import', path.join(TMP, 'missing.json')), ctx),
      (/** @type {any} */ err) => err.name === 'ImportError' && err.exitCode === 2);
    const junk = path.join(TMP, 'junk.json');
    writeFileSync(junk, '{"not": "an export"}');
    await assert.rejects(feedbackCommand.run(args('import', junk), ctx), { name: 'ImportError' });
  });
