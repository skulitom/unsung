// @ts-check
/**
 * The static gallery (DESIGN §11.2): the repositories you vouched for and published, one page each,
 * an index filterable by language, an Atom feed of all picks and one per language family.
 *
 * A repository is exported only if all of these hold: its latest triage decision is `gem` and its
 * latest publishing decision is `publish`; it is at least 7 days old; it has never been
 * quarantined; no verdict carries `do_not_promote`; neither it nor its owner is in
 * `data/optout.json`; and a live re-check just found it public on GitHub. Everything else is
 * reported as skipped, with the reason.
 *
 * Output goes only to the export directory. Pages that an earlier export wrote and that are no
 * longer published (an opt-out, an unpublish) are removed, so a maintainer's request takes effect
 * on the next export. `data/gallery.json` lists the generated files for that purpose.
 */

import path from 'node:path';
import { repoPath } from '../core/schema.mjs';
import { daysBetween } from '../core/util.mjs';
import {
  cleanText, escapeAttr, escapeHtml, externalLink, formatDate, page, plural, safeUrl, siteLink,
} from './html.mjs';
import { repoUrl, supportLadder } from './support.mjs';
import { TAG_PREFIX, atomFeed, feedEntry, siteHref } from './feed.mjs';
import { copyAssets, readJsonInside, removeGenerated, writeFileAtomic } from './files.mjs';
import { recheckRepos } from './recheck.mjs';

/** @typedef {import('../core/schema.mjs').RepoRecord} RepoRecord */
/** @typedef {import('../core/schema.mjs').Feedback} Feedback */
/** @typedef {import('../core/schema.mjs').Verdict} Verdict */
/** @typedef {import('../core/schema.mjs').Score} Score */
/** @typedef {import('../core/schema.mjs').Signal} Signal */
/** @typedef {import('./recheck.mjs').LiveRepo} LiveRepo */
/** @typedef {import('./support.mjs').Rung} Rung */
/** @typedef {import('../log.mjs').Log} Log */
/** @typedef {import('../cli/context.mjs').Store} Store */
/** @typedef {import('../cli/context.mjs').Client} Client */

/** A pick must be at least this many days old (§11.2). */
export const MIN_AGE_DAYS = 7;

/** Default gallery title (§9.1). */
export const DEFAULT_TITLE = 'Unsung picks';

/** The order in which hit positive signals become a pick's reasons (§6.8 `top`). */
export const TOP_ORDER = Object.freeze([
  'q.release', 'p.testsRun', 'p.shipped', 'q.tests', 'q.examples', 'p.coherent', 'q.usage', 'q.ci',
  'q.manifest', 'q.deps', 'q.code', 'q.licence', 'q.readme',
]);

const TRIAGE = new Set(['gem', 'wip', 'notgood', 'notmine']);
const PUBLISHING = new Set(['publish', 'unpublish']);
const SCORING = new Set(['quality', 'proof', 'slop', 'judge']);

/** Generated files an export may later remove. */
const GENERATED_PAGE = /^r\/[^/]+\/[^/]+\/index\.html$/;
const GENERATED_FEED = /^feeds\/[a-z0-9-]+\.xml$/;

/** Language families for the per-language feeds (the primary languages of §5.2). */
const FAMILIES = [
  ['javascript', 'JavaScript and TypeScript', ['JavaScript', 'TypeScript', 'Vue', 'Svelte', 'Astro']],
  ['python', 'Python', ['Python', 'Jupyter Notebook']],
  ['rust', 'Rust', ['Rust']],
  ['go', 'Go', ['Go']],
  ['jvm', 'Java and the JVM', ['Java', 'Kotlin', 'Scala', 'Groovy', 'Clojure']],
  ['dotnet', '.NET', ['C#', 'F#', 'Visual Basic .NET']],
  ['c-cpp', 'C and C++', ['C', 'C++', 'Objective-C', 'CUDA']],
  ['ruby', 'Ruby', ['Ruby']],
  ['php', 'PHP', ['PHP']],
  ['swift', 'Swift', ['Swift']],
  ['dart', 'Dart', ['Dart']],
  ['beam', 'Elixir and Erlang', ['Elixir', 'Erlang']],
  ['haskell', 'Haskell', ['Haskell']],
];

/** A usage problem with the export (a bad URL, a missing opt-out address); the CLI exits 2. */
export class GalleryError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'GalleryError';
    this.code = 'EGALLERY';
    this.exitCode = 2;
  }
}

/**
 * One published pick as it appears in `site/data/gallery.json` (§11.2). The fields after
 * `confidence` are additions: `id` gives the Atom entry id, `page` the gem page URL relative to the
 * site root, and the rest feed the pages and the digest.
 * @typedef {object} GalleryEntry
 * @property {string} nwo current `owner/name`
 * @property {string} url the repository on GitHub
 * @property {string | null} description ≤ 300 characters
 * @property {string | null} lang primary language
 * @property {string | null} pitch from a valid verdict, ≤ 140 characters
 * @property {string} note the curator's note, ≤ 280 characters
 * @property {string} publishedAt
 * @property {number | null} starsAtPublish
 * @property {number | null} starsNow from the live re-check
 * @property {string[]} reasons ≤ 3, plain English
 * @property {{label: string, points: number}[]} signals the chips that sum to the points
 * @property {number | null} quality 0…1
 * @property {number | null} confidence K, 0…1
 * @property {string} id GraphQL node id
 * @property {string} page gem page, relative to the site root (`r/owner/name/`)
 * @property {string} family language family slug (`rust`, `javascript`, …)
 * @property {string} familyLabel language family name
 * @property {{label: string, url: string}[][]} evidence evidence links for each reason
 * @property {'low' | 'medium' | 'high' | null} confidenceBand
 * @property {number | null} points S
 * @property {number | null} pointsMax
 * @property {boolean} archived archived by its owner at the re-check
 * @property {string | null} headOid the scored commit
 */

/**
 * A repository that passed the local export checks (everything except the live re-check).
 * @typedef {object} Pick
 * @property {string} id
 * @property {string} nwo
 * @property {RepoRecord} record
 * @property {string} publishedAt time of the latest publish event
 * @property {string} note
 * @property {number | null} starsAtPublish
 */

/** @typedef {{nwo: string, reason: string}} Skip */

/**
 * @typedef {object} FeedbackState
 * @property {Feedback | null} triage the latest effective gem, wip, notgood or notmine event
 * @property {Feedback | null} publishing the latest effective publish or unpublish event
 * @property {Feedback | null} gem the latest effective gem event
 */

/**
 * The current time as an ISO string, from a function, a string, a number or nothing.
 * @param {unknown} now
 * @returns {string}
 */
export function resolveNow(now) {
  const v = typeof now === 'function' ? now() : now;
  if (v === undefined || v === null) return new Date().toISOString();
  const ms = v instanceof Date ? v.getTime() : typeof v === 'number' ? v : Date.parse(String(v));
  if (!Number.isFinite(ms)) throw new TypeError(`Not a valid time: ${String(v).slice(0, 40)}`);
  return new Date(ms).toISOString();
}

/**
 * Gather an array, an iterable, an async iterable or a promise of one into an array.
 * @param {unknown} source
 * @returns {Promise<any[]>}
 */
async function collect(source) {
  const s = await source;
  if (!s) return [];
  if (Array.isArray(s)) return s;
  const out = [];
  if (typeof (/** @type {any} */ (s))[Symbol.asyncIterator] === 'function'
    || typeof (/** @type {any} */ (s))[Symbol.iterator] === 'function') {
    for await (const x of /** @type {AsyncIterable<any>} */ (s)) out.push(x);
  }
  return out;
}

/**
 * Fold the feedback log into the current state of each repository (§10.4, §10.5). An `undo`
 * removes the event it names — matched by that event's `at` when `undoes` is a string, or by its
 * position in the log when it is a number — or, failing a match, the repository's latest event.
 * @param {Feedback[]} events in file order
 * @returns {Map<string, FeedbackState>}
 */
export function foldFeedback(events) {
  /** @type {Map<string, {ev: Feedback, index: number}[]>} */
  const effective = new Map();
  events.forEach((ev, index) => {
    if (!ev || typeof ev !== 'object' || typeof ev.id !== 'string') return;
    const list = effective.get(ev.id) ?? [];
    effective.set(ev.id, list);
    if (ev.action !== 'undo') {
      list.push({ ev, index });
      return;
    }
    let k = -1;
    if (typeof ev.undoes === 'string') k = list.findLastIndex((x) => x.ev.at === ev.undoes);
    else if (typeof ev.undoes === 'number') k = list.findLastIndex((x) => x.index === ev.undoes);
    if (k < 0) k = list.length - 1;
    if (k >= 0) list.splice(k, 1);
  });
  /** @type {Map<string, FeedbackState>} */
  const out = new Map();
  for (const [id, list] of effective) {
    /** @param {(a: string) => boolean} test */
    const last = (test) => list.findLast((x) => test(x.ev.action))?.ev ?? null;
    out.set(id, {
      triage: last((a) => TRIAGE.has(a)),
      publishing: last((a) => PUBLISHING.has(a)),
      gem: last((a) => a === 'gem'),
    });
  }
  return out;
}

/**
 * The §8.5 export rule, used when `src/core/verdict.mjs#verdictBlocksExport` is not supplied: any
 * verdict whose output carries the `do_not_promote` flag blocks export.
 * @param {Verdict | null | undefined} verdict
 * @returns {boolean}
 */
export function verdictCarriesDoNotPromote(verdict) {
  const flags = verdict?.output?.flags;
  return Array.isArray(flags) && flags.includes('do_not_promote');
}

/**
 * @typedef {{repos: Set<string>, owners: Set<string>}} OptOut
 */

/**
 * `data/optout.json` (`{v, repos: [], owners: []}`) as lower-cased sets; `repos` may hold
 * `owner/name` or node ids, `owners` logins. A missing file means nobody has opted out.
 * @param {unknown} value
 * @returns {OptOut}
 */
export function normaliseOptOut(value) {
  const v = /** @type {any} */ (value) ?? {};
  /** @param {unknown} list */
  const set = (list) => new Set((Array.isArray(list) ? list : [])
    .filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().toLowerCase()));
  return { repos: set(v.repos), owners: set(v.owners) };
}

/**
 * Whether a repository or its owner has opted out.
 * @param {OptOut} optout
 * @param {string | null | undefined} id
 * @param {string | null | undefined} nwo
 * @param {string | null} [owner] default the owner part of `nwo`
 * @returns {boolean}
 */
export function optedOut(optout, id, nwo, owner = null) {
  const lower = (/** @type {unknown} */ s) => (typeof s === 'string' ? s.toLowerCase() : '');
  const login = owner ?? (typeof nwo === 'string' ? nwo.split('/')[0] : null);
  return (id ? optout.repos.has(lower(id)) : false) || (nwo ? optout.repos.has(lower(nwo)) : false)
    || (login ? optout.owners.has(lower(login)) : false);
}

/**
 * Whether the record shows the repository was ever quarantined: its lane now, any gate, any lane in
 * its history, or its candidate state.
 * @param {RepoRecord} record
 * @returns {boolean}
 */
export function everQuarantined(record) {
  const r = /** @type {any} */ (record);
  if (r?.score?.lane === 'quarantine') return true;
  const gates = Array.isArray(r?.score?.gates) ? r.score.gates : [];
  if (gates.some((/** @type {any} */ g) => g?.action === 'quarantine')) return true;
  const history = Array.isArray(r?.history) ? r.history : [];
  if (history.some((/** @type {any} */ h) => h?.lane === 'quarantine')) return true;
  return r?.candidate?.state === 'quarantined' || r?.candidate?.result?.lane === 'quarantine';
}

/**
 * @param {RepoRecord} record
 * @param {string} at
 * @returns {number | null}
 */
function historyStarsAt(record, at) {
  const points = Array.isArray(record.history) ? record.history : [];
  const before = points.filter((h) => typeof h?.at === 'string' && h.at <= at && typeof h.stars === 'number');
  return before.length > 0 ? before[before.length - 1].stars : null;
}

/**
 * A record finder over the store: `getRepoById`, else `getRepo`, else one pass over `listRepos`.
 * @param {Store} store
 * @returns {(id: string, nwo: string | null) => Promise<RepoRecord | null>}
 */
function recordFinder(store) {
  /** @type {Map<string, RepoRecord> | null} */
  let all = null;
  return async (id, nwo) => {
    if (typeof store.getRepoById === 'function') {
      const r = await store.getRepoById(id);
      if (r) return r;
    }
    if (nwo && typeof store.getRepo === 'function') {
      const r = await store.getRepo(nwo);
      if (r && (!r.id || r.id === id)) return r;
    }
    if (typeof store.listRepos !== 'function') return null;
    if (all === null) {
      all = new Map();
      for (const r of await collect(store.listRepos())) if (r && typeof r.id === 'string') all.set(r.id, r);
    }
    return all.get(id) ?? null;
  };
}

/**
 * The repositories that pass every export check that needs no network (§11.2), newest publish
 * first. Published repositories that fail a check are appended to `skipped` with the reason.
 * @param {object} opts
 * @param {Store} opts.store `readFeedback`, `readOptOut`, and `getRepoById`, `getRepo` or `listRepos`
 * @param {unknown} [opts.now] ISO string, Date, milliseconds or a function returning one
 * @param {(verdict: Verdict | null | undefined) => boolean} [opts.blocksExport] default §8.5's rule
 * @param {Skip[]} [opts.skipped] receives the published repositories left out
 * @returns {Promise<Pick[]>}
 */
export async function eligiblePicks({ store, now, blocksExport = verdictCarriesDoNotPromote, skipped = [] }) {
  const nowIso = resolveNow(now);
  const states = foldFeedback(await collect(store.readFeedback()));
  const optout = normaliseOptOut(typeof store.readOptOut === 'function' ? await store.readOptOut() : null);
  const find = recordFinder(store);
  /** @type {Pick[]} */
  const picks = [];
  for (const [id, st] of states) {
    const pub = st.publishing;
    if (!pub || pub.action !== 'publish') continue;
    const hint = typeof pub.nwo === 'string' ? pub.nwo : null;
    if (st.triage?.action !== 'gem') {
      skipped.push({ nwo: hint ?? id, reason: 'no longer saved as a gem' });
      continue;
    }
    const record = await find(id, hint);
    if (!record) {
      skipped.push({ nwo: hint ?? id, reason: 'no stored record' });
      continue;
    }
    const nwo = String(record.nwo ?? hint);
    /** @param {string} reason */
    const skip = (reason) => skipped.push({ nwo, reason });
    if (!repoUrl(nwo)) {
      skip('not a valid owner/name');
      continue;
    }
    if (optedOut(optout, id, nwo)) {
      skip('opted out');
      continue;
    }
    const createdAt = record.facts?.createdAt ?? record.candidate?.createdAt ?? null;
    let age = -1;
    try {
      age = createdAt ? daysBetween(createdAt, nowIso) : -1;
    } catch {
      age = -1;
    }
    if (age < MIN_AGE_DAYS) {
      skip(`younger than ${MIN_AGE_DAYS} days`);
      continue;
    }
    if (everQuarantined(record)) {
      skip('was quarantined');
      continue;
    }
    if (blocksExport(record.verdict)) {
      skip('its review asked not to promote it');
      continue;
    }
    const note = cleanText(pub.note || st.gem?.note || '', { maxChars: 280 });
    const ctxStars = pub.context?.stars;
    const storedStars = typeof record.facts?.stars === 'number' ? record.facts.stars : null;
    const starsAtPublish = typeof ctxStars === 'number' ? ctxStars
      : historyStarsAt(record, pub.at) ?? storedStars;
    picks.push({ id, nwo, record, publishedAt: resolveNow(pub.at), note, starsAtPublish });
  }
  picks.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : a.publishedAt > b.publishedAt ? -1
    : a.nwo.localeCompare(b.nwo)));
  return picks;
}

/**
 * The language family of a primary language, for feeds and filters.
 * @param {string | null | undefined} lang
 * @returns {{slug: string, label: string}}
 */
export function languageFamily(lang) {
  if (typeof lang !== 'string' || lang.trim() === '') return { slug: 'other', label: 'Other' };
  const want = lang.trim().toLowerCase();
  for (const [slug, label, langs] of FAMILIES) {
    if (/** @type {string[]} */ (langs).some((l) => l.toLowerCase() === want)) {
      return { slug: /** @type {string} */ (slug), label: /** @type {string} */ (label) };
    }
  }
  const slug = want.replace(/\+/g, 'p').replace(/#/g, 'sharp').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 40) || 'other';
  return { slug, label: cleanText(lang, { singleLine: true, maxChars: 40 }) || 'Other' };
}

/**
 * The gem page's directory on disk, relative to the export directory (`r/<owner>/<name>`).
 * @param {string} nwo
 * @returns {string}
 */
export function pageDir(nwo) {
  return `r/${repoPath(nwo)}`;
}

/**
 * The gem page's URL relative to the site root, with every path segment percent-encoded.
 * @param {string} nwo
 * @returns {string}
 */
export function pageHref(nwo) {
  return `r/${repoPath(nwo).split('/').map(encodeURIComponent).join('/')}/`;
}

/**
 * @param {unknown} x
 * @returns {number | null}
 */
function round2(x) {
  return typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}

/**
 * @param {Signal} s
 * @returns {{label: string, url: string}[]}
 */
function evidenceOf(s) {
  const list = Array.isArray(s.evidence) ? s.evidence : [];
  /** @type {{label: string, url: string}[]} */
  const out = [];
  for (const e of list) {
    const url = safeUrl(e?.url);
    if (!url || new URL(url).hostname !== 'github.com') continue;
    out.push({ label: cleanText(e?.label, { singleLine: true, maxChars: 40 }) || 'evidence', url });
    if (out.length === 3) break;
  }
  return out;
}

/**
 * Up to three hit positive signals in §6.8's order, as `label: reason` with their evidence.
 * @param {Score | null} score
 * @returns {{text: string, evidence: {label: string, url: string}[]}[]}
 */
export function topReasons(score) {
  const byId = new Map((Array.isArray(score?.signals) ? score.signals : []).map((s) => [s.id, s]));
  /** @type {{text: string, evidence: {label: string, url: string}[]}[]} */
  const out = [];
  for (const id of TOP_ORDER) {
    const s = byId.get(id);
    if (!s || s.status !== 'ok' || s.hit !== true || !(Number(s.points ?? s.weight ?? 0) > 0)) continue;
    const label = cleanText(s.label, { singleLine: true, maxChars: 80 });
    const reason = cleanText(s.reason, { singleLine: true, maxChars: 160 });
    out.push({ text: reason ? `${label}: ${reason}` : label, evidence: evidenceOf(s) });
    if (out.length === 3) break;
  }
  return out;
}

/**
 * The chips that sum to the points (§6.1): every hit scoring signal with non-zero points, keeping
 * only the most negative within a group, in registry order.
 * @param {Score | null} score
 * @returns {{label: string, points: number}[]}
 */
export function pointChips(score) {
  const hits = (Array.isArray(score?.signals) ? score.signals : []).filter((s) => SCORING.has(s.kind)
    && s.status === 'ok' && s.hit === true && typeof s.points === 'number' && s.points !== 0);
  /** @type {Map<string, Signal>} */
  const worst = new Map();
  for (const s of hits) {
    if (!s.group) continue;
    const cur = worst.get(s.group);
    if (!cur || /** @type {number} */ (s.points) < /** @type {number} */ (cur.points)) worst.set(s.group, s);
  }
  return hits.filter((s) => !s.group || worst.get(s.group) === s)
    .map((s) => ({
      label: cleanText(s.label, { singleLine: true, maxChars: 80 }),
      points: /** @type {number} */ (s.points),
    }));
}

/**
 * Build the gallery entry for a pick from its record and the live re-check.
 * @param {Pick} pick
 * @param {LiveRepo | null} live
 * @returns {GalleryEntry}
 */
export function toGalleryEntry(pick, live) {
  const record = /** @type {any} */ (pick.record);
  const facts = record.facts ?? {};
  const score = record.score ?? null;
  const nwo = live?.nwo && repoUrl(live.nwo) ? live.nwo : pick.nwo;
  const lang = typeof facts.primaryLanguage === 'string' ? facts.primaryLanguage
    : typeof record.candidate?.lang === 'string' ? record.candidate.lang : null;
  const family = languageFamily(lang);
  const verdict = record.verdict;
  const rawPitch = verdict?.status === 'ok' ? verdict?.output?.pitch : null;
  const pitch = typeof rawPitch === 'string' ? cleanText(rawPitch, { singleLine: true, maxChars: 140 }) : '';
  const reasons = topReasons(score);
  return {
    nwo,
    url: /** @type {string} */ (repoUrl(nwo)),
    description: cleanText(facts.description ?? '', { singleLine: true, maxChars: 300 }) || null,
    lang,
    pitch: pitch || null,
    note: pick.note,
    publishedAt: pick.publishedAt,
    starsAtPublish: pick.starsAtPublish,
    starsNow: live?.stars ?? null,
    reasons: reasons.map((r) => r.text),
    signals: pointChips(score),
    quality: round2(score?.quality),
    confidence: round2(score?.confidence?.k),
    id: pick.id,
    page: pageHref(nwo),
    family: family.slug,
    familyLabel: family.label,
    evidence: reasons.map((r) => r.evidence),
    confidenceBand: score?.confidence?.band ?? null,
    points: typeof score?.S === 'number' ? score.S : null,
    pointsMax: typeof score?.pointsMax === 'number' ? score.pointsMax : null,
    archived: live?.archived === true,
    headOid: score?.headOid ?? facts.headOid ?? null,
  };
}

/**
 * A validated `--site-url`, ending in `/`, or null when none was given.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normaliseSiteUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  /** @type {URL} */
  let u;
  try {
    u = new URL(String(value));
  } catch {
    const got = String(value).slice(0, 80);
    throw new GalleryError(`--site-url must be a full URL, such as https://you.github.io/picks/ `
      + `(got '${got}')`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new GalleryError('--site-url must start with https:// (or http:// for a local preview)');
  }
  u.search = '';
  u.hash = '';
  if (!u.pathname.endsWith('/')) u.pathname = `${u.pathname}/`;
  return u.href;
}

/**
 * A validated `--issues-url`, or null when none was given.
 * @param {unknown} value
 * @returns {string | null}
 */
export function normaliseIssuesUrl(value) {
  if (value === undefined || value === null || value === '') return null;
  const safe = safeUrl(String(value));
  if (!safe) {
    throw new GalleryError('--issues-url must be an https:// address where maintainers can reach you');
  }
  return safe;
}

// ---------------------------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------------------------

const FOOTER = '<footer class="site"><p>Chosen by hand with Unsung, which only reads public repositories. '
  + 'It never stars, comments, opens issues or acts on anyone&#39;s behalf.</p></footer>';

/**
 * @param {number} n
 * @returns {string}
 */
function signed(n) {
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

/**
 * @param {GalleryEntry} e
 * @param {number} maxStars
 * @returns {string}
 */
function metaLine(e, maxStars) {
  /** @type {string[]} */
  const parts = [];
  if (e.lang) parts.push(escapeHtml(e.lang));
  const when = formatDate(e.publishedAt);
  if (when) parts.push(`featured <time datetime="${escapeAttr(e.publishedAt)}">${escapeHtml(when)}</time>`);
  const then = plural(e.starsAtPublish, 'star');
  const hasNow = typeof e.starsNow === 'number';
  parts.push(hasNow ? `${escapeHtml(then)} then, ${escapeHtml(String(e.starsNow))} now`
    : `${escapeHtml(then)} when featured`);
  if (hasNow && Number(e.starsNow) > maxStars) parts.push(`graduated: past ${maxStars} stars`);
  if (e.archived) parts.push('archived by its owner');
  return parts.join(' · ');
}

/**
 * @param {string} note
 * @returns {string}
 */
function noteHtml(note) {
  const paras = note.split(/\n{2,}/).map((p) => p.split('\n').map(escapeHtml).join('<br>'));
  const inner = paras.map((p) => `<p>${p}</p>`).join('');
  return `<figure class="note"><blockquote dir="auto">${inner}</blockquote>`
    + '<figcaption>The curator&#39;s note</figcaption></figure>';
}

/**
 * @param {GalleryEntry} e
 * @returns {string}
 */
function whySection(e) {
  const reasons = e.reasons.map((r, i) => {
    const ev = (e.evidence[i] ?? []).map((x) => externalLink(x.url, x.label)).join(', ');
    return `<li>${escapeHtml(r)}${ev ? ` <span class="evidence">(${ev})</span>` : ''}</li>`;
  });
  const q = typeof e.quality === 'number' ? ` · Quality ${Math.round(e.quality * 100)}` : '';
  const of = typeof e.pointsMax === 'number' ? ` of ${e.pointsMax}` : '';
  const pts = typeof e.points === 'number' ? `${e.points}${of} points${q}` : '';
  const conf = e.confidenceBand ? `Confidence ${e.confidenceBand}` : '';
  const chips = e.signals.map((s) => `<li class="${s.points > 0 ? 'pos' : 'neg'}">`
    + `${escapeHtml(signed(s.points))} ${escapeHtml(s.label)}</li>`);
  return [
    '<section class="why">',
    '<h2>Why it is here</h2>',
    reasons.length > 0 ? `<ul class="reasons">${reasons.join('')}</ul>` : '',
    pts || conf ? `<p class="meters"><span class="quality">${escapeHtml(pts)}</span>`
      + `${pts && conf ? ' · ' : ''}<span class="confidence">${escapeHtml(conf)}</span></p>` : '',
    chips.length > 0 ? `<ul class="chips">${chips.join('')}</ul>` : '',
    '<p class="small muted">Points come from evidence in the repository at the commit that was scored, '
      + 'never from stars. Quality estimates the share of genuine projects among hand-labelled '
      + 'repositories with as many points.</p>',
    '</section>',
  ].filter(Boolean).join('\n');
}

/**
 * @param {Rung} r
 * @returns {string}
 */
function rungHtml(r) {
  const muted = (/** @type {string} */ t) => ` <span class="small muted">${escapeHtml(t)}</span>`;
  switch (r.kind) {
    case 'try':
      return `<li><strong>Try it:</strong> <code>${escapeHtml(r.command)}</code>${muted(r.basis ?? '')}</li>`;
    case 'demo':
      return `<li><strong>Open the demo:</strong> ${externalLink(r.url, r.url ?? '', { ugc: true })}</li>`;
    case 'star':
      return `<li>${externalLink(r.url, 'Star it yourself')}`
        + `${muted('on GitHub. Unsung never stars anything for you.')}</li>`;
    case 'releases':
      return `<li>${externalLink(r.url, 'Follow releases')}${muted('(an Atom feed of its releases)')}</li>`;
    case 'feedback':
      return `<li>${externalLink(r.url, r.label)}${muted(r.note ?? '')}</li>`;
    case 'share':
      return `<li><strong>Share:</strong> ${externalLink(r.url, r.url ?? '')}</li>`;
    case 'sponsor':
      return `<li>${externalLink(r.url, r.label, { ugc: r.ugc === true })}</li>`;
    default:
      return '';
  }
}

/**
 * @param {string | null} issuesUrl
 * @returns {string}
 */
function optoutLine(issuesUrl) {
  if (!issuesUrl) return '';
  return `<p class="optout">Maintainer? Open an issue at ${externalLink(issuesUrl, issuesUrl)} `
    + 'and it will be removed.</p>';
}

/**
 * The page for one gem (§11.2).
 * @param {GalleryEntry} e
 * @param {RepoRecord} record
 * @param {{title: string, siteUrl: string | null, issuesUrl: string | null, maxStars: number}} opts
 * @returns {string}
 */
export function gemPage(e, record, { title, siteUrl, issuesUrl, maxStars }) {
  const base = '../../../';
  const pageUrl = siteUrl ? siteHref(e.page, siteUrl) : null;
  const ladder = supportLadder(record, { nwo: e.nwo, pageUrl });
  const body = [
    `<header class="site"><p class="brand">${siteLink(base, title)}</p></header>`,
    '<main class="gem">',
    `<p class="crumbs">${siteLink(base, 'All picks')}</p>`,
    `<h1>${externalLink(e.url, e.nwo)}</h1>`,
    e.description ? `<p class="description" dir="auto">${escapeHtml(e.description)}</p>` : '',
    `<p class="meta">${metaLine(e, maxStars)}</p>`,
    e.note ? noteHtml(e.note) : '',
    e.pitch ? `<p class="pitch" dir="auto">${escapeHtml(e.pitch)}</p>`
      + '<p class="small muted">This one-line pitch was written by an AI review and checked against '
      + 'quotes from the repository.</p>' : '',
    whySection(e),
    ladder.length > 0 ? `<section class="support"><h2>Support it</h2><ol class="ladder">`
      + `${ladder.map(rungHtml).join('')}</ol></section>` : '',
    optoutLine(issuesUrl),
    '</main>',
    FOOTER,
  ].filter(Boolean).join('\n');
  return page({
    title: `${e.nwo} · ${title}`,
    description: e.pitch || e.description || `${e.nwo}, a repository picked by hand.`,
    canonical: pageUrl,
    body,
    assetsBase: base,
    feeds: [{ title, href: `${base}feed.xml` }],
  });
}

/**
 * @param {GalleryEntry} e
 * @param {number} maxStars
 * @returns {string}
 */
function card(e, maxStars) {
  const note = e.note ? cleanText(e.note, { singleLine: true, maxChars: 200 }) : '';
  return [
    `<li class="card" data-family="${escapeAttr(e.family)}"`
      + ` data-family-label="${escapeAttr(e.familyLabel)}">`,
    `<h2>${siteLink(e.page, e.nwo)}</h2>`,
    e.description ? `<p class="description" dir="auto">${escapeHtml(e.description)}</p>` : '',
    e.pitch ? `<p class="pitch" dir="auto">${escapeHtml(e.pitch)}</p>` : '',
    note ? `<p class="note" dir="auto">${escapeHtml(note)}</p>` : '',
    `<p class="meta">${metaLine(e, maxStars)}</p>`,
    e.reasons.length > 0
      ? `<ul class="reasons">${e.reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '',
    '</li>',
  ].filter(Boolean).join('\n');
}

/**
 * The gallery index: every pick, newest first, with a language filter and the feeds.
 * @param {GalleryEntry[]} entries
 * @param {{title: string, siteUrl: string | null, issuesUrl: string | null, maxStars: number,
 *   families: {slug: string, label: string, count: number}[], generatedAt: string}} opts
 * @returns {string}
 */
export function indexPage(entries, { title, siteUrl, issuesUrl, maxStars, families, generatedAt }) {
  const feedLinks = families.map((f) => siteLink(`feeds/${f.slug}.xml`, f.label)).join(', ');
  const count = entries.length === 1 ? '1 pick' : `${entries.length} picks`;
  const list = entries.length > 0
    ? `<ol class="cards">\n${entries.map((e) => card(e, maxStars)).join('\n')}\n</ol>`
    : '<p class="empty">No picks are published yet. Save a gem in the explorer, press p to publish it '
      + 'with a note, then run <code>unsung export</code> again.</p>';
  const body = [
    '<header class="site">',
    `<h1>${escapeHtml(title)}</h1>`,
    '<p class="lede">Good repositories that almost nobody has noticed yet, chosen by hand. Each one '
      + 'earned its place with evidence (code that exists, tests that run, versions that shipped), '
      + 'never with stars.</p>',
    `<p class="small muted">${escapeHtml(count)} · updated ${escapeHtml(formatDate(generatedAt))}</p>`,
    `<p class="feeds">${siteLink('feed.xml', 'Atom feed of every pick')}`
      + `${feedLinks ? ` · by language: ${feedLinks}` : ''}</p>`,
    '</header>',
    '<main class="gallery">',
    '<nav class="filters" aria-label="Filter by language" hidden></nav>',
    list,
    optoutLine(issuesUrl),
    '</main>',
    FOOTER,
  ].join('\n');
  return page({
    title,
    description: 'Good repositories that almost nobody has noticed yet, chosen by hand.',
    canonical: siteUrl,
    body,
    assetsBase: '',
    scripts: ['assets/gallery.mjs'],
    feeds: [{ title, href: 'feed.xml' }],
  });
}

// ---------------------------------------------------------------------------------------------
// Building the site
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} BuildResult
 * @property {GalleryEntry[]} entries
 * @property {string[]} pages gem pages written, relative to the export directory
 * @property {string[]} feeds feeds written, relative to the export directory
 * @property {Skip[]} skipped published repositories left out, with the reason
 * @property {string[]} removed pages and feeds from an earlier export that were removed
 * @property {string} outDir absolute
 */

/** @typedef {{defaults?: {maxStars?: number}, weights?: {eligibility?: {maxStars?: number}}}} ExportConfig */

/**
 * @param {Store} store
 * @returns {Promise<OptOut>}
 */
async function readOptOut(store) {
  return normaliseOptOut(typeof store.readOptOut === 'function' ? await store.readOptOut() : null);
}

/**
 * Build the gallery into `outDir` (§11.2, §11.3). Only the export directory is written.
 * @param {object} opts
 * @param {Store} opts.store
 * @param {Client | (() => Promise<Client>) | null} opts.client used for the live re-check; a function
 *   is called only when there is something to re-check
 * @param {ExportConfig | null} [opts.config] only `maxStars` is read
 * @param {string} opts.outDir
 * @param {string | null} [opts.siteUrl] public URL of the site
 * @param {string | null} [opts.issuesUrl] where maintainers ask for removal; required when there are picks
 * @param {string} [opts.title]
 * @param {unknown} [opts.now]
 * @param {Log | null} [opts.log]
 * @param {(verdict: Verdict | null | undefined) => boolean} [opts.blocksExport]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<BuildResult>}
 */
export async function buildGallery({
  store, client, config = null, outDir, siteUrl = null, issuesUrl = null, title = DEFAULT_TITLE, now,
  log = null, blocksExport = verdictCarriesDoNotPromote, signal,
}) {
  const nowIso = resolveNow(now);
  const site = normaliseSiteUrl(siteUrl);
  const issues = normaliseIssuesUrl(issuesUrl);
  const heading = cleanText(title, { singleLine: true, maxChars: 120 }) || DEFAULT_TITLE;
  const maxStars = Number(config?.weights?.eligibility?.maxStars ?? config?.defaults?.maxStars ?? 25);
  /** @type {Skip[]} */
  const skipped = [];
  const picks = await eligiblePicks({ store, now: nowIso, blocksExport, skipped });
  if (picks.length > 0 && !issues) {
    throw new GalleryError('Set --issues-url to an address where maintainers can ask for their repository '
      + 'to be removed (for example the issues page of the repository that hosts your site)');
  }

  /** @type {Map<string, LiveRepo | null>} */
  let live = new Map();
  if (picks.length > 0) {
    const c = typeof client === 'function' ? await client() : client;
    live = await recheckRepos(/** @type {Client} */ (c), picks.map((p) => p.id), { signal });
  }
  const optout = await readOptOut(store);
  /** @type {GalleryEntry[]} */
  const entries = [];
  /** @type {Map<string, RepoRecord>} */
  const records = new Map();
  for (const pick of picks) {
    const now2 = live.get(pick.id) ?? null;
    if (!now2) {
      skipped.push({ nwo: pick.nwo, reason: 'gone from GitHub or no longer public' });
      continue;
    }
    if (optedOut(optout, pick.id, now2.nwo, now2.owner)) {
      skipped.push({ nwo: now2.nwo, reason: 'opted out' });
      continue;
    }
    entries.push(toGalleryEntry(pick, now2));
    records.set(pick.id, pick.record);
  }

  const root = path.resolve(outDir);
  const previous = readJsonInside(root, 'data/gallery.json', null);
  copyAssets(root);
  /** @type {string[]} */
  const pages = [];
  for (const e of entries) {
    const file = `${pageDir(e.nwo)}/index.html`;
    const html = gemPage(e, /** @type {RepoRecord} */ (records.get(e.id)), {
      title: heading, siteUrl: site, issuesUrl: issues, maxStars,
    });
    writeFileAtomic(root, file, html);
    pages.push(file);
  }

  /** @type {Map<string, {slug: string, label: string, entries: GalleryEntry[]}>} */
  const byFamily = new Map();
  for (const e of entries) {
    const f = byFamily.get(e.family) ?? { slug: e.family, label: e.familyLabel, entries: [] };
    f.entries.push(e);
    byFamily.set(e.family, f);
  }
  const families = [...byFamily.values()].sort((a, b) => b.entries.length - a.entries.length
    || a.label.localeCompare(b.label));
  const siteId = site ?? 'local/';
  const subtitle = 'Good repositories that almost nobody has noticed yet, chosen by hand.';
  const feeds = ['feed.xml'];
  writeFileAtomic(root, 'feed.xml', atomFeed({
    id: `${TAG_PREFIX}${siteId}`,
    title: heading,
    subtitle,
    selfUrl: siteHref('feed.xml', site),
    siteUrl: site ?? 'index.html',
    updated: entries[0]?.publishedAt ?? nowIso,
    entries: entries.map((e) => feedEntry(e, site)),
  }));
  for (const f of families) {
    const rel = `feeds/${f.slug}.xml`;
    writeFileAtomic(root, rel, atomFeed({
      id: `${TAG_PREFIX}${siteId}${rel}`,
      title: `${heading}: ${f.label}`,
      subtitle,
      selfUrl: siteHref(rel, site),
      siteUrl: site ?? '../index.html',
      author: heading,
      updated: f.entries[0]?.publishedAt ?? nowIso,
      entries: f.entries.map((e) => feedEntry(site ? e : { ...e, page: `../${e.page}` }, site)),
    }));
    feeds.push(rel);
  }

  writeFileAtomic(root, 'index.html', indexPage(entries, {
    title: heading, siteUrl: site, issuesUrl: issues, maxStars, generatedAt: nowIso,
    families: families.map((f) => ({ slug: f.slug, label: f.label, count: f.entries.length })),
  }));

  const generated = [...pages, ...feeds.filter((f) => f.startsWith('feeds/'))];
  const keep = new Set(generated);
  /** @type {string[]} */
  const removed = [];
  const old = Array.isArray(previous?.generated) ? previous.generated : [];
  for (const rel of old) {
    if (typeof rel !== 'string' || keep.has(rel)) continue;
    const isPage = GENERATED_PAGE.test(rel);
    if (!isPage && !GENERATED_FEED.test(rel)) continue;
    if (removeGenerated(root, rel, isPage ? 'r' : 'feeds')) removed.push(rel);
  }

  const gallery = { v: 1, generatedAt: nowIso, title: heading, siteUrl: site, entries, generated };
  writeFileAtomic(root, 'data/gallery.json', `${JSON.stringify(gallery, null, 2)}\n`);
  log?.debug?.('Gallery written', { out: root, entries: entries.length, removed: removed.length });
  return { entries, pages, feeds, skipped, removed, outDir: root };
}

/**
 * The export rule for verdicts: `verdictBlocksExport` from `src/core/verdict.mjs` (WP5) when that
 * module is present, combined with the §8.5 rule above so that either one can block; otherwise the
 * §8.5 rule alone. The importer is injectable for tests.
 * @param {() => Promise<any>} [importer]
 * @returns {Promise<(verdict: Verdict | null | undefined) => boolean>}
 */
export async function resolveBlocksExport(importer = () => import('../core/verdict.mjs')) {
  try {
    const mod = await importer();
    if (typeof mod?.verdictBlocksExport === 'function') {
      const real = mod.verdictBlocksExport;
      return (verdict) => (verdict ? Boolean(real(verdict)) || verdictCarriesDoNotPromote(verdict) : false);
    }
  } catch (err) {
    if (/** @type {{code?: string}} */ (err)?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
  }
  return verdictCarriesDoNotPromote;
}
