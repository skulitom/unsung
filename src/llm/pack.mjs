// @ts-check
/**
 * The evidence pack sent to the LLM judge (DESIGN §8.2): at most 48 KB of text built from a
 * `RepoRecord` and a few extra files fetched on demand. In order: a facts section written by Unsung
 * (attention and scores removed), the tree, the README, a manifest, a workflow, the entry point and
 * the largest source file, the largest test file, and design notes. Every repository text is
 * wrapped in a block whose random id the repository cannot know:
 *
 *   <<<FILE path="src/main.rs" bytes=5120 truncated=false id=7f3a9c0b12de>>>
 *   …
 *   <<<END 7f3a9c0b12de>>>
 *
 * Any text that contains the id is cut at that point. The owner's login is replaced by `OWNER`
 * where it names the owner (see `maskOwner`); Unsung's own labels are never rewritten. Pure apart
 * from the injected `rand`.
 */

import { randomBytes } from 'node:crypto';
import { truncateUtf8 } from '../core/util.mjs';
import { RUBRIC_VERSION } from './rubric.mjs';

/** @typedef {import('../core/schema.mjs').RepoRecord} RepoRecord */
/** @typedef {import('../core/schema.mjs').Facts} Facts */

/**
 * A file as fetched for a pack (the `data/cache/files/` shape): `null` when absent or binary.
 * @typedef {{byteSize?: number | null, text: string | null, truncated?: boolean} | null} FetchedFile
 */

/**
 * One FILE block of a built pack.
 * @typedef {object} PackFile
 * @property {string} path the path as shown in the pack (owner masked, unusual characters escaped)
 * @property {string} realPath the path in the repository
 * @property {string} role `readme`, `manifest`, `workflow`, `entry`, `source`, `test` or `design`
 * @property {string} text the text exactly as the pack carries it
 * @property {number} bytes the file's size in the repository (or of its text when unknown)
 * @property {boolean} truncated whether the pack carries less than the whole file
 */

/**
 * @typedef {object} Pack
 * @property {string} text the whole pack
 * @property {PackFile[]} files the FILE blocks, in pack order (claims may cite only these)
 * @property {number} bytes UTF-8 size of `text`
 * @property {string} id the block id (12 hex characters)
 */

/** Largest pack, in UTF-8 bytes (§8.2). */
export const PACK_MAX_BYTES = 48 * 1024;

/** Cap on each fetched file (§8.2). */
export const FILE_FETCH_BYTES = 16 * 1024;

/** At most this many paths are fetched per repository (§8.2). */
export const MAX_PACK_PATHS = 6;

/** Most paths listed in the tree block (§8.2). */
export const TREE_MAX_LINES = 400;

/** Source files larger than this are taken to be generated or bundled and are never fetched. */
export const MAX_SOURCE_BYTES = 256 * 1024;

/** Byte caps per section (§8.2) and the floors a section may shrink to when the pack is full. */
export const SECTION_CAPS = Object.freeze({
  facts: 4096, tree: 16384, readme: 12288, manifest: 4096, workflow: 4096, entry: 8192, source: 8192,
  test: 6144, design: 3072,
});
const SECTION_FLOORS = Object.freeze({
  facts: 4096, tree: 4096, readme: 4096, manifest: 1024, workflow: 1024, entry: 2048, source: 2048,
  test: 1024, design: 0,
});
/** Sections give way in this order when the pack is over its limit. */
const SHRINK_ORDER = ['tree', 'design', 'test', 'source', 'entry', 'workflow', 'manifest', 'readme'];

/** Root manifests (§5.2), language manifests before build tools. */
const MANIFESTS = [
  'package.json', 'deno.json', 'deno.jsonc', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py',
  'setup.cfg', 'requirements.txt', 'Pipfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'build.sbt',
  'project.clj', 'deps.edn', 'Gemfile', 'composer.json', 'Package.swift', 'pubspec.yaml', 'mix.exs',
  'rebar.config',
  'stack.yaml', 'cabal.project', 'build.zig', 'gleam.toml', 'cjpm.toml', 'shard.yml', 'v.mod', 'dune-project',
  'vcpkg.json', 'conanfile.txt', 'conanfile.py', 'CMakeLists.txt', 'meson.build', 'configure.ac', 'xmake.lua',
  'Makefile', 'GNUmakefile', 'justfile', 'flake.nix', 'platformio.ini',
];
const MANIFEST_SUFFIXES = ['.csproj', '.fsproj', '.sln', '.gemspec', '.cabal'];

const SOURCE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'mts', 'cts', 'py', 'rs', 'go', 'java', 'kt', 'kts', 'scala',
  'groovy', 'clj', 'cljs', 'rb', 'php', 'cs', 'fs', 'vb', 'swift', 'm', 'mm', 'c', 'h', 'cc', 'cpp', 'cxx',
  'hpp', 'hh', 'zig', 'dart', 'ex', 'exs', 'erl', 'hrl', 'hs', 'lua', 'sh', 'bash', 'ps1', 'pl', 'pm', 'r',
  'jl', 'nim',
  'ml', 'mli', 'v', 'cj', 'gleam', 'vue', 'svelte', 'astro', 'elm', 'cr', 'sol', 'hx',
]);

/** Directories collapsed to one line in the tree and never fetched from (§8.2). */
const COLLAPSED_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build']);
const EXCLUDED_DIRS = new Set([...COLLAPSED_DIRS, 'third_party', 'target', '.git']);
const SOURCE_DIRS = new Set([
  'src', 'lib', 'cmd', 'pkg', 'internal', 'app', 'crates', 'packages', 'include', 'core', 'source', 'sources',
  'server', 'client', 'bin',
]);
const TEST_DIRS = new Set(['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'testing', 'unittest']);
const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'deno.lock', 'cargo.lock', 'go.sum', 'poetry.lock', 'uv.lock', 'pdm.lock', 'pipfile.lock', 'gemfile.lock',
  'composer.lock', 'package.resolved', 'pubspec.lock', 'mix.lock', 'flake.lock',
]);
const GENERATED = [/\.min\./i, /\.pb\.go$/i, /_pb2\.py$/i, /\.generated\./i, /\.g\.dart$/i,
  /\.designer\.cs$/i, /\.d\.ts$/i, /\.map$/i, /-lock\.json$/i];
const DESIGN_NOTES = ['DESIGN.md', 'ARCHITECTURE.md', 'AGENTS.md'];
const MARKDOWN = /\.(md|markdown|mdx)$|^readme$/i;

/** Test commands of §5.2, to pick the workflow that runs tests. */
const TEST_COMMAND = new RegExp([
  '\\b(npm|pnpm|yarn|bun)( run)? test\\b', 'npx (vitest|jest|mocha|ava|playwright test)', 'node --test',
  'deno test', 'bun test', '\\bvitest\\b', '\\bjest\\b', '\\bpytest\\b', 'python3? -m (pytest|unittest)',
  '\\btox\\b', '\\bnox\\b', 'cargo (test|nextest)', 'go test', 'gotestsum', 'mvn .*(test|verify)',
  'gradlew? .*(test|check)', 'sbt .*test', 'lein test', 'dotnet test', '\\bctest\\b', 'make (test|check)',
  'meson test', 'ninja test', '\\brspec\\b', 'rake (test|spec)', 'phpunit', 'composer test', 'swift test',
  'xcodebuild .*test', '(flutter|dart) test', 'mix test', 'rebar3 (eunit|ct)', '(cabal|stack) test',
  'zig build test', 'just test', 'nix flake check', 'gleam test', 'dune test',
].join('|'));

/**
 * Invisible code points removed from pack text (§7.2, §8.2): zero-width and bidirectional controls,
 * the byte-order mark, Unicode tag characters (U+E0000–U+E007F, which can spell hidden ASCII text
 * that GitHub does not show but a model reads) and the variation-selector supplement
 * (U+E0100–U+E01EF). An emoji flag built from tags becomes a plain black flag.
 */
const INVISIBLE_RANGES = [
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff],
  [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];

// ---------------------------------------------------------------------------------------------
// Small text helpers
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} s
 * @returns {number}
 */
function byteLength(s) {
  return new TextEncoder().encode(s).length;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Logins that are also everyday or technical words. Like logins of three characters or fewer, they
 * are masked only where they name the owner, never as standalone words, so the owner `pdf` leaves
 * "Convert PDF files" alone.
 */
const COMMON_WORD_LOGINS = new Set([
  'test', 'tests', 'code', 'docs', 'data', 'none', 'null', 'true', 'false', 'unknown', 'tree', 'files',
  'file', 'main', 'master', 'build', 'tool', 'tools', 'utils', 'core', 'home', 'blog', 'site', 'demo',
  'example', 'examples', 'sample', 'project', 'github', 'python', 'java', 'rust', 'node', 'linux',
  'android', 'apple', 'google', 'server', 'client', 'config', 'source', 'open', 'free', 'hello', 'world',
  'game', 'games', 'chat', 'mail', 'email', 'image', 'video', 'audio', 'music', 'text', 'json', 'html',
  'http', 'react', 'swift', 'model', 'release', 'readme', 'licence', 'license', 'shell', 'script',
  'library', 'package', 'module', 'plugin', 'theme', 'design', 'notes', 'wiki', 'help', 'support',
  'security', 'version', 'install', 'setup', 'guide', 'learn', 'work', 'team', 'labs', 'cloud', 'mobile',
  'desktop', 'windows', 'terminal', 'editor', 'browser', 'light', 'dark', 'fast', 'simple', 'small',
  'tiny', 'mini', 'micro', 'super', 'meta', 'next', 'time', 'date', 'task', 'todo', 'list', 'graph',
  'chart', 'table', 'form', 'input', 'output', 'stream', 'cache', 'store', 'shop', 'crypto', 'token',
  'wallet', 'user', 'users', 'admin', 'owner', 'repo', 'bytes',
]);

/**
 * Replace the owner's login with `OWNER` where it names the owner (§8.2), case-insensitively:
 * always in `github.com/<login>`, `raw.githubusercontent.com/<login>`, `<login>.github.io`,
 * `@<login>`, an e-mail address `<login>@…` and `<login>/<repo>`; and as a standalone word (not
 * inside a longer login-like word) unless the login has three characters or fewer or is an
 * everyday word, where masking would rewrite ordinary text.
 * @param {string} text
 * @param {string | null | undefined} owner
 * @param {{repo?: string | null}} [opts] the repository name, for `<login>/<repo>`
 * @returns {string}
 */
export function maskOwner(text, owner, { repo } = {}) {
  const s = String(text ?? '');
  const login = String(owner ?? '').trim();
  if (!login) return s;
  const L = escapeRegExp(login);
  const before = '(?<![A-Za-z0-9-])';
  const after = '(?![A-Za-z0-9-])';
  const parts = [
    `(?<=(?:github\\.com|githubusercontent\\.com)/)${L}${after}`,
    `(?<=(?:^|[^\\w.%+-])@)${L}${after}`,
    `${before}${L}(?=\\.github\\.io${after})`,
    `(?<![\\w.%-])${L}(?=@[A-Za-z0-9-]+\\.)`,
  ];
  const name = String(repo ?? '').trim();
  if (name) parts.push(`${before}${L}(?=/${escapeRegExp(name)}(?![A-Za-z0-9_-]))`);
  if (Array.from(login).length > 3 && !COMMON_WORD_LOGINS.has(login.toLowerCase())) {
    parts.push(`${before}${L}${after}`);
  }
  return s.replace(new RegExp(parts.join('|'), 'gi'), 'OWNER');
}

/**
 * @param {number} cp
 * @returns {boolean}
 */
function isInvisible(cp) {
  return INVISIBLE_RANGES.some(([a, b]) => cp >= a && cp <= b);
}

/**
 * Remove zero-width, bidirectional-control and byte-order-mark characters.
 * @param {string} text
 * @returns {{text: string, removed: number}}
 */
export function stripInvisible(text) {
  let removed = 0;
  let out = '';
  for (const ch of String(text ?? '')) {
    if (isInvisible(/** @type {number} */ (ch.codePointAt(0)))) removed++;
    else out += ch;
  }
  return { text: out, removed };
}

/**
 * Remove HTML comments; an unterminated comment runs to the end of the text.
 * @param {string} text
 * @returns {{text: string, removed: number}}
 */
export function stripHtmlComments(text) {
  let removed = 0;
  const out = String(text ?? '').replace(/<!--[\s\S]*?(-->|$)/g, () => {
    removed++;
    return '';
  });
  return { text: out, removed };
}

/**
 * Quote a repository string for a block header or the facts section: `"…"` with quotes,
 * backslashes, angle brackets, control, separator and invisible characters escaped as `\uXXXX`
 * (`\u{XXXXX}` above U+FFFF, such as tag characters), so no repository string can end a header
 * line or open a block. Ordinary paths are unchanged.
 * @param {string} s
 * @returns {string} the text between the quotes
 */
export function escapeInner(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    const cp = /** @type {number} */ (ch.codePointAt(0));
    const bad = cp < 0x20 || cp === 0x7f || cp === 0x2028 || cp === 0x2029 || isInvisible(cp)
      || ch === '"' || ch === '\\' || ch === '<' || ch === '>';
    const code = cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
    out += bad ? code : ch;
  }
  return out;
}

/**
 * @param {string} s
 * @param {number} [max] characters
 * @returns {string}
 */
function quote(s, max = 80) {
  const chars = Array.from(String(s ?? ''));
  const cut = chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
  return `"${escapeInner(cut)}"`;
}

/**
 * @param {number} n
 * @returns {string}
 */
function fmtInt(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Cut text to at most `limit` UTF-8 bytes, preferring a line end near the cut.
 * @param {string} text
 * @param {number} limit
 * @returns {{text: string, truncated: boolean}}
 */
function cutText(text, limit) {
  const { text: cut, truncated } = truncateUtf8(text, Math.max(0, limit));
  if (!truncated) return { text: cut, truncated };
  const nl = cut.lastIndexOf('\n');
  return { text: nl >= cut.length * 0.75 ? cut.slice(0, nl + 1) : cut, truncated: true };
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} p
 * @returns {string}
 */
function baseName(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * @param {string} p
 * @returns {string}
 */
function extension(p) {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase();
}

/**
 * Whether a path is a test file or sits in a test directory (§5.2, simplified).
 * @param {string} p
 * @returns {boolean}
 */
export function isTestPath(p) {
  const segments = String(p).split('/');
  const base = segments[segments.length - 1];
  const dirs = segments.slice(0, -1).map((d) => d.toLowerCase());
  if (dirs.some((d) => TEST_DIRS.has(d) || d.endsWith('.tests') || d === 'integration_test')) return true;
  return /\.(test|spec)\.[cm]?[jt]sx?$/i.test(base) || /^test_.*\.py$|_test\.py$/i.test(base)
    || /_test\.go$/.test(base) || /Tests?\.(java|kt)$/.test(base) || /Spec\.scala$/.test(base)
    || /_(spec|test)\.rb$/.test(base) || /Test\.php$/.test(base) || /_test\.exs$/.test(base)
    || /^test_.*\.c(c|pp|xx)?$|_test\.c(c|pp|xx)?$/i.test(base);
}

/**
 * Whether a path is under a vendored, built or dependency directory, or is a lockfile or a
 * generated or minified file.
 * @param {string} p
 * @returns {boolean}
 */
function isExcluded(p) {
  const segments = String(p).split('/');
  if (segments.slice(0, -1).some((d) => EXCLUDED_DIRS.has(d.toLowerCase()))) return true;
  const base = segments[segments.length - 1];
  return LOCKFILES.has(base.toLowerCase()) || GENERATED.some((re) => re.test(base));
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isSource(p) {
  return SOURCE_EXTENSIONS.has(extension(p)) && !isExcluded(p);
}

/**
 * Blobs of the deep tree, or of the root listing when the tree was not fetched.
 * @param {Facts} facts
 * @returns {{path: string, size: number | null}[]}
 */
function blobsOf(facts) {
  const entries = facts?.tree?.entries;
  if (Array.isArray(entries) && entries.length > 0) {
    return entries.filter((e) => Array.isArray(e) && e[1] === 'blob' && typeof e[0] === 'string')
      .map((e) => ({ path: e[0], size: typeof e[2] === 'number' ? e[2] : null }));
  }
  return (facts?.root ?? []).filter((e) => e && e.type === 'blob' && typeof e.name === 'string')
    .map((e) => ({ path: e.name, size: null }));
}

/**
 * @param {unknown} v
 * @returns {string | null}
 */
function firstString(v) {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(firstString).find((x) => x) ?? null;
  if (v && typeof v === 'object') {
    const o = /** @type {Record<string, unknown>} */ (v);
    for (const k of ['.', 'import', 'require', 'default', 'node']) {
      const s = firstString(o[k]);
      if (s) return s;
    }
    return Object.values(o).map(firstString).find((x) => x) ?? null;
  }
  return null;
}

/**
 * @param {string} p
 * @returns {string}
 */
function stripDotSlash(p) {
  return p.replace(/^\.\//, '');
}

/**
 * @param {string} p
 * @param {string} pattern `*` matches one path segment
 * @returns {boolean}
 */
function globMatch(p, pattern) {
  const re = new RegExp(`^${pattern.split('*').map(escapeRegExp).join('[^/]*')}$`);
  return re.test(p);
}

/**
 * @typedef {{role: string, path: string, text: string | null, bytes: number | null, known: boolean}} Slot
 *   `known`: the text comes from the facts, so nothing needs fetching
 */

/**
 * Decide which file fills each pack slot. Pure and deterministic, so `choosePackPaths` and
 * `buildPack` agree.
 * @param {RepoRecord} record
 * @returns {Slot[]}
 */
function planPack(record) {
  const facts = /** @type {Facts} */ (record?.facts ?? {});
  const blobs = blobsOf(facts);
  const paths = new Set(blobs.map((b) => b.path));
  const rootNames = new Set((facts.root ?? []).map((e) => e?.name).filter(Boolean));
  const has = (/** @type {string} */ p) => paths.has(p) || (!p.includes('/') && rootNames.has(p));
  const sizeOf = (/** @type {string} */ p) => blobs.find((b) => b.path === p)?.size ?? null;
  /** @type {Slot[]} */
  const slots = [];
  const taken = new Set();

  // Manifest: package.json when present (its full text is never in the facts), else the deep manifest.
  if (has('package.json')) {
    const bytes = sizeOf('package.json');
    slots.push({ role: 'manifest', path: 'package.json', text: null, bytes, known: false });
  } else if (facts.manifest?.path && typeof facts.manifest.text === 'string') {
    const { path: p, text } = facts.manifest;
    slots.push({ role: 'manifest', path: p, text, bytes: null, known: true });
  } else {
    const name = MANIFESTS.find((m) => has(m))
      ?? [...rootNames].find((n) => MANIFEST_SUFFIXES.some((s) => String(n).toLowerCase().endsWith(s)));
    if (name) slots.push({ role: 'manifest', path: name, text: null, bytes: sizeOf(name), known: false });
  }

  // Workflow: the one that runs tests, else the first.
  const wfs = (facts.workflows ?? []).filter((w) => w && /\.ya?ml$/i.test(String(w.name)));
  if (wfs.length > 0) {
    const withText = wfs.filter((w) => typeof w.text === 'string');
    const pick = withText.find((w) => TEST_COMMAND.test(/** @type {string} */ (w.text)))
      ?? (withText.length > 0 ? withText[0] : wfs.find((w) => /test|ci|build|check/i.test(w.name)) ?? wfs[0]);
    const p = `.github/workflows/${pick.name}`;
    const known = typeof pick.text === 'string';
    slots.push({ role: 'workflow', path: p, text: known ? pick.text : null, bytes: sizeOf(p), known });
  }
  for (const s of slots) taken.add(s.path);

  // Entry point: package.json bin/main/exports when the facts carry them, else by name (§8.2).
  const pj = /** @type {Record<string, unknown> | null} */ (facts.packageJson ?? null);
  const declared = pj ? [pj.bin, pj.main, pj.exports].map(firstString).filter(Boolean) : [];
  const sources = blobs.filter((b) => isSource(b.path) && !isTestPath(b.path)
    && (b.size === null || b.size <= MAX_SOURCE_BYTES));
  const sourcePaths = new Set(sources.map((b) => b.path));
  let entry = declared.map((d) => stripDotSlash(/** @type {string} */ (d))).find((d) => sourcePaths.has(d));
  if (!entry) {
    const patterns = ['src/main.*', 'main.go', 'cmd/*/main.go', 'src/lib.rs', 'src/main.rs', '__main__.py',
      '*/__main__.py', 'cli.py', '*/cli.py', 'index.*', 'src/index.*'];
    for (const pattern of patterns) {
      entry = sources.map((b) => b.path).find((p) => globMatch(p, pattern));
      if (entry) break;
    }
  }
  if (entry && !taken.has(entry)) {
    slots.push({ role: 'entry', path: entry, text: null, bytes: sizeOf(entry), known: false });
    taken.add(entry);
  }

  /** @param {{path: string, size: number | null}[]} list */
  const largest = (list) => list.filter((b) => !taken.has(b.path) && b.size !== null)
    .sort((a, b) => /** @type {number} */ (b.size) - /** @type {number} */ (a.size)
      || (a.path < b.path ? -1 : 1))[0];
  const big = largest(sources);
  if (big) {
    slots.push({ role: 'source', path: big.path, text: null, bytes: big.size, known: false });
    taken.add(big.path);
  }
  const test = largest(blobs.filter((b) => isTestPath(b.path) && SOURCE_EXTENSIONS.has(extension(b.path))
    && !isExcluded(b.path) && (b.size === null || b.size <= MAX_SOURCE_BYTES)));
  if (test) {
    slots.push({ role: 'test', path: test.path, text: null, bytes: test.size, known: false });
    taken.add(test.path);
  }
  const lookup = (/** @type {string} */ n) => {
    const want = n.toLowerCase();
    const blob = blobs.find((b) => b.path.toLowerCase() === want)?.path;
    if (blob || n.includes('/')) return blob;
    return [...rootNames].find((r) => String(r).toLowerCase() === want);
  };
  const design = DESIGN_NOTES.flatMap((n) => [n, `docs/${n}`]).map(lookup).find((p) => p && !taken.has(p));
  if (design) slots.push({ role: 'design', path: design, text: null, bytes: sizeOf(design), known: false });
  return slots;
}

/**
 * The paths to fetch for a repository's pack (§8.2): the manifest, workflow, entry point, largest
 * source file, largest test file and design notes whose text is not already in the facts, at most
 * six, in pack order. The README comes from the facts and is never fetched.
 * @param {RepoRecord} record
 * @returns {string[]}
 */
export function choosePackPaths(record) {
  return planPack(record).filter((s) => !s.known).map((s) => s.path).slice(0, MAX_PACK_PATHS);
}

// ---------------------------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------------------------

/**
 * @param {string | null | undefined} iso
 * @returns {string}
 */
function day(iso) {
  return typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : 'unknown';
}

/**
 * The facts section (§8.2 item 1): written by Unsung; attention, owner and scores removed. The owner
 * is masked only in the quoted strings that come from the repository, never in Unsung's own labels.
 * @param {RepoRecord} record
 * @param {(s: string) => string} mask the owner masking of `maskOwner`
 * @returns {string}
 */
function factsText(record, mask) {
  const f = /** @type {Facts} */ (record.facts ?? {});
  const quoted = (/** @type {unknown} */ s, /** @type {number} */ max) => quote(mask(String(s ?? '')), max);
  const lines = [];
  const langs = (f.languages ?? []).filter((l) => l && typeof l.name === 'string');
  const total = langs.reduce((a, l) => a + (Number(l.bytes) || 0), 0);
  lines.push(langs.length === 0 ? '- Languages: unknown' : `- Languages: ${langs.map((l) => {
    const share = total > 0 ? ` (${Math.round((100 * (Number(l.bytes) || 0)) / total)} %)` : '';
    return `${quoted(l.name, 40)} ${fmtInt(Number(l.bytes) || 0)} bytes${share}`;
  }).join(', ')}`);
  lines.push(`- Code: ${typeof f.codeBytes === 'number' ? `${fmtInt(f.codeBytes)} bytes` : 'unknown'}`);
  lines.push(`- Licence: ${f.licence ? quoted(f.licence, 40) : 'none detected'}`);
  lines.push(`- Created ${day(f.createdAt)}; last push ${day(f.pushedAt)}`);
  if (f.releases) {
    const recent = (f.releases.recent ?? []).slice(0, 5)
      .map((r) => `${quoted(r.tag, 40)} ${day(r.publishedAt)}${r.prerelease ? ' (prerelease)' : ''}`);
    lines.push(`- Releases: ${f.releases.count}${recent.length > 0 ? `, latest ${recent.join(', ')}` : ''}`
      + `${typeof f.tags === 'number' ? `; tags: ${f.tags}` : ''}`);
  } else lines.push('- Releases: unknown');
  const blobs = blobsOf(f);
  const tests = blobs.filter((b) => isTestPath(b.path) && !isExcluded(b.path)).length;
  lines.push(f.tree
    ? `- Test files in the tree: ${tests}`
    : `- Test files at the root: ${tests} (the full tree was not fetched)`);
  const wfs = (f.workflows ?? []).map((w) => quoted(w?.name ?? '', 60));
  lines.push(`- Workflows: ${f.workflows === null || f.workflows === undefined ? 'unknown'
    : wfs.length > 0 ? wfs.join(', ') : 'none'}`);
  lines.push(`- CI state on the scored commit: ${f.rollup ?? 'unknown'}`);
  const chips = (record.score?.signals ?? []).filter((s) => ['quality', 'proof', 'slop'].includes(s.kind));
  if (chips.length > 0) {
    lines.push('- Checklist (points hidden):');
    for (const s of chips) {
      const state = s.status === 'na' ? 'does not apply'
        : s.status === 'unknown' ? 'unknown' : s.hit ? 'hit' : 'miss';
      // A slop signal retired to weight 0 (§4.4: `s.incoherent` since weights w2) is a marker the
      // checklist still shows, not a penalty, so the reviewer is not told it counts against.
      const penalty = s.kind === 'slop' && s.weight !== 0;
      lines.push(`  - ${s.label}${penalty ? ' (penalty)' : ''}: ${state}`);
    }
  } else lines.push('- Checklist: not scored');
  const descriptors = (record.score?.descriptors ?? []).filter((d) => d && typeof d.label === 'string');
  if (descriptors.length > 0) {
    const shown = descriptors.map((d) => `${d.label}${d.detail ? ` (${quoted(d.detail, 60)})` : ''}`);
    lines.push(`- Descriptors: ${shown.join('; ')}`);
  }
  return lines.join('\n');
}

/**
 * @typedef {object} TreeListing
 * @property {string[]} lines collapsed directories first, then source directories, root files, the rest
 * @property {number} total blobs in the listing
 * @property {string[]} notes
 */

/**
 * @param {string} p
 * @returns {string}
 */
function treePath(p) {
  const inner = escapeInner(p);
  return inner === p && p.trim() === p ? p : `"${inner}"`;
}

/**
 * The tree listing (§8.2 item 2).
 * @param {Facts} facts
 * @returns {TreeListing}
 */
function treeListing(facts) {
  const entries = facts?.tree?.entries;
  const deep = Array.isArray(entries) && entries.length > 0;
  /** @type {{path: string, size: number | null}[]} */
  const blobs = deep
    ? blobsOf(facts)
    : (facts?.root ?? []).filter((e) => e && typeof e.name === 'string')
      .map((e) => ({ path: e.type === 'tree' ? `${e.name}/` : e.name, size: null }));
  /** @type {Map<string, number>} */
  const collapsed = new Map();
  const kept = [];
  for (const b of blobs) {
    const segments = b.path.split('/');
    const at = segments.slice(0, -1).findIndex((d) => COLLAPSED_DIRS.has(d.toLowerCase()));
    if (at >= 0) {
      const prefix = `${segments.slice(0, at + 1).join('/')}/`;
      collapsed.set(prefix, (collapsed.get(prefix) ?? 0) + 1);
    } else kept.push(b);
  }
  const group = (/** @type {string} */ p) => {
    const i = p.indexOf('/');
    if (i < 0 || i === p.length - 1) return 1;
    return SOURCE_DIRS.has(p.slice(0, i).toLowerCase()) ? 0 : 2;
  };
  const ordered = kept.map((b, i) => ({ b, i }))
    .sort((x, y) => group(x.b.path) - group(y.b.path) || x.i - y.i);
  const lines = [
    ...[...collapsed].map(([prefix, n]) => `${treePath(prefix)} (${fmtInt(n)} files, collapsed)`),
    ...ordered.map(({ b }) => `${treePath(b.path)}${b.size !== null ? ` ${b.size}` : ''}`),
  ];
  const notes = [];
  if (!deep) notes.push('Only the root listing was fetched; sizes are unknown.');
  else if (facts.tree?.truncated) notes.push('GitHub truncated the tree listing.');
  return { lines, total: blobs.length, notes };
}

/**
 * @param {() => number} rand
 * @returns {string} 12 hex characters (6 random bytes)
 */
function packIdFrom(rand) {
  let out = '';
  for (let i = 0; i < 6; i++) out += Math.floor(rand() * 256).toString(16).padStart(2, '0');
  return out;
}

/**
 * @typedef {object} FileSection
 * @property {string} role
 * @property {string} realPath
 * @property {string} shown
 * @property {string} full prepared text before the size cut
 * @property {number} bytes
 * @property {boolean} preTruncated
 * @property {string[]} notes
 * @property {number} limit current byte limit
 */

/**
 * Prepare one repository text for the pack: HTML comments (Markdown only) and invisible characters
 * removed, the owner masked, and anything from the pack id onwards cut.
 * @param {string} text
 * @param {string} realPath
 * @param {(s: string) => string} mask the owner masking of `maskOwner`
 * @param {string} id
 * @returns {{text: string, notes: string[], cut: boolean}}
 */
function prepareText(text, realPath, mask, id) {
  let t = String(text);
  let comments = 0;
  if (MARKDOWN.test(baseName(realPath))) ({ text: t, removed: comments } = stripHtmlComments(t));
  const inv = stripInvisible(t);
  t = mask(inv.text);
  const at = t.indexOf(id);
  const cut = at >= 0;
  if (cut) t = t.slice(0, at);
  const removed = [];
  if (comments > 0) removed.push(`${comments} HTML comment${comments === 1 ? '' : 's'}`);
  if (inv.removed > 0) removed.push(`${inv.removed} invisible character${inv.removed === 1 ? '' : 's'}`);
  const shown = escapeInner(mask(realPath));
  const notes = removed.length > 0 ? [`Note: ${removed.join(' and ')} removed from "${shown}".`] : [];
  return { text: t, notes, cut };
}

/**
 * Build the evidence pack (§8.2) for a repository record and the files fetched for it (a map from
 * path to `{byteSize, text}` or null, as `choosePackPaths` asked). Sections are capped as §8.2 says
 * and give way, tree first, when the whole would exceed 48 KB.
 * @param {RepoRecord} record
 * @param {Record<string, FetchedFile> | null | undefined} files
 * @param {{rand?: () => number, id?: string}} [opts] `rand` makes the block id reproducible in tests
 * @returns {Pack}
 */
export function buildPack(record, files, opts = {}) {
  const facts = /** @type {Facts} */ (record?.facts ?? {});
  const owner = facts.owner ?? String(record?.nwo ?? '').split('/')[0];
  const repoName = facts.name ?? String(record?.nwo ?? '').split('/')[1] ?? '';
  const mask = (/** @type {string} */ s) => maskOwner(s, owner, { repo: repoName });
  const id = opts.id ?? (opts.rand ? packIdFrom(opts.rand) : packIdFrom(secureRand));

  /** @type {FileSection[]} */
  const sections = [];
  if (facts.readme && typeof facts.readme.text === 'string') {
    const realPath = facts.readme.name || 'README.md';
    const p = prepareText(facts.readme.text, realPath, mask, id);
    sections.push({
      role: 'readme', realPath, shown: escapeInner(mask(realPath)), full: p.text,
      bytes: typeof facts.readme.bytes === 'number' ? facts.readme.bytes : byteLength(facts.readme.text),
      preTruncated: facts.readme.truncated === true || p.cut, notes: p.notes, limit: SECTION_CAPS.readme,
    });
  }
  for (const slot of planPack(record)) {
    const fetched = slot.known ? null : files?.[slot.path];
    const text = slot.known ? slot.text : fetched?.text;
    if (typeof text !== 'string') continue;
    const p = prepareText(text, slot.path, mask, id);
    const size = typeof fetched?.byteSize === 'number' ? fetched.byteSize : slot.bytes ?? byteLength(text);
    sections.push({
      role: slot.role, realPath: slot.path, shown: escapeInner(mask(slot.path)), full: p.text,
      bytes: size, preTruncated: fetched?.truncated === true || size > byteLength(text) || p.cut,
      notes: p.notes, limit: /** @type {Record<string, number>} */ (SECTION_CAPS)[slot.role] ?? 4096,
    });
  }

  const facts0 = factsText(record, mask);
  const factsBody = cutText(facts0.includes(id) ? facts0.slice(0, facts0.indexOf(id)) : facts0,
    SECTION_CAPS.facts).text;
  const tree = treeListing(facts);
  let treeLimit = SECTION_CAPS.tree;
  const intro = [
    `Evidence pack prepared by Unsung for review rubric ${RUBRIC_VERSION}.`,
    `Repository: ${mask(String(record?.nwo ?? ''))}`,
    `Every block below carries the id ${id}; only an END line with that id closes a block.`,
  ].join('\n');

  const renderTree = () => {
    const out = [];
    let used = 0;
    let shown = 0;
    for (const raw of tree.lines) {
      if (shown >= TREE_MAX_LINES) break;
      const line = mask(raw);
      if (line.includes(id)) continue;
      const b = byteLength(line) + 1;
      if (used + b > treeLimit) break;
      out.push(line);
      used += b;
      shown++;
    }
    const rest = tree.lines.length - shown;
    if (rest > 0) out.push(`… ${fmtInt(rest)} more lines not shown`);
    const body = out.length > 0 ? `${out.join('\n')}\n` : '';
    return `<<<TREE files=${tree.total} shown=${shown} id=${id}>>>\n${body}<<<END ${id}>>>`;
  };

  /** @param {FileSection} s */
  const renderFile = (s) => {
    const { text, truncated } = cutText(s.full, s.limit);
    const body = text === '' || text.endsWith('\n') ? text : `${text}\n`;
    const cutFlag = truncated || s.preTruncated;
    const header = `<<<FILE path="${s.shown}" bytes=${s.bytes} truncated=${cutFlag} id=${id}>>>`;
    return { block: [...s.notes, `${header}\n${body}<<<END ${id}>>>`].join('\n'), text, truncated };
  };

  /** @param {FileSection[]} list */
  const assemble = (list) => [
    intro, '', '## Facts (written by Unsung; quoted strings come from the repository)', factsBody, '',
    '## Tree', ...tree.notes, renderTree(), '', '## Files',
    ...(list.length > 0 ? list.map((s) => `${renderFile(s).block}\n`) : ['(no files)']),
  ].join('\n');

  let included = sections;
  let text = assemble(included);
  for (let pass = 0; pass < 3 && byteLength(text) > PACK_MAX_BYTES; pass++) {
    for (const key of SHRINK_ORDER) {
      const over = byteLength(text) - PACK_MAX_BYTES;
      if (over <= 0) break;
      const floor = /** @type {Record<string, number>} */ (SECTION_FLOORS)[key];
      if (key === 'tree') {
        treeLimit = Math.max(floor, treeLimit - over - 64);
      } else {
        const s = included.find((x) => x.role === key);
        if (!s) continue;
        const current = Math.min(s.limit, byteLength(s.full));
        s.limit = Math.max(floor, current - over - 64);
      }
      text = assemble(included);
    }
  }
  while (byteLength(text) > PACK_MAX_BYTES && included.length > 0) {
    included = included.slice(0, -1);
    text = assemble(included);
  }

  /** @type {PackFile[]} */
  const packFiles = included.map((s) => {
    const r = renderFile(s);
    return {
      path: s.shown, realPath: s.realPath, role: s.role, text: r.text, bytes: s.bytes,
      truncated: r.truncated || s.preTruncated,
    };
  });
  return { text, files: packFiles, bytes: byteLength(text), id };
}

/** @returns {number} a float in [0, 1) from the operating system's random source */
function secureRand() {
  return randomBytes(4).readUInt32BE(0) / 4294967296;
}
