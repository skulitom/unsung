// @ts-check
/**
 * The explorer's data access (DESIGN §10.1, §10.5, §12.7). Served locally, every call goes to the
 * server's JSON API. On a read-only Pages copy there is no API: the index comes from
 * `data/gallery.json` and feedback is kept in `localStorage` (every access wrapped in try/catch) and
 * exported as a JSON file for `unsung feedback import`. While the server shows the examples,
 * decisions are kept in the browser too, never written to `data/`.
 */

import { labelFromFeedback, validateFeedback } from '../src/core/schema.mjs';
import { rebuildTaste, setPin } from '../src/core/taste.mjs';
import { foldFeedback, isNwo, overlayFeedback } from '../src/core/views.mjs';

/** @typedef {import('../src/core/schema.mjs').Index} Index */
/** @typedef {import('../src/core/schema.mjs').IndexEntry} IndexEntry */
/** @typedef {import('../src/core/schema.mjs').Feedback} Feedback */
/** @typedef {import('../src/core/schema.mjs').TasteState} TasteState */
/**
 * @typedef {{getItem(k: string): string | null, setItem(k: string, v: string): void,
 *   removeItem(k: string): void}} Storage
 */
/** @typedef {'unknown' | 'server' | 'examples' | 'static'} ApiMode */

/** `localStorage` keys: Pages copies and the examples keep separate histories. */
export const STORAGE_KEYS = Object.freeze({
  static: { events: 'unsung.feedback.v1', pins: 'unsung.pins.v1' },
  examples: { events: 'unsung.examples.feedback.v1', pins: 'unsung.examples.pins.v1' },
});

/** A failed API call; `status` is the HTTP status, or 0 when the server could not be reached. */
export class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status
   * @param {unknown} [problems]
   */
  constructor(message, status, problems) {
    super(message);
    this.name = 'ApiError';
    this.code = 'EAPI';
    this.status = status;
    this.problems = problems ?? null;
  }
}

/** @returns {Storage} storage that lives only as long as the page */
export function memoryStorage() {
  /** @type {Map<string, string>} */
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? /** @type {string} */ (m.get(k)) : null),
    setItem: (k, v) => {
      m.set(k, String(v));
    },
    removeItem: (k) => {
      m.delete(k);
    },
  };
}

/** @returns {Storage | null} the browser's localStorage, or null where it is blocked */
function browserStorage() {
  try {
    const s = /** @type {any} */ (globalThis).localStorage;
    if (!s) return null;
    s.getItem('unsung.probe');
    return s;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} s
 * @param {number} max
 * @returns {string | null}
 */
function str(s, max) {
  return typeof s === 'string' ? s.slice(0, max) : null;
}

/**
 * Turn a published gallery (`site/data/gallery.json`, §11.2) into an index the explorer can show:
 * every pick is a saved, published gem; its reasons become its reason lines and its signals its
 * chips.
 * @param {unknown} gallery
 * @returns {Index & {static: true}}
 */
export function indexFromGallery(gallery) {
  const g = /** @type {Record<string, any>} */ (gallery && typeof gallery === 'object' ? gallery : {});
  const list = Array.isArray(g.entries) ? g.entries : [];
  /** @type {IndexEntry[]} */
  const entries = list.filter((e) => e && isNwo(e.nwo)).map((e) => {
    const signals = Array.isArray(e.signals) ? e.signals : [];
    const S = signals.reduce((sum, x) => sum + (Number(x?.points) || 0), 0);
    const k = typeof e.confidence === 'number' ? e.confidence : 0;
    const lang = str(e.lang, 60);
    return /** @type {IndexEntry} */ ({
      id: `gallery:${e.nwo}`, nwo: e.nwo, description: str(e.description, 300), lang, topics: [],
      createdAt: null, pushedAt: null, ageDays: null,
      lane: k >= 0.5 ? 'proven' : 'promising', band: 'gem', S, pointsMax: Math.max(S, 1), coverage: 1,
      quality: typeof e.quality === 'number' ? e.quality : 0, k,
      kBand: k >= 0.6 ? 'high' : k >= 0.3 ? 'medium' : 'low', a: 0,
      gem: Math.round((S + 1.5 * k) * 100) / 100,
      stars: Number(e.starsNow ?? e.starsAtPublish ?? 0) || 0, forks: 0, gain4w: null, spark: null,
      chips: signals.map((x, i) => ({
        id: `gallery.${i}`, points: Number(x?.points) || 0, status: 'ok', hit: true,
        label: String(x?.label ?? ''),
      })),
      top: (Array.isArray(e.reasons) ? e.reasons : []).slice(0, 3).map(String),
      negatives: [], descriptors: [],
      gates: [], verdict: e.pitch ? { category: 'G', pitch: String(e.pitch).slice(0, 140), points: 0 } : null,
      facets: lang ? [`lang:${lang.toLowerCase().replace(/\s+/g, '-')}`] : [],
      feedback: { last: null, published: true, snoozeUntil: null }, headOid: null,
      note: str(e.note, 280) ?? '',
    });
  });
  return {
    v: 1, generatedAt: typeof g.generatedAt === 'string' ? g.generatedAt : '', static: true,
    model: { weights: null, calibration: null }, counts: {}, lastRun: null, entries,
  };
}

/**
 * Create the API client.
 * @param {object} [opts]
 * @param {(url: string, init?: any) => Promise<any>} [opts.fetch] default `globalThis.fetch`
 * @param {Storage | null} [opts.storage] default `localStorage`; null keeps everything in memory
 * @param {() => string} [opts.now] ISO time for events kept in the browser
 * @param {string} [opts.base] prefix for every path (default: relative to the page)
 */
export function createApi(opts = {}) {
  const g = /** @type {any} */ (globalThis);
  const doFetch = opts.fetch ?? (typeof g.fetch === 'function' ? g.fetch.bind(g) : null);
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;
  const now = opts.now ?? (() => new Date().toISOString());
  const base = opts.base ?? '';
  /** @type {ApiMode} */
  let mode = 'unknown';
  /** @type {(Index & {examples?: boolean, static?: boolean}) | null} */
  let lastIndex = null;
  /** @type {Record<string, string>} kept when storage refuses a write */
  const memory = {};
  let lastAt = 0;

  /**
   * @param {string} path
   * @param {any} [init]
   * @returns {Promise<any>}
   */
  async function request(path, init) {
    if (!doFetch) throw new ApiError('This browser cannot make requests', 0);
    /** @type {any} */
    let res;
    try {
      res = await doFetch(base + path, init);
    } catch {
      throw new ApiError('The explorer server could not be reached', 0);
    }
    const body = await res.text().catch(() => '');
    /** @type {any} */
    let json;
    try {
      json = body ? JSON.parse(body) : null;
    } catch {
      throw new ApiError(res.ok ? 'The server did not answer with JSON' : `Request failed (${res.status})`,
        res.ok ? -1 : res.status);
    }
    if (!res.ok) {
      const message = typeof json?.error === 'string' ? json.error : `Request failed (${res.status})`;
      throw new ApiError(message, res.status, json?.problems);
    }
    return json;
  }

  /** @param {string} path */
  const get = (path) => request(path, { headers: { accept: 'application/json' } });
  /**
   * @param {string} path
   * @param {unknown} body
   */
  const post = (path, body) => request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-unsung': '1', accept: 'application/json' },
    body: JSON.stringify(body),
  });

  const isLocal = () => mode === 'static' || mode === 'examples';
  const keys = () => (mode === 'examples' ? STORAGE_KEYS.examples : STORAGE_KEYS.static);

  /**
   * @param {string} key
   * @returns {string | null}
   */
  function readKey(key) {
    try {
      const v = storage ? storage.getItem(key) : null;
      if (v !== null && v !== undefined) return v;
    } catch {
      // Blocked storage falls back to memory.
    }
    return Object.hasOwn(memory, key) ? memory[key] : null;
  }

  /**
   * @param {string} key
   * @param {string} value
   */
  function writeKey(key, value) {
    memory[key] = value;
    try {
      if (storage) storage.setItem(key, value);
    } catch {
      // Kept in memory for this page only.
    }
  }

  /** @returns {{events: Feedback[], pins: Record<string, 1 | -1>}} */
  function readLocal() {
    /** @type {any} */
    let events = [];
    /** @type {any} */
    let pins = {};
    try {
      events = JSON.parse(readKey(keys().events) ?? '[]');
    } catch {
      events = [];
    }
    try {
      pins = JSON.parse(readKey(keys().pins) ?? '{}');
    } catch {
      pins = {};
    }
    return {
      events: Array.isArray(events) ? events.filter((e) => validateFeedback(e).length === 0) : [],
      pins: pins && typeof pins === 'object' && !Array.isArray(pins) ? pins : {},
    };
  }

  /** @returns {Map<string, IndexEntry>} */
  const entriesById = () => new Map((lastIndex?.entries ?? []).map((e) => [e.id, e]));

  /** @returns {string} a timestamp later than any this client has issued */
  function stamp() {
    let t = Date.parse(now());
    if (!Number.isFinite(t)) t = 0;
    if (t <= lastAt) t = lastAt + 1;
    lastAt = t;
    return new Date(t).toISOString();
  }

  /**
   * @param {Index & {examples?: boolean, static?: boolean}} idx
   * @returns {Index & {examples?: boolean, static?: boolean}}
   */
  function withLocal(idx) {
    return { ...idx, entries: overlayFeedback(idx.entries, foldFeedback(readLocal().events)) };
  }

  return {
    /** @returns {ApiMode} where data comes from: the server, the examples, or a static copy */
    get mode() {
      return mode;
    },

    /** @returns {Promise<Index & {examples?: boolean, static?: boolean}>} */
    async index() {
      try {
        const idx = await get('api/index');
        if (!idx || !Array.isArray(idx.entries)) throw new ApiError('The index is malformed', 500);
        mode = idx.examples ? 'examples' : 'server';
        lastIndex = mode === 'examples' ? withLocal(idx) : idx;
        return /** @type {any} */ (lastIndex);
      } catch (err) {
        const status = err instanceof ApiError ? err.status : 0;
        if (status !== 404 && status !== 0 && status !== -1 && status !== 405) throw err;
      }
      let gallery;
      try {
        gallery = await get('data/gallery.json');
      } catch {
        throw new ApiError(
          'No index to show: start the explorer with npm start, or open a published gallery', 404);
      }
      mode = 'static';
      lastIndex = withLocal(indexFromGallery(gallery));
      return lastIndex;
    },

    /**
     * The RepoRecord, or null when there is none (or on a static copy).
     * @param {string} nwo
     * @returns {Promise<any>}
     */
    async repo(nwo) {
      if (!isNwo(nwo)) throw new ApiError('Not a repository name', 400);
      if (mode === 'static') return null;
      try {
        return await get(`api/repo/${nwo.split('/').map(encodeURIComponent).join('/')}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },

    /**
     * Record a decision. The body is a Feedback without `v` and `at`; the answer carries the new
     * taste, the entry with its new queue state, and the stored event (whose `at` an undo names).
     * @param {Omit<Feedback, 'v' | 'at'>} body
     * @returns {Promise<{taste: TasteState, entry: IndexEntry | null, event: Feedback}>}
     */
    async feedback(body) {
      if (!isLocal()) return post('api/feedback', body);
      const { events, pins } = readLocal();
      /** @type {any} */
      const ev = { v: 1, at: stamp(), ...body };
      ev.label = ev.action === 'label' ? ev.label ?? null : labelFromFeedback(ev);
      const problems = validateFeedback(ev);
      if (problems.length > 0) {
        throw new ApiError(`That decision is not valid: ${problems[0]}`, 400, problems);
      }
      if (ev.action === 'undo' && !events.some((x) => x.id === ev.id && x.at === ev.undoes)) {
        throw new ApiError('There is nothing to undo', 409);
      }
      const next = [...events, ev];
      writeKey(keys().events, JSON.stringify(next));
      const byId = entriesById();
      const taste = rebuildTaste(next, byId, { pins, updatedAt: ev.at });
      const baseEntry = byId.get(ev.id);
      const fold = foldFeedback(next);
      const entry = baseEntry
        ? { ...baseEntry, feedback: fold[ev.id] ?? { last: null, published: false, snoozeUntil: null } }
        : null;
      if (lastIndex && entry) {
        lastIndex = { ...lastIndex, entries: lastIndex.entries.map((e) => (e.id === ev.id ? entry : e)) };
      }
      return { taste, entry, event: ev };
    },

    /** @returns {Promise<TasteState>} */
    async taste() {
      if (!isLocal()) return get('api/taste');
      const { events, pins } = readLocal();
      return rebuildTaste(events, entriesById(), { pins });
    },

    /**
     * Pin (1), mute (−1) or reset (0) a taste facet (§10.2 Taste).
     * @param {string} facet
     * @param {-1 | 0 | 1} pin
     * @returns {Promise<{taste: TasteState}>}
     */
    async pin(facet, pin) {
      if (!isLocal()) return post('api/taste', { facet, pin });
      const { events, pins } = readLocal();
      const nextPins = { ...pins };
      if (pin === 1 || pin === -1) nextPins[facet] = pin;
      else delete nextPins[facet];
      writeKey(keys().pins, JSON.stringify(nextPins));
      const taste = setPin(rebuildTaste(events, entriesById(), { pins: nextPins }), facet, pin, stamp());
      return { taste };
    },

    /** @returns {Promise<{weights: any, calibration: any}>} */
    async model() {
      if (mode === 'static') return { weights: null, calibration: null };
      return get('api/model');
    },

    /** @returns {Promise<any>} `{runs, units, lock, rate}` (§10.1) */
    async status() {
      if (mode === 'static') return { runs: [], units: {}, lock: null, rate: null, static: true };
      return get('api/status');
    },

    /**
     * Blind Calibrate items (§10.7). Without a seed the server draws the day's items; "Draw again"
     * passes a fresh seed so it gets others.
     * @param {number} [n]
     * @param {{seed?: number}} [opts]
     * @returns {Promise<{items: any[], seed?: number | null}>}
     */
    async calibrate(n = 20, { seed } = {}) {
      if (mode === 'static') return { items: [], seed: null };
      const count = Math.max(1, Math.min(50, Math.floor(n) || 20));
      const seedPart = typeof seed === 'number' && Number.isFinite(seed) ? `&seed=${seed >>> 0}` : '';
      return get(`api/calibrate?n=${count}${seedPart}`);
    },

    /**
     * Add a repository now (`POST /api/add`, §10.1).
     * @param {string} nwo
     * @returns {Promise<any>}
     */
    async add(nwo) {
      if (mode === 'static') {
        throw new ApiError('Adding a repository needs the local explorer (npm start)', 409);
      }
      if (!isNwo(nwo)) throw new ApiError('Write the repository as owner/name', 400);
      return post('api/add', { nwo });
    },

    /**
     * Decisions kept in this browser, as a file for `unsung feedback import` (§10.5).
     * @returns {{v: 1, kind: string, exportedAt: string, events: Feedback[], pins: Record<string, number>}}
     */
    exportFeedback() {
      const { events, pins } = readLocal();
      return { v: 1, kind: 'unsung-feedback', exportedAt: now(), events, pins };
    },

    /** @returns {Feedback[]} decisions kept in this browser */
    localEvents() {
      return readLocal().events;
    },
  };
}

/** @typedef {ReturnType<typeof createApi>} Api */
