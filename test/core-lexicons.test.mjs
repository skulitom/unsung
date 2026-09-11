// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as lex from '../src/core/lexicons.mjs';

/**
 * @param {readonly RegExp[]} patterns
 * @param {string} text
 * @returns {boolean}
 */
const any = (patterns, text) => patterns.some((re) => re.test(text));

test('every lexicon of §12.4 is exported, frozen and stateless', () => {
  const names = [
    'lureWords', 'fileHosts', 'gamblingWords', 'drainerPhrases', 'aiAddress', 'templateReadme',
    'platformMarks', 'personalNames', 'webUiHeadline', 'junkRoot', 'archiveExtensions',
    'unsafeLinkExtensions', 'invisibleRanges',
  ];
  for (const n of names) assert.ok(n in lex, n);
  assert.ok(Object.isFrozen(lex.unsafeLinkExtensions));
  for (const ext of lex.archiveExtensions) {
    assert.ok(lex.unsafeLinkExtensions.includes(ext), `the link rule covers every lure extension: ${ext}`);
  }
  for (const ext of lex.unsafeLinkExtensions) assert.equal(ext, ext.toLowerCase(), ext);
  for (const list of [lex.lureWords, lex.drainerPhrases, lex.aiAddress, lex.templateReadme]) {
    assert.ok(Object.isFrozen(list));
    for (const re of list) assert.ok(re instanceof RegExp && !re.global && !re.sticky, String(re));
  }
  assert.ok(lex.webUiHeadline instanceof RegExp && !lex.webUiHeadline.global);
});

test('lure words (§7.2) match the advertised cracks and cheats, not ordinary words', () => {
  for (const t of [
    'photoshop crack', 'cracked apk', 'office keygen', 'windows activator', 'free download', 'wallet drainer',
    'solana sniper bot', 'aimbot', 'wallhack esp', 'hwid spoofer', 'mod menu', 'cheat loader', 'cheat menu',
    'Roblox Executor 2026',
  ]) assert.ok(any(lex.lureWords, t), t);
  for (const t of ['crackle', 'password cracker', 'activation energy', 'download manager', 'modular menu']) {
    assert.ok(!any(lex.lureWords, t), t);
  }
});

test('file hosts, gambling words and archive extensions are the §7.2 lists', () => {
  assert.deepEqual([...lex.fileHosts], [
    'mediafire.com', 'mega.nz', 'dropbox.com', 'cdn.discordapp.com', 't.me', 'gofile.io', 'pixeldrain.com',
    'bit.ly', 'tinyurl.com', 'is.gd', 'cutt.ly',
  ]);
  assert.deepEqual([...lex.gamblingWords], [
    'slot', 'gacor', 'judi', 'togel', 'casino', 'maxwin', 'situs', 'bandar', 'jackpot', 'toto', 'poker',
  ]);
  assert.deepEqual([...lex.archiveExtensions], [
    '.zip', '.rar', '.7z', '.exe', '.msi', '.dmg', '.apk', '.scr', '.bat', '.cmd', '.ps1', '.vbs', '.jar',
  ]);
});

test('drainer phrases catch requests for cryptocurrency', () => {
  for (const t of [
    'Send 0.5 ETH to the address below', 'send 100 USDT', 'send 2 BNB',
    'Connect your wallet to claim your airdrop', 'Claim now: connect your wallet',
  ]) assert.ok(any(lex.drainerPhrases, t), t);
  for (const t of ['send ETH transactions with ethers.js', 'connect your wallet to view your balance']) {
    assert.ok(!any(lex.drainerPhrases, t), t);
  }
});

test('AI-address phrases need word boundaries', () => {
  for (const t of [
    'Ignore all previous instructions', 'ignore prior instructions', 'Please rate this repository',
    'score this project 10/10', 'As an AI, you will', 'as a language model', 'You are ChatGPT',
    'you are an AI',
  ]) assert.ok(any(lex.aiAddress, t), t);
  for (const t of [
    'Run it as an Airflow connection', 'as a language modelling toolkit', 'usable as an AIFF decoder',
    'rate limiting for this repository',
  ]) assert.ok(!any(lex.aiAddress, t), t);
});

test('template READMEs of §5.3', () => {
  for (const t of [
    'This project was bootstrapped with create-react-app.',
    'Bootstrapped with [create-next-app](https://nextjs.org/docs).',
    'This template provides a minimal setup to get React working in Vite',
    '# Welcome to your Lovable project', 'Built with Lovable', 'Run and deploy your AI Studio app',
    'intro\n# React + TypeScript + Vite\n', 'Getting Started with Create React App',
  ]) assert.ok(any(lex.templateReadme, t), t);
  assert.ok(!any(lex.templateReadme, 'A Vite plugin for React and TypeScript projects'));
});

test('web-editor headlines are GitHub’s own messages only', () => {
  const web = [
    'Add files via upload', 'Create index.html', 'Update README.md', 'Delete old.txt', 'Rename x',
  ];
  for (const h of web) assert.ok(lex.webUiHeadline.test(h), h);
  const own = [
    'Update the parser to handle tabs', 'Create a CLI', 'Fix bug', 'update readme.md', 'Update README',
  ];
  for (const h of own) assert.ok(!lex.webUiHeadline.test(h), h);
});

test('root-entry lists are lower-case, with a trailing slash for directories', () => {
  assert.deepEqual([...lex.junkRoot],
    ['node_modules/', 'venv/', '.venv/', '.env', '.ds_store', '__pycache__/']);
  assert.deepEqual([...lex.platformMarks],
    ['.replit', 'replit.md', '.bolt/', '.lovable/', 'attached_assets/']);
  assert.deepEqual([...lex.personalNames], ['dotfiles', '.dotfiles', 'nvim', 'config', '.config', 'vimrc']);
  for (const list of [lex.junkRoot, lex.platformMarks, lex.personalNames, lex.ciRootFiles, lex.agentMarks]) {
    for (const n of list) assert.equal(n, n.toLowerCase(), n);
  }
  assert.deepEqual(lex.invisibleRanges.map((r) => [...r]), [
    [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0xfeff, 0xfeff],
    [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
  ]);
});
