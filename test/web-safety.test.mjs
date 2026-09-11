// @ts-check
/**
 * The banned-sink scan (DESIGN §10.8, §12.7): nothing in web/ or src/publish/ may use the
 * HTML-parsing sinks, evaluate strings as code, or set event-handler attributes; the explorer's
 * HTML carries no inline script, style or handler (the §10.1 CSP would block them anyway) and no
 * remote resource. It also checks the explorer's files against the conventions of §16.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Files under a directory of the project, recursively; none when it does not exist yet.
 * @param {string} rel
 * @param {RegExp} pattern
 * @returns {string[]} project-relative paths with forward slashes
 */
function filesUnder(rel, pattern) {
  const abs = path.join(ROOT, rel);
  if (!existsSync(abs)) return [];
  /** @type {string[]} */
  const out = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (pattern.test(d.name)) out.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  walk(abs);
  return out.sort();
}

/** The four sinks §10.8 bans, and three more that execute strings or set handlers. */
const BANNED = [
  [/\binnerHTML\b/, 'innerHTML'],
  [/\bouterHTML\b/, 'outerHTML'],
  [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
  [/\bdocument\s*\.\s*write(ln)?\b/, 'document.write'],
  [/\beval\s*\(/, 'eval()'],
  [/\bnew\s+Function\s*\(/, 'new Function()'],
  [/setAttribute\(\s*['"`]on/i, 'an event-handler attribute'],
];

test('web/ and src/publish/ never use the banned sinks', () => {
  const files = [...filesUnder('web', /\.(mjs|js|html)$/), ...filesUnder('src/publish', /\.(mjs|js|html)$/)];
  assert.ok(files.includes('web/render.mjs'), 'the scan sees the explorer');
  /** @type {string[]} */
  const found = [];
  for (const rel of files) {
    const lines = readFileSync(path.join(ROOT, rel), 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const [re, name] of BANNED) {
        if (/** @type {RegExp} */ (re).test(line)) found.push(`${rel}:${i + 1} uses ${name}`);
      }
    });
  }
  assert.deepEqual(found, []);
});

test('the explorer HTML has no inline script, style or handler, and no remote resource', () => {
  const pages = filesUnder('web', /\.html$/);
  assert.ok(pages.includes('web/index.html'));
  for (const rel of pages) {
    const html = readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${rel}: inline script`);
    assert.doesNotMatch(html, /<style\b/i, `${rel}: inline style element`);
    assert.doesNotMatch(html, /\sstyle\s*=/i, `${rel}: style attribute`);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i, `${rel}: event-handler attribute`);
    assert.doesNotMatch(html, /\b(src|href)\s*=\s*["']?(https?:)?\/\//i, `${rel}: remote resource`);
    assert.doesNotMatch(html, /javascript:/i, `${rel}: javascript: URL`);
  }
  const css = filesUnder('web', /\.css$/).map((rel) => readFileSync(path.join(ROOT, rel), 'utf8')).join('\n');
  assert.doesNotMatch(css, /@import|url\(\s*["']?(https?:)?\/\//i, 'no remote fonts or images');
});

test('the explorer follows §16: @ts-check first, lines of 110 characters at most, British spelling', () => {
  const files = [
    'server.mjs', 'src/core/taste.mjs', 'src/core/views.mjs', 'src/cli/serve.mjs', 'src/cli/feedback.mjs',
    'test/support/fake-dom.mjs', ...filesUnder('web', /\.(mjs|css|html)$/),
  ].filter((rel) => existsSync(path.join(ROOT, rel)));
  /** @type {string[]} */
  const problems = [];
  for (const rel of files) {
    const text = readFileSync(path.join(ROOT, rel), 'utf8');
    if (rel.endsWith('.mjs')) {
      const head = text.split('\n').filter((l) => !l.startsWith('#!'))[0];
      if (head !== '// @ts-check') problems.push(`${rel}: does not start with // @ts-check`);
    }
    text.split('\n').forEach((line, i) => {
      if (line.length > 110) problems.push(`${rel}:${i + 1} is ${line.length} characters long`);
    });
    const prose = text.replace(/(overscroll|scroll)-behavior/g, '');
    for (const word of ['behavior', 'favorite', 'analyze', 'initialize', 'artifact', 'honor']) {
      if (new RegExp(`\\b${word}`, 'i').test(prose)) problems.push(`${rel}: American spelling "${word}"`);
    }
  }
  assert.deepEqual(problems, []);
});
