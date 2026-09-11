// @ts-check
/**
 * The ecosystem table of DESIGN §5.2 as data, and the questions the signals ask of it: which
 * ecosystems a repository belongs to, which root names are manifests or lockfiles, which paths are
 * tests, which workflow commands run tests, and whether a manifest declares no dependencies.
 *
 * Name matching is case-insensitive; a manifest or lockfile pattern that starts with `*` matches a
 * suffix (`*.csproj`). Test-file patterns keep their case (`*Test.java` must not match `latest.java`).
 */

/** @typedef {import('./schema.mjs').Facts} Facts */

/**
 * @typedef {object} Ecosystem
 * @property {string} id
 * @property {readonly string[]} languages GitHub Linguist names that make a repository this ecosystem
 * @property {readonly string[]} manifests root names (lower-case; `*` prefix = suffix match)
 * @property {readonly string[]} lockfiles root names (lower-case)
 * @property {boolean} lockfileOptional true where §5.2 says an absent lockfile makes `q.deps` `na`
 * @property {readonly string[]} testDirs directory names (lower-case)
 * @property {readonly RegExp[]} testDirPatterns directory-name patterns (e.g. `*.Tests/`)
 * @property {readonly RegExp[]} testFiles file-name patterns
 * @property {readonly RegExp[]} testCommands commands that run tests in a workflow `run:`
 */

/** @type {readonly Ecosystem[]} */
export const ECOSYSTEMS = Object.freeze([
  {
    id: 'node',
    languages: ['JavaScript', 'TypeScript', 'Vue', 'Svelte', 'Astro'],
    manifests: ['package.json', 'deno.json', 'deno.jsonc'],
    lockfiles: [
      'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
      'deno.lock',
    ],
    lockfileOptional: false,
    testDirs: ['test', 'tests', '__tests__', 'spec', 'e2e'],
    testDirPatterns: [],
    testFiles: [/\.test\.[cm]?[jt]sx?$/, /\.spec\.[cm]?[jt]sx?$/],
    testCommands: [
      /\b(npm|pnpm|yarn|bun)( run)? test\b/, /\bnpx (vitest|jest|mocha|ava|playwright test)\b/,
      /\bnode --test\b/, /\bdeno test\b/, /\bbun test\b/, /\bvitest\b/, /\bjest\b/,
    ],
  },
  {
    id: 'python',
    languages: ['Python', 'Jupyter Notebook'],
    manifests: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'pipfile'],
    lockfiles: ['poetry.lock', 'uv.lock', 'pdm.lock', 'pipfile.lock'],
    lockfileOptional: false,
    testDirs: ['tests', 'test', 'testing'],
    testDirPatterns: [],
    testFiles: [/^test_.*\.py$/, /_test\.py$/],
    testCommands: [
      /\bpytest\b/, /\bpython3? -m (pytest|unittest)\b/, /\btox\b/, /\bnox\b/, /\bhatch (run )?test\b/,
      /\buv run pytest\b/,
    ],
  },
  {
    id: 'rust',
    languages: ['Rust'],
    manifests: ['cargo.toml'],
    lockfiles: ['cargo.lock'],
    lockfileOptional: true,
    testDirs: ['tests'],
    testDirPatterns: [],
    testFiles: [],
    testCommands: [/\bcargo (test|nextest)\b/],
  },
  {
    id: 'go',
    languages: ['Go'],
    manifests: ['go.mod'],
    lockfiles: ['go.sum'],
    lockfileOptional: false,
    testDirs: [],
    testDirPatterns: [],
    testFiles: [/_test\.go$/],
    testCommands: [/\bgo test\b/, /\bgotestsum\b/],
  },
  {
    id: 'jvm',
    languages: ['Java', 'Kotlin', 'Scala', 'Groovy', 'Clojure'],
    manifests: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'build.sbt', 'project.clj', 'deps.edn'],
    lockfiles: ['gradle.lockfile'],
    lockfileOptional: true,
    testDirs: ['test'],
    testDirPatterns: [],
    testFiles: [/Test\.java$/, /Tests\.java$/, /Test\.kt$/, /Spec\.scala$/],
    testCommands: [
      /\bmvn .*(test|verify)/, /\.?\/?\bgradlew? .*(test|check|build)/, /\bsbt .*test/, /\blein test\b/,
    ],
  },
  {
    id: 'dotnet',
    languages: ['C#', 'F#', 'Visual Basic .NET'],
    manifests: ['*.csproj', '*.fsproj', '*.sln'],
    lockfiles: ['packages.lock.json'],
    lockfileOptional: true,
    testDirs: ['tests'],
    testDirPatterns: [/\.tests$/i],
    testFiles: [],
    testCommands: [/\bdotnet test\b/],
  },
  {
    id: 'c-cpp',
    languages: ['C', 'C++', 'Objective-C', 'CUDA'],
    manifests: [
      'cmakelists.txt', 'makefile', 'gnumakefile', 'meson.build', 'configure.ac', 'xmake.lua', 'vcpkg.json',
      'conanfile.txt', 'conanfile.py',
    ],
    lockfiles: [],
    lockfileOptional: true,
    testDirs: ['test', 'tests', 'unittest'],
    testDirPatterns: [],
    testFiles: [/_test\.c[\w+]*$/, /^test_.*\.c[\w+]*$/],
    testCommands: [/\bctest\b/, /\bmake (test|check)\b/, /\bmeson test\b/, /\bninja test\b/],
  },
  {
    id: 'ruby',
    languages: ['Ruby'],
    manifests: ['gemfile', '*.gemspec'],
    lockfiles: ['gemfile.lock'],
    lockfileOptional: false,
    testDirs: ['spec', 'test'],
    testDirPatterns: [],
    testFiles: [/_spec\.rb$/, /_test\.rb$/],
    testCommands: [/\b(bundle exec )?(rspec|rake( test| spec)?)\b/],
  },
  {
    id: 'php',
    languages: ['PHP'],
    manifests: ['composer.json'],
    lockfiles: ['composer.lock'],
    lockfileOptional: false,
    testDirs: ['tests'],
    testDirPatterns: [],
    testFiles: [/Test\.php$/],
    testCommands: [/(\bvendor\/bin\/)?\b(phpunit|pest)\b/, /\bcomposer test\b/],
  },
  {
    id: 'swift',
    languages: ['Swift'],
    manifests: ['package.swift'],
    lockfiles: ['package.resolved'],
    lockfileOptional: false,
    testDirs: ['tests'],
    testDirPatterns: [],
    testFiles: [],
    testCommands: [/\bswift test\b/, /\bxcodebuild .*test/],
  },
  {
    id: 'dart',
    languages: ['Dart'],
    manifests: ['pubspec.yaml'],
    lockfiles: ['pubspec.lock'],
    lockfileOptional: false,
    testDirs: ['test'],
    testDirPatterns: [],
    testFiles: [],
    testCommands: [/\b(flutter|dart) test\b/],
  },
  {
    id: 'beam',
    languages: ['Elixir', 'Erlang'],
    manifests: ['mix.exs', 'rebar.config'],
    lockfiles: ['mix.lock', 'rebar.lock'],
    lockfileOptional: false,
    testDirs: ['test'],
    testDirPatterns: [],
    testFiles: [/_test\.exs$/],
    testCommands: [/\bmix test\b/, /\brebar3 (eunit|ct)\b/],
  },
  {
    id: 'haskell',
    languages: ['Haskell'],
    manifests: ['*.cabal', 'stack.yaml', 'cabal.project'],
    lockfiles: ['cabal.project.freeze', 'stack.yaml.lock'],
    lockfileOptional: false,
    testDirs: ['test'],
    testDirPatterns: [],
    testFiles: [],
    testCommands: [/\b(cabal|stack) test\b/],
  },
  {
    id: 'other',
    languages: [],
    manifests: [
      'build.zig', 'justfile', 'flake.nix', 'cjpm.toml', 'gleam.toml', 'shard.yml', 'v.mod', 'dune-project',
      'platformio.ini',
    ],
    lockfiles: ['flake.lock', 'manifest.toml'],
    lockfileOptional: true,
    testDirs: ['test', 'tests'],
    testDirPatterns: [],
    testFiles: [],
    testCommands: [
      /\bzig build test\b/, /\bjust test\b/, /\bmake test\b/, /\bnix flake check\b/, /\bgleam test\b/,
      /\bdune test\b/,
    ],
  },
].map((e) => Object.freeze(e)));

/** Paths whose tests belong to someone else (§5.3 `q.tests`). */
const FOREIGN_DIRS = new Set(['node_modules', 'vendor', 'third_party']);

const BY_ID = new Map(ECOSYSTEMS.map((e) => [e.id, e]));
const ALL_TEST_DIRS = new Set(ECOSYSTEMS.flatMap((e) => e.testDirs));
const ALL_TEST_DIR_PATTERNS = ECOSYSTEMS.flatMap((e) => e.testDirPatterns);
const ALL_TEST_FILES = ECOSYSTEMS.flatMap((e) => e.testFiles);

/**
 * @param {string} name
 * @param {readonly string[]} patterns lower-case names, `*` prefix = suffix
 * @returns {boolean}
 */
function matchName(name, patterns) {
  const n = String(name).toLowerCase();
  return patterns.some((p) => (p.startsWith('*')
    ? n.length > p.length - 1 && n.endsWith(p.slice(1))
    : n === p));
}

/**
 * Whether a root entry name is a §5.2 manifest of any ecosystem.
 * @param {string} name
 * @returns {boolean}
 */
export function isManifest(name) {
  return ECOSYSTEMS.some((e) => matchName(name, e.manifests));
}

/**
 * The ecosystem a manifest belongs to, or null.
 * @param {string} name
 * @returns {string | null}
 */
export function manifestEcosystem(name) {
  return ECOSYSTEMS.find((e) => matchName(name, e.manifests))?.id ?? null;
}

/**
 * Whether a root entry name is a §5.2 lockfile of any ecosystem.
 * @param {string} name
 * @returns {boolean}
 */
export function isLockfile(name) {
  return ECOSYSTEMS.some((e) => matchName(name, e.lockfiles));
}

/**
 * Whether a repository path is a test path of any §5.2 ecosystem: a directory segment named as a
 * test directory (`test/`, `tests/`, `__tests__/`, `spec/`, `e2e/`, `testing/`, `unittest/`,
 * `*.Tests/`), or a file named as a test file (`*.test.ts`, `test_*.py`, `*_test.go`, …). A trailing
 * `/` marks the path itself as a directory. Paths under `node_modules/`, `vendor/` or `third_party/`
 * never count.
 * @param {string} path
 * @returns {boolean}
 */
export function isTestPath(path) {
  if (typeof path !== 'string' || !path) return false;
  const isDir = path.endsWith('/');
  const parts = path.replace(/^\.\//, '').split('/').filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((p) => FOREIGN_DIRS.has(p.toLowerCase()))) return false;
  const dirs = isDir ? parts : parts.slice(0, -1);
  for (const d of dirs) {
    if (ALL_TEST_DIRS.has(d.toLowerCase()) || ALL_TEST_DIR_PATTERNS.some((re) => re.test(d))) return true;
  }
  if (isDir) return false;
  const file = parts[parts.length - 1];
  return ALL_TEST_FILES.some((re) => re.test(file));
}

/**
 * Ecosystems of a repository (§5.2): those whose manifests are present at the root, plus the one
 * owning its primary language (`other` for a language no ecosystem lists). In table order.
 * @param {Pick<Facts, 'root' | 'primaryLanguage'>} facts
 * @returns {string[]}
 */
export function ecosystemsOf(facts) {
  const ids = new Set();
  for (const entry of facts?.root ?? []) {
    if (entry?.type === 'tree') continue;
    const id = manifestEcosystem(entry?.name ?? '');
    if (id) ids.add(id);
  }
  const lang = facts?.primaryLanguage;
  if (lang) ids.add(ECOSYSTEMS.find((e) => e.languages.includes(lang))?.id ?? 'other');
  return ECOSYSTEMS.map((e) => e.id).filter((id) => ids.has(id));
}

/**
 * Commands that run tests in a workflow `run:` line, for the given ecosystems; every ecosystem's
 * commands when `ids` is omitted.
 * @param {readonly string[]} [ids]
 * @returns {RegExp[]}
 */
export function testCommandRegexes(ids) {
  const list = ids == null ? ECOSYSTEMS
    : ids.map((id) => BY_ID.get(id)).filter((e) => e !== undefined);
  return list.flatMap((e) => /** @type {Ecosystem} */ (e).testCommands);
}

/**
 * Whether the given ecosystems expect a committed lockfile (§5.2). `optional` when every one of them
 * lists an absent lockfile as `na`, or when there is none.
 * @param {readonly string[]} ids
 * @returns {'expected' | 'optional'}
 */
export function lockfileExpectation(ids) {
  const list = (ids ?? []).map((id) => BY_ID.get(id)).filter((e) => e !== undefined);
  return list.some((e) => !(/** @type {Ecosystem} */ (e).lockfileOptional)) ? 'expected' : 'optional';
}

/**
 * Whether the repository has a zero-dependency manifest (§5.2): a root `package.json` whose four
 * dependency maps are all absent or empty, or a `go.mod` with no `require` (known only once the deep
 * stage has fetched it). `null` when such a manifest is present but its contents are not known;
 * `false` when none exists.
 * @param {Pick<Facts, 'root' | 'packageJson' | 'manifest'>} facts
 * @returns {boolean | null}
 */
export function zeroDependency(facts) {
  if (!Array.isArray(facts?.root)) return null;
  const names = new Set(facts.root.filter((e) => e?.type !== 'tree')
    .map((e) => String(e?.name).toLowerCase()));
  /** @type {(boolean | null)[]} */
  const answers = [];
  if (names.has('package.json')) {
    const pkg = /** @type {Record<string, unknown> | null} */ (facts.packageJson ?? null);
    if (!pkg) answers.push(null);
    else {
      const counts = ['deps', 'devDeps', 'peerDeps', 'optionalDeps'].map((k) => pkg[k]);
      if (counts.some((c) => typeof c === 'number' && c > 0)) answers.push(false);
      else if (typeof pkg.deps === 'number' && typeof pkg.devDeps === 'number') answers.push(true);
      else answers.push(null);
    }
  }
  if (names.has('go.mod')) {
    const m = facts.manifest;
    if (m && String(m.path).toLowerCase() === 'go.mod' && typeof m.text === 'string') {
      answers.push(!/^\s*require\b/m.test(m.text));
    } else answers.push(null);
  }
  if (answers.includes(true)) return true;
  if (answers.includes(null)) return null;
  return false;
}
