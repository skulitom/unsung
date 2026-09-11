// @ts-check
/**
 * A reader for a fixtures directory laid out as DESIGN §14.2 (`test/fixtures/` in a checkout), for
 * `unsung eval`, `unsung calibrate` and `unsung explain --fixture`. It offers the functions of
 * `test/support/fixtures.mjs` (`loadLabelled`, `loadRepoFixture`, `loadJsonFixture`,
 * `listRepoFixtures`, `hasRepoFixture`), so `src/eval/labels.mjs` works with either.
 *
 * Fixture files are local test data; paths named inside them are resolved and kept inside the
 * fixtures directory.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** The files a repository fixture may hold, without `.json`. */
export const REPO_FILES = Object.freeze(['meta', 'enrich', 'deep', 'tree', 'files', 'activity', 'stars']);

/**
 * @typedef {object} RepoFixture
 * @property {string} name directory name, `owner__name`
 * @property {string} nwo `owner/name`
 * @property {string} dir absolute directory
 * @property {any} meta
 * @property {any} enrich
 * @property {any} deep
 * @property {any} tree
 * @property {any} files
 * @property {any} activity
 * @property {any} stars
 */

/** @typedef {Record<string, {cat: string, flags?: unknown, note?: string, stratum: string}>} Labels */

/**
 * @typedef {object} FixtureLoader
 * @property {string} dir the fixtures directory, absolute
 * @property {() => boolean} exists whether the directory holds repository fixtures
 * @property {() => Labels} loadLabelled
 * @property {(name: string) => RepoFixture} loadRepoFixture
 * @property {(rel: string) => any} loadJsonFixture
 * @property {(filter?: ((meta: any, nwo: string) => boolean)) => string[]} listRepoFixtures
 * @property {(name: string) => boolean} hasRepoFixture
 */

/** A fixtures file is missing, unreadable or outside the fixtures directory. */
export class FixtureError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'FixtureError';
    this.code = 'EFIXTURE';
  }
}

/**
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
  const text = readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/**
 * `owner__name` → `owner/name`.
 * @param {string} dir
 * @returns {string}
 */
function nwoFromDir(dir) {
  const i = dir.indexOf('__');
  return i > 0 ? `${dir.slice(0, i)}/${dir.slice(i + 2)}` : dir;
}

/**
 * A loader over one fixtures directory.
 * @param {string} dir
 * @returns {FixtureLoader}
 */
export function fixtureLoader(dir) {
  const root = path.resolve(dir);
  const reposDir = path.join(root, 'repos');

  /**
   * @param {string} rel
   * @returns {string}
   */
  const inside = (rel) => {
    const full = path.resolve(root, rel);
    const r = path.relative(root, full);
    if (r.startsWith('..') || path.isAbsolute(r)) {
      throw new FixtureError(`Fixture path ${rel} leaves ${root}`);
    }
    return full;
  };

  /** @returns {string[]} */
  const repoDirs = () => {
    if (!existsSync(reposDir)) return [];
    return readdirSync(reposDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  };

  /**
   * @param {string} name
   * @returns {string | undefined}
   */
  const findDir = (name) => {
    const wanted = String(name).includes('/') ? String(name).replace('/', '__') : String(name);
    const dirs = repoDirs();
    return dirs.find((d) => d === wanted) ?? dirs.find((d) => d.toLowerCase() === wanted.toLowerCase());
  };

  return {
    dir: root,
    exists: () => repoDirs().length > 0,
    loadLabelled() {
      const file = path.join(root, 'labelled', 'labels.json');
      if (!existsSync(file)) throw new FixtureError(`No labels at ${file}`);
      return readJson(file);
    },
    loadRepoFixture(name) {
      const hit = findDir(name);
      if (!hit) throw new FixtureError(`No repository fixture for ${name} in ${reposDir}`);
      const d = path.join(reposDir, hit);
      /** @type {RepoFixture} */
      const fx = {
        name: hit, nwo: nwoFromDir(hit), dir: d,
        meta: null, enrich: null, deep: null, tree: null, files: null, activity: null, stars: null,
      };
      for (const f of REPO_FILES) {
        const file = path.join(d, `${f}.json`);
        /** @type {any} */ (fx)[f] = existsSync(file) ? readJson(file) : null;
      }
      if (typeof fx.meta?.nwo === 'string') fx.nwo = fx.meta.nwo;
      else if (typeof fx.enrich?.nameWithOwner === 'string') fx.nwo = fx.enrich.nameWithOwner;
      return fx;
    },
    loadJsonFixture(rel) {
      const file = inside(rel);
      if (!existsSync(file)) throw new FixtureError(`Fixture ${rel} is missing`);
      return readJson(file);
    },
    listRepoFixtures(filter) {
      /** @type {string[]} */
      const out = [];
      for (const d of repoDirs()) {
        const nwo = nwoFromDir(d);
        if (filter) {
          const file = path.join(reposDir, d, 'meta.json');
          const meta = existsSync(file) ? readJson(file) : {};
          if (!filter(meta, nwo)) continue;
        }
        out.push(nwo);
      }
      return out;
    },
    hasRepoFixture(name) {
      return findDir(name) !== undefined;
    },
  };
}
