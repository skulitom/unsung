// @ts-check
/**
 * README text helpers (DESIGN §5.3, §5.3.1, §5.6, §7.2, §10.8): fence counting, README references
 * and their resolution, links, clone targets, writing-system detection, reviewer-addressing text,
 * and `toSafeBlocks`, the Markdown reader that turns untrusted README text into plain blocks.
 *
 * Everything here is pure. Nothing is rendered, fetched or executed; URLs are returned as text.
 */

import { aiAddress } from './lexicons.mjs';
import { truncateUtf8 } from './util.mjs';
import { safeLinkUrl } from './views.mjs';

const LINE_SPLIT = /\r\n|\r|\n/;

/**
 * §5.3 `q.usage`: lines whose trimmed start is three backticks or three tildes.
 * @param {string | null | undefined} t
 * @returns {number}
 */
export function countFenceLines(t) {
  if (typeof t !== 'string' || !t) return 0;
  let n = 0;
  for (const line of t.split(LINE_SPLIT)) {
    const s = line.trimStart();
    if (s.startsWith('```') || s.startsWith('~~~')) n++;
  }
  return n;
}

/**
 * Remove HTML comments (an unterminated one runs to the end, as GitHub renders it).
 * @param {string | null | undefined} t
 * @returns {{text: string, removed: number}} `removed` counts comments
 */
export function stripHtmlComments(t) {
  let removed = 0;
  const text = String(t ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, () => {
    removed++;
    return '';
  });
  return { text, removed };
}

/**
 * Zero-width and bidi-control characters of §7.2, plus the bidi isolates U+2066–U+2069, the Unicode
 * tag characters U+E0000–U+E007F (which can spell out hidden ASCII) and the variation-selector
 * supplement U+E0100–U+E01EF.
 */
const INVISIBLE = new RegExp('[\\u{200B}-\\u{200F}\\u{202A}-\\u{202E}\\u{2060}-\\u{2064}\\u{2066}-\\u{2069}'
  + '\\u{FEFF}\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]', 'gu');
/** The §7.2 set exactly, for `g.injection` runs. */
const INVISIBLE_RUN = new RegExp('[\\u{200B}-\\u{200F}\\u{202A}-\\u{202E}\\u{2060}-\\u{2064}\\u{FEFF}'
  + '\\u{E0000}-\\u{E007F}\\u{E0100}-\\u{E01EF}]+', 'gu');
/**
 * A valid emoji tag sequence: a black flag, one to six tag digits or lower-case tag letters, and the
 * cancel tag (the flags of England, Scotland and Wales). Not hidden text, so not counted in runs.
 */
const EMOJI_TAG_SEQUENCE = /\u{1F3F4}[\u{E0030}-\u{E0039}\u{E0061}-\u{E007A}]{1,6}\u{E007F}/gu;

/**
 * Remove zero-width, bidi-control, tag and supplementary variation-selector characters (a tag-built
 * flag becomes a plain black flag).
 * @param {string | null | undefined} t
 * @returns {{text: string, removed: number}} `removed` counts characters
 */
export function stripInvisible(t) {
  let removed = 0;
  const text = String(t ?? '').replace(INVISIBLE, () => {
    removed++;
    return '';
  });
  return { text, removed };
}

/**
 * Length of the longest run of §7.2 invisible characters — zero-width, bidi-control and Unicode tag
 * characters — outside valid emoji tag sequences (`g.injection` fires at 3).
 * @param {string | null | undefined} t
 * @returns {number}
 */
export function invisibleRun(t) {
  let best = 0;
  // A flag keeps its black flag so that the runs on either side of it are not joined.
  const text = String(t ?? '').replace(EMOJI_TAG_SEQUENCE, '\u{1F3F4}');
  for (const m of text.matchAll(INVISIBLE_RUN)) best = Math.max(best, [...m[0]].length);
  return best;
}

// ---------------------------------------------------------------------------------------------
// Code segments
// ---------------------------------------------------------------------------------------------

/**
 * Split README text into fenced-code contents, inline code spans and the prose around them.
 * A fence opens on a line whose trimmed start is three or more backticks or tildes and closes on a
 * line of the same character at least as long; an unclosed fence runs to the end.
 * @param {string} t
 * @returns {{code: string[], prose: string}} `prose` has code replaced by spaces, lines kept
 */
function splitCode(t) {
  /** @type {string[]} */
  const code = [];
  /** @type {string[]} */
  const prose = [];
  /** @type {{ch: string, len: number, lines: string[]} | null} */
  let fence = null;
  for (const line of String(t).split(LINE_SPLIT)) {
    const s = line.trimStart();
    const m = /^(`{3,}|~{3,})/.exec(s);
    if (fence) {
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && !s.slice(m[1].length).trim()) {
        code.push(fence.lines.join('\n'));
        fence = null;
      } else fence.lines.push(line);
      prose.push('');
      continue;
    }
    if (m) {
      fence = { ch: m[1][0], len: m[1].length, lines: [] };
      prose.push('');
      continue;
    }
    prose.push(line.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks, inner) => {
      code.push(inner);
      return ' ';
    }));
  }
  if (fence) code.push(fence.lines.join('\n'));
  return { code, prose: prose.join('\n') };
}

// ---------------------------------------------------------------------------------------------
// README references (§5.3.1)
// ---------------------------------------------------------------------------------------------

/**
 * A README reference. A `weak` path (two extension-less segments such as `tools/list`, or a build
 * or environment directory, or a path under one, such as `dist/`, `.venv/` or `build/bin/app`)
 * counts only when it resolves or starts in a directory of the tree: such tokens are usually slugs,
 * protocol methods, MIME types, platform pairs or build outputs rather than claims about the
 * repository.
 * @typedef {{kind: 'path' | 'script', value: string, weak?: boolean}} Ref
 */

/** Directories whose contents are generated or local, so a missing path there proves nothing. */
const GENERATED_DIRS = new Set([
  'build', 'dist', 'out', 'target', 'bin', 'obj', 'coverage', '.venv', 'venv', '__pycache__', '.next',
  '.nuxt', '.cache', 'tmp',
]);

/** Library and product names that look like file names (`Next.js`, `Socket.io`). */
const LIBRARY_NAMES = new RegExp('^(node|next|nuxt|vue|react|angular|ember|backbone|express|three|d3|chart'
  + '|alpine|solid|p5|anime|moment|day|transformers|tensorflow|ml5|pixi|babylon|phaser|leaflet|highlight'
  + '|marked|socket|deno|hono|htmx|lit|preact|svelte|fabric|paper|matter|tone|brain|ramda|lodash)'
  + '\\.(js|io)$', 'i');

/** Extensions of source and configuration files that make a slash-less token a path reference. */
const REF_EXTENSIONS = new Set([
  'js mjs cjs jsx ts mts cts tsx py pyi ipynb rs go java kt kts scala groovy clj cljs rb php',
  'c h cc cpp cxx hpp hh cs fs vb swift m mm dart ex exs erl hrl hs lua r jl zig nim sh bash zsh',
  'fish ps1 bat cmd sql proto graphql gql vue svelte astro html htm css scss sass less json jsonc',
  'json5 yaml yml toml ini cfg conf xml md mdx rst txt csv tsv lock gradle properties tf hcl nix mk',
  'cmake gemspec cabal csproj sln',
].join(' ').split(' '));

/** Package-manager subcommands that are not script names (`pnpm install`, `yarn add`, …). */
const PM_BUILTINS = new Set([
  'install i add remove rm un uninstall update up upgrade dlx exec create init link unlink publish',
  'pack audit outdated why list ls global config cache info set version x import rebuild prune store',
  'env setup login logout whoami workspace workspaces dedupe patch patch-commit plugin node bin root',
  'help licenses licences owner tag team check autoclean policies self-update run install-test ci',
  'fetch deploy recursive',
].join(' ').split(' '));

const SCRIPT_REF = /(?:^|[\s;&|(])(npm run|pnpm run|yarn run|bun run|pnpm|yarn)\s+([A-Za-z][\w:.\-/]*)/g;
const TOKEN_SPLIT = /[\s"'`(),;|=[\]]+/;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,6}$/i;

/**
 * @param {string} segment
 * @returns {boolean}
 */
function hasRefExtension(segment) {
  const dot = segment.lastIndexOf('.');
  return dot > 0 && REF_EXTENSIONS.has(segment.slice(dot + 1).toLowerCase());
}

/**
 * A path reference from one code token, or null (§5.3.1).
 * @param {string} token
 * @returns {{value: string, weak: boolean} | null}
 */
function pathRef(token) {
  let tok = token.replace(/[.,:;!?]+$/, '').replace(/:\d+(?::\d+)?$/, '');
  if (!tok || /[<>{}*$%\\]|\.\.\.|\u{2026}/u.test(tok)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(tok)) return null; // a URL or scheme
  if (/^[-$~/@#]/.test(tok) || tok.startsWith('..')) return null;
  tok = tok.replace(/^(\.\/)+/, '');
  if (!tok || /^(your[-_]|path\/to\/)/i.test(tok)) return null;
  if (!/^[\w.+@/-]+$/.test(tok) || !/[A-Za-z]/.test(tok)) return null;
  const first = tok.split('/')[0];
  if (tok.includes('/')) {
    if (DOMAIN.test(first) || first.toLowerCase() === 'node_modules') return null;
  } else if (!hasRefExtension(tok) || LIBRARY_NAMES.test(tok)) return null;
  const dirMarked = tok.endsWith('/');
  tok = tok.replace(/\/+$/, '');
  if (!tok || tok.length > 200) return null;
  const parts = tok.split('/');
  // A build or environment directory (`dist/`, `.venv/`) or a path under one is weak at any depth:
  // such directories are usually gitignored, so a missing one proves nothing.
  const weak = (parts.length === 2 && !dirMarked && !hasRefExtension(parts[1]))
    || GENERATED_DIRS.has(parts[0].toLowerCase());
  return { value: tok, weak };
}

/**
 * README references from fenced code blocks and inline code spans (§5.3.1): paths (a token with a
 * `/` or a known source or configuration extension; not a URL, not starting with `-`, `$`, `~`, `/`,
 * `@` or `..`; a leading `./` stripped) and scripts (`npm run X`, `pnpm X`, `pnpm run X`, `yarn X`,
 * `yarn run X`, `bun run X`, package-manager subcommands excluded). Placeholders (`<…>`, `{…}`,
 * `your-…`, `path/to/…`) are ignored. De-duplicated, in order, at most 50.
 * @param {string | null | undefined} t
 * @returns {Ref[]}
 */
export function extractRefs(t) {
  if (typeof t !== 'string' || !t) return [];
  /** @type {Ref[]} */
  const refs = [];
  const seen = new Set();
  /** @param {Ref} ref */
  const add = (ref) => {
    const key = `${ref.kind}:${ref.value}`;
    if (seen.has(key) || refs.length >= 50) return;
    seen.add(key);
    refs.push(ref);
  };
  for (const seg of splitCode(stripHtmlComments(t).text).code) {
    for (const m of seg.matchAll(SCRIPT_REF)) {
      const tool = m[1];
      const name = m[2].replace(/[.,:;]+$/, '');
      if ((tool === 'pnpm' || tool === 'yarn') && PM_BUILTINS.has(name.toLowerCase())) continue;
      if (name) add({ kind: 'script', value: name });
    }
    for (const token of seg.split(TOKEN_SPLIT)) {
      const ref = token ? pathRef(token) : null;
      if (!ref) continue;
      add(ref.weak ? { kind: 'path', value: ref.value, weak: true } : { kind: 'path', value: ref.value });
    }
    if (refs.length >= 50) break;
  }
  return refs;
}

/**
 * Resolve references (§5.3.1): a path resolves if it names a tree path or a directory prefix of
 * one (a bare file name also resolves against any path's last segment); a script resolves if
 * `scripts` has it. With `repo` (`owner/name`), a path that starts with the repository's own name
 * (`name/…` or `owner/name/…`, as after `git clone`) is resolved without that prefix, and a mention
 * of the repository itself is not a reference. A weak path that does not resolve is not counted
 * unless its first segment is a directory of the tree.
 * @param {readonly Ref[]} refs
 * @param {{paths?: readonly string[] | null,
 *   scripts?: readonly string[] | Record<string, unknown> | null, repo?: string | null}} [opts]
 * @returns {{cited: number, resolved: number, unresolved: Ref[]}}
 */
export function resolveRefs(refs, { paths, scripts, repo } = {}) {
  const files = new Set();
  const dirs = new Set();
  const basenames = new Set();
  for (const p of paths ?? []) {
    const clean = String(p).replace(/\/+$/, '');
    files.add(clean);
    const parts = clean.split('/');
    basenames.add(parts[parts.length - 1]);
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  const names = new Set(Array.isArray(scripts) ? scripts.map(String)
    : scripts && typeof scripts === 'object' ? Object.keys(scripts) : []);
  const [owner = '', name = ''] = typeof repo === 'string' ? repo.toLowerCase().split('/') : [];
  /** @param {string} v */
  const exists = (v) => files.has(v) || dirs.has(v) || (!v.includes('/') && basenames.has(v));
  /** @type {Ref[]} */
  const unresolved = [];
  let resolved = 0;
  let cited = 0;
  for (const ref of refs ?? []) {
    if (ref.kind === 'script') {
      cited++;
      if (names.has(ref.value)) resolved++;
      else unresolved.push(ref);
      continue;
    }
    let v = ref.value;
    const lower = v.toLowerCase();
    if (name && (lower === name || lower === `${owner}/${name}`)) continue;
    if (name && !exists(v)) {
      const prefix = [`${owner}/${name}/`, `${name}/`].find((p) => lower.startsWith(p));
      if (prefix) v = v.slice(prefix.length);
    }
    const ok = v !== '' && exists(v);
    if (!ok && ref.weak && !dirs.has(v.split('/')[0])) continue;
    cited++;
    if (ok) resolved++;
    else unresolved.push(ref);
  }
  return { cited, resolved, unresolved };
}

// ---------------------------------------------------------------------------------------------
// Links and clone targets
// ---------------------------------------------------------------------------------------------

const URL_PART = '[^()\\s<>]*(?:\\([^()\\s]*\\)[^()\\s<>]*)*';
const TITLE_PART = '(?:\\s+(?:"[^"]*"|\'[^\']*\'|\\([^)]*\\)))?';
const LABEL_PART = '((?:[^\\[\\]\\\\]|\\\\.|\\[[^\\[\\]]*\\])*)';
const MD_LINK = new RegExp(`(!?)\\[${LABEL_PART}\\]\\(\\s*<?(${URL_PART})>?${TITLE_PART}\\s*\\)`, 'g');
const REF_DEF = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?.*$/gm;
const AUTOLINK = /<((?:https?|ftp):\/\/[^\s<>]+)>/gi;
const HTML_ATTR = /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const BARE_URL = /\b(?:https?:\/\/|www\.)[^\s<>"'`\]]+/gi;

/**
 * Trim the punctuation that ends a sentence rather than a URL.
 * @param {string} url
 * @returns {string}
 */
function trimUrl(url) {
  let u = url.replace(/[.,;:!?*_~]+$/, '');
  while (u.endsWith(')') && (u.match(/\(/g) ?? []).length < (u.match(/\)/g) ?? []).length) {
    u = u.slice(0, -1).replace(/[.,;:!?]+$/, '');
  }
  return u;
}

/**
 * Every link in the README prose, one entry per occurrence: Markdown links and images, reference
 * definitions, autolinks, HTML `href`/`src` attributes and bare URLs. Code blocks and inline code
 * are not links and are skipped.
 * @param {string | null | undefined} t
 * @returns {{text: string, url: string}[]}
 */
export function links(t) {
  if (typeof t !== 'string' || !t) return [];
  /** @type {{text: string, url: string}[]} */
  const out = [];
  /**
   * @param {string} s
   * @returns {string}
   */
  const take = (s) => s
    .replace(MD_LINK, (_m, _bang, label, url) => {
      out.push({ text: label.replace(MD_LINK, ' ').trim(), url });
      take(label);
      return ' ';
    })
    .replace(REF_DEF, (_m, label, url) => {
      out.push({ text: label, url });
      return ' ';
    })
    .replace(AUTOLINK, (_m, url) => {
      out.push({ text: url, url });
      return ' ';
    })
    .replace(HTML_ATTR, (_m, a, b) => {
      const url = a ?? b ?? '';
      if (url) out.push({ text: url, url });
      return ' ';
    });
  const rest = take(splitCode(t).prose);
  for (const m of rest.matchAll(BARE_URL)) {
    const url = trimUrl(m[0]);
    if (url.length > 7) out.push({ text: url, url });
  }
  return out;
}

const CLONE_URL = new RegExp('(?:https?://(?:www\\.)?|ssh://git@|git@)github\\.com[/:]([A-Za-z0-9-]+)/'
  + '([A-Za-z0-9._-]+?)(?:\\.git)?(?=$|[\\s`\'")\\]/#?])', 'i');

/**
 * Repositories that the README's `git clone` commands fetch: the first GitHub URL after each
 * `git clone` (flags in between allowed), with `.git` stripped.
 * @param {string | null | undefined} t
 * @returns {{owner: string, name: string}[]}
 */
export function cloneTargets(t) {
  if (typeof t !== 'string' || !t) return [];
  /** @type {{owner: string, name: string}[]} */
  const out = [];
  for (const line of t.split(LINE_SPLIT)) {
    const at = line.search(/\bgit\s+clone\b/i);
    if (at < 0) continue;
    const m = CLONE_URL.exec(line.slice(at));
    if (m) out.push({ owner: m[1], name: m[2] });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Writing system (§5.6 d.script, taste facet script:<script>)
// ---------------------------------------------------------------------------------------------

/** Descriptor labels of §5.6 by script key. */
export const SCRIPT_LABELS = Object.freeze({
  cjk: 'Chinese/Japanese/Korean', cyrillic: 'Cyrillic', arabic: 'Arabic', devanagari: 'Devanagari',
  other: 'Other',
});

const SCRIPT_TESTS = /** @type {const} */ ([
  ['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
  ['cyrillic', /\p{Script=Cyrillic}/u],
  ['arabic', /\p{Script=Arabic}/u],
  ['devanagari', /\p{Script=Devanagari}/u],
]);

/**
 * Dominant writing system of README prose (code, HTML tags and URLs removed): `latin`, `cjk`,
 * `cyrillic`, `arabic`, `devanagari` or `other`. A script whose share of letters exceeds 30 % wins
 * (the largest such); otherwise `other` when non-Latin letters exceed 30 %; otherwise `latin`, which
 * is also the answer for fewer than 10 letters.
 * @param {string | null | undefined} t
 * @returns {'latin' | 'cjk' | 'cyrillic' | 'arabic' | 'devanagari' | 'other'}
 */
export function detectScript(t) {
  if (typeof t !== 'string' || !t) return 'latin';
  const prose = splitCode(stripHtmlComments(t).text).prose
    .replace(/<[^>]*>/g, ' ').replace(/\]\([^)]*\)/g, ']').replace(BARE_URL, ' ');
  /** @type {Record<string, number>} */
  const counts = { latin: 0, cjk: 0, cyrillic: 0, arabic: 0, devanagari: 0, other: 0 };
  let total = 0;
  for (const m of prose.matchAll(/\p{L}/gu)) {
    const ch = m[0];
    total++;
    const hit = SCRIPT_TESTS.find(([, re]) => re.test(ch));
    if (hit) counts[hit[0]]++;
    else if (/\p{Script=Latin}/u.test(ch)) counts.latin++;
    else counts.other++;
  }
  if (total < 10) return 'latin';
  const best = SCRIPT_TESTS.map(([k]) => k).filter((k) => counts[k] / total > 0.3)
    .sort((a, b) => counts[b] - counts[a])[0];
  if (best) return best;
  return (total - counts.latin) / total > 0.3 ? 'other' : 'latin';
}

// ---------------------------------------------------------------------------------------------
// Text addressed to an AI reviewer (§7.2 g.injection)
// ---------------------------------------------------------------------------------------------

/**
 * Quote a match, at most 120 characters (§4.3 evidence quotes).
 * @param {string} s
 * @returns {string}
 */
function quote(s) {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > 120 ? `${clean.slice(0, 119)}\u{2026}` : clean;
}

/**
 * Phrases matching `lexicons.aiAddress` anywhere in the text, as quotes.
 * @param {string | null | undefined} t
 * @returns {string[]}
 */
export function aiAddressed(t) {
  if (typeof t !== 'string' || !t) return [];
  /** @type {string[]} */
  const out = [];
  for (const re of aiAddress) {
    const m = re.exec(t);
    if (m && !out.includes(quote(m[0]))) out.push(quote(m[0]));
  }
  return out;
}

/** Imperatives aimed at a reviewer or model, as they appear inside HTML comments. */
const COMMENT_IMPERATIVES = Object.freeze([
  ...aiAddress,
  new RegExp('\\b(ignore|disregard|forget|override)\\b[^.]{0,60}'
    + '\\b(instructions?|prompts?|rules|guidelines|system prompt)\\b', 'i'),
  new RegExp('(?:^|[.!?:;]\\s*|\\b(?:please|kindly|must|should|always)\\s+)'
    + '(rate|score|rank|grade|give|award|recommend|approve)\\b[^.]{0,60}'
    + '\\b(this|the)\\s+(repo|repository|project|code|codebase|submission)\\b', 'i'),
  new RegExp('\\bgive\\b[^.]{0,30}'
    + '\\b(high|higher|highest|perfect|top|maximum|max|full|positive|good|great|5[- ]star|10/10)\\b'
    + '[^.]{0,20}\\b(scores?|ratings?|marks?|reviews?|grades?|points?)\\b', 'i'),
  new RegExp('\\b(ai|llm|gpt|chatgpt|claude|gemini|copilot|assistant|language model)s?\\b[^.]{0,20}'
    + '\\b(reviewers?|reviewing|evaluators?|evaluating|graders?|judges?|judging|scoring|rating)\\b', 'i'),
]);

/**
 * HTML comments that give instructions to an AI reviewer, as quotes (§7.2 `g.injection`).
 * @param {string | null | undefined} t
 * @returns {string[]}
 */
export function commentImperatives(t) {
  if (typeof t !== 'string' || !t) return [];
  /** @type {string[]} */
  const out = [];
  for (const m of t.matchAll(/<!--([\s\S]*?)(?:-->|$)/g)) {
    const body = m[1].replace(/\s+/g, ' ').trim();
    if (body && COMMENT_IMPERATIVES.some((re) => re.test(body))) out.push(quote(body));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Safe blocks (§10.8)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{type: 'text', text: string} | {type: 'code', text: string}
 *   | {type: 'link', text: string, url: string}} Run
 */
/**
 * @typedef {{type: 'heading', level: number, runs: Run[]}
 *   | {type: 'paragraph', runs: Run[]}
 *   | {type: 'code', lang: string | null, text: string}
 *   | {type: 'list', ordered: boolean, start: number | null, items: Run[][]}
 *   | {type: 'quote', runs: Run[]}
 *   | {type: 'rule'}} Block
 */

const CODE_SPAN = /(`+)(?!`)([\s\S]*?[^`])\1(?!`)/y;
const IMAGE = new RegExp(`!\\[${LABEL_PART}\\]\\(\\s*<?(${URL_PART})>?${TITLE_PART}\\s*\\)`, 'y');
const IMAGE_REF = new RegExp(`!\\[${LABEL_PART}\\](?:\\[([^\\]]*)\\])?`, 'y');
const LINK = new RegExp(`\\[${LABEL_PART}\\]\\(\\s*<?(${URL_PART})>?${TITLE_PART}\\s*\\)`, 'y');
const LINK_REF = new RegExp(`\\[${LABEL_PART}\\](?:\\[([^\\]]*)\\])?`, 'y');
const AUTOLINK_Y = /<((?:https?|ftp):\/\/[^\s<>]+|mailto:[^\s<>]+)>/y;
const BARE_Y = /https?:\/\/[^\s<>"'`]+/y;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!|>~<"']/;

/**
 * Remove emphasis markers, keeping the text.
 * @param {string} s
 * @returns {string}
 */
function stripEmphasis(s) {
  return s
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=[^\s*])([^*]*?[^\s*])\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, '$1$2');
}

/**
 * The plain text of a link label or image alt (nested images become `[image: alt]`).
 * @param {string} label
 * @returns {string}
 */
function plainLabel(label) {
  const runs = parseInline(label, new Map());
  return runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} alt
 * @returns {string}
 */
function imageText(alt) {
  const a = plainLabel(alt);
  return a ? `[image: ${a}]` : '[image]';
}

/**
 * Parse inline Markdown into text, code and link runs. Raw HTML stays literal text.
 * @param {string} text
 * @param {Map<string, string>} refs reference definitions, lower-case label → URL
 * @returns {Run[]}
 */
function parseInline(text, refs) {
  /** @type {(Run & {raw?: boolean})[]} */
  const runs = [];
  let buf = '';
  const flush = () => {
    if (buf) runs.push({ type: 'text', text: buf });
    buf = '';
  };
  /**
   * @param {RegExp} re sticky pattern
   * @param {number} pos
   * @returns {RegExpExecArray | null}
   */
  const at = (re, pos) => {
    re.lastIndex = pos;
    return re.exec(text);
  };
  let pos = 0;
  while (pos < text.length) {
    const ch = text[pos];
    /** @type {RegExpExecArray | null} */
    let m = null;
    if (ch === '\\' && pos + 1 < text.length && ESCAPABLE.test(text[pos + 1])) {
      // An escaped character is literal: keep it out of emphasis stripping.
      flush();
      runs.push({ type: 'text', text: text[pos + 1], raw: true });
      pos += 2;
      continue;
    }
    if (ch === '`' && (m = at(CODE_SPAN, pos))) {
      flush();
      const inner = m[2].replace(/\n/g, ' ');
      runs.push({ type: 'code', text: /^ .* $/.test(inner) && inner.trim() ? inner.slice(1, -1) : inner });
    } else if (ch === '!' && text[pos + 1] === '[' && ((m = at(IMAGE, pos)) || (m = at(IMAGE_REF, pos)))) {
      buf += imageText(m[1]);
    } else if (ch === '[' && (m = at(LINK, pos))) {
      flush();
      runs.push({ type: 'link', text: plainLabel(m[1]) || m[2], url: m[2] });
    } else if (ch === '[' && (m = at(LINK_REF, pos)) && refs.has((m[2] || m[1]).trim().toLowerCase())) {
      flush();
      const url = /** @type {string} */ (refs.get((m[2] || m[1]).trim().toLowerCase()));
      runs.push({ type: 'link', text: plainLabel(m[1]) || url, url });
    } else if (ch === '<' && (m = at(AUTOLINK_Y, pos))) {
      flush();
      runs.push({ type: 'link', text: m[1], url: m[1] });
    } else if (ch === 'h' && !/[\w/]/.test(text[pos - 1] ?? '') && (m = at(BARE_Y, pos))) {
      const url = trimUrl(m[0]);
      flush();
      runs.push({ type: 'link', text: url, url });
      pos += url.length;
      continue;
    } else {
      buf += ch;
      pos++;
      continue;
    }
    pos += m[0].length;
  }
  flush();
  /** @type {Run[]} */
  const out = [];
  for (const r of runs) {
    const run = r.type === 'text'
      ? { type: /** @type {'text'} */ ('text'), text: r.raw ? r.text : stripEmphasis(r.text) } : r;
    const last = out[out.length - 1];
    if (run.type === 'text' && last?.type === 'text') last.text += run.text;
    else if (run.type !== 'text' || run.text) out.push(run);
  }
  return out;
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_2 = /^ {0,3}-+[ \t]*$/;
const QUOTE = /^ {0,3}>[ ]?(.*)$/;
const ITEM = /^(\s*)([-*+]|(\d{1,9})[.)])(?:[ \t]+(.*))?$/;
const TABLE_DELIM = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const REF_DEF_LINE = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+.*)?$/;

/**
 * Cells of a table row joined as text.
 * @param {string} line
 * @returns {string}
 */
function tableRow(line) {
  const cells = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/);
  return cells.map((c) => c.trim().replace(/\\\|/g, '|'))
    .filter((c, i, a) => c || (i > 0 && i < a.length - 1))
    .join(' | ');
}

/**
 * Read untrusted Markdown into plain blocks (§10.8): `heading`, `paragraph`, `code`, `list`, `quote`
 * and `rule`, whose inline runs are text, code or links `{text, url}`. Raw HTML is kept as literal
 * text, images become `[image: alt]`, emphasis markers are dropped, tables become one paragraph per
 * row with cells joined by ` | `, and nested lists and quotes are flattened. Nothing is interpreted as
 * HTML and no URL is checked here: the renderer decides which links may become anchors (see
 * `safeHref`).
 * @param {string | null | undefined} md
 * @param {{maxBytes?: number}} [opts] input cap in UTF-8 bytes (default 32 KB)
 * @returns {Block[]}
 */
export function toSafeBlocks(md, { maxBytes = 32768 } = {}) {
  const src = truncateUtf8(String(md ?? ''), maxBytes).text
    .replace(/\r\n?/g, '\n').replace(/\u{0}/gu, '\u{FFFD}');
  const lines = src.split('\n');
  /** @type {Map<string, string>} */
  const refs = new Map();
  /** @type {Set<number>} */
  const refLines = new Set();
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    const m = inFence ? null : REF_DEF_LINE.exec(line);
    if (m) {
      refLines.add(i);
      const key = m[1].trim().toLowerCase();
      if (!refs.has(key)) refs.set(key, m[2]);
    }
  });

  /** @type {Block[]} */
  const blocks = [];
  /** @type {string[] | null} */
  let para = null;
  /** @type {{ordered: boolean, start: number | null, items: string[]} | null} */
  let list = null;
  /** @type {string[] | null} */
  let quoteLines = null;
  const flushPara = () => {
    if (para) blocks.push({ type: 'paragraph', runs: parseInline(para.join(' '), refs) });
    para = null;
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((s) => parseInline(s, refs));
      blocks.push({ type: 'list', ordered: list.ordered, start: list.start, items });
    }
    list = null;
  };
  const flushQuote = () => {
    if (quoteLines) blocks.push({ type: 'quote', runs: parseInline(quoteLines.join(' '), refs) });
    quoteLines = null;
  };
  const flushAll = () => {
    flushPara();
    flushList();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (refLines.has(i)) {
      flushAll();
      continue;
    }
    const fence = FENCE_OPEN.exec(line);
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      flushAll();
      const indent = fence[1].length;
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
        if (close && close[1][0] === fence[2][0] && close[1].length >= fence[2].length) break;
        body.push(lines[j].replace(new RegExp(`^ {0,${indent}}`), ''));
      }
      const lang = fence[3].trim().split(/\s+/)[0] || null;
      blocks.push({ type: 'code', lang, text: body.join('\n') });
      i = j;
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    if (para && !list && !quoteLines && (SETEXT_1.test(line) || SETEXT_2.test(line))) {
      const text = para.join(' ');
      para = null;
      blocks.push({ type: 'heading', level: SETEXT_1.test(line) ? 1 : 2, runs: parseInline(text, refs) });
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      flushAll();
      blocks.push({ type: 'heading', level: atx[1].length, runs: parseInline(atx[2] ?? '', refs) });
      continue;
    }
    if (THEMATIC.test(line)) {
      flushAll();
      blocks.push({ type: 'rule' });
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      if (!quoteLines) {
        flushPara();
        flushList();
        quoteLines = [];
      }
      let inner = q[1];
      for (let m = QUOTE.exec(inner); m; m = QUOTE.exec(inner)) inner = m[1];
      if (inner.trim()) quoteLines.push(inner.trim());
      continue;
    }
    flushQuote();
    const item = ITEM.exec(line);
    if (item && (list || !para || item[1].length === 0)) {
      const ordered = item[3] !== undefined;
      if (!list || (item[1].length < 2 && list.ordered !== ordered)) {
        flushPara();
        flushList();
        list = { ordered, start: ordered ? Number(item[3]) : null, items: [] };
      }
      list.items.push((item[4] ?? '').trim());
      continue;
    }
    if (list && /^\s{2,}\S/.test(line)) {
      const last = list.items.length - 1;
      list.items[last] = `${list.items[last]} ${line.trim()}`.trim();
      continue;
    }
    flushList();
    const next = lines[i + 1] ?? '';
    if (line.includes('|') && TABLE_DELIM.test(next) && next.includes('-')) {
      flushPara();
      blocks.push({ type: 'paragraph', runs: parseInline(tableRow(line), refs) });
      let j = i + 2;
      for (; j < lines.length && lines[j].includes('|') && lines[j].trim(); j++) {
        blocks.push({ type: 'paragraph', runs: parseInline(tableRow(lines[j]), refs) });
      }
      i = j - 1;
      continue;
    }
    if (!para && /^( {4,}|\t)/.test(line)) {
      const body = [];
      let j = i;
      for (; j < lines.length && (/^( {4,}|\t)/.test(lines[j]) || !lines[j].trim()); j++) {
        body.push(lines[j].replace(/^( {4}|\t)/, ''));
      }
      while (body.length && !body[body.length - 1].trim()) body.pop();
      blocks.push({ type: 'code', lang: null, text: body.join('\n') });
      i = j - 1;
      continue;
    }
    (para ??= []).push(line.trim().replace(/(\\| {2,})$/, ''));
  }
  flushAll();
  return blocks;
}

/**
 * The URL to use as an anchor's `href`, or null when it must stay plain text (§7.6, §10.8). The one
 * link rule the explorer, the gallery and the digest share, `views.mjs#safeLinkUrl`: `https:` with a
 * host and no credentials, at most 2,048 characters, not on a download host or link shortener, and
 * no decoded path segment ending in an archive or executable extension (`/Setup.zip/file`,
 * `/tool.exe.` and `/tool.exe%00` stay text).
 * @param {unknown} url
 * @returns {string | null}
 */
export function safeHref(url) {
  return safeLinkUrl(url);
}
