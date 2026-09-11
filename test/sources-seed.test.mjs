// @ts-check
/**
 * Candidate seeds (DESIGN §4.3) from recorded nodes, and the base-query check on live values.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadJsonFixture, loadRepoFixture } from './support/fixtures.mjs';
import { DESCRIPTION_BYTES, passesBase, seedFromNode } from '../src/sources/seed.mjs';

describe('seedFromNode', () => {
  it('maps a recorded census node', () => {
    const fx = loadJsonFixture('search/normal-2026-09-08T0400.json');
    const node = fx.pages[0].body.data.search.nodes[0];
    assert.deepEqual(seedFromNode(node, 'census:2026-09-08'), {
      id: 'R_kgDOUR3DIg', nwo: 'ajx1tech/bypeel', createdAt: '2026-09-08T04:06:17Z',
      pushedAt: '2026-09-10T09:08:05Z', stars: 0, forks: 0, diskKB: 6757, lang: 'HTML', licence: null,
      hasDesc: true, description: 'AI-Powered Monitoring & Analysis of Bitcoin Transaction Traffic',
      ownerType: 'User', isFork: false, isArchived: false, isTemplate: false, isMirror: false,
      source: 'census:2026-09-08',
    });
  });

  it('accepts an enrich-shaped node', () => {
    const { enrich } = loadRepoFixture('zaghaghi/toolog');
    const seed = seedFromNode(enrich, 'add');
    assert.equal(seed.nwo, 'zaghaghi/toolog');
    assert.equal(seed.licence, 'MIT');
    assert.equal(seed.lang, 'Rust');
    assert.equal(seed.stars, 5);
    assert.equal(seed.source, 'add');
  });

  it('licence: spdxId, NOASSERTION for an unidentified licence, null for none', () => {
    const base = { id: 'R_1', nameWithOwner: 'o/r', createdAt: '2026-09-08T00:00:00Z' };
    const apache = seedFromNode({ ...base, licenseInfo: { spdxId: 'Apache-2.0' } }, 'add');
    assert.equal(apache.licence, 'Apache-2.0');
    assert.equal(seedFromNode({ ...base, licenseInfo: { spdxId: null } }, 'add').licence, 'NOASSERTION');
    assert.equal(seedFromNode({ ...base, licenseInfo: null }, 'add').licence, null);
  });

  it('caps the description at 1 KB without splitting a character, and reads blank as no description', () => {
    const base = { id: 'R_1', nameWithOwner: 'o/r', createdAt: '2026-09-08T00:00:00Z' };
    const long = seedFromNode({ ...base, description: 'é'.repeat(2000) }, 'add');
    assert.ok(Buffer.byteLength(/** @type {string} */ (long.description)) <= DESCRIPTION_BYTES);
    assert.ok(/** @type {string} */ (long.description).endsWith('é'));
    assert.equal(seedFromNode({ ...base, description: '   ' }, 'add').hasDesc, false);
    assert.equal(seedFromNode({ ...base, description: null }, 'add').hasDesc, false);
  });

  it('refuses nodes it cannot key', () => {
    assert.throws(() => seedFromNode(null, 'add'), TypeError);
    assert.throws(() => seedFromNode({ nameWithOwner: 'o/r', createdAt: 'x' }, 'add'), TypeError);
    assert.throws(() => seedFromNode({ id: 'R', nameWithOwner: 'o/r' }, 'add'), TypeError);
    assert.throws(() => seedFromNode({ id: 'R', nameWithOwner: 'o/r', createdAt: 'x' }, ''), TypeError);
  });
});

describe('passesBase', () => {
  const ok = seedFromNode({
    id: 'R_1', nameWithOwner: 'o/r', createdAt: '2026-09-08T00:00:00Z', stargazerCount: 25, diskUsage: 200,
  }, 'add');

  it('keeps a repository inside every base-query filter', () => {
    assert.equal(passesBase(ok), true);
  });

  it('drops forks, archives, templates, mirrors, too many stars and too little code', () => {
    for (const flag of ['isFork', 'isArchived', 'isTemplate', 'isMirror']) {
      assert.equal(passesBase({ ...ok, [flag]: true }), false, flag);
    }
    assert.equal(passesBase({ ...ok, stars: 26 }), false);
    assert.equal(passesBase({ ...ok, stars: 26 }, { maxStars: 30 }), true);
    assert.equal(passesBase({ ...ok, diskKB: 199 }), false);
    assert.equal(passesBase(/** @type {any} */ (null)), false);
  });
});
