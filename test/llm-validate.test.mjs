// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { mulberry32 } from '../src/core/util.mjs';
import { validateVerdictOutput } from '../src/core/schema.mjs';
import { verdictEffect } from '../src/core/verdict.mjs';
import { buildPack } from '../src/llm/pack.mjs';
import {
  MIN_QUOTE_CHARS, ParseError, firstJsonObject, parseApiResponse, parseCliEnvelope, parseCliOutput,
  stripFence,
  validateVerdict,
} from '../src/llm/validate.mjs';
import { fixturePath, loadJsonFixture } from './support/fixtures.mjs';

const packFixture = loadJsonFixture('llm/pack-record.json');
const pack = buildPack(packFixture.record, packFixture.files, { rand: mulberry32(7) });

/** @returns {any[]} every output fixture under test/fixtures/llm/ */
function outputFixtures() {
  return readdirSync(fixturePath('llm')).filter((f) => f.endsWith('.json') && f !== 'pack-record.json').sort()
    .map((f) => loadJsonFixture(`llm/${f}`));
}

/**
 * A valid answer with the given claims.
 * @param {Record<string, any>} [over]
 * @returns {Record<string, any>}
 */
function answer(over = {}) {
  return {
    category: 'G', categoryConfidence: 0.8,
    scores: { purpose: 4, craft: 3, verification: 3, honesty: 3, originality: 3 },
    claims: [
      { text: 'Purpose', path: 'README.md', quote: 'Offline tide predictions for any port',
        supports: 'purpose' },
      { text: 'Tested', path: 'tests/predict.rs', quote: 'fn brest_high_water_is_near_six_metres()',
        supports: 'verification' },
    ],
    flags: [], pitch: 'Tides offline.', audience: 'Sailors', summary: 'Good.', injectionSeen: false, ...over,
  };
}

test('the fixtures cover every case §12.6 names', () => {
  const names = outputFixtures().map((f) => f.name);
  for (const want of ['cli-result', 'cli-fenced', 'cli-fenced-backticks', 'cli-structured', 'cli-budget-exhausted',
    'api-refusal', 'api-fallback', 'fabricated-quote', 'injection']) {
    assert.ok(names.includes(want), `missing fixture ${want}`);
  }
});

test('every LLM fixture parses, validates and takes effect as its expect says', () => {
  for (const fx of outputFixtures()) {
    if (fx.kind === 'cli' && fx.expect.status === 'error') {
      assert.throws(() => parseCliOutput(fx.stdout), ParseError, fx.name);
      continue;
    }
    const parsed = fx.kind === 'cli'
      ? { status: 'ok', output: parseCliOutput(fx.stdout) }
      : parseApiResponse(fx.message);
    if (fx.expect.status === 'refused' || fx.expect.status === 'error') {
      assert.equal(parsed.status, fx.expect.status, fx.name);
      if (fx.expect.category) assert.equal(parsed.refusal?.category, fx.expect.category, fx.name);
      assert.equal(parsed.output, undefined, `${fx.name}: no output is read from a ${fx.expect.status}`);
      continue;
    }
    assert.equal(parsed.status, 'ok', fx.name);
    const v = validateVerdict(parsed.output, pack);
    assert.equal(v.status, fx.expect.status, `${fx.name}: ${v.problems.join('; ')}`);
    assert.equal(v.kept, fx.expect.kept, `${fx.name} kept`);
    assert.equal(v.dropped, fx.expect.dropped, `${fx.name} dropped`);
    assert.deepEqual(validateVerdictOutput(v.output), [], fx.name);
    const effect = verdictEffect({ status: v.status, output: v.output });
    assert.equal(effect.points, fx.expect.points, `${fx.name} points`);
    assert.equal(effect.lane, fx.expect.lane, `${fx.name} lane`);
    if (fx.expect.servedBy) assert.equal(fx.message.model, fx.expect.servedBy);
  }
});

test('legacy: parseCliOutput still reads a structured_output field (printed only with --json-schema)', () => {
  const stdout = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: '{"category": "E"}',
    structured_output: { category: 'G' },
  });
  assert.deepEqual(parseCliOutput(stdout), { category: 'G' });
});

test('backticks inside the answer never end its code fence (llm-2)', () => {
  const quote = '```sh\ncargo install tidewatch\ntidewatch predict --port brest --days 3\n```';
  const obj = answer({
    summary: 'Uses ``` fences',
    claims: [{ ...answer().claims[0], quote }, answer().claims[1]],
  });
  const fencedCompact = `\`\`\`json\n${JSON.stringify(obj)}\n\`\`\``;
  const fencedPretty = `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
  const proseThenFence = `Here is my review.\n\n${fencedPretty}\nThat is all.`;
  const envelope = (/** @type {string} */ result) => JSON.stringify({ type: 'result', subtype: 'success',
    is_error: false, result });
  for (const text of [fencedCompact, fencedPretty, proseThenFence, JSON.stringify(obj), ` ${JSON.stringify(obj)}\n`]) {
    const out = parseCliOutput(envelope(text));
    assert.equal(out.category, 'G', text.slice(0, 40));
    assert.equal(out.summary, 'Uses ``` fences');
    assert.equal(out.claims[0].quote, quote);
  }
  assert.equal(stripFence(fencedCompact), JSON.stringify(obj), 'stripFence keeps the backticks inside strings');
  assert.equal(stripFence('```json\n{"ok": true}\n```'), '{"ok": true}');
  const api = parseApiResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: fencedCompact }] });
  assert.equal(api.output?.category, 'G');
});

test('a truncated answer is a ParseError, never one of its nested objects (llm-2)', () => {
  assert.throws(() => firstJsonObject('{"a": {"b": 1}'),
    (err) => err instanceof ParseError && /ends before its JSON object closes/.test(err.message));
  const cut = JSON.stringify(answer()).slice(0, -40);
  assert.throws(() => parseCliOutput(JSON.stringify({ type: 'result', result: `\`\`\`json\n${cut}` })), ParseError);
  assert.throws(() => parseCliOutput(JSON.stringify({ type: 'result', result: cut })), ParseError);
  assert.deepEqual(firstJsonObject('Note: { is odd.\n{"ok": 1}'), { ok: 1 }, 'a stray brace in prose');
  assert.deepEqual(firstJsonObject('[{"ok": 1}]'), { ok: 1 }, 'an answer wrapped in an array');
});

test('parseCliOutput reads the envelope measured on this machine (fenced .result)', () => {
  const stdout = JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: '```json\n{"ok": true}\n```',
    stop_reason: 'end_turn', total_cost_usd: 0.00201, num_turns: 1, api_error_status: null,
    permission_denials: [],
  });
  assert.deepEqual(parseCliOutput(stdout), { ok: true });
});

test('the first balanced object is found past prose and braces inside strings', () => {
  const text = 'Sure. {not json} then ```json\n{"a": "} {\\"", "b": {"c": [1, {"d": 2}]}}\n``` and {"x": 2}';
  assert.deepEqual(firstJsonObject(stripFence(text)), { a: '} {"', b: { c: [1, { d: 2 }] } });
  assert.deepEqual(firstJsonObject('prefix {bad} {"ok": 1} suffix'), { ok: 1 });
  assert.throws(() => firstJsonObject('no object here'), ParseError);
  const noJson = JSON.stringify({ type: 'result', result: 'I cannot help.' });
  assert.throws(() => parseCliOutput(noJson), ParseError);
});

test('parseCliEnvelope takes the last JSON line when warnings come first', () => {
  const stdout = 'warning: something\n{"type": "result", "subtype": "success", "result": "{}"}\n';
  assert.equal(parseCliEnvelope(stdout)?.type, 'result');
  assert.equal(parseCliEnvelope('   '), null);
});

test('parseApiResponse checks stop_reason before any content', () => {
  const text = { type: 'text', text: JSON.stringify(answer()) };
  const refusal = parseApiResponse({
    stop_reason: 'refusal', stop_details: { category: 'bio' }, content: [text],
  });
  assert.equal(refusal.status, 'refused');
  assert.equal(refusal.output, undefined);
  assert.equal(refusal.refusal?.category, 'bio');
  assert.equal(parseApiResponse({ stop_reason: 'refusal', stop_details: null }).refusal?.category, null);
  assert.equal(parseApiResponse({ stop_reason: 'max_tokens', content: [text] }).status, 'error');
  assert.equal(parseApiResponse({ stop_reason: 'pause_turn', content: [text] }).status, 'error');
  assert.equal(parseApiResponse({ stop_reason: 'end_turn', content: [] }).status, 'error');
  assert.equal(parseApiResponse(null).status, 'error');
});

test('parseApiResponse ignores thinking blocks and reads the text after a fallback block', () => {
  const good = JSON.stringify(answer());
  const r = parseApiResponse({
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '{"category": "X"}' },
      { type: 'text', text: '{"category": "E"}' },
      { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'text', text: good },
    ],
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.output?.category, 'G');
});

test('a fabricated quote is dropped; fewer than two surviving claims is unsupported', () => {
  const v = validateVerdict(answer({
    claims: [
      answer().claims[0],
      { text: 'Fake', path: 'tests/predict.rs', quote: 'fn property_based_tests_for_every_port()',
        supports: 'verification' },
    ],
  }), pack);
  assert.equal(v.status, 'unsupported');
  assert.equal(v.kept, 1);
  assert.equal(v.dropped, 1);
  assert.match(v.problems.join('\n'), /Claim 2 dropped: its quote is not in "tests\/predict\.rs"/);
  assert.equal(verdictEffect({ status: v.status, output: v.output }).points, 0);
});

test('quotes and file texts are compared whitespace-normalised', () => {
  const v = validateVerdict(answer({
    claims: [
      { text: 'a', path: 'src/main.rs', quote: 'fn main() {\n  let args =   Args::parse();',
        supports: 'craft' },
      { text: 'b', path: 'README.md', quote: 'Offline tide predictions\tfor any\r\nport',
        supports: 'purpose' },
    ],
  }), pack);
  assert.equal(v.status, 'ok', v.problems.join('; '));
});

test('a claim must cite a FILE block, not the tree or a missing file, with a real quote', () => {
  const v = validateVerdict(answer({
    claims: [
      { text: 'tree', path: 'src/harmonics.rs', quote: 'pub fn predict', supports: 'craft' },
      { text: 'empty', path: 'README.md', quote: '   ', supports: 'purpose' },
      { text: 'short', path: 'README.md', quote: 'tide', supports: 'purpose' },
      { text: 'ok', path: './README.md', quote: 'It does not model storm surge.', supports: 'honesty' },
    ],
  }), pack);
  assert.equal(v.kept, 1);
  assert.equal(v.dropped, 3);
  assert.equal(v.output?.claims[0].path, 'README.md');
  assert.match(v.problems.join('\n'), /not a file in the pack/);
  assert.match(v.problems.join('\n'), new RegExp(`shorter than ${MIN_QUOTE_CHARS} characters`));
});

test('kept claims carry the path as it is in the repository, not as the pack shows it', () => {
  const record = {
    nwo: 'octo-sailor/tool', facts: {
      owner: 'octo-sailor', name: 'tool', readme: null, root: [],
      tree: { truncated: false, count: 1, entries: [['cmd/octo-sailor/main.go', 'blob', 40]] },
    },
  };
  const files = {
    'cmd/octo-sailor/main.go': { byteSize: 40, text: 'package main\n\nfunc main() { serveForever() }\n' },
  };
  const p = buildPack(/** @type {any} */ (record), files, { rand: mulberry32(1) });
  assert.equal(p.files[0].path, 'cmd/OWNER/main.go');
  const quote = 'func main() { serveForever() }';
  const v = validateVerdict(answer({
    claims: [
      { text: 'a', path: 'cmd/OWNER/main.go', quote, supports: 'craft' },
      { text: 'b', path: 'cmd/octo-sailor/main.go', quote: 'package main', supports: 'craft' },
    ],
  }), p);
  assert.equal(v.kept, 2, v.problems.join('; '));
  assert.deepEqual(v.output?.claims.map((c) => c.path),
    ['cmd/octo-sailor/main.go', 'cmd/octo-sailor/main.go']);
});

test('the local bounds are enforced before the schema check', () => {
  const many = Array.from({ length: 15 }, () => answer().claims[0]);
  const v = validateVerdict(answer({
    pitch: 'p'.repeat(300), audience: 'a'.repeat(100), summary: 's'.repeat(500),
    scores: { purpose: 7, craft: 0, verification: 3, honesty: 3, originality: 3 }, categoryConfidence: 1.4,
    flags: ['tutorial_clone', 'tutorial_clone'],
    claims: many.map((c) => ({ ...c, text: 't'.repeat(300) })),
  }), pack);
  assert.equal(v.status, 'ok');
  const out = /** @type {any} */ (v.output);
  assert.equal(out.pitch.length, 140);
  assert.equal(out.audience.length, 80);
  assert.equal(out.summary.length, 400);
  assert.equal(out.scores.purpose, 4);
  assert.equal(out.scores.craft, 1);
  assert.equal(out.categoryConfidence, 1);
  assert.deepEqual(out.flags, ['tutorial_clone']);
  assert.equal(v.kept, 12);
  assert.equal(v.dropped, 3);
  assert.ok(out.claims.every((/** @type {any} */ c) => c.text.length === 240));
});

test('a quote longer than 200 characters is cut to its first 200 and still verifies', () => {
  const text = 'x'.repeat(250);
  const file = { path: 'a.txt', realPath: 'a.txt', role: 'source', text, bytes: 250, truncated: false };
  const p = { files: [file] };
  const v = validateVerdict(answer({
    claims: [
      { text: 'a', path: 'a.txt', quote: 'x'.repeat(260), supports: 'craft' },
      { text: 'b', path: 'a.txt', quote: 'x'.repeat(20), supports: 'craft' },
    ],
  }), p);
  assert.equal(v.status, 'ok');
  assert.equal(/** @type {any} */ (v.output).claims[0].quote.length, 200);
});

test('schema violations make the verdict an error', () => {
  const { pitch: _omit, ...missing } = answer();
  const badClaim = { text: 'a', path: 'README.md', quote: 'Offline tide predictions', supports: 'magic' };
  const bads = [missing, answer({ extra: 1 }), answer({ category: 'Q' }), answer({ injectionSeen: 'no' }),
    answer({ claims: [badClaim] }), answer({ scores: { purpose: 3 } }), 'not an object', null];
  for (const bad of bads) {
    const v = validateVerdict(bad, pack);
    assert.equal(v.status, 'error');
    assert.equal(v.output, null);
    assert.ok(v.problems.length > 0);
  }
});
