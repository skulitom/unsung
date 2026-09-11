// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testCommandRegexes } from '../src/core/ecosystems.mjs';
import { findTestStep, isNpmDefaultTest, isTrivialTestScript, runSteps } from '../src/core/workflows.mjs';

const TESTS = testCommandRegexes();

const CI = `name: CI
on:
  push:
    branches: [main]   # comment
env:
  run: not-a-step
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: "Install"
        run: npm ci
      - name: Lint
        run: |
          npm run lint
          # npm test is only a comment here
      - name: Test
        run: >
          npm test
          -- --coverage
      - run: 'go test ./... # quoted hash'
        working-directory: server
  flaky:
    continue-on-error: true
    steps:
    - run: pytest -q
    - name: Allowed to fail
      continue-on-error: true
      run: cargo test
`;

test('runSteps finds run commands: inline, quoted, literal and folded blocks, compact lists', () => {
  const steps = runSteps(CI);
  assert.deepEqual(steps.map((s) => [s.job, s.name, s.run, s.continueOnError, s.workingDirectory]), [
    ['build', 'Install', 'npm ci', false, null],
    ['build', 'Lint', 'npm run lint\n# npm test is only a comment here', false, null],
    ['build', 'Test', 'npm test -- --coverage', false, null],
    ['build', null, 'go test ./... # quoted hash', false, 'server'],
    ['flaky', null, 'pytest -q', true, null],
    ['flaky', 'Allowed to fail', 'cargo test', true, null],
  ]);
});

test('runSteps tolerates empty, odd and CRLF input', () => {
  assert.deepEqual(runSteps(''), []);
  assert.deepEqual(runSteps(null), []);
  assert.deepEqual(runSteps('just: text\nno jobs here\n'), []);
  const crlf = 'jobs:\r\n  t:\r\n    steps:\r\n      - run: make test\r\n';
  assert.deepEqual(runSteps(crlf).map((s) => s.run), ['make test']);
  const multi = 'jobs:\n  t:\n    steps:\n      - run: npm ci &&\n          npm test\n';
  assert.deepEqual(runSteps(multi).map((s) => s.run), ['npm ci && npm test']);
});

test('findTestStep returns the first step that runs tests; comments and echo do not count', () => {
  const found = findTestStep(runSteps(CI), TESTS);
  assert.ok(found);
  assert.equal(found.command, 'npm test -- --coverage');
  assert.equal(found.neutralised, false);
  assert.equal(findTestStep(runSteps('jobs:\n  a:\n    steps:\n      - run: echo ok\n'), TESTS), null);
  const echoed = runSteps('jobs:\n  a:\n    steps:\n      - run: echo "npm test"\n');
  assert.equal(findTestStep(echoed, TESTS), null);
  const comment = { job: 'a', name: null, run: '# pytest', continueOnError: false, workingDirectory: null };
  assert.equal(findTestStep([comment], TESTS), null);
});

test('neutralised test steps: || true, || exit 0, ; true, continue-on-error', () => {
  /** @param {string} run @param {boolean} [coe] */
  const step = (run, coe = false) => [
    { job: 'a', name: null, run, continueOnError: coe, workingDirectory: null },
  ];
  const neutral = [
    'npm test || true', 'pytest || exit 0', 'go test ./...; true', 'npm test && npm run e2e || true',
  ];
  for (const run of neutral) {
    const r = findTestStep(step(run), TESTS);
    assert.ok(r && r.neutralised, run);
  }
  assert.ok(findTestStep(step('cargo test', true), TESTS)?.neutralised);
  assert.equal(findTestStep(step('npm test; npm run lint || true'), TESTS)?.neutralised, false);
  const mixed = [...step('npm test || true'), ...step('pytest -q')];
  assert.deepEqual(findTestStep(mixed, TESTS)?.command, 'pytest -q');
  assert.equal(findTestStep(mixed, TESTS)?.neutralised, false);
});

test('npm test with npm’s placeholder or a trivial test script is not a test command', () => {
  const steps = runSteps('jobs:\n  a:\n    steps:\n      - run: npm test\n');
  const placeholder = 'echo "Error: no test specified" && exit 1';
  assert.equal(findTestStep(steps, TESTS, { testScript: placeholder }), null);
  assert.equal(findTestStep(steps, TESTS, { testScript: 'echo ok' }), null);
  assert.ok(findTestStep(steps, TESTS, { testScript: 'node --test' }));
  assert.ok(findTestStep(steps, TESTS, { testScript: null }));
  const elsewhere = [{ ...steps[0], workingDirectory: 'web' }];
  const other = findTestStep(elsewhere, TESTS, { testScript: placeholder });
  assert.ok(other, 'another package.json may hold tests');
});

test('isNpmDefaultTest and isTrivialTestScript', () => {
  assert.ok(isNpmDefaultTest('echo "Error: no test specified" && exit 1'));
  assert.ok(isNpmDefaultTest('echo \\"Error: no test specified\\" && exit 1'));
  assert.ok(isNpmDefaultTest("echo 'Error: no test specified'  &&  exit 1"));
  assert.ok(!isNpmDefaultTest('node --test'));
  assert.ok(!isNpmDefaultTest(null));
  assert.ok(isTrivialTestScript('echo ok'));
  assert.ok(isTrivialTestScript('echo a && exit 0'));
  assert.ok(isTrivialTestScript('true'));
  assert.ok(!isTrivialTestScript('vitest run'));
  assert.ok(!isTrivialTestScript(undefined));
});
