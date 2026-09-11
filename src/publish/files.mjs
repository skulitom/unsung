// @ts-check
/**
 * File output for `unsung export` and `unsung digest` (DESIGN §11.2, §4.1). Writes are atomic
 * (temporary file, fsync, rename) and can never land outside the export directory: every path is
 * resolved against the directory, checked to stay inside it, and refused if any existing part of it
 * is a symbolic link. Removal is limited to single generated files, followed by any parent
 * directories that are left empty, up to a stop directory; nothing is ever removed recursively.
 */

import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding the static gallery assets shipped with Unsung. */
export const ASSETS_DIR = fileURLToPath(new URL('./assets/', import.meta.url));

/** The assets copied into `<out>/assets/`. */
export const ASSET_FILES = Object.freeze(['style.css', 'gallery.mjs']);

/** A path that would leave the export directory, or that goes through a symbolic link. */
export class ExportPathError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ExportPathError';
    this.code = 'EEXPORTPATH';
  }
}

/**
 * Throw if any existing component of `full` below `base` is a symbolic link.
 * @param {string} base
 * @param {string} full
 */
function assertNoLinks(base, full) {
  let dir = base;
  for (const part of path.relative(base, full).split(path.sep)) {
    dir = path.join(dir, part);
    /** @type {import('node:fs').Stats} */
    let st;
    try {
      st = lstatSync(dir);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      throw new ExportPathError(`Refusing to write through a symbolic link: ${path.relative(base, dir)}`);
    }
  }
}

/**
 * The absolute path of `rel` (a `/`-separated path relative to `root`), after checking that it stays
 * inside `root` and does not pass through a symbolic link.
 * @param {string} root
 * @param {string} rel
 * @returns {string}
 */
export function resolveInside(root, rel) {
  const bad = typeof rel !== 'string' || rel === '' || rel.includes('\0') || path.isAbsolute(rel)
    || /^[a-z]:/i.test(rel);
  if (bad) {
    throw new ExportPathError(`Not a relative path inside the export directory: ${String(rel).slice(0, 80)}`);
  }
  const base = path.resolve(root);
  const full = path.resolve(base, ...rel.split('/'));
  const back = path.relative(base, full);
  if (back === '' || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new ExportPathError(`Refusing to write outside the export directory: ${rel.slice(0, 80)}`);
  }
  assertNoLinks(base, full);
  return full;
}

/**
 * Write `data` to `root/rel` atomically: a temporary sibling is written and fsynced, then renamed
 * over the target. Parent directories are created. Returns the absolute path.
 * @param {string} root
 * @param {string} rel
 * @param {string | Uint8Array} data
 * @returns {string}
 */
export function writeFileAtomic(root, rel, data) {
  const full = resolveInside(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  for (let attempt = 1; ; attempt++) {
    try {
      renameSync(tmp, full);
      return full;
    } catch (err) {
      const code = /** @type {{code?: string}} */ (err).code;
      // Windows can briefly refuse a rename while another process (an indexer, a virus scanner)
      // has the target open.
      if (attempt < 5 && (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) continue;
      try {
        unlinkSync(tmp);
      } catch {
        // already gone
      }
      throw err;
    }
  }
}

/**
 * Remove one generated file, then each parent directory that is now empty, stopping at `stopAt`
 * (relative to `root`, never removed). Returns whether the file existed and was removed.
 * @param {string} root
 * @param {string} rel
 * @param {string} stopAt
 * @returns {boolean}
 */
export function removeGenerated(root, rel, stopAt) {
  const full = resolveInside(root, rel);
  const stop = resolveInside(root, stopAt);
  /** @type {import('node:fs').Stats} */
  let st;
  try {
    st = lstatSync(full);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  unlinkSync(full);
  let dir = path.dirname(full);
  while (dir.startsWith(`${stop}${path.sep}`)) {
    try {
      rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
  return true;
}

/**
 * Copy the gallery assets into `<root>/assets/`. Returns the relative paths written.
 * @param {string} root
 * @returns {string[]}
 */
export function copyAssets(root) {
  return ASSET_FILES.map((name) => {
    const rel = `assets/${name}`;
    writeFileAtomic(root, rel, readFileSync(path.join(ASSETS_DIR, name)));
    return rel;
  });
}

/**
 * Read and parse a JSON file inside `root`, or return `fallback` when it is missing or unreadable.
 * @param {string} root
 * @param {string} rel
 * @param {unknown} fallback
 * @returns {any}
 */
export function readJsonInside(root, rel, fallback) {
  try {
    const text = readFileSync(resolveInside(root, rel), 'utf8');
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return fallback;
  }
}
