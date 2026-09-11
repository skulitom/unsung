// @ts-check
/**
 * Builds `test/fixtures/index.sample.json`, an Index (DESIGN §4.3) of about 40 entries for UI
 * work, by running the real scorer and indexer over the repository fixtures. Usage:
 *
 *   node tools/make-index-sample.mjs [--out <file>] [--now 2026-09-11T16:00:00Z] [--config <dir>]
 *                                    [--check] [--report]
 *
 * Every repository fixture with an enrich snapshot becomes Facts (`src/eval/labels.mjs#fixtureFacts`:
 * the enrich node with any recorded deep responses merged), a Candidate, and a RepoRecord scored by
 * `src/pipeline/indexer.mjs#applyScore` (that is, `src/core/score.mjs#scoreFacts`) with the
 * configuration in `config/`. `buildIndex` over a memory store turns the records into entries, and
 * the sample keeps a quota per lane — seed gems first, then recorded fixtures, then by rank — so
 * that every lane appears. A lane no fixture reaches is named in the output rather than filled with
 * invented data.
 *
 * Two inputs are illustrative rather than computed:
 * - three verdicts: `HaveNiceDa/My-Notion` (C) and `AKzar1el/god-prompt` (S) carry their research
 *   label as a confident, supported verdict (−2 and Doubted by §8.5), and `codefly-dev/cli` a
 *   genuine one (+1) so the UI has a pitch to show. Their claims quote the README verbatim, they
 *   carry `illustrative: true`, and no model was run;
 * - `lastRun` describes how the fixtures were recorded, as a RunSummary.
 *
 * `--check` prints the §5.3 firing counts and the AUCs of the real signals on the research
 * snapshots (`unsung eval --labels fixtures` prints the whole report); `--report` scores every
 * named-set fixture against its `meta.expect` with the real scorer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config.mjs';
import { validateIndex, validateRepoRecord } from '../src/core/schema.mjs';
import { mulberry32 } from '../src/core/util.mjs';
import { verdictEffect } from '../src/core/verdict.mjs';
import { evaluate, namedReport } from '../src/eval/evaluate.mjs';
import { fixtureLoader } from '../src/eval/fixtures.mjs';
import { fixtureFacts, labelledFromFixtures, namedFromFixtures } from '../src/eval/labels.mjs';
import { candidateFromFacts } from '../src/pipeline/candidates.mjs';
import { applyScore, buildIndex } from '../src/pipeline/indexer.mjs';
import { createMemoryStore } from '../src/store/memory.mjs';
import { FIXTURES, ROOT, byteLength, readJsonIf, writeJson } from './lib/fixture-io.mjs';

/** @typedef {import('../src/core/schema.mjs').Facts} Facts */
/** @typedef {import('../src/core/schema.mjs').IndexEntry} IndexEntry */
/** @typedef {import('../src/core/schema.mjs').Verdict} Verdict */

/** The lanes the sample shows, in shelf order (§10.2). */
const LANES = [
  'promising', 'proven', 'look', 'doubted', 'institutional', 'rising', 'graduated', 'quarantine',
];

/** How many entries each lane keeps at most. */
/** @type {Record<string, number>} */
const QUOTAS = {
  promising: 14, proven: 6, look: 8, doubted: 4, institutional: 5, rising: 2, graduated: 2, quarantine: 3,
};

/** Repositories given an illustrative verdict, by lower-cased nwo → category. */
/** @type {Record<string, string>} */
const ILLUSTRATIVE = Object.fromEntries([['HaveNiceDa/My-Notion', 'C'], ['AKzar1el/god-prompt', 'S'],
  ['codefly-dev/cli', 'G']].map(([nwo, category]) => [nwo.toLowerCase(), category]));

/** Claim texts of the illustrative verdicts, per category. */
/** @type {Record<string, [string, string]>} */
const CLAIM_TEXT = {
  G: ['States a clear job for a clear audience', 'Documents how the tool is built and used'],
  C: ['Follows a tutorial stack rather than a design of its own', 'Lightly adapts a well-known application'],
  S: ['Prompt text far outweighs working code', 'A persona pack rather than a tool'],
};

const SUMMARY = 'Illustrative verdict for UI work: the category is the research label; no model was run.';

/**
 * Up to `n` README passages a claim can quote verbatim: prose lines outside code blocks (a list or
 * quote marker is left out of the passage), at least 20 characters, without a link, an image or
 * inline code, not ending in a colon, cut to 120 characters.
 * @param {string | null | undefined} text
 * @param {number} n
 * @returns {string[]}
 */
function readmeQuotes(text, n) {
  /** @type {string[]} */
  const out = [];
  let fence = false;
  for (const raw of String(text ?? '').split('\n')) {
    const trimmed = raw.trim();
    if (/^(```|~~~)/.test(trimmed)) {
      fence = !fence;
      continue;
    }
    const line = trimmed.replace(/^([-*>]|\d+\.)\s+/, '');
    if (fence || [...line].length < 20 || /^[#|<![]/.test(line) || /https?:|`|[:：]$/.test(line)) continue;
    out.push([...line].slice(0, 120).join(''));
    if (out.length >= n) break;
  }
  return out;
}

/**
 * The first sentence of the description, else the first README quote, at most 140 characters.
 * @param {Facts} facts
 * @returns {string}
 */
function pitchOf(facts) {
  const d = typeof facts.description === 'string' ? facts.description.trim() : '';
  const first = d ? d.split(/(?<=[.!?])\s/)[0] : (readmeQuotes(facts.readme?.text, 1)[0] ?? facts.nwo);
  return [...first].slice(0, 140).join('');
}

/**
 * An illustrative verdict (§4.3) for UI work: its category is the research label, its claims quote
 * the README verbatim, its effect follows §8.5. `illustrative: true` says that no model was run.
 * @param {Facts} facts
 * @param {string} category
 * @param {{now: string, weights: any}} opts
 * @returns {Verdict}
 */
function illustrativeVerdict(facts, category, { now, weights }) {
  const genuine = category === 'G';
  const supports = genuine ? ['purpose', 'craft'] : ['category', 'originality'];
  const claims = readmeQuotes(facts.readme?.text, 2).map((quote, i) => ({
    text: CLAIM_TEXT[category][i], path: facts.readme?.name ?? 'README.md', quote, supports: supports[i],
  }));
  const output = {
    category,
    categoryConfidence: genuine ? 0.8 : 0.85,
    scores: genuine ? { purpose: 4, craft: 3, verification: 3, honesty: 4, originality: 3 }
      : { purpose: 2, craft: 2, verification: 1, honesty: 2, originality: 1 },
    claims,
    flags: [],
    pitch: genuine ? pitchOf(facts) : '',
    audience: '',
    summary: SUMMARY,
    injectionSeen: false,
  };
  /** @type {any} */
  const v = {
    v: 1, id: facts.id, nwo: facts.nwo, headOid: facts.headOid ?? null, rubric: 'r1', backend: 'claude-cli',
    model: 'claude-opus-5', at: now, status: 'ok', output,
    validation: { claimsKept: claims.length, claimsDropped: 0, problems: [] },
    effect: { points: 0, lane: null, reason: '' }, costUsd: 0, usage: null, packBytes: 0, durationMs: 0,
    illustrative: true,
  };
  v.effect = verdictEffect(v, { weights });
  return v;
}

/**
 * Index order within a lane (§6.7): `gem` descending, then stars ascending, then newest first.
 * @param {Partial<IndexEntry>} a
 * @param {Partial<IndexEntry>} b
 * @returns {number}
 */
function entryOrder(a, b) {
  const ga = a.gem ?? -Infinity;
  const gb = b.gem ?? -Infinity;
  if (ga !== gb) return gb - ga;
  if ((a.stars ?? 0) !== (b.stars ?? 0)) return (a.stars ?? 0) - (b.stars ?? 0);
  const ca = a.createdAt ?? '';
  const cb = b.createdAt ?? '';
  if (ca !== cb) return ca < cb ? 1 : -1;
  return String(a.nwo) < String(b.nwo) ? -1 : String(a.nwo) > String(b.nwo) ? 1 : 0;
}

/**
 * An illustrative RunSummary (§4.3) describing how the fixtures were gathered.
 * @param {string} fixtures
 * @param {string} now
 * @param {Record<string, number>} lanes lane counts of every scored fixture
 */
function lastRunSummary(fixtures, now, lanes) {
  const windows = fs.readdirSync(path.join(fixtures, 'search'))
    .map((f) => readJsonIf(path.join(fixtures, 'search', f), null)).filter(Boolean);
  const pages = windows.reduce((a, s) => a + s.pages.length, 0);
  /** @param {any} p */
  const nodesOf = (p) => p.body?.data?.search?.nodes?.length ?? 0;
  const seeds = windows.reduce((a, s) => a + s.pages
    .reduce((/** @type {number} */ b, /** @type {any} */ p) => b + nodesOf(p), 0), 0);
  const start = new Date(Date.parse(now) - 10 * 60_000).toISOString().replace('.000Z', 'Z');
  const gem = (lanes.promising ?? 0) + (lanes.proven ?? 0);
  return {
    v: 1, runId: `${start.replace(/[-:]/g, '')}-fx01`, startedAt: start, endedAt: now,
    argv: ['run', '--budget', '10m'], profile: 'quick', budget: { wallMs: 600000, graphqlMs: 450000 },
    stages: {
      census: {
        days: ['2026-09-08'], units: windows.length, pages, seeds,
        saturated: windows.filter((s) => s.saturated).length,
      },
      archive: { hours: ['2026-09-10-15'], events: 270, lookups: 1, seeds: 99 },
      prefilter: { in: seeds + 99, queued: 0, deferred: 0, quarantined: 0, dropped: {} },
      enrich: { repos: 30, calls: 3, halvings: 0, heavy: 0, gone: 0, explore: 0 },
      deep: { repos: 30, graphqlCalls: 12, restCalls: 85 },
      score: {
        gem, look: lanes.look ?? 0, low: lanes.low ?? 0,
        lanes: { promising: lanes.promising ?? 0, proven: lanes.proven ?? 0 },
      },
      recheck: { checked: 0, gone: 0, requeued: 0 },
    },
    rate: {
      graphql: { points: 30, serverMs: 0, remaining: 0 }, rest: { calls: 85, notModified: 1, remaining: 0 },
      pauses: [],
    },
    exit: { code: 0, reason: 'finished', resumeAt: null },
  };
}

/**
 * Score every fixture with the real pipeline and build the sample index.
 * @param {{fixtures: string, now: string, configDir: string}} opts
 * @returns {Promise<{index: any, pooled: Record<string, number>, notes: string[]}>}
 */
export async function buildSampleIndex({ fixtures, now, configDir }) {
  const config = loadConfig(configDir);
  const loader = fixtureLoader(fixtures);
  const store = createMemoryStore({ now: () => now });
  /** @type {Map<string, {seed: boolean, recorded: boolean}>} */
  const origin = new Map();
  /** @type {Record<string, number>} */
  const pooled = {};
  /** @type {string[]} */
  const problems = [];
  for (const nwo of loader.listRepoFixtures(() => true)) {
    const fx = loader.loadRepoFixture(nwo);
    if (!fx.enrich) continue;
    const { facts } = fixtureFacts(fx);
    const category = ILLUSTRATIVE[facts.nwo.toLowerCase()];
    const verdict = category ? illustrativeVerdict(facts, category, { now, weights: config.weights }) : null;
    const candidate = candidateFromFacts(facts, { source: 'add', now, prior: 0 });
    /** @type {any} */
    const bare = {
      v: 1, id: facts.id, nwo: facts.nwo, candidate, facts, score: null, firstSeen: null, history: [],
      verdict, checkedAt: facts.fetchedAt, gone: false,
    };
    const record = applyScore(bare, config, { now, verdict });
    const errors = validateRepoRecord(record);
    if (errors.length) problems.push(`${facts.nwo}: ${errors.slice(0, 3).join('; ')}`);
    const dropped = (record.score?.gates ?? []).some((g) => g.action === 'drop');
    const lane = dropped ? 'dropped' : String(record.score?.lane);
    pooled[lane] = (pooled[lane] ?? 0) + 1;
    await store.putCandidates([record.candidate]);
    await store.putRepo(record);
    origin.set(record.id, { seed: fx.meta?.set === 'seedGems', recorded: fx.meta?.source === 'recorded' });
  }
  if (problems.length) throw new Error(`Invalid records:\n  ${problems.join('\n  ')}`);

  const full = await buildIndex({ store, config, now, lastRun: lastRunSummary(fixtures, now, pooled) });
  /** @param {IndexEntry} e */
  const priority = (e) => {
    const o = origin.get(e.id);
    return (o?.seed ? 0 : 2) + (o?.recorded ? 0 : 1);
  };
  /** @type {IndexEntry[]} */
  const entries = [];
  /** @type {string[]} */
  const notes = [];
  for (const lane of LANES) {
    const pool = full.entries.filter((e) => e.lane === lane)
      .sort((a, b) => (priority(a) - priority(b)) || entryOrder(a, b));
    const take = pool.slice(0, QUOTAS[lane]);
    if (!take.length) notes.push(`no fixture reached lane ${lane}`);
    entries.push(...take);
  }
  entries.sort((a, b) => (LANES.indexOf(a.lane) - LANES.indexOf(b.lane)) || entryOrder(a, b));
  const counts = Object.fromEntries(LANES.map((l) => [l, entries.filter((e) => e.lane === l).length]));
  const index = { ...full, generatedAt: now, counts, entries };
  const invalid = validateIndex(index);
  if (invalid.length) throw new Error(`The sample index is invalid: ${invalid.slice(0, 5).join('; ')}`);
  return { index, pooled, notes };
}

/**
 * Firing counts and AUCs of the real signals on the research snapshots (§5.3, §14.4).
 * @param {string} fixtures
 * @param {string} configDir
 */
export function checkResearch(fixtures, configDir) {
  const config = loadConfig(configDir);
  const rows = labelledFromFixtures(fixtureLoader(fixtures));
  const report = evaluate(rows, config, { rand: mulberry32(7), bootstrap: 200 });
  const round = (/** @type {number} */ x) => Math.round(x * 1000) / 1000;
  const firing = Object.fromEntries(report.signals.map((s) => [s.id, `${s.G} / ${s.rest}`]));
  const u = report.gemPrecision.uniform;
  return {
    n: report.counts.labels, aucPooled: round(report.auc.pooled), aucUniform: round(report.auc.uniform),
    firing, uniformGemPrecision: `${u.genuine} of ${u.n}`,
  };
}

/**
 * Every named-set fixture scored by the real scorer against its `meta.expect` (§14.2).
 * @param {string} fixtures
 * @param {string} configDir
 */
export function reportNamedSets(fixtures, configDir) {
  return namedReport(namedFromFixtures(fixtureLoader(fixtures)), loadConfig(configDir));
}

/**
 * CLI entry point.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      out: { type: 'string', default: path.join(FIXTURES, 'index.sample.json') },
      fixtures: { type: 'string', default: FIXTURES },
      config: { type: 'string', default: path.join(ROOT, 'config') },
      now: { type: 'string', default: '2026-09-11T16:00:00Z' },
      check: { type: 'boolean', default: false },
      report: { type: 'boolean', default: false },
    },
  });
  if (values.report) {
    const rep = reportNamedSets(values.fixtures, values.config);
    for (const r of rep.results) {
      const flag = r.ok ? 'ok  ' : 'MISS';
      process.stdout.write(`${flag} ${String(r.set).padEnd(13)} ${r.nwo.padEnd(42)} ${r.lane.padEnd(13)} `
        + `S=${r.S} K=${r.k.toFixed(2)} ${r.gates.join(',')} ${r.problems.join('; ')}\n`);
    }
    for (const s of rep.setRules) {
      process.stdout.write(`${s.set}: median ${s.median} against the seed median ${s.seedMedian} `
        + `(${s.ok ? 'holds' : 'fails'})\n`);
    }
    return rep.ok ? 0 : 1;
  }
  if (values.check) {
    process.stdout.write(`${JSON.stringify(checkResearch(values.fixtures, values.config), null, 2)}\n`);
    return 0;
  }
  const { index, pooled, notes } = await buildSampleIndex({
    fixtures: values.fixtures, now: values.now, configDir: values.config,
  });
  writeJson(values.out, index);
  const summary = {
    file: path.relative(process.cwd(), values.out), bytes: byteLength(JSON.stringify(index)),
    entries: index.entries.length, counts: index.counts, pooled, notes,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (err) => {
    process.stderr.write(`make-index-sample: ${/** @type {Error} */ (err).message}\n`);
    process.exitCode = 1;
  });
}
