// @ts-check
/**
 * Stubs for the WP2 pipeline tests: every function the pipeline takes from WP1, WP3 and WP4, with
 * the signatures DESIGN §12 documents, plus a scripted GitHub client and a reference budget that
 * implements the shares of §3.8. The stubs are deliberately simple and explicit; the end-to-end
 * test (`test/e2e.test.mjs`) runs the real modules instead.
 *
 * This file is a helper: `node --test` loads it, and it only exports functions.
 */

import { fakeClock } from './clock.mjs';

/** @typedef {import('../../src/core/schema.mjs').CandidateSeed} CandidateSeed */

/**
 * A repository as the fake GitHub knows it. `S`, `gates`, `k` and `gain4w` steer the fake
 * scorer; `readme: null` with a `README.rst` root entry exercises the README repair.
 * @typedef {object} FakeRepo
 * @property {string} id
 * @property {string} nwo
 * @property {string} [createdAt]
 * @property {string} [pushedAt]
 * @property {number} [stars]
 * @property {number} [forks]
 * @property {number} [diskKB]
 * @property {string | null} [lang]
 * @property {string} [ownerType]
 * @property {string | null} [description]
 * @property {number} [S] points before deep (after deep: + deepBonus)
 * @property {number} [deepBonus] default 1
 * @property {{id: string, action: string, reason: string}[]} [gates]
 * @property {number} [k]
 * @property {number | null} [gain4w]
 * @property {any} [readme] null means no README.md
 * @property {{name: string, type: string}[]} [root]
 * @property {string[]} [workflows]
 * @property {boolean} [heavy] the GraphQL enrich of a batch holding it answers 502 (HeavyQueryError)
 * @property {boolean} [gone] NOT_FOUND
 */

/** @param {string} nwo */
const ownerOf = (nwo) => nwo.split('/')[0];

/** @param {string} message @returns {Error} */
const heavyError = (message) => Object.assign(new Error(message), {
  name: 'HeavyQueryError', code: 'EHEAVY',
});

/** Root manifests the fake `isManifest` recognises. */
const MANIFESTS = /^(package\.json|Cargo\.toml|go\.mod|pyproject\.toml)$/i;

/**
 * @param {FakeRepo} r
 * @param {string} [source]
 * @returns {CandidateSeed}
 */
export function seedOf(r, source = 'census:2026-09-08') {
  return {
    id: r.id,
    nwo: r.nwo,
    createdAt: r.createdAt ?? '2026-09-08T10:00:00Z',
    pushedAt: r.pushedAt ?? '2026-09-08T12:00:00Z',
    stars: r.stars ?? 0,
    forks: r.forks ?? 0,
    diskKB: r.diskKB ?? 800,
    lang: r.lang === undefined ? 'Rust' : r.lang,
    licence: 'MIT',
    hasDesc: true,
    description: r.description ?? 'A tool',
    ownerType: r.ownerType ?? 'User',
    isFork: false,
    isArchived: false,
    isTemplate: false,
    isMirror: false,
    source,
  };
}

/**
 * The enrich node the fake GitHub returns for a repository.
 * @param {FakeRepo} r
 * @returns {any}
 */
export function nodeOf(r) {
  return {
    id: r.id,
    nameWithOwner: r.nwo,
    description: r.description ?? 'A tool',
    createdAt: r.createdAt ?? '2026-09-08T10:00:00Z',
    pushedAt: r.pushedAt ?? '2026-09-08T12:00:00Z',
    diskUsage: r.diskKB ?? 800,
    stargazerCount: r.stars ?? 0,
    forkCount: r.forks ?? 0,
    primaryLanguage: r.lang === null ? null : { name: r.lang ?? 'Rust' },
    owner: { login: ownerOf(r.nwo), __typename: r.ownerType ?? 'User' },
    defaultBranchRef: { name: 'main', target: { oid: `oid-${r.id}` } },
    root: { entries: r.root ?? [{ name: 'src', type: 'tree' }, { name: 'Cargo.toml', type: 'blob' }] },
    wf: { entries: (r.workflows ?? ['ci.yml']).map((name) => ({ name })) },
    readme: r.readme === undefined ? { byteSize: 2000, isTruncated: false, text: '# Tool' } : r.readme,
    fake: {
      S: r.S ?? 7, deepBonus: r.deepBonus ?? 1, gates: r.gates ?? [], k: r.k ?? 0.2, gain4w: r.gain4w ?? null,
    },
  };
}

/**
 * @typedef {object} FakeGitHubOptions
 * @property {{advance?: (ms: number) => unknown, ms: () => number}} [clock] advanced by `ms` per call
 * @property {number} [ms] response time of every call
 * @property {number} [failAfter] every call after this one throws a generic error (a crash)
 * @property {{call: number, resumeAt: string}} [pauseOn] that call throws a RateLimitError
 * @property {{call: number, error: Error}} [errorOn] that call throws the given error
 * @property {(n: number) => void} [onCall] told the number of each call before it is answered
 */

/**
 * A GitHub client over a table of fake repositories. It answers the documents built by the fake
 * query builders below.
 * @param {FakeRepo[]} repos
 * @param {FakeGitHubOptions} [opts]
 */
export function fakeGitHub(repos, opts = {}) {
  const byNwo = new Map(repos.map((r) => [r.nwo.toLowerCase(), r]));
  const byId = new Map(repos.map((r) => [r.id, r]));
  const calls = /** @type {{kind: string, doc: string, variables: any}[]} */ ([]);
  const restCalls = /** @type {string[]} */ ([]);
  let n = 0;
  const ms = opts.ms ?? 0;
  const rateLimit = { cost: 1, remaining: 4000, resetAt: '2026-09-11T13:00:00Z' };
  /** @param {Record<string, any>} data */
  const answer = (data) => ({ data: { rateLimit, ...data }, errors: [], rateLimit, ms });

  const tick = () => {
    n++;
    opts.onCall?.(n);
    if (opts.errorOn && n === opts.errorOn.call) throw opts.errorOn.error;
    if (opts.failAfter !== undefined && n > opts.failAfter) throw new Error(`simulated crash on call ${n}`);
    if (opts.pauseOn && n === opts.pauseOn.call) {
      throw Object.assign(new Error('secondary rate limit'), {
        name: 'RateLimitError', code: 'ERATELIMIT', resumeAt: opts.pauseOn.resumeAt,
      });
    }
    if (ms > 0) opts.clock?.advance?.(ms);
  };

  /** @param {FakeRepo} r */
  const existsNode = (r) => ({
    id: r.id, stargazerCount: r.stars ?? 0, forkCount: r.forks ?? 0, pushedAt: r.pushedAt ?? null,
    isArchived: false, primaryLanguage: r.lang === null ? null : { name: r.lang ?? 'Rust' },
  });

  return {
    calls,
    restCalls,
    get count() {
      return n;
    },
    /**
     * @param {string} doc
     * @param {any} variables
     * @param {{kind?: string}} [o]
     */
    async graphql(doc, variables, o = {}) {
      tick();
      calls.push({ kind: o.kind ?? 'graphql', doc, variables });
      if (doc.startsWith('query search')) return answer({ search: { repositoryCount: 0, nodes: [] } });
      if (doc.startsWith('query exists')) {
        return answer({
          nodes: variables.ids.map((/** @type {string} */ id) => {
            const r = byId.get(id);
            return r && !r.gone ? existsNode(r) : null;
          }),
        });
      }
      if (doc.startsWith('query repair')) {
        /** @type {Record<string, any>} */
        const data = {};
        variables.items.forEach((/** @type {any} */ it, /** @type {number} */ i) => {
          data[`r${i}`] = { readme: { byteSize: 3000, isTruncated: false, text: `repaired ${it.file}` } };
        });
        return answer(data);
      }
      if (doc.startsWith('query files')) {
        /** @type {Record<string, any>} */
        const data = {};
        variables.items.forEach((/** @type {any} */ it, /** @type {number} */ i) => {
          /** @type {Record<string, any>} */
          const node = {};
          it.paths.forEach((/** @type {string} */ p, /** @type {number} */ j) => {
            node[`f${j}`] = { byteSize: 10, text: `text of ${p}` };
          });
          data[`r${i}`] = node;
        });
        return answer(data);
      }
      const m = /^query (Enrich|Deep|Lean)/.exec(doc);
      if (!m) throw new Error(`fake GitHub: unknown document ${doc.slice(0, 40)}`);
      /** @type {FakeRepo[]} */
      const found = variables.refs
        .map((/** @type {any} */ ref) => byNwo.get(`${ref.owner}/${ref.name}`.toLowerCase()));
      if (m[1] === 'Enrich' && found.some((r) => r?.heavy)) throw heavyError('HTTP 502');
      /** @type {Record<string, any>} */
      const data = {};
      found.forEach((r, i) => {
        if (!r || r.gone) data[`r${i}`] = null;
        else if (m[1] === 'Deep') {
          data[`r${i}`] = { fundingLinks: [], releases: { totalCount: 0, nodes: [] } };
        } else data[`r${i}`] = nodeOf(r);
      });
      return answer(data);
    },
    /** @param {string} path */
    async rest(path) {
      tick();
      restCalls.push(path);
      const m = /^\/repos\/([^/]+\/[^/]+)(\/.*)?$/.exec(path);
      const r = m ? byNwo.get(m[1].toLowerCase()) : undefined;
      if (!r || r.gone) throw Object.assign(new Error('Not Found'), { name: 'GitHubError', status: 404 });
      const sub = m?.[2] ?? '';
      /** @param {unknown} data @param {boolean} [notModified] */
      const ok = (data, notModified = false) => ({ status: 200, data, notModified, headers: {} });
      if (sub.startsWith('/git/trees/')) {
        return ok({ sha: 'tree', truncated: false, tree: [{ path: 'src/main.rs', type: 'blob', size: 10 }] });
      }
      if (sub.startsWith('/activity')) return ok([], true);
      if (sub.startsWith('/stargazers/history')) {
        return ok([{ week: 1788652800, total: r.gain4w ?? 0, days: [] }]);
      }
      return ok(nodeOf({ ...r, heavy: false }));
    },
  };
}

/**
 * The budget of §3.8, for tests: census ≤ 30 %, archive its own 5 % (plus what census left), enrich
 * until 85 % of the total is used, deep the rest. Null `graphqlMs` allows everything.
 * @param {{wallMs: number | null, graphqlMs: number | null,
 *   shares: {census: number, archive: number, enrichUntil: number}}} b
 */
export function referenceBudget({ graphqlMs, shares }) {
  /** @type {Record<string, number>} */
  const spent = { census: 0, archive: 0, enrich: 0, deep: 0 };
  const total = () => Object.values(spent).reduce((a, b) => a + b, 0);
  return {
    spent,
    /** @param {string} phase */
    allows(phase) {
      if (graphqlMs === null) return true;
      if (phase === 'census') return total() < shares.census * graphqlMs;
      if (phase === 'archive') {
        return total() < (shares.census + shares.archive) * graphqlMs
          || spent.archive < shares.archive * graphqlMs;
      }
      if (phase === 'enrich') return total() < shares.enrichUntil * graphqlMs;
      return total() < graphqlMs;
    },
    /**
     * @param {string} phase
     * @param {{ms: number, points?: number}} used
     */
    spend(phase, { ms }) {
      spent[phase] = (spent[phase] ?? 0) + ms;
    },
    exhausted: () => graphqlMs !== null && total() >= graphqlMs,
    snapshot: () => ({ ...spent }),
  };
}

/**
 * Census units for the fake `censusDay`: one unit per window, each fetched in `pages` search calls.
 * @typedef {{key: string, seeds: CandidateSeed[], pages?: number, saturated?: boolean}} FakeUnit
 */

/**
 * The fake prefilter: rules 1, 2, 3, 5 (any name containing "crack"), 8 and 9 of §3.4, and the prior.
 * @param {CandidateSeed} seed
 * @param {{now: string, maxStars: number}} o
 */
function fakePrefilter(seed, { now, maxStars }) {
  const prior = (seed.licence ? 1 : 0) + (seed.hasDesc ? 1 : 0) + (seed.diskKB >= 1024 ? 1 : 0)
    + (seed.lang ? 1 : 0)
    + (String(seed.source).endsWith(':Release') ? 1 : 0);
  const ageDays = (Date.parse(now) - Date.parse(seed.createdAt)) / 86_400_000;
  /**
   * @param {string} state
   * @param {string | null} reason
   * @param {string | null} [nextAt]
   */
  const res = (state, reason, nextAt = null) => ({ state, reason, prior, nextAt, gates: [] });
  if (seed.isFork || seed.isArchived) return res('dropped', 'excluded-kind');
  if (seed.stars > maxStars) return res('dropped', 'attention');
  if (seed.diskKB < 200) return res('dropped', 'too-small');
  if (/crack/i.test(seed.nwo)) return res('quarantined', 'lure-name');
  if (!seed.lang && ageDays < 7) {
    const nextAt = new Date(Date.parse(seed.createdAt) + 7 * 86_400_000).toISOString();
    return res('deferred', 'no-language-yet', nextAt);
  }
  if (!seed.lang) return res('dropped', 'no-language');
  return res('queued', null);
}

/**
 * The fake scorer: `S` from the node's `fake` block (+ deepBonus after deep, + the verdict's points),
 * bands, confidence, attention and the lanes of §6.7.
 * @param {any} facts
 * @param {{verdict?: any, now: string}} o
 */
function fakeScore(facts, { verdict, now }) {
  const fake = facts.fake ?? {};
  const deep = facts.stages?.includes('deep') ? (fake.deepBonus ?? 1) : 0;
  const S = (fake.S ?? 7) + deep + (verdict?.effect?.points ?? 0);
  const band = S >= 7 ? 'gem' : S >= 5 ? 'look' : 'low';
  const k = fake.k ?? 0.2;
  const stars = facts.stars ?? 0;
  const e = stars + (facts.forks ?? 0);
  const a = Math.log(1 + e) / Math.log(1 + Math.max(e, 25));
  const gain4w = fake.gain4w ?? null;
  const gates = (fake.gates ?? [])
    .map((/** @type {any} */ g) => ({ evidence: [], reason: g.reason ?? g.id, ...g }));
  /** @param {string} action */
  const has = (action) => gates.some((/** @type {any} */ g) => g.action === action);
  let lane = band === 'gem' ? (k >= 0.5 ? 'proven' : 'promising') : band === 'look' ? 'look' : 'low';
  if (has('doubt')) lane = 'doubted';
  if ((gain4w ?? 0) >= 10) lane = 'rising';
  if (stars > 25) lane = 'graduated';
  if (has('institutional')) lane = 'institutional';
  if (has('quarantine')) lane = 'quarantine';
  return {
    v: 1, id: facts.id, nwo: facts.nwo, headOid: facts.headOid, scoredAt: now,
    model: { weights: 'w1', calibration: 'c1', rubric: null },
    signals: [{
      id: 'q.licence', kind: 'quality', status: 'ok', hit: true, value: 'MIT', weight: 1, points: 1,
      strength: null, group: null, provisional: false, cost: 'cheap', label: 'Has a licence', reason: 'MIT',
      evidence: [],
    }],
    S, pointsMax: 13, coverage: 1, quality: 1 / (1 + Math.exp(-(-6.403 + 1.113 * S))), band,
    confidence: { k, band: k >= 0.6 ? 'high' : k >= 0.3 ? 'medium' : 'low', items: [] },
    attention: { stars, forks: facts.forks ?? 0, watchers: 0, gain4w, a }, gem: S + 1.5 * k - 1.5 * a, lane,
    gates, descriptors: [],
  };
}

/**
 * The fake `factsFromEnrich`: a valid Facts object carrying the node's `fake` block along.
 * @param {any} node
 * @param {{fetchedAt: string, readmeRepair?: any}} o
 */
function fakeFacts(node, { fetchedAt, readmeRepair }) {
  const [owner, name] = node.nameWithOwner.split('/');
  const readme = node.readme ?? readmeRepair ?? null;
  return {
    v: 1, id: node.id, nwo: node.nameWithOwner, owner, name, fetchedAt, source: 'graphql', stages: ['enrich'],
    headOid: node.defaultBranchRef?.target?.oid ?? null, defaultBranch: 'main', createdAt: node.createdAt,
    pushedAt: node.pushedAt, description: node.description ?? null, homepageUrl: null, isFork: false,
    isArchived: false, isTemplate: false, isMirror: false, hasIssues: true, hasDiscussions: false,
    stars: node.stargazerCount ?? 0, forks: node.forkCount ?? 0, watchers: 0, diskKB: node.diskUsage ?? 0,
    licence: 'MIT', primaryLanguage: node.primaryLanguage?.name ?? null, languages: [], codeBytes: 60000,
    topics: [], releases: { count: 0, recent: [] }, tags: 0,
    ownerInfo: { login: owner, type: node.owner?.__typename ?? 'User', createdAt: null, publicRepos: 10 },
    commits: { total: 5, recent: [] }, rollup: null, root: node.root?.entries ?? [],
    workflows: (node.wf?.entries ?? []).map((/** @type {any} */ e) => ({ name: e.name, text: null })),
    readme: readme
      ? {
        name: readme.name ?? 'README.md', bytes: readme.byteSize ?? 0, truncated: false,
        text: readme.text ?? '',
      }
      : null,
    packageJson: null, manifest: null, agentsMdBytes: null, claudeMdBytes: null, tree: null, activity: null,
    starHistory: null, outsiders: null, funding: null, heavy: false, fake: node.fake,
  };
}

/**
 * The stub functions. `units` maps a day to its census windows; `hours` maps `YYYY-MM-DD-H` to
 * archive seeds (and `sample` to the seeds of the ID walk).
 * @param {{units?: Record<string, FakeUnit[]>, hours?: Record<string, CandidateSeed[]>,
 *   days?: string[]}} [world]
 * @param {Record<string, any>} [overrides]
 */
export function fakeLib(world = {}, overrides = {}) {
  const units = world.units ?? {};
  const hours = world.hours ?? {};
  /** @param {{lang?: string | null, topic?: string | null} | string | null} scope */
  const scopeKey = (scope) => {
    if (!scope || typeof scope === 'string') return scope || 'all';
    const parts = [];
    if (scope.lang) parts.push(`lang=${scope.lang.toLowerCase()}`);
    if (scope.topic) parts.push(`topic=${scope.topic.toLowerCase()}`);
    return parts.length > 0 ? parts.join(',') : 'all';
  };
  /** @param {any} client @param {string} path */
  const restData = async (client, path) => (await client.rest(path)).data;
  return {
    ENRICH_FRAGMENT: 'fragment Enrich on Repository { id }',
    DEEP_FRAGMENT: 'fragment Deep on Repository { id }',
    /**
     * @param {string} fragmentName
     * @param {string} _fragment
     * @param {{owner: string, name: string}[]} refs
     */
    aliasedRepoQuery: (fragmentName, _fragment, refs) => ({
      doc: `query ${fragmentName} {}`, variables: { refs },
    }),
    readmeRepairQuery: (/** @type {any[]} */ items) => ({ doc: 'query repair {}', variables: { items } }),
    filesQuery: (/** @type {any[]} */ items) => ({ doc: 'query files {}', variables: { items } }),
    existsQuery: (/** @type {string[]} */ ids) => ({ doc: 'query exists {}', variables: { ids } }),
    /**
     * Batching with WP1's contract but no AIMD: build → client.graphql → parse; a HeavyQueryError
     * on a batch retries each item alone, then hands it to onHeavy.
     * @param {any[]} items
     * @param {any} o
     */
    async* runBatched(items, { client, build, parse, size, onHeavy }) {
      /** @param {any[]} batch */
      const once = async (batch) => {
        const { doc, variables } = build(batch);
        return parse(await client.graphql(doc, variables, { kind: 'graphql' }), batch);
      };
      for (let i = 0; i < items.length; i += size) {
        const batch = items.slice(i, i + size);
        try {
          const values = await once(batch);
          for (let j = 0; j < batch.length; j++) {
            yield { item: batch[j], value: values[j], error: null, heavy: false };
          }
        } catch (err) {
          if (/** @type {any} */ (err)?.name !== 'HeavyQueryError') throw err;
          for (const item of batch) {
            try {
              yield { item, value: (await once([item]))[0], error: null, heavy: false };
            } catch (e) {
              if (/** @type {any} */ (e)?.name !== 'HeavyQueryError') throw e;
              yield { item, value: onHeavy ? await onHeavy(item, e) : null, error: null, heavy: true };
            }
          }
        }
      }
    },
    factsFromEnrich: fakeFacts,
    /** @param {any} facts @param {any} deep @param {{fetchedAt: string}} o */
    mergeDeep(facts, deep, { fetchedAt }) {
      return {
        ...facts,
        fetchedAt,
        stages: ['enrich', 'deep'],
        deepHeadOid: facts.headOid,
        tree: deep.tree ? { truncated: false, count: deep.tree.tree?.length ?? 0, entries: [] } : null,
        workflows: (facts.workflows ?? []).map((/** @type {any} */ w) => ({
          ...w, text: deep.files?.[`.github/workflows/${w.name}`]?.text ?? null,
        })),
        deepSeen: {
          node: Boolean(deep.node), tree: Boolean(deep.tree), activity: deep.activity !== null,
          stars: deep.starHistory !== null, files: deep.files,
        },
      };
    },
    prefilter: fakePrefilter,
    priorOf: () => 2,
    isManifest: (/** @type {string} */ name) => MANIFESTS.test(name),
    scoreFacts: fakeScore,
    explain: (/** @type {any} */ score) => ({
      top: score.signals.filter((/** @type {any} */ s) => s.hit), negatives: [],
    }),
    verdictSignal: () => ({ points: 1 }),
    /** @param {any} client @param {string} nwo @param {string} sha */
    recursiveTree: (client, nwo, sha) => restData(client, `/repos/${nwo}/git/trees/${sha}?recursive=1`),
    /** @param {any} client @param {string} nwo */
    activity: (client, nwo) => restData(client, `/repos/${nwo}/activity?per_page=100`),
    /** @param {any} client @param {string} nwo */
    starHistory: (client, nwo) => restData(client, `/repos/${nwo}/stargazers/history?per_page=8`),
    /** @param {any} client @param {string} nwo */
    restFallback: (client, nwo) => restData(client, `/repos/${nwo}`),
    createBudget: referenceBudget,
    seedFromNode: (/** @type {any} */ node, /** @type {string} */ source) => ({ ...node, source }),
    passesBase: () => true,
    /** @param {{today: string, lagDays: number, backfillDays: number}} o */
    planDays({ today, lagDays, backfillDays }) {
      if (world.days) return world.days;
      const out = [];
      for (let i = 0; i <= backfillDays; i++) {
        out.push(new Date(Date.parse(today) - (lagDays + i) * 86_400_000).toISOString().slice(0, 10));
      }
      return out;
    },
    scopeKey,
    /**
     * Census units of a day, as WP1 does it: skip done ones, start, fetch `pages` search pages, yield
     * the seeds (carrying their `unit`), then mark the unit done when the consumer comes back.
     * @param {{client: any, day: string, scope: any, ledger: any, runId?: string}} o
     */
    async* censusDay({ client, day, scope, ledger, runId }) {
      for (const unit of units[day] ?? []) {
        const key = unit.key.replace(':all:', `:${scopeKey(scope)}:`);
        if (ledger.isDone(key)) continue;
        ledger.start(key, 'census', runId);
        const pages = unit.pages ?? 1;
        for (let p = 0; p < pages; p++) {
          await client.graphql('query search {}', { q: key, page: p }, { kind: 'search' });
        }
        const seeds = [...unit.seeds];
        const info = { key, pages, saturated: Boolean(unit.saturated) };
        Object.defineProperty(seeds, 'unit', { value: info, enumerable: false });
        yield seeds;
        ledger.done(key, { count: unit.seeds.length, pages, saturated: false, seeds: unit.seeds.length });
      }
    },
    /** @param {string} now @param {number} n */
    completeHours(now, n) {
      const out = [];
      let t = Math.floor((Date.parse(now) - 15 * 60_000) / 3_600_000) * 3_600_000 - 3_600_000;
      for (let i = 0; i < n; i++, t -= 3_600_000) {
        const d = new Date(t);
        out.push({ date: d.toISOString().slice(0, 10), hour: d.getUTCHours() });
      }
      return out;
    },
    /**
     * One archive hour, as WP1 does it: start, write the extract, look up, yield, then done.
     * @param {{client: any, date: string, hour: number, ledger: any, writeExtract: Function}} o
     */
    async* archiveHour({ client, date, hour, ledger, writeExtract }) {
      const name = `${date}-${hour}`;
      const key = `archive:${name}`;
      ledger.start(key, 'archive');
      const seeds = hours[name] ?? [];
      await writeExtract(date, hour, seeds.map((s) => ({
        type: 'ReleaseEvent', repoId: 1, nwo: s.nwo, actor: 'a', at: 'x', tag: 'v1', prerelease: false,
      })));
      if (seeds.length > 0) {
        const refs = seeds.map((s) => ({ owner: ownerOf(s.nwo), name: s.nwo.split('/')[1] }));
        await client.graphql('query Lean {}', { refs });
      }
      yield seeds;
      ledger.done(key, { events: seeds.length, seeds: seeds.length });
    },
    /** @param {{n: number}} o */
    sampleUniform: async ({ n }) => (world.hours?.sample ?? []).slice(0, n),
    ...overrides,
  };
}

/**
 * A configuration for tests: `defaults.json` as §9.3 states, and minimal weights and calibration.
 * @param {Record<string, any>} [defaultsOverride]
 */
export function testConfig(defaultsOverride = {}) {
  return {
    defaults: {
      version: 1,
      profiles: {
        quick: { budget: '10m', archiveHours: 3, deepTopN: 50, enrichMax: 1000, recheckTop: 100 },
        daily: { budget: null, archiveHours: 24, deepTopN: 400, enrichMax: 12000, recheckTop: 2000 },
      },
      lagDays: 3,
      backfillDays: 0,
      maxStars: 25,
      ownerCapPerDay: 5,
      explore: 0.05,
      queueTtlDays: 14,
      shares: { census: 0.3, archive: 0.05, enrichUntil: 0.85 },
      governor: { graphqlMsPerMin: 45000, restMsPerMin: 20000, searchGapMs: 2100, restConcurrency: 2 },
      batch: {
        enrich: { size: 12, min: 1, max: 20, targetMs: 6000 },
        deep: { size: 5, min: 1, max: 10, targetMs: 5000 },
        lookup: { size: 100, min: 10, max: 100, targetMs: 5000 },
      },
      caps: { readmeBytes: 32768, fileBytes: 16384, treeEntries: 5000, indexEntries: 20000 },
      server: { port: 8750 },
      llm: {
        backend: 'none', model: 'claude-opus-5', effort: 'high', maxUsd: 3, perCallUsd: 0.5,
        endpoint: 'https://api.anthropic.com', claudePath: null, fallbacks: true, prices: {},
      },
      ...defaultsOverride,
    },
    weights: {
      version: 'w1', signals: {}, confidence: {}, bands: { gem: 7, look: 5 },
      gem: { kWeight: 1.5, aWeight: 1.5 }, attention: { saturation: 25 },
      eligibility: { maxStars: 25, risingGain4w: 10 }, institutions: { orgMinRepos: 100 },
      confidenceBands: { medium: 0.3, high: 0.6 }, lanes: { provenK: 0.5 }, changelog: [],
    },
    calibration: {
      version: 'c1', method: 'platt', a: -6.403, b: 1.113, fittedOn: {}, fittedAt: '2026-09-11',
    },
    institutions: { version: 1, allow: [], deny: [] },
  };
}

/**
 * A fake clock whose sleeps complete by themselves (virtual time).
 * @param {string} [start]
 */
export function testClock(start = '2026-09-11T12:00:00Z') {
  return fakeClock(start, { auto: true });
}

/** A logger that records every line. */
export function recordingLog() {
  /** @type {{level: string, msg: string, fields?: any}[]} */
  const lines = [];
  /** @param {string} level */
  const at = (level) => (/** @type {string} */ msg, /** @type {any} */ fields) => {
    lines.push({ level, msg, fields });
  };
  return {
    lines,
    level: 'debug',
    enabled: () => true,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    /** @param {string} name @param {any} fields */
    stage: (name, fields) => {
      lines.push({ level: 'stage', msg: name, fields });
    },
  };
}
