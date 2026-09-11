// @ts-check
/**
 * Loaders for `test/fixtures/` in the formats of DESIGN §14.2. Optional files that are absent load
 * as `null`; required ones throw a clear error.
 *
 *   repos/<owner>__<name>/{meta,enrich,deep,tree,files,activity,stars}.json
 *   labelled/labels.json
 *   github/graphql/<name>.json, github/rest/<name>.json
 *
 * This file is a helper: `node --test` loads it, and it only exports functions.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of `test/fixtures/`. */
export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** Absolute path of `test/fixtures/repos/`. */
export const REPOS_DIR = path.join(FIXTURES_DIR, 'repos');

/** The files a repository fixture may hold, without `.json`. */
export const REPO_FILES = Object.freeze(['meta', 'enrich', 'deep', 'tree', 'files', 'activity', 'stars']);

/**
 * @typedef {object} RepoFixture
 * @property {string} name directory name, `owner__name`
 * @property {string} nwo `owner/name`
 * @property {string} dir absolute directory
 * @property {any} meta `{source, recordedAt, label?, stratum?, expect?}`, or null
 * @property {any} enrich GraphQL node in the §3.5 shape, or null
 * @property {any} deep
 * @property {any} tree
 * @property {any} files
 * @property {any} activity
 * @property {any} stars
 */

/**
 * @typedef {((meta: any, nwo: string) => boolean) | Record<string, unknown>} FixtureFilter
 *   a predicate, or values that `meta` must hold: a plain value must be equal, an array must
 *   contain the value, a function is a predicate, `true` means present and `false` absent
 */

/**
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  const text = readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/**
 * @param {string} file
 * @returns {any}
 */
function readOptional(file) {
  return existsSync(file) ? readJson(file) : null;
}

/**
 * @param {string} rel
 * @returns {string}
 */
function shown(rel) {
  return `test/fixtures/${rel.split(path.sep).join('/')}`;
}

/**
 * Absolute path of a file under `test/fixtures/`.
 * @param {...string} parts
 * @returns {string}
 */
export function fixturePath(...parts) {
  return path.join(FIXTURES_DIR, ...parts);
}

/**
 * Load any JSON file under `test/fixtures/` (for example `index.sample.json`).
 * @param {string} rel path relative to `test/fixtures/`
 * @returns {any}
 */
export function loadJsonFixture(rel) {
  const file = fixturePath(rel);
  if (!existsSync(file)) throw new Error(`Fixture ${shown(rel)} is missing`);
  return readJson(file);
}

/**
 * `owner__name` → `owner/name` (logins never contain `_`, so the first `__` is the separator).
 * @param {string} dir
 * @returns {string}
 */
function nwoFromDir(dir) {
  const i = dir.indexOf('__');
  return i > 0 ? `${dir.slice(0, i)}/${dir.slice(i + 2)}` : dir;
}

/** @returns {string[]} fixture directory names, sorted */
function repoDirs() {
  if (!existsSync(REPOS_DIR)) return [];
  return readdirSync(REPOS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * @param {string | {nwo?: string, name?: string}} name
 * @returns {string}
 */
function wantedDir(name) {
  const raw = typeof name === 'string' ? name : String(name?.nwo ?? name?.name ?? '');
  return raw.includes('/') ? raw.replace('/', '__') : raw;
}

/**
 * Whether a repository fixture exists.
 * @param {string | {nwo?: string, name?: string}} name `owner/name` or `owner__name`
 * @returns {boolean}
 */
export function hasRepoFixture(name) {
  const wanted = wantedDir(name).toLowerCase();
  return repoDirs().some((d) => d.toLowerCase() === wanted);
}

/**
 * Load one repository fixture. Matching is exact first, then case-insensitive.
 * @param {string | {nwo?: string, name?: string}} name `owner/name`, `owner__name`, or a fixture
 * @returns {RepoFixture}
 */
export function loadRepoFixture(name) {
  const wanted = wantedDir(name);
  const dirs = repoDirs();
  const hit = dirs.find((d) => d === wanted) ?? dirs.find((d) => d.toLowerCase() === wanted.toLowerCase());
  if (!hit) throw new Error(`No repository fixture for ${wanted.replace('__', '/')} in ${shown('repos')}`);
  const dir = path.join(REPOS_DIR, hit);
  /** @type {RepoFixture} */
  const fx = {
    name: hit, nwo: nwoFromDir(hit), dir,
    meta: null, enrich: null, deep: null, tree: null, files: null, activity: null, stars: null,
  };
  for (const f of REPO_FILES) {
    /** @type {any} */ (fx)[f] = readOptional(path.join(dir, `${f}.json`));
  }
  if (typeof fx.meta?.nwo === 'string') fx.nwo = fx.meta.nwo;
  else if (typeof fx.enrich?.nameWithOwner === 'string') fx.nwo = fx.enrich.nameWithOwner;
  return fx;
}

/**
 * @param {any} meta
 * @param {Record<string, unknown>} filter
 * @returns {boolean}
 */
function metaMatches(meta, filter) {
  for (const [k, want] of Object.entries(filter)) {
    const have = meta?.[k];
    if (typeof want === 'function') {
      if (!want(have)) return false;
    } else if (Array.isArray(want)) {
      if (!want.includes(have)) return false;
    } else if (want === true) {
      if (have === undefined || have === null) return false;
    } else if (want === false) {
      if (have !== undefined && have !== null) return false;
    } else if (have !== want) return false;
  }
  return true;
}

/**
 * List repository fixtures as `owner/name`, sorted, optionally filtered on `meta.json`.
 * @param {FixtureFilter} [filter]
 * @returns {string[]}
 */
export function listRepoFixtures(filter) {
  const out = [];
  for (const d of repoDirs()) {
    const nwo = nwoFromDir(d);
    if (filter) {
      const meta = readOptional(path.join(REPOS_DIR, d, 'meta.json')) ?? {};
      const keep = typeof filter === 'function' ? filter(meta, nwo) : metaMatches(meta, filter);
      if (!keep) continue;
    }
    out.push(nwo);
  }
  return out;
}

/**
 * The research labels: `{nwo: {cat, flags, note, stratum}}` (§14.2).
 * @returns {Record<string, {cat: string, flags?: unknown, note?: string, stratum: 'uniform' | 'search'}>}
 */
export function loadLabelled() {
  const rel = path.join('labelled', 'labels.json');
  if (!existsSync(fixturePath(rel))) {
    throw new Error(`Fixture ${shown(rel)} is missing `
      + '(node tools/convert-research.mjs research/raw/haystack builds it)');
  }
  return readJson(fixturePath(rel));
}

/**
 * @param {string} kind
 * @param {string} name
 * @returns {any}
 */
function loadRecorded(kind, name) {
  const base = String(name).replace(/\.json$/, '');
  return loadJsonFixture(path.join('github', kind, `${base}.json`));
}

/**
 * A recorded GraphQL exchange: `{request: {query, variables}, status, headers, body}`.
 * @param {string} name file name under `github/graphql/`, with or without `.json`
 * @returns {any}
 */
export function loadGraphqlFixture(name) {
  return loadRecorded('graphql', name);
}

/**
 * A recorded REST exchange: `{request: {path}, status, headers, body}`.
 * @param {string} name file name under `github/rest/`, with or without `.json`
 * @returns {any}
 */
export function loadRestFixture(name) {
  return loadRecorded('rest', name);
}
