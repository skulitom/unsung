// @ts-check
/**
 * Tests for src/publish/digest.mjs, the weekly digest (DESIGN §11.4): ISO-week arithmetic, Markdown
 * escaping, and the digest itself, including "four weeks on" with stars then and now.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDigest, escapeMarkdown, inWeek, lastCompleteWeek, releasesSince, shiftWeek, weekDates, weekStart,
} from '../src/publish/digest.mjs';

const SITE = 'https://you.github.io/picks/';

/**
 * A digest entry (a gallery entry plus the re-check's findings).
 * @param {Record<string, any>} [over]
 * @returns {any}
 */
function entry(over = {}) {
  return {
    id: 'R_1',
    nwo: 'octo/tool',
    url: 'https://github.com/octo/tool',
    page: 'r/octo/tool/',
    description: 'A small tool that does one job well.',
    lang: 'Rust',
    pitch: null,
    note: 'I use this every day.',
    publishedAt: '2026-09-09T10:00:00.000Z',
    starsAtPublish: 0,
    starsNow: 2,
    reasons: ['Ships releases: 3 releases, latest v0.3.0 on 2 Sep', 'Has tests: 12 test files'],
    signals: [],
    quality: 0.92,
    confidence: 0.3,
    family: 'rust',
    familyLabel: 'Rust',
    evidence: [[], []],
    confidenceBand: 'medium',
    points: 8,
    pointsMax: 13,
    archived: false,
    headOid: 'abc',
    releasesSince: null,
    latestRelease: null,
    gone: false,
    ...over,
  };
}

/** Four weeks on: one still unsung with a release, one graduated, one gone. */
const EARLIER = [
  entry({ id: 'R_old', nwo: 'octo/old', url: 'https://github.com/octo/old', page: 'r/octo/old/',
    publishedAt: '2026-08-12T10:00:00.000Z', starsAtPublish: 0, starsNow: 4, releasesSince: 1,
    latestRelease: 'v0.4.0' }),
  entry({ id: 'R_big', nwo: 'octo/big', url: 'https://github.com/octo/big', page: 'r/octo/big/',
    publishedAt: '2026-08-13T10:00:00.000Z', starsAtPublish: 2, starsNow: 40, releasesSince: 0 }),
  entry({ id: 'R_gone', nwo: 'octo/vanished', url: 'https://github.com/octo/vanished',
    page: 'r/octo/vanished/', publishedAt: '2026-08-14T10:00:00.000Z', gone: true }),
];

test('ISO weeks: start, shift, last complete week and membership', () => {
  assert.equal(weekStart('2026-W37'), Date.UTC(2026, 8, 7));
  assert.equal(weekStart('2026-W01'), Date.UTC(2025, 11, 29));
  assert.equal(weekStart('2020-W53'), Date.UTC(2020, 11, 28));
  for (const bad of ['2025-W53', '2026-W00', '2026-37', 'nonsense', '2026-w37']) {
    assert.throws(() => weekStart(bad), RangeError, bad);
  }
  assert.equal(shiftWeek('2026-W37', -4), '2026-W33');
  assert.equal(shiftWeek('2026-W02', -4), '2025-W50');
  assert.equal(lastCompleteWeek('2026-09-11T12:00:00Z'), '2026-W36');
  assert.equal(lastCompleteWeek('2026-09-07T00:00:00Z'), '2026-W36');
  assert.ok(inWeek('2026-09-13T23:59:59Z', '2026-W37'));
  assert.ok(!inWeek('2026-09-14T00:00:00Z', '2026-W37'));
  assert.ok(!inWeek('not a date', '2026-W37'));
});

test('weekDates reads naturally within a month, across months and across years', () => {
  assert.equal(weekDates('2026-W37'), '7–13 September 2026');
  assert.equal(weekDates('2026-W36'), '31 August – 6 September 2026');
  assert.equal(weekDates('2026-W01'), '29 December 2025 – 4 January 2026');
});

test('escapeMarkdown neutralises links, images, HTML, emphasis, tables and block markers', () => {
  assert.equal(escapeMarkdown('[click](javascript:alert(1))'), '\\[click\\](javascript:alert(1))');
  assert.equal(escapeMarkdown('![x](https://t.example/p.png)'), '!\\[x\\](`https://t.example/p.png`)');
  assert.equal(escapeMarkdown('<img src=x onerror=alert(1)>'), '\\<img src=x onerror=alert(1)\\>');
  assert.equal(escapeMarkdown('*bold* _it_ `code` ~strike~ a|b'),
    '\\*bold\\* \\_it\\_ \\`code\\` \\~strike\\~ a\\|b');
  assert.equal(escapeMarkdown('&amp; & &#60;'), '&amp;amp; & &amp;#60;');
  assert.equal(escapeMarkdown('# Heading'), '\\# Heading');
  assert.equal(escapeMarkdown('- item'), '\\- item');
  assert.equal(escapeMarkdown('1. first'), '\\1. first');
  assert.equal(escapeMarkdown('line one\n# not a heading'), 'line one # not a heading');
  assert.equal(escapeMarkdown('back\\slash'), 'back\\\\slash');
});

test('escapeMarkdown puts URL-like tokens in code spans, which GFM never autolinks', () => {
  assert.equal(escapeMarkdown('Grab https://evil.example/Setup.exe or www.evil.example/x.zip'),
    'Grab `https://evil.example/Setup.exe` or `www.evil.example/x.zip`');
  assert.equal(escapeMarkdown('- see https://a.example/x_y|z'), '\\- see `https://a.example/x_y`\\|z');
  assert.equal(escapeMarkdown('HTTPS://A.example/b ftp://c.example/d'),
    '`HTTPS://A.example/b` `ftp://c.example/d`');
  assert.equal(escapeMarkdown('https://a.example/x starts the line'), '`https://a.example/x` starts the line');
  assert.equal(escapeMarkdown('a &amp; https://a.example/?q=1&amp;r=2'), 'a &amp;amp; `https://a.example/?q=1&amp;r=2`');
});

test('URLs from repository text never become live links in the Markdown digest', () => {
  const bad = 'Grab https://x.example/a.exe or www.x.example/b.zip now';
  const picks = [
    entry({ description: bad, note: `See ${bad}\n\nAlso HTTPS://X.example/c.msi`, reasons: [`Reason ${bad}`] }),
    entry({ id: 'R_2', nwo: 'octo/second', url: 'https://github.com/octo/second', page: 'r/octo/second/',
      pitch: bad }),
  ];
  const later = [entry({ id: 'R_3', nwo: 'octo/third', url: 'https://github.com/octo/third', page: 'r/octo/third/',
    publishedAt: '2026-08-12T10:00:00.000Z', releasesSince: 1, latestRelease: 'www.x.example/v1' })];
  const { markdown, html } = buildDigest({ week: '2026-W37', picks, fourWeeksAgo: later, siteUrl: SITE });
  for (const line of markdown.split('\n')) {
    const bare = line.replace(/\]\([^)]*\)/g, '').replace(/`[^`]*`/g, '');
    assert.doesNotMatch(bare, /(?:https?:\/\/|www\.)/i, line);
  }
  assert.ok(markdown.includes('Grab `https://x.example/a.exe` or `www.x.example/b.zip` now'));
  assert.ok(markdown.includes('> See Grab `https://x.example/a.exe` or `www.x.example/b.zip` now'));
  assert.ok(markdown.includes('> Also `HTTPS://X.example/c.msi`'));
  assert.ok(markdown.includes('- Reason Grab `https://x.example/a.exe`'));
  assert.ok(markdown.includes('1 (latest `www.x.example/v1`)'));
  assert.ok(!html.includes('href="https://x.example') && !html.includes('href="http://www.x.example'),
    'the HTML digest shows them as text as well');
});

test('releasesSince counts releases after the publish time and ignores prereleases', () => {
  const releases = {
    count: 5,
    recent: [
      { tag: 'v0.5.0-rc1', publishedAt: '2026-09-01T00:00:00Z', prerelease: true },
      { tag: 'v0.4.1', publishedAt: '2026-08-30T00:00:00Z', prerelease: false },
      { tag: 'v0.4.0', publishedAt: '2026-08-20T00:00:00Z', prerelease: false },
      { tag: 'v0.3.0', publishedAt: '2026-08-01T00:00:00Z', prerelease: false },
    ],
  };
  assert.deepEqual(releasesSince(releases, '2026-08-12T10:00:00Z'), { count: 2, latest: 'v0.4.1' });
  assert.deepEqual(releasesSince(releases, '2026-09-05T00:00:00Z'), { count: 0, latest: null });
  assert.deepEqual(releasesSince(null, '2026-08-12T10:00:00Z'), { count: null, latest: null });
});

test('the Markdown digest lists the week and reports stars then and now four weeks on', () => {
  const picks = [entry(), entry({ id: 'R_2', nwo: 'octo/second', url: 'https://github.com/octo/second',
    page: 'r/octo/second/', pitch: 'Tidy logs in one command', note: '' })];
  const { markdown } = buildDigest({ week: '2026-W37', picks, fourWeeksAgo: EARLIER, siteUrl: SITE });
  const lines = markdown.split('\n');
  assert.equal(lines[0], '# Unsung picks: week 37, 2026');
  assert.ok(lines.includes('7–13 September 2026 · 2 picks'));
  assert.ok(lines.includes('## [octo/tool](https://you.github.io/picks/r/octo/tool/)'));
  assert.ok(lines.includes('A small tool that does one job well.'));
  assert.ok(lines.includes('> I use this every day.'));
  assert.ok(lines.includes('- Ships releases: 3 releases, latest v0.3.0 on 2 Sep'));
  assert.ok(lines.includes('Rust · 0 stars when featured · [on GitHub](https://github.com/octo/tool)'));
  assert.ok(lines.includes('Tidy logs in one command'), 'a pitch takes the place of the description');
  assert.ok(lines.includes('## Four weeks on'));
  assert.ok(lines.includes('How the picks of week 33, 2026 (10–16 August 2026) are doing.'));
  assert.ok(lines.includes('| Repository | Stars then | Stars now | Releases since | Status |'));
  assert.ok(lines.includes('| [octo/old](https://you.github.io/picks/r/octo/old/) | 0 | 4 '
    + '| 1 (latest v0.4.0) | Still unsung |'));
  assert.ok(lines.includes('| [octo/big](https://you.github.io/picks/r/octo/big/) | 2 | 40 | none '
    + '| Graduated: past 25 stars |'));
  assert.ok(lines.includes('One pick from that week is no longer on GitHub, so it is left out.'));
  assert.ok(!markdown.includes('vanished'), 'a repository that has gone is not named');
});

test('without a site URL the Markdown links to GitHub and the HTML to the relative gem pages', () => {
  const { markdown, html } = buildDigest({ week: '2026-W37', picks: [entry()], fourWeeksAgo: [] });
  assert.ok(markdown.includes('## [octo/tool](https://github.com/octo/tool)'));
  assert.ok(html.includes('<a href="../r/octo/tool/">octo/tool</a>'));
  assert.ok(!html.includes('rel="canonical"'));
  assert.ok(markdown.includes('No picks were published that week.'));
});

test('the HTML digest is a standalone page with the same content', () => {
  const { html } = buildDigest({ week: '2026-W37', picks: [entry()], fourWeeksAgo: EARLIER, siteUrl: SITE });
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes('<title>Unsung picks: week 37, 2026</title>'));
  assert.ok(html.includes('<link rel="canonical" href="https://you.github.io/picks/digest/2026-W37.html">'));
  assert.ok(html.includes('<link rel="stylesheet" href="../assets/style.css">'));
  assert.ok(html.includes('<a href="https://you.github.io/picks/r/octo/tool/" rel="noopener">octo/tool</a>'));
  assert.ok(html.includes('<th scope="col">Stars then</th><th scope="col">Stars now</th>'));
  assert.ok(html.includes('<td>0</td><td>4</td><td>1 (latest v0.4.0)</td><td>Still unsung</td>'));
  assert.ok(html.includes('<td>2</td><td>40</td><td>none</td><td>Graduated: past 25 stars</td>'));
  assert.ok(!html.includes('vanished'));
});

test('an empty week says so', () => {
  const { markdown, html } = buildDigest({ week: '2026-W37', picks: [], fourWeeksAgo: [] });
  assert.ok(markdown.includes('7–13 September 2026 · 0 picks'));
  assert.ok(markdown.includes('No picks were published this week.'));
  assert.ok(html.includes('<p>No picks were published this week.</p>'));
  assert.throws(() => buildDigest({ week: '2026-37', picks: [], fourWeeksAgo: [] }), RangeError);
});

test('hostile repository text stays text in both formats', () => {
  const hostile = '[click](javascript:alert(1)) <img src=x onerror=alert(1)> **x** | cell\n# Heading\n- item';
  const e = entry({ description: hostile, note: `${hostile}\n\n> quote`, reasons: [`Reason ${hostile}`],
    latestRelease: '<b>v1</b>', releasesSince: 1, lang: '<i>Rust</i>' });
  const { markdown, html } = buildDigest({ week: '2026-W37', picks: [e], fourWeeksAgo: [{ ...e, id: 'R_9' }],
    siteUrl: SITE, title: 'Picks <script>' });
  assert.ok(!markdown.includes('[click]('), 'no Markdown link is formed');
  assert.ok(!/(^|[^\\])<(img|b|i|script)\b/m.test(markdown), 'no unescaped HTML in the Markdown');
  assert.ok(!/^# Heading/m.test(markdown) && !/^- item/m.test(markdown), 'no block markup was injected');
  assert.ok(markdown.includes('\\[click\\](javascript:alert(1))'));
  assert.ok(!/<img|<b>v1|<i>Rust|<script>/.test(html));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('<title>Picks &lt;script&gt;: week 37, 2026</title>'));
});
