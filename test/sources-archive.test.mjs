// @ts-check
/**
 * The GH Archive lane (DESIGN §3.3) on the recorded hour sample: the file is streamed and split on
 * "\n" by hand, so the two lines holding a raw U+2028 parse; only Release and Public events are
 * extracted; the lookups reproduce the recorded lean answers; the token never goes to
 * data.gharchive.org.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createFakeFetch } from './support/fake-fetch.mjs';
import { fakeClock } from './support/clock.mjs';
import { fixturePath, loadGraphqlFixture } from './support/fixtures.mjs';
import { createGovernor } from '../src/github/governor.mjs';
import { createClient } from '../src/github/client.mjs';
import {
  ArchiveError, archiveHour, completeHours, extractEvent, hourUrl, streamEvents,
} from '../src/sources/archive.mjs';
import { passesBase, seedFromNode } from '../src/sources/seed.mjs';
import { clearSecrets } from '../src/secrets.mjs';

const SAMPLE = fs.readFileSync(fixturePath('gharchive', '2026-09-10-15.sample.json.gz'));
const URL_15 = 'https://data.gharchive.org/2026-09-10-15.json.gz';
const LS = String.fromCharCode(0x2028);
const TOKEN = 'archive-test-token-2468';

/**
 * A fetch for data.gharchive.org that streams `bytes` in awkward 997-byte chunks.
 * @param {Uint8Array} bytes
 * @param {{status?: number}} [opts]
 */
function archiveFetch(bytes, { status = 200 } = {}) {
  /** @type {{url: string, init: any}[]} */
  const calls = [];
  /** @type {any} */
  const fn = async (/** @type {string} */ url, /** @type {any} */ init) => {
    calls.push({ url, init });
    if (status !== 200) return new Response('Not Found', { status });
    const body = new ReadableStream({
      start(ctl) {
        for (let i = 0; i < bytes.length; i += 997) ctl.enqueue(bytes.subarray(i, i + 997));
        ctl.close();
      },
    });
    return new Response(body, { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

/**
 * @param {AsyncIterable<any>} gen
 */
async function all(gen) {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
}

afterEach(() => clearSecrets());

describe('hours', () => {
  it('builds unpadded hour URLs', () => {
    assert.equal(hourUrl('2026-09-10', 3), 'https://data.gharchive.org/2026-09-10-3.json.gz');
    assert.equal(hourUrl('2026-09-10', '15'), URL_15);
    assert.throws(() => hourUrl('2026-09-10', 24), RangeError);
    assert.throws(() => hourUrl('10/09/2026', 1), RangeError);
  });

  it('an hour is complete 15 minutes after it ends', () => {
    assert.deepEqual(completeHours('2026-09-11T15:20:00Z', 3),
      [{ date: '2026-09-11', hour: 14 }, { date: '2026-09-11', hour: 13 }, { date: '2026-09-11', hour: 12 }]);
    assert.deepEqual(completeHours('2026-09-11T15:14:59Z', 1), [{ date: '2026-09-11', hour: 13 }]);
    assert.deepEqual(completeHours('2026-09-11T15:15:00Z', 1), [{ date: '2026-09-11', hour: 14 }]);
    assert.deepEqual(completeHours(Date.parse('2026-09-11T01:10:00Z'), 2),
      [{ date: '2026-09-10', hour: 23 }, { date: '2026-09-10', hour: 22 }]);
  });
});

describe('streamEvents', () => {
  it('parses the recorded sample, U+2028 lines included, reading Release and Public events', async () => {
    const stats = {};
    const events = await all(streamEvents(URL_15, { fetch: archiveFetch(SAMPLE), stats }));
    assert.equal(events.length, 270);
    assert.deepEqual(stats, { lines: 502, matched: 270, bad: 0, bytes: stats.bytes });
    assert.ok(events.every((e) => e.type === 'ReleaseEvent' || e.type === 'PublicEvent'));

    const everything = {};
    const every = await all(streamEvents(URL_15,
      { fetch: archiveFetch(SAMPLE), types: null, stats: everything }));
    assert.equal(every.length, 502);
    assert.equal(/** @type {any} */ (everything).bad, 0);
    assert.equal(every.filter((e) => JSON.stringify(e).includes(LS)).length, 2,
      'both U+2028 lines parsed whole');
  });

  it('shows why: a readline-style split breaks the U+2028 lines', async () => {
    const { gunzipSync } = await import('node:zlib');
    const text = gunzipSync(SAMPLE).toString('utf8');
    const pieces = text.split(new RegExp(`\\n|${LS}`)).filter(Boolean);
    const broken = pieces.filter((p) => {
      try {
        JSON.parse(p);
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(broken.length, 4, 'two lines become four halves that do not parse');
  });

  it('counts and skips a line that fails to parse', async () => {
    const lines = [
      '{"type":"ReleaseEvent","repo":{"id":1,"name":"a/b"},"actor":{"login":"x"},'
        + '"created_at":"2026-09-10T15:00:00Z"}',
      '{"type":"ReleaseEvent", broken',
      '{"type":"PushEvent","repo":{"id":2,"name":"c/d"}}',
      '{"type":"PublicEvent","repo":{"id":3,"name":"e/f"},"actor":{"login":"y"},'
        + '"created_at":"2026-09-10T15:01:00Z"}',
    ];
    const stats = {};
    const got = await all(streamEvents(URL_15, { fetch: archiveFetch(gzipSync(lines.join('\n'))), stats }));
    assert.deepEqual(got.map((e) => e.repo.name), ['a/b', 'e/f']);
    assert.equal(/** @type {any} */ (stats).bad, 1);
  });

  it('refuses other hosts, reports HTTP errors, and can stop early', async () => {
    const elsewhere = streamEvents('https://example.com/x.json.gz', { fetch: archiveFetch(SAMPLE) });
    await assert.rejects(all(elsewhere), TypeError);
    await assert.rejects(all(streamEvents(URL_15, { fetch: archiveFetch(SAMPLE, { status: 404 }) })),
      (err) => err instanceof ArchiveError && err.status === 404);
    let n = 0;
    for await (const _ of streamEvents(URL_15, { fetch: archiveFetch(SAMPLE) })) if (++n === 5) break;
    assert.equal(n, 5);
  });
});

describe('extractEvent', () => {
  it('keeps the §3.3 fields of Release and Public events only', () => {
    const base = { repo: { id: 7, name: 'o/r' }, actor: { login: 'me' }, created_at: '2026-09-10T15:00:00Z' };
    const common = { repoId: 7, nwo: 'o/r', actor: 'me', at: '2026-09-10T15:00:00Z' };
    const release = { tag_name: 'v1', prerelease: false };
    assert.deepEqual(extractEvent({ ...base, type: 'ReleaseEvent', payload: { release } }),
      { type: 'ReleaseEvent', ...common, tag: 'v1', prerelease: false });
    assert.deepEqual(extractEvent({ ...base, type: 'PublicEvent', payload: {} }),
      { type: 'PublicEvent', ...common, tag: null, prerelease: null });
    assert.equal(extractEvent({ ...base, type: 'PushEvent' }), null);
    assert.equal(extractEvent({ ...base, type: 'ReleaseEvent', repo: { id: 'x', name: 'o/r' } }), null);
    assert.equal(extractEvent(null), null);
  });
});

describe('archiveHour', () => {
  const lookup = loadGraphqlFixture('archive-lookup');
  /** @type {Map<string, any>} */
  const recorded = new Map();
  for (let i = 0; `o${i}` in lookup.request.variables; i++) {
    const v = lookup.request.variables;
    const nodeAt = lookup.body.data[`r${i}`];
    if (nodeAt) recorded.set(`${v[`o${i}`]}/${v[`n${i}`]}`.toLowerCase(), nodeAt);
  }

  /** A GitHub that answers lean lookups from the recorded archive lookup; anything else is NOT_FOUND. */
  function lookupRoute() {
    /** @type {string[][]} */
    const asked = [];
    /** @type {import('./support/fake-fetch.mjs').Route} */
    const r = {
      method: 'POST',
      respond: (call) => {
        assert.match(String(call.query), /fragment Lean on Repository/);
        const v = /** @type {any} */ (call.variables);
        /** @type {Record<string, unknown>} */
        const data = { rateLimit: { cost: 1, remaining: 4000, resetAt: '2026-09-11T13:00:00Z' } };
        const errors = [];
        const names = [];
        for (let i = 0; `o${i}` in v; i++) {
          const nwo = `${v[`o${i}`]}/${v[`n${i}`]}`;
          names.push(nwo);
          data[`r${i}`] = recorded.get(nwo.toLowerCase()) ?? null;
          if (!data[`r${i}`]) {
            errors.push({ type: 'NOT_FOUND', path: [`r${i}`], message: 'Could not resolve' });
          }
        }
        asked.push(names);
        return { status: 200, body: { data, errors }, ms: 900 };
      },
    };
    return { route: r, asked };
  }

  /** @returns {{units: Map<string, any>, isDone(k: string): boolean, start(k: string): void,
   *   done(k: string, o: any): void, fail(k: string, e: any): void}} */
  function ledger() {
    const units = new Map();
    return {
      units,
      isDone: (k) => units.get(k)?.state === 'done',
      start: (k) => { units.set(k, { state: 'running' }); },
      done: (k, out) => { units.set(k, { state: 'done', out }); },
      fail: (k, err) => { units.set(k, { state: 'failed', err }); },
    };
  }

  it('extracts, looks up and seeds one hour, and never sends the token to GH Archive', async () => {
    const { route, asked } = lookupRoute();
    const clock = fakeClock('2026-09-11T12:00:00Z', { auto: true });
    const githubFetch = createFakeFetch([route], { clock });
    const governor = createGovernor({}, { clock });
    const client = createClient({ token: TOKEN, governor, fetch: githubFetch });
    const gh = archiveFetch(SAMPLE);
    const units = ledger();
    /** @type {any[]} */
    const extracts = [];
    /** @type {Record<string, number>} */
    const stats = {};
    const batches = await all(archiveHour({
      client, date: '2026-09-10', hour: 15, fetch: gh, ledger: units, stats,
      writeExtract: (date, hour, events) => { extracts.push({ date, hour, events }); },
    }));
    const seeds = batches.flat();

    // what the sample says should happen
    const raw = (await all(streamEvents(URL_15, { fetch: archiveFetch(SAMPLE) }))).map(extractEvent);
    /** @type {Map<string, string>} */
    const kinds = new Map();
    for (const ev of /** @type {any[]} */ (raw)) {
      if (ev.prerelease === true) continue;
      const k = ev.nwo.toLowerCase();
      const kind = ev.type === 'ReleaseEvent' ? 'Release' : 'Public';
      if (kind === 'Release' || !kinds.has(k)) kinds.set(k, kind);
    }
    const expected = [...kinds].filter(([k]) => recorded.has(k))
      .map(([k, kind]) => seedFromNode(recorded.get(k), `archive:2026-09-10-15:${kind}`))
      .filter((s) => passesBase(s));

    assert.equal(extracts.length, 1);
    assert.equal(extracts[0].date, '2026-09-10');
    assert.equal(extracts[0].hour, 15);
    assert.equal(extracts[0].events.length, 270);
    const label = (/** @type {{id: string, source: string}} */ s) => `${s.id} ${s.source}`;
    assert.deepEqual(seeds.map(label).sort(), expected.map(label).sort());
    assert.ok(seeds.length > 10);
    assert.ok(seeds.every((s) => passesBase(s)));
    const lookedUp = new Set(asked.flat().map((n) => n.toLowerCase()));
    assert.equal(lookedUp.size, kinds.size, 'every repository with a non-prerelease event is looked up once');
    const named = new Set(raw.map((e) => /** @type {any} */ (e).nwo.toLowerCase()));
    const preOnly = [...named].filter((k) => !kinds.has(k));
    assert.ok(preOnly.length > 0 && preOnly.every((k) => !lookedUp.has(k)),
      'prerelease-only repositories are ignored');
    assert.ok(asked.every((names) => names.length <= 100));
    assert.equal(stats.lookups, asked.length);
    assert.equal(units.units.get('archive:2026-09-10-15').state, 'done');
    assert.equal(units.units.get('archive:2026-09-10-15').out.seeds, seeds.length);

    assert.equal(gh.calls.length, 1);
    assert.equal(gh.calls[0].url, URL_15);
    assert.equal(JSON.stringify(gh.calls[0].init.headers ?? {}).includes(TOKEN), false);
    const sent = JSON.stringify(gh.calls[0].init.headers ?? {}).toLowerCase();
    assert.equal(sent.includes('authorization'), false);
    assert.ok(githubFetch.calls.every((c) => c.url === 'https://api.github.com/graphql'));

    const again = await all(archiveHour({ client, date: '2026-09-10', hour: 15, fetch: gh, ledger: units }));
    assert.deepEqual(again, []);
    assert.equal(gh.calls.length, 1, 'a done hour is not fetched again');
  });

  it('a missing hour fails its unit instead of ending the run', async () => {
    const clock = fakeClock('2026-09-11T12:00:00Z', { auto: true });
    const governor = createGovernor({}, { clock });
    const client = createClient({ token: TOKEN, governor, fetch: createFakeFetch([], { clock }) });
    const units = ledger();
    const out = await all(archiveHour({
      client, date: '2026-09-10', hour: 16, fetch: archiveFetch(SAMPLE, { status: 404 }), ledger: units,
    }));
    assert.deepEqual(out, []);
    const unit = units.units.get('archive:2026-09-10-16');
    assert.equal(unit.state, 'failed');
    assert.equal(unit.err.code, 'EARCHIVE');
  });
});
