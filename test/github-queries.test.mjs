// @ts-check
/**
 * The §3 GraphQL documents and the builders (DESIGN §12.2): the text equals DESIGN.md and the
 * builders reproduce the recorded fixture requests exactly (test/fixtures/github/, search/).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraphqlFixture, loadJsonFixture } from './support/fixtures.mjs';
import {
  BASE_QUERY, DEEP_FRAGMENT, ENRICH_FRAGMENT, EXISTS_QUERY, EXISTS_SELECTION, LEAN_FIELDS, LEAN_FRAGMENT,
  SEARCH_QUERY, aliasValues, aliasedRepoQuery, existsQuery, filesQuery, readmeRepairQuery, refOf,
} from '../src/github/queries.mjs';
import { assertReadOnly } from '../src/github/client.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** @returns {string[] | null} the ```graphql blocks of DESIGN.md */
function designBlocks() {
  const file = path.join(ROOT, 'DESIGN.md');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return [...text.matchAll(/```graphql\n([\s\S]*?)\n```/g)].map((m) => m[1]);
}

/**
 * `{o0, n0, o1, n1, …}` → refs.
 * @param {Record<string, any>} v
 */
function refsOf(v) {
  const out = [];
  for (let i = 0; `o${i}` in v; i++) out.push({ owner: v[`o${i}`], name: v[`n${i}`] });
  return out;
}

describe('the §3 documents', () => {
  const blocks = designBlocks();
  it('equal the DESIGN.md text', { skip: !blocks && 'DESIGN.md not present' }, () => {
    const [search, enrich, deep] = /** @type {string[]} */ (blocks);
    assert.equal(SEARCH_QUERY, search);
    assert.equal(ENRICH_FRAGMENT, enrich);
    assert.equal(DEEP_FRAGMENT, deep);
    const design = fs.readFileSync(path.join(ROOT, 'DESIGN.md'), 'utf8');
    assert.ok(design.includes(EXISTS_SELECTION), '§3.7 selection');
    assert.ok(design.includes(BASE_QUERY), '§3.2 base query');
  });

  it('the lean fields are the census node fields', () => {
    const collapse = (/** @type {string} */ s) => s.replace(/\s+/g, ' ').trim();
    assert.ok(collapse(SEARCH_QUERY).includes(collapse(LEAN_FIELDS)));
    assert.ok(LEAN_FRAGMENT.startsWith('fragment Lean on Repository {\n'));
  });

  it('every census page of the recorded windows used SEARCH_QUERY verbatim', () => {
    for (const name of ['normal-2026-09-08T0400.json', 'saturated-2026-09-08T14.json']) {
      const fx = loadJsonFixture(`search/${name}`);
      for (const p of fx.pages) assert.equal(p.request.query, SEARCH_QUERY, name);
    }
  });

  it('every document passes the read-only guard', () => {
    assertReadOnly(SEARCH_QUERY);
    assertReadOnly(EXISTS_QUERY);
    assertReadOnly(aliasedRepoQuery('Enrich', ENRICH_FRAGMENT, ['o/r']).doc);
    assertReadOnly(readmeRepairQuery([{ nwo: 'o/r', file: 'README.rst' }]).doc);
    assertReadOnly(filesQuery([{ nwo: 'o/r', paths: ['go.mod'] }]).doc);
  });
});

describe('builders reproduce the recorded requests', () => {
  it('enrich batch (11 seed gems)', () => {
    const fx = loadGraphqlFixture('enrich-batch');
    const built = aliasedRepoQuery('Enrich', ENRICH_FRAGMENT, refsOf(fx.request.variables));
    assert.equal(built.doc, fx.request.query);
    assert.deepEqual(built.variables, fx.request.variables);
  });

  it('deep batch of five', () => {
    const fx = loadGraphqlFixture('deep-batch');
    const built = aliasedRepoQuery('Deep', DEEP_FRAGMENT, refsOf(fx.request.variables));
    assert.equal(built.doc, fx.request.query);
    assert.deepEqual(built.variables, fx.request.variables);
  });

  it('archive lookup of 100 (lean fragment, owner/name strings accepted)', () => {
    const fx = loadGraphqlFixture('archive-lookup');
    const nwos = refsOf(fx.request.variables).map((r) => `${r.owner}/${r.name}`);
    const built = aliasedRepoQuery('Lean', LEAN_FRAGMENT, nwos);
    assert.equal(built.doc, fx.request.query);
    assert.deepEqual(built.variables, fx.request.variables);
  });

  it('README repair', () => {
    const fx = loadGraphqlFixture('readme-repair');
    const built = readmeRepairQuery([{ owner: 'gene-git', name: 'wg-client', file: 'README.rst' }]);
    assert.equal(built.doc, fx.request.query);
    assert.deepEqual(built.variables, fx.request.variables);
  });

  it('file fetches', () => {
    const fx = loadGraphqlFixture('files-batch');
    const v = fx.request.variables;
    const items = [];
    for (let i = 0; `o${i}` in v; i++) {
      const paths = [];
      for (let j = 0; `e${i}_${j}` in v; j++) paths.push(String(v[`e${i}_${j}`]).replace(/^HEAD:/, ''));
      items.push({ owner: v[`o${i}`], name: v[`n${i}`], paths });
    }
    const built = filesQuery(items);
    assert.equal(built.doc, fx.request.query);
    assert.deepEqual(built.variables, v);
  });

  it('re-check', () => {
    const fx = loadGraphqlFixture('exists');
    const built = existsQuery(fx.request.variables.ids);
    assert.equal(built.doc, fx.request.query);
    assert.deepEqual(built.variables, fx.request.variables);
  });
});

describe('builder safety', () => {
  it('never interpolates owner, name or paths into the document', () => {
    const evil = 'x") { viewer { login } } #';
    const a = aliasedRepoQuery('Enrich', ENRICH_FRAGMENT, [{ owner: 'o', name: evil }]);
    assert.ok(!a.doc.includes(evil));
    assert.equal(a.variables.n0, evil);
    const r = readmeRepairQuery([{ owner: 'o', name: 'r', file: 'README") { x }' }]);
    assert.ok(!r.doc.includes('README'));
    assert.equal(r.variables.e0, 'HEAD:README") { x }');
    const f = filesQuery([{ nwo: 'o/r', paths: ['.github/workflows/"ci".yml'] }]);
    assert.ok(!f.doc.includes('"ci"'));
  });

  it('rejects bad input', () => {
    assert.throws(() => aliasedRepoQuery('Enrich', ENRICH_FRAGMENT, []), RangeError);
    assert.throws(() => aliasedRepoQuery('En rich', ENRICH_FRAGMENT, ['o/r']), TypeError);
    assert.throws(() => aliasedRepoQuery('Deep', ENRICH_FRAGMENT, ['o/r']), TypeError);
    assert.throws(() => aliasedRepoQuery('Lean', LEAN_FRAGMENT, Array(101).fill('o/r')), RangeError);
    assert.throws(() => readmeRepairQuery(Array(21).fill({ nwo: 'o/r', file: 'README' })), RangeError);
    const newline = `bad${String.fromCharCode(10)}name`;
    assert.throws(() => readmeRepairQuery([{ nwo: 'o/r', file: newline }]), TypeError);
    assert.throws(() => filesQuery([{ nwo: 'o/r', paths: [] }]), RangeError);
    assert.throws(() => existsQuery([]), RangeError);
    assert.throws(() => existsQuery(['']), TypeError);
    assert.throws(() => refOf('no-slash'), TypeError);
    assert.throws(() => refOf('a/b/c'), TypeError);
  });

  it('refOf accepts owner/name, {owner, name} and {nwo}', () => {
    assert.deepEqual(refOf('a/b'), { owner: 'a', name: 'b' });
    assert.deepEqual(refOf({ owner: 'a', name: 'b' }), { owner: 'a', name: 'b' });
    assert.deepEqual(refOf({ nwo: 'a/b.c' }), { owner: 'a', name: 'b.c' });
  });

  it('aliasValues reads r0…rN, null for missing aliases', () => {
    assert.deepEqual(aliasValues({ data: { r0: { id: 'x' }, r2: null } }, 3), [{ id: 'x' }, null, null]);
  });
});
