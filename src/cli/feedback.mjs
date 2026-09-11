// @ts-check
/**
 * `unsung feedback import <file>` (DESIGN §9.1, §10.5): merge feedback exported from a read-only
 * Pages copy into `data/feedback.jsonl`, then rebuild `taste.json`. Events already stored are
 * skipped, invalid ones are reported, and nothing stored is ever changed.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ArgsError } from './args.mjs';
import { pinsOf, rebuildTaste } from '../core/taste.mjs';
import { mergeFeedback, parseFeedbackExport } from '../core/views.mjs';

/** @typedef {import('./context.mjs').Ctx} Ctx */
/** @typedef {import('./args.mjs').ParsedArgs} ParsedArgs */

/** The export file is missing, unreadable or not an export; the CLI exits 2. */
export class ImportError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ImportError';
    this.code = 'EIMPORT';
    this.exitCode = 2;
  }
}

/**
 * Collect an array, an iterable or an async iterable (the store may return any of them).
 * @param {unknown} source
 * @returns {Promise<any[]>}
 */
async function collect(source) {
  const s = /** @type {any} */ (await source);
  if (!s) return [];
  if (Array.isArray(s)) return s;
  if (typeof s[Symbol.asyncIterator] === 'function' || typeof s[Symbol.iterator] === 'function') {
    const out = [];
    for await (const v of s) out.push(v);
    return out;
  }
  return [];
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

export const command = {
  name: 'feedback',
  summary: 'Merge feedback exported from a Pages copy',
  flags: {},

  /**
   * @param {ParsedArgs} args
   * @param {Ctx} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    const [sub, file, ...rest] = args.positionals;
    if (sub !== 'import' || !file || rest.length > 0) {
      throw new ArgsError('Usage: unsung feedback import <file>');
    }
    const full = path.resolve(file);
    /** @type {string} */
    let text;
    try {
      text = await readFile(full, 'utf8');
    } catch (err) {
      const code = /** @type {{code?: string}} */ (err)?.code;
      const why = code === 'ENOENT' ? 'there is no such file' : code ?? 'error';
      throw new ImportError(`Cannot read ${file}: ${why}`);
    }
    /** @type {{events: unknown[], pins: Record<string, 1 | -1>}} */
    let parsed;
    try {
      parsed = parseFeedbackExport(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
    } catch (err) {
      const why = /** @type {Error} */ (err).message;
      throw new ImportError(`${file} is not an Unsung feedback export (${why})`);
    }

    const store = await ctx.store();
    const existing = await collect(store.readFeedback());
    const { added, duplicates, invalid } = mergeFeedback(existing, parsed.events);
    for (const ev of added) await store.appendFeedback(ev);

    const index = await store.readIndex();
    const byId = new Map((index?.entries ?? []).map((/** @type {any} */ e) => [e.id, e]));
    const pins = { ...pinsOf(await store.readTaste()), ...parsed.pins };
    const taste = rebuildTaste([...existing, ...added], byId, { pins, updatedAt: ctx.now() });
    await store.writeTaste(taste);

    const summary = {
      file: full, added: added.length, duplicates, invalid: invalid.length,
      pins: Object.keys(parsed.pins).length,
    };
    if (ctx.flags.json) {
      ctx.printJson({ ...summary, problems: invalid });
      return 0;
    }
    ctx.print(`Imported ${plural(added.length, 'feedback event')} from ${path.basename(full)}.`);
    if (duplicates > 0) ctx.print(`${plural(duplicates, 'event was', 'events were')} already stored.`);
    if (summary.pins > 0) ctx.print(`${plural(summary.pins, 'taste pin')} applied.`);
    for (const bad of invalid.slice(0, 5)) {
      ctx.log.warn(`Skipped event ${bad.index + 1}: ${bad.problems.join('; ')}`);
    }
    if (invalid.length > 5) ctx.log.warn(`${invalid.length - 5} more invalid events skipped`);
    ctx.print('Taste rebuilt.');
    return 0;
  },
};
