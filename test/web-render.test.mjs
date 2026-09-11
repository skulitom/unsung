// @ts-check
/**
 * Safe rendering (DESIGN §10.8): elements are built with createElement and text nodes only;
 * dangerous attributes never survive; links are live only when https, not an archive or
 * executable, and not quarantined; README blocks render as plain structure with literal HTML.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allElements, createEvent, createFakeDocument, serialise } from './support/fake-dom.mjs';
import {
  UNSAFE_EXTENSIONS, el, frag, isSafeUrl, plainText, renderBlocks, replace, safeHref, safeLink, text,
  useDocument,
} from '../web/render.mjs';

const doc = createFakeDocument();
useDocument(doc);

const HOSTILE = '<img src=x onerror="alert(1)"><script>alert(2)</script>';

test('el builds elements from classes, text, numbers and nested children', () => {
  const node = el('div', { class: ['card', null, 'selected'], id: 'x', 'aria-label': 'A card', tabindex: -1 },
    ['one ', 2, null, false, [el('b', null, 'three'), [' four']]]);
  assert.equal(serialise(node),
    '<div class="card selected" id="x" aria-label="A card" tabindex="-1">one 2<b>three</b> four</div>');
  assert.equal(frag(['a', el('i', null, 'b')]).childNodes.length, 2);
  assert.equal(text(null).textContent, '');
});

test('el never sets style, source or string handlers, and attaches function handlers', () => {
  let clicked = 0;
  const node = el('a', {
    style: 'color: red', src: 'https://x/y.js', srcdoc: HOSTILE, onclick: () => clicked++,
    onmouseover: 'alert(1)', formaction: 'https://evil', 'bad attr': 'x', dataset: { nwo: 'o/r', bad_key: 1 },
    hidden: true, disabled: false, value: 'v',
  });
  const names = node.attributes.map((/** @type {{name: string}} */ a) => a.name).sort();
  assert.deepEqual(names, ['data-nwo', 'hidden']);
  node.dispatchEvent(createEvent('click'));
  assert.equal(clicked, 1);
  assert.equal(node.value, 'v');
});

test('hrefs survive only as internal routes or safe https URLs', () => {
  /** @param {string} href */
  const hrefOf = (href) => el('a', { href }).getAttribute('href');
  assert.equal(hrefOf('https://github.com/o/r'), 'https://github.com/o/r');
  assert.equal(hrefOf('#/r/o/r'), '#/r/o/r');
  for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<b>x</b>',
    'http://example.com', '//evil.example/x', 'vbscript:x', '#x', '#/a b', 'https://example.com/tool.exe',
    'file:///etc/passwd']) {
    assert.equal(hrefOf(bad), null, bad);
    assert.equal(safeHref(bad), null, bad);
  }
});

test('isSafeUrl: https only, no credentials, and no archive or executable at the end of the path', () => {
  for (const ok of ['https://github.com/o/r', 'https://github.com/o/r/releases', 'https://x.dev/docs/',
    'https://x.dev/a.html?download=file.zip', 'https://x.dev/zip']) {
    assert.ok(isSafeUrl(ok), ok);
  }
  for (const bad of ['http://github.com/o/r', 'https://x/file.zip', 'https://x/a.EXE', 'https://x/a.exe?x=1',
    'https://x/a.tar.gz#f', 'https://x/a%2Eexe', 'https://u:p@x.dev/', 'javascript:alert(1)', 'data:,x', '',
    'https://x/setup.msi', 'https://x/run.sh', 'not a url', 'https://', `https://x/${'a'.repeat(3000)}`]) {
    assert.ok(!isSafeUrl(bad), bad);
  }
  const listed = ['zip', 'rar', '7z', 'exe', 'msi', 'dmg', 'apk', 'scr', 'bat', 'cmd', 'ps1', 'vbs', 'jar'];
  for (const ext of listed) {
    assert.ok(UNSAFE_EXTENSIONS.includes(ext), `§7.2 lists .${ext}`);
  }
});

test('safeLink: a live link with its full URL, or plain text when unsafe or quarantined', () => {
  const live = safeLink('https://github.com/o/r', 'the repository');
  const a = live.querySelector('a');
  assert.equal(a.getAttribute('href'), 'https://github.com/o/r');
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer nofollow');
  assert.equal(a.getAttribute('target'), '_blank');
  assert.equal(live.textContent, 'the repository (https://github.com/o/r)');
  assert.equal(safeLink('https://github.com/o/r').textContent, 'https://github.com/o/r');
  const archive = safeLink('https://github.com/o/r/raw/main/tests/payload.zip', 'Download');
  assert.equal(archive.querySelector('a'), null);
  assert.equal(archive.textContent, 'Download (https://github.com/o/r/raw/main/tests/payload.zip)');
  const quarantined = safeLink('https://github.com/o/r', 'repo', { quarantined: true });
  assert.equal(quarantined.querySelector('a'), null);
  assert.equal(safeLink('javascript:alert(1)', HOSTILE).querySelector('a'), null);
});

test('hostile text is always text', () => {
  const node = el('p', { title: HOSTILE }, HOSTILE);
  assert.equal(node.childNodes.length, 1);
  assert.equal(node.childNodes[0].nodeType, 3);
  assert.ok(serialise(node).includes('&lt;script&gt;'));
  assert.equal(allElements(node).length, 1);
});

test('README blocks render as headings, paragraphs, code, lists, quotes and rules', () => {
  const blocks = [
    { type: 'heading', level: 1, runs: [{ type: 'text', text: 'Title' }] },
    { type: 'paragraph', runs: [{ type: 'text', text: 'See ' },
      { type: 'link', text: 'docs', url: 'https://x.dev/d' }, { type: 'text', text: ' and ' },
      { type: 'code', text: 'npm test' }, ' ', { type: 'image', alt: 'logo' }] },
    { type: 'code', text: `${HOSTILE}\nrm -rf /`, lang: 'sh' },
    { type: 'list', ordered: true, items: [[{ type: 'text', text: 'one' }], { runs: ['two'] }, 'three'] },
    { type: 'list', ordered: false, items: [[{ type: 'link', text: 'bad', url: 'http://x/y' }]] },
    { type: 'quote', runs: [{ type: 'text', text: HOSTILE }] },
    { type: 'quote', blocks: [{ type: 'paragraph', text: 'nested' }] },
    { type: 'rule' },
    { type: 'html', text: '<div onclick="x()">raw</div>' },
    { type: 'script', runs: ['alert(1)'] },
    'a bare string',
    null,
  ];
  const root = renderBlocks(blocks);
  const tags = allElements(root).map((/** @type {{localName: string}} */ n) => n.localName);
  for (const bad of ['script', 'img', 'iframe', 'style', 'object', 'embed', 'div']) {
    assert.equal(tags.filter((t) => t === bad).length, bad === 'div' ? 1 : 0, bad);
  }
  assert.ok(root.querySelector('h3'), 'a level-1 heading sits under the page headings');
  assert.equal(root.querySelectorAll('a').length, 1, 'only the https link is live');
  assert.equal(root.querySelector('pre code').textContent, `${HOSTILE}\nrm -rf /`);
  assert.equal(root.querySelector('ol').children.length, 3);
  assert.ok(root.textContent.includes('[image: logo]'));
  assert.ok(root.textContent.includes('<div onclick="x()">raw</div>'), 'raw HTML stays literal text');
  assert.ok(root.textContent.includes('bad (http://x/y)'));
  assert.ok(root.querySelector('hr'));
  assert.ok(root.querySelector('blockquote p'));
});

test('quarantined READMEs have no live links at all; long READMEs are cut', () => {
  const linkBlock = { type: 'paragraph', runs: [{ type: 'link', text: 'x', url: 'https://x.dev/' }] };
  const root = renderBlocks([linkBlock], { quarantined: true });
  assert.equal(root.querySelectorAll('a').length, 0);
  const many = renderBlocks(Array.from({ length: 30 }, (_, i) => ({ type: 'paragraph', text: `p${i}` })),
    { maxBlocks: 10 });
  assert.equal(many.querySelectorAll('p').length, 11);
  assert.ok(many.textContent.includes('20 more blocks not shown'));
  assert.equal(plainText(HOSTILE).textContent, HOSTILE);
});

test('the blocks of src/core/readme.mjs render safely (once WP3 has landed)', async (t) => {
  /** @type {any} */
  let mod = null;
  try {
    mod = await import('../src/core/readme.mjs');
  } catch {
    mod = null;
  }
  if (typeof mod?.toSafeBlocks !== 'function') {
    t.skip('src/core/readme.mjs is not there yet');
    return;
  }
  const fence = '```';
  const md = [
    '# Title', '',
    'See [docs](https://x.dev/d), [plain](http://x.dev/b), [zip](https://x.dev/f.zip) and ![logo](l.png)',
    '<script>alert(1)</script>', '',
    '- one', '- [two](javascript:alert(1))', '',
    `${fence}sh`, 'rm -rf /', fence,
  ].join('\n');
  const root = renderBlocks(mod.toSafeBlocks(md, { maxBytes: 32768 }));
  const hrefs = root.querySelectorAll('a').map((/** @type {any} */ a) => a.getAttribute('href'));
  assert.deepEqual(hrefs, ['https://x.dev/d'], 'only the https link to a page is live');
  assert.equal(root.querySelectorAll('script').length + root.querySelectorAll('img').length, 0);
  assert.ok(root.textContent.includes('<script>alert(1)</script>'), 'raw HTML stays literal text');
  assert.ok(root.textContent.includes('[image: logo]'));
  assert.ok(root.querySelector('h3'));
  assert.equal(root.querySelector('pre code').textContent, 'rm -rf /');
});

test('a README\'s MediaFire download or dressed-up executable link is never live (§10.8)', async () => {
  const { toSafeBlocks } = await import('../src/core/readme.mjs');
  const mediafire = 'https://www.mediafire.com/file/abc123/Setup.zip/file';
  const md = [
    `Download: [Setup](${mediafire})`, '',
    '[a](https://example.com/tool.exe/) [b](https://example.com/tool.exe.) [c](https://example.com/tool.exe%00)',
    '', '[docs](https://x.dev/docs/)',
  ].join('\n');
  const root = renderBlocks(toSafeBlocks(md));
  const hrefs = root.querySelectorAll('a').map((/** @type {any} */ a) => a.getAttribute('href'));
  assert.deepEqual(hrefs, ['https://x.dev/docs/']);
  assert.ok(root.textContent.includes(`Setup (${mediafire})`), 'the address is still shown, as text');
  assert.equal(el('a', { href: mediafire }).getAttribute('href'), null);
  assert.equal(safeLink(mediafire, 'Setup').querySelector('a'), null);
  assert.equal(safeHref('https://example.com/tool.exe%20'), null);
});

test('replace empties a node before appending', () => {
  const node = el('ul', null, [el('li', null, 'a'), el('li', null, 'b')]);
  replace(node, el('li', null, 'c'));
  assert.equal(serialise(node), '<ul><li>c</li></ul>');
  replace(node);
  assert.equal(node.childNodes.length, 0);
});
