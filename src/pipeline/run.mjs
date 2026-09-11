// @ts-check
/**
 * `run` (DESIGN §3): the funnel census → archive → prefilter → re-check → enrich → deep → index,
 * inside a budget (§3.8), resumable (§3.12).
 *
 * - **Lock.** The run takes `data/.lock`; a live lock throws `LockError` (exit 2). Units left
 *   running by a dead run go back to `planned` when the lock is taken.
 * - **Units.** Census windows and archive hours are ledger units. WP1's `censusDay` and
 *   `archiveHour` receive a ledger whose `done()` is held back until the seeds yielded so far are
 *   stored, so a crash can never mark a unit done whose candidates were lost; candidates are
 *   upserts, so redoing a unit writes no duplicates.
 * - **Budget.** Every GitHub call goes through a metering client that charges its response time to
 *   the current phase; each phase runs while `budget.allows(phase)` (census ≤ 30 %, archive its own
 *   5 % even after census overshot, enrich until 85 %, deep the rest, unused shares rolling
 *   forward) and the wall clock lasts. The governor delivers less GraphQL time a minute than the
 *   budget assumes, so a budgeted run also stops enrich early enough to leave deep
 *   `min(20 % of the wall, 2 s per repository to deepen)` of the wall clock; deep stops only
 *   between chunks, whose queries are already answered. An archive hour (download and lookups,
 *   about 2 minutes, and it cannot stop half-way) starts only with that much wall clock left before
 *   deep's part. `--until caught-up` lets discovery ignore the budget.
 * - **Census order.** Each created-day starts at an hour drawn from the run's seeded generator, so
 *   runs that stop part-way through a day spread over all of its hours.
 * - **Exit.** `0` finished (also when the budget ran out), `75` a rate-limit pause that cannot be
 *   waited out (`--no-wait`, or it outlasts the budget) with `resumeAt`, `130` interrupted (the
 *   request in flight finishes, the manifest is written, the lock released). Other errors are
 *   recorded in the manifest and rethrown.
 */

import { formatMs } from '../log.mjs';
import { dayOf, summaryOf } from '../store/common.mjs';
import { createOwnerCaps, emptyPrefilterStats, ingestSeeds } from './candidates.mjs';
import { deepen, emptyDeepStats, selectDeep } from './deep.mjs';
import { loadDeps } from './deps.mjs';
import { emptyEnrichStats, enrich } from './enrich.mjs';
import { buildIndex } from './indexer.mjs';
import { recheck } from './recheck.mjs';
import {
  SILENT_LOG, createMeter, fmt, isAbort, isFatal, isPause, isRecoverable, isStopPause, meterClient,
  resumeAtMs,
} from './util.mjs';

/** @typedef {import('../core/schema.mjs').RunManifest} RunManifest */
/** @typedef {import('../core/schema.mjs').CandidateSeed} CandidateSeed */
/** @typedef {import('../config.mjs').RunOptions} RunOptions */
/** @typedef {import('../config.mjs').Config} Config */
/** @typedef {import('./deps.mjs').Lib} Lib */

/** Checkpoint the manifest this often (§3.12). */
export const CHECKPOINT_MS = 60_000;

/** Candidates taken from the queue at a time; exploration fills one slot in every 20. */
export const ENRICH_CHUNK = 100;

/** A stage retries after waiting out at most this many pauses. */
const MAX_PAUSES = 20;

/** Wall clock a budgeted run keeps for deep: this much per repository to deepen (§3.8)… */
export const DEEP_RESERVE_PER_REPO_MS = 2_000;

/** …but at most this share of the wall. */
export const DEEP_RESERVE_SHARE = 0.2;

/**
 * Wall clock one GH Archive hour takes, download and lookups together (measured live on
 * 2026-09-11: 2,190 events, 17 lookups, 2m 04s). An hour cannot stop half-way, so a budgeted run
 * starts one only with this much of the wall clock left before the part kept for deep.
 */
export const ARCHIVE_HOUR_WALL_MS = 120_000;

/**
 * The end of the wall clock that enrich leaves to deep: `min(20 % of the wall, 2 s × deepTopN)`,
 * or 0 for an unbudgeted run or one that deepens nothing.
 * @param {number | null} wallMs
 * @param {number} deepTopN
 * @returns {number}
 */
export function deepReserveMs(wallMs, deepTopN) {
  if (wallMs === null || !Number.isFinite(wallMs) || !(deepTopN > 0)) return 0;
  return Math.min(DEEP_RESERVE_SHARE * wallMs, deepTopN * DEEP_RESERVE_PER_REPO_MS);
}

/**
 * @typedef {object} RunCtx
 * @property {any} store
 * @property {any} [client] the GitHub client (not needed for a dry run)
 * @property {any} [governor] its governor, for pause statistics
 * @property {any} [budget] a `Budget` (§12.2); default `createBudget(opts.budget, {clock})`
 * @property {{now: () => string, ms: () => number,
 *   sleep: (ms: number, o?: {signal?: AbortSignal}) => Promise<void>}} clock
 * @property {Config} config
 * @property {import('../log.mjs').Log} [log]
 * @property {() => number} rand the run's seeded generator
 * @property {string[]} [argv]
 * @property {string} [runId] default `YYYYMMDDTHHMMSSZ-xxxx`
 * @property {AbortSignal} [signal] aborted on Ctrl-C
 * @property {typeof fetch} [fetch] for GH Archive (default `globalThis.fetch`)
 * @property {string} [userAgent] sent to GH Archive
 * @property {Lib} [deps] injected functions (default: the real modules)
 */

/**
 * `YYYYMMDDTHHMMSSZ-xxxx` (§4.3).
 * @param {string} iso
 * @param {() => number} rand
 * @returns {string}
 */
export function makeRunId(iso, rand) {
  const stamp = new Date(Date.parse(iso)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const suffix = Math.floor((rand?.() ?? 0) * 0x10000).toString(16).padStart(4, '0');
  return `${stamp}-${suffix}`;
}

/**
 * A ledger for WP1 code whose `done()` waits until `flush()`, which the run calls once the seeds
 * yielded so far are stored.
 * @param {any} ledger the store's ledger
 * @param {string} runId
 * @param {Map<string, string>} touched unit key → last state, for the manifest
 */
function heldLedger(ledger, runId, touched) {
  /** @type {{key: string, out: any}[]} */
  const pending = [];
  /** @type {Set<string>} units whose seeds are known to be stored */
  const confirmed = new Set();
  /** @param {string} key */
  const isPending = (key) => pending.some((p) => p.key === key);
  /** @param {{key: string, out: any}} p */
  const mark = (p) => {
    const u = ledger.done(p.key, p.out);
    touched.set(p.key, u.state);
    return u;
  };
  return {
    api: {
      /** @param {string} key */
      get: (key) => ledger.get(key),
      /** @param {string} key */
      isDone: (key) => ledger.isDone(key) || isPending(key),
      /**
       * @param {string} key
       * @param {string} [nowIso]
       */
      canStart: (key, nowIso) => !isPending(key) && ledger.canStart(key, nowIso),
      /**
       * @param {string} key
       * @param {string} [stage]
       * @param {string} [rid]
       */
      start: (key, stage, rid) => {
        const u = ledger.start(key, stage, rid ?? runId);
        touched.set(key, u.state);
        return u;
      },
      /**
       * @param {string} key
       * @param {any} [out]
       */
      done: (key, out) => {
        pending.push({ key, out: out ?? null });
        return { ...(ledger.get(key) ?? { v: 1, key }), state: 'done', out: out ?? null };
      },
      /**
       * @param {string} key
       * @param {unknown} err
       */
      fail: (key, err) => {
        const u = ledger.fail(key, err);
        touched.set(key, u.state);
        return u;
      },
      /** @param {any} [filter] */
      list: (filter) => ledger.list(filter),
      /**
       * @param {string} key
       * @param {string} [stage]
       */
      plan: (key, stage) => ledger.plan(key, stage),
    },
    /**
     * Note that every seed of a unit has been stored.
     * @param {unknown} key
     */
    confirm(key) {
      if (typeof key === 'string') confirmed.add(key);
    },
    /** @returns {any[]} the units marked done (everything held; call after the seeds are stored) */
    flush() {
      return pending.splice(0).map(mark);
    },
    /**
     * After a failure: mark done only the held units whose seeds were confirmed stored; the others
     * stay running and are redone by a later run.
     * @returns {any[]}
     */
    flushConfirmed() {
      return pending.splice(0).filter((p) => confirmed.has(p.key)).map(mark);
    },
  };
}

/**
 * Run the funnel once.
 * @param {RunOptions} opts from `resolveProfile`
 * @param {RunCtx} ctx
 * @returns {Promise<RunManifest>}
 */
export async function run(opts, ctx) {
  const lib = ctx.deps ?? await loadDeps();
  const { store, config, clock } = ctx;
  const log = ctx.log ?? SILENT_LOG;
  const now = () => clock.now();
  const startedAt = now();
  const startMs = clock.ms();
  const runId = ctx.runId ?? makeRunId(startedAt, ctx.rand);
  // The census scope goes to WP1 as {lang, topic}; its key form (`all`, `lang=rust`, …) is WP1's.
  const scope = { lang: opts.lang ?? null, topic: opts.topic ?? null };
  if (opts.dryRun) return plan(opts, ctx, lib, runId, String(lib.scopeKey(scope)));

  const budget = ctx.budget ?? lib.createBudget({
    wallMs: opts.budget.wallMs, graphqlMs: opts.budget.graphqlMs, shares: opts.budget.shares,
  }, { clock });
  const meter = createMeter({ budget, clock });
  const client = meterClient(ctx.client, meter, clock);
  // --no-wait, or a pause past the wall budget, makes the governor throw PauseError (exit 75).
  ctx.governor?.configure?.({
    wait: opts.wait, deadlineMs: opts.budget.wallMs === null ? null : startMs + opts.budget.wallMs,
  });
  const signal = ctx.signal;
  let interrupted = Boolean(signal?.aborted);
  const onAbort = () => {
    interrupted = true;
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    await store.lock(runId);
  } catch (err) {
    signal?.removeEventListener('abort', onAbort);
    throw err;
  }

  /** @type {Map<string, string>} */
  const touched = new Map();
  const census = { days: /** @type {string[]} */ ([]), units: 0, pages: 0, seeds: 0, saturated: 0 };
  /** @type {{hours: string[], events: number, lookups: number, seeds: number, skipped?: string}} */
  const archive = { hours: [], events: 0, lookups: 0, seeds: 0 };
  const prefilter = emptyPrefilterStats();
  const estats = emptyEnrichStats();
  const dstats = emptyDeepStats();
  const rstats = { checked: 0, gone: 0, requeued: 0 };
  /** @type {Map<string, {band: string, lane: string}>} */
  const scored = new Map();
  /** @type {{resource: string, ms: number, why: string}[]} */
  const pauses = [];
  /** @type {{code: number, reason: string, resumeAt: string | null} | null} */
  let stop = null;
  let wallOut = false;

  /** @type {RunManifest} */
  const manifest = {
    v: 1, runId, startedAt, endedAt: null, argv: ctx.argv ?? [], profile: opts.profile,
    budget: { wallMs: opts.budget.wallMs, graphqlMs: opts.budget.graphqlMs },
    stages: {}, rate: {}, exit: null, units: [],
  };

  const fill = () => {
    const scoreCounts = { gem: 0, look: 0, low: 0, lanes: /** @type {Record<string, number>} */ ({}) };
    for (const { band, lane } of scored.values()) {
      if (band === 'gem' || band === 'look' || band === 'low') scoreCounts[band]++;
      scoreCounts.lanes[lane] = (scoreCounts.lanes[lane] ?? 0) + 1;
    }
    const e = meter.of('enrich');
    const d = meter.of('deep');
    census.pages = meter.of('census').searches;
    archive.lookups = meter.of('archive').calls;
    manifest.stages = {
      census: { ...census },
      archive: { ...archive },
      prefilter: { ...prefilter, dropped: { ...prefilter.dropped } },
      enrich: {
        repos: estats.repos, calls: e.calls, halvings: e.heavy, heavy: estats.heavy, gone: estats.gone,
        explore: estats.explore, kept: estats.kept, failed: estats.failed,
      },
      deep: { repos: dstats.repos, graphqlCalls: d.calls, restCalls: d.rest },
      score: scoreCounts,
      recheck: { ...rstats },
    };
    const snap = ctx.governor?.snapshot?.();
    const governorPauses = Array.isArray(snap?.pauses) ? snap.pauses : [];
    manifest.rate = { ...meter.rate(), pauses: [...pauses, ...governorPauses] };
    manifest.units = [...touched.keys()].map((key) => ({
      key, state: store.ledger.get(key)?.state ?? touched.get(key),
    }));
  };

  let lastCheckpoint = clock.ms();
  const checkpoint = async () => {
    if (clock.ms() - lastCheckpoint < CHECKPOINT_MS) return;
    lastCheckpoint = clock.ms();
    fill();
    await store.checkpointRun(manifest);
  };

  const wallExceeded = () => opts.budget.wallMs !== null && clock.ms() - startMs >= opts.budget.wallMs;
  const reserveMs = deepReserveMs(opts.budget.wallMs, opts.deepTopN);
  /** Whether the wall clock has reached the part kept for deep (§3.8). */
  const inDeepReserve = () => reserveMs > 0 && opts.budget.wallMs !== null
    && clock.ms() - startMs >= opts.budget.wallMs - reserveMs;
  /** Wall clock left before deep's part, when the archive lane last found too little for an hour. */
  let archiveLeftMs = /** @type {number | null} */ (null);

  /**
   * Whether a phase must stop now.
   * @param {'census' | 'archive' | 'enrich' | 'deep'} phase
   * @returns {boolean}
   */
  const mustStop = (phase) => {
    if (stop) return true;
    if (interrupted || signal?.aborted) {
      stop = { code: 130, reason: 'interrupted', resumeAt: null };
      return true;
    }
    if (opts.until === 'caught-up' && (phase === 'census' || phase === 'archive')) return false;
    if (wallOut || wallExceeded()) {
      wallOut = true;
      return true;
    }
    if (phase === 'enrich' && inDeepReserve()) return true;
    if (phase === 'archive' && opts.budget.wallMs !== null) {
      const left = opts.budget.wallMs - reserveMs - (clock.ms() - startMs);
      if (left < ARCHIVE_HOUR_WALL_MS) {
        archiveLeftMs = Math.max(0, left);
        return true;
      }
    }
    return !budget.allows(phase);
  };

  /** Why the archive lane stopped before its first hour: `budget`, `wall`, `time` or the stop reason. */
  const archiveSkipReason = () => (stop ? stop.reason : wallOut ? 'wall' : archiveLeftMs !== null ? 'time'
    : 'budget');

  /**
   * Run a stage step, waiting out rate-limit pauses when allowed (§3.10); otherwise stop with 75.
   * @param {() => Promise<void>} step
   */
  const withPauses = async (step) => {
    for (let n = 0; n < MAX_PAUSES; n++) {
      try {
        await step();
        return;
      } catch (err) {
        if (!isPause(err)) throw err;
        const nowMs = clock.ms();
        const until = resumeAtMs(err, nowMs);
        const e = /** @type {{resource?: string, why?: string, name?: string}} */ (err);
        pauses.push({
          resource: e.resource ?? 'graphql', ms: Math.max(0, until - nowMs),
          why: e.why ?? (e.name === 'CircuitOpenError' ? 'breaker' : 'rate-limit'),
        });
        const beyond = opts.budget.wallMs !== null && until > startMs + opts.budget.wallMs;
        if (!opts.wait || beyond || isStopPause(err)) {
          stop = { code: 75, reason: 'paused', resumeAt: new Date(until).toISOString() };
          return;
        }
        log.info(`GitHub asked us to pause until ${new Date(until).toISOString()}; waiting`);
        await clock.sleep(Math.max(0, until - nowMs), { signal });
      }
    }
    stop = { code: 75, reason: 'paused', resumeAt: new Date(clock.ms() + 60_000).toISOString() };
  };

  /**
   * @param {CandidateSeed[]} seeds
   * @param {'census' | 'archive'} kind
   */
  const caps = createOwnerCaps();
  const ingest = async (/** @type {any} */ seeds, /** @type {'census' | 'archive'} */ kind) => {
    const list = Array.isArray(seeds) ? seeds : [];
    if (kind === 'census') census.seeds += list.length;
    else archive.seeds += list.length;
    await ingestSeeds(list, {
      store, lib, now: now(), maxStars: opts.maxStars, ownerCapPerDay: opts.ownerCapPerDay, caps,
      stats: prefilter,
    });
  };

  /** @param {any} seeds a census batch; WP1 attaches the leaf window it came from as `unit` */
  const countUnit = (seeds) => {
    const unit = seeds?.unit;
    if (!unit) return;
    census.units++;
    if (unit.saturated) census.saturated++;
  };

  try {
    await store.startRun(manifest);

    // Retention at the start of a daily run (§4.2); queued candidates past their TTL expire (§3.4).
    if (opts.profile === 'daily') await store.compact({ now: now() });
    const ttlCut = Date.parse(now()) - opts.queueTtlDays * 86_400_000;
    const queued = await store.listCandidates({ state: 'queued' });
    const stale = queued.filter((/** @type {any} */ c) => Date.parse(c.seenAt) < ttlCut);
    if (stale.length > 0) {
      await store.putCandidates(stale.map((c) => ({ ...c, state: 'expired', reason: 'queue-ttl' })));
    }
    /** @type {Record<string, number>} */
    const expired = { expired: stale.length };

    // --- census (§3.2) -----------------------------------------------------------------------
    let t0 = clock.ms();
    meter.setPhase('census');
    const days = lib.planDays({
      today: dayOf(now()), lagDays: opts.lagDays, backfillDays: opts.backfillDays,
    });
    for (const day of days) {
      if (mustStop('census')) break;
      census.days.push(day);
      // A seeded start hour (§3.2): runs that stop part-way through a day spread over its hours
      // (and the time zones behind them) instead of always taking 00:00–02:00 UTC.
      const startHour = Math.floor((typeof ctx.rand === 'function' ? ctx.rand() : 0) * 24) % 24;
      await withPauses(async () => {
        const held = heldLedger(store.ledger, runId, touched);
        try {
          const batches = lib.censusDay({
            client, day, scope, ledger: held.api, log, runId, maxStars: opts.maxStars, clock, signal,
            phase: 'census', startHour,
          });
          /** @type {any} the leaf whose seeds were stored last */
          let last = null;
          let lastSeeds = 0;
          for await (const seeds of batches) {
            countUnit(seeds);
            await ingest(seeds, 'census');
            last = /** @type {any} */ (seeds)?.unit ?? null;
            lastSeeds = Array.isArray(seeds) ? seeds.length : 0;
            held.confirm(last?.key);
            held.flush();
            await checkpoint();
            if (mustStop('census')) break;
          }
          held.flush();
          // WP1 marks a leaf done when asked for the next one; when the run stops in between, the
          // leaf whose seeds were just stored is marked here rather than fetched again next time.
          if (typeof last?.key === 'string' && !store.ledger.isDone(last.key)) {
            const u = store.ledger.done(last.key, {
              count: last.count ?? lastSeeds, pages: last.pages ?? null, saturated: Boolean(last.saturated),
              seeds: lastSeeds,
            });
            touched.set(last.key, u.state);
          }
        } catch (err) {
          held.flushConfirmed();
          if (!isRecoverable(err)) throw err;
          log.warn(`Census of ${day} failed; it will be retried`, { error: err });
        }
      });
    }
    fill();
    const saturatedText = census.saturated ? ` · ${census.saturated} saturated` : '';
    log.stage('census', {
      text: `created ${census.days.join(', ') || 'none'} · ${fmt(census.units)} windows · `
        + `${fmt(census.pages)} pages · ${fmt(census.seeds)} repos${saturatedText}`,
      ms: clock.ms() - t0,
    });

    // --- GH Archive (§3.3) -------------------------------------------------------------------
    if (opts.archive && opts.archiveHours > 0 && !stop) {
      t0 = clock.ms();
      meter.setPhase('archive');
      const fetchFn = ctx.fetch ?? globalThis.fetch;
      for (const { date, hour } of lib.completeHours(now(), opts.archiveHours)) {
        const key = `archive:${date}-${Number(hour)}`;
        if (!store.ledger.canStart(key)) continue;
        if (mustStop('archive')) {
          if (archive.hours.length === 0) archive.skipped = archiveSkipReason();
          break;
        }
        archive.hours.push(`${date}-${Number(hour)}`);
        /** @param {...any} args */
        const writeExtract = async (...args) => {
          const [d, h, events] = args.length >= 3 ? args : [date, hour, args[0]];
          const n = await store.writeArchiveExtract(d, h, events);
          archive.events += n;
          return n;
        };
        await withPauses(async () => {
          const held = heldLedger(store.ledger, runId, touched);
          try {
            const batches = lib.archiveHour({
              client, date, hour, fetch: fetchFn, ledger: held.api, writeExtract, log, runId,
              maxStars: opts.maxStars, batch: opts.batch.lookup, phase: 'archive', signal,
              userAgent: ctx.userAgent,
            });
            // An hour's seeds come after all of its lookups and are already in memory: store every
            // array so the hour is marked done, rather than stopping between them and redoing the
            // whole hour next run. The budget is checked between hours.
            for await (const seeds of batches) {
              await ingest(seeds, 'archive');
              held.flush();
              await checkpoint();
            }
            held.flush();
          } catch (err) {
            if (isFatal(err) || isPause(err)) throw err;
            if (store.ledger.get(key)?.state !== 'failed') held.api.fail(key, err);
            log.warn(`GH Archive hour ${date}-${hour} failed; it will be retried`, { error: err });
          }
        });
        if (stop) break;
      }
      fill();
      let archiveText = `${archive.hours.join(', ') || 'no new hours'} · `
        + `${fmt(archive.events)} release/public events · ${fmt(archive.seeds)} candidates`;
      if (archive.skipped === 'budget') {
        const of = opts.budget.graphqlMs === null ? '' : ` of the ${formatMs(opts.budget.graphqlMs)}`;
        archiveText = `skipped: census used ${formatMs(meter.of('census').serverMs) || '0ms'}${of}`
          + ' GraphQL budget';
      } else if (archive.skipped === 'time') {
        archiveText = `skipped: ${formatMs(archiveLeftMs ?? 0) || '0ms'} of the wall clock left before deep;`
          + ` an hour takes about ${formatMs(ARCHIVE_HOUR_WALL_MS)}`;
      } else if (archive.skipped === 'wall') archiveText = 'skipped: the wall-clock budget ran out';
      else if (archive.skipped) archiveText = `skipped: ${archive.skipped}`;
      log.stage('archive', { text: archiveText, ms: clock.ms() - t0 });
    }

    const dropped = Object.entries(prefilter.dropped).map(([r, n]) => `${r.replace(/-/g, ' ')} ${fmt(n)}`);
    const held = [
      ...dropped,
      ...(prefilter.deferred ? [`deferred ${fmt(prefilter.deferred)}`] : []),
      ...(prefilter.quarantined ? [`lure ${fmt(prefilter.quarantined)}`] : []),
      ...(expired.expired ? [`expired ${fmt(expired.expired)}`] : []),
    ];
    const heldText = held.length ? ` (${held.join(' · ')})` : '';
    log.stage('prefilter', { text: `${fmt(prefilter.in)} → ${fmt(prefilter.queued)} queued${heldText}` });

    // --- re-check (§3.7) ---------------------------------------------------------------------
    if (!stop && !wallOut && !mustStop('enrich')) {
      t0 = clock.ms();
      meter.setPhase('recheck');
      await withPauses(async () => {
        const r = await recheck({
          client, store, config, now, top: opts.recheckTop, deps: lib, log, signal,
        });
        Object.assign(rstats, r);
      });
      log.stage('recheck', {
        text: `${fmt(rstats.checked)} checked · ${fmt(rstats.gone)} gone · `
          + `${fmt(rstats.requeued)} re-queued`,
        ms: clock.ms() - t0,
      });
    }

    // --- enrich and score (§3.5) -------------------------------------------------------------
    const feedbackIds = new Set((await store.readFeedback()).map((/** @type {any} */ e) => e.id));
    if (!stop) {
      t0 = clock.ms();
      meter.setPhase('enrich');
      /** @type {Set<string>} */
      const attempted = new Set();
      const env = {
        client, store, config, lib, now, log, batch: opts.batch.enrich, feedbackIds, stats: estats, signal,
      };
      await withPauses(async () => {
        while (attempted.size < opts.enrichMax && !mustStop('enrich')) {
          const room = opts.enrichMax - attempted.size;
          const chunk = await store.queue({
            limit: Math.min(ENRICH_CHUNK, room), explore: opts.explore, rand: ctx.rand, exclude: attempted,
          });
          if (chunk.length === 0) break;
          let broke = false;
          for await (const out of enrich(chunk, env)) {
            attempted.add(out.candidate.id);
            const rs = out.record?.score;
            if (rs) scored.set(/** @type {any} */ (out.record).id, { band: rs.band, lane: rs.lane });
            await checkpoint();
            if (mustStop('enrich')) {
              broke = true;
              break;
            }
          }
          if (!broke) for (const c of chunk) attempted.add(c.id);
        }
      });
      fill();
      const e = meter.of('enrich');
      const halvings = e.heavy ? ` (${e.heavy} halving${e.heavy === 1 ? '' : 's'})` : '';
      const goneText = estats.gone ? ` · gone ${fmt(estats.gone)}` : '';
      log.stage('enrich', {
        text: `${fmt(estats.repos)} repos in ${fmt(e.calls)} calls${halvings}`
          + ` · explore ${fmt(estats.explore)}${goneText}`,
        ms: clock.ms() - t0,
      });
    }

    // --- deep and rescore (§3.6) -------------------------------------------------------------
    if (!stop && opts.deepTopN > 0 && !mustStop('deep')) {
      t0 = clock.ms();
      meter.setPhase('deep');
      /** @type {any[]} */
      const light = [];
      for await (const rec of store.listRepos()) {
        if (!rec?.score || rec.gone) continue;
        const s = rec.score;
        const f = /** @type {any} */ (rec.facts);
        light.push({
          id: rec.id, nwo: rec.nwo,
          score: { lane: s.lane, gem: s.gem, attention: { stars: s.attention?.stars ?? 0 } },
          facts: {
            stages: f?.stages, headOid: f?.headOid, deepHeadOid: f?.deepHeadOid, createdAt: f?.createdAt,
          },
        });
      }
      const picks = selectDeep(light, opts.deepTopN);
      /** @type {Set<string>} */
      const deepened = new Set();
      const env = {
        client, store, config, lib, now, log, batch: opts.batch.deep, feedbackIds, stats: dstats, signal,
        restConcurrency: opts.governor?.restConcurrency,
      };
      const chunkSize = Math.max(1, opts.batch.deep.size);
      await withPauses(async () => {
        const todo = [];
        for (const p of picks) {
          if (deepened.has(p.id)) continue;
          const rec = await store.getRepo(p.nwo);
          if (rec) todo.push(rec);
        }
        // The budget is checked between chunks: a chunk's deep and file queries are answered before
        // its first record comes out, so stopping inside one would throw that work away.
        for (let i = 0; i < todo.length; i += chunkSize) {
          if (mustStop('deep')) break;
          for await (const rec of deepen(todo.slice(i, i + chunkSize), env)) {
            deepened.add(rec.id);
            if (rec.score) scored.set(rec.id, { band: rec.score.band, lane: rec.score.lane });
            await checkpoint();
          }
        }
      });
      fill();
      const d = meter.of('deep');
      log.stage('deep', {
        text: `deepened ${fmt(dstats.repos)} of top ${fmt(picks.length)} · ${fmt(d.calls)} queries · `
          + `${fmt(d.rest)} REST (${fmt(d.notModified)} not modified)`,
        ms: clock.ms() - t0,
      });
    }

    fill();
    const sc = /** @type {any} */ (manifest.stages.score);
    const lanes = Object.entries(sc.lanes).filter(([l]) => l === 'promising' || l === 'proven')
      .map(([l, n]) => `${l} ${fmt(/** @type {number} */ (n))}`);
    const laneText = lanes.length ? ` (${lanes.join(' · ')})` : '';
    log.stage('score', {
      text: `gem ${fmt(sc.gem)}${laneText} · look ${fmt(sc.look)} · low ${fmt(sc.low)}`
        + ` · quarantined ${fmt(sc.lanes.quarantine ?? 0)}`,
    });

    stop ??= { code: 0, reason: wallOut ? 'budget' : 'finished', resumeAt: null };
    for (const [key] of touched) {
      const u = store.ledger.get(key);
      if (u?.state === 'running' && u.runId === runId) store.ledger.plan(key);
    }
    manifest.exit = stop;
    manifest.endedAt = now();
    fill();

    if (stop.code !== 130) {
      const index = await buildIndex({ store, config, now: now(), lastRun: summaryOf(manifest), deps: lib });
      await store.writeIndex(index);
      const queued = (await store.candidateCounts()).queued ?? 0;
      log.stage('index', {
        text: `${store.dir ? 'data/index.json' : 'index'} · ${fmt(index.entries.length)} entries · `
          + `${fmt(queued)} still queued for the next run`,
      });
    }
    if (stop.code === 75) log.warn(`Paused by GitHub's rate limits; resume at ${stop.resumeAt}`);
    await store.endRun(manifest);
    return manifest;
  } catch (err) {
    const aborted = isAbort(err);
    const given = /** @type {any} */ (err)?.exitCode;
    const code = aborted ? 130 : typeof given === 'number' ? given : 1;
    manifest.exit = { code, reason: aborted ? 'interrupted' : 'error', resumeAt: null };
    manifest.endedAt = now();
    for (const [key] of touched) {
      const u = store.ledger.get(key);
      if (u?.state === 'running' && u.runId === runId) store.ledger.plan(key);
    }
    fill();
    /** @type {any} */ (manifest).error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    try {
      await store.endRun(manifest);
    } catch (e) {
      log.error('Could not write the run manifest', { error: e });
    }
    if (aborted) return manifest;
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await store.unlock();
  }
}

/**
 * `--dry-run` (§9.1): plan units and print the budget without calling GitHub or writing anything.
 * @param {RunOptions} opts
 * @param {RunCtx} ctx
 * @param {Lib} lib
 * @param {string} runId
 * @param {string} scope
 * @returns {Promise<RunManifest>}
 */
async function plan(opts, ctx, lib, runId, scope) {
  const { store, clock } = ctx;
  const log = ctx.log ?? SILENT_LOG;
  const at = clock.now();
  const days = lib.planDays({ today: dayOf(at), lagDays: opts.lagDays, backfillDays: opts.backfillDays });
  const censusPlan = days.map((/** @type {string} */ day) => {
    const units = store.ledger.list({ prefix: `census:${day}:${scope}:` });
    const done = units.filter((/** @type {any} */ u) => u.state === 'done').length;
    return { day, done, known: units.length };
  });
  const hours = opts.archive
    ? lib.completeHours(at, opts.archiveHours).map((/** @type {any} */ { date, hour }) => {
      const key = `archive:${date}-${Number(hour)}`;
      return { hour: `${date}-${Number(hour)}`, todo: store.ledger.canStart(key) };
    })
    : [];
  const queued = (await store.candidateCounts()).queued ?? 0;
  const { wallMs, graphqlMs, shares } = opts.budget;
  const todo = hours.filter((h) => h.todo).length;
  log.stage('plan', {
    text: `census ${days.join(', ') || 'none'} (scope ${scope})`
      + ` · archive ${todo} of ${hours.length} hours to do · ${fmt(queued)} queued`,
  });
  /** @param {number} x */
  const pct = (x) => Math.round(x * 100);
  const limits = `enrich up to ${fmt(opts.enrichMax)} · deep top ${fmt(opts.deepTopN)}`;
  log.stage('budget', {
    text: wallMs === null
      ? `uncapped (${opts.profile}) · ${limits}`
      : `${formatMs(wallMs)} wall · GraphQL ${formatMs(graphqlMs ?? 0)}: `
        + `census ≤ ${pct(shares.census)} %, archive ${pct(shares.archive)} %, `
        + `enrich to ${pct(shares.enrichUntil)} %, deep the rest`
        + ` · ${limits}`,
  });
  return {
    v: 1, runId, startedAt: at, endedAt: clock.now(), argv: ctx.argv ?? [], profile: opts.profile,
    budget: { wallMs, graphqlMs },
    stages: { plan: { scope, days: censusPlan, hours, queued } },
    rate: {},
    exit: { code: 0, reason: 'dry-run', resumeAt: null },
  };
}
