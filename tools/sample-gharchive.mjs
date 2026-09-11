// @ts-check
/**
 * Streams one GH Archive hour and keeps a small, deterministic, biased sample for the fixtures
 * (DESIGN §3.3, §14.2). Usage:
 *
 *   node tools/sample-gharchive.mjs --hour 2026-09-10-15 [--seed 20260910] [--out <dir>]
 *
 * The hour is fetched with `fetch`, gunzipped with `node:zlib` and split on `\n` by hand —
 * never with `readline`, which also splits on U+2028 and would break `JSON.parse`. Nothing but
 * the sample is written: the full hour never touches the disk. Lines are kept byte-for-byte.
 *
 * Sample make-up (about 500 lines, original order): up to 5 lines holding a raw U+2028, up to 10
 * prerelease ReleaseEvents, 250 other ReleaseEvents, 120 PublicEvents and 230 other events of any
 * type (a line carrying an e-mail address is skipped, to keep personal data out of the
 * repository). If the hour holds no raw U+2028 at all, one is inserted into the
 * release body of a kept ReleaseEvent and the tool says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createGunzip, gzipSync } from 'node:zlib';
import { FIXTURES, mulberry32 } from './lib/fixture-io.mjs';

const UA = 'unsung/0.1.0 (+local; read-only)';
/** U+2028 LINE SEPARATOR, which `readline` treats as a line break. */
const LS = '\u2028';
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const TYPE = /"type":"(\w+)"/;
const CAPS = { u2028: 5, prerelease: 10, release: 250, public: 120, other: 230 };

/**
 * Split a gunzipped byte stream into lines on byte 0x0A only.
 * @param {AsyncIterable<Buffer>} stream
 * @returns {AsyncGenerator<Buffer>}
 */
export async function* splitLines(stream) {
  /** @type {Buffer} */
  let carry = Buffer.alloc(0);
  for await (const chunk of stream) {
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let start = 0;
    let nl = buf.indexOf(0x0a, start);
    while (nl !== -1) {
      yield buf.subarray(start, nl);
      start = nl + 1;
      nl = buf.indexOf(0x0a, start);
    }
    carry = Buffer.from(buf.subarray(start));
  }
  if (carry.length) yield carry;
}

/**
 * Reservoir of capacity `k` over `{idx, line}` items.
 * @param {number} k
 * @param {() => number} rand
 */
function reservoir(k, rand) {
  /** @type {{idx: number, line: string}[]} */
  const items = [];
  let seen = 0;
  return {
    items,
    /** @param {{idx: number, line: string}} item */
    offer(item) {
      seen++;
      if (items.length < k) items.push(item);
      else {
        const j = Math.floor(rand() * seen);
        if (j < k) items[j] = item;
      }
    },
  };
}

/**
 * @param {string} hour `YYYY-MM-DD-H` (hours not zero-padded)
 * @returns {string}
 */
export function hourUrl(hour) {
  return `https://data.gharchive.org/${hour}.json.gz`;
}

/**
 * @param {string} line
 * @returns {string}
 */
function typeOf(line) {
  return TYPE.exec(line.slice(0, 300))?.[1] ?? 'unknown';
}

/**
 * Stream the hour and pick the sample.
 * @param {{hour: string, seed: number, fetchImpl?: typeof fetch}} opts
 */
export async function sampleHour({ hour, seed, fetchImpl = fetch }) {
  const res = await fetchImpl(hourUrl(hour), { headers: { 'user-agent': UA } });
  if (!res.ok || !res.body) throw new Error(`GH Archive answered ${res.status} for ${hour}`);
  const gunzip = createGunzip();
  const source = Readable.fromWeb(/** @type {any} */ (res.body));
  source.on('error', (err) => gunzip.destroy(err));
  source.pipe(gunzip);

  const rand = mulberry32(seed);
  const pools = {
    prerelease: reservoir(CAPS.prerelease, rand),
    release: reservoir(CAPS.release, rand),
    public: reservoir(CAPS.public, rand),
    other: reservoir(CAPS.other, rand),
  };
  /** @type {{idx: number, line: string}[]} */
  const u2028 = [];
  /** @type {Record<string, number>} */
  const types = {};
  let lines = 0;
  let badLines = 0;
  let u2028Lines = 0;
  let emailSkipped = 0;

  for await (const raw of splitLines(gunzip)) {
    if (!raw.length) continue;
    const idx = lines++;
    const line = raw.toString('utf8');
    const type = typeOf(line);
    types[type] = (types[type] ?? 0) + 1;
    const item = { idx, line };
    if (line.includes(LS)) {
      u2028Lines++;
      try {
        JSON.parse(line);
        if (u2028.length < CAPS.u2028 && !EMAIL.test(line)) u2028.push(item);
      } catch {
        badLines++;
      }
      continue;
    }
    if (EMAIL.test(line)) {
      emailSkipped++;
      continue;
    }
    if (type === 'ReleaseEvent') {
      if (line.includes('"prerelease":true')) pools.prerelease.offer(item);
      else pools.release.offer(item);
    } else if (type === 'PublicEvent') pools.public.offer(item);
    else pools.other.offer(item);
  }

  const picked = [...u2028, ...Object.values(pools).flatMap((p) => p.items)]
    .sort((a, b) => a.idx - b.idx);
  for (const p of picked) {
    try {
      JSON.parse(p.line);
    } catch {
      throw new Error(`Line ${p.idx} of ${hour} does not parse; refusing to keep it`);
    }
  }

  /** @type {{sampleLine: number, eventId: string, field: string} | null} */
  let inserted = null;
  if (!picked.some((p) => p.line.includes(LS))) {
    const target = picked.find((p) => typeOf(p.line) === 'ReleaseEvent' && p.line.includes('"body":"'));
    if (!target) throw new Error('No ReleaseEvent with a body to carry an inserted U+2028');
    const at = target.line.indexOf('"body":"') + '"body":"'.length;
    target.line = `${target.line.slice(0, at)}${LS}${target.line.slice(at)}`;
    inserted = {
      sampleLine: picked.indexOf(target) + 1,
      eventId: JSON.parse(target.line).id,
      field: 'payload.release.body',
    };
  }

  /** @type {Record<string, number>} */
  const keptTypes = {};
  for (const p of picked) keptTypes[typeOf(p.line)] = (keptTypes[typeOf(p.line)] ?? 0) + 1;
  const withLs = picked.map((p, i) => (p.line.includes(LS) ? i + 1 : 0)).filter(Boolean);
  return {
    picked,
    stats: {
      hour, lines, badLines, u2028Lines, emailSkipped, types, inserted, kept: picked.length, keptTypes,
      u2028SampleLines: withLs,
    },
  };
}

/**
 * CLI entry point.
 * @param {string[]} argv
 * @returns {Promise<number>}
 */
export async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      hour: { type: 'string' },
      seed: { type: 'string', default: '20260910' },
      out: { type: 'string', default: path.join(FIXTURES, 'gharchive') },
    },
  });
  if (!values.hour || !/^\d{4}-\d{2}-\d{2}-(\d|1\d|2[0-3])$/.test(values.hour)) {
    process.stderr.write('Usage: node tools/sample-gharchive.mjs --hour YYYY-MM-DD-H\n');
    return 2;
  }
  const { picked, stats } = await sampleHour({ hour: values.hour, seed: Number(values.seed) });
  const body = `${picked.map((p) => p.line).join('\n')}\n`;
  const file = path.join(values.out, `${values.hour}.sample.json.gz`);
  fs.mkdirSync(values.out, { recursive: true });
  fs.writeFileSync(file, gzipSync(Buffer.from(body, 'utf8'), { level: 9 }));
  const summary = { file: path.relative(process.cwd(), file), ...stats };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => {
    process.stderr.write(`sample-gharchive: ${err && err.message}\n`);
    process.exitCode = 1;
  });
}
