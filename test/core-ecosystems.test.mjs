// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ECOSYSTEMS, ecosystemsOf, isLockfile, isManifest, isTestPath, lockfileExpectation, manifestEcosystem,
  testCommandRegexes, zeroDependency,
} from '../src/core/ecosystems.mjs';

/**
 * @param {string[]} names
 * @returns {{name: string, type: string}[]}
 */
const blobs = (names) => names.map((name) => ({ name, type: 'blob' }));

test('the table holds the fourteen ecosystems of §5.2, in order', () => {
  assert.deepEqual(ECOSYSTEMS.map((e) => e.id), [
    'node', 'python', 'rust', 'go', 'jvm', 'dotnet', 'c-cpp', 'ruby', 'php', 'swift', 'dart', 'beam',
    'haskell', 'other',
  ]);
  assert.ok(Object.isFrozen(ECOSYSTEMS) && ECOSYSTEMS.every((e) => Object.isFrozen(e)));
});

test('manifests match case-insensitively, suffix patterns included', () => {
  for (const n of [
    'package.json', 'deno.jsonc', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'requirements.txt', 'Pipfile',
    'CMakeLists.txt', 'Makefile', 'GNUmakefile', 'App.csproj', 'Tool.fsproj', 'All.sln', 'foo.gemspec',
    'Gemfile',
    'pkg.cabal', 'stack.yaml', 'Package.swift', 'pubspec.yaml', 'mix.exs', 'composer.json', 'build.zig',
    'flake.nix', 'justfile', 'platformio.ini', 'build.gradle.kts', 'deps.edn',
  ]) assert.ok(isManifest(n), n);
  for (const n of ['README.md', '.csproj', 'index.js', 'Cargo.lock', 'package-lock.json', 'setup.sh']) {
    assert.ok(!isManifest(n), n);
  }
  assert.equal(manifestEcosystem('Cargo.toml'), 'rust');
  assert.equal(manifestEcosystem('App.csproj'), 'dotnet');
  assert.equal(manifestEcosystem('Makefile'), 'c-cpp');
  assert.equal(manifestEcosystem('justfile'), 'other');
  assert.equal(manifestEcosystem('notes.txt'), null);
});

test('lockfiles match case-insensitively', () => {
  for (const n of [
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'deno.lock', 'poetry.lock', 'uv.lock',
    'Pipfile.lock', 'Cargo.lock', 'go.sum', 'gradle.lockfile', 'packages.lock.json', 'Gemfile.lock',
    'composer.lock',
    'Package.resolved', 'pubspec.lock', 'mix.lock', 'stack.yaml.lock', 'flake.lock',
  ]) assert.ok(isLockfile(n), n);
  for (const n of ['package.json', 'lock.txt', 'Cargo.toml']) assert.ok(!isLockfile(n), n);
});

test('test paths: test directories anywhere, test files by name, foreign code excluded', () => {
  for (const p of [
    'tests/', 'test/', '__tests__/', 'spec/', 'e2e/', 'testing/', 'unittest/', 'Tests/', 'Foo.Tests/',
    'tests/test_cli.py', 'pkg/core/test/a.js', 'src/test/java/AppTest.java', 'src/foo.test.ts',
    'a/b.spec.mjs',
    'x.test.jsx', 'test_parse.py', 'parse_test.py', 'server_test.go', 'AppTest.java', 'AppTests.java',
    'MainTest.kt', 'CoreSpec.scala', 'util_test.cpp', 'test_util.c', 'model_spec.rb', 'model_test.rb',
    'UserTest.php', 'app_test.exs',
  ]) assert.ok(isTestPath(p), p);
  for (const p of [
    'src/', 'src/index.ts', 'latest.java', 'contest.py', 'testdata.json', 'attest/',
    'node_modules/x/test/a.js',
    'vendor/lib/tests/t.go', 'third_party/gtest/test/a.cc', 'README.md', '', 'protest.go',
  ]) assert.ok(!isTestPath(p), p);
});

test('ecosystemsOf: root manifests plus the primary language, in table order', () => {
  assert.deepEqual(ecosystemsOf({ root: blobs(['package.json', 'Cargo.toml']), primaryLanguage: 'Rust' }),
    ['node', 'rust']);
  assert.deepEqual(ecosystemsOf({ root: blobs(['README.md']), primaryLanguage: 'HTML' }), ['other']);
  assert.deepEqual(ecosystemsOf({ root: blobs(['Makefile']), primaryLanguage: 'Python' }),
    ['python', 'c-cpp']);
  assert.deepEqual(ecosystemsOf({ root: null, primaryLanguage: null }), []);
  const dirNamedLikeManifest = [{ name: 'package.json', type: 'tree' }];
  assert.deepEqual(ecosystemsOf({ root: dirNamedLikeManifest, primaryLanguage: null }), []);
});

test('lockfile expectation: optional only when every ecosystem lists an absent lockfile as na', () => {
  assert.equal(lockfileExpectation(['rust']), 'optional');
  assert.equal(lockfileExpectation(['c-cpp', 'other']), 'optional');
  assert.equal(lockfileExpectation(['jvm', 'dotnet']), 'optional');
  assert.equal(lockfileExpectation([]), 'optional');
  assert.equal(lockfileExpectation(['node', 'rust']), 'expected');
  assert.equal(lockfileExpectation(['python']), 'expected');
});

test('test commands of §5.2 match workflow run lines; other commands do not', () => {
  const all = testCommandRegexes();
  const runs = (/** @type {string} */ line) => all.some((re) => re.test(line));
  for (const line of [
    'npm test', 'pnpm run test', 'yarn test:unit', 'bun test', 'npx vitest run', 'npx playwright test',
    'node --test', 'deno test -A', 'jest --ci', 'pytest -q', 'python -m unittest discover',
    'python3 -m pytest', 'tox -e py312', 'hatch run test', 'uv run pytest', 'cargo test --all',
    'cargo nextest run', 'go test ./...',
    'gotestsum', 'mvn -B verify', './gradlew check', 'gradle build', 'sbt +test', 'lein test', 'dotnet test',
    'ctest --output-on-failure', 'make check', 'meson test -C build', 'ninja test', 'bundle exec rspec',
    'rake test', 'vendor/bin/phpunit', 'composer test', 'swift test', 'xcodebuild -scheme App test',
    'flutter test', 'dart test', 'mix test', 'rebar3 eunit', 'cabal test', 'stack test', 'zig build test',
    'just test', 'make test', 'nix flake check', 'gleam test', 'dune test',
  ]) assert.ok(runs(line), line);
  for (const line of [
    'echo ok', 'npm ci', 'npm run build', 'go build ./...', 'cargo build --release', 'make', 'protox',
    'docker build .', 'pip install -r requirements.txt',
  ]) assert.ok(!runs(line), line);
  const go = testCommandRegexes(['go']);
  assert.ok(go.some((re) => re.test('go test -race ./...')));
  assert.ok(!go.some((re) => re.test('npm test')));
  assert.deepEqual(testCommandRegexes(['nope']), []);
});

test('zeroDependency: a package.json with four empty maps, or a go.mod without require', () => {
  const pkgRoot = blobs(['package.json']);
  const zero = { deps: 0, devDeps: 0, peerDeps: 0, optionalDeps: 0 };
  assert.equal(zeroDependency({ root: pkgRoot, packageJson: zero, manifest: null }), true);
  assert.equal(zeroDependency({ root: pkgRoot, packageJson: { ...zero, deps: 2 }, manifest: null }), false);
  const peer = { ...zero, peerDeps: 1 };
  assert.equal(zeroDependency({ root: pkgRoot, packageJson: peer, manifest: null }), false);
  assert.equal(zeroDependency({ root: pkgRoot, packageJson: null, manifest: null }), null);
  const goRoot = blobs(['go.mod']);
  const bare = { path: 'go.mod', text: 'module example.com/x\n\ngo 1.22\n' };
  const withReq = {
    path: 'go.mod', text: 'module example.com/x\n\nrequire (\n\tgolang.org/x/text v0.1.0\n)\n',
  };
  assert.equal(zeroDependency({ root: goRoot, packageJson: null, manifest: bare }), true);
  assert.equal(zeroDependency({ root: goRoot, packageJson: null, manifest: withReq }), false);
  assert.equal(zeroDependency({ root: goRoot, packageJson: null, manifest: null }), null);
  assert.equal(zeroDependency({ root: blobs(['Cargo.toml']), packageJson: null, manifest: null }), false);
  assert.equal(zeroDependency({ root: null, packageJson: null, manifest: null }), null);
});
