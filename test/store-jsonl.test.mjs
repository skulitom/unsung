// @ts-check
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  appendJsonl, appendJsonlSync, readJson, readJsonSync, readJsonl, readJsonlSync, toJsonl, writeJsonAtomic,
  writeJsonAtomicSync, writeJsonGzAtomicSync, writeJsonlAtomic,
} from '../src/store/jsonl.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unsung-jsonl-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
/** @param {string} name */
const file = (name) => path.join(root, `${n++}`, name);

/**
 * @param {AsyncIterable<any>} gen
 * @returns {Promise<any[]>}
 */
async function collect(gen) {
  const out = [];
  for await (const x of gen) out.push(x);
  return out;
}

test('appendJsonl creates directories and writes one record per line', async () => {
  const f = file('a/b/c.jsonl');
  assert.equal(await appendJsonl(f, [{ a: 1 }, { b: 2 }]), 2);
  assert.equal(await appendJsonl(f, { c: 3 }), 1);
  assert.equal(await appendJsonl(f, []), 0);
  assert.equal(fs.readFileSync(f, 'utf8'), '{"a":1}\n{"b":2}\n{"c":3}\n');
  assert.deepEqual(await collect(readJsonl(f)), [{ a: 1 }, { b: 2 }, { c: 3 }]);
});

test('a partial last line (a crash mid-write) is skipped and never glued to the next record', async () => {
  const f = file('partial.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"a":1}\n{"b":');
  appendJsonlSync(f, { c: 3 });
  /** @type {{line: string, no: number}[]} */
  const bad = [];
  const got = await collect(readJsonl(f, { onBadLine: (line, no) => bad.push({ line, no }) }));
  assert.deepEqual(got, [{ a: 1 }, { c: 3 }]);
  assert.deepEqual(bad, [{ line: '{"b":', no: 2 }]);
  assert.deepEqual(readJsonlSync(f), [{ a: 1 }, { c: 3 }]);
});

test('lines are split on \\n only: U+2028 and U+2029 inside records survive', async () => {
  const f = file('sep.jsonl');
  const text = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
  appendJsonlSync(f, [{ text }, { n: 2 }]);
  assert.deepEqual(await collect(readJsonl(f)), [{ text }, { n: 2 }]);
  assert.deepEqual(readJsonlSync(f), [{ text }, { n: 2 }]);
});

test('multi-byte characters split across stream chunks decode correctly', async () => {
  const f = file('big.jsonl');
  const records = Array.from({ length: 3000 }, (_, i) => ({ i, s: 'żółć 漢字 🎉'.repeat(5) }));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, toJsonl(records));
  const got = await collect(readJsonl(f));
  assert.equal(got.length, 3000);
  assert.deepEqual(got[2999], records[2999]);
});

test('gzipped JSON Lines are read by extension, streaming and whole', async () => {
  const f = file('p.jsonl.gz');
  await writeJsonlAtomic(f, [{ a: 1 }, { b: 2 }], { gzip: true });
  assert.ok(zlib.gunzipSync(fs.readFileSync(f)).toString().startsWith('{"a":1}'));
  assert.deepEqual(await collect(readJsonl(f)), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(readJsonlSync(f), [{ a: 1 }, { b: 2 }]);
});

test('a byte-order mark and blank lines are ignored; a missing file reads as empty', async () => {
  const f = file('bom.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${String.fromCharCode(0xfeff)}{"a":1}\n\n  \n{"b":2}`);
  assert.deepEqual(await collect(readJsonl(f)), [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(await collect(readJsonl(file('nope.jsonl'))), []);
  assert.deepEqual(readJsonlSync(file('nope.jsonl')), []);
});

test('writeJsonAtomic replaces the file and leaves no temporary files behind', async () => {
  const f = file('doc.json');
  await writeJsonAtomic(f, { v: 1 });
  writeJsonAtomicSync(f, { v: 2 }, { space: 2 });
  assert.deepEqual(await readJson(f, null), { v: 2 });
  assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "v": 2\n}\n');
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['doc.json']);
});

test('readJson returns the fallback for a missing file and refuses a corrupt one', async () => {
  assert.equal(await readJson(file('missing.json'), 'fallback'), 'fallback');
  const f = file('corrupt.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '{"a":');
  assert.throws(() => readJsonSync(f, null), (e) => /** @type {any} */ (e).code === 'EBADJSON');
  const gz = file('doc.json.gz');
  writeJsonGzAtomicSync(gz, { z: [1, 2] });
  assert.deepEqual(readJsonSync(gz, null), { z: [1, 2] });
});
