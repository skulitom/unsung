// @ts-check
/**
 * Tests for src/publish/feed.mjs, the Atom feeds (RFC 4287; DESIGN §11.3). A small XML parser in
 * this file checks that every feed is well-formed, including feeds built from hostile text.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAG_PREFIX, atomDate, atomFeed, escapeXml, feedEntry, siteHref } from '../src/publish/feed.mjs';

/** @param {number} cp */
const ch = (cp) => String.fromCodePoint(cp);

/**
 * @typedef {{name: string, attrs: Record<string, string>, children: El[], text: string}} El
 */

/**
 * @param {number} cp
 * @returns {boolean}
 */
function isXmlChar(cp) {
  return cp === 0x09 || cp === 0x0a || cp === 0x0d || (cp >= 0x20 && cp <= 0xd7ff)
    || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
}

/**
 * @param {string} s
 * @returns {string}
 */
function decode(s) {
  /** @type {Record<string, string>} */
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return s.replace(/&(amp|lt|gt|quot|apos);/g, (_m, e) => map[e]);
}

/**
 * @param {string} t
 */
function checkText(t) {
  if (t.includes('<')) throw new Error(`raw < in text: ${t.slice(0, 40)}`);
  const bareAmp = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  if (bareAmp.test(t)) throw new Error(`bare & in: ${t.slice(0, 40)}`);
  for (const c of t) {
    if (!isXmlChar(/** @type {number} */ (c.codePointAt(0)))) throw new Error('character XML forbids');
  }
}

/**
 * Parse the XML our feeds use (declaration, elements, attributes in double quotes, text, the five
 * entities) and throw on anything malformed. Comments, CDATA and processing instructions after the
 * declaration are rejected: the feeds never contain them.
 * @param {string} xml
 * @returns {El}
 */
function parseXml(xml) {
  let i = 0;
  const decl = /^<\?xml version="1\.0" encoding="utf-8"\?>\n/.exec(xml);
  if (!decl) throw new Error('missing XML declaration');
  i = decl[0].length;
  /** @type {El[]} */
  const stack = [];
  /** @type {El | null} */
  let root = null;
  while (i < xml.length) {
    if (xml[i] !== '<') {
      const next = xml.indexOf('<', i);
      const t = xml.slice(i, next < 0 ? xml.length : next);
      if (stack.length === 0) {
        if (t.trim() !== '') throw new Error('text outside the root element');
      } else {
        checkText(t);
        stack[stack.length - 1].text += decode(t);
      }
      i = next < 0 ? xml.length : next;
      continue;
    }
    if (xml.startsWith('</', i)) {
      const end = xml.indexOf('>', i);
      const name = xml.slice(i + 2, end);
      const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`mismatched </${name}>`);
      i = end + 1;
      continue;
    }
    if (/^<[!?]/.test(xml.slice(i, i + 2))) throw new Error('unexpected markup');
    const nameRe = /[A-Za-z_][\w.:-]*/y;
    nameRe.lastIndex = i + 1;
    const m = nameRe.exec(xml);
    if (!m) throw new Error(`bad tag near ${xml.slice(i, i + 20)}`);
    /** @type {El} */
    const el = { name: m[0], attrs: {}, children: [], text: '' };
    let j = nameRe.lastIndex;
    let selfClosing = false;
    for (;;) {
      while (/\s/.test(xml[j])) j++;
      if (xml.startsWith('/>', j)) {
        selfClosing = true;
        j += 2;
        break;
      }
      if (xml[j] === '>') {
        j++;
        break;
      }
      const attr = /([A-Za-z_][\w.:-]*)="([^"]*)"/y;
      attr.lastIndex = j;
      const am = attr.exec(xml);
      if (!am) throw new Error(`bad attribute near ${xml.slice(j, j + 30)}`);
      if (am[1] in el.attrs) throw new Error(`duplicate attribute ${am[1]}`);
      checkText(am[2]);
      el.attrs[am[1]] = decode(am[2]);
      j = attr.lastIndex;
    }
    if (stack.length > 0) stack[stack.length - 1].children.push(el);
    else if (root) throw new Error('more than one root element');
    else root = el;
    if (!selfClosing) stack.push(el);
    i = j;
  }
  if (stack.length > 0) throw new Error(`unclosed <${stack[stack.length - 1].name}>`);
  if (!root) throw new Error('no root element');
  return root;
}

/**
 * @param {El} el
 * @param {string} name
 * @returns {El[]}
 */
const kids = (el, name) => el.children.filter((c) => c.name === name);

/**
 * @param {El} el
 * @param {string} name
 * @returns {El}
 */
function one(el, name) {
  const found = kids(el, name);
  assert.equal(found.length, 1, `exactly one <${name}> in <${el.name}>`);
  return found[0];
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/**
 * Check the RFC 4287 requirements this project relies on.
 * @param {string} xml
 * @returns {El}
 */
function assertAtom(xml) {
  const feed = parseXml(xml);
  assert.equal(feed.name, 'feed');
  assert.equal(feed.attrs.xmlns, 'http://www.w3.org/2005/Atom');
  assert.ok(one(feed, 'id').text.startsWith(TAG_PREFIX));
  assert.ok(one(feed, 'title').text.length > 0);
  assert.match(one(feed, 'updated').text, RFC3339);
  assert.ok(one(one(feed, 'author'), 'name').text.length > 0);
  assert.equal(kids(feed, 'link').filter((l) => l.attrs.rel === 'self').length, 1);
  for (const entry of kids(feed, 'entry')) {
    assert.ok(one(entry, 'id').text.startsWith(TAG_PREFIX));
    assert.ok(one(entry, 'title').text.length > 0);
    assert.match(one(entry, 'updated').text, RFC3339);
    const links = kids(entry, 'link');
    assert.equal(links.filter((l) => l.attrs.rel === 'alternate').length, 1);
    assert.equal(links.filter((l) => l.attrs.rel === 'related').length, 1);
    assert.equal(one(entry, 'content').attrs.type, 'text');
  }
  return feed;
}

/**
 * A gallery entry for tests.
 * @param {Record<string, any>} [over]
 * @returns {any}
 */
function entry(over = {}) {
  return {
    id: 'R_kgDOabc123',
    nwo: 'octo/tool',
    url: 'https://github.com/octo/tool',
    page: 'r/octo/tool/',
    description: 'A small tool that does one job well.',
    lang: 'Rust',
    pitch: null,
    note: 'I use this every day.',
    publishedAt: '2026-09-10T09:30:00.000Z',
    starsAtPublish: 0,
    starsNow: 3,
    reasons: ['Ships releases: 3 releases, latest v0.3.0 on 2 Sep', 'Has tests: 12 test files'],
    signals: [{ label: 'Ships releases', points: 1 }],
    quality: 0.92,
    confidence: 0.3,
    ...over,
  };
}

test('escapeXml escapes markup and removes characters XML forbids', () => {
  assert.equal(escapeXml('<a b="c" d=\'e\'>&</a>'),
    '&lt;a b=&quot;c&quot; d=&apos;e&apos;&gt;&amp;&lt;/a&gt;');
  const lone = String.fromCharCode(0xd800);
  const bad = `a${ch(0)}b${ch(8)}c${ch(0x1b)}d${ch(0x85)}e${lone}f${ch(0xfffe)}g${ch(0xffff)}h`;
  assert.equal(escapeXml(bad), 'abcdefgh');
  assert.equal(escapeXml(`tab\tlf\ncr\r`), 'tab\tlf\ncr\r');
  assert.equal(escapeXml(`emoji ${ch(0x1f48e)}`), `emoji ${ch(0x1f48e)}`);
  assert.equal(escapeXml(null), '');
});

test('atomDate gives RFC 3339 timestamps', () => {
  assert.equal(atomDate('2026-09-11T10:00:00.000Z'), '2026-09-11T10:00:00Z');
  assert.equal(atomDate('2026-09-11T10:00:00.123Z'), '2026-09-11T10:00:00.123Z');
  assert.equal(atomDate('2026-09-11T12:00:00+02:00'), '2026-09-11T10:00:00Z');
  assert.equal(atomDate('yesterday'), null);
  assert.equal(atomDate(null), null);
});

test('siteHref resolves against the site URL, or stays relative without one', () => {
  assert.equal(siteHref('r/octo/tool/', 'https://you.github.io/picks/'),
    'https://you.github.io/picks/r/octo/tool/');
  assert.equal(siteHref('feed.xml', null), 'feed.xml');
});

test('feedEntry follows §11.3', () => {
  const e = feedEntry(entry(), 'https://you.github.io/picks/');
  assert.equal(e.id, `${TAG_PREFIX}R_kgDOabc123`);
  assert.equal(e.title, 'octo/tool — A small tool that does one job well.');
  assert.equal(e.updated, '2026-09-10T09:30:00Z');
  assert.equal(e.alternate, 'https://you.github.io/picks/r/octo/tool/');
  assert.equal(e.related, 'https://github.com/octo/tool');
  assert.ok(e.content.startsWith('I use this every day.'));
  assert.ok(e.content.includes('- Ships releases: 3 releases, latest v0.3.0 on 2 Sep'));
  assert.ok(e.content.includes('Stars when featured: 0, 3 now.'));
  assert.ok(e.content.endsWith('Repository: https://github.com/octo/tool'));

  assert.equal(feedEntry(entry({ pitch: 'Tidy logs in one command' }), null).title,
    'octo/tool — Tidy logs in one command');
  assert.equal(feedEntry(entry({ pitch: null, description: null }), null).title, 'octo/tool');
  assert.equal(feedEntry(entry(), null).alternate, 'r/octo/tool/');
});

test('atomFeed produces well-formed Atom with every required element', () => {
  const xml = atomFeed({
    id: `${TAG_PREFIX}https://you.github.io/picks/`,
    title: 'Unsung picks',
    subtitle: 'Chosen by hand.',
    selfUrl: 'https://you.github.io/picks/feed.xml',
    siteUrl: 'https://you.github.io/picks/',
    updated: '2026-09-11T08:00:00.000Z',
    entries: [feedEntry(entry(), 'https://you.github.io/picks/'),
      feedEntry(entry({ id: 'R_2', nwo: 'octo/other', page: 'r/octo/other/' }),
        'https://you.github.io/picks/')],
  });
  const feed = assertAtom(xml);
  assert.equal(one(feed, 'id').text, `${TAG_PREFIX}https://you.github.io/picks/`);
  assert.equal(one(feed, 'updated').text, '2026-09-11T08:00:00Z');
  assert.equal(kids(feed, 'entry').length, 2);
  assert.equal(feed.attrs['xml:lang'], 'en-GB');
  const first = kids(feed, 'entry')[0];
  assert.equal(kids(first, 'link').find((l) => l.attrs.rel === 'related')?.attrs.href,
    'https://github.com/octo/tool');
  assert.equal(one(first, 'published').text, '2026-09-10T09:30:00Z');
});

test('an empty feed is still valid, and its date falls back sensibly', () => {
  const empty = atomFeed({
    id: `${TAG_PREFIX}local/`, title: 'Unsung picks', selfUrl: 'feed.xml', siteUrl: 'index.html', entries: [],
  });
  const feed = assertAtom(empty);
  assert.equal(kids(feed, 'entry').length, 0);
  assert.equal(one(feed, 'updated').text, '1970-01-01T00:00:00Z');
  const dated = atomFeed({ id: `${TAG_PREFIX}local/`, title: 't', selfUrl: 'feed.xml', siteUrl: 'index.html',
    entries: [feedEntry(entry(), null)] });
  assert.equal(one(parseXml(dated), 'updated').text, '2026-09-10T09:30:00Z');
});

test('hostile repository text cannot break a feed', () => {
  const loneLow = String.fromCharCode(0xdc00);
  const hostile = `]]></content><script>alert(1)</script>&amp;&#0;"' ${ch(0)}${ch(0x202e)}${loneLow}<!--`;
  const e = entry({
    nwo: 'octo/tool',
    description: hostile,
    pitch: `</title><entry>${hostile}`,
    note: `note ${hostile}\n\nsecond paragraph`,
    reasons: [`Reason ${hostile}`],
    page: 'r/octo/tool/?a="b"&c=<d>',
  });
  const xml = atomFeed({
    id: `${TAG_PREFIX}"<local>"&`, title: `Title ${hostile}`, author: hostile, subtitle: hostile,
    selfUrl: 'feed.xml?x="y"', siteUrl: 'index.html', entries: [feedEntry(e, null)],
  });
  const feed = assertAtom(xml);
  assert.ok(!xml.includes('<script>'));
  assert.ok(!xml.includes('<!--'));
  assert.ok(!xml.includes(']]>'));
  assert.equal(kids(feed, 'entry').length, 1, 'no entry was injected');
  const content = one(kids(feed, 'entry')[0], 'content').text;
  assert.ok(content.includes('<script>alert(1)</script>'), 'the text survives, as text');
  assert.equal(kids(kids(feed, 'entry')[0], 'link').find((l) => l.attrs.rel === 'alternate')?.attrs.href,
    'r/octo/tool/?a="b"&c=<d>');
});
