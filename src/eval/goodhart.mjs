// @ts-check
/**
 * The Goodhart check (DESIGN §7.7, §14.4): dress every non-genuine labelled repository with the
 * eight cheap artefacts an agent adds in minutes — a licence, a README of at least 1 KB, two code
 * blocks, CI, a manifest, a lockfile, one test, one release — and measure how much of the ranking
 * survives. The dressed AUC is a permanent metric: no weight change may lower it (§14.5).
 *
 * `dress` works on Facts, so everything the scorer reads sees the same repository a dresser would
 * produce. It touches only the inputs of the eight cheap signals: a README grown to 1 KB still
 * counts toward `s.prose` against its code, as it would on GitHub; no Markdown file, script or
 * path is added, so no other slop or proof signal can change.
 */

import { ecosystemsOf, isLockfile, isManifest, isTestPath } from '../core/ecosystems.mjs';
import { countFenceLines } from '../core/readme.mjs';
import { scoreFacts } from '../core/score.mjs';
import { aucBy } from './metrics.mjs';

/** @typedef {import('../core/schema.mjs').Facts} Facts */

/** The eight cheap signals dressing earns (§7.7). */
export const CHEAP_SIGNALS = Object.freeze([
  'q.licence', 'q.readme', 'q.usage', 'q.ci', 'q.manifest', 'q.deps', 'q.tests', 'q.release',
]);

/** Usage text with two fenced blocks; it cites no path or script, so `p.coherent` cannot move. */
const USAGE = '\n\n## Usage\n\n```sh\nmake\n```\n\nThen:\n\n```sh\nmake install\n```\n';

/** Filler prose that brings a README up to 1 KB. */
const FILLER = 'This project is maintained and open to contributions. ';

/** Lockfile per ecosystem, for a dressed repository that has none. */
const LOCKFILES = /** @type {Record<string, string>} */ ({
  node: 'package-lock.json', python: 'poetry.lock', rust: 'Cargo.lock', go: 'go.sum', ruby: 'Gemfile.lock',
  php: 'composer.lock', dart: 'pubspec.lock', beam: 'mix.lock', swift: 'Package.resolved',
  haskell: 'stack.yaml.lock', jvm: 'gradle.lockfile', dotnet: 'packages.lock.json',
});

/** Manifest per ecosystem, for a dressed repository that has none. */
const MANIFESTS = /** @type {Record<string, string>} */ ({
  node: 'package.json', python: 'pyproject.toml', rust: 'Cargo.toml', go: 'go.mod', ruby: 'Gemfile',
  php: 'composer.json', dart: 'pubspec.yaml', beam: 'mix.exs', swift: 'Package.swift', jvm: 'pom.xml',
  dotnet: 'app.csproj', haskell: 'stack.yaml', 'c-cpp': 'CMakeLists.txt',
});

/**
 * @param {string} s
 * @returns {number}
 */
function utf8Bytes(s) {
  return new TextEncoder().encode(s).length;
}

/**
 * The README a dresser leaves: two code blocks and at least 1,000 bytes.
 * @param {Facts['readme']} readme
 * @returns {NonNullable<Facts['readme']>}
 */
function dressReadme(readme) {
  const name = readme?.name ?? 'README.md';
  const text = typeof readme?.text === 'string' ? readme.text : '';
  const stored = /** @type {any} */ (readme)?.fenceLines;
  const fences = typeof stored === 'number' ? stored : countFenceLines(text);
  let added = fences >= 4 ? '' : USAGE;
  const before = Math.max(readme?.bytes ?? 0, utf8Bytes(text));
  while (before + utf8Bytes(added) < 1000) added += FILLER;
  const out = /** @type {any} */ ({
    ...(readme ?? {}), name, bytes: before + utf8Bytes(added), truncated: readme?.truncated === true,
    text: `${text}${added}`,
  });
  if (typeof stored === 'number' || fences < 4) out.fenceLines = fences + countFenceLines(added);
  return out;
}

/**
 * Add the eight cheap artefacts of §7.7 to Facts: a licence, a README of at least 1 KB with two
 * code blocks, a CI workflow, a manifest, a lockfile, a test directory and a release. Artefacts
 * already present are left alone. Returns a new object; the input is not modified.
 * @param {Facts} facts
 * @returns {Facts}
 */
export function dress(facts) {
  const f = /** @type {Facts} */ ({ ...facts });
  f.licence = facts.licence ?? 'MIT';
  f.readme = dressReadme(facts.readme);

  const root = [...(facts.root ?? [])];
  /** @param {string} name @param {'blob' | 'tree'} type */
  const add = (name, type) => {
    if (!root.some((e) => e.name.toLowerCase() === name.toLowerCase())) root.push({ name, type });
  };
  const workflows = [...(facts.workflows ?? [])];
  if (!workflows.some((w) => /\.ya?ml$/i.test(w.name))) {
    workflows.push({ name: 'ci.yml', text: null });
    add('.github', 'tree');
  }
  f.workflows = workflows;

  if (!root.some((e) => e.type !== 'tree' && isManifest(e.name))) {
    const eco = ecosystemsOf(f).find((e) => MANIFESTS[e]);
    add(eco ? MANIFESTS[eco] : 'package.json', 'blob');
  }
  f.root = root;
  if (!root.some((e) => e.type !== 'tree' && isLockfile(e.name))) {
    const eco = ecosystemsOf(f).find((e) => LOCKFILES[e]);
    add(eco ? LOCKFILES[eco] : 'package-lock.json', 'blob');
  }
  if (!root.some((e) => isTestPath(e.type === 'tree' ? `${e.name}/` : e.name))) add('tests', 'tree');
  f.root = root;

  const rel = facts.releases;
  f.releases = { count: Math.max(1, rel?.count ?? 0), recent: rel?.recent ?? [] };
  return f;
}

/**
 * @typedef {object} GoodhartConfig
 * @property {any} [weights]
 * @property {any} [calibration]
 * @property {any} [institutions]
 */

/**
 * The dressed AUC (§14.4): genuine rows as they are, every other row dressed, AUC of `S` pooled
 * (`all`) and on the uniform stratum.
 * @param {{facts: Facts, label: string, stratum: string, at?: string}[]} rows label rows
 * @param {GoodhartConfig} config
 * @param {{isPos?: (row: any) => boolean, uniform?: string}} [opts]
 * @returns {{all: number, uniform: number}}
 */
export function goodhartAuc(rows, config, opts = {}) {
  const isPos = opts.isPos ?? ((/** @type {any} */ r) => r.label === 'G');
  const uniformName = opts.uniform ?? 'uniform';
  const scored = rows.map((r) => {
    const facts = isPos(r) ? r.facts : dress(r.facts);
    const s = scoreFacts(facts, {
      weights: config.weights, calibration: config.calibration, institutions: config.institutions,
      now: r.at ?? facts.fetchedAt,
    });
    return { row: r, S: s.S };
  });
  const pos = (/** @type {{row: any}} */ x) => isPos(x.row);
  return {
    all: aucBy(scored, 'S', pos),
    uniform: aucBy(scored.filter((x) => x.row.stratum === uniformName), 'S', pos),
  };
}
