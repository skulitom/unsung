// @ts-check
/**
 * A line-based reader for GitHub Actions workflow YAML (DESIGN §5.2, §5.3 `p.testsRun`). It finds
 * the `run:` commands of each job's steps, inline or as `|`/`>` block scalars, and whether a step or
 * its job sets `continue-on-error: true`. It is not a YAML parser: it follows indentation, which is
 * enough for the workflows GitHub accepts, and ignores what it does not understand.
 */

/**
 * @typedef {object} WorkflowStep
 * @property {string | null} job job id
 * @property {string | null} name step name
 * @property {string} run the command text
 * @property {boolean} continueOnError set on the step or its job
 * @property {string | null} workingDirectory the step's `working-directory`, if any
 */

const KV = /^("[^"]*"|'[^']*'|[^\s:'"][^:]*?)\s*:(?:[ \t]+(.*))?$/;
const BLOCK_SCALAR = /^[|>][-+0-9]*$/;

/**
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Drop a trailing YAML comment (a `#` after whitespace, outside quotes).
 * @param {string} s
 * @returns {string}
 */
function stripComment(s) {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

/**
 * @param {string | undefined} v
 * @returns {string}
 */
function unquote(v) {
  const s = String(v ?? '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\(["\\/])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/**
 * @param {string | undefined} v
 * @returns {boolean}
 */
function isTrue(v) {
  return /^(true|True|TRUE)$/.test(unquote(v));
}

/**
 * Collect the lines of a block or multi-line plain scalar that are more indented than its key.
 * @param {string[]} lines
 * @param {number} from index of the first candidate line
 * @param {number} keyIndent
 * @returns {{body: string[], next: number}} `next` is the index of the first line not taken
 */
function collectDeeper(lines, from, keyIndent) {
  const body = [];
  let j = from;
  for (; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() && indentOf(l) <= keyIndent) break;
    body.push(l);
  }
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return { body, next: from + body.length };
}

/**
 * Every step with a `run:` command, in file order (§12.4). Steps are found under `jobs.<id>.steps`;
 * `continue-on-error: true` on a step or on its job marks the step.
 * @param {string | null | undefined} yaml
 * @returns {WorkflowStep[]}
 */
export function runSteps(yaml) {
  const lines = String(yaml ?? '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {(WorkflowStep & {keyIndent: number, run: string | null})[]} */
  const steps = [];
  /** @type {Set<string | null>} */
  const continuingJobs = new Set();
  let topIndent = -1;
  let inJobs = false;
  let jobIndent = -1;
  /** @type {string | null} */
  let job = null;
  let jobPropIndent = -1;
  let stepsIndent = -1;
  let dashIndent = -1;
  /** @type {(WorkflowStep & {keyIndent: number, run: string | null}) | null} */
  let step = null;

  /**
   * Apply one `key: value` line of the current step; returns the index of the last line consumed.
   * @param {string} content
   * @param {number} keyIndent
   * @param {number} i
   * @returns {number}
   */
  const stepKey = (content, keyIndent, i) => {
    if (!step) return i;
    const kv = KV.exec(stripComment(content));
    if (!kv) return i;
    const key = unquote(kv[1]);
    const value = kv[2] ?? '';
    if (key === 'run') {
      const v = value.trim();
      if (BLOCK_SCALAR.test(stripComment(v))) {
        const { body, next } = collectDeeper(lines, i + 1, keyIndent);
        const nonBlank = body.filter((l) => l.trim());
        const cut = nonBlank.length ? Math.min(...nonBlank.map(indentOf)) : 0;
        const text = body.map((l) => l.slice(Math.min(cut, indentOf(l))));
        step.run = v.startsWith('>') ? text.map((l) => l.trim()).join(' ').trim() : text.join('\n');
        return next - 1;
      }
      const { body, next } = collectDeeper(lines, i + 1, keyIndent);
      const rest = body.map((l) => l.trim()).filter(Boolean);
      step.run = [unquote(stripComment(v)), ...rest].filter(Boolean).join(' ');
      return next - 1;
    }
    if (key === 'name') step.name = unquote(stripComment(value));
    else if (key === 'continue-on-error') step.continueOnError = isTrue(stripComment(value));
    else if (key === 'working-directory') step.workingDirectory = unquote(stripComment(value)) || null;
    return i;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = indentOf(raw);
    const content = raw.slice(indent);
    if (topIndent < 0) topIndent = indent;
    if (indent <= topIndent) {
      inJobs = /^jobs\s*:\s*$/.test(stripComment(content));
      job = null;
      jobIndent = -1;
      stepsIndent = -1;
      step = null;
      continue;
    }
    if (!inJobs) continue;
    if (jobIndent < 0) jobIndent = indent;
    if (indent <= jobIndent) {
      const kv = KV.exec(stripComment(content));
      job = kv ? unquote(kv[1]) : null;
      jobPropIndent = -1;
      stepsIndent = -1;
      dashIndent = -1;
      step = null;
      continue;
    }
    if (job === null) continue;
    if (jobPropIndent < 0) jobPropIndent = indent;
    const isDash = /^-(\s|$)/.test(content);
    if (indent <= jobPropIndent && !(isDash && stepsIndent >= 0 && indent === stepsIndent)) {
      step = null;
      stepsIndent = -1;
      dashIndent = -1;
      const kv = KV.exec(stripComment(content));
      if (!kv) continue;
      const key = unquote(kv[1]);
      if (key === 'steps' && !(kv[2] ?? '').trim()) stepsIndent = indent;
      else if (key === 'continue-on-error' && isTrue(stripComment(kv[2] ?? ''))) continuingJobs.add(job);
      continue;
    }
    if (stepsIndent < 0) continue;
    if (isDash) {
      if (dashIndent < 0) dashIndent = indent;
      if (indent !== dashIndent) continue;
      const rest = content.replace(/^-\s*/, '');
      const keyIndent = indent + (content.length - rest.length);
      step = { job, name: null, run: null, continueOnError: false, workingDirectory: null, keyIndent };
      steps.push(step);
      if (rest) i = stepKey(rest, keyIndent, i);
      continue;
    }
    if (step && indent === step.keyIndent) i = stepKey(content, indent, i);
  }
  return steps
    .filter((s) => typeof s.run === 'string' && s.run.trim() !== '')
    .map((s) => ({
      job: s.job, name: s.name, run: /** @type {string} */ (s.run),
      continueOnError: s.continueOnError || continuingJobs.has(s.job), workingDirectory: s.workingDirectory,
    }));
}

/**
 * npm's placeholder test script, `echo "Error: no test specified" && exit 1` (§5.2).
 * @param {unknown} script
 * @returns {boolean}
 */
export function isNpmDefaultTest(script) {
  if (typeof script !== 'string') return false;
  const s = script.replace(/\s+/g, ' ').trim().toLowerCase();
  return /^echo \\?["']?error: no test specified\\?["']? ?&& ?exit 1$/.test(s);
}

/**
 * A test script that only prints or succeeds (`echo ok`, `true`, `exit 0`, or nothing).
 * @param {unknown} script
 * @returns {boolean}
 */
export function isTrivialTestScript(script) {
  if (typeof script !== 'string') return false;
  return script.split(/&&|\|\||;/).map((s) => s.trim())
    .every((s) => !s || /^(echo|printf)\b/.test(s) || /^(true|:|exit 0)$/.test(s));
}

const PM_TEST = /^(npm|pnpm|yarn|bun)( run)? test\b/;
const NEUTRALISED_CHAIN = /\|\|\s*(true|exit\s+0)\b/;
const NEUTRALISED_NEXT = /^\s*;\s*true\b/;

/**
 * Split a shell line into command segments, each with the text that follows it on the line.
 * @param {string} line
 * @returns {{seg: string, after: string}[]}
 */
function segments(line) {
  const parts = line.split(/(\|\||&&|;|\|)/);
  /** @type {{seg: string, after: string}[]} */
  const out = [];
  for (let k = 0; k < parts.length; k += 2) out.push({ seg: parts[k], after: parts.slice(k + 1).join('') });
  return out;
}

/**
 * The first step whose command runs a test (§5.2, §5.3 `p.testsRun`). A match is **neutralised** when
 * the step or its job sets `continue-on-error: true`, or the command is followed by `|| true` or
 * `|| exit 0` in the same chain, or directly by `; true`. Commands inside `echo`/`printf` and shell
 * comments are not commands. A package-manager `test` whose `package.json` test script is npm's
 * placeholder or trivial (`opts.testScript`) is not a test command, unless the step runs in another
 * `working-directory`. A non-neutralised match wins over a neutralised one.
 * @param {readonly WorkflowStep[]} steps
 * @param {readonly RegExp[]} regexes
 * @param {{testScript?: string | null}} [opts]
 * @returns {{step: WorkflowStep, neutralised: boolean, command: string} | null}
 */
export function findTestStep(steps, regexes, opts = {}) {
  const fakeScript = typeof opts.testScript === 'string'
    && (isNpmDefaultTest(opts.testScript) || isTrivialTestScript(opts.testScript));
  /** @type {{step: WorkflowStep, neutralised: boolean, command: string} | null} */
  let neutralisedHit = null;
  for (const step of steps ?? []) {
    const text = String(step.run ?? '').replace(/\\\n\s*/g, ' ');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      for (const { seg, after } of segments(line)) {
        const cmd = seg.trim();
        if (!cmd || /^(echo|printf|#|:)(\s|$)/.test(cmd)) continue;
        const re = regexes.find((r) => r.test(cmd));
        if (!re) continue;
        const pm = PM_TEST.exec(cmd.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*/, ''));
        if (pm && fakeScript && !step.workingDirectory) continue;
        const chain = after.split(';')[0];
        const neutralised = step.continueOnError || NEUTRALISED_CHAIN.test(chain)
          || NEUTRALISED_NEXT.test(after);
        const hit = { step, neutralised, command: line.length > 200 ? line.slice(0, 200) : line };
        if (!neutralised) return hit;
        neutralisedHit ??= hit;
      }
    }
  }
  return neutralisedHit;
}
