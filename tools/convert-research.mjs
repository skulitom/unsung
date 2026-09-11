// @ts-check
/**
 * Converts the research haystack into fixtures (DESIGN §14.2 "Research conversion"). Usage:
 *
 *   node tools/convert-research.mjs <research/raw/haystack> [--out test/fixtures]
 *
 * Writes `repos/<owner>__<name>/{meta,enrich}.json` for the 147 deep snapshots, `meta.json` alone
 * for the two spam repositories that answered 502 in research, and `labelled/labels.json` for all
 * 149 labels. The snapshot is mapped onto the §3.5 ENRICH shape: `r1`…`r6` become `readme` (with
 * its `name`), `pkg`, `wf` and `root` keep their names, histories are trimmed to 20 nodes, and
 * `statusCheckRollup`, release dates, `oid` and owner contribution years stay absent, so the
 * signals that need them are `unknown`. README text goes through the 8 KB excerpt of
 * `tools/lib/fixture-io.mjs`. Commit bodies and author names and e-mail addresses are dropped.
 *
 * A fixture directory that the recorder has already filled (`meta.source` "recorded") keeps its
 * recorded `enrich.json`; the research snapshot is written beside it as `enrich.research.json`
 * and `meta.labelledSnapshot` points at it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  FIXTURES, TEXT_CAP, fixtureDirName, readJsonIf, readmeExcerpt, truncateUtf8, writeJson,
} from './lib/fixture-io.mjs';
import { expectFor, setOf } from './lib/named-sets.mjs';

/** README aliases of the research fragment, in lookup order, with the file name each fetched. */
const README_ALIASES = [
  ['r1', 'README.md'], ['r2', 'readme.md'], ['r3', 'Readme.md'],
  ['r4', 'README.rst'], ['r5', 'README'], ['r6', 'README.MD'],
];

/** The two spam repositories whose research fetch answered 502 (§14.2). */
const MISSING_NOTE = 'The research deep fetch answered HTTP 502 for this repository; no snapshot exists.';

/**
 * @typedef {{cat: string, flags?: string[], note?: string}} ResearchLabel
 * @typedef {{name: string, byteSize: number, text: string}} ReadmeBlob
 */

/**
 * Pick the README the research run found, first alias first.
 * @param {any} g research snapshot
 * @returns {ReadmeBlob | null}
 */
function pickReadme(g) {
  for (const [alias, name] of README_ALIASES) {
    const blob = g[alias];
    if (blob && typeof blob === 'object' && typeof blob.text === 'string') {
      return { name, byteSize: blob.byteSize, text: blob.text };
    }
  }
  return null;
}

/**
 * Map a research snapshot onto the §3.5 ENRICH shape (fields the source lacked are absent).
 * @param {any} g research snapshot (`deep/<owner>__<name>.gql.json`)
 * @param {{id?: string | null}} [opts]
 * @returns {{node: Record<string, unknown>,
 *   readme: import('./lib/fixture-io.mjs').Excerpt & {name: string} | null}}
 */
export function convertSnapshot(g, opts = {}) {
  /** @type {Record<string, unknown>} */
  const node = {};
  if (opts.id) node.id = opts.id;
  for (const k of ['nameWithOwner', 'description', 'homepageUrl', 'createdAt', 'pushedAt', 'diskUsage',
    'stargazerCount', 'forkCount', 'isFork', 'isArchived', 'isTemplate', 'isMirror', 'hasIssuesEnabled']) {
    if (k in g) node[k] = g[k];
  }
  node.licenseInfo = g.licenseInfo ? { spdxId: g.licenseInfo.spdxId ?? null } : null;
  node.primaryLanguage = g.primaryLanguage ? { name: g.primaryLanguage.name } : null;
  if (g.languages) {
    node.languages = {
      totalSize: g.languages.totalSize ?? 0,
      edges: (g.languages.edges ?? []).slice(0, 8)
        .map((/** @type {any} */ e) => ({ size: e.size, node: { name: e.node?.name } })),
    };
  }
  if (g.repositoryTopics) {
    node.repositoryTopics = {
      nodes: (g.repositoryTopics.nodes ?? []).slice(0, 12)
        .map((/** @type {any} */ n) => ({ topic: { name: n.topic?.name } })),
    };
  }
  if (g.releases) node.releases = { totalCount: g.releases.totalCount ?? 0 };
  if (g.tags) node.tags = { totalCount: g.tags.totalCount ?? 0 };
  if (g.watchers) node.watchers = { totalCount: g.watchers.totalCount ?? 0 };
  if (g.owner) {
    /** @type {Record<string, unknown>} */
    const owner = { login: g.owner.login, __typename: g.owner.__typename };
    if ('createdAt' in g.owner) owner.createdAt = g.owner.createdAt;
    if (g.owner.repositories) owner.repositories = { totalCount: g.owner.repositories.totalCount };
    node.owner = owner;
  }
  if ('defaultBranchRef' in g) {
    const ref = g.defaultBranchRef;
    const hist = ref?.target?.history;
    node.defaultBranchRef = ref ? {
      name: ref.name,
      target: hist ? {
        history: {
          totalCount: hist.totalCount ?? 0,
          nodes: (hist.nodes ?? []).slice(0, 20).map((/** @type {any} */ n) => ({
            committedDate: n.committedDate,
            messageHeadline: n.messageHeadline,
            author: { user: n.author?.user ? { login: n.author.user.login } : null },
          })),
        },
      } : null,
    } : null;
  }
  if ('root' in g) {
    node.root = g.root
      ? { entries: (g.root.entries ?? []).map((/** @type {any} */ e) => ({ name: e.name, type: e.type })) }
      : null;
  }
  if ('wf' in g) {
    const entries = g.wf ? (g.wf.entries ?? []).map((/** @type {any} */ e) => ({ name: e.name })) : null;
    node.wf = entries ? { entries } : null;
  }
  const found = pickReadme(g);
  /** @type {(import('./lib/fixture-io.mjs').Excerpt & {name: string}) | null} */
  let readme = null;
  if (found) {
    const ex = readmeExcerpt(found.text);
    node.readme = { name: found.name, byteSize: found.byteSize, text: ex.text };
    readme = { name: found.name, ...ex };
  } else {
    node.readme = null;
  }
  if ('pkg' in g) {
    node.pkg = g.pkg ? {
      byteSize: g.pkg.byteSize,
      text: g.pkg.text == null ? null : truncateUtf8(g.pkg.text, TEXT_CAP).text,
    } : null;
  }
  if ('agents' in g) node.agents = g.agents ? { byteSize: g.agents.byteSize } : null;
  if ('claude' in g) node.claude = g.claude ? { byteSize: g.claude.byteSize } : null;
  return { node, readme };
}

/**
 * `meta.readme` summary for a README excerpt.
 * @param {(import('./lib/fixture-io.mjs').Excerpt & {name: string}) | null} r
 */
export function readmeMeta(r) {
  if (!r) return null;
  return { name: r.name, originalBytes: r.originalBytes, keptBytes: r.keptBytes, excerpt: r.excerpt };
}

/**
 * Map each research repository (lower-cased) to its sample, stratum and search-item node id.
 * @param {string} dir
 * @returns {Map<string, {sample: string, stratum: 'search' | 'uniform', id: string | null}>}
 */
function readSamples(dir) {
  const out = new Map();
  for (const file of ['picked.json', 'picked_uniform.json', 'picked_uniform2.json']) {
    for (const p of JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))) {
      out.set(p.full_name.toLowerCase(), {
        sample: p.sample,
        stratum: p.sample.startsWith('U_') ? 'uniform' : 'search',
        id: p.search_item?.node_id ?? null,
      });
    }
  }
  return out;
}

/**
 * Convert the whole research set.
 * @param {{dir: string, out: string, log?: (msg: string) => void}} opts
 */
export function convertResearch({ dir, out, log = () => {} }) {
  /** @type {Record<string, ResearchLabel>} */
  const labels = JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf8'));
  const samples = readSamples(dir);
  const deepDir = path.join(dir, 'deep');
  const snapshots = new Map(fs.readdirSync(deepDir).filter((f) => f.endsWith('.gql.json'))
    .map((f) => [f.slice(0, -'.gql.json'.length).toLowerCase(), path.join(deepDir, f)]));

  /** @type {Record<string, {cat: string, flags: string[], note: string, stratum: string}>} */
  const labelsOut = {};
  const counts = { snapshots: 0, metaOnly: 0, besideRecorded: 0, excerpts: 0 };
  const keys = Object.keys(labels).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const nwo of keys) {
    const lab = labels[nwo];
    const sample = samples.get(nwo.toLowerCase());
    if (!sample) throw new Error(`No sample recorded for labelled repository ${nwo}`);
    labelsOut[nwo] = { cat: lab.cat, flags: lab.flags ?? [], note: lab.note ?? '', stratum: sample.stratum };

    const fixDir = path.join(out, 'repos', fixtureDirName(nwo));
    const prior = readJsonIf(path.join(fixDir, 'meta.json'), null);
    const snapFile = snapshots.get(fixtureDirName(nwo).toLowerCase());
    const set = setOf(nwo);
    const expect = expectFor(nwo);

    if (!snapFile) {
      writeJson(path.join(fixDir, 'meta.json'), {
        source: 'research', recordedAt: null, nwo,
        label: lab.cat, stratum: sample.stratum, sample: sample.sample,
        ...(set ? { set, expect } : {}), missing: MISSING_NOTE,
      });
      counts.metaOnly++;
      continue;
    }

    const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    const { node, readme } = convertSnapshot(snap, { id: sample.id });
    const mtime = Math.floor(fs.statSync(snapFile).mtimeMs / 1000) * 1000;
    const recordedAt = new Date(mtime).toISOString().replace('.000Z', 'Z');
    counts.snapshots++;
    if (readme?.excerpt) counts.excerpts++;

    if (prior?.source === 'recorded') {
      writeJson(path.join(fixDir, 'enrich.research.json'), node);
      writeJson(path.join(fixDir, 'meta.json'), {
        ...prior, label: lab.cat, stratum: sample.stratum, sample: sample.sample,
        labelledSnapshot: 'enrich.research.json', researchRecordedAt: recordedAt,
        researchReadme: readmeMeta(readme),
      });
      counts.besideRecorded++;
      continue;
    }
    writeJson(path.join(fixDir, 'enrich.json'), node);
    writeJson(path.join(fixDir, 'meta.json'), {
      source: 'research', recordedAt, nwo, label: lab.cat, stratum: sample.stratum, sample: sample.sample,
      ...(set ? { set, expect } : {}),
      readme: readmeMeta(readme),
      ...(prior?.recording ? { recording: prior.recording } : {}),
    });
    log(`converted ${nwo}`);
  }
  writeJson(path.join(out, 'labelled', 'labels.json'), labelsOut);
  return { labels: keys.length, ...counts };
}

/**
 * CLI entry point.
 * @param {string[]} argv
 * @returns {number}
 */
export function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { out: { type: 'string', default: FIXTURES }, verbose: { type: 'boolean', default: false } },
  });
  if (positionals.length !== 1) {
    process.stderr.write(
      'Usage: node tools/convert-research.mjs <research/raw/haystack> [--out test/fixtures]\n',
    );
    return 2;
  }
  const summary = convertResearch({
    dir: path.resolve(positionals[0]), out: path.resolve(values.out),
    log: values.verbose ? (m) => process.stdout.write(`${m}\n`) : undefined,
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`convert-research: ${/** @type {Error} */ (err).message}\n`);
    process.exitCode = 1;
  }
}
