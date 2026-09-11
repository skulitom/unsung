// @ts-check
/**
 * The support ladder (DESIGN §11.5): ways a reader can help a repository they like, in order, each
 * only when it applies. Unsung never takes these actions itself; it only shows them.
 *
 * "Try it" shows a command only when the README contains it (in a code block or code span) and its
 * target checks out against the repository's own files: the package that `package.json` names, the
 * crate that `Cargo.toml` names, the project that `pyproject.toml` names, a Go module path inside
 * this repository, or an npm script that exists. The command shown is rebuilt from the checked
 * parts, never copied from the README, so nothing else a README line carries can ride along.
 *
 * This module is pure: no I/O, no clock.
 */

import { cleanText, safeUrl } from './html.mjs';

/** @typedef {import('../core/schema.mjs').Facts} Facts */
/** @typedef {import('../core/schema.mjs').RepoRecord} RepoRecord */

/**
 * One rung of the ladder.
 * @typedef {object} Rung
 * @property {'try' | 'demo' | 'star' | 'releases' | 'feedback' | 'share' | 'sponsor'} kind
 * @property {string} label
 * @property {string} [url]
 * @property {string} [command] the command to run (`try`)
 * @property {string} [basis] why the command can be trusted (`try`)
 * @property {string} [note] a short etiquette note (`feedback`)
 * @property {boolean} [ugc] the URL came from repository content (`demo`, some `sponsor` links)
 */

/** @typedef {{command: string, basis: string}} InstallCommand */

/** GitHub logins and repository names (`owner/name`). */
const NWO = /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/;

const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const CRATE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PY_SPEC = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[\w,.-]+\])?((?:[=!~<>]=|[<>])[\w.*+!-]+)?$/;
const GO_PATH = /^[A-Za-z0-9._~/-]+$/;
const GO_VERSION = /^(latest|v\d[0-9A-Za-z.+-]*)$/;
const SCRIPT_NAME = /^[A-Za-z0-9:_][A-Za-z0-9:._-]*$/;

/** npm scripts that maintain the project rather than run it; never offered as "Try it". */
const HOUSEKEEPING = /^(test|lint|format|fmt|typecheck|check|clean|pre|post|publish|release|version)/i;

/** How many README command lines are examined at most. */
const MAX_COMMANDS = 400;

export const FEEDBACK_NOTE = 'Try it first, then say what you tried, what worked and what did not. '
  + 'Be specific and kind: the maintainer owes you nothing.';

/**
 * @param {unknown} record
 * @returns {Partial<Facts> & Record<string, any>}
 */
function factsOf(record) {
  const r = /** @type {any} */ (record);
  if (r && typeof r === 'object' && r.facts && typeof r.facts === 'object') return r.facts;
  return r && typeof r === 'object' ? r : {};
}

/**
 * `https://github.com/<owner>/<name>[/<segment>…]`, or null when `nwo` is not a valid `owner/name`.
 * @param {unknown} nwo
 * @param {...string} segments
 * @returns {string | null}
 */
export function repoUrl(nwo, ...segments) {
  if (typeof nwo !== 'string') return null;
  const m = NWO.exec(nwo.trim());
  if (!m || m[2] === '.' || m[2] === '..') return null;
  const tail = segments.map((s) => `/${encodeURIComponent(s)}`).join('');
  return `https://github.com/${m[1]}/${m[2]}${tail}`;
}

/**
 * Lines of code from a README: the lines inside fenced blocks and the contents of inline code
 * spans, in document order (§5.3.1 reads references from the same places).
 * @param {unknown} text
 * @returns {string[]}
 */
export function readmeCommands(text) {
  /** @type {string[]} */
  const out = [];
  /** @type {string | null} */
  let fence = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (out.length >= MAX_COMMANDS) break;
    if (fence === null) {
      const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (open) {
        fence = open[1];
        continue;
      }
      for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1]);
      continue;
    }
    const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (close && close[1][0] === fence[0] && close[1].length >= fence.length) {
      fence = null;
      continue;
    }
    out.push(line);
  }
  return out.slice(0, MAX_COMMANDS);
}

/**
 * Split one README code line into simple commands: drop a trailing `# comment`, a shell prompt and
 * `sudo`, and break chains on `&&`, `||` and `;`.
 * @param {string} line
 * @returns {string[]}
 */
function segments(line) {
  const s = line.replace(/\s+#.*$/, '').trim();
  if (s === '' || s.startsWith('#') || s.startsWith('//')) return [];
  const unprompted = s.replace(/^(?:\$|%|>|PS>)\s+/, '');
  return unprompted.split(/\s*(?:&&|\|\||;)\s*/)
    .map((x) => x.replace(/^sudo\s+/, '').trim())
    .filter((x) => x !== '');
}

/**
 * The value of `name` in the first of `sections` of a small TOML file, or null.
 * @param {unknown} text
 * @param {string[]} sections
 * @returns {string | null}
 */
function tomlName(text, sections) {
  if (typeof text !== 'string') return null;
  /** @type {string | null} */
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[\s*([^\]\s]+)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    if (section === null || !sections.includes(section)) continue;
    const m = /^name\s*=\s*(?:"([^"]+)"|'([^']+)')/.exec(line);
    if (m) return m[1] ?? m[2] ?? null;
  }
  return null;
}

/**
 * The manifest text when `facts.manifest` is the named root file.
 * @param {Record<string, any>} facts
 * @param {string} file
 * @returns {string | null}
 */
function manifestText(facts, file) {
  const m = facts.manifest;
  if (!m || typeof m !== 'object' || typeof m.path !== 'string' || typeof m.text !== 'string') return null;
  return m.path.toLowerCase() === file.toLowerCase() ? m.text : null;
}

/**
 * @param {string} name
 * @returns {string}
 */
function pep503(name) {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

/**
 * @param {string} name
 * @returns {string}
 */
function crateKey(name) {
  return name.toLowerCase().replace(/_/g, '-');
}

/**
 * @param {Record<string, any>} facts
 * @returns {Set<string>}
 */
function scriptNames(facts) {
  const pj = facts.packageJson;
  /** @type {Set<string>} */
  const names = new Set();
  if (!pj || typeof pj !== 'object') return names;
  const s = pj.scripts;
  if (Array.isArray(s)) for (const n of s) if (typeof n === 'string') names.add(n);
  if (s && typeof s === 'object' && !Array.isArray(s)) for (const n of Object.keys(s)) names.add(n);
  return names;
}

/**
 * @param {string} seg
 * @param {Record<string, any>} facts
 * @returns {InstallCommand | null}
 */
function npmInstall(seg, facts) {
  const m = /^npm\s+(?:i|install|add)\s+(.+)$/.exec(seg);
  if (!m) return null;
  let global = false;
  /** @type {string[]} */
  const specs = [];
  for (const t of m[1].split(/\s+/)) {
    if (t === '-g' || t === '--global') global = true;
    else if (t.startsWith('-')) return null;
    else specs.push(t);
  }
  if (specs.length !== 1) return null;
  const spec = specs[0];
  const at = spec.lastIndexOf('@');
  const name = at > 0 ? spec.slice(0, at) : spec;
  const own = facts.packageJson?.name;
  if (typeof own !== 'string' || name !== own || !NPM_NAME.test(name)) return null;
  return {
    command: `npm install ${global ? '-g ' : ''}${name}`,
    basis: 'The README installs the package that package.json names.',
  };
}

/**
 * @param {string} seg
 * @param {Record<string, any>} facts
 * @returns {InstallCommand | null}
 */
function cargoInstall(seg, facts) {
  const m = /^cargo\s+install\s+(.+)$/.exec(seg);
  if (!m) return null;
  let locked = false;
  /** @type {string[]} */
  const names = [];
  for (const t of m[1].split(/\s+/)) {
    if (t === '--locked') locked = true;
    else if (t.startsWith('-')) return null;
    else names.push(t);
  }
  if (names.length !== 1 || !CRATE_NAME.test(names[0])) return null;
  const own = tomlName(manifestText(facts, 'Cargo.toml'), ['package']);
  if (!own || crateKey(own) !== crateKey(names[0])) return null;
  return {
    command: `cargo install ${names[0]}${locked ? ' --locked' : ''}`,
    basis: 'The README installs the crate that Cargo.toml names.',
  };
}

/**
 * @param {string} seg
 * @param {Record<string, any>} facts
 * @returns {InstallCommand | null}
 */
function pipInstall(seg, facts) {
  const m = /^(pipx|pip3?|python3?\s+-m\s+pip|py\s+-m\s+pip)\s+install\s+(.+)$/.exec(seg);
  if (!m) return null;
  const tool = m[1] === 'pipx' ? 'pipx' : 'pip';
  /** @type {string[]} */
  const specs = [];
  for (const t of m[2].split(/\s+/)) {
    if (t === '-U' || t === '--upgrade' || t === '--user') continue;
    if (t.startsWith('-')) return null;
    specs.push(t.replace(/^["']|["']$/g, ''));
  }
  if (specs.length !== 1) return null;
  const spec = PY_SPEC.exec(specs[0]);
  if (!spec) return null;
  const own = tomlName(manifestText(facts, 'pyproject.toml'), ['project', 'tool.poetry']);
  if (!own || pep503(own) !== pep503(spec[1])) return null;
  return {
    command: `${tool} install ${spec[1]}`,
    basis: 'The README installs the project that pyproject.toml names.',
  };
}

/**
 * @param {string} seg
 * @param {Record<string, any>} facts
 * @param {string} nwo
 * @returns {InstallCommand | null}
 */
function goInstall(seg, facts, nwo) {
  const m = /^go\s+install\s+(\S+)$/.exec(seg);
  if (!m) return null;
  const at = m[1].lastIndexOf('@');
  if (at <= 0) return null;
  const modPath = m[1].slice(0, at);
  const version = m[1].slice(at + 1);
  if (!GO_PATH.test(modPath) || !GO_VERSION.test(version) || modPath.includes('..')) return null;
  const home = `github.com/${nwo}`.toLowerCase();
  /** @type {(p: string, root: string) => boolean} */
  const inside = (p, root) => p === root || p.startsWith(`${root}/`);
  const path = modPath.toLowerCase();
  if (!inside(path, home)) return null;
  const goMod = manifestText(facts, 'go.mod');
  const declared = goMod ? /^\s*module\s+(\S+)/m.exec(goMod)?.[1] : null;
  if (declared && !inside(path, declared.toLowerCase())) return null;
  return {
    command: `go install ${modPath}@${version}`,
    basis: 'The module path is inside this repository.',
  };
}

/**
 * @param {string} seg
 * @param {Record<string, any>} facts
 * @returns {InstallCommand | null}
 */
function npmRun(seg, facts) {
  const m = /^npm\s+(?:run(?:-script)?\s+(\S+)|(start))(?:\s|$)/.exec(seg);
  if (!m) return null;
  const name = m[1] ?? 'start';
  if (!SCRIPT_NAME.test(name) || HOUSEKEEPING.test(name)) return null;
  if (!scriptNames(facts).has(name)) return null;
  return {
    command: name === 'start' && m[2] ? 'npm start' : `npm run ${name}`,
    basis: 'package.json defines this script.',
  };
}

/**
 * The first README install or run command whose target checks out (§11.5), rebuilt from its
 * checked parts, or null.
 * @param {RepoRecord | Partial<Facts> | null | undefined} record a RepoRecord or its Facts
 * @param {{nwo?: string}} [opts] `nwo` overrides the stored name (after a rename)
 * @returns {InstallCommand | null}
 */
export function installCommand(record, { nwo } = {}) {
  const facts = factsOf(record);
  const name = nwo ?? facts.nwo ?? /** @type {any} */ (record)?.nwo;
  const text = facts.readme && typeof facts.readme === 'object' ? facts.readme.text : null;
  if (typeof text !== 'string' || typeof name !== 'string' || !repoUrl(name)) return null;
  for (const line of readmeCommands(text)) {
    for (const seg of segments(line)) {
      const hit = npmInstall(seg, facts) ?? cargoInstall(seg, facts) ?? pipInstall(seg, facts)
        ?? goInstall(seg, facts, name) ?? npmRun(seg, facts);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * @param {Record<string, any>} facts
 * @param {string} owner
 * @returns {Rung | null}
 */
function sponsorRung(facts, owner) {
  const links = Array.isArray(facts.funding) ? facts.funding : [];
  const github = links.find((l) => String(l?.platform ?? '').toUpperCase() === 'GITHUB' && safeUrl(l?.url));
  const any = github ?? links.find((l) => safeUrl(l?.url));
  if (any) {
    const url = /** @type {string} */ (safeUrl(any.url));
    const onGithub = new URL(url).hostname === 'github.com';
    return { kind: 'sponsor', label: 'Sponsor the maintainer', url, ugc: !onGithub };
  }
  if (facts.ownerInfo?.sponsorsListing === true) {
    return { kind: 'sponsor', label: 'Sponsor the maintainer', url: `https://github.com/sponsors/${owner}` };
  }
  return null;
}

/**
 * The support ladder for a repository (§11.5), in order, each rung only when it applies:
 * try it (and the demo link), star it yourself, follow releases, give feedback after trying it,
 * share, sponsor. `pageUrl` (the gem page) enables the share rung.
 * @param {RepoRecord | Partial<Facts> | null | undefined} record a RepoRecord or its Facts
 * @param {{nwo?: string, pageUrl?: string | null}} [opts] `nwo` overrides the stored name
 * @returns {Rung[]}
 */
export function supportLadder(record, { nwo, pageUrl = null } = {}) {
  const facts = factsOf(record);
  const name = nwo ?? facts.nwo ?? /** @type {any} */ (record)?.nwo;
  const base = repoUrl(name);
  if (!base || typeof name !== 'string') return [];
  const owner = name.split('/')[0];
  /** @type {Rung[]} */
  const rungs = [];

  const tryIt = installCommand(record, { nwo: name });
  if (tryIt) rungs.push({ kind: 'try', label: 'Try it', command: tryIt.command, basis: tryIt.basis });
  const demo = safeUrl(facts.homepageUrl);
  if (demo) rungs.push({ kind: 'demo', label: 'Open the demo', url: demo, ugc: true });

  rungs.push({ kind: 'star', label: 'Star it yourself', url: base });

  const releases = Number(facts.releases?.count ?? 0);
  const tags = Number(facts.tags ?? 0);
  if (releases > 0 || tags > 0) {
    rungs.push({ kind: 'releases', label: 'Follow releases', url: `${base}/releases.atom` });
  }

  const where = facts.hasDiscussions === true ? 'discussions' : facts.hasIssues === true ? 'issues' : null;
  if (where) {
    const label = 'Give feedback after trying it';
    rungs.push({ kind: 'feedback', label, url: `${base}/${where}`, note: FEEDBACK_NOTE });
  }

  if (typeof pageUrl === 'string' && pageUrl !== '') {
    rungs.push({ kind: 'share', label: 'Share this page', url: cleanText(pageUrl, { singleLine: true }) });
  }

  const sponsor = sponsorRung(facts, owner);
  if (sponsor) rungs.push(sponsor);
  return rungs;
}
