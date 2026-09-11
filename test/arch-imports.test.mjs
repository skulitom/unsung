// @ts-check
/**
 * Enforces the layer rules of DESIGN §2 by parsing every static and dynamic import in src/, bin/,
 * tools/, web/ and server.mjs. Directories that do not exist yet are skipped, so the test passes on
 * a partial tree. It also checks that src/core/ never reaches for the clock, randomness, the network,
 * the process or the DOM.
 *
 * Interpretations where §2 is silent (see the report to the integrator):
 * - src/log.mjs and src/secrets.mjs are shared foundation, importable from every layer except
 *   src/core/ and web/ (§12.2 has src/github/ depend on secrets);
 * - src/publish/ may import node:* (it writes the export directory);
 * - server.mjs may import src/github/ (POST /api/add needs a client for addRepo);
 * - files §2 does not list (src/config.mjs, src/eval/, …) may import src/core/, the foundation
 *   modules and node:*; src/eval/ may also import src/store/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCAN = ['src', 'bin', 'tools', 'web', 'server.mjs'];
const SOURCE_EXT = /\.(mjs|js|cjs)$/;

// ---------------------------------------------------------------------------------------------
// A small JavaScript tokenizer: enough to find imports without being fooled by comments,
// strings, template literals or regular expressions.
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} Token
 * @property {'id' | 'str' | 'tpl' | 'num' | 'punct' | 'regex'} type
 * @property {string} value
 * @property {number} line
 * @property {boolean} [plain] a template literal without substitutions
 */

const REGEX_AFTER = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw',
  'case', 'do', 'else', 'yield', 'await', 'export', 'default', 'extends']);
const SPACE_CODES = new Set([0x20, 0x09, 0x0b, 0x0c, 0x0d, 0xa0, 0xfeff, 0x2028, 0x2029]);
/** @param {string} ch */
const wide = (ch) => ch.charCodeAt(0) >= 0x80 && !SPACE_CODES.has(ch.charCodeAt(0));
const ID_START = { test: (/** @type {string} */ ch) => /[A-Za-z_$]/.test(ch) || wide(ch) };
const ID_PART = { test: (/** @type {string} */ ch) => /[A-Za-z0-9_$]/.test(ch) || wide(ch) };
const SPACE = { test: (/** @type {string} */ ch) => SPACE_CODES.has(ch.charCodeAt(0)) };

/**
 * @param {string} src
 * @returns {Token[]}
 */
function tokenize(src) {
  /** @type {Token[]} */
  const tokens = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  /** @type {Token | null} */
  let prev = null;
  /** @type {number[]} brace depth inside each open template `${…}` */
  const templates = [];

  /**
   * @param {Token['type']} type
   * @param {string} value
   * @param {Partial<Token>} [extra]
   */
  const push = (type, value, extra = {}) => {
    const t = { type, value, line, ...extra };
    tokens.push(t);
    prev = t;
  };
  const regexAllowed = () => {
    const p = /** @type {Token | null} */ (prev);
    if (!p) return true;
    if (p.type === 'id') return REGEX_AFTER.has(p.value);
    if (p.type === 'punct') return p.value !== ')' && p.value !== ']';
    return false;
  };
  /**
   * Read template text from `start` up to the closing backtick or the next `${`.
   * @param {number} start
   * @param {boolean} continuing true after the `}` of a substitution
   * @returns {number}
   */
  const readTemplate = (start, continuing) => {
    let j = start;
    let text = '';
    const startLine = line;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\') {
        text += src[j + 1] ?? '';
        if (src[j + 1] === '\n') line++;
        j += 2;
        continue;
      }
      if (ch === '`') {
        if (!continuing) push('tpl', text, { plain: true, line: startLine });
        else prev = { type: 'tpl', value: '', line };
        return j + 1;
      }
      if (ch === '$' && src[j + 1] === '{') {
        if (!continuing) push('tpl', text, { plain: false, line: startLine });
        templates.push(0);
        return j + 2;
      }
      if (ch === '\n') line++;
      text += ch;
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = src[i];
    if (c === '\n') {
      line++;
      i++;
      continue;
    }
    if (SPACE.test(c)) {
      i++;
      continue;
    }
    if (c === '#' && i === 0 && src[1] === '!') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') line++;
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let value = '';
      while (j < n && src[j] !== c && src[j] !== '\n') {
        if (src[j] === '\\') {
          if (src[j + 1] === '\n') line++;
          else value += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        value += src[j];
        j++;
      }
      push('str', value);
      i = j + 1;
      continue;
    }
    if (c === '`') {
      i = readTemplate(i + 1, false);
      continue;
    }
    if (c === '}' && templates.length > 0 && templates[templates.length - 1] === 0) {
      templates.pop();
      i = readTemplate(i + 1, true);
      continue;
    }
    if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        const ch = src[j];
        if (ch === '\\') {
          j += 2;
          continue;
        }
        if (inClass) {
          if (ch === ']') inClass = false;
        } else if (ch === '[') inClass = true;
        else if (ch === '/') break;
        j++;
      }
      if (src[j] === '/') {
        j++;
        while (j < n && /[a-z]/i.test(src[j])) j++;
        push('regex', src.slice(i, j));
        i = j;
        continue;
      }
    }
    if (ID_START.test(c) || (c === '#' && ID_START.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j])) j++;
      push('id', src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(src[j])) j++;
      push('num', src.slice(i, j));
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) {
      push('punct', '...');
      i += 3;
      continue;
    }
    if (src.startsWith('?.', i) && !/[0-9]/.test(src[i + 2] ?? '')) {
      push('punct', '?.');
      i += 2;
      continue;
    }
    if (templates.length > 0) {
      if (c === '{') templates[templates.length - 1]++;
      else if (c === '}') templates[templates.length - 1]--;
    }
    push('punct', c);
    i++;
  }
  return tokens;
}

/** @typedef {{spec: string | null, line: number, kind: 'static' | 'dynamic' | 'reexport'}} Import */

/**
 * @param {Token | undefined} t
 * @param {string} value
 */
const isPunct = (t, value) => t !== undefined && t.type === 'punct' && t.value === value;

/**
 * @param {Token[]} tokens
 * @returns {Import[]}
 */
function importsOf(tokens) {
  /** @type {Import[]} */
  const out = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'id' || (t.value !== 'import' && t.value !== 'export')) continue;
    if (isPunct(tokens[k - 1], '.') || isPunct(tokens[k - 1], '?.')) continue;
    const next = tokens[k + 1];
    if (!next) continue;
    if (t.value === 'import') {
      if (isPunct(next, '.') || isPunct(next, ':')) continue; // import.meta, or a property named import
      if (isPunct(next, '(')) {
        const arg = tokens[k + 2];
        const close = tokens[k + 3];
        const literal = arg && (arg.type === 'str' || (arg.type === 'tpl' && arg.plain))
          && (isPunct(close, ')') || isPunct(close, ','));
        out.push({ spec: literal ? arg.value : null, line: t.line, kind: 'dynamic' });
        continue;
      }
      if (next.type === 'str') {
        out.push({ spec: next.value, line: t.line, kind: 'static' });
        continue;
      }
      for (let m = k + 1; m < Math.min(tokens.length, k + 400); m++) {
        const u = tokens[m];
        if (isPunct(u, ';')) break;
        if (u.type === 'id' && u.value === 'from' && tokens[m + 1]?.type === 'str') {
          out.push({ spec: tokens[m + 1].value, line: t.line, kind: 'static' });
          break;
        }
      }
      continue;
    }
    // export * from '…' · export * as ns from '…' · export { a, b as c } from '…'
    let m = k + 1;
    if (isPunct(next, '*')) {
      m++;
      if (tokens[m]?.type === 'id' && tokens[m].value === 'as') m += 2;
    } else if (isPunct(next, '{')) {
      while (m < tokens.length && !isPunct(tokens[m], '}')) m++;
      m++;
    } else continue;
    if (tokens[m]?.type === 'id' && tokens[m].value === 'from' && tokens[m + 1]?.type === 'str') {
      out.push({ spec: tokens[m + 1].value, line: t.line, kind: 'reexport' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The layer table (§2)
// ---------------------------------------------------------------------------------------------

const FOUNDATION = ['src/log.mjs', 'src/secrets.mjs', 'src/config.mjs'];
const SHARED = ['src/log.mjs', 'src/secrets.mjs'];

/**
 * @param {string} rel
 * @param {...string} prefixes
 * @returns {boolean}
 */
const under = (rel, ...prefixes) => prefixes.some((p) => rel.startsWith(p));

/**
 * @typedef {object} Rule
 * @property {(rel: string) => boolean} targets which project files may be imported
 * @property {boolean | ((name: string) => boolean)} builtins whether node:* modules may be imported
 * @property {string} text the rule, for messages
 */

/** @type {Record<string, Rule>} */
const RULES = {
  core: {
    targets: (r) => under(r, 'src/core/'), builtins: false,
    text: 'src/core/ may import only other src/core/ modules',
  },
  github: {
    targets: (r) => under(r, 'src/core/', 'src/github/', 'src/sources/') || SHARED.includes(r),
    builtins: true,
    text: 'src/github/ and src/sources/ may import src/core/, src/log.mjs, src/secrets.mjs and node:*',
  },
  store: {
    targets: (r) => under(r, 'src/core/', 'src/store/') || SHARED.includes(r), builtins: true,
    text: 'src/store/ may import src/core/ and node:*',
  },
  pipeline: {
    targets: (r) => !under(r, 'web/', 'src/llm/', 'src/publish/'),
    builtins: (name) => name !== 'child_process' && name !== 'cluster',
    text: 'src/pipeline/ may import everything except web/, src/llm/ and src/publish/, '
      + 'and never spawns processes',
  },
  llm: {
    targets: (r) => under(r, 'src/core/', 'src/github/', 'src/store/', 'src/llm/') || SHARED.includes(r),
    builtins: true,
    text: 'src/llm/ may import src/core/, src/github/, src/store/ and node:*',
  },
  publish: {
    targets: (r) => under(r, 'src/core/', 'src/store/', 'src/github/', 'src/publish/') || SHARED.includes(r),
    builtins: true,
    text: 'src/publish/ may import src/core/, src/store/ and src/github/',
  },
  web: {
    targets: (r) => under(r, 'src/core/', 'web/'), builtins: false,
    text: 'web/ may import only src/core/ and other web/ modules',
  },
  server: {
    targets: (r) => under(r, 'src/core/', 'src/store/', 'src/github/')
      || ['src/pipeline/add.mjs', 'src/config.mjs', ...SHARED].includes(r),
    builtins: true,
    text: 'server.mjs may import src/core/, src/store/, src/github/, src/pipeline/add.mjs, src/config.mjs, '
      + 'src/log.mjs and node:*',
  },
  shell: {
    targets: (r) => !under(r, 'web/'), builtins: true,
    text: 'bin/, src/cli/ and tools/ may import anything except web/',
  },
  eval: {
    targets: (r) => under(r, 'src/core/', 'src/eval/', 'src/store/') || FOUNDATION.includes(r),
    builtins: true,
    text: 'src/eval/ may import src/core/, src/store/, the foundation modules and node:*',
  },
  other: {
    targets: (r) => under(r, 'src/core/') || FOUNDATION.includes(r), builtins: true,
    text: 'shared src/ modules may import src/core/, the foundation modules and node:*',
  },
};

/**
 * @param {string} rel project-relative path with forward slashes
 * @returns {keyof typeof RULES}
 */
function layerOf(rel) {
  if (under(rel, 'src/core/')) return 'core';
  if (under(rel, 'src/github/', 'src/sources/')) return 'github';
  if (under(rel, 'src/store/')) return 'store';
  if (under(rel, 'src/pipeline/')) return 'pipeline';
  if (under(rel, 'src/llm/')) return 'llm';
  if (under(rel, 'src/publish/')) return 'publish';
  if (under(rel, 'src/eval/')) return 'eval';
  if (under(rel, 'web/')) return 'web';
  if (rel === 'server.mjs') return 'server';
  if (under(rel, 'bin/', 'src/cli/', 'tools/')) return 'shell';
  return 'other';
}

/**
 * The violation an import makes, or null.
 * @param {string} fromRel
 * @param {Import} imp
 * @returns {string | null}
 */
function checkImport(fromRel, imp) {
  const layer = layerOf(fromRel);
  const rule = RULES[layer];
  const where = `${fromRel}:${imp.line}`;
  if (imp.spec === null) {
    if (layer === 'shell') return null;
    return `${where} uses import() with a computed specifier, which cannot be checked`;
  }
  const spec = imp.spec.replace(/[?#].*$/, '');
  if (spec.startsWith('node:')) {
    const name = spec.slice(5).split('/')[0];
    const ok = typeof rule.builtins === 'function' ? rule.builtins(name) : rule.builtins;
    return ok ? null : `${where} imports ${spec}: ${rule.text}`;
  }
  const isUrl = /^[a-z][a-z0-9+.-]*:/i.test(spec);
  if (isUrl && !spec.startsWith('file:')) return `${where} imports the URL ${spec}`;
  const isPath = ['./', '../', '/', 'file:'].some((prefix) => spec.startsWith(prefix));
  if (!isPath) {
    if (builtinModules.includes(spec.split('/')[0])) return `${where} imports '${spec}': write node:${spec}`;
    const backends = fromRel === 'src/llm/backends.mjs' && imp.kind === 'dynamic';
    if (backends && spec === '@anthropic-ai/sdk') return null;
    return `${where} imports the package '${spec}': Unsung has no dependencies `
      + "(the one exception is import('@anthropic-ai/sdk') in src/llm/backends.mjs)";
  }
  const abs = spec.startsWith('file:')
    ? fileURLToPath(spec)
    : path.resolve(ROOT, path.dirname(fromRel), spec);
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) {
    return `${where} imports ${spec}, outside the project`;
  }
  return rule.targets(rel) ? null : `${where} imports ${rel}: ${rule.text}`;
}

const DOM_GLOBALS = ['document', 'window', 'localStorage', 'navigator'];
const RANDOM_CRYPTO = new Set(['randomUUID', 'getRandomValues']);

/**
 * Things src/core/ must never do (§2): read the clock or randomness, call fetch, touch the process
 * or the DOM, or use require().
 * @param {string} fromRel
 * @param {Token[]} tokens
 * @returns {string[]}
 */
function coreGlobals(fromRel, tokens) {
  /** @type {string[]} */
  const out = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type !== 'id') continue;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    const member = isPunct(prev, '.') || isPunct(prev, '?.');
    const prop = isPunct(next, '.') && tokens[k + 2]?.type === 'id' ? tokens[k + 2].value : null;
    const where = `${fromRel}:${t.line}`;
    if (member) continue;
    const afterNew = prev?.type === 'id' && prev.value === 'new';
    const bareNewDate = t.value === 'new' && next?.value === 'Date'
      && isPunct(tokens[k + 2], '(') && isPunct(tokens[k + 3], ')');
    /** @type {string | null} */
    let what = null;
    if (t.value === 'fetch' && isPunct(next, '(')) what = 'calls fetch()';
    else if (t.value === 'Date' && prop === 'now') what = 'reads Date.now()';
    else if (t.value === 'Date' && isPunct(next, '(') && !afterNew) what = 'calls Date()';
    else if (bareNewDate) what = 'reads the clock with new Date()';
    else if (t.value === 'Math' && prop === 'random') what = 'reads Math.random()';
    else if (t.value === 'performance' && prop === 'now') what = 'reads performance.now()';
    else if (t.value === 'crypto' && RANDOM_CRYPTO.has(String(prop))) what = `reads crypto.${prop}()`;
    else if (DOM_GLOBALS.includes(t.value) && prop) what = `touches the DOM (${t.value})`;
    else if (t.value === 'process' && prop) what = `touches process.${prop}`;
    else if (t.value === 'require' && isPunct(next, '(')) what = 'uses require()';
    if (what) out.push(`${where} ${what}`);
  }
  return out;
}

/**
 * Every layer violation in one source file.
 * @param {string} rel
 * @param {string} src
 * @returns {string[]}
 */
function violations(rel, src) {
  const tokens = tokenize(src);
  const out = importsOf(tokens).map((imp) => checkImport(rel, imp)).filter((v) => v !== null);
  if (layerOf(rel) === 'core') out.push(...coreGlobals(rel, tokens));
  return /** @type {string[]} */ (out);
}

/** @returns {string[]} project-relative source files under the scanned roots that exist */
function listSources() {
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      if (d.name === 'node_modules' || d.name.startsWith('.')) continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (SOURCE_EXT.test(d.name)) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  for (const entry of SCAN) {
    const abs = path.join(ROOT, entry);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) walk(abs);
    else if (SOURCE_EXT.test(entry)) out.push(entry);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} src
 * @returns {(string | null)[]}
 */
const specs = (src) => importsOf(tokenize(src)).map((i) => i.spec);

test('the parser finds static, re-exported and dynamic imports', () => {
  const src = `#!/usr/bin/env node
import a from './a.mjs';
import { b, c as d } from "./b.mjs";
import * as e from './e.mjs';
import './side-effect.mjs';
import {
  f,
  g,
} from './multi.mjs';
export * from './star.mjs';
export * as ns from './ns.mjs';
export { h } from './h.mjs';
export { local };
export const x = 1;
const lazy = () => import('./lazy.mjs');
const tpl = () => import(\`./tpl.mjs\`);
const attrs = await import('./data.json', { with: { type: 'json' } });
const computed = (name) => import(\`./cli/\${name}.mjs\`);
const other = import(path);
const meta = import.meta.url;
const obj = { import: 1 }; obj.import('./not-an-import.mjs');
`;
  assert.deepEqual(specs(src), [
    './a.mjs', './b.mjs', './e.mjs', './side-effect.mjs', './multi.mjs', './star.mjs', './ns.mjs', './h.mjs',
    './lazy.mjs', './tpl.mjs', './data.json', null, null,
  ]);
});

test('comments, strings, templates and regular expressions do not fool the parser', () => {
  const src = `
// import nope from 'node:fs';
/* import nope from 'node:http'; */
/** @typedef {import('../store/store.mjs').Store} Store */
const s = "import x from 'node:net'";
const t = \`import y from 'node:dns' \${ "}" } still text \${ { a: '\`' }.a }\`;
const r = /import ['"]node:os['"]/g;
const q = a / b / c;
const cls = /[/'"]/;
import real from './real.mjs';
`;
  assert.deepEqual(specs(src), ['./real.mjs']);
});

test('the layer rules of §2 are applied', () => {
  /**
   * @param {string} rel
   * @param {string} src
   */
  const bad = (rel, src) => violations(rel, src).length > 0;
  assert.ok(bad('src/core/x.mjs', "import fs from 'node:fs';"));
  assert.ok(bad('src/core/x.mjs', "import { s } from '../store/store.mjs';"));
  assert.ok(bad('src/core/x.mjs', "import { l } from '../log.mjs';"));
  assert.ok(!bad('src/core/x.mjs', "import { sat } from './util.mjs';"));

  assert.ok(!bad('src/github/client.mjs', "import { redact } from '../secrets.mjs'; "
    + "import https from 'node:https'; import { g } from './governor.mjs';"));
  assert.ok(!bad('src/sources/census.mjs',
    "import { s } from '../github/search.mjs'; import { l } from '../log.mjs';"));
  assert.ok(bad('src/github/client.mjs', "import { openStore } from '../store/store.mjs';"));
  assert.ok(bad('src/store/store.mjs', "import { c } from '../github/client.mjs';"));
  assert.ok(!bad('src/store/store.mjs',
    "import zlib from 'node:zlib'; import { v } from '../core/schema.mjs';"));

  assert.ok(!bad('src/pipeline/run.mjs',
    "import { c } from '../github/client.mjs'; import { s } from '../store/store.mjs';"));
  assert.ok(bad('src/pipeline/run.mjs', "import { p } from '../llm/pack.mjs';"));
  assert.ok(bad('src/pipeline/run.mjs', "import { g } from '../publish/gallery.mjs';"));
  assert.ok(bad('src/pipeline/run.mjs', "import { spawn } from 'node:child_process';"));

  assert.ok(!bad('src/llm/backends.mjs', "const loadSdk = () => import('@anthropic-ai/sdk');"));
  assert.ok(bad('src/llm/backends.mjs', "import Anthropic from '@anthropic-ai/sdk';"));
  assert.ok(bad('src/llm/review.mjs', "const m = await import('@anthropic-ai/sdk');"));
  assert.ok(bad('src/llm/review.mjs', "import { run } from '../pipeline/run.mjs';"));
  assert.ok(!bad('src/llm/review.mjs',
    "import { c } from '../github/client.mjs'; import { spawn } from 'node:child_process';"));

  assert.ok(!bad('src/publish/gallery.mjs',
    "import fs from 'node:fs'; import { s } from '../store/store.mjs';"));
  assert.ok(bad('src/publish/gallery.mjs', "import { p } from '../pipeline/run.mjs';"));

  assert.ok(!bad('web/app.mjs',
    "import { shelf } from '../src/core/views.mjs'; import { el } from './render.mjs';"));
  assert.ok(bad('web/app.mjs', "import fs from 'node:fs';"));
  assert.ok(bad('web/app.mjs', "import { s } from '../src/store/store.mjs';"));

  assert.ok(!bad('server.mjs',
    "import { addRepo } from './src/pipeline/add.mjs'; import http from 'node:http';"));
  assert.ok(bad('server.mjs', "import { run } from './src/pipeline/run.mjs';"));
  assert.ok(bad('server.mjs', "import { x } from './web/app.mjs';"));

  assert.ok(!bad('bin/unsung.mjs', 'const m = await import(url);'));
  assert.ok(!bad('src/cli/run.mjs',
    "import { run } from '../pipeline/run.mjs'; import { r } from '../llm/review.mjs';"));
  assert.ok(bad('bin/unsung.mjs', "import { x } from '../web/app.mjs';"));
  assert.ok(bad('src/pipeline/run.mjs', 'const m = await import(name);'));

  assert.ok(bad('src/store/store.mjs', "import fs from 'fs';"));
  assert.match(violations('src/store/store.mjs', "import fs from 'fs';")[0], /write node:fs/);
  assert.ok(bad('tools/x.mjs', "import y from 'left-pad';"));
  assert.ok(bad('src/github/x.mjs', "import y from 'https://example.com/y.mjs';"));
  assert.ok(bad('src/github/x.mjs', "import y from '../../../elsewhere.mjs';"));
});

test('src/core/ never reads the clock, randomness, network, process or DOM', () => {
  /** @param {string} src */
  const found = (src) => violations('src/core/x.mjs', src);
  for (const src of ['const t = Date.now();', 'const r = Math.random();', 'await fetch(url);',
    'const d = new Date();',
    'const s = Date();', 'document.createElement("a");', 'window.location.hash;', 'process.env.HOME;',
    'performance.now();', 'crypto.randomUUID();', 'const m = require("x");']) {
    assert.equal(found(src).length, 1, src);
  }
  for (const src of ['Date.parse(iso);', 'new Date(iso).getTime();', 'deps.fetch(url);',
    '// Date.now() is banned',
    'const windows = 3;', 'const s = "Math.random()";', 'x.process.y;']) {
    assert.deepEqual(found(src), [], src);
  }
});

test('the source tree obeys the layer rules of §2', () => {
  const files = listSources();
  assert.ok(files.includes('src/core/schema.mjs'), 'the scan should see the foundation');
  assert.ok(files.includes('bin/unsung.mjs'));
  /** @type {string[]} */
  const problems = [];
  for (const rel of files) problems.push(...violations(rel, readFileSync(path.join(ROOT, rel), 'utf8')));
  assert.deepEqual(problems, [], `Layer violations:\n${problems.join('\n')}`);
});
