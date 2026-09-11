// @ts-check
/**
 * Command-line parsing (DESIGN §9.1, §12.1) over `node:util#parseArgs`, adding the flag types
 * `number` and `duration`, `--no-<flag>` negation, defaults, and British-English errors.
 *
 * A command's flag spec maps each flag name to its definition:
 *
 *   { budget: { type: 'duration', summary: 'wall-clock budget' },
 *     'enrich-max': { type: 'number', arg: 'N' },
 *     'no-archive': { type: 'boolean' },
 *     top: { type: 'number', default: 100 } }
 *
 * An array of `{name, ...definition}` objects and bare type strings (`{ top: 'number' }`) are
 * accepted too. Names may be written in kebab-case or camelCase; on the command line a flag is
 * always spelt in kebab-case (`--enrich-max`), and the parsed `flags` object carries every value
 * under both spellings (`flags['enrich-max']` and `flags.enrichMax`). Every boolean `x` can be
 * negated with `--no-x`; a declared boolean `no-x` also sets `x` to its opposite.
 */

import { parseArgs as utilParseArgs } from 'node:util';
import { parseDuration } from '../core/util.mjs';

/** A usage error; the CLI prints its message and exits 2. */
export class ArgsError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'ArgsError';
    this.code = 'EARGS';
    this.exitCode = 2;
  }
}

/** @typedef {'string' | 'number' | 'boolean' | 'duration'} FlagType */

/**
 * @typedef {object} FlagDef
 * @property {FlagType} type
 * @property {unknown} [default] applied when the flag is absent (strings are converted by type)
 * @property {string} [short] one-letter alias
 * @property {boolean} [multiple] collect every occurrence into an array
 * @property {string} [summary] one line of help (`description` and `help` are synonyms)
 * @property {string} [arg] placeholder shown in help, such as `N` or `<dir>`
 */

/** @typedef {Record<string, FlagDef | FlagType> | (FlagDef & {name: string})[]} FlagSpec */

/**
 * @typedef {object} ParsedArgs
 * @property {string | null} command the first positional argument
 * @property {string[]} positionals the remaining positional arguments
 * @property {Record<string, any>} flags typed values under kebab-case and camelCase names;
 *   booleans default to false, other flags without a default are absent
 * @property {string[]} given kebab-case names of the flags that appeared on the command line
 */

/** Flags every command accepts (§9.1). */
export const GLOBAL_FLAGS = Object.freeze({
  data: { type: 'string', arg: '<dir>', summary: 'data directory (default ./data, or UNSUNG_DATA)' },
  config: { type: 'string', arg: '<dir>', summary: 'configuration directory (default ./config)' },
  json: { type: 'boolean', summary: 'machine-readable output on stdout; logs stay on stderr' },
  verbose: { type: 'boolean', summary: 'log debugging detail' },
  quiet: { type: 'boolean', summary: 'log warnings and errors only' },
  seed: {
    type: 'number', arg: '<n>', summary: 'seed for exploration and sampling (default derived from the run)',
  },
  help: { type: 'boolean', short: 'h', summary: 'show help' },
});

/** @type {Record<string, FlagType>} */
const TYPE_ALIASES = {
  string: 'string', str: 'string', number: 'number', int: 'number', integer: 'number', float: 'number',
  boolean: 'boolean', bool: 'boolean', duration: 'duration',
};

/** Values of a `duration` flag that mean "no limit". */
const UNLIMITED = new Set(['none', 'off', 'unlimited']);

/**
 * `enrichMax` → `enrich-max`.
 * @param {string} name
 * @returns {string}
 */
export function kebab(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * `enrich-max` → `enrichMax`.
 * @param {string} name
 * @returns {string}
 */
export function camel(name) {
  return name.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase());
}

/**
 * @typedef {FlagDef & {name: string, declared: string}} NormalFlag
 */

/**
 * Normalise a spec (object or array form) to a map from kebab-case name to definition.
 * @param {FlagSpec | null | undefined} spec
 * @returns {Map<string, NormalFlag>}
 */
export function normaliseSpec(spec) {
  /** @type {[string, FlagDef | FlagType][]} */
  const entries = Array.isArray(spec)
    ? spec.map((d) => [d.name, d])
    : Object.entries(spec ?? {});
  /** @type {Map<string, NormalFlag>} */
  const out = new Map();
  for (const [declared, raw] of entries) {
    if (typeof declared !== 'string' || !declared) throw new TypeError('Every flag needs a name');
    const def = typeof raw === 'string' ? { type: raw } : { ...raw };
    const type = TYPE_ALIASES[String(def.type ?? 'string')];
    if (!type) throw new TypeError(`Flag '${declared}' has an unknown type '${String(def.type)}'`);
    const r = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (def));
    const summary = def.summary ?? (typeof r.description === 'string' ? r.description : undefined)
      ?? (typeof r.help === 'string' ? r.help : undefined);
    const name = kebab(declared);
    out.set(name, { ...def, type, summary, name, declared });
  }
  return out;
}

/**
 * @param {string} value
 * @returns {string}
 */
function shown(value) {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

/**
 * Convert a raw string (or a default) to the flag's type.
 * @param {NormalFlag} def
 * @param {unknown} value
 * @returns {unknown}
 */
function convert(def, value) {
  if (value === null) return null;
  const flag = `--${def.name}`;
  switch (def.type) {
    case 'boolean':
      return Boolean(value);
    case 'number': {
      const n = typeof value === 'number' ? value : String(value).trim() === '' ? NaN : Number(value);
      if (!Number.isFinite(n)) {
        throw new ArgsError(`Flag '${flag}' expects a number, got '${shown(String(value))}'`);
      }
      return n;
    }
    case 'duration': {
      if (typeof value === 'string' && UNLIMITED.has(value.trim().toLowerCase())) return null;
      try {
        return parseDuration(/** @type {string | number} */ (value));
      } catch {
        const got = shown(String(value));
        throw new ArgsError(`Flag '${flag}' expects a duration such as 10m or 2h, got '${got}'`);
      }
    }
    default:
      return String(value);
  }
}

/**
 * Parse `argv` (without the node executable and script path) against a flag spec. Global flags
 * (§9.1) are always included; a same-named flag in `spec` overrides the global definition.
 * With `strict: false`, unknown flags are ignored instead of rejected.
 * @param {string[]} argv
 * @param {FlagSpec | null} [spec]
 * @param {{strict?: boolean}} [opts]
 * @returns {ParsedArgs}
 */
export function parseArgs(argv, spec, { strict = true } = {}) {
  const defs = new Map([...normaliseSpec(GLOBAL_FLAGS), ...normaliseSpec(spec)]);

  /** @type {Record<string, {type: 'string' | 'boolean', short?: string, multiple?: boolean}>} */
  const options = {};
  /** @type {Map<string, {def: NormalFlag, negate: boolean}>} */
  const lookup = new Map();
  for (const def of defs.values()) {
    const utilType = def.type === 'boolean' ? 'boolean' : 'string';
    options[def.name] = { type: utilType };
    if (def.short && def.short.length === 1) options[def.name].short = def.short;
    if (def.multiple) options[def.name].multiple = true;
    lookup.set(def.name, { def, negate: false });
    if (def.declared !== def.name && !defs.has(def.declared)) {
      options[def.declared] = { type: utilType };
      lookup.set(def.declared, { def, negate: false });
    }
    if (def.type === 'boolean' && !defs.has(`no-${def.name}`)) {
      options[`no-${def.name}`] = { type: 'boolean' };
      lookup.set(`no-${def.name}`, { def, negate: true });
    }
  }

  /** @type {{tokens?: any[]}} */
  let parsed;
  try {
    parsed = utilParseArgs({ args: argv, options, strict: false, allowPositionals: true, tokens: true });
  } catch (err) {
    throw new ArgsError(err instanceof Error ? err.message : String(err));
  }

  /** @type {Record<string, unknown>} */
  const values = {};
  /** @type {Set<string>} */
  const given = new Set();
  /** @type {string[]} */
  const positionals = [];

  for (const token of parsed.tokens ?? []) {
    if (token.kind === 'positional') {
      positionals.push(token.value);
      continue;
    }
    if (token.kind !== 'option') continue;
    const hit = lookup.get(token.name);
    if (!hit) {
      if (strict) throw new ArgsError(`Unknown flag '${token.rawName}'`);
      continue;
    }
    const { def, negate } = hit;
    given.add(def.name);
    if (negate) {
      if (token.value !== undefined) throw new ArgsError(`Flag '${token.rawName}' does not take a value`);
      values[def.name] = false;
      continue;
    }
    if (def.type === 'boolean') {
      if (token.value === undefined) values[def.name] = true;
      else if (/^(true|false)$/i.test(token.value)) values[def.name] = token.value.toLowerCase() === 'true';
      else throw new ArgsError(`Flag '${token.rawName}' does not take a value`);
      continue;
    }
    if (token.value === undefined || (!token.inlineValue && /^-(?!\d|\.\d)/.test(token.value))) {
      throw new ArgsError(`Flag '${token.rawName}' needs a value`);
    }
    const value = convert(def, token.value);
    if (def.multiple) {
      const list = Array.isArray(values[def.name]) ? /** @type {unknown[]} */ (values[def.name]) : [];
      list.push(value);
      values[def.name] = list;
    } else values[def.name] = value;
  }

  for (const def of defs.values()) {
    if (given.has(def.name)) continue;
    if (def.default !== undefined) {
      values[def.name] = def.multiple && Array.isArray(def.default)
        ? def.default.map((d) => convert(def, d))
        : convert(def, def.default);
    } else if (def.type === 'boolean') values[def.name] = false;
    else if (def.multiple) values[def.name] = [];
  }

  // A declared `no-x` boolean also sets `x` (when `x` itself is not declared).
  for (const def of defs.values()) {
    if (def.type !== 'boolean' || !def.name.startsWith('no-')) continue;
    const base = def.name.slice(3);
    if (base && !defs.has(base)) values[base] = !values[def.name];
  }

  /** @type {Record<string, any>} */
  const flags = {};
  for (const [name, value] of Object.entries(values)) {
    flags[name] = value;
    flags[camel(name)] = value;
  }
  const command = positionals.length > 0 ? /** @type {string} */ (positionals.shift()) : null;
  return { command, positionals, flags, given: [...given] };
}

/**
 * Help lines for a flag spec: `  --budget <duration>   wall-clock budget (default 10m)`.
 * @param {FlagSpec | null | undefined} spec
 * @returns {string[]}
 */
export function flagHelp(spec) {
  const defs = [...normaliseSpec(spec).values()];
  const left = defs.map((d) => {
    const arg = d.type === 'boolean' ? '' : ` ${d.arg ?? `<${d.type === 'string' ? 'value' : d.type}>`}`;
    return `${d.short ? `-${d.short}, ` : ''}--${d.name}${arg}`;
  });
  const width = Math.max(0, ...left.map((l) => l.length));
  return defs.map((d, i) => {
    const hasDefault = d.default !== undefined && d.default !== null && d.default !== false;
    const dflt = hasDefault ? ` (default ${String(d.default)})` : '';
    return `  ${left[i].padEnd(width)}  ${d.summary ?? ''}${dflt}`.trimEnd();
  });
}
