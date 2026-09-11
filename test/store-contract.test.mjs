// @ts-check
/**
 * The Store contract (DESIGN §12.3): one suite, run against the file store (in a fresh temporary
 * directory per test) and the memory store. File-store-only behaviour (persistence across reopen,
 * STORE_VERSION, gzipped partitions, dead-process locks) is tested at the end.
 */

import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { validateCandidate, validateUnit } from '../src/core/schema.mjs';
import { registerSecret, clearSecrets } from '../src/secrets.mjs';
import { openStore, LockError, StoreError, verdictKey } from '../src/store/store.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';
import { mulberry32 } from '../src/core/util.mjs';

/** @typedef {import('../src/core/schema.mjs').Candidate} Candidate */

/** @type {string[]} */
const roots = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** @returns {string} */
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unsung-store-'));
  roots.push(dir);
  return dir;
}

/**
 * A settable clock for the store.
 * @param {string} [start]
 */
function clock(start = '2026-09-11T12:00:00.000Z') {
  let t = Date.parse(start);
  return {
    now: () => new Date(t).toISOString(),
    /** @param {string} iso */
    set: (iso) => {
      t = Date.parse(iso);
    },
    /** @param {number} ms */
    advance: (ms) => {
      t += ms;
    },
  };
}

const IMPLS = [
  {
    name: 'file store',
    /** @param {() => string} now */
    make: async (now) => openStore(tempDir(), { now }),
  },
  {
    name: 'memory store',
    /** @param {() => string} now */
    make: async (now) => createMemoryStore({ now }),
  },
];

/**
 * @param {Partial<Candidate>} [over]
 * @returns {Candidate}
 */
function cand(over = {}) {
  return {
    v: 1, id: 'R_1', nwo: 'owner/one', day: '2026-09-08', createdAt: '2026-09-08T10:00:00Z',
    pushedAt: '2026-09-08T11:00:00Z', stars: 0, forks: 0, diskKB: 812, lang: 'Rust', licence: 'MIT',
    hasDesc: true, ownerType: 'User', sources: ['census:2026-09-08'], seenAt: '2026-09-11T12:00:00.000Z',
    prior: 3, explore: false, state: 'queued', reason: null, nextAt: null, result: null, ...over,
  };
}

/**
 * @param {string} id
 * @param {string} nwo
 * @param {Record<string, any>} [over]
 * @returns {any}
 */
function record(id, nwo, over = {}) {
  return {
    v: 1, id, nwo, candidate: null,
    facts: { v: 1, id, nwo, owner: nwo.split('/')[0], name: nwo.split('/')[1], headOid: 'abc' },
    score: null, firstSeen: null, history: [], verdict: null, checkedAt: '2026-09-11T12:00:00.000Z',
    gone: false, ...over,
  };
}

/**
 * @param {Record<string, any>} over
 * @returns {any}
 */
function feedback(over) {
  return {
    v: 1, at: '2026-09-11T12:00:00Z', id: 'R_1', nwo: 'owner/one', action: 'gem', label: 'G', reason: null,
    note: '', blind: false, undoes: null, snoozeUntil: null, context: null, ...over,
  };
}

/**
 * @param {Record<string, any>} [over]
 * @returns {any}
 */
function cacheEntry(over = {}) {
  return { url: 'u', etag: 'e', lastModified: null, status: 200, body: 1, at: 'x', ...over };
}

const EVENT = {
  type: 'ReleaseEvent', repoId: 1, nwo: 'o/r', actor: 'a', at: 'x', tag: 'v1', prerelease: false,
};
const CENSUS_KEY = 'census:2026-09-08:all:2026-09-08T13:00:00Z..2026-09-08T13:59:59Z';

for (const impl of IMPLS) {
  describe(impl.name, () => {
    test('lock: a live lock blocks a second run; unlock releases it', async () => {
      const c = clock();
      const store = await impl.make(c.now);
      const info = await store.lock('run-a');
      assert.equal(info.runId, 'run-a');
      assert.equal(info.pid, process.pid);
      await assert.rejects(store.lock('run-b'), (e) => e instanceof LockError && e.exitCode === 2
        && e.code === 'ELOCKED' && /run-a/.test(e.message));
      const held = await store.lockInfo();
      assert.equal(held?.runId, 'run-a');
      assert.equal(held?.live, true);
      await store.unlock();
      assert.equal(await store.lockInfo(), null);
      await store.lock('run-b');
      await store.unlock();
    });

    test('lock: a lock older than 6 hours is stale and taken over', async () => {
      const c = clock();
      const store = await impl.make(c.now);
      await store.lock('old-run');
      c.advance(6 * 3_600_000 + 1);
      assert.equal((await store.lockInfo())?.live, false);
      const taken = await store.lock('new-run');
      assert.equal(taken.runId, 'new-run');
      await store.unlock();
    });

    test('lock: units left running by a dead run go back to planned', async () => {
      const c = clock();
      const store = await impl.make(c.now);
      store.ledger.start(CENSUS_KEY, 'census', 'dead-run');
      store.ledger.start('archive:2026-09-10-3', 'archive', 'dead-run');
      store.ledger.done('archive:2026-09-10-3', { seeds: 1 });
      await store.lock('live-run');
      assert.equal(store.ledger.get(CENSUS_KEY)?.state, 'planned');
      assert.equal(store.ledger.get(CENSUS_KEY)?.attempts, 1);
      assert.equal(store.ledger.get('archive:2026-09-10-3')?.state, 'done');
      await store.unlock();
    });

    test('ledger: planned → running → done, with attempts and outputs', async () => {
      const store = await impl.make(clock().now);
      assert.equal(store.ledger.get(CENSUS_KEY), null);
      assert.equal(store.ledger.isDone(CENSUS_KEY), false);
      assert.equal(store.ledger.canStart(CENSUS_KEY), true);
      const started = store.ledger.start(CENSUS_KEY, 'census', 'r1');
      assert.deepEqual(validateUnit(started), []);
      assert.equal(started.state, 'running');
      assert.equal(started.attempts, 1);
      assert.equal(started.runId, 'r1');
      assert.equal(store.ledger.canStart(CENSUS_KEY), false);
      const out = { count: 612, pages: 7, saturated: false, seeds: 611 };
      const done = store.ledger.done(CENSUS_KEY, out);
      assert.deepEqual(validateUnit(done), []);
      assert.equal(done.state, 'done');
      assert.equal(done.attempts, 1);
      assert.deepEqual(done.out, out);
      assert.equal(store.ledger.isDone(CENSUS_KEY), true);
      assert.equal(store.ledger.canStart(CENSUS_KEY), false);
      // The stage defaults to the key's prefix.
      assert.equal(store.ledger.start('archive:2026-09-10-3').stage, 'archive');
    });

    test('ledger: failures back off 10 min × 2^attempts and stop after 5 attempts', async () => {
      const c = clock('2026-09-11T00:00:00.000Z');
      const store = await impl.make(c.now);
      const key = 'archive:2026-09-10-3';
      store.ledger.start(key, 'archive', 'r1');
      const failed = store.ledger.fail(key, new Error('boom'));
      assert.deepEqual(validateUnit(failed), []);
      assert.equal(failed.state, 'failed');
      assert.match(String(failed.err), /boom/);
      assert.equal(failed.nextAt, '2026-09-11T00:20:00.000Z');
      assert.equal(store.ledger.canStart(key), false);
      c.set('2026-09-11T00:20:00.000Z');
      assert.equal(store.ledger.canStart(key), true);
      for (let i = 2; i <= 5; i++) {
        store.ledger.start(key, 'archive', 'r1');
        const f = store.ledger.fail(key, 'again');
        assert.equal(f.attempts, i);
        if (i < 5) assert.equal(Date.parse(String(f.nextAt)) - Date.parse(c.now()), 10 * 60_000 * 2 ** i);
        else assert.equal(f.nextAt, null);
        c.set('2026-09-30T00:00:00.000Z');
      }
      assert.equal(store.ledger.canStart(key), false);
      assert.deepEqual(store.ledger.list({ state: 'failed' }).map((u) => u.key), [key]);
      assert.deepEqual(store.ledger.list({ stage: 'census' }), []);
    });

    test('ledger: error texts are redacted', async () => {
      const store = await impl.make(clock().now);
      const token = `ghp_${'a'.repeat(36)}`;
      store.ledger.start('archive:2026-09-10-4');
      const f = store.ledger.fail('archive:2026-09-10-4', new Error(`bad token ${token}`));
      assert.ok(!String(f.err).includes(token));
      assert.match(String(f.err), /\[REDACTED\]/);
    });

    test('candidates: upsert keyed by id never writes a duplicate candidate line', async () => {
      const store = await impl.make(clock().now);
      assert.deepEqual(await store.putCandidates([cand(), cand({ id: 'R_2', nwo: 'owner/two', prior: 1 })]),
        { added: 2, updated: 0 });
      assert.deepEqual(await store.putCandidates([cand()]), { added: 0, updated: 0 });
      assert.deepEqual(await store.putCandidates(cand({ stars: 4, day: '2026-09-11' })),
        { added: 0, updated: 1 });
      const got = await store.getCandidate('R_1');
      assert.equal(got?.stars, 4);
      assert.equal(got?.day, '2026-09-08', 'a known candidate stays in its first partition');
      const lines = await store.rawCandidateLines();
      const full = lines.filter((l) => l.patch !== true).map((l) => l.id);
      assert.deepEqual(full.sort(), ['R_1', 'R_2']);
      for (const line of lines) assert.deepEqual(validateCandidate(line), []);
      const patch = lines.find((l) => l.patch === true);
      assert.deepEqual(patch.set, { stars: 4 });
      assert.equal(patch.day, '2026-09-08');
      assert.equal(await store.getCandidate('nope'), null);
    });

    test('candidates: patches win field by field and are validated shapes', async () => {
      const store = await impl.make(clock().now);
      await store.putCandidates([cand()]);
      const result = {
        headOid: '9f3c', S: 8, band: 'gem', lane: 'promising', gem: 8.45, at: '2026-09-11T12:00:00Z',
      };
      const updated = await store.patchCandidate('R_1', { state: 'enriched', result });
      assert.equal(updated.state, 'enriched');
      assert.deepEqual(updated.result, result);
      const sneaky = /** @type {any} */ ({ reason: 'x', id: 'R_other', day: '2000-01-01' });
      await store.patchCandidate(updated, sneaky);
      const got = await store.getCandidate('R_1');
      assert.equal(got?.id, 'R_1');
      assert.equal(got?.day, '2026-09-08');
      assert.equal(got?.reason, 'x');
      assert.equal(got?.prior, 3);
      assert.deepEqual(validateCandidate(got), []);
      await assert.rejects(store.patchCandidate('R_missing', { state: 'gone' }),
        (e) => e instanceof StoreError && e.code === 'ENOENT');
      await assert.rejects(store.putCandidates([{ ...cand(), id: '' }]), StoreError);
    });

    test('candidates: queue is best-first by prior then newest', async () => {
      const store = await impl.make(clock().now);
      await store.putCandidates([
        cand({ id: 'A', prior: 2, createdAt: '2026-09-08T01:00:00Z' }),
        cand({ id: 'B', prior: 4, createdAt: '2026-09-08T01:00:00Z' }),
        cand({ id: 'C', prior: 2, createdAt: '2026-09-08T05:00:00Z' }),
        cand({ id: 'D', prior: 5, state: 'dropped' }),
        cand({ id: 'E', prior: 0, createdAt: '2026-09-08T02:00:00Z' }),
      ]);
      /** @param {Candidate[]} list */
      const ids = (list) => list.map((x) => x.id);
      assert.deepEqual(ids(await store.queue({ limit: 10 })), ['B', 'C', 'A', 'E']);
      assert.deepEqual(ids(await store.queue({ limit: 2 })), ['B', 'C']);
      assert.deepEqual(ids(await store.queue({ limit: 10, exclude: ['B', 'A'] })), ['C', 'E']);
      await store.patchCandidate('B', { state: 'enriched' });
      await store.patchCandidate('E', { prior: 9 });
      assert.deepEqual(ids(await store.queue({ limit: 10 })), ['E', 'C', 'A']);
      assert.deepEqual(await store.queue({ limit: 0 }), []);
    });

    test('candidates: exploration fills one slot in every 20 with a random prior ≤ 1 candidate', async () => {
      const store = await impl.make(clock().now);
      const many = [];
      for (let i = 0; i < 60; i++) {
        const mm = String(i).padStart(2, '0');
        many.push(cand({ id: `H${mm}`, prior: 3, createdAt: `2026-09-08T00:${mm}:00Z` }));
      }
      for (let i = 0; i < 30; i++) many.push(cand({ id: `L${String(i).padStart(2, '0')}`, prior: i % 2 }));
      await store.putCandidates(many);
      const batch = await store.queue({ limit: 40, explore: 0.05, rand: mulberry32(7) });
      assert.equal(batch.length, 40);
      const explored = batch.filter((x) => x.explore);
      assert.equal(explored.length, 2);
      for (const x of explored) assert.ok(x.prior <= 1 && x.id.startsWith('L'));
      assert.deepEqual(batch.map((x, i) => (x.explore ? i : -1)).filter((i) => i >= 0), [19, 39]);
      const again = await store.queue({ limit: 40, explore: 0.05, rand: mulberry32(7) });
      assert.deepEqual(again.map((x) => x.id), batch.map((x) => x.id), 'seeded draws repeat');
      assert.equal((await store.getCandidate(explored[0].id))?.explore, false, 'queue() writes nothing');
      const small = await store.queue({ limit: 12, explore: 0.05, rand: mulberry32(1) });
      assert.equal(small.filter((x) => x.explore).length, 1);
      assert.equal((await store.queue({ limit: 12, explore: 0.05 })).filter((x) => x.explore).length, 0,
        'no generator, no exploration');
    });

    test('candidates: due deferred, listing and counts', async () => {
      const store = await impl.make(clock().now);
      const deferred = { state: /** @type {const} */ ('deferred'), reason: 'no-language-yet' };
      await store.putCandidates([
        cand({ id: 'D1', ...deferred, nextAt: '2026-09-10T00:00:00Z' }),
        cand({ id: 'D2', ...deferred, nextAt: '2026-09-15T00:00:00Z' }),
        cand({ id: 'Q1', day: '2026-09-09' }),
      ]);
      /** @param {Candidate[]} list */
      const ids = (list) => list.map((x) => x.id).sort();
      assert.deepEqual(ids(await store.dueDeferred('2026-09-11T12:00:00Z')), ['D1']);
      assert.deepEqual(ids(await store.dueDeferred()), ['D1']);
      assert.deepEqual(ids(await store.listCandidates({ state: 'deferred' })), ['D1', 'D2']);
      assert.deepEqual(ids(await store.listCandidates({ day: '2026-09-09' })), ['Q1']);
      assert.deepEqual(ids(await store.listCandidates({ ids: ['Q1', 'D2'] })), ['D2', 'Q1']);
      assert.deepEqual(await store.candidateCounts(), { deferred: 2, queued: 1 });
    });

    test('repos: atomic records by path, lookup by id, renames move the file', async () => {
      const store = await impl.make(clock().now);
      assert.equal(await store.getRepo('owner/one'), null);
      await store.putRepo(record('R_1', 'Owner/One'));
      assert.equal((await store.getRepo('owner/one'))?.id, 'R_1', 'paths are case-insensitive');
      assert.equal((await store.getRepoById('R_1'))?.nwo, 'Owner/One');
      await store.putRepo(record('R_1', 'owner/renamed'));
      assert.equal(await store.getRepo('owner/one'), null);
      assert.equal((await store.getRepoById('R_1'))?.nwo, 'owner/renamed');
      await store.putRepo(record('R_2', 'other/two'));
      const all = [];
      for await (const r of store.listRepos()) all.push(r.nwo);
      assert.deepEqual(all, ['other/two', 'owner/renamed']);
      assert.equal(await store.deleteRepo('other/two'), true);
      assert.equal(await store.deleteRepo('other/two'), false);
      assert.equal(await store.getRepoById('R_2'), null);
      await assert.rejects(store.putRepo(record('R_3', 'no-slash')), StoreError);
      await assert.rejects(store.putRepo(/** @type {any} */ ({ nwo: 'a/b' })), StoreError);
    });

    test('repos: values going in and coming out are copies', async () => {
      const store = await impl.make(clock().now);
      const rec = record('R_1', 'owner/one');
      await store.putRepo(rec);
      rec.history.push({ mutated: true });
      const got = await store.getRepo('owner/one');
      assert.deepEqual(got?.history, []);
      got?.history.push(/** @type {any} */ ({ mutated: true }));
      assert.deepEqual((await store.getRepo('owner/one'))?.history, []);
      await store.putCandidates([cand()]);
      const c1 = await store.getCandidate('R_1');
      /** @type {any} */ (c1).sources.push('x');
      assert.deepEqual((await store.getCandidate('R_1'))?.sources, ['census:2026-09-08']);
    });

    test('feedback is append-only; taste is a document', async () => {
      const store = await impl.make(clock().now);
      assert.deepEqual(await store.readFeedback(), []);
      const ev = feedback({});
      await store.appendFeedback(ev);
      await store.appendFeedback(feedback({ action: 'undo', label: null, undoes: ev.at }));
      assert.deepEqual((await store.readFeedback()).map((e) => e.action), ['gem', 'undo']);
      await assert.rejects(store.appendFeedback(/** @type {any} */ ({ id: 'x' })), StoreError);
      assert.equal(await store.readTaste(), null);
      const taste = {
        v: 1, updatedAt: '2026-09-11T12:00:00Z', facets: { 'lang:rust': { gems: 1, notmine: 0, pin: 0 } },
      };
      await store.writeTaste(/** @type {any} */ (taste));
      assert.deepEqual(await store.readTaste(), taste);
    });

    test('verdicts: cached by (id, headOid, rubric, backend, model); latest wins', async () => {
      const store = await impl.make(clock().now);
      const base = {
        v: 1, id: 'R_1', nwo: 'owner/one', headOid: 'h1', rubric: 'r1', backend: 'claude-cli',
        model: 'claude-opus-5',
        at: 'a', status: 'ok',
      };
      await store.appendVerdict(/** @type {any} */ ({ ...base, at: '1' }));
      await store.appendVerdict(/** @type {any} */ ({ ...base, at: '2' }));
      await store.appendVerdict(/** @type {any} */ ({ ...base, headOid: 'h2', at: '3' }));
      assert.equal((await store.getVerdict(verdictKey(base)))?.at, '2');
      assert.equal((await store.getVerdict({ id: 'R_1' }))?.at, '3');
      assert.equal((await store.getVerdict({ id: 'R_1', headOid: 'h1', backend: 'claude-cli' }))?.at, '2');
      assert.equal(await store.getVerdict({ id: 'R_1', backend: 'anthropic-api' }), null);
      assert.equal(await store.getVerdict('R_9|h1|r1|claude-cli|claude-opus-5'), null);
      assert.equal(verdictKey({ id: 'R_2', headOid: null, rubric: 'r1', backend: 'claude-cli', model: null }),
        'R_2|HEAD|r1|claude-cli|');
      const noHead = { ...base, id: 'R_2', headOid: null, model: null, at: '4' };
      await store.appendVerdict(/** @type {any} */ (noHead));
      const headless = await store.getVerdict('R_2|HEAD|r1|claude-cli|');
      assert.equal(headless?.at, '4', 'a missing head is written HEAD, as src/core/verdict.mjs does');
    });

    test('owner memory: case-insensitive, flags accumulate and farm stays permanent', async () => {
      const store = await impl.make(clock().now);
      assert.equal(await store.getOwner('Farmer'), null);
      await store.putOwner({
        login: 'Farmer', type: 'User', flags: ['farm'], evidence: '6,690 repositories', publicRepos: 6690,
      });
      const later = await store.putOwner({ login: 'farmer', flags: ['prolific'], publicRepos: 7000 });
      assert.deepEqual(later.flags, ['farm', 'prolific']);
      const got = await store.getOwner('FARMER');
      assert.deepEqual(got?.flags, ['farm', 'prolific']);
      assert.equal(got?.evidence, '6,690 repositories');
      assert.equal(got?.publicRepos, 7000);
      assert.equal(got?.checkedAt, '2026-09-11T12:00:00.000Z');
      await assert.rejects(store.putOwner(/** @type {any} */ ({ flags: [] })), StoreError);
    });

    test('HTTP cache: synchronous get and put; the stored URL is redacted', async () => {
      const store = await impl.make(clock().now);
      const token = `ghp_${'b'.repeat(36)}`;
      registerSecret('super-secret-value-123');
      try {
        const key = 'GET https://api.github.com/x';
        assert.equal(store.httpCache.get(key), null);
        const url = `https://api.github.com/x?t=${token}&s=super-secret-value-123`;
        const ret = store.httpCache.put(key, cacheEntry({ url, etag: 'W/"e"', body: { ok: true } }));
        assert.equal(ret, undefined);
        const hit = store.httpCache.get(key);
        assert.equal(hit?.etag, 'W/"e"');
        assert.deepEqual(hit?.body, { ok: true });
        assert.ok(!String(hit?.url).includes(token));
        assert.ok(!String(hit?.url).includes('super-secret-value-123'));
        const sha = 'a'.repeat(40);
        store.httpCache.put(sha, cacheEntry({ etag: null }));
        assert.equal(store.httpCache.get(sha)?.body, 1);
      } finally {
        clearSecrets();
      }
    });

    test('trees and pack files are cached by SHA', async () => {
      const store = await impl.make(clock().now);
      const sha = '20ae2ffee317f5550c6aad57293b5806ed4afe38';
      assert.equal(await store.getTree(sha), null);
      await store.putTree(sha, { sha, truncated: false, tree: [{ path: 'src', type: 'tree' }] });
      assert.equal((await store.getTree(sha.toUpperCase()))?.tree.length, 1);
      assert.equal(await store.getFiles('R_kgDOAbc', sha), null);
      await store.putFiles('R_kgDOAbc', sha, { 'src/main.rs': { byteSize: 5, text: 'fn m' } });
      assert.equal((await store.getFiles('R_kgDOAbc', sha))?.['src/main.rs'].text, 'fn m');
      assert.equal(await store.getFiles('R_kgDOABC', sha), null, 'node ids are case-sensitive');
    });

    test('archive extracts: the first write of an hour replaces, later writes append', async () => {
      const store = await impl.make(clock().now);
      assert.equal(await store.writeArchiveExtract('2026-09-10', 3, [EVENT]), 1);
      await store.writeArchiveExtract('2026-09-10', 3, [{ ...EVENT, repoId: 2 }]);
      assert.deepEqual((await store.readArchiveExtract('2026-09-10', 3))?.map((e) => e.repoId), [1, 2]);
      if (store.kind === 'file') {
        const fresh = await openStore(/** @type {string} */ (store.dir), {});
        await fresh.writeArchiveExtract('2026-09-10', '3', [{ ...EVENT, repoId: 9 }]);
        assert.deepEqual((await fresh.readArchiveExtract('2026-09-10', 3))?.map((e) => e.repoId), [9]);
      }
      assert.equal(await store.readArchiveExtract('2026-09-10', 4), null);
      await assert.rejects(store.writeArchiveExtract('2026-09-10', 24, []), StoreError);
    });

    test('runs: manifests are rewritten, summaries appended, newest first, and redacted', async () => {
      const store = await impl.make(clock().now);
      const token = `ghp_${'c'.repeat(36)}`;
      /** @param {string} runId @param {Record<string, any>} [over] @returns {any} */
      const manifest = (runId, over = {}) => ({
        v: 1, runId, startedAt: '2026-09-11T12:00:00Z', endedAt: null, argv: ['run', token], profile: 'quick',
        budget: { wallMs: 600000, graphqlMs: 450000 }, stages: {}, rate: {}, exit: null,
        units: [{ key: 'k' }],
        ...over,
      });
      const first = '20260911T120000Z-aaaa';
      const second = '20260911T130000Z-bbbb';
      await store.startRun(manifest(first));
      await store.checkpointRun(manifest(first, { stages: { census: { pages: 1 } } }));
      assert.deepEqual((await store.getRun(first))?.stages, { census: { pages: 1 } });
      await store.endRun(manifest(first, {
        endedAt: '2026-09-11T12:10:00Z', exit: { code: 0, reason: 'finished', resumeAt: null },
      }));
      await store.endRun(manifest(second, { exit: { code: 75, reason: 'paused', resumeAt: null } }));
      const runs = await store.lastRuns(5);
      assert.deepEqual(runs.map((r) => r.runId), [second, first]);
      assert.equal('units' in runs[0], false, 'a RunSummary has no units');
      assert.deepEqual((await store.lastRuns(1)).map((r) => r.runId), [second]);
      const full = await store.getRun(first);
      assert.deepEqual(full?.units, [{ key: 'k' }]);
      assert.ok(!JSON.stringify(full).includes(token));
      assert.ok(!JSON.stringify(runs).includes(token));
      await assert.rejects(store.startRun(manifest('../evil')), StoreError);
    });

    test('index and opt-out documents', async () => {
      const store = await impl.make(clock().now);
      assert.equal(await store.readIndex(), null);
      const idx = {
        v: 1, generatedAt: 'x', model: { weights: null, calibration: null }, counts: {}, lastRun: null,
        entries: [],
      };
      await store.writeIndex(/** @type {any} */ (idx));
      assert.deepEqual(await store.readIndex(), idx);
      assert.deepEqual(await store.readOptOut(), { v: 1, repos: [], owners: [] });
    });

    test('compact: retention of candidates, gone repositories, archive and HTTP cache', async () => {
      const c = clock('2026-06-01T00:00:00.000Z');
      const store = await impl.make(c.now);
      await store.writeArchiveExtract('2026-06-01', 0, [EVENT]);
      store.httpCache.put('old', cacheEntry());
      await store.putCandidates([
        cand({ id: 'OLD-DROP', day: '2026-06-01', state: 'dropped', reason: 'too-small' }),
        cand({ id: 'OLD-EXP', day: '2026-06-01', state: 'expired' }),
        cand({ id: 'OLD-Q', day: '2026-06-01', state: 'queued' }),
      ]);
      await store.patchCandidate('OLD-Q', { prior: 4 });
      const vanished = { gone: true, checkedAt: '2026-06-01T00:00:00Z' };
      await store.putRepo(record('R_GONE', 'gone/old', vanished));
      await store.putRepo(record('R_GONE_FB', 'gone/liked', vanished));
      await store.putRepo(record('R_LIVE', 'live/one'));
      await store.appendFeedback(feedback({ at: 'x', id: 'R_GONE_FB', nwo: 'gone/liked' }));

      c.set('2026-09-11T00:00:00.000Z');
      store.httpCache.put('fresh', cacheEntry({ body: 2 }));
      await store.writeArchiveExtract('2026-09-10', 23, [EVENT]);
      await store.putCandidates([
        cand({ id: 'NEW-DROP', day: '2026-09-10', state: 'dropped' }),
        cand({ id: 'RECENT', day: '2026-09-05', state: 'queued' }),
      ]);
      const report = await store.compact();
      assert.equal(report.candidates.removed, 2);
      assert.equal(report.repos.removed, 1);
      assert.equal(report.archive.removed, 1);
      assert.equal(report.http.removed, 1);
      assert.equal(await store.getCandidate('OLD-DROP'), null);
      assert.equal(await store.getCandidate('OLD-EXP'), null);
      const oldQ = await store.getCandidate('OLD-Q');
      assert.equal(oldQ?.prior, 4, 'queued candidates are kept, patches folded');
      assert.equal((await store.getCandidate('NEW-DROP'))?.state, 'dropped');
      assert.ok(await store.getCandidate('RECENT'));
      assert.equal(await store.getRepo('gone/old'), null);
      assert.ok(await store.getRepo('gone/liked'), 'gone repositories with feedback stay');
      assert.ok(await store.getRepo('live/one'));
      assert.equal(await store.readArchiveExtract('2026-06-01', 0), null);
      assert.ok(await store.readArchiveExtract('2026-09-10', 23));
      assert.equal(store.httpCache.get('old'), null);
      assert.equal(store.httpCache.get('fresh')?.body, 2);
      const lines = await store.rawCandidateLines();
      assert.equal(lines.filter((l) => l.id === 'OLD-Q').length, 1, 'the old partition is folded');
      assert.deepEqual(await store.compact(), {
        ...report,
        candidates: { removed: 0, partitions: 0, gzipped: 0 },
        repos: { removed: 0 },
        archive: { removed: 0 },
        http: { removed: 0 },
      });
    });

    test('compact: ledger months older than 90 days collapse to final states', async () => {
      const c = clock('2026-01-05T00:00:00.000Z');
      const store = await impl.make(c.now);
      const key = 'archive:2026-01-04-1';
      store.ledger.start(key, 'archive', 'r');
      store.ledger.fail(key, 'x');
      store.ledger.start(key, 'archive', 'r');
      store.ledger.done(key, {});
      c.set('2026-09-11T00:00:00.000Z');
      const report = await store.compact();
      if (store.kind === 'file') assert.equal(report.units.collapsed, 3);
      assert.equal(store.ledger.get(key)?.state, 'done');
      const again = store.kind === 'file' ? await openStore(/** @type {string} */ (store.dir), {}) : store;
      assert.equal(again.ledger.get(key)?.state, 'done');
      assert.equal(again.ledger.get(key)?.attempts, 2);
    });
  });
}

describe('file store only', () => {
  test('everything survives reopening the directory', async () => {
    const dir = tempDir();
    const c = clock();
    const a = await openStore(dir, { now: c.now });
    await a.putCandidates([cand(), cand({ id: 'R_2', prior: 1, day: '2026-09-09' })]);
    await a.patchCandidate('R_1', { state: 'enriched' });
    a.ledger.start(CENSUS_KEY, 'census', 'r1');
    a.ledger.done(CENSUS_KEY, { seeds: 3 });
    await a.putRepo(record('R_1', 'owner/one'));
    await a.putOwner({ login: 'farmer', flags: ['farm'] });
    await a.appendVerdict(/** @type {any} */ ({
      v: 1, id: 'R_1', nwo: 'owner/one', headOid: 'h', rubric: 'r1', backend: 'claude-cli', model: 'm',
    }));

    const b = await openStore(dir, { now: c.now });
    assert.equal((await b.getCandidate('R_1'))?.state, 'enriched');
    assert.deepEqual((await b.queue({ limit: 5 })).map((x) => x.id), ['R_2']);
    assert.equal(b.ledger.isDone(CENSUS_KEY), true);
    assert.equal((await b.getRepoById('R_1'))?.nwo, 'owner/one');
    assert.deepEqual((await b.getOwner('FARMER'))?.flags, ['farm']);
    assert.equal((await b.getVerdict({ id: 'R_1' }))?.model, 'm');
    assert.equal(fs.readFileSync(path.join(dir, 'STORE_VERSION'), 'utf8').trim(), '1');
    assert.ok(fs.existsSync(path.join(dir, 'candidates', '2026-09-08.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'repos', 'owner', 'one.json')));
    assert.ok(fs.readdirSync(path.join(dir, 'units')).every((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)));
  });

  test('a torn last line in a partition is skipped and reported once', async () => {
    const dir = tempDir();
    const a = await openStore(dir, { now: clock().now });
    await a.putCandidates([cand()]);
    fs.appendFileSync(path.join(dir, 'candidates', '2026-09-08.jsonl'), '{"v":1,"patch":tr');
    /** @type {string[]} */
    const warnings = [];
    const warn = (/** @type {string} */ m) => warnings.push(m);
    const log = /** @type {any} */ ({ warn, debug() {}, info() {} });
    const b = await openStore(dir, { now: clock().now, log });
    assert.equal((await b.getCandidate('R_1'))?.state, 'queued');
    await b.patchCandidate('R_1', { state: 'enriched' });
    assert.deepEqual(warnings, ['Skipped 1 unreadable line in data/candidates']);
    const c = await openStore(dir, { now: clock().now });
    assert.equal((await c.getCandidate('R_1'))?.state, 'enriched', 'the next line was not glued on');
  });

  test('compaction gzips old partitions, which read back the same', async () => {
    const dir = tempDir();
    const c = clock('2026-09-01T00:00:00.000Z');
    const a = await openStore(dir, { now: c.now });
    await a.putCandidates([cand({ day: '2026-09-01' }), cand({ id: 'R_2', day: '2026-09-10' })]);
    await a.patchCandidate('R_1', { stars: 7 });
    c.set('2026-09-11T00:00:00.000Z');
    const report = await a.compact();
    assert.deepEqual(report.candidates, { removed: 0, partitions: 1, gzipped: 1 });
    const files = fs.readdirSync(path.join(dir, 'candidates')).sort();
    assert.deepEqual(files, ['2026-09-01.jsonl.gz', '2026-09-10.jsonl']);
    const gz = fs.readFileSync(path.join(dir, 'candidates', '2026-09-01.jsonl.gz'));
    assert.equal(zlib.gunzipSync(gz).toString().trim().split('\n').length, 1);
    await a.patchCandidate('R_1', { stars: 8 });
    const b = await openStore(dir, { now: c.now });
    const r1 = await b.getCandidate('R_1');
    assert.equal(r1?.stars, 8, 'new lines beside a gzipped partition apply on top');
  });

  test('STORE_VERSION: a newer store is refused; an older one needs --migrate', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'STORE_VERSION');
    fs.writeFileSync(file, '2\n');
    await assert.rejects(openStore(dir),
      (e) => e instanceof StoreError && e.exitCode === 2 && /newer/.test(e.message));
    fs.writeFileSync(file, '0\n');
    await assert.rejects(openStore(dir),
      (e) => e instanceof StoreError && e.exitCode === 2 && /--migrate/.test(e.message));
    await openStore(dir, { migrate: true });
    assert.equal(fs.readFileSync(file, 'utf8').trim(), '1');
    await openStore(dir);
  });

  test('a lock whose process has died is stale and taken over', async () => {
    const dir = tempDir();
    const dead = { pid: 2 ** 22 + 12345, runId: 'dead', startedAt: '2026-09-11T11:59:00.000Z' };
    fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify(dead));
    const store = await openStore(dir, { now: clock().now });
    assert.equal((await store.lockInfo())?.live, false);
    const got = await store.lock('mine');
    assert.equal(got.runId, 'mine');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, '.lock'), 'utf8'));
    assert.deepEqual(onDisk, { pid: process.pid, runId: 'mine', startedAt: '2026-09-11T12:00:00.000Z' });
    const other = await openStore(dir, { now: clock().now });
    await assert.rejects(other.lock('second'), LockError);
    await other.unlock();
    assert.ok(fs.existsSync(path.join(dir, '.lock')), 'unlock never removes someone else\'s lock');
    await store.unlock();
    assert.equal(fs.existsSync(path.join(dir, '.lock')), false);
  });

  test('record files carry their identity first and ids are found without a full parse', async () => {
    const dir = tempDir();
    const a = await openStore(dir, { now: clock().now });
    await a.putRepo(/** @type {any} */ ({ facts: { id: 'x' }, nwo: 'o/r', id: 'R_z', v: 1 }));
    const text = fs.readFileSync(path.join(dir, 'repos', 'o', 'r.json'), 'utf8');
    assert.match(text, /^\{"v":1,"id":"R_z","nwo":"o\/r"/);
    const b = await openStore(dir, { now: clock().now });
    assert.equal((await b.getRepoById('R_z'))?.nwo, 'o/r');
  });
});
