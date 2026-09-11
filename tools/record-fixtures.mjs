// @ts-check
/**
 * Records live GitHub responses into the fixture format of DESIGN §14.2, using the §3 query
 * documents verbatim (`tools/lib/queries.mjs`) and its own minimal `fetch` code. Never run by
 * `npm test`. Usage:
 *
 *   node tools/record-fixtures.mjs --set seeds|hard|spam|named|labelled|<owner/name>… [--no-deep]
 *   node tools/record-fixtures.mjs --census [--day 2026-09-08]
 *   node tools/record-fixtures.mjs --samples [--archive <gharchive sample .json.gz>]
 *
 *   common: --out <fixtures dir>  --dry-run
 *           --max-search 25  --max-points 400  --max-rest 400   (hard budget; the run stops)
 *
 * `--set` enriches the repositories (12 per query, README repair when needed), writes
 * `repos/<owner>__<name>/enrich.json` and `meta.json` (`source: "recorded"`), and — unless
 * `--no-deep` — the deep-stage responses `deep.json`, `files.json`, `tree.json`,
 * `activity.json` and `stars.json` (stars only at ≥ 3 stars). A repository that no longer resolves
 * keeps its converted research snapshot and `meta.recording` says so. For a labelled repository
 * the research snapshot is preserved as `enrich.research.json`. The first response of each kind
 * is also stored whole under `github/graphql/` and `github/rest/`.
 *
 * `--census` records a normal census window (≤ 900 hits, paged to the end with crafted cursors)
 * and a window whose count exceeds 1,000, paged to the 1,000-result cap, under `search/`.
 * `--samples` records the re-check, archive-lookup and REST-fallback responses.
 *
 * Security: the token comes from GITHUB_TOKEN, GH_TOKEN or `gh auth token` (inside this process,
 * never printed), is sent only to api.github.com, and every line printed or file written passes
 * through `redact()`; a file that would contain a token is refused. Request headers are never
 * stored; response headers are kept from an allowlist. Nothing is cloned or downloaded from a
 * repository: its content is read only as text through the API.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  FIXTURES, TEXT_CAP, fixtureDirName, readJsonIf, readmeExcerpt, truncateUtf8, writeJson,
} from './lib/fixture-io.mjs';
import { NAMED_SETS, SET_ALIASES, expectFor, setOf } from './lib/named-sets.mjs';
import {
  DEEP_FRAGMENT, ENRICH_FRAGMENT, EXISTS_QUERY, LEAN_FRAGMENT, SEARCH_QUERY, aliasedRepoQuery, cursor,
  filesQuery, readmeRepairQuery, refOf, searchString,
} from './lib/queries.mjs';

const API = 'https://api.github.com';
const UA = 'unsung/0.1.0 (+local; read-only)';
const API_VERSION = '2026-03-10';
const SEARCH_GAP_MS = 2500;
const TREE_CAP = 5000;
const TOKEN_PATTERN = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const KEEP_HEADERS = new Set([
  'content-type', 'date', 'etag', 'last-modified', 'link', 'retry-after', 'x-github-api-version-selected',
  'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-resource',
  'x-ratelimit-used',
]);
const DEEP_FILES = ['deep.json', 'files.json', 'tree.json', 'activity.json', 'stars.json'];
/** §5.2 root manifests in table order, `package.json` excluded (enrich already has it). */
const MANIFESTS = [
  'deno.json', 'deno.jsonc', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile',
  'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'build.sbt', 'project.clj',
  'deps.edn',
  '*.csproj', '*.fsproj', '*.sln', 'CMakeLists.txt', 'Makefile', 'GNUmakefile', 'meson.build', 'configure.ac',
  'xmake.lua', 'vcpkg.json', 'conanfile.txt', 'conanfile.py', 'Gemfile', '*.gemspec', 'composer.json',
  'Package.swift', 'pubspec.yaml', 'mix.exs', 'rebar.config', '*.cabal', 'stack.yaml', 'cabal.project',
  'build.zig', 'justfile', 'flake.nix', 'cjpm.toml', 'gleam.toml', 'shard.yml', 'v.mod', 'dune-project',
  'platformio.ini',
];

/** @type {string[]} */
const secrets = [];

/**
 * Replace every registered secret and anything shaped like a GitHub token (§3.9).
 * @param {unknown} text
 * @returns {string}
 */
export function redact(text) {
  let s = String(text);
  for (const t of secrets) if (t) s = s.split(t).join('[REDACTED]');
  return s.replace(TOKEN_PATTERN, '[REDACTED]');
}

/**
 * @param {string} msg
 */
function log(msg) {
  process.stdout.write(`${redact(msg)}\n`);
}

/**
 * The token, from the environment or `gh auth token`, registered for redaction.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string}
 */
function getToken(env) {
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN']) {
    const v = (env[k] ?? '').trim();
    if (v) {
      secrets.push(v);
      return v;
    }
  }
  let token;
  try {
    token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 5000,
    }).trim();
  } catch (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code;
    throw new Error(code === 'ENOENT'
      ? 'Install GitHub CLI or set GITHUB_TOKEN'
      : 'Run `gh auth login` first');
  }
  if (!token) throw new Error('`gh auth token` printed nothing; run `gh auth login` first');
  secrets.push(token);
  return token;
}

/**
 * Write a fixture file, refusing any content that would carry a token.
 * @param {string} file
 * @param {unknown} value
 * @param {{compact?: boolean}} [opts]
 */
function writeFixture(file, value, opts) {
  const text = JSON.stringify(value);
  if (redact(text) !== text) {
    throw new Error(`Refusing to write ${path.basename(file)}: it would contain a token`);
  }
  writeJson(file, value, opts);
}

/**
 * @typedef {{search: number, points: number, rest: number}} Limits
 */

/**
 * A hard budget: exceeding a limit throws and stops the run.
 * @param {Limits} limits
 */
function createBudget(limits) {
  const used = { search: 0, points: 0, rest: 0 };
  return {
    used,
    /** @param {'search' | 'rest'} kind */
    take(kind) {
      if (used[kind] + 1 > limits[kind]) throw new Error(`Budget exhausted: ${kind} (${limits[kind]})`);
      used[kind]++;
    },
    reservePoint() {
      if (used.points + 1 > limits.points) {
        throw new Error(`Budget exhausted: GraphQL points (${limits.points})`);
      }
    },
    /** @param {number} n */
    spendPoints(n) {
      used.points += n;
    },
  };
}

/**
 * Allowlisted response headers (never request headers, so never Authorization).
 * @param {Headers} headers
 * @returns {Record<string, string>}
 */
function keepHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of headers) if (KEEP_HEADERS.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  return out;
}

/**
 * @typedef {{request: {query: string, variables: Record<string, unknown>}, status: number,
 *   headers: Record<string, string>, body: any}} GraphqlEnvelope
 * @typedef {{request: {path: string}, status: number, headers: Record<string, string>,
 *   body: any}} RestEnvelope
 */

/**
 * Minimal read-only HTTP client for recording.
 * @param {{token: string, budget: ReturnType<typeof createBudget>, fetchImpl?: typeof fetch}} opts
 */
function createHttp({ token, budget, fetchImpl = fetch }) {
  let lastSearch = 0;
  /** @param {number} ms */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * @param {string} query
   * @param {Record<string, unknown>} variables
   * @param {{search?: boolean}} [opts]
   * @returns {Promise<GraphqlEnvelope>}
   */
  async function graphql(query, variables, opts = {}) {
    if (!/^\s*(query\b|\{)/.test(query)) throw new Error('Refusing a GraphQL document that is not a query');
    for (let attempt = 0; ; attempt++) {
      if (opts.search) {
        budget.take('search');
        const wait = lastSearch + SEARCH_GAP_MS - Date.now();
        if (wait > 0) await sleep(wait);
      }
      budget.reservePoint();
      /** @type {Response} */
      let res;
      try {
        res = await fetchImpl(`${API}/graphql`, {
          method: 'POST',
          headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': UA },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(60_000),
        });
      } catch (err) {
        lastSearch = opts.search ? Date.now() : lastSearch;
        budget.spendPoints(1);
        if (attempt < 2) {
          log(`  network error (${redact(/** @type {Error} */ (err).message)}); retrying`);
          await sleep(5000 * (attempt + 1));
          continue;
        }
        throw new Error(`GraphQL request failed: ${redact(/** @type {Error} */ (err).message)}`);
      }
      if (opts.search) lastSearch = Date.now();
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = { unparsed: redact(text.slice(0, 300)) };
      }
      budget.spendPoints(body?.data?.rateLimit?.cost ?? 1);
      if ((res.status === 502 || res.status === 504) && attempt < 2) {
        log(`  GraphQL ${res.status}; retrying`);
        await sleep(5000 * (attempt + 1));
        continue;
      }
      if (res.status === 401) throw new Error('GitHub refused the token (401)');
      if (res.status === 403 || res.status === 429) {
        throw new Error(`GitHub rate-limited the recorder (${res.status}); stop and try later`);
      }
      return { request: { query, variables }, status: res.status, headers: keepHeaders(res.headers), body };
    }
  }

  /**
   * @param {string} p path under https://api.github.com, starting with `/`
   * @param {{ifNoneMatch?: string}} [opts]
   * @returns {Promise<RestEnvelope>}
   */
  async function rest(p, opts = {}) {
    for (let attempt = 0; ; attempt++) {
      budget.take('rest');
      /** @type {Record<string, string>} */
      const headers = {
        authorization: `bearer ${token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION, 'user-agent': UA,
      };
      if (opts.ifNoneMatch) headers['if-none-match'] = opts.ifNoneMatch;
      /** @type {Response} */
      let res;
      try {
        res = await fetchImpl(`${API}${p}`, { method: 'GET', headers, signal: AbortSignal.timeout(60_000) });
      } catch (err) {
        if (attempt < 2) {
          await sleep(attempt ? 8000 : 2000);
          continue;
        }
        throw new Error(`REST ${p} failed: ${redact(/** @type {Error} */ (err).message)}`);
      }
      const text = await res.text();
      if (res.status >= 500 && attempt < 2) {
        await sleep(attempt ? 8000 : 2000);
        continue;
      }
      if (res.status === 401) throw new Error('GitHub refused the token (401)');
      if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
        throw new Error(`GitHub rate-limited the recorder (${res.status}); stop and try later`);
      }
      let body = null;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { unparsed: redact(text.slice(0, 300)) };
        }
      }
      return { request: { path: p }, status: res.status, headers: keepHeaders(res.headers), body };
    }
  }
  return { graphql, rest };
}

/**
 * @template T
 * @param {T[]} arr
 * @param {number} n
 * @returns {T[][]}
 */
function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Cap README-like blob text in place; returns the excerpt summary.
 * @param {any} blob `{byteSize, isTruncated?, text}`
 */
function capReadmeBlob(blob) {
  if (!blob || typeof blob.text !== 'string') return null;
  const ex = readmeExcerpt(blob.text);
  blob.text = ex.text;
  return ex;
}

/**
 * Apply the fixture text caps to an enrich node in place (README 8 KB excerpt, package.json 16 KB).
 * @param {any} node
 */
function capEnrichNode(node) {
  const readme = capReadmeBlob(node.readme);
  if (node.pkg && typeof node.pkg.text === 'string') {
    node.pkg.text = truncateUtf8(node.pkg.text, TEXT_CAP).text;
  }
  return readme;
}

/**
 * Workflow files and manifest to fetch for the deep stage (§3.6 step 5).
 * @param {any} node enrich node
 * @returns {string[]}
 */
export function deepFilePaths(node) {
  const wf = (node.wf?.entries ?? []).map((/** @type {any} */ e) => e.name)
    .filter((/** @type {string} */ n) => /\.ya?ml$/i.test(n));
  const preferred = wf.filter((/** @type {string} */ n) => /test|ci|build|check/i.test(n));
  const rest = wf.filter((/** @type {string} */ n) => !/test|ci|build|check/i.test(n));
  const paths = [...preferred, ...rest].slice(0, 3).map((n) => `.github/workflows/${n}`);
  const blobs = (node.root?.entries ?? []).filter((/** @type {any} */ e) => e.type === 'blob')
    .map((/** @type {any} */ e) => e.name);
  for (const m of MANIFESTS) {
    const hit = m.startsWith('*.')
      ? blobs.find((/** @type {string} */ b) => b.toLowerCase().endsWith(m.slice(1).toLowerCase()))
      : blobs.find((/** @type {string} */ b) => b.toLowerCase() === m.toLowerCase());
    if (hit) {
      paths.push(hit);
      break;
    }
  }
  return paths;
}

/**
 * Slim a recursive tree body to `{sha, truncated, tree: [{path, type, size?}]}`, ≤ 5,000 entries.
 * @param {any} body
 */
function slimTree(body) {
  const all = Array.isArray(body?.tree) ? body.tree : [];
  return {
    sha: body?.sha ?? null,
    truncated: Boolean(body?.truncated),
    tree: all.slice(0, TREE_CAP).map((/** @type {any} */ e) => (e.type === 'blob'
      ? { path: e.path, type: e.type, size: e.size }
      : { path: e.path, type: e.type })),
  };
}

/**
 * Slim activity entries to the fields §3.6 reads.
 * @param {any} body
 */
function slimActivity(body) {
  if (!Array.isArray(body)) return body;
  return body.map((e) => ({ id: e.id, ref: e.ref, timestamp: e.timestamp, activity_type: e.activity_type }));
}

/**
 * Store an envelope without anything but its four documented keys.
 * @param {string} out
 * @param {string} rel
 * @param {GraphqlEnvelope | RestEnvelope} env
 */
function saveEnvelope(out, rel, env) {
  const { request, status, headers, body } = env;
  writeFixture(path.join(out, rel), { request, status, headers, body });
  log(`  saved ${rel}`);
}

/**
 * Keep the research snapshot of a labelled repository before recording over it.
 * @param {string} dir
 * @param {any} prior previous meta.json or null
 */
function preserveResearch(dir, prior) {
  const enrich = path.join(dir, 'enrich.json');
  const research = path.join(dir, 'enrich.research.json');
  if (prior?.source === 'research' && prior.label && fs.existsSync(enrich)) {
    fs.renameSync(enrich, research);
  }
  return fs.existsSync(research) ? 'enrich.research.json' : null;
}

/**
 * Meta fields carried over from a research fixture.
 * @param {any} prior
 */
function researchFields(prior) {
  if (!prior) return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of ['label', 'stratum', 'sample']) if (prior[k] !== undefined) out[k] = prior[k];
  if (prior.source === 'research') {
    out.researchRecordedAt = prior.recordedAt ?? null;
    if (prior.readme !== undefined) out.researchReadme = prior.readme;
  } else {
    if (prior.researchRecordedAt !== undefined) out.researchRecordedAt = prior.researchRecordedAt;
    if (prior.researchReadme !== undefined) out.researchReadme = prior.researchReadme;
  }
  return out;
}

/**
 * Record enrich (and deep) responses for a list of repositories.
 * @param {string[]} nwos
 * @param {{http: ReturnType<typeof createHttp>, out: string, recordedAt: string, deep: boolean,
 *   envelopes?: boolean}} ctx `envelopes` false keeps the github/ samples from being overwritten
 */
async function recordRepos(nwos, { http, out, recordedAt, deep, envelopes = true }) {
  /** @type {(rel: string, env: GraphqlEnvelope | RestEnvelope) => void} */
  const save = (rel, env) => {
    if (envelopes) saveEnvelope(out, rel, env);
  };
  /** @type {Map<string, any>} */
  const nodes = new Map();
  /** @type {Map<string, any>} */
  const readmes = new Map();
  /** @type {Map<string, string>} */
  const missing = new Map();
  let savedFirst = false;
  let savedMissing = false;

  for (const chunk of chunks(nwos, 12)) {
    const { doc, variables } = aliasedRepoQuery('Enrich', ENRICH_FRAGMENT, chunk.map(refOf));
    const env = await http.graphql(doc, variables);
    if (env.status !== 200 || !env.body?.data) {
      const detail = redact(JSON.stringify(env.body?.errors ?? env.body).slice(0, 300));
      throw new Error(`Enrich answered ${env.status}: ${detail}`);
    }
    const errors = env.body.errors ?? [];
    chunk.forEach((nwo, i) => {
      const node = env.body.data[`r${i}`] ?? null;
      if (node) {
        readmes.set(nwo, capEnrichNode(node));
        nodes.set(nwo, node);
      } else {
        const err = errors.find((/** @type {any} */ e) => Array.isArray(e.path) && e.path[0] === `r${i}`);
        missing.set(nwo, err?.type ?? 'NULL');
      }
    });
    const found = chunk.filter((n) => nodes.has(n)).length;
    log(`enrich: ${chunk.length} asked, ${found} found, cost ${env.body.data.rateLimit?.cost}`);
    if (!savedFirst) {
      save('github/graphql/enrich-batch.json', env);
      savedFirst = true;
    }
    if (!savedMissing && errors.length) {
      save('github/graphql/enrich-not-found.json', env);
      savedMissing = true;
    }
  }

  /** @type {Map<string, {name: string, blob: any}>} */
  const repaired = new Map();
  const repairs = [];
  for (const [nwo, node] of nodes) {
    if (node.readme) continue;
    const entry = (node.root?.entries ?? [])
      .find((/** @type {any} */ e) => e.type === 'blob' && /^readme(\.[a-z0-9]+)?$/i.test(e.name));
    if (entry) repairs.push({ nwo, ...refOf(node.nameWithOwner), file: entry.name });
  }
  let savedRepair = false;
  for (const chunk of chunks(repairs, 20)) {
    const { doc, variables } = readmeRepairQuery(chunk);
    const env = await http.graphql(doc, variables);
    chunk.forEach((it, i) => {
      const blob = env.body?.data?.[`r${i}`]?.readme ?? null;
      if (blob) {
        readmes.set(it.nwo, capReadmeBlob(blob));
        repaired.set(it.nwo, { name: it.file, blob });
      }
    });
    log(`readme repair: ${chunk.map((c) => `${c.nwo} → ${c.file}`).join(', ')}`);
    if (!savedRepair) {
      save('github/graphql/readme-repair.json', env);
      savedRepair = true;
    }
  }

  // enrich.json and meta.json
  for (const nwo of nwos) {
    const dir = path.join(out, 'repos', fixtureDirName(nwo));
    const prior = readJsonIf(path.join(dir, 'meta.json'), null);
    const set = setOf(nwo);
    const expect = expectFor(nwo);
    if (!nodes.has(nwo)) {
      const research = path.join(dir, 'enrich.research.json');
      if (!fs.existsSync(path.join(dir, 'enrich.json')) && fs.existsSync(research)) {
        fs.renameSync(research, path.join(dir, 'enrich.json'));
      }
      for (const f of DEEP_FILES) fs.rmSync(path.join(dir, f), { force: true });
      const hasResearch = fs.existsSync(path.join(dir, 'enrich.json'))
        && (prior?.label || prior?.researchRecordedAt !== undefined);
      const base = hasResearch
        ? {
          source: 'research',
          recordedAt: prior?.source === 'research' ? prior.recordedAt : prior?.researchRecordedAt ?? null,
          nwo,
        }
        : { source: 'recorded', recordedAt, nwo };
      const readme = prior?.source === 'research' ? prior.readme : prior?.researchReadme;
      writeFixture(path.join(dir, 'meta.json'), {
        ...base, ...(set ? { set } : {}),
        ...(prior?.label ? { label: prior.label, stratum: prior.stratum, sample: prior.sample } : {}),
        ...(expect ? { expect } : {}),
        ...(hasResearch && readme !== undefined ? { readme } : {}),
        recording: {
          attemptedAt: recordedAt, result: missing.get(nwo) ?? 'NULL',
          fallback: hasResearch
            ? 'The repository no longer resolves; this is its converted research snapshot.'
            : null,
        },
      });
      log(`vanished: ${nwo} (${missing.get(nwo)}) → ${hasResearch ? 'research snapshot' : 'meta only'}`);
      continue;
    }
    const node = nodes.get(nwo);
    const labelledSnapshot = preserveResearch(dir, prior);
    for (const f of DEEP_FILES) fs.rmSync(path.join(dir, f), { force: true });
    const rep = repaired.get(nwo);
    const fixtureNode = { ...node };
    if (rep) fixtureNode.readme = { name: rep.name, ...rep.blob };
    else if (node.readme) fixtureNode.readme = { name: 'README.md', ...node.readme };
    writeFixture(path.join(dir, 'enrich.json'), fixtureNode);
    const ex = readmes.get(nwo);
    writeFixture(path.join(dir, 'meta.json'), {
      source: 'recorded', recordedAt, nwo, ...(set ? { set } : {}), ...researchFields(prior),
      ...(expect ? { expect } : {}),
      readme: ex ? {
        name: rep ? rep.name : 'README.md', originalBytes: ex.originalBytes, keptBytes: ex.keptBytes,
        excerpt: ex.excerpt,
      } : null,
      ...(labelledSnapshot ? { labelledSnapshot } : {}),
      ...(node.nameWithOwner !== nwo ? { nameWithOwnerNow: node.nameWithOwner } : {}),
    });
  }
  log(`wrote ${nodes.size} recorded fixtures; ${missing.size} vanished`);
  if (!deep) return { nodes, missing };

  const items = [...nodes].filter(([, n]) => n.defaultBranchRef?.target?.oid)
    .map(([nwo, n]) => ({ nwo, node: n, ...refOf(n.nameWithOwner) }));
  /** @type {Map<string, Record<string, unknown>>} */
  const deepInfo = new Map(items.map((it) => [it.nwo, {}]));

  let saved = false;
  for (const chunk of chunks(items, 5)) {
    const { doc, variables } = aliasedRepoQuery('Deep', DEEP_FRAGMENT, chunk);
    const env = await http.graphql(doc, variables);
    chunk.forEach((it, i) => {
      const d = env.body?.data?.[`r${i}`] ?? null;
      if (d) writeFixture(path.join(out, 'repos', fixtureDirName(it.nwo), 'deep.json'), d);
      /** @type {any} */ (deepInfo.get(it.nwo)).deep = Boolean(d);
    });
    log(`deep: ${chunk.length} repositories, cost ${env.body?.data?.rateLimit?.cost}`);
    if (!saved) {
      save('github/graphql/deep-batch.json', env);
      saved = true;
    }
  }

  const withFiles = items.map((it) => ({ ...it, paths: deepFilePaths(it.node) }))
    .filter((it) => it.paths.length);
  saved = false;
  for (const chunk of chunks(withFiles, 5)) {
    const { doc, variables } = filesQuery(chunk);
    const env = await http.graphql(doc, variables);
    for (const [i, it] of chunk.entries()) {
      const repo = env.body?.data?.[`r${i}`] ?? {};
      /** @type {Record<string, unknown>} */
      const files = {};
      it.paths.forEach((p, j) => {
        const blob = repo[`f${j}`] ?? null;
        if (blob && typeof blob.text === 'string') blob.text = truncateUtf8(blob.text, TEXT_CAP).text;
        files[p] = blob;
      });
      writeFixture(path.join(out, 'repos', fixtureDirName(it.nwo), 'files.json'), files);
      /** @type {any} */ (deepInfo.get(it.nwo)).files = it.paths;
    }
    log(`files: ${chunk.length} repositories, cost ${env.body?.data?.rateLimit?.cost}`);
    if (!saved) {
      save('github/graphql/files-batch.json', env);
      saved = true;
    }
  }

  /** @type {{tree?: RestEnvelope, activity?: RestEnvelope, stars?: RestEnvelope}} */
  const samples = {};
  for (const it of items) {
    const dir = path.join(out, 'repos', fixtureDirName(it.nwo));
    const info = /** @type {any} */ (deepInfo.get(it.nwo));
    const oid = it.node.defaultBranchRef.target.oid;
    const nwoNow = it.node.nameWithOwner;

    const tree = await http.rest(`/repos/${nwoNow}/git/trees/${oid}?recursive=1`);
    if (tree.status === 200) {
      const slim = slimTree(tree.body);
      writeFixture(path.join(dir, 'tree.json'), slim, { compact: true });
      info.treeEntries = tree.body?.tree?.length ?? 0;
      info.treeTruncated = Boolean(tree.body?.truncated);
      info.treeCapped = info.treeEntries > TREE_CAP;
      const env = { ...tree, body: slim };
      if (!samples.tree || info.treeEntries < (samples.tree.body.tree.length || Infinity)) samples.tree = env;
    } else info.treeStatus = tree.status;

    const act = await http.rest(`/repos/${nwoNow}/activity?per_page=100`);
    if (act.status === 200) {
      const slim = slimActivity(act.body);
      writeFixture(path.join(dir, 'activity.json'), slim);
      info.activityEvents = Array.isArray(slim) ? slim.length : null;
      if (!samples.activity) samples.activity = { ...act, body: slim };
    } else info.activityStatus = act.status;

    if ((it.node.stargazerCount ?? 0) >= 3) {
      const stars = await http.rest(`/repos/${nwoNow}/stargazers/history?per_page=8`);
      if (stars.status === 200) {
        writeFixture(path.join(dir, 'stars.json'), stars.body);
        info.stars = true;
        if (!samples.stars) samples.stars = stars;
      } else info.starsStatus = stars.status;
    } else info.stars = false;
    log(`deep REST: ${it.nwo} tree ${tree.status} activity ${act.status}`);
  }
  if (samples.tree) save('github/rest/tree.json', samples.tree);
  if (samples.activity) {
    save('github/rest/activity.json', samples.activity);
    const etag = samples.activity.headers.etag;
    if (etag && envelopes) {
      const again = await http.rest(samples.activity.request.path, { ifNoneMatch: etag });
      save('github/rest/activity-304.json', again);
    }
  }
  if (samples.stars) save('github/rest/stargazers-history.json', samples.stars);

  for (const it of items) {
    const file = path.join(out, 'repos', fixtureDirName(it.nwo), 'meta.json');
    const meta = readJsonIf(file, {});
    writeFixture(file, { ...meta, deep: { recordedAt, ...deepInfo.get(it.nwo) } });
  }
  return { nodes, missing };
}

/**
 * Record one census window: the probe plus pages with crafted cursors, up to `maxPages` pages.
 * @param {ReturnType<typeof createHttp>} http
 * @param {string} fromIso
 * @param {string} toIso
 * @param {number} maxPages
 */
async function censusWindow(http, fromIso, toIso, maxPages) {
  const q = searchString(fromIso, toIso);
  const probe = await http.graphql(SEARCH_QUERY, { q, first: 100 }, { search: true });
  const count = probe.body?.data?.search?.repositoryCount;
  if (probe.status !== 200 || typeof count !== 'number') {
    const detail = redact(JSON.stringify(probe.body).slice(0, 300));
    throw new Error(`Search probe answered ${probe.status}: ${detail}`);
  }
  const pages = [probe];
  const want = Math.min(Math.ceil(Math.min(count, 1000) / 100), maxPages);
  for (let k = 1; k < want && 100 * k + 100 <= 1000; k++) {
    pages.push(await http.graphql(SEARCH_QUERY, { q, first: 100, after: cursor(100 * k) }, { search: true }));
  }
  return { q, count, pages };
}

/**
 * @param {Date} d
 * @returns {string}
 */
function iso(d) {
  return d.toISOString().replace('.000Z', 'Z');
}

/**
 * Record a normal and a saturated census window for `day` (§3.2).
 * @param {{http: ReturnType<typeof createHttp>, out: string, recordedAt: string, day: string}} ctx
 */
async function recordCensus({ http, out, recordedAt, day }) {
  let minutes = 8;
  /** @type {Awaited<ReturnType<typeof censusWindow>> | null} */
  let normal = null;
  let from = new Date(`${day}T04:00:00Z`);
  let to = from;
  for (let attempt = 0; attempt < 3; attempt++) {
    to = new Date(from.getTime() + minutes * 60_000 - 1000);
    const q = searchString(iso(from), iso(to));
    const probe = await http.graphql(SEARCH_QUERY, { q, first: 100 }, { search: true });
    const count = probe.body?.data?.search?.repositoryCount ?? 0;
    log(`census probe ${iso(from)}..${iso(to)}: ${count}`);
    if (count <= 600 || (attempt === 2 && count <= 900)) {
      const pages = [probe];
      for (let k = 1; k < Math.ceil(count / 100); k++) {
        const vars = { q, first: 100, after: cursor(100 * k) };
        pages.push(await http.graphql(SEARCH_QUERY, vars, { search: true }));
      }
      normal = { q, count, pages };
      break;
    }
    minutes = Math.max(1, Math.floor(minutes / 2));
  }
  if (!normal) throw new Error('Could not find a census window of at most 900 hits');
  const normalName = `normal-${day}T0400.json`;
  writeFixture(path.join(out, 'search', normalName), {
    name: 'normal', day, scope: 'all', fromIso: iso(from), toIso: iso(to),
    unitKey: `census:${day}:all:${iso(from)}..${iso(to)}`, q: normal.q, recordedAt,
    repositoryCount: normal.count, saturated: false,
    pages: normal.pages.map(({ request, status, headers, body }) => ({ request, status, headers, body })),
  }, { compact: true });
  log(`saved search/${normalName}: ${normal.count} hits in ${normal.pages.length} pages`);

  let sFrom = `${day}T14:00:00Z`;
  let sTo = `${day}T14:59:59Z`;
  let sat = await censusWindow(http, sFrom, sTo, 1);
  if (sat.count <= 1000) {
    sFrom = `${day}T00:00:00Z`;
    sTo = `${day}T23:59:59Z`;
    sat = await censusWindow(http, sFrom, sTo, 1);
  }
  const rest = [];
  for (let k = 1; k < 10; k++) {
    const vars = { q: sat.q, first: 100, after: cursor(100 * k) };
    rest.push(await http.graphql(SEARCH_QUERY, vars, { search: true }));
  }
  const satName = `saturated-${sFrom.slice(0, 13).replace(':', '')}.json`;
  writeFixture(path.join(out, 'search', satName), {
    name: 'saturated', day, scope: 'all', fromIso: sFrom, toIso: sTo,
    unitKey: `census:${day}:all:${sFrom}..${sTo}`, q: sat.q, recordedAt,
    repositoryCount: sat.count, saturated: true,
    pages: [...sat.pages, ...rest]
      .map(({ request, status, headers, body }) => ({ request, status, headers, body })),
  }, { compact: true });
  log(`saved search/${satName}: count ${sat.count}, ${1 + rest.length} pages (the 1,000-result cap)`);
}

/**
 * Lines of a gzipped NDJSON sample, split on `\n` by hand.
 * @param {string} file
 * @returns {any[]}
 */
function archiveEvents(file) {
  const text = gunzipSync(fs.readFileSync(file)).toString('utf8');
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * Record the re-check, archive-lookup and REST-fallback samples.
 * @param {{http: ReturnType<typeof createHttp>, out: string, archive: string | null}} ctx
 */
async function recordSamples({ http, out, archive }) {
  /** @type {(rel: string, env: GraphqlEnvelope | RestEnvelope) => void} */
  const save = (rel, env) => saveEnvelope(out, rel, env);
  const ids = [];
  for (const nwo of NAMED_SETS.seedGems) {
    const node = readJsonIf(path.join(out, 'repos', fixtureDirName(nwo), 'enrich.json'), null);
    const meta = readJsonIf(path.join(out, 'repos', fixtureDirName(nwo), 'meta.json'), null);
    if (node?.id && meta?.source === 'recorded') ids.push(node.id);
  }
  const exists = await http.graphql(EXISTS_QUERY, { ids: [...ids.slice(0, 10), 'R_kgDOAAAAAA'] });
  save('github/graphql/exists.json', exists);

  if (archive) {
    const seen = new Set();
    const refs = [];
    for (const e of archiveEvents(archive)) {
      if (e.type !== 'ReleaseEvent' && e.type !== 'PublicEvent') continue;
      const nwo = e.repo?.name;
      if (!nwo || seen.has(nwo.toLowerCase())) continue;
      seen.add(nwo.toLowerCase());
      refs.push(refOf(nwo));
      if (refs.length === 100) break;
    }
    const { doc, variables } = aliasedRepoQuery('Lean', LEAN_FRAGMENT, refs);
    const env = await http.graphql(doc, variables);
    const errors = (env.body?.errors ?? []).length;
    log(`archive lookup: ${refs.length} asked, ${errors} errors, cost ${env.body?.data?.rateLimit?.cost}`);
    save('github/graphql/archive-lookup.json', env);
  }

  const nwo = 'zaghaghi/toolog';
  const repo = await http.rest(`/repos/${nwo}`);
  if (repo.body && typeof repo.body === 'object') delete repo.body.permissions;
  save('github/rest/repo.json', repo);

  const readme = await http.rest(`/repos/${nwo}/readme`);
  if (readme.body?.content && readme.body.encoding === 'base64') {
    const text = Buffer.from(readme.body.content, 'base64').toString('utf8');
    readme.body.content = Buffer.from(readmeExcerpt(text).text, 'utf8').toString('base64');
  }
  save('github/rest/readme.json', readme);

  const contents = await http.rest(`/repos/${nwo}/contents/`);
  if (Array.isArray(contents.body)) {
    contents.body = contents.body.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size }));
  }
  save('github/rest/contents-root.json', contents);

  const releases = await http.rest(`/repos/${nwo}/releases?per_page=5`);
  if (Array.isArray(releases.body)) {
    releases.body = releases.body.map((r) => ({
      id: r.id, tag_name: r.tag_name, name: r.name, draft: r.draft, prerelease: r.prerelease,
      created_at: r.created_at, published_at: r.published_at,
    }));
  }
  save('github/rest/releases.json', releases);

  const commits = await http.rest(`/repos/${nwo}/commits?per_page=20`);
  if (Array.isArray(commits.body)) {
    commits.body = commits.body.map((c) => ({
      sha: c.sha,
      commit: {
        message: truncateUtf8(c.commit?.message ?? '', 1000).text,
        author: { date: c.commit?.author?.date ?? null },
        committer: { date: c.commit?.committer?.date ?? null },
      },
      author: c.author ? { login: c.author.login } : null,
      committer: c.committer ? { login: c.committer.login } : null,
    }));
  }
  save('github/rest/commits.json', commits);

  const since = await http.rest('/repositories?since=1365300000');
  if (Array.isArray(since.body)) {
    since.body = since.body
      .map((r) => ({ id: r.id, node_id: r.node_id, full_name: r.full_name, fork: r.fork }));
  }
  save('github/rest/repositories-since.json', since);

  const gone = await http.rest('/repos/unsung-fixtures/no-such-repository');
  save('github/rest/not-found.json', gone);
}

/**
 * Resolve `--set` values into repository names.
 * @param {string[]} values
 * @param {string} out
 * @returns {string[]}
 */
function resolveSet(values, out) {
  const list = [];
  for (const v of values) {
    if (v === 'labelled') {
      list.push(...Object.keys(readJsonIf(path.join(out, 'labelled', 'labels.json'), {})));
    } else if (v in SET_ALIASES) {
      for (const s of SET_ALIASES[/** @type {keyof typeof SET_ALIASES} */ (v)]) list.push(...NAMED_SETS[s]);
    } else if (/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(v)) {
      list.push(v);
    } else {
      throw new Error(`Unknown --set value: ${v.slice(0, 80)}`);
    }
  }
  return [...new Map(list.map((n) => [n.toLowerCase(), n])).values()];
}

/**
 * CLI entry point.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      set: { type: 'string', multiple: true },
      'no-deep': { type: 'boolean', default: false },
      census: { type: 'boolean', default: false },
      day: { type: 'string', default: '2026-09-08' },
      samples: { type: 'boolean', default: false },
      archive: { type: 'string' },
      out: { type: 'string', default: FIXTURES },
      'dry-run': { type: 'boolean', default: false },
      'max-search': { type: 'string', default: '25' },
      'max-points': { type: 'string', default: '400' },
      'max-rest': { type: 'string', default: '400' },
    },
  });
  const out = path.resolve(values.out);
  const sets = [...(values.set ?? []), ...positionals];
  if (!sets.length && !values.census && !values.samples) {
    process.stderr.write('Usage: node tools/record-fixtures.mjs '
      + '--set seeds|hard|spam|named|labelled|<owner/name>… | --census | --samples\n');
    return 2;
  }
  const repos = resolveSet(sets, out);
  const archive = values.archive ?? (() => {
    const dir = path.join(out, 'gharchive');
    const f = fs.existsSync(dir) ? fs.readdirSync(dir).find((x) => x.endsWith('.sample.json.gz')) : undefined;
    return f ? path.join(dir, f) : null;
  })();
  if (values['dry-run']) {
    const plan = {
      repos, deep: !values['no-deep'], census: values.census, day: values.day,
      samples: values.samples, archive,
    };
    log(JSON.stringify(plan, null, 2));
    return 0;
  }
  const budget = createBudget({
    search: Number(values['max-search']),
    points: Number(values['max-points']),
    rest: Number(values['max-rest']),
  });
  const http = createHttp({ token: getToken(process.env), budget });
  const recordedAt = iso(new Date(Math.floor(Date.now() / 1000) * 1000));
  try {
    // Only named and labelled sets refresh the github/ samples; an ad-hoc list never overwrites them.
    const envelopes = sets.every((v) => v in SET_ALIASES || v === 'labelled');
    if (repos.length) {
      await recordRepos(repos, { http, out, recordedAt, deep: !values['no-deep'], envelopes });
    }
    if (values.census) await recordCensus({ http, out, recordedAt, day: values.day });
    if (values.samples) await recordSamples({ http, out, archive });
  } finally {
    log(`budget used: ${JSON.stringify(budget.used)}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`record-fixtures: ${redact(/** @type {Error} */ (err).message)}\n`);
    process.exitCode = 1;
  });
}
