// @ts-check
/**
 * Format checks for `test/fixtures/**` (DESIGN §14.2), owned by WP0. Self-contained: it reads the
 * fixture files directly, never the network or `data/`, and validates the index sample with
 * `src/core/schema.mjs#validateIndex` when that module exists. `redteam/` (WP3) and `llm/` (WP5)
 * belong to other packages and are skipped.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test', 'fixtures');
const OTHER_PACKAGES = new Set(['redteam', 'llm']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const TOKEN = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/;
const LS = String.fromCharCode(0x2028);
const LANES = [
  'promising', 'proven', 'look', 'doubted', 'institutional', 'rising', 'graduated', 'quarantine',
];
const ENRICH_KEYS = new Set(['id', 'nameWithOwner', 'description', 'homepageUrl', 'createdAt', 'pushedAt',
  'diskUsage', 'stargazerCount', 'forkCount', 'isFork', 'isArchived', 'isTemplate', 'isMirror',
  'hasIssuesEnabled',
  'hasDiscussionsEnabled', 'licenseInfo', 'primaryLanguage', 'languages', 'repositoryTopics', 'releases',
  'tags',
  'watchers', 'owner', 'defaultBranchRef', 'root', 'wf', 'readme', 'pkg', 'agents', 'claude']);

/** §14.2 named sets — the contract, restated here so the fixtures are checked against it. */
const SEEDS = ['codefly-dev/cli', 'inamdarmihir/ask-my-tabs', 'sakajunquality/bunko', 'zaghaghi/toolog',
  'dragonGR/Dropzone', 'wonderingStars/foxsdr', 'montezuma-p/harken', 'nuetzliches/hookaido',
  'bodowd/duckdb_rdkit',
  'elacy/terraform-provider-pfsense', 'skulitom/london-time-map'];
const HARD_POSITIVES = ['gene-git/wg-client', 'legandrop/LGA_NukeShortcuts', 'YQ-RZJ/three.cj',
  'HUIXI-AI/RhinoForge', '07prajwal2000/streamer'];
const HARD_NEGATIVES = ['HaveNiceDa/My-Notion', 'ellmos-ai/bach', 'gtfo-ai/platform', 'AKzar1el/god-prompt',
  'gbazad93/AirFlow-ML-Data-Integration', 'ogforange-coder/CodenameEngine-Mobile', 'OBDb/Mazda-3'];
/** @type {Record<string, {outcome: string, gates: string[]}>} */
const LURES = {
  'islna637/crush-flake': { outcome: 'quarantined', gates: ['g.lure.link'] },
  'TigerSeparate/zaPReTTeLeGrAM': { outcome: 'quarantined', gates: ['g.lure.script'] },
  'd557wgl3zj/tohuys': { outcome: 'dropped', gates: ['g.spam.streak', 'g.spam.farm'] },
  'henry2026a/bishe-ssm-vue-js-1788757134': { outcome: 'dropped', gates: ['g.spam.farm'] },
  'DaraPalwina/darapalwinanet': { outcome: 'dropped', gates: ['g.spam.streak'] },
};

/**
 * @param {string} rel
 * @returns {any}
 */
function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(FIX, rel), 'utf8'));
}

/**
 * @param {string} rel
 */
function exists(rel) {
  return fs.existsSync(path.join(FIX, rel));
}

/**
 * @param {string} nwo
 */
function dirOf(nwo) {
  return `repos/${nwo.replace('/', '__')}`;
}

/**
 * Every file under the fixture tree that belongs to WP0.
 * @returns {string[]} paths relative to FIX
 */
function ownFiles() {
  /** @type {string[]} */
  const out = [];
  /** @param {string} rel */
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(FIX, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && OTHER_PACKAGES.has(e.name)) continue;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('');
  return out;
}

/**
 * Collect every key in a JSON value.
 * @param {unknown} v
 * @param {Set<string>} [acc]
 */
function keysDeep(v, acc = new Set()) {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, acc);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      acc.add(k);
      keysDeep(x, acc);
    }
  }
  return acc;
}

/**
 * The ```graphql blocks of DESIGN.md, or null when the design is not beside the tests.
 * @returns {string[] | null}
 */
function designBlocks() {
  const file = path.join(ROOT, 'DESIGN.md');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return [...text.matchAll(/```graphql\n([\s\S]*?)\n```/g)].map((m) => m[1]);
}

/**
 * A GH Archive sample split on `\n` by hand (never `readline`).
 * @param {string} rel
 */
function archiveLines(rel) {
  const text = gunzipSync(fs.readFileSync(path.join(FIX, rel))).toString('utf8');
  return text.split('\n').filter((l) => l.length > 0);
}

describe('labelled/labels.json', () => {
  const labels = readJson('labelled/labels.json');
  const rows = Object.entries(labels);

  it('holds the 149 research labels with category, flags, note and stratum', () => {
    assert.equal(rows.length, 149);
    for (const [nwo, v] of rows) {
      assert.match(nwo, /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
      assert.ok(['G', 'W', 'C', 'P', 'S', 'D', 'X', 'E'].includes(v.cat), nwo);
      assert.ok(Array.isArray(v.flags), nwo);
      assert.equal(typeof v.note, 'string');
      assert.ok(v.stratum === 'search' || v.stratum === 'uniform', nwo);
    }
  });

  it('matches the category and stratum counts of the haystack study', () => {
    /** @type {Record<string, number>} */
    const cats = {};
    for (const [, v] of rows) cats[v.cat] = (cats[v.cat] ?? 0) + 1;
    assert.deepEqual(cats, { G: 74, W: 12, C: 36, P: 8, S: 4, D: 6, X: 7, E: 2 });
    assert.equal(rows.filter(([, v]) => v.stratum === 'search').length, 80);
    assert.equal(rows.filter(([, v]) => v.stratum === 'uniform').length, 69);
    assert.equal(rows.filter(([, v]) => v.stratum === 'uniform' && v.cat === 'G').length, 9);
  });

  it('has a fixture for every label: 147 research snapshots and 2 meta-only spam fixtures', () => {
    let snapshots = 0;
    const metaOnly = [];
    for (const [nwo, v] of rows) {
      const meta = readJson(`${dirOf(nwo)}/meta.json`);
      assert.equal(meta.label, v.cat, nwo);
      assert.equal(meta.stratum, v.stratum, nwo);
      const snap = meta.labelledSnapshot ?? 'enrich.json';
      if (exists(`${dirOf(nwo)}/${snap}`)) snapshots++;
      else metaOnly.push(nwo);
    }
    assert.equal(snapshots, 147);
    assert.deepEqual(metaOnly.sort(), ['asot8tn56n/mseauu', 'm1lwmpmzom/ovxmxv']);
    for (const nwo of metaOnly) {
      const meta = readJson(`${dirOf(nwo)}/meta.json`);
      assert.equal(meta.label, 'X');
      assert.equal(meta.source, 'research');
      assert.equal(typeof meta.missing, 'string');
    }
  });
});

describe('repos/<owner>__<name>', () => {
  const dirs = fs.readdirSync(path.join(FIX, 'repos')).filter((d) => !d.startsWith('.'));

  it('every fixture has a meta.json naming its source and repository', () => {
    for (const d of dirs) {
      const meta = readJson(`repos/${d}/meta.json`);
      assert.ok(meta.source === 'recorded' || meta.source === 'research', d);
      assert.equal(meta.nwo.replace('/', '__'), d);
      if (meta.recordedAt !== null) assert.match(meta.recordedAt, ISO, d);
      else assert.ok(meta.missing, `${d}: recordedAt may be null only for a meta-only fixture`);
    }
  });

  it('enrich nodes use only §3.5 ENRICH fields and respect the text caps', () => {
    for (const d of dirs) {
      for (const f of ['enrich.json', 'enrich.research.json']) {
        if (!exists(`repos/${d}/${f}`)) continue;
        const node = readJson(`repos/${d}/${f}`);
        for (const k of Object.keys(node)) assert.ok(ENRICH_KEYS.has(k), `${d}/${f}: unexpected field ${k}`);
        const keys = keysDeep(node);
        for (const banned of ['messageBody', 'email', 'updatedAt', 'followers']) {
          assert.ok(!keys.has(banned), `${d}/${f}: ${banned} must not be stored`);
        }
        if (node.readme) {
          assert.equal(typeof node.readme.name, 'string', `${d}/${f}: readme carries its name`);
          assert.ok(Buffer.byteLength(node.readme.text ?? '', 'utf8') <= 8192, `${d}/${f}: README over 8 KB`);
        }
        if (node.pkg?.text) {
          assert.ok(Buffer.byteLength(node.pkg.text, 'utf8') <= 16384, `${d}/${f}: package.json`);
        }
        const hist = node.defaultBranchRef?.target?.history;
        if (hist) assert.ok(hist.nodes.length <= 20, `${d}/${f}: history over 20 nodes`);
        assert.ok((node.languages?.edges ?? []).length <= 8);
        assert.ok((node.repositoryTopics?.nodes ?? []).length <= 12);
      }
    }
  });

  it('research snapshots leave rollup, release dates, oid and contribution years absent', () => {
    for (const d of dirs) {
      const meta = readJson(`repos/${d}/meta.json`);
      const file = meta.source === 'research' ? 'enrich.json' : meta.labelledSnapshot;
      if (!file || !exists(`repos/${d}/${file}`)) continue;
      const node = readJson(`repos/${d}/${file}`);
      const target = node.defaultBranchRef?.target ?? {};
      assert.ok(!('statusCheckRollup' in target) && !('oid' in target), d);
      assert.ok(!node.releases || !('nodes' in node.releases), d);
      assert.ok(!node.owner || !('contributionsCollection' in node.owner), d);
    }
  });

  it('recorded fixtures carry a node id and the scored commit', () => {
    for (const d of dirs) {
      const meta = readJson(`repos/${d}/meta.json`);
      if (meta.source !== 'recorded') continue;
      const node = readJson(`repos/${d}/enrich.json`);
      assert.match(node.id, /^[A-Za-z_]+[A-Za-z0-9_-]+$/, d);
      assert.match(node.defaultBranchRef.target.oid, /^[0-9a-f]{40}$/, d);
      if (meta.labelledSnapshot) assert.ok(exists(`repos/${d}/${meta.labelledSnapshot}`), d);
    }
  });
});

describe('named sets (§14.2)', () => {
  /**
   * @param {string} nwo
   */
  const metaOf = (nwo) => readJson(`${dirOf(nwo)}/meta.json`);

  it('seed gems expect promising or proven (ask-my-tabs may be look, harken rising) and no gate', () => {
    for (const nwo of SEEDS) {
      const m = metaOf(nwo);
      assert.equal(m.set, 'seedGems', nwo);
      const ask = nwo === 'inamdarmihir/ask-my-tabs';
      const rising = nwo === 'montezuma-p/harken';
      const lanes = ask ? ['promising', 'proven', 'look'] : rising ? ['promising', 'proven', 'rising']
        : ['promising', 'proven'];
      assert.deepEqual(m.expect.lane, lanes, nwo);
      if (rising) assert.match(m.expect.note, /§6\.7 rule 5/);
      assert.equal(m.expect.minS, ask ? 5 : 7, nwo);
      assert.deepEqual(m.expect.gates, [], nwo);
    }
  });

  it('hard positives expect no gate; streamer reaches 7 points', () => {
    for (const nwo of HARD_POSITIVES) {
      const m = metaOf(nwo);
      assert.equal(m.set, 'hardPositives', nwo);
      assert.deepEqual(m.expect.gates, [], nwo);
      assert.equal(m.expect.minS, nwo === '07prajwal2000/streamer' ? 7 : null, nwo);
    }
  });

  it('hard negatives are never proven and sit below the seed median as a set', () => {
    for (const nwo of HARD_NEGATIVES) {
      const m = metaOf(nwo);
      assert.equal(m.set, 'hardNegatives', nwo);
      assert.deepEqual(m.expect.notLane, ['proven'], nwo);
      assert.match(m.expect.setRule, /median/);
    }
  });

  it('lures and spam name the §7.2 rule that quarantines or drops them', () => {
    for (const [nwo, want] of Object.entries(LURES)) {
      const m = metaOf(nwo);
      assert.equal(m.set, 'luresAndSpam', nwo);
      assert.equal(m.expect.outcome, want.outcome, nwo);
      assert.deepEqual(m.expect.gates, want.gates, nwo);
      assert.equal(m.expect.lane, want.outcome === 'quarantined' ? 'quarantine' : null, nwo);
    }
  });

  it('every named repository is recorded, or falls back to its research snapshot and says so', () => {
    for (const nwo of [...SEEDS, ...HARD_POSITIVES, ...HARD_NEGATIVES, ...Object.keys(LURES)]) {
      const m = metaOf(nwo);
      if (m.source === 'recorded') assert.ok(exists(`${dirOf(nwo)}/enrich.json`), nwo);
      else assert.ok(m.recording?.fallback, `${nwo}: a vanished repository says so in meta.recording`);
    }
  });

  it('seed gems have deep, tree, activity and (at 3 stars or more) star-history responses', () => {
    for (const nwo of SEEDS) {
      const m = metaOf(nwo);
      if (m.source !== 'recorded') continue;
      const d = dirOf(nwo);
      for (const f of ['deep.json', 'tree.json', 'activity.json']) {
        assert.ok(exists(`${d}/${f}`), `${nwo}: ${f}`);
      }
      const stars = readJson(`${d}/enrich.json`).stargazerCount;
      assert.equal(exists(`${d}/stars.json`), stars >= 3, `${nwo}: stars.json iff ≥ 3 stars`);
    }
  });
});

describe('deep-stage responses', () => {
  const dirs = fs.readdirSync(path.join(FIX, 'repos'));

  it('tree, activity, stars and files have the documented shapes', () => {
    for (const d of dirs) {
      if (exists(`repos/${d}/tree.json`)) {
        const t = readJson(`repos/${d}/tree.json`);
        assert.equal(typeof t.truncated, 'boolean', d);
        assert.ok(Array.isArray(t.tree) && t.tree.length <= 5000, d);
        for (const e of t.tree) {
          assert.ok(typeof e.path === 'string' && ['blob', 'tree', 'commit'].includes(e.type), d);
        }
      }
      if (exists(`repos/${d}/activity.json`)) {
        for (const a of readJson(`repos/${d}/activity.json`)) {
          assert.match(a.timestamp, ISO, d);
          assert.equal(typeof a.activity_type, 'string', d);
          assert.deepEqual(Object.keys(a).sort(), ['activity_type', 'id', 'ref', 'timestamp'], d);
        }
      }
      if (exists(`repos/${d}/stars.json`)) {
        for (const w of readJson(`repos/${d}/stars.json`)) {
          assert.ok(Number.isInteger(w.week) && Number.isInteger(w.total), d);
        }
      }
      if (exists(`repos/${d}/files.json`)) {
        for (const [p, blob] of Object.entries(readJson(`repos/${d}/files.json`))) {
          assert.ok(!p.startsWith('/') && !p.includes('..'), d);
          const text = /** @type {any} */ (blob)?.text ?? '';
          assert.ok(Buffer.byteLength(text, 'utf8') <= 16384, `${d}: ${p}`);
        }
      }
    }
  });
});

describe('github/graphql and github/rest samples', () => {
  const blocks = designBlocks();

  it('GraphQL envelopes are {request: {query, variables}, status, headers, body} read-only queries', () => {
    const files = fs.readdirSync(path.join(FIX, 'github', 'graphql'));
    assert.ok(files.includes('enrich-batch.json') && files.includes('deep-batch.json'));
    for (const f of files) {
      const env = readJson(`github/graphql/${f}`);
      assert.deepEqual(Object.keys(env).sort(), ['body', 'headers', 'request', 'status'], f);
      assert.deepEqual(Object.keys(env.request).sort(), ['query', 'variables'], f);
      assert.match(env.request.query, /^query\b/, `${f}: the first keyword is query`);
      assert.match(env.request.query, /rateLimit \{ cost remaining resetAt \}/, f);
      assert.equal(env.status, 200, f);
      assert.ok(env.body.data.rateLimit, f);
    }
  });

  const skip = !blocks && 'DESIGN.md not present';
  it('recorded requests contain the §3 documents verbatim', { skip }, () => {
    const [search, enrich, deep] = /** @type {string[]} */ (blocks);
    assert.ok(search.startsWith('query($q'));
    assert.ok(enrich.startsWith('fragment Enrich') && deep.startsWith('fragment Deep'));
    assert.ok(readJson('github/graphql/enrich-batch.json').request.query.includes(enrich));
    assert.ok(readJson('github/graphql/deep-batch.json').request.query.includes(deep));
    for (const f of fs.readdirSync(path.join(FIX, 'search'))) {
      for (const p of readJson(`search/${f}`).pages) assert.equal(p.request.query, search, f);
    }
  });

  it('NOT_FOUND aliases and nodes are recorded', () => {
    const exists_ = readJson('github/graphql/exists.json');
    assert.ok(exists_.body.errors.some((/** @type {any} */ e) => e.type === 'NOT_FOUND'));
    assert.ok(exists_.body.data.nodes.includes(null));
    const lookup = readJson('github/graphql/archive-lookup.json');
    assert.ok(lookup.request.query.includes('fragment Lean on Repository'));
    const aliasMissing = (/** @type {any} */ e) => e.type === 'NOT_FOUND' && /^r\d+$/.test(e.path[0]);
    assert.ok(lookup.body.errors.some(aliasMissing));
  });

  it('REST envelopes are {request: {path}, status, headers, body}', () => {
    for (const f of fs.readdirSync(path.join(FIX, 'github', 'rest'))) {
      const env = readJson(`github/rest/${f}`);
      assert.deepEqual(Object.keys(env).sort(), ['body', 'headers', 'request', 'status'], f);
      assert.deepEqual(Object.keys(env.request), ['path'], f);
      assert.match(env.request.path, /^\//, f);
    }
    assert.equal(readJson('github/rest/not-found.json').status, 404);
    const cond = readJson('github/rest/activity-304.json');
    assert.equal(cond.status, 304);
    assert.equal(cond.body, null);
    // GitHub answers the conditional request with the strong form of the weak ETag it sent.
    /** @param {string} e */
    const opaque = (e) => e.replace(/^W\//, '');
    assert.equal(opaque(cond.headers.etag), opaque(readJson('github/rest/activity.json').headers.etag));
  });

  it('stored headers never include credentials', () => {
    const dirsWithEnvelopes = ['github/graphql', 'github/rest'];
    for (const d of dirsWithEnvelopes) {
      for (const f of fs.readdirSync(path.join(FIX, d))) {
        for (const k of Object.keys(readJson(`${d}/${f}`).headers)) {
          assert.ok(!/authorization|cookie|oauth|token/i.test(k), `${d}/${f}: header ${k}`);
        }
      }
    }
  });
});

describe('search/ census windows', () => {
  const files = fs.readdirSync(path.join(FIX, 'search'));
  /**
   * @param {string} name
   */
  const load = (name) => {
    const f = files.find((x) => x.startsWith(`${name}-`));
    assert.ok(f, `a ${name} window is recorded`);
    return readJson(`search/${f}`);
  };

  /**
   * @param {any} w
   */
  const checkPaging = (w) => {
    w.pages.forEach((/** @type {any} */ p, /** @type {number} */ k) => {
      assert.equal(p.status, 200);
      assert.equal(p.request.variables.q, w.q);
      assert.equal(p.request.variables.first, 100);
      if (k === 0) assert.ok(!('after' in p.request.variables), 'the probe has no cursor');
      else {
        assert.equal(Buffer.from(p.request.variables.after, 'base64').toString('utf8'), `cursor:${100 * k}`);
        assert.ok(100 * k + 100 <= 1000, 'after + first never exceeds 1,000');
      }
      assert.equal(p.body.data.search.repositoryCount, w.repositoryCount);
    });
    const base = 'fork:false archived:false template:false mirror:false stars:0..25 size:>=200';
    assert.ok(w.q.startsWith(`${base} created:`));
    assert.ok(w.q.endsWith(' sort:stars-asc'));
    assert.equal(w.unitKey, `census:${w.day}:all:${w.fromIso}..${w.toIso}`);
  };

  it('a normal window of at most 900 hits is paged to its end', () => {
    const w = load('normal');
    assert.equal(w.saturated, false);
    assert.ok(w.repositoryCount <= 900);
    checkPaging(w);
    assert.equal(w.pages.length, Math.ceil(w.repositoryCount / 100));
    const ids = w.pages.flatMap((/** @type {any} */ p) => p.body.data.search.nodes)
      .map((/** @type {any} */ n) => n.id);
    assert.equal(new Set(ids).size, w.repositoryCount);
  });

  it('a saturated window of more than 1,000 hits is paged to the 1,000-result cap', () => {
    const w = load('saturated');
    assert.equal(w.saturated, true);
    assert.ok(w.repositoryCount > 1000);
    checkPaging(w);
    assert.equal(w.pages.length, 10);
    const ids = w.pages.flatMap((/** @type {any} */ p) => p.body.data.search.nodes)
      .map((/** @type {any} */ n) => n.id);
    assert.equal(ids.length, 1000);
  });
});

describe('gharchive/ sample', () => {
  const files = fs.readdirSync(path.join(FIX, 'gharchive'));

  it('is one hour, named YYYY-MM-DD-H.sample.json.gz, of about 500 events', () => {
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}-([0-9]|1[0-9]|2[0-3])\.sample\.json\.gz$/);
    const lines = archiveLines(`gharchive/${files[0]}`);
    assert.ok(lines.length >= 400 && lines.length <= 600, `${lines.length} lines`);
    const types = new Set(lines.map((l) => JSON.parse(l).type));
    for (const t of ['ReleaseEvent', 'PublicEvent', 'PushEvent']) assert.ok(types.has(t), t);
  });

  it('holds a raw U+2028 line that parses when split on \\n but breaks a readline-style split', () => {
    const lines = archiveLines(`gharchive/${files[0]}`);
    const withLs = lines.filter((l) => l.includes(LS));
    assert.ok(withLs.length >= 1);
    for (const l of withLs) assert.doesNotThrow(() => JSON.parse(l));
    const pieces = withLs[0].split(LS);
    assert.ok(pieces.length > 1);
    assert.throws(() => JSON.parse(pieces[0]));
  });
});

describe('index.sample.json', () => {
  const index = readJson('index.sample.json');

  it('validates against src/core/schema.mjs when it exists', async (t) => {
    const schema = path.join(ROOT, 'src', 'core', 'schema.mjs');
    if (!fs.existsSync(schema)) {
      t.skip('src/core/schema.mjs not present yet');
      return;
    }
    const { validateIndex } = await import(pathToFileURL(schema).href);
    assert.deepEqual(validateIndex(index), []);
  });

  it('has about 40 entries, every lane, and counts that match the entries', () => {
    assert.equal(index.v, 1);
    assert.ok(index.entries.length >= 30 && index.entries.length <= 50, `${index.entries.length} entries`);
    for (const lane of LANES) {
      const n = index.entries.filter((/** @type {any} */ e) => e.lane === lane).length;
      assert.ok(n > 0, `lane ${lane} appears`);
      assert.equal(index.counts[lane], n, `counts.${lane}`);
    }
    assert.equal(new Set(index.entries.map((/** @type {any} */ e) => e.id)).size, index.entries.length);
  });

  it('quarantined entries carry only identity, lane and gate reasons', () => {
    for (const e of index.entries.filter((/** @type {any} */ x) => x.lane === 'quarantine')) {
      assert.deepEqual(Object.keys(e).sort(), ['gates', 'id', 'lane', 'nwo']);
      const quarantining = (/** @type {any} */ g) => g.action === 'quarantine' && g.reason;
      assert.ok(e.gates.length && e.gates.every(quarantining));
    }
  });

  it('other entries carry scores, chips and explanations', () => {
    for (const e of index.entries.filter((/** @type {any} */ x) => x.lane !== 'quarantine')) {
      assert.ok(['gem', 'look', 'low'].includes(e.band), e.nwo);
      assert.ok(e.description === null || e.description.length <= 300, e.nwo);
      assert.ok(Array.isArray(e.chips) && e.chips.length > 0, e.nwo);
      for (const c of e.chips) assert.ok(['ok', 'unknown', 'na'].includes(c.status), e.nwo);
      assert.ok(e.quality >= 0 && e.quality <= 1 && e.k >= 0 && e.k <= 1 && e.a >= 0 && e.a <= 1, e.nwo);
    }
  });
});

describe('fixture hygiene', () => {
  const files = ownFiles();

  it('no fixture contains a GitHub token', () => {
    for (const f of files) {
      const buf = fs.readFileSync(path.join(FIX, f));
      const text = f.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      assert.ok(!TOKEN.test(text), `${f} contains something shaped like a token`);
    }
  });

  it('stays under about 15 MB in total', () => {
    const bytes = files.reduce((a, f) => a + fs.statSync(path.join(FIX, f)).size, 0);
    assert.ok(bytes < 15 * 1024 * 1024, `${bytes} bytes`);
  });

  it('README.md documents formats, provenance and the testing-only notice', () => {
    const readme = fs.readFileSync(path.join(FIX, 'README.md'), 'utf8');
    assert.match(readme, /for testing only/i);
    assert.match(readme, /8 KB/);
    assert.match(readme, /removed on request/i);
  });
});
