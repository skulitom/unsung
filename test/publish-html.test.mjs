// @ts-check
/**
 * Tests for src/publish/html.mjs (DESIGN §11.2, §10.8, §7.6): escaping, text cleaning, the link
 * rules, the page shell and the safe-block renderer; plus a scan that keeps HTML-injection sinks out
 * of src/publish/.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAGE_CSP, blocksToHtml, cleanText, escapeAttr, escapeHtml, externalLink, formatDate, page, plural, safeUrl,
  siteLink,
} from '../src/publish/html.mjs';
import { toSafeBlocks } from '../src/core/readme.mjs';
import { UNSAFE_LINK_EXTENSIONS, safeLinkUrl } from '../src/core/views.mjs';
import { isSafeUrl } from '../web/render.mjs';

/** Links to archives, executables and download hosts, however they are dressed up: never anchors. */
const NEVER_LINKED = [
  'https://www.mediafire.com/file/abc123/Setup.zip/file', 'https://example.com/tool.exe/',
  'https://example.com/tool.exe.', 'https://example.com/tool.exe%00', 'https://example.com/tool.exe%20',
  'https://example.com/tool.EXE%20.%20/', 'https://example.com/get/Setup.zip/file',
  'https://example.com/tool.tar.gz', 'https://example.com/tool.zst', 'https://example.com/tool.exe;v=1',
  'https://example.com/tool.exe%00.txt', 'https://example.com/a%2Fb.exe%2F', 'https://example.com/%E0%A4%A',
  'https://bit.ly/abc', 'https://mega.nz/file/abc#key', 'https://dl.dropbox.com/s/x/notes.txt',
  'https://mediafire.com./file/x', 'https://WWW.MEDIAFIRE.COM/file/x',
];

/** Ordinary pages, including ones whose names merely mention an archive: still links. */
const LINKABLE = [
  'https://github.com/o/r', 'https://x.dev/docs/', 'https://example.com/zip-tools/', 'https://x.dev/zip',
  'https://x.dev/a.html?download=file.zip', 'https://notmediafire.com/x', 'https://example.com/exe/',
  'https://example.com/a.zip.html',
];

test('one link rule for the gallery and the explorer: archives, executables and download hosts stay text',
  () => {
    for (const url of NEVER_LINKED) {
      assert.equal(safeLinkUrl(url), null, url);
      assert.equal(safeUrl(url), null, url);
      assert.equal(isSafeUrl(url), false, url);
    }
    for (const url of LINKABLE) {
      assert.equal(safeUrl(url), new URL(url).href, url);
      assert.equal(isSafeUrl(url), true, url);
    }
    for (const url of [...NEVER_LINKED, ...LINKABLE]) {
      assert.equal(isSafeUrl(url), safeUrl(url) !== null, `parity: ${url}`);
      assert.equal(safeUrl(url), safeLinkUrl(url), `parity: ${url}`);
    }
    for (const ext of ['.zip', '.exe', '.tar.gz', '.zst', '.sh', '.appimage', '.msix']) {
      assert.ok(UNSAFE_LINK_EXTENSIONS.includes(ext), ext);
    }
  });

test('blocksToHtml gives a README\'s MediaFire download link no href', () => {
  const md = 'Download: [Setup](https://www.mediafire.com/file/abc123/Setup.zip/file) or '
    + '[mirror](https://example.com/tool.exe/), and [docs](https://x.dev/docs/)';
  const html = blocksToHtml(toSafeBlocks(md));
  assert.deepEqual([...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]), ['https://x.dev/docs/']);
  assert.ok(html.includes('Setup (https://www.mediafire.com/file/abc123/Setup.zip/file)'));
  assert.ok(html.includes('mirror (https://example.com/tool.exe/)'));
});

/** @param {number} cp */
const ch = (cp) => String.fromCodePoint(cp);
const NUL = ch(0);
const BEL = ch(7);
const NEL = ch(0x85);
const RLO = ch(0x202e);
const LRI = ch(0x2066);
const ZWSP = ch(0x200b);
const ZWJ = ch(0x200d);
const BOM = ch(0xfeff);
const LONE_SURROGATE = String.fromCharCode(0xd800);

test('escapeHtml escapes the five special characters', () => {
  assert.equal(escapeHtml('<a href="x" title=\'y\'>&</a>'),
    '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeHtml('&amp;'), '&amp;amp;');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(42), '42');
});

test('escapeHtml drops control characters, lone surrogates and bidi overrides, keeping real text', () => {
  assert.equal(escapeHtml(`a${NUL}b${BEL}c${NEL}d${RLO}e${LRI}f${LONE_SURROGATE}g`), 'abcdefg');
  assert.equal(escapeHtml('tab\tline\nend'), 'tab\tline\nend');
  const family = `x${ch(0x1f468)}${ZWJ}${ch(0x1f469)}y`;
  assert.equal(escapeHtml(family), family);
  assert.equal(escapeHtml('Привет, 世界, مرحبا'), 'Привет, 世界, مرحبا');
});

test('escapeAttr also escapes backticks and line breaks', () => {
  assert.equal(escapeAttr('a`b\nc\r\td"e'), 'a&#96;b&#10;c&#13;&#9;d&quot;e');
});

test('cleanText removes invisible characters, folds whitespace and caps the length', () => {
  assert.equal(cleanText(`a${ZWSP}b${BOM}c${RLO}d${NUL}e`), 'abcde');
  assert.equal(cleanText(`keep${ZWJ}this`), `keep${ZWJ}this`);
  assert.equal(cleanText('  one\n\n two  ', { singleLine: true }), 'one two');
  assert.equal(cleanText('line one\r\nline two'), 'line one\nline two');
  assert.equal(cleanText('abcdefghij', { maxChars: 5 }), 'abcd…');
  assert.equal([...cleanText('x'.repeat(500), { maxChars: 300 })].length, 300);
  assert.equal(cleanText(null), '');
});

test('safeUrl allows only plain https links that are not archives or executables', () => {
  assert.equal(safeUrl('https://github.com/o/r'), 'https://github.com/o/r');
  assert.equal(safeUrl('  https://example.com/zip-tools/  '), 'https://example.com/zip-tools/');
  const bad = [
    'http://example.com', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>',
    'ftp://x/y',
    '//github.com/o/r', '/relative', 'docs/x.md', '', '   ', null, 42, 'https://user:pass@example.com/',
    'https://example.com/payload.zip', 'https://example.com/setup.EXE', 'https://example.com/run.ps1?x=1',
    'https://example.com/a%2Ezip', 'https://cdn.example.com/tool.tar.gz', 'https://example.com/install.sh',
    'https://example.com/app.apk#frag',
  ];
  for (const url of bad) assert.equal(safeUrl(url), null, String(url));
});

test('siteLink and externalLink', () => {
  assert.equal(siteLink('r/o/n/', 'o/n'), '<a href="r/o/n/">o/n</a>');
  assert.equal(siteLink('x" onclick="y', '<b>'), '<a href="x&quot; onclick=&quot;y">&lt;b&gt;</a>');
  assert.equal(externalLink('https://github.com/o/r', 'o/r'),
    '<a href="https://github.com/o/r" rel="noopener">o/r</a>');
  assert.equal(externalLink('https://x.dev', 'demo', { ugc: true }),
    '<a href="https://x.dev/" rel="noopener nofollow ugc">demo</a>');
  assert.equal(externalLink('javascript:alert(1)', '<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
  assert.equal(externalLink('https://example.com/a.exe', 'get'), 'get');
});

test('formatDate and plural speak British English', () => {
  assert.equal(formatDate('2026-09-11T10:00:00Z'), '11 September 2026');
  assert.equal(formatDate('2026-01-01T00:00:00.000Z'), '1 January 2026');
  assert.equal(formatDate('not a date'), '');
  assert.equal(formatDate(null), '');
  assert.equal(plural(1, 'star'), '1 star');
  assert.equal(plural(0, 'star'), '0 stars');
  assert.equal(plural(1234, 'star'), '1,234 stars');
  assert.equal(plural(null, 'star'), 'an unknown number of stars');
});

test('page() builds a complete document with a strict policy and escaped metadata', () => {
  const html = page({
    title: 'T <script>',
    description: 'D "quoted"',
    canonical: 'https://you.github.io/picks/',
    body: '<p>x</p>',
    assetsBase: '../../../',
    scripts: ['assets/gallery.mjs'],
    feeds: [{ title: 'Feed', href: '../../../feed.xml' }],
  });
  assert.match(html, /^<!doctype html>\n<html lang="en-GB">\n<head>\n<meta charset="utf-8">/);
  assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${escapeAttr(PAGE_CSP)}">`));
  assert.ok(html.includes('<title>T &lt;script&gt;</title>'));
  assert.ok(html.includes('<meta property="og:title" content="T &lt;script&gt;">'));
  assert.ok(html.includes('<meta property="og:description" content="D &quot;quoted&quot;">'));
  assert.ok(html.includes('<meta name="description" content="D &quot;quoted&quot;">'));
  assert.ok(html.includes('<link rel="canonical" href="https://you.github.io/picks/">'));
  assert.ok(html.includes('<link rel="stylesheet" href="../../../assets/style.css">'));
  assert.ok(html.includes('<link rel="alternate" type="application/atom+xml" title="Feed" '
    + 'href="../../../feed.xml">'));
  assert.ok(html.includes('<script type="module" src="../../../assets/gallery.mjs"></script>'));
  assert.ok(html.includes('<body>\n<p>x</p>\n</body>\n</html>\n'));
  assert.doesNotMatch(html, /og:image/);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /style=/);
  assert.match(PAGE_CSP, /script-src 'self'/);
  assert.match(PAGE_CSP, /style-src 'self'/);
  assert.doesNotMatch(PAGE_CSP, /unsafe/);
});

test('page() drops a canonical that is not http(s) and an assetsBase that is not a run of ../', () => {
  const html = page({ title: 't', canonical: 'javascript:alert(1)', body: '', assetsBase: '"><script>' });
  assert.ok(!html.includes('canonical'));
  assert.ok(html.includes('<link rel="stylesheet" href="assets/style.css">'));
  assert.ok(!html.includes('og:description'), 'no description, no og:description');
});

test('blocksToHtml renders every block kind', () => {
  const html = blocksToHtml([
    { type: 'heading', level: 1, runs: [{ type: 'text', text: 'Title' }] },
    {
      type: 'paragraph',
      runs: ['plain ', { type: 'code', text: 'npm test' }, ' and ',
        { type: 'link', text: 'docs', url: 'https://example.com/docs' }],
    },
    { type: 'code', text: 'if (a < b) {}' },
    { type: 'list', ordered: true, items: [[{ type: 'text', text: 'one' }], 'two', { runs: ['three'] }] },
    { type: 'list', items: [['a']] },
    { type: 'quote', runs: ['quoted'] },
    { type: 'rule' },
  ]);
  assert.equal(html, [
    '<h1>Title</h1>',
    '<p>plain <code>npm test</code> and <a href="https://example.com/docs" '
      + 'rel="noopener noreferrer nofollow" target="_blank">docs</a> '
      + '<span class="url">(https://example.com/docs)</span></p>',
    '<pre><code>if (a &lt; b) {}</code></pre>',
    '<ol><li>one</li><li>two</li><li>three</li></ol>',
    '<ul><li>a</li></ul>',
    '<blockquote><p>quoted</p></blockquote>',
    '<hr>',
  ].join('\n'));
});

test('blocksToHtml turns unsafe links into text and keeps raw HTML literal', () => {
  /** @param {string} url */
  const linkPara = (url) => blocksToHtml([
    { type: 'paragraph', runs: [{ type: 'link', text: 'get it', url }] },
  ]);
  assert.equal(linkPara('https://example.com/tool.zip'), '<p>get it (https://example.com/tool.zip)</p>');
  assert.equal(linkPara('http://example.com/'), '<p>get it (http://example.com/)</p>');
  assert.equal(linkPara('javascript:alert(1)'), '<p>get it (javascript:alert(1))</p>');
  assert.equal(linkPara('docs/usage.md'), '<p>get it (docs/usage.md)</p>');
  assert.equal(linkPara('https://example.com/"><b>'), '<p><a href="https://example.com/%22%3E%3Cb%3E" '
    + 'rel="noopener noreferrer nofollow" target="_blank">get it</a> '
    + '<span class="url">(https://example.com/%22%3E%3Cb%3E)</span></p>');
  const qLink = { type: 'paragraph', runs: [{ type: 'link', text: 'x', url: 'https://example.com/' }] };
  const quarantined = blocksToHtml([qLink], { quarantined: true });
  assert.equal(quarantined, '<p>x (https://example.com/)</p>');
  assert.equal(blocksToHtml([{ type: 'paragraph', text: '<img src=x onerror=alert(1)>' }]),
    '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  assert.equal(blocksToHtml([{ type: 'paragraph', runs: [{ type: 'image', alt: 'logo', text: '' }] }]),
    '<p>[image: logo]</p>');
  const selfLabel = { type: 'link', text: 'https://example.com/', url: 'https://example.com/' };
  const same = blocksToHtml([{ type: 'paragraph', runs: [selfLabel] }]);
  assert.ok(!same.includes('class="url"'), 'a label equal to its URL is not repeated');
});

test('blocksToHtml accepts the shapes a renderer might produce and ignores the rest', () => {
  assert.equal(blocksToHtml([{ kind: 'heading', depth: 2, children: ['Sub'] }]), '<h2>Sub</h2>');
  assert.equal(blocksToHtml([{ type: 'heading', level: 1, text: 'x' }], { headingOffset: 1 }), '<h2>x</h2>');
  assert.equal(blocksToHtml([{ type: 'heading', level: 9, text: 'x' }]), '<h6>x</h6>');
  assert.equal(blocksToHtml([{ type: 'quote', blocks: [{ type: 'paragraph', text: 'inner' }] }]),
    '<blockquote><p>inner</p></blockquote>');
  assert.equal(blocksToHtml([{ type: 'list', items: [{ blocks: [{ type: 'paragraph', text: 'p' }] }] }]),
    '<ul><li><p>p</p></li></ul>');
  assert.equal(blocksToHtml([{ type: 'mystery', text: '<x>' }]), '<p>&lt;x&gt;</p>');
  assert.equal(blocksToHtml(['bare string', null, 42]), '<p>bare string</p>');
  assert.equal(blocksToHtml(/** @type {any} */ ('not an array')), '');
  assert.equal(blocksToHtml(null), '');
});

test('src/publish/ never uses an HTML-injection sink', () => {
  const root = fileURLToPath(new URL('../src/publish/', import.meta.url));
  const sinks = ['inner' + 'HTML', 'outer' + 'HTML', 'insertAdjacent' + 'HTML', 'document.' + 'write'];
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir */
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else {
        const text = readFileSync(p, 'utf8');
        for (const s of sinks) if (text.includes(s)) found.push(`${path.relative(root, p)}: ${s}`);
      }
    }
  };
  walk(root);
  assert.deepEqual(found, []);
});
