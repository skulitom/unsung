// @ts-check
/**
 * The prefilter (DESIGN §3.4) and the hard gates (§7.2, §7.4). Pure: time comes in as `now`, owner
 * memory and per-owner counts come in as tables or functions.
 *
 * A gate is `{id, action, reason, evidence}` with action `quarantine`, `drop`, `doubt` or
 * `institutional`. Gate evidence never links to a suspicious file: it points at the repository page
 * and quotes the offending text (at most 120 characters), as §7.6 requires.
 */

import {
  archiveExtensions, binaryExtensions, drainerPhrases, fileHosts, gamblingWords, lureDirs, lureWords,
  passwordHint, personalNames, scriptLanguages, scriptPayloadExtensions,
} from './lexicons.mjs';
import { aiAddressed, commentImperatives, invisibleRun, links } from './readme.mjs';
import { daysBetween, truncateUtf8 } from './util.mjs';

/** @typedef {import('./schema.mjs').Facts} Facts */
/** @typedef {import('./schema.mjs').Gate} Gate */
/** @typedef {import('./schema.mjs').Signal} Signal */
/** @typedef {import('./schema.mjs').CandidateSeed} CandidateSeed */
/** @typedef {import('./schema.mjs').OwnerMemory} OwnerMemory */

/** Defaults of §3.4 and §9.3. */
export const PREFILTER_DEFAULTS = Object.freeze({
  maxStars: 25, ownerCapPerDay: 5, minDiskKB: 200, deferDays: 7,
});

const DAY_MS = 86_400_000;

/**
 * @typedef {((login: string) => (OwnerMemory | null | undefined))
 *   | Map<string, OwnerMemory> | Record<string, OwnerMemory> | null} OwnerTable
 */
/**
 * @typedef {((login: string) => (number | null | undefined))
 *   | Map<string, number> | Record<string, number> | null} CountTable
 */

/**
 * Look a login up in a function, Map or object (keys lower-case, or as given).
 * @template T
 * @param {((login: string) => (T | null | undefined)) | Map<string, T> | Record<string, T>
 *   | null | undefined} table
 * @param {string} login
 * @returns {T | null}
 */
function lookup(table, login) {
  if (!table || !login) return null;
  const lower = login.toLowerCase();
  if (typeof table === 'function') return table(login) ?? null;
  if (table instanceof Map) return table.get(lower) ?? table.get(login) ?? null;
  const record = /** @type {Record<string, T>} */ (table);
  return record[lower] ?? record[login] ?? null;
}

/**
 * @param {string} id
 * @param {'quarantine' | 'drop' | 'doubt' | 'institutional'} action
 * @param {string} reason
 * @param {Gate['evidence']} [evidence]
 * @returns {Gate}
 */
function gate(id, action, reason, evidence = []) {
  return { id, action, reason, evidence };
}

/**
 * @param {string} s
 * @param {number} [max]
 * @returns {string}
 */
function short(s, max = 120) {
  const clean = String(s).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}\u{2026}` : clean;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function size(bytes) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

/**
 * A repository name read as words (`photoshop-crack_2024` → `photoshop crack 2024`).
 * @param {string} name
 * @returns {string}
 */
function nameWords(name) {
  return String(name ?? '').replace(/[-_.]+/g, ' ');
}

/**
 * Distinct `lexicons.gamblingWords` in a text, matched as whole words (a plural `s` allowed).
 * @param {string} text
 * @returns {string[]}
 */
export function gamblingIn(text) {
  const tokens = new Set(String(text ?? '').toLowerCase().split(/[^a-z]+/).filter(Boolean));
  return gamblingWords.filter((w) => tokens.has(w) || tokens.has(`${w}s`));
}

/**
 * `g.lure.name`: the name, or the first 200 characters of the description, matches a lure word.
 * @param {string} nwo
 * @param {string} name
 * @param {string | null | undefined} description
 * @returns {Gate | null}
 */
function lureName(nwo, name, description) {
  const texts = [nameWords(name), String(description ?? '').slice(0, 200)];
  for (const re of lureWords) {
    for (const t of texts) {
      const m = re.exec(t);
      if (!m) continue;
      const evidence = [{ label: 'repository', url: `https://github.com/${nwo}`, quote: short(m[0]) }];
      const reason = `The name or description advertises "${short(m[0], 40)}"`;
      return gate('g.lure.name', 'quarantine', reason, evidence);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Prior and prefilter (§3.4)
// ---------------------------------------------------------------------------------------------

/**
 * The prior (§3.4): +1 licence, +1 description, +1 `diskUsage ≥ 1024`, +1 primary language,
 * +1 found through an archive `ReleaseEvent`. An integer 0–5 from free fields only.
 * @param {Partial<CandidateSeed> & {sources?: string[]}} seed
 * @returns {number}
 */
export function priorOf(seed) {
  let p = 0;
  if (seed?.licence) p++;
  const hasDesc = typeof seed?.hasDesc === 'boolean' ? seed.hasDesc
    : typeof seed?.description === 'string' && seed.description.trim() !== '';
  if (hasDesc) p++;
  if ((seed?.diskKB ?? 0) >= 1024) p++;
  if (seed?.lang) p++;
  const sources = [seed?.source, ...(Array.isArray(seed?.sources) ? seed.sources : [])];
  if (sources.some((s) => typeof s === 'string' && /^archive:.*:Release$/.test(s))) p++;
  return p;
}

/**
 * @typedef {object} PrefilterResult
 * @property {'queued' | 'deferred' | 'dropped' | 'quarantined'} state
 * @property {string | null} reason
 * @property {number} prior
 * @property {Gate[]} gates
 * @property {string | null} nextAt when a deferred candidate is looked at again
 */

/**
 * @typedef {object} PrefilterOptions
 * @property {string} [now] ISO time (required for repositories without a primary language)
 * @property {number} [maxStars] default 25
 * @property {OwnerTable} [ownerMemory] login → OwnerMemory (`farm` and `streak` drop the owner)
 * @property {CountTable} [ownerCounts] login → candidates from that owner already queued for the
 *   same created-day (callers process seeds in descending prior; see `prefilterAll`)
 * @property {number} [ownerCapPerDay] default 5
 */

/**
 * The §3.4 prefilter for one seed: rules in order, the first that matches decides.
 * @param {Partial<CandidateSeed> & {sources?: string[]}} seed
 * @param {PrefilterOptions} [opts]
 * @returns {PrefilterResult}
 */
export function prefilter(seed, opts = {}) {
  const maxStars = opts.maxStars ?? PREFILTER_DEFAULTS.maxStars;
  const cap = opts.ownerCapPerDay ?? PREFILTER_DEFAULTS.ownerCapPerDay;
  const prior = priorOf(seed);
  const nwo = String(seed?.nwo ?? '');
  const [owner = '', name = ''] = nwo.split('/');
  /**
   * @param {PrefilterResult['state']} state
   * @param {string | null} reason
   * @param {Gate[]} [gates]
   * @param {string | null} [nextAt]
   * @returns {PrefilterResult}
   */
  const res = (state, reason, gates = [], nextAt = null) => ({ state, reason, prior, gates, nextAt });

  if (seed?.isFork || seed?.isArchived || seed?.isTemplate || seed?.isMirror) {
    return res('dropped', 'excluded-kind');
  }
  if ((seed?.stars ?? 0) > maxStars) return res('dropped', 'attention');
  if ((seed?.diskKB ?? 0) < PREFILTER_DEFAULTS.minDiskKB) return res('dropped', 'too-small');
  const lowerName = name.toLowerCase();
  const profile = lowerName === owner.toLowerCase() || lowerName.endsWith('.github.io');
  if (profile || personalNames.includes(lowerName)) {
    return res('dropped', 'profile-or-site');
  }
  const lure = lureName(nwo, name, seed?.description);
  if (lure) return res('quarantined', 'lure-name', [lure]);
  const words = gamblingIn(`${nameWords(name)} ${seed?.description ?? ''}`);
  if (words.length >= 2) {
    const spam = gate('g.spam.words', 'drop', `Gambling words: ${words.join(', ')}`);
    return res('dropped', 'spam-words', [spam]);
  }
  const memory = lookup(opts.ownerMemory, owner);
  const flags = Array.isArray(memory?.flags) ? memory.flags : [];
  if (flags.includes('farm') || flags.includes('streak')) {
    const farm = flags.includes('farm');
    const remembered = gate(farm ? 'g.spam.farm' : 'g.spam.streak', 'drop',
      `The owner is remembered as a ${farm ? 'repository farm' : 'commit-streak farm'}`);
    return res('dropped', 'farm-owner', [remembered]);
  }
  if (!seed?.lang) {
    const created = Date.parse(String(seed?.createdAt ?? ''));
    const now = Date.parse(String(opts.now ?? ''));
    if (!Number.isFinite(now)) {
      throw new TypeError('prefilter needs now to judge a repository without a language');
    }
    const deferMs = PREFILTER_DEFAULTS.deferDays * DAY_MS;
    if (Number.isFinite(created) && now - created < deferMs) {
      const nextAt = new Date(created + deferMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
      return res('deferred', 'no-language-yet', [], nextAt);
    }
    return res('dropped', 'no-language');
  }
  if ((lookup(opts.ownerCounts, owner) ?? 0) >= cap) return res('dropped', 'owner-cap');
  return res('queued', null);
}

/**
 * The prefilter over a batch, applying the owner cap of rule 10 itself: among the seeds that would
 * be queued, at most `ownerCapPerDay` per owner and created-day survive, those with the highest
 * prior (then the newest). `opts.ownerCounts` adds candidates already queued by earlier batches.
 * Results are in input order.
 * @param {(Partial<CandidateSeed> & {sources?: string[]})[]} seeds
 * @param {PrefilterOptions} [opts]
 * @returns {PrefilterResult[]}
 */
export function prefilterAll(seeds, opts = {}) {
  const cap = opts.ownerCapPerDay ?? PREFILTER_DEFAULTS.ownerCapPerDay;
  const results = seeds.map((s) => prefilter(s, { ...opts, ownerCounts: null }));
  /** @type {Map<string, number[]>} */
  const groups = new Map();
  results.forEach((r, i) => {
    if (r.state !== 'queued') return;
    const owner = String(seeds[i].nwo ?? '').split('/')[0].toLowerCase();
    const key = `${owner}|${String(seeds[i].createdAt ?? '').slice(0, 10)}`;
    const list = groups.get(key) ?? [];
    list.push(i);
    groups.set(key, list);
  });
  for (const [key, idx] of groups) {
    const owner = key.split('|')[0];
    const already = lookup(opts.ownerCounts, owner) ?? 0;
    idx.sort((a, b) => (results[b].prior - results[a].prior)
      || (Date.parse(String(seeds[b].createdAt)) - Date.parse(String(seeds[a].createdAt)))
      || String(seeds[a].id).localeCompare(String(seeds[b].id)));
    for (const i of idx.slice(Math.max(0, cap - already))) {
      results[i] = { ...results[i], state: 'dropped', reason: 'owner-cap' };
    }
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// Gates (§7.2, §7.4)
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} p
 * @returns {string}
 */
function decodePath(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/**
 * @param {string} path
 * @param {readonly string[]} extensions
 * @returns {boolean}
 */
function hasExt(path, extensions) {
  const p = path.toLowerCase();
  return extensions.some((ext) => p.endsWith(ext));
}

/**
 * @param {Facts} f
 * @param {string | null | undefined} now
 * @returns {number | null} owner account age in days
 */
function ownerAge(f, now) {
  const created = f.ownerInfo?.createdAt;
  if (!created || !now) return null;
  const days = daysBetween(created, now);
  return Number.isFinite(days) ? days : null;
}

/**
 * @typedef {{kind: 'repo' | 'host', path: string | null, key: string, url: string}} LureCandidate
 */

/**
 * A README link that `g.lure.link` considers: an archive or executable stored in this repository
 * (a relative path, `raw.githubusercontent.com/<nwo>/…`, `github.com/<nwo>/(raw|blob)/…`), or a link
 * to a file host or shortener whose path or label names an archive or a download.
 * @param {{text: string, url: string}} link
 * @param {string} nwoLower
 * @returns {LureCandidate | null}
 */
function lureCandidate(link, nwoLower) {
  const raw = String(link.url ?? '').trim().replace(/^<|>$/g, '');
  if (!raw || raw.startsWith('#') || /^mailto:/i.test(raw)) return null;
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//');
  if (!absolute) {
    const path = decodePath(raw.replace(/[?#].*$/, '')).replace(/^(\.\/)+/, '').replace(/^\/+/, '');
    if (!hasExt(path, archiveExtensions)) return null;
    return { kind: 'repo', path, key: `repo:${path.toLowerCase()}`, url: raw };
  }
  /** @type {URL} */
  let u;
  try {
    u = new URL(raw.startsWith('//') ? `https:${raw}` : raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const segs = decodePath(u.pathname).split('/').filter(Boolean);
  const same = segs.length >= 2 && `${segs[0]}/${segs[1]}`.toLowerCase() === nwoLower;
  /** @type {string | null} */
  let inRepo = null;
  if (host === 'raw.githubusercontent.com' && same && segs.length >= 4) inRepo = segs.slice(3).join('/');
  if (host === 'github.com' && same && segs.length >= 5 && (segs[2] === 'raw' || segs[2] === 'blob')) {
    inRepo = segs.slice(4).join('/');
  }
  if (inRepo !== null) {
    if (!hasExt(inRepo, archiveExtensions)) return null;
    return { kind: 'repo', path: inRepo, key: `repo:${inRepo.toLowerCase()}`, url: raw };
  }
  if (!fileHosts.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  const p = decodePath(u.pathname).toLowerCase();
  const label = String(link.text ?? '').toLowerCase();
  const named = archiveExtensions
    .some((ext) => p.endsWith(ext) || p.includes(`${ext}/`) || label.includes(ext))
    || /\bdownload/.test(label);
  return named ? { kind: 'host', path: null, key: `url:${u.href.toLowerCase()}`, url: raw } : null;
}

/**
 * `g.lure.link` (§7.2).
 * @param {Facts} f
 * @param {string} text README text
 * @param {string | null | undefined} now
 * @returns {Gate | null}
 */
function lureLink(f, text, now) {
  const nwoLower = f.nwo.toLowerCase();
  const found = /** @type {LureCandidate[]} */ (links(text).map((l) => lureCandidate(l, nwoLower))
    .filter((c) => c !== null));
  if (!found.length) return null;
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const c of found) counts.set(c.key, (counts.get(c.key) ?? 0) + 1);
  const repeated = [...counts.values()].some((n) => n >= 3);
  const inDir = found.some((c) => c.kind === 'repo' && c.path !== null
    && c.path.split('/').slice(0, -1).some((d) => lureDirs.includes(d.toLowerCase())));
  const smallCode = typeof f.codeBytes === 'number' && f.codeBytes < 20_000;
  const age = ownerAge(f, now);
  const young = age !== null && age < 90;
  const password = passwordHint.test(text);
  if (!(inDir || smallCode || young || password || repeated)) return null;
  const why = [];
  if (repeated) why.push('the same file three or more times');
  if (inDir) why.push('stored under a tests, docs, assets, images or .github folder');
  if (smallCode) why.push('with under 20 KB of code');
  if (young) why.push('from an account under 90 days old');
  if (password) why.push('next to a password');
  const what = found.length === 1 ? 'an archive or executable' : `${found.length} archives or executables`;
  const url = `https://github.com/${f.nwo}`;
  const evidence = [...new Set(found.map((c) => c.url))].slice(0, 3)
    .map((u) => ({ label: 'README link (not followed)', url, quote: short(u) }));
  return gate('g.lure.link', 'quarantine', `The README links ${what}: ${why.join(', ')}`, evidence);
}

/**
 * `g.lure.script` (§7.2).
 * @param {Facts} f
 * @param {string | null | undefined} now
 * @returns {Gate | null}
 */
function lureScript(f, now) {
  const url = `https://github.com/${f.nwo}`;
  const lang = f.primaryLanguage;
  if (lang && scriptLanguages.includes(lang) && Array.isArray(f.languages)) {
    const bytes = f.languages.find((l) => l.name === lang)?.bytes ?? 0;
    if (bytes >= 1_000_000) return gate('g.lure.script', 'quarantine', `${size(bytes)} of ${lang}`);
  }
  const entries = Array.isArray(f.tree?.entries) ? f.tree.entries : [];
  const big = entries.find((e) => e[1] === 'blob' && typeof e[2] === 'number' && e[2] >= 1_000_000
    && hasExt(String(e[0]), scriptPayloadExtensions));
  if (big) {
    const evidence = [{ label: 'committed script (not opened)', url, quote: short(String(big[0])) }];
    const bytes = /** @type {number} */ (big[2]);
    return gate('g.lure.script', 'quarantine', `A ${size(bytes)} script is committed`, evidence);
  }
  const bin = entries.find((e) => e[1] === 'blob' && hasExt(String(e[0]), binaryExtensions));
  const age = ownerAge(f, now);
  if (bin && typeof f.codeBytes === 'number' && f.codeBytes < 20_000 && age !== null && age < 90) {
    const evidence = [{ label: 'committed executable (not opened)', url, quote: short(String(bin[0])) }];
    return gate('g.lure.script', 'quarantine',
      'A committed executable, little code and an account under 90 days old', evidence);
  }
  return null;
}

/**
 * `g.lure.drainer` (§7.2).
 * @param {Facts} f
 * @param {string} text
 * @param {string} desc
 * @returns {Gate | null}
 */
function lureDrainer(f, text, desc) {
  for (const re of drainerPhrases) {
    const m = re.exec(text) ?? re.exec(desc);
    if (!m) continue;
    const evidence = [{ label: 'README', url: `https://github.com/${f.nwo}`, quote: short(m[0]) }];
    return gate('g.lure.drainer', 'quarantine',
      'The README asks readers to send cryptocurrency or connect a wallet', evidence);
  }
  return null;
}

/**
 * `g.spam.words` (§7.2).
 * @param {Facts} f
 * @param {string} text
 * @param {string} desc
 * @returns {Gate | null}
 */
function spamWords(f, text, desc) {
  const nd = gamblingIn(`${nameWords(f.name)} ${desc}`);
  const all = gamblingIn(`${nameWords(f.name)} ${desc} ${truncateUtf8(text, 4096).text}`);
  if (nd.length < 2 && all.length < 3) return null;
  return gate('g.spam.words', 'drop', `Gambling words: ${(nd.length >= 2 ? nd : all).join(', ')}`);
}

/**
 * `g.spam.farm` (§7.2).
 * @param {Facts} f
 * @param {string | null | undefined} now
 * @returns {Gate | null}
 */
function spamFarm(f, now) {
  const o = f.ownerInfo;
  if (o?.type !== 'User' || typeof o.publicRepos !== 'number') return null;
  const n = o.publicRepos;
  if (n >= 1000) return gate('g.spam.farm', 'drop', `The owner has ${n} public repositories`);
  const age = ownerAge(f, now);
  if (n >= 200 && age !== null && age < 90) {
    return gate('g.spam.farm', 'drop',
      `The owner has ${n} public repositories on an account ${Math.floor(age)} days old`);
  }
  return null;
}

/**
 * `g.spam.streak` (§7.2).
 * @param {Facts} f
 * @returns {Gate | null}
 */
function spamStreak(f) {
  const total = f.commits?.total;
  if (typeof total !== 'number' || total < 500) return null;
  if (typeof f.codeBytes !== 'number' || f.codeBytes >= 10_000) return null;
  return gate('g.spam.streak', 'drop', `${total} commits over ${size(f.codeBytes)} of code`);
}

/**
 * `g.injection` (§7.2): doubt only; points never change.
 * @param {Facts} f
 * @param {string} text
 * @param {string} desc
 * @returns {Gate | null}
 */
function injection(f, text, desc) {
  const addressed = [...new Set([...aiAddressed(text), ...aiAddressed(desc)])];
  const comments = commentImperatives(text);
  const run = Math.max(invisibleRun(text), invisibleRun(desc));
  if (!addressed.length && !comments.length && run < 3) return null;
  const parts = [];
  if (addressed.length) parts.push('addresses an AI reviewer');
  if (comments.length) parts.push('gives instructions inside HTML comments');
  if (run >= 3) parts.push(`hides ${run} invisible characters in a row`);
  const url = `https://github.com/${f.nwo}`;
  const evidence = [...addressed, ...comments].slice(0, 3)
    .map((q) => ({ label: 'README', url, quote: short(q) }));
  return gate('g.injection', 'doubt',
    `The README ${parts.join(', ')}; the reviewer is disabled and points are unchanged`, evidence);
}

/**
 * `g.institutional` (§7.4): an organisation with at least `orgMinRepos` public repositories, or an
 * owner on `institutions.allow`; `deny` overrides both. `isVerified` is never read.
 * @param {Facts} f
 * @param {{allow?: string[], deny?: string[]} | null | undefined} institutions
 * @param {Record<string, any> | null | undefined} weights
 * @returns {Gate | null}
 */
function institutional(f, institutions, weights) {
  const login = String(f.ownerInfo?.login ?? f.owner ?? '').toLowerCase();
  const allow = new Set((institutions?.allow ?? []).map((x) => String(x).toLowerCase()));
  const deny = new Set((institutions?.deny ?? []).map((x) => String(x).toLowerCase()));
  if (!login || deny.has(login)) return null;
  if (allow.has(login)) {
    return gate('g.institutional', 'institutional', `${f.owner} is on the institutions list`);
  }
  const min = weights?.institutions?.orgMinRepos ?? 100;
  const o = f.ownerInfo;
  if (o?.type === 'Organization' && typeof o.publicRepos === 'number' && o.publicRepos >= min) {
    const reason = `An organisation with ${o.publicRepos} public repositories`;
    return gate('g.institutional', 'institutional', reason);
  }
  return null;
}

/**
 * The hard gates of §7.2 and §7.4 on Facts, in table order: `g.lure.name` (also checked here, so a
 * repository reaching enrich by `add` is judged too), `g.lure.link`, `g.lure.script`,
 * `g.lure.drainer`, `g.spam.words`, `g.spam.farm`, `g.spam.streak`, `g.injection`,
 * `g.institutional`. Owner-age conditions need `now`; without it they do not fire.
 * @param {Facts} facts
 * @param {Signal[] | null} [signals] unused today; kept for gates that read signals
 * @param {{institutions?: {allow?: string[], deny?: string[]} | null, now?: string | null,
 *   weights?: Record<string, any> | null}} [opts]
 * @returns {Gate[]}
 */
export function evaluateGates(facts, signals = null, opts = {}) {
  void signals;
  const f = facts;
  const text = typeof f.readme?.text === 'string' ? f.readme.text : '';
  const desc = typeof f.description === 'string' ? f.description : '';
  const now = opts.now ?? null;
  const found = [
    lureName(f.nwo, f.name, desc), lureLink(f, text, now), lureScript(f, now), lureDrainer(f, text, desc),
    spamWords(f, text, desc), spamFarm(f, now), spamStreak(f), injection(f, text, desc),
    institutional(f, opts.institutions, opts.weights),
  ];
  return /** @type {Gate[]} */ (found.filter((g) => g !== null));
}
