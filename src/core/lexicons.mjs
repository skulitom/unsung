// @ts-check
/**
 * Word lists and patterns read by the prefilter, the signals and the gates (DESIGN §3.4, §5.3,
 * §5.6, §7.2). Pure data. Patterns are case-insensitive unless their comment says otherwise, and none
 * carries the `g` flag, so `test()` is stateless. Names in root-entry lists are lower-case, and a
 * trailing `/` marks a directory.
 */

/** §7.2 `g.lure.name` and §3.4 rule 5: names and descriptions that advertise cracks and cheats. */
export const lureWords = Object.freeze([
  /\bcrack(ed)?\b/i, /\bkeygen\b/i, /\bactivator\b/i, /free download/i, /\bdrainer\b/i, /sniper bot/i,
  /\baimbot\b/i, /\bwallhack\b/i, /\bspoofer\b/i, /mod menu/i, /cheat (menu|loader)/i, /roblox executor/i,
]);

/** §7.2 `lexicons.fileHosts`: download hosts and link shorteners (a host matches itself and subdomains). */
export const fileHosts = Object.freeze([
  'mediafire.com', 'mega.nz', 'dropbox.com', 'cdn.discordapp.com', 't.me', 'gofile.io', 'pixeldrain.com',
  'bit.ly', 'tinyurl.com', 'is.gd', 'cutt.ly',
]);

/** §7.2 `lexicons.gamblingWords`, matched as whole words (a trailing plural `s` allowed). */
export const gamblingWords = Object.freeze([
  'slot', 'gacor', 'judi', 'togel', 'casino', 'maxwin', 'situs', 'bandar', 'jackpot', 'toto', 'poker',
]);

/** §7.2 `g.lure.drainer`: asking readers to send cryptocurrency, or to connect a wallet to claim. */
export const drainerPhrases = Object.freeze([
  /\bsend \d+(\.\d+)? ?(ETH|BNB|SOL|USDT)\b/i,
  /\bconnect your wallet\b[\s\S]{0,200}?\bclaim/i,
  /\bclaim\b[\s\S]{0,200}?\bconnect your wallet\b/i,
]);

/**
 * §7.2 `lexicons.aiAddress`: text addressed to an AI reviewer. Word boundaries are added at both ends
 * so that "as an Airflow connection" does not read as "as an AI".
 */
export const aiAddress = Object.freeze([
  /\bignore (all )?(previous|prior|above) instructions\b/i,
  /\b(rate|score|rank) this (repo|repository|project)\b/i,
  /\bas an? (AI|LLM|language model)\b/i,
  /\byou are (ChatGPT|Claude|an AI)\b/i,
]);

/**
 * §5.3 `lexicons.templateReadme`: untouched project-template READMEs (read in the first 4 KB), exactly
 * as §5.3 writes them. (create-next-app's README writes "[`create-next-app`]", which the first
 * pattern misses; allowing the backtick would add two non-genuine labelled repositories.)
 */
export const templateReadme = Object.freeze([
  /bootstrapped with \[?create-(next|react)-app/i,
  /This template provides a minimal setup/i,
  /Welcome to your Lovable project/i,
  /built with \[?Lovable/i,
  /Run and deploy your AI Studio app/i,
  /^# React \+ TypeScript \+ Vite/im,
  /Getting Started with Create React App/i,
]);

/** §5.3 `s.template`: root entries left behind by app-builder platforms. */
export const platformMarks = Object.freeze([
  '.replit', 'replit.md', '.bolt/', '.lovable/', 'attached_assets/',
]);

/** §3.4 rule 4: repository names that are personal configuration. */
export const personalNames = Object.freeze(['dotfiles', '.dotfiles', 'nvim', 'config', '.config', 'vimrc']);

/** §5.3 `s.webui`: headlines GitHub's web editor writes (case-sensitive, as GitHub writes them). */
export const webUiHeadline = /^(Add files via upload|Create \S+$|Update \S+\.\w+$|Delete \S+$|Rename \S+$)/;

/** §5.3 `s.junk`: root entries that should never be committed. */
export const junkRoot = Object.freeze([
  'node_modules/', 'venv/', '.venv/', '.env', '.ds_store', '__pycache__/',
]);

/** §7.2 `g.lure.link`: extensions of archives and executables that a lure links to. */
export const archiveExtensions = Object.freeze([
  '.zip', '.rar', '.7z', '.exe', '.msi', '.dmg', '.apk', '.scr', '.bat', '.cmd', '.ps1', '.vbs', '.jar',
]);

/**
 * §7.6, §10.8: extensions of archives, installers, packages and scripts, multi-part ones included. A
 * link with a path segment ending in one of them is never live in the explorer, the gallery or the
 * digest (`views.mjs#safeLinkUrl`). A superset of `archiveExtensions`.
 */
export const unsafeLinkExtensions = Object.freeze([
  '.7z', '.apk', '.appimage', '.appx', '.bat', '.bin', '.bz2', '.cmd', '.crx', '.deb', '.dll', '.dmg',
  '.exe', '.gz', '.ipa', '.iso', '.jar', '.msi', '.msix', '.pkg', '.ps1', '.rar', '.rpm', '.run', '.scr',
  '.sh', '.tar', '.tar.bz2', '.tar.gz', '.tar.xz', '.tar.zst', '.tgz', '.vbs', '.xpi', '.xz', '.zip',
  '.zst',
]);

// --- additive lists used by signals.mjs, gates.mjs and readme.mjs ------------------------------

/** §5.3 `q.ci`: CI configuration at the root other than GitHub Actions. */
export const ciRootFiles = Object.freeze([
  '.gitlab-ci.yml', '.travis.yml', 'azure-pipelines.yml', 'jenkinsfile', 'bitbucket-pipelines.yml',
  '.circleci/', '.woodpecker.yml',
]);

/** §5.3 `q.examples`: root directories that hold examples. */
export const examplesDirs = Object.freeze(['examples', 'example', 'demo', 'demos', 'samples', 'sample']);

/** §5.6 `d.agent`: files and directories that coding agents read. */
export const agentMarks = Object.freeze([
  'claude.md', 'agents.md', '.claude/', '.cursorrules', '.cursor/', '.github/copilot-instructions.md',
  '.windsurfrules',
]);

/** §7.2 `g.lure.link`: directories where an in-repository archive raises suspicion. */
export const lureDirs = Object.freeze(['test', 'tests', 'docs', 'assets', 'images', '.github']);

/** §7.2 `g.lure.link`: a password next to a download link. */
export const passwordHint = /\bpass(word)?\s*[:=]/i;

/** §7.2 `g.lure.script`: languages whose bulk suggests a script payload. */
export const scriptLanguages = Object.freeze(['Batchfile', 'PowerShell', 'VBScript', 'AutoHotkey', 'AutoIt']);

/** §7.2 `g.lure.script` (deep): script payloads and committed binaries. */
export const scriptPayloadExtensions = Object.freeze(['.bat', '.cmd', '.ps1', '.vbs']);
export const binaryExtensions = Object.freeze(['.exe', '.dll', '.scr']);

/**
 * §7.2 `g.injection`: zero-width, bidi-control and invisible tag characters, as inclusive code-point
 * ranges (U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+FEFF, the Unicode tag characters
 * U+E0000–U+E007F and the variation-selector supplement U+E0100–U+E01EF). Valid emoji tag sequences
 * (the flags of England, Scotland and Wales) are not counted in a run (`readme.mjs#invisibleRun`).
 */
export const invisibleRanges = Object.freeze([
  Object.freeze([0x200b, 0x200f]), Object.freeze([0x202a, 0x202e]), Object.freeze([0x2060, 0x2064]),
  Object.freeze([0xfeff, 0xfeff]), Object.freeze([0xe0000, 0xe007f]), Object.freeze([0xe0100, 0xe01ef]),
]);
