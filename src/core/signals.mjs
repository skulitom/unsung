// @ts-check
/**
 * The signal registry (DESIGN §5.3–§5.6): quality, proof and slop signals, confidence items and
 * descriptors, each a pure function of Facts. A signal's weight comes from `config/weights.json`;
 * the registry carries §5.3's values for any signal a weights file does not name.
 *
 * The judge, `llm.review`, is not evaluated here: `src/core/verdict.mjs#verdictSignal` produces it
 * and the scorer appends it after these signals (it is last in §5.3's order).
 *
 * Status semantics (§5.1): `ok` evaluated; `unknown` an input is null (scores 0, lowers coverage);
 * `na` does not apply. Reasons are British English and quote at most a short excerpt of repository
 * text; evidence URLs point at the scored commit.
 */

import {
  ecosystemsOf, isLockfile, isManifest, isTestPath, lockfileExpectation, testCommandRegexes, zeroDependency,
} from './ecosystems.mjs';
import {
  agentMarks, ciRootFiles, examplesDirs, junkRoot, platformMarks, templateReadme, webUiHeadline,
} from './lexicons.mjs';
import {
  SCRIPT_LABELS, cloneTargets, countFenceLines, detectScript, extractRefs, resolveRefs,
} from './readme.mjs';
import { clamp, daysBetween, truncateUtf8 } from './util.mjs';
import { findTestStep, runSteps } from './workflows.mjs';

/** @typedef {import('./schema.mjs').Facts} Facts */
/** @typedef {import('./schema.mjs').Signal} Signal */
/** @typedef {import('./schema.mjs').Descriptor} Descriptor */
/** @typedef {import('./schema.mjs').Evidence} Evidence */
/** @typedef {import('./readme.mjs').Ref} Ref */

/**
 * @typedef {object} EvalContext
 * @property {Record<string, any> | null} [weights] `config/weights.json`
 * @property {string | null} [now] ISO time of scoring (confidence items that need an age)
 * @property {Signal[]} [signals] already evaluated signals (confidence items read `p.testsRun`)
 * @property {Derived} [_derived] internal: values shared by the rules of one evaluation pass
 */

/**
 * @typedef {object} Outcome what a rule measured
 * @property {'ok' | 'unknown' | 'na'} status
 * @property {boolean} [hit]
 * @property {unknown} [value]
 * @property {number} [strength] confidence items, 0…1
 * @property {string} reason
 * @property {Evidence[]} [evidence]
 */

/**
 * @typedef {object} Derived values several rules share, computed once per evaluation pass
 * @property {{name: string, type: string}[] | null} root
 * @property {Set<string> | null} rootKeys lower-case root names, `/` after directories
 * @property {string[] | null} treePaths
 * @property {Ref[] | null} refs README references (§5.3.1)
 * @property {{file: string, command: string, neutralised: boolean} | null} testStep
 */

/**
 * @typedef {object} SignalDef
 * @property {string} id
 * @property {'quality' | 'proof' | 'slop'} kind
 * @property {number} points §5.3 weight, used when the weights file does not name the signal
 * @property {'cheap' | 'effort' | 'costly' | null} cost
 * @property {string | null} group
 * @property {boolean} provisional
 * @property {string} label
 * @property {string} hint what it takes to earn (or avoid) the points, for "why not higher"
 * @property {(facts: Facts, ctx?: EvalContext) => Signal} evaluate
 */

/**
 * @typedef {object} ConfidenceDef
 * @property {string} id
 * @property {'confidence'} kind
 * @property {string} group
 * @property {'cheap' | 'effort' | 'costly'} cost
 * @property {number} max the strongest this item can be
 * @property {string} label
 * @property {string} hint what would raise confidence
 * @property {(facts: Facts, ctx?: EvalContext) => Signal} evaluate
 */

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * @param {unknown} iso
 * @returns {string}
 */
function dayText(iso) {
  const ms = Date.parse(String(iso));
  if (!Number.isFinite(ms)) return 'an unknown date';
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function size(bytes) {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} bytes`;
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A short excerpt of repository text for a reason or quote.
 * @param {string} s
 * @param {number} [max]
 * @returns {string}
 */
function short(s, max = 60) {
  const clean = String(s).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}\u{2026}` : clean;
}

/** @param {Facts} f */
const repoUrl = (f) => `https://github.com/${f.nwo}`;
/** @param {Facts} f */
const refOf = (f) => f.headOid ?? f.defaultBranch ?? 'HEAD';
/** @param {string} p */
const encodePath = (p) => String(p).split('/').map(encodeURIComponent).join('/');
/**
 * @param {Facts} f
 * @param {string} p
 */
const blobUrl = (f, p) => `${repoUrl(f)}/blob/${refOf(f)}/${encodePath(p)}`;
/**
 * @param {Facts} f
 * @param {string} p
 */
const treeUrl = (f, p) => `${repoUrl(f)}/tree/${refOf(f)}/${encodePath(p)}`;
/** @param {string} name */
const isYaml = (name) => /\.ya?ml$/i.test(name);
/** @param {{name: string, type: string}} e */
const rootKey = (e) => `${String(e.name).toLowerCase()}${e.type === 'tree' ? '/' : ''}`;

/**
 * @param {boolean} hit
 * @param {string} reason
 * @param {unknown} [value]
 * @param {Evidence[]} [evidence]
 * @returns {Outcome}
 */
function ok(hit, reason, value = null, evidence = []) {
  return { status: 'ok', hit, reason, value, evidence };
}

/**
 * @param {string} reason
 * @param {unknown} [value]
 * @returns {Outcome}
 */
function unknown(reason, value = null) {
  return { status: 'unknown', reason, value };
}

/**
 * @param {string} reason
 * @param {unknown} [value]
 * @returns {Outcome}
 */
function na(reason, value = null) {
  return { status: 'na', reason, value };
}

/**
 * The first workflow step that runs tests, preferring one that is not neutralised (§5.2).
 * @param {Facts} f
 * @returns {Derived['testStep']}
 */
function testStepOf(f) {
  const regexes = testCommandRegexes();
  const testScript = f.packageJson?.testScript ?? null;
  /** @type {Derived['testStep']} */
  let neutralised = null;
  for (const w of f.workflows ?? []) {
    if (!isYaml(w.name) || typeof w.text !== 'string') continue;
    const found = findTestStep(runSteps(w.text), regexes, { testScript });
    if (!found) continue;
    const hit = { file: w.name, command: found.command, neutralised: found.neutralised };
    if (!found.neutralised) return hit;
    neutralised ??= hit;
  }
  return neutralised;
}

/**
 * @param {Facts} f
 * @returns {Derived}
 */
function derive(f) {
  const root = Array.isArray(f.root) ? f.root : null;
  const text = typeof f.readme?.text === 'string' ? f.readme.text : null;
  return {
    root,
    rootKeys: root ? new Set(root.map(rootKey)) : null,
    treePaths: f.tree && Array.isArray(f.tree.entries) ? f.tree.entries.map((e) => String(e[0])) : null,
    refs: text === null ? null : extractRefs(text),
    testStep: testStepOf(f),
  };
}

// ---------------------------------------------------------------------------------------------
// Quality signals (§5.3)
// ---------------------------------------------------------------------------------------------

/** @typedef {(f: Facts, d: Derived, ctx: EvalContext) => Outcome} Rule */

/** @type {Rule} */
function qLicence(f, d) {
  const file = d.root?.find((e) => e.type !== 'tree'
    && /^(licen[cs]e|copying|unlicense)([.-].*)?$/i.test(e.name));
  const evidence = file ? [{ label: file.name, url: blobUrl(f, file.name) }] : [];
  if (f.licence === null || f.licence === undefined) return ok(false, 'No licence detected', null, evidence);
  const reason = f.licence === 'NOASSERTION' ? 'A licence GitHub could not identify' : `Licence ${f.licence}`;
  return ok(true, reason, f.licence, evidence);
}

/** @type {Rule} */
function qReadme(f) {
  const r = f.readme;
  if (!r) return ok(false, 'No README', 0);
  const evidence = [{ label: r.name, url: blobUrl(f, r.name) }];
  return ok(r.bytes >= 1000, `${r.name}, ${size(r.bytes)}`, r.bytes, evidence);
}

/** @type {Rule} */
function qUsage(f) {
  const r = f.readme;
  if (!r) return ok(false, 'No README', 0);
  const stored = /** @type {any} */ (r).fenceLines;
  const lines = typeof stored === 'number' ? stored
    : typeof r.text === 'string' ? countFenceLines(r.text) : null;
  if (lines === null) return unknown('README text not fetched');
  const reason = `${plural(Math.floor(lines / 2), 'fenced code block')} in the README`;
  return ok(lines >= 4, reason, lines, [{ label: r.name, url: blobUrl(f, r.name) }]);
}

/** @type {Rule} */
function qCi(f, d) {
  const yml = (f.workflows ?? []).filter((w) => isYaml(w.name));
  if (yml.length) {
    const evidence = [{ label: '.github/workflows', url: treeUrl(f, '.github/workflows') }];
    return ok(true, plural(yml.length, 'GitHub Actions workflow'), yml.map((w) => w.name), evidence);
  }
  const other = d.root?.find((e) => ciRootFiles.includes(rootKey(e)));
  if (other) {
    const url = other.type === 'tree' ? treeUrl(f, other.name) : blobUrl(f, other.name);
    return ok(true, `${other.name} at the root`, [other.name], [{ label: other.name, url }]);
  }
  if (!d.root || !d.rootKeys) return unknown('Root listing not fetched');
  if (f.workflows === null && d.rootKeys.has('.github/')) return unknown('Workflow directory not fetched');
  return ok(false, 'No CI configuration', []);
}

/** @type {Rule} */
function qManifest(f, d) {
  if (!d.root) return unknown('Root listing not fetched');
  const found = d.root.filter((e) => e.type !== 'tree' && isManifest(e.name)).map((e) => e.name);
  if (!found.length) return ok(false, 'No package or build manifest at the root', []);
  const evidence = [{ label: found[0], url: blobUrl(f, found[0]) }];
  return ok(true, `${found.slice(0, 3).join(', ')} at the root`, found, evidence);
}

/** @type {Rule} */
function qDeps(f, d) {
  if (!d.root) return unknown('Root listing not fetched');
  const lock = d.root.find((e) => e.type !== 'tree' && isLockfile(e.name));
  if (lock) {
    return ok(true, `${lock.name} committed`, lock.name, [{ label: lock.name, url: blobUrl(f, lock.name) }]);
  }
  const zero = zeroDependency(f);
  if (zero === true) return ok(true, 'A manifest with no dependencies', 'zero-dependency');
  const ecos = ecosystemsOf(f);
  if (lockfileExpectation(ecos) === 'optional') {
    const reason = ecos.length ? `No lockfile is expected for ${ecos.join(', ')}`
      : 'No package manager in use';
    return na(reason, ecos);
  }
  if (zero === null) return unknown('Manifest contents not fetched');
  return ok(false, 'No lockfile committed', null);
}

/** @type {Rule} */
function qTests(f, d) {
  if (!d.root && !f.tree) return unknown('Root listing not fetched');
  const rootHit = d.root?.find((e) => isTestPath(e.type === 'tree' ? `${e.name}/` : e.name)) ?? null;
  /** @type {string[] | null} */
  let tests = null;
  if (f.tree && Array.isArray(f.tree.entries)) {
    tests = f.tree.entries.filter((e) => e[1] !== 'tree' && isTestPath(String(e[0])))
      .map((e) => String(e[0]));
  }
  const first = tests?.[0] ?? null;
  if (!rootHit && !first) {
    return ok(false, f.tree ? 'No test files in the tree' : 'No test directory or file at the root', 0);
  }
  if (first && tests) {
    const reason = `${plural(tests.length, 'test file')}, such as ${short(first, 80)}`;
    return ok(true, reason, tests.length, [{ label: first, url: blobUrl(f, first) }]);
  }
  const hit = /** @type {{name: string, type: string}} */ (rootHit);
  const dir = hit.type === 'tree';
  const url = dir ? treeUrl(f, hit.name) : blobUrl(f, hit.name);
  const reason = `Tests at ${hit.name}${dir ? '/' : ''}`;
  return ok(true, reason, tests ? tests.length : 1, [{ label: hit.name, url }]);
}

/** @type {Rule} */
function qCode(f) {
  if (typeof f.codeBytes !== 'number') return unknown('Language sizes not fetched');
  return ok(f.codeBytes >= 50_000, `${size(f.codeBytes)} of code`, f.codeBytes);
}

/** @type {Rule} */
function qRelease(f) {
  const rc = f.releases ? f.releases.count : null;
  const tags = typeof f.tags === 'number' ? f.tags : null;
  if (rc !== null && rc >= 1) {
    const latest = f.releases?.recent?.[0];
    let when = '';
    if (latest?.tag) when = `, latest ${short(latest.tag, 30)}`;
    if (latest?.tag && latest.publishedAt) when += ` on ${dayText(latest.publishedAt)}`;
    const evidence = [{ label: 'releases', url: `${repoUrl(f)}/releases` }];
    return ok(true, `${plural(rc, 'release')}${when}`, rc, evidence);
  }
  if (tags !== null && tags >= 1) {
    return ok(true, plural(tags, 'tag'), tags, [{ label: 'tags', url: `${repoUrl(f)}/tags` }]);
  }
  if (rc === null || tags === null) return unknown('Releases or tags not fetched');
  return ok(false, 'No releases or tags', 0);
}

/** @type {Rule} */
function qExamples(f, d) {
  if (!d.root) return unknown('Root listing not fetched');
  const dir = d.root.find((e) => e.type === 'tree' && examplesDirs.includes(e.name.toLowerCase()));
  if (!dir) return ok(false, 'No examples directory', null);
  const evidence = [{ label: `${dir.name}/`, url: treeUrl(f, dir.name) }];
  return ok(true, `${dir.name}/ at the root`, dir.name, evidence);
}

// ---------------------------------------------------------------------------------------------
// Proof signals (§5.3, provisional)
// ---------------------------------------------------------------------------------------------

/** @type {Rule} */
function pTestsRun(f, d) {
  if (!Array.isArray(f.workflows)) return unknown('Workflow files not fetched');
  const yml = f.workflows.filter((w) => isYaml(w.name));
  if (!yml.length) return ok(false, 'No GitHub Actions workflows', null);
  const fetched = yml.filter((w) => typeof w.text === 'string');
  if (!fetched.length) return unknown('Workflow files not fetched yet');
  const t = d.testStep;
  if (!t) {
    if (fetched.length < yml.length) {
      return unknown(`No test command in the ${plural(fetched.length, 'workflow')} fetched`);
    }
    return ok(false, 'CI runs no test command', null);
  }
  const cmd = short(t.command, 60);
  const value = short(t.command, 120);
  const evidence = [
    { label: t.file, url: blobUrl(f, `.github/workflows/${t.file}`) },
    { label: 'CI runs', url: `${repoUrl(f)}/actions` },
  ];
  if (t.neutralised) {
    // §5.3 "workflow texts not fetched → unknown": `testStepOf` prefers a test step that is not
    // neutralised, and one may sit in a workflow that was not fetched.
    if (fetched.length < yml.length) {
      return unknown(`CI runs ${cmd} but ignores its failures; `
        + `${plural(yml.length - fetched.length, 'workflow')} not fetched`, value);
    }
    return ok(false, `CI runs ${cmd} but ignores its failures`, value, evidence);
  }
  if (f.rollup !== 'SUCCESS') {
    return unknown(`CI runs ${cmd}; the latest CI state is ${f.rollup ?? 'not reported'}`, value);
  }
  return ok(true, `CI runs ${cmd} and passes`, value, evidence);
}

/**
 * Non-prerelease releases with a publication date, or the outcome when they cannot be judged.
 * @param {Facts} f
 * @returns {{dated: {tag: string, publishedAt: string}[]} | {outcome: Outcome}}
 */
function datedReleases(f) {
  const rel = f.releases;
  if (!rel) return { outcome: unknown('Releases not fetched') };
  if (rel.count === 0) return { outcome: ok(false, 'No releases', 0) };
  const recent = Array.isArray(rel.recent) ? rel.recent : [];
  if (!recent.some((r) => typeof r.publishedAt === 'string')) {
    return { outcome: unknown('Release dates not fetched') };
  }
  const dated = recent.filter((r) => r.prerelease !== true && typeof r.publishedAt === 'string')
    .map((r) => ({ tag: r.tag, publishedAt: /** @type {string} */ (r.publishedAt) }));
  if (!dated.length) return { outcome: ok(false, 'Only prereleases among the recent releases', 0) };
  return { dated };
}

/** @type {Rule} */
function pShipped(f) {
  const r = datedReleases(f);
  if ('outcome' in r) return r.outcome;
  const days = [...new Set(r.dated.map((x) => x.publishedAt.slice(0, 10)))].sort();
  const span = daysBetween(days[0], days[days.length - 1]);
  const reason = `${plural(r.dated.length, 'release')} on ${plural(days.length, 'day')} `
    + `over ${plural(Math.round(span), 'day')}`;
  const value = { releases: r.dated.length, days: days.length, spanDays: Math.round(span) };
  const evidence = [{ label: 'releases', url: `${repoUrl(f)}/releases` }];
  return ok(days.length >= 2 && span >= 7, reason, value, evidence);
}

/**
 * Shared measurement of `p.coherent` and `s.incoherent` (§5.3.1).
 * @param {Facts} f
 * @param {Derived} d
 * @returns {{outcome: Outcome} | {res: ReturnType<typeof resolveRefs>, share: number, truncated: boolean}}
 */
function coherence(f, d) {
  if (!f.readme) return { outcome: na('No README') };
  if (d.refs === null) return { outcome: unknown('README text not fetched') };
  /** @param {number} n */
  const few = (n) => ({ outcome: na(`${plural(n, 'checkable reference')} in the README; 5 are needed`, n) });
  if (d.refs.length < 5) return few(d.refs.length);
  if (!d.treePaths) return { outcome: unknown('File tree not fetched yet', d.refs.length) };
  const scripts = /** @type {any} */ (f.packageJson)?.scripts ?? null;
  const res = resolveRefs(d.refs, { paths: d.treePaths, scripts, repo: f.nwo });
  if (res.cited < 5) return few(res.cited);
  return { res, share: res.resolved / res.cited, truncated: f.tree?.truncated === true };
}

/** @type {Rule} */
function pCoherent(f, d) {
  const c = coherence(f, d);
  if ('outcome' in c) return c.outcome;
  const reason = `${c.res.resolved} of ${c.res.cited} cited paths and scripts exist`;
  const value = { cited: c.res.cited, resolved: c.res.resolved };
  const hit = c.share >= 0.8;
  if (!hit && c.truncated) return unknown(`${reason}; the tree listing is truncated`, value);
  return ok(hit, reason, value, f.readme ? [{ label: f.readme.name, url: blobUrl(f, f.readme.name) }] : []);
}

/** @type {Rule} */
function sIncoherent(f, d) {
  const c = coherence(f, d);
  if ('outcome' in c) return c.outcome;
  const reason = `${c.res.resolved} of ${c.res.cited} cited paths and scripts exist`;
  const value = { cited: c.res.cited, resolved: c.res.resolved };
  const hit = c.share < 0.4;
  if (hit && c.truncated) return unknown(`${reason}; the tree listing is truncated`, value);
  const evidence = hit ? c.res.unresolved.slice(0, 3)
    .map((u) => ({ label: `missing ${u.kind}`, url: treeUrl(f, ''), quote: short(u.value, 120) })) : [];
  return ok(hit, reason, value, evidence);
}

// ---------------------------------------------------------------------------------------------
// Slop signals (§5.3, §7.3)
// ---------------------------------------------------------------------------------------------

/** @type {Rule} */
function sWebui(f) {
  if (!f.commits) return unknown('Commit history not fetched');
  const heads = (f.commits.recent ?? []).map((c) => c.headline).filter((h) => typeof h === 'string');
  if (heads.length < 4) {
    return na(`${plural(heads.length, 'recent commit')}; at least 4 are needed to judge`, heads.length);
  }
  const web = heads.filter((h) => webUiHeadline.test(/** @type {string} */ (h))).length;
  const reason = `${web} of ${heads.length} recent commits carry GitHub web-editor messages`;
  const evidence = [{ label: 'commits', url: `${repoUrl(f)}/commits/${refOf(f)}` }];
  return ok(web / heads.length >= 0.5, reason, { web, total: heads.length }, evidence);
}

/** @type {Rule} */
function sTemplate(f, d) {
  const text = typeof f.readme?.text === 'string' ? f.readme.text : null;
  const head = text === null ? null : truncateUtf8(text, 4096).text;
  const m = head === null ? null : templateReadme.map((re) => re.exec(head)).find((x) => x) ?? null;
  if (m && f.readme) {
    const evidence = [{ label: f.readme.name, url: blobUrl(f, f.readme.name), quote: short(m[0], 120) }];
    return ok(true, `An untouched template README ("${short(m[0], 50)}")`, short(m[0], 120), evidence);
  }
  const marks = d.root ? d.root.filter((e) => platformMarks.includes(rootKey(e))).map((e) => e.name) : null;
  if (marks?.length) {
    const evidence = marks.map((n) => ({ label: n, url: treeUrl(f, n) }));
    return ok(true, `App-builder files at the root: ${marks.join(', ')}`, marks, evidence);
  }
  if (!d.root || (f.readme && text === null)) return unknown('README text or root listing not fetched');
  return ok(false, 'No template or app-builder marks', null);
}

/** @type {Rule} */
function sProse(f) {
  if (typeof f.codeBytes !== 'number') return unknown('Language sizes not fetched');
  const rb = f.readme?.bytes ?? 0;
  const reason = `README ${size(rb)} against ${size(f.codeBytes)} of code`;
  return ok(rb > 5 * Math.max(f.codeBytes, 1), reason, { readme: rb, code: f.codeBytes });
}

/** @type {Rule} */
function sMdheavy(f, d) {
  if (!d.root || typeof f.codeBytes !== 'number') {
    return unknown('Root listing or language sizes not fetched');
  }
  const md = d.root.filter((e) => e.type !== 'tree' && /\.md$/i.test(e.name)).length;
  const reason = `${plural(md, 'Markdown file')} at the root, ${size(f.codeBytes)} of code`;
  return ok(md >= 4 && f.codeBytes < 20_000, reason, md);
}

/** @type {Rule} */
function sJunk(f, d) {
  if (!d.root && !f.tree) return unknown('Root listing not fetched');
  const rootJunk = d.root?.find((e) => junkRoot.includes(rootKey(e))) ?? null;
  if (rootJunk) {
    const dir = rootJunk.type === 'tree';
    const url = dir ? treeUrl(f, rootJunk.name) : blobUrl(f, rootJunk.name);
    const name = `${rootJunk.name}${dir ? '/' : ''}`;
    return ok(true, `${name} committed at the root`, name, [{ label: name, url }]);
  }
  for (const e of f.tree?.entries ?? []) {
    const p = String(e[0]);
    const parts = p.split('/');
    const dirs = (e[1] === 'tree' ? parts : parts.slice(0, -1)).map((s) => s.toLowerCase());
    const env = e[1] !== 'tree' && parts[parts.length - 1] === '.env' && !parts.includes('examples');
    if (dirs.includes('node_modules') || dirs.includes('__pycache__') || env) {
      return ok(true, `${short(p, 80)} committed`, p, [{ label: p, url: blobUrl(f, p) }]);
    }
  }
  return ok(false, 'No dependencies, caches or secrets committed', null);
}

/** @type {Rule} */
function sFarm(f) {
  const o = f.ownerInfo;
  if (!o) return unknown('Owner not known');
  if (o.type === 'Organization') return ok(false, 'Owned by an organisation', o.publicRepos ?? null);
  if (o.type !== 'User') return unknown('Owner type not known');
  if (typeof o.publicRepos !== 'number') return unknown('Owner repository count not known');
  const reason = `The owner has ${plural(o.publicRepos, 'public repository', 'public repositories')}`;
  return ok(o.publicRepos >= 200, reason, o.publicRepos);
}

/** @type {Rule} */
function sCloneUrl(f) {
  const r = f.readme;
  if (!r) return ok(false, 'No README', null);
  if (typeof r.text !== 'string') return unknown('README text not fetched');
  const targets = cloneTargets(r.text);
  const other = targets.find((t) => t.owner.toLowerCase() !== f.owner.toLowerCase()
    && t.name.toLowerCase() === f.name.toLowerCase());
  if (other) {
    const target = `${other.owner}/${other.name}`;
    const evidence = [{ label: r.name, url: blobUrl(f, r.name), quote: short(`git clone ${target}`, 120) }];
    return ok(true, `The README clones ${short(target, 80)}`, target, evidence);
  }
  return ok(false, targets.length ? 'Clone URLs point here' : 'No clone URL in the README', null);
}

// ---------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------

/**
 * @param {SignalDef} def
 * @param {Outcome} out
 * @param {Record<string, any> | null | undefined} weights
 * @returns {Signal}
 */
function toSignal(def, out, weights) {
  const w = weights?.signals?.[def.id];
  const weight = typeof w?.points === 'number' ? w.points : def.points;
  const hit = out.status === 'ok' ? out.hit === true : null;
  return {
    id: def.id,
    kind: def.kind,
    status: out.status,
    hit,
    value: out.value ?? null,
    weight,
    points: hit ? weight : 0,
    strength: null,
    group: typeof w?.group === 'string' ? w.group : def.group,
    provisional: typeof w?.provisional === 'boolean' ? w.provisional : def.provisional,
    cost: def.cost,
    label: def.label,
    reason: out.reason,
    evidence: out.evidence ?? [],
  };
}

/**
 * @param {string} id
 * @param {'quality' | 'proof' | 'slop'} kind
 * @param {number} points
 * @param {'cheap' | 'effort' | 'costly' | null} cost
 * @param {string} label
 * @param {string} hint
 * @param {Rule} rule
 * @param {{group?: string, provisional?: boolean}} [extra]
 * @returns {SignalDef}
 */
function signal(id, kind, points, cost, label, hint, rule, extra = {}) {
  /** @type {SignalDef} */
  const def = {
    id, kind, points, cost, group: extra.group ?? null, provisional: extra.provisional === true, label, hint,
    evaluate(facts, ctx = {}) {
      /** @type {Outcome} */
      let out;
      try {
        out = rule(facts, ctx._derived ?? derive(facts), ctx);
      } catch {
        out = unknown('Could not be evaluated on these facts');
      }
      return toSignal(def, out, ctx.weights);
    },
  };
  return Object.freeze(def);
}

const PROV = { provisional: true };

/** The quality, proof and slop signals of §5.3, in registry order (`llm.review` follows them). */
export const SIGNALS = Object.freeze([
  signal('q.licence', 'quality', 1, 'cheap', 'Has a licence',
    '+1 with a licence file GitHub can detect', qLicence),
  signal('q.readme', 'quality', 1, 'cheap', 'Substantial README',
    '+1 for a README of at least 1 KB', qReadme),
  signal('q.usage', 'quality', 1, 'cheap', 'Shows how to use it',
    '+1 for at least two code blocks in the README showing how to use it', qUsage),
  signal('q.ci', 'quality', 1, 'cheap', 'Has CI',
    '+1 for a CI workflow', qCi),
  signal('q.manifest', 'quality', 1, 'cheap', 'Build manifest',
    '+1 for a package or build manifest at the root', qManifest),
  signal('q.deps', 'quality', 1, 'cheap', 'Pinned dependencies',
    '+1 for a committed lockfile, or a manifest with no dependencies', qDeps),
  signal('q.tests', 'quality', 1, 'cheap', 'Has tests',
    '+1 for tests in the repository', qTests),
  signal('q.code', 'quality', 1, 'effort', 'Real code',
    '+1 for at least 50 KB of code', qCode),
  signal('q.release', 'quality', 1, 'cheap', 'Ships releases',
    '+1 for a release or a tag', qRelease),
  signal('q.examples', 'quality', 1, 'cheap', 'Has examples',
    '+1 for an examples or demo directory', qExamples),
  signal('p.testsRun', 'proof', 1, 'effort', 'CI runs the tests',
    '+1 if CI runs the tests and passes', pTestsRun, PROV),
  signal('p.shipped', 'proof', 1, 'costly', 'Shipped over time',
    '+1 for releases on two days at least a week apart', pShipped, PROV),
  signal('p.coherent', 'proof', 1, 'effort', 'README matches the code',
    '+1 when at least 80% of the paths and scripts the README cites exist', pCoherent, PROV),
  // Retired in weights w2 (§5.3): still evaluated and shown as a chip, worth no points.
  signal('s.incoherent', 'slop', 0, 'effort', 'README cites missing files',
    'Noted, not scored (retired in weights w2): fewer than 40% of the cited paths and scripts exist',
    sIncoherent),
  signal('s.webui', 'slop', -2, null, 'Uploaded through the web',
    'Penalised when most recent commits carry GitHub web-editor messages', sWebui),
  signal('s.template', 'slop', -2, null, 'Untouched template',
    'Penalised for a template README left as generated, or app-builder files', sTemplate),
  signal('s.prose', 'slop', -2, null, 'Mostly prose',
    'Penalised when the README is more than five times the size of the code', sProse, { group: 'prose' }),
  signal('s.mdheavy', 'slop', -1, null, 'Markdown-heavy',
    'Penalised for four or more Markdown files at the root over less than 20 KB of code', sMdheavy,
    { group: 'prose' }),
  signal('s.junk', 'slop', -1, null, 'Junk committed',
    'Penalised for committed dependencies, caches or .env files', sJunk),
  signal('s.farm', 'slop', -1, null, 'Prolific owner',
    'Penalised when the owner has 200 or more public repositories', sFarm),
  signal('s.cloneUrl', 'slop', -1, null, 'Clone URL points elsewhere',
    'Penalised when the README clones a same-named repository from another owner', sCloneUrl, PROV),
]);

/** Id of the judge signal, produced by `src/core/verdict.mjs` and appended after `SIGNALS`. */
export const JUDGE_ID = 'llm.review';

/**
 * Evaluate every quality, proof and slop signal of §5.3 on Facts, in registry order.
 * @param {Facts} facts
 * @param {EvalContext} [ctx] `{weights, now}`
 * @returns {Signal[]}
 */
export function evaluateSignals(facts, ctx = {}) {
  const c = { ...ctx, _derived: derive(facts) };
  return SIGNALS.map((def) => def.evaluate(facts, c));
}

// ---------------------------------------------------------------------------------------------
// Confidence items (§5.4)
// ---------------------------------------------------------------------------------------------

/** @typedef {(f: Facts, ctx: EvalContext) => Outcome} ItemRule */

/** The strongest `k.owner` can be for an organisation (§5.4): one created at least two years ago. */
export const ORG_OWNER_MAX = 0.15;

/**
 * `value` is the number of contribution years before 2024 for a user, and `{ownerType:
 * 'Organization', days}` for an organisation (`days` since creation, null when unknown), so an
 * explanation can use the organisation ceiling.
 * @type {ItemRule}
 */
function kOwner(f, ctx) {
  const o = f.ownerInfo;
  if (!o) return unknown('Owner not known');
  if (o.type === 'Organization') {
    if (!o.createdAt || !ctx.now) {
      return unknown('Organisation age not known', { ownerType: 'Organization', days: null });
    }
    const days = daysBetween(o.createdAt, ctx.now);
    const reason = `An organisation created ${dayText(o.createdAt)}`;
    const value = { ownerType: 'Organization', days: Math.floor(days) };
    return { status: 'ok', strength: days >= 730 ? ORG_OWNER_MAX : 0, reason, value };
  }
  if (!Array.isArray(o.contributionYears)) return unknown('Owner contribution history not fetched');
  const before = o.contributionYears.filter((y) => y < 2024).length;
  const strength = before >= 3 ? 0.3 : before >= 1 ? 0.15 : 0;
  const reason = `${plural(before, 'year')} of contributions before 2024`;
  return { status: 'ok', strength, reason, value: before };
}

/** @type {ItemRule} */
function kTime(f) {
  if (!f.createdAt || !f.pushedAt) return unknown('Creation or push time not known');
  const span = daysBetween(f.createdAt, f.pushedAt);
  const strength = span >= 180 ? 0.25 : span >= 30 ? 0.1 : 0;
  const reason = `Last pushed ${plural(Math.max(0, Math.floor(span)), 'day')} after it was created`;
  return { status: 'ok', strength, reason, value: Math.floor(span) };
}

/** @type {ItemRule} */
function kPushDays(f) {
  const a = f.activity;
  if (!a) return unknown('Push activity not fetched');
  const span = a.firstAt && a.lastAt ? daysBetween(a.firstAt, a.lastAt) : 0;
  const strength = a.pushDays >= 20 && span >= 180 ? 0.4 : a.pushDays >= 5 && span >= 30 ? 0.25 : 0;
  const reason = `Pushed on ${plural(a.pushDays, 'day')} over ${plural(Math.round(span), 'day')}`;
  return { status: 'ok', strength, reason, value: { pushDays: a.pushDays, spanDays: Math.round(span) } };
}

/** @type {ItemRule} */
function kReleases(f) {
  const r = datedReleases(f);
  if ('outcome' in r) return r.outcome.status === 'ok' ? { ...r.outcome, strength: 0 } : r.outcome;
  const times = r.dated.map((x) => x.publishedAt).sort();
  const span = daysBetween(times[0], times[times.length - 1]);
  const strength = r.dated.length >= 3 && span >= 28 ? 0.3 : 0;
  const reason = `${plural(r.dated.length, 'release')} over ${plural(Math.round(span), 'day')}`;
  return { status: 'ok', strength, reason, value: { releases: r.dated.length, spanDays: Math.round(span) } };
}

/** @type {ItemRule} */
function kOutsiders(f) {
  if (!Array.isArray(f.outsiders)) return unknown('Issue and pull-request authors not fetched');
  const owner = f.owner.toLowerCase();
  const insiders = new Set((f.commits?.recent ?? [])
    .map((c) => c.authorLogin?.toLowerCase()).filter(Boolean));
  const established = new Set();
  for (const o of f.outsiders) {
    const login = String(o.login ?? '').toLowerCase();
    if (!login || login === owner || insiders.has(login) || login.endsWith('[bot]')) continue;
    if (!o.accountCreatedAt || !o.at) continue;
    if (daysBetween(o.accountCreatedAt, o.at) >= 365) established.add(login);
  }
  const n = established.size;
  const reason = n ? `${plural(n, 'established outsider')} opened issues or pull requests`
    : 'No issues or pull requests from established outsiders';
  return { status: 'ok', strength: Math.min(0.45, 0.15 * n), reason, value: n };
}

/** @type {ItemRule} */
function kCiVerified(f, ctx) {
  const tr = ctx.signals?.find((s) => s.id === 'p.testsRun')
    ?? SIGNALS.find((s) => s.id === 'p.testsRun')?.evaluate(f, { weights: ctx.weights });
  if (!tr || tr.status !== 'ok') return unknown('CI test run not verified');
  const reason = tr.hit ? 'CI runs the tests and passes' : tr.reason;
  return { status: 'ok', strength: tr.hit ? 0.15 : 0, reason };
}

/**
 * @param {string} id
 * @param {string} group
 * @param {'cheap' | 'effort' | 'costly'} cost
 * @param {number} max
 * @param {string} label
 * @param {string} hint
 * @param {ItemRule} rule
 * @returns {ConfidenceDef}
 */
function item(id, group, cost, max, label, hint, rule) {
  /** @type {ConfidenceDef} */
  const def = {
    id, kind: 'confidence', group, cost, max, label, hint,
    evaluate(facts, ctx = {}) {
      /** @type {Outcome} */
      let out;
      try {
        out = rule(facts, ctx);
      } catch {
        out = unknown('Could not be evaluated on these facts');
      }
      const w = ctx.weights?.confidence?.[id];
      const strength = out.status === 'ok' ? clamp(out.strength ?? 0, 0, 1) : 0;
      return {
        id,
        kind: 'confidence',
        status: out.status,
        hit: out.status === 'ok' ? strength > 0 : null,
        value: out.value ?? null,
        weight: null,
        points: null,
        strength,
        group: typeof w?.group === 'string' ? w.group : group,
        provisional: false,
        cost,
        label,
        reason: out.reason,
        evidence: out.evidence ?? [],
      };
    },
  };
  return Object.freeze(def);
}

/** The confidence items of §5.4, in table order. Within a group only the strongest counts (§6.4). */
export const CONFIDENCE_ITEMS = Object.freeze([
  item('k.owner', 'owner', 'costly', 0.3, 'Owner history',
    'Stronger when the owner contributed on GitHub in three years before 2024, '
    + 'or is an organisation at least two years old', kOwner),
  item('k.time', 'time', 'costly', 0.25, 'Time in development',
    'Stronger when pushes continue 30 days (0.10) or 180 days (0.25) after creation', kTime),
  item('k.pushDays', 'time', 'costly', 0.4, 'Pushed on many days',
    'Stronger with pushes on 5 days over a month (0.25) or 20 days over six months (0.40)', kPushDays),
  item('k.releases', 'releases', 'costly', 0.3, 'Releases across weeks',
    'Stronger with three releases spread over at least four weeks', kReleases),
  item('k.outsiders', 'people', 'costly', 0.45, 'Established outsiders',
    'Stronger with issues or pull requests from people whose accounts are over a year old (0.15 each)',
    kOutsiders),
  item('k.ciVerified', 'ci', 'effort', 0.15, 'CI verified',
    'Stronger when CI runs the tests and passes', kCiVerified),
]);

/**
 * Evaluate the confidence items of §5.4. `signals` supplies `p.testsRun` for `k.ciVerified`.
 * @param {Facts} facts
 * @param {Signal[] | null} [signals]
 * @param {EvalContext} [ctx] `{weights, now}`
 * @returns {Signal[]}
 */
export function evaluateConfidence(facts, signals = null, ctx = {}) {
  const c = { ...ctx, signals: signals ?? undefined };
  return CONFIDENCE_ITEMS.map((def) => def.evaluate(facts, c));
}

// ---------------------------------------------------------------------------------------------
// Descriptors (§5.6)
// ---------------------------------------------------------------------------------------------

/** Labels of the §5.6 descriptors. */
export const DESCRIPTOR_LABELS = Object.freeze({
  'd.agent': 'Agent-assisted',
  'd.squashed': 'Squashed history',
  'd.script': 'Non-Latin README',
  'd.demo': 'Has a demo',
  'd.imported': 'Imported history',
  'd.sprawl': 'Sprawling',
  'd.funding': 'Accepts sponsorship',
});

/**
 * Neutral descriptors of §5.6, in table order. They never change points or confidence.
 * @param {Facts} facts
 * @returns {Descriptor[]}
 */
export function describe(facts) {
  const f = facts;
  /** @type {Descriptor[]} */
  const out = [];
  /**
   * @param {keyof typeof DESCRIPTOR_LABELS} id
   * @param {string | null} detail
   */
  const add = (id, detail) => out.push({ id, label: DESCRIPTOR_LABELS[id], detail });

  /** @type {string[]} */
  const marks = [];
  for (const e of f.root ?? []) {
    if (agentMarks.includes(rootKey(e))) marks.push(`${e.name}${e.type === 'tree' ? '/' : ''}`);
  }
  /** @param {string} n */
  const has = (n) => marks.some((m) => m.toLowerCase() === n.toLowerCase());
  if ((f.agentsMdBytes ?? 0) > 0 && !has('AGENTS.md')) marks.push('AGENTS.md');
  if ((f.claudeMdBytes ?? 0) > 0 && !has('CLAUDE.md')) marks.push('CLAUDE.md');
  if (f.tree?.entries?.some((e) => String(e[0]).toLowerCase() === '.github/copilot-instructions.md')) {
    marks.push('.github/copilot-instructions.md');
  }
  if (marks.length) add('d.agent', marks.join(', '));

  const total = f.commits?.total;
  if (typeof total === 'number' && total <= 3) add('d.squashed', plural(total, 'commit'));

  if (typeof f.readme?.text === 'string') {
    const script = detectScript(f.readme.text);
    if (script !== 'latin') add('d.script', SCRIPT_LABELS[script]);
  }

  if (f.homepageUrl) add('d.demo', f.homepageUrl);

  const dated = (f.commits?.recent ?? []).filter((c) => typeof c.at === 'string');
  const oldest = dated[dated.length - 1];
  if (oldest?.at && f.createdAt && daysBetween(oldest.at, f.createdAt) > 30) {
    add('d.imported', `Commits from ${dayText(oldest.at)}; created ${dayText(f.createdAt)}`);
  }

  if (typeof total === 'number' && total >= 200 && (f.tree?.count ?? 0) >= 2000) {
    add('d.sprawl', `${plural(total, 'commit')}, ${plural(f.tree?.count ?? 0, 'file')}`);
  }

  const funding = f.funding ?? [];
  if (funding.length || f.ownerInfo?.sponsorsListing === true) {
    const where = [...new Set(funding.map((x) => x.platform).filter(Boolean))];
    if (f.ownerInfo?.sponsorsListing === true && !where.includes('GITHUB')) where.push('GitHub Sponsors');
    add('d.funding', where.join(', ') || null);
  }
  return out;
}
