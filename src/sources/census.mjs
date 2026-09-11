// @ts-check
/**
 * The census source (DESIGN §3.2): which created-days to census, and one day's seeds, leaf window by
 * leaf window. `run` censuses days from `today − lagDays` back to `today − lagDays − backfillDays`,
 * newest first; within a day the 24 hourly windows go in order from `startHour`, wrapping round to
 * the hours before it, and completed units are skipped. `run` draws `startHour` from its seeded
 * generator, so runs that stop part-way through a day sample different hours (and time zones)
 * rather than always the first two.
 */

import { BASE_QUERY } from '../github/queries.mjs';
import { censusWindows, hourWindows } from '../github/search.mjs';
import { DEFAULT_MAX_STARS, passesBase, seedFromNode } from './seed.mjs';

const DAY_MS = 86_400_000;

/**
 * @typedef {import('../core/schema.mjs').CandidateSeed} CandidateSeed
 * @typedef {import('../github/client.mjs').Client} Client
 * @typedef {import('../github/search.mjs').Ledger} Ledger
 * @typedef {import('../github/search.mjs').CensusStats} CensusStats
 */

/**
 * The unit a batch of census seeds came from; attached to each yielded array as a non-enumerable
 * `unit` property.
 * @typedef {object} CensusUnit
 * @property {string} key
 * @property {string} fromIso
 * @property {string} toIso
 * @property {string | null} stars
 * @property {number} count
 * @property {number} pages
 * @property {boolean} saturated
 * @property {number} dropped
 * @property {number} ms
 * @property {number} points
 */

/**
 * @param {unknown} v
 * @param {string} what
 * @returns {number}
 */
function wholeDays(v, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`${what} must be a whole number of days ≥ 0`);
  return n;
}

/**
 * Created-days to census, newest first (§3.2).
 * @param {{today: string | number | Date, lagDays?: number, backfillDays?: number}} opts `today` is an
 *   ISO timestamp, a `YYYY-MM-DD` day, a Date or milliseconds (UTC)
 * @returns {string[]} `YYYY-MM-DD`
 */
export function planDays({ today, lagDays = 3, backfillDays = 0 }) {
  const t = today instanceof Date ? today.getTime()
    : typeof today === 'number' ? today
      : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(String(today)) ? `${today}T00:00:00Z` : String(today));
  if (!Number.isFinite(t)) throw new RangeError('planDays needs today as a date or timestamp');
  const lag = wholeDays(lagDays, 'lagDays');
  const back = wholeDays(backfillDays, 'backfillDays');
  const midnight = Math.floor(t / DAY_MS) * DAY_MS;
  return Array.from({ length: back + 1 },
    (_, i) => new Date(midnight - (lag + i) * DAY_MS).toISOString().slice(0, 10));
}

/**
 * The 24 hourly windows of a day starting at `startHour` and wrapping round.
 * @param {string} day
 * @param {unknown} startHour a whole hour 0–23 (anything else counts as 0)
 * @returns {import('../github/search.mjs').Window[]}
 */
export function rotatedHours(day, startHour = 0) {
  const all = hourWindows(day);
  const n = Number(startHour);
  const start = Number.isInteger(n) && n >= 0 && n < 24 ? n : 0;
  return [...all.slice(start), ...all.slice(0, start)];
}

/**
 * Census one created-day: the 24 hourly windows from `startHour` round to the hour before it, each
 * walked adaptively (`censusWindows`). Yields the seeds of each leaf window — an array, possibly
 * empty, carrying its `unit` — and marks the unit done when the consumer asks for the next one.
 * Seeds are de-duplicated across the day and pass the base query on live values.
 * @param {object} opts
 * @param {Client} opts.client
 * @param {string} opts.day `YYYY-MM-DD`
 * @param {number} [opts.startHour] the UTC hour (0–23) to begin with (default 0: oldest first)
 * @param {unknown} [opts.scope] `null`/`'all'`, `'lang=rust'`, or `{lang, topic}`
 * @param {Ledger | null} [opts.ledger]
 * @param {{debug(msg: string, f?: object): void, warn(msg: string, f?: object): void} | null} [opts.log]
 * @param {string | null} [opts.runId]
 * @param {string} [opts.base] default `BASE_QUERY`
 * @param {number} [opts.maxStars] default 25
 * @param {{ms(): number}} [opts.clock]
 * @param {string} [opts.phase] budget phase (default `census`)
 * @param {AbortSignal} [opts.signal]
 * @param {Partial<CensusStats>} [opts.stats] accumulated across the day
 * @returns {AsyncGenerator<CandidateSeed[] & {unit?: CensusUnit}>}
 */
export async function* censusDay(opts) {
  const {
    client, day, scope = null, ledger = null, log = null, runId = null, base = BASE_QUERY,
    maxStars = DEFAULT_MAX_STARS, clock, phase = 'census', signal, stats, startHour = 0,
  } = opts;
  const windows = rotatedHours(day, startHour);
  /** @type {Set<string>} */
  const seen = new Set();
  const source = `census:${day}`;
  for (const hour of windows) {
    const leaves = censusWindows({
      client, base, scope, fromIso: hour.fromIso, toIso: hour.toIso, ledger, log, day, runId, clock, phase,
      signal, seen, stats,
    });
    for await (const leaf of leaves) {
      /** @type {CandidateSeed[]} */
      const seeds = [];
      for (const node of leaf.nodes) {
        /** @type {CandidateSeed} */
        let seed;
        try {
          seed = seedFromNode(node, source);
        } catch {
          continue;
        }
        if (passesBase(seed, { maxStars })) seeds.push(seed);
      }
      /** @type {CensusUnit} */
      const unit = {
        key: leaf.key, fromIso: leaf.fromIso, toIso: leaf.toIso, stars: leaf.stars, count: leaf.count,
        pages: leaf.pages, saturated: leaf.saturated, dropped: leaf.dropped, ms: leaf.ms, points: leaf.points,
      };
      Object.defineProperty(seeds, 'unit', { value: unit, enumerable: false });
      yield seeds;
    }
  }
}
