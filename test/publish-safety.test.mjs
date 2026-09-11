// @ts-check
/**
 * End-to-end safety of everything `unsung export` and `unsung digest` write (DESIGN §7.6, §11.2,
 * §13 WP7): a whole site and a digest are built from a repository whose every field carries hostile
 * text, and every generated page and feed is audited tag by tag and attribute by attribute. Anything
 * the generators did not mean to write (a script, an event handler, an unquoted or unknown
 * attribute, a javascript: link, a raw control character) fails the test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGallery } from '../src/publish/gallery.mjs';
import { buildDigest } from '../src/publish/digest.mjs';
import { langFromHash } from '../src/publish/assets/gallery.mjs';

const NOW = '2026-09-11T12:00:00.000Z';

/** @param {number} cp */
const ch = (cp) => String.fromCodePoint(cp);

/** Hostile text: markup, an entity, a bidi override, a NUL, a CDATA end and a comment opener. */
const H = `"><script>alert(1)</script><img src=x onerror=alert(1)>'&amp;${ch(0x202e)}${ch(0)}]]><!--`;

const HTML_TAGS = new Set(['!doctype', 'html', 'head', 'meta', 'title', 'link', 'script', 'body', 'header',
  'main', 'footer', 'nav', 'section', 'article', 'figure', 'figcaption', 'blockquote', 'h1', 'h2', 'p', 'a',
  'ul', 'ol', 'li', 'code', 'strong', 'span', 'time', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'div']);
const HTML_ATTRS = new Set(['lang', 'charset', 'name', 'content', 'http-equiv', 'property', 'rel', 'href',
  'type', 'title', 'src', 'class', 'dir', 'hidden', 'aria-label', 'data-family', 'data-family-label',
  'datetime', 'scope']);
const XML_TAGS = new Set(['feed', 'id', 'title', 'subtitle', 'updated', 'link', 'author', 'name', 'generator',
  'entry', 'published', 'content']);
const XML_ATTRS = new Set(['xmlns', 'xml:lang', 'type', 'rel', 'href']);

/**
 * Every tag and attribute in a generated document, checked against allowlists.
 * @param {string} doc
 * @param {string} file
 * @param {{tags: Set<string>, attrs: Set<string>, xml: boolean}} rules
 * @returns {string[]} problems
 */
function audit(doc, file, { tags, attrs, xml }) {
  /** @type {string[]} */
  const problems = [];
  for (const c of doc) {
    const cp = /** @type {number} */ (c.codePointAt(0));
    const control = (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13) || (cp >= 0x7f && cp <= 0x9f);
    const bidi = (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069);
    const surrogate = cp >= 0xd800 && cp <= 0xdfff;
    if (control || bidi || surrogate) problems.push(`${file}: character U+${cp.toString(16)}`);
  }
  if (/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/.test(doc)) problems.push(`${file}: a bare ampersand`);
  let body = doc;
  if (xml) {
    const declared = doc.startsWith('<?xml version="1.0" encoding="utf-8"?>\n');
    if (!declared) problems.push(`${file}: no XML declaration`);
    body = doc.slice(doc.indexOf('\n') + 1);
  }
  let i = 0;
  while ((i = body.indexOf('<', i)) !== -1) {
    const end = body.indexOf('>', i);
    if (end < 0) {
      problems.push(`${file}: unclosed tag`);
      break;
    }
    const inner = body.slice(i + 1, end);
    const m = /^(\/?)([!a-zA-Z][a-zA-Z0-9:-]*)/.exec(inner);
    if (!m) {
      problems.push(`${file}: stray < before "${inner.slice(0, 30)}"`);
      i = end + 1;
      continue;
    }
    const name = m[2].toLowerCase();
    if (!tags.has(name)) problems.push(`${file}: tag <${name}>`);
    if (!m[1] && name !== '!doctype') {
      const rest = inner.slice(m[0].length).replace(/\/$/, '');
      const attr = /\s+([a-zA-Z][a-zA-Z0-9:-]*)(?:="([^"]*)")?/y;
      let pos = 0;
      for (let am = attr.exec(rest); am; am = attr.exec(rest)) {
        pos = attr.lastIndex;
        const [, an, av] = am;
        if (!attrs.has(an.toLowerCase())) problems.push(`${file}: attribute ${an} on <${name}>`);
        const scheme = av !== undefined && /^\s*(javascript|data|vbscript):/i.test(av);
        if ((an === 'href' || an === 'src') && scheme) {
          problems.push(`${file}: ${an}="${av.slice(0, 30)}"`);
        }
      }
      const leftover = rest.slice(pos).trim();
      if (leftover !== '') problems.push(`${file}: malformed attributes "${leftover.slice(0, 40)}"`);
      if (name === 'script') {
        const ours = / src="(\.\.\/)*assets\/gallery\.mjs"/.test(rest);
        if (!ours) problems.push(`${file}: a script that is not ours`);
        if (!body.startsWith('</script>', end + 1)) problems.push(`${file}: an inline script`);
      }
    }
    i = end + 1;
  }
  return problems;
}

/**
 * A repository record in which every field that can reach a page carries hostile text.
 * @returns {any}
 */
function hostileRecord() {
  const nwo = 'octo/tool';
  const id = 'R_hostile';
  const signal = (/** @type {string} */ sid, /** @type {number} */ points) => ({
    id: sid, kind: points < 0 ? 'slop' : 'quality', status: 'ok', hit: true, value: null, weight: points,
    points, strength: null, group: null, provisional: false, cost: 'cheap', label: `Label ${H}`,
    reason: `Reason ${H}`,
    evidence: [
      { label: `Evidence ${H}`, url: `https://github.com/${nwo}/blob/abc/"><script>alert(1)</script>` },
      { label: 'bad', url: 'javascript:alert(1)' },
    ],
  });
  return {
    v: 1, id, nwo,
    candidate: { v: 1, id, nwo, day: '2026-08-01', createdAt: '2026-08-01T00:00:00Z', state: 'enriched' },
    facts: {
      v: 1, id, nwo, owner: 'octo', name: 'tool', createdAt: '2026-08-01T00:00:00Z', description: `Desc ${H}`,
      primaryLanguage: `Lang ${H}`, stars: 0, homepageUrl: 'javascript:alert(document.cookie)',
      hasIssues: true, hasDiscussions: false, releases: { count: 2, recent: [] }, tags: 2, headOid: 'abc',
      funding: [{ platform: 'CUSTOM', url: 'https://x.example/"><script>alert(1)</script>' }],
      readme: { name: 'README.md', bytes: 40, truncated: false, text: '```\nnpm i tool"><script>\n```' },
      packageJson: { name: 'tool', scripts: ['dev'] }, manifest: null,
      ownerInfo: { login: 'octo', type: 'User', sponsorsListing: false },
    },
    score: {
      v: 1, id, nwo, headOid: 'abc', scoredAt: NOW, model: { weights: 'w1', calibration: 'c1', rubric: null },
      signals: [signal('q.release', 1), signal('q.tests', 1), signal('s.junk', -1)],
      S: 1, pointsMax: 2, coverage: 1, quality: 0.5, band: 'low',
      confidence: { k: 0.1, band: `low${H}`, items: [] },
      attention: { stars: 0, forks: 0, watchers: 0, gain4w: null, a: 0 },
      gem: 1, lane: 'promising', gates: [], descriptors: [],
    },
    firstSeen: null, history: [],
    verdict: { status: 'ok', output: { flags: [], pitch: `Pitch ${H}` } },
    checkedAt: NOW, gone: false,
  };
}

test('every page and feed built from hostile text is exactly what the generators meant', async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'unsung-wp7-safety-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'site');
  const rec = hostileRecord();
  const store = {
    readFeedback: async () => [
      { v: 1, at: '2026-09-05T10:00:00Z', id: rec.id, nwo: rec.nwo, action: 'gem', label: 'G', reason: null,
        note: `Gem ${H}`, blind: false, undoes: null, snoozeUntil: null, context: null },
      { v: 1, at: '2026-09-05T10:01:00Z', id: rec.id, nwo: rec.nwo, action: 'publish', label: null,
        reason: null, note: `Note ${H}\n\nSecond ${H}`, blind: false, undoes: null, snoozeUntil: null,
        context: { stars: 0 } },
    ],
    readOptOut: async () => null,
    getRepoById: async () => rec,
  };
  const client = {
    graphql: async (/** @type {string} */ _doc, /** @type {any} */ vars) => ({
      data: { nodes: vars.ids.map(() => ({ id: rec.id, nameWithOwner: rec.nwo, stargazerCount: 1,
        owner: { login: 'octo' }, releases: { totalCount: 1, nodes: [{ tagName: `v1${H}`, publishedAt: NOW,
          isPrerelease: false }] } })) },
    }),
  };
  const result = await buildGallery({
    store, client, outDir: out, now: NOW, title: `Picks ${H}`,
    siteUrl: 'https://you.github.io/pi"cks/', issuesUrl: 'https://github.com/you/picks/issues?q="<x>"',
  });
  assert.equal(result.entries.length, 1);

  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const files = [];
  /** @param {string} d */
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(out);
  for (const file of files) {
    const rel = path.relative(out, file).split(path.sep).join('/');
    const text = readFileSync(file, 'utf8');
    const htmlRules = { tags: HTML_TAGS, attrs: HTML_ATTRS, xml: false };
    const xmlRules = { tags: XML_TAGS, attrs: XML_ATTRS, xml: true };
    if (rel.endsWith('.html')) problems.push(...audit(text, rel, htmlRules));
    if (rel.endsWith('.xml')) problems.push(...audit(text, rel, xmlRules));
  }
  assert.deepEqual(problems, []);
  const gemFile = path.join('r', 'octo', 'tool', 'index.html');
  assert.ok(files.some((f) => f.endsWith('.xml')) && files.some((f) => f.endsWith(gemFile)));

  const page = readFileSync(path.join(out, 'r', 'octo', 'tool', 'index.html'), 'utf8');
  assert.ok(page.includes('Desc &quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'),
    'the text is shown, escaped');
  assert.ok(!page.includes('javascript:'), 'a javascript: homepage never becomes a link or a demo rung');
  assert.ok(!page.includes('<strong>Try it:</strong>'), 'a README command with markup in it is not offered');
  assert.ok(page.includes('https://x.example/%22%3E%3Cscript%3Ealert(1)%3C/script%3E'));

  const gallery = JSON.parse(readFileSync(path.join(out, 'data', 'gallery.json'), 'utf8'));
  const entry = { ...gallery.entries[0], releasesSince: 1, latestRelease: `v1${H}` };
  const digest = buildDigest({
    week: '2026-W36', picks: [entry], fourWeeksAgo: [entry], siteUrl: gallery.siteUrl, title: `Picks ${H}`,
  });
  assert.deepEqual(audit(digest.html, 'digest.html', { tags: HTML_TAGS, attrs: HTML_ATTRS, xml: false }), []);
  assert.doesNotMatch(digest.markdown, /(^|[^\\])<[a-z!/]/im, 'no unescaped markup in the Markdown digest');
  assert.doesNotMatch(digest.markdown, /\]\((?!https:\/\/)/, 'every Markdown link goes to an https address');
});

test('the gallery script reads only a well-formed language from the URL hash', () => {
  assert.equal(langFromHash('#lang=rust'), 'rust');
  assert.equal(langFromHash('#x=1&lang=c-cpp'), 'c-cpp');
  assert.equal(langFromHash('#lang=<script>'), null);
  assert.equal(langFromHash(''), null);
});
