// @ts-check
/**
 * `unsung status [--audit] [--units]` (DESIGN §9.1, §7.5): recent runs, the ledger by state, budget
 * spent, saturated windows, halvings, heavy repositories and source health; `--units` lists every
 * ledger unit, `--audit` draws this week's gate audit sample (10 repositories per gate).
 */

import { isoWeek, mulberry32, sampleN } from '../core/util.mjs';
import { fmt } from '../pipeline/util.mjs';
import { createMemoryStore } from '../store/memory.mjs';
import { hasStore } from '../store/store.mjs';

/** Repositories per gate in the weekly audit sample (§7.5). */
export const AUDIT_PER_GATE = 10;

/**
 * @param {string | null | undefined} iso
 * @returns {string}
 */
function when(iso) {
  return typeof iso === 'string' ? iso.replace('T', ' ').slice(0, 16) : '—';
}

/**
 * The weekly gate audit sample: up to 10 repositories per gate, drawn with a generator seeded by
 * the ISO week, from index entries carrying the gate and candidates dropped by it.
 * @param {any} store
 * @param {string} now
 * @returns {Promise<Record<string, string[]>>}
 */
export async function auditSample(store, now) {
  /** @type {Map<string, Set<string>>} */
  const byGate = new Map();
  /** @param {string} id @param {string} nwo */
  const add = (id, nwo) => {
    const set = byGate.get(id) ?? new Set();
    set.add(nwo);
    byGate.set(id, set);
  };
  const index = await store.readIndex();
  for (const e of index?.entries ?? []) {
    for (const g of e.gates ?? []) add(typeof g === 'string' ? g : g.id, e.nwo);
  }
  for (const c of await store.listCandidates({ state: ['dropped', 'quarantined'] })) {
    if (typeof c.reason === 'string' && c.reason.startsWith('g.')) add(c.reason, c.nwo);
    else if (c.reason === 'lure-name') add('g.lure.name', c.nwo);
    else if (c.reason === 'spam-words') add('g.spam.words', c.nwo);
  }
  const week = isoWeek(now);
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const id of [...byGate.keys()].sort()) {
    const list = [.../** @type {Set<string>} */ (byGate.get(id))].sort();
    out[id] = sampleN(list, AUDIT_PER_GATE, mulberry32(`${week}:${id}`));
  }
  return out;
}

export const command = {
  name: 'status',
  summary: 'Show recent runs, the ledger, budget spent and source health',
  flags: {
    audit: { type: 'boolean', summary: 'print this week\'s gate audit sample for blind labelling' },
    units: { type: 'boolean', summary: 'list every ledger unit' },
  },
  /**
   * @param {import('./args.mjs').ParsedArgs} args
   * @param {any} ctx
   * @returns {Promise<number>}
   */
  async run(args, ctx) {
    // Looking never creates a data directory: one without a store reads as an empty store.
    const store = ctx.dataDir && !hasStore(ctx.dataDir)
      ? createMemoryStore({ now: ctx.now })
      : await ctx.store();
    const runs = await store.lastRuns(5);
    const units = store.ledger.list();
    /** @type {Record<string, number>} */
    const byState = { planned: 0, running: 0, done: 0, failed: 0 };
    /** @type {Record<string, Record<string, number>>} */
    const bySource = {};
    for (const u of units) {
      byState[u.state] = (byState[u.state] ?? 0) + 1;
      bySource[u.stage] ??= { planned: 0, running: 0, done: 0, failed: 0 };
      bySource[u.stage][u.state] = (bySource[u.stage][u.state] ?? 0) + 1;
    }
    const saturated = units.filter((u) => u.out && /** @type {any} */ (u.out).saturated).map((u) => u.key);
    const candidates = await store.candidateCounts();
    const lock = await store.lockInfo();
    const index = await store.readIndex();
    const audit = args.flags.audit ? await auditSample(store, ctx.now()) : undefined;

    if (ctx.flags.json) {
      ctx.printJson({
        lock, runs, units: byState, sources: bySource, saturated, candidates,
        index: index
          ? { generatedAt: index.generatedAt, entries: index.entries.length, counts: index.counts }
          : null,
        ...(args.flags.units ? { unitList: units } : {}),
        ...(audit ? { audit } : {}),
      });
      return 0;
    }

    if (lock) {
      const stale = lock.live ? '' : ', stale';
      ctx.print(`Lock: run ${lock.runId} (process ${lock.pid}) since ${when(lock.startedAt)}${stale}`);
    } else ctx.print('Lock: none');
    ctx.print(runs.length ? 'Recent runs:' : 'No runs yet. Start one with: unsung run');
    for (const r of runs) {
      const e = /** @type {any} */ (r.stages?.enrich ?? {});
      const g = /** @type {any} */ (r.rate?.graphql ?? {});
      const rest = /** @type {any} */ (r.rate?.rest ?? {});
      const span = `${when(r.startedAt)} → ${when(r.endedAt)}`;
      const exit = `${r.exit?.reason ?? 'running'} (${r.exit?.code ?? '—'})`;
      const rate = `GraphQL ${fmt(g.points ?? 0)} points · REST ${fmt(rest.calls ?? 0)} calls`
        + ` (${fmt(rest.notModified ?? 0)} not modified)`;
      const extra = `${e.halvings ? ` (${e.halvings} halvings)` : ''}${e.heavy ? ` · ${e.heavy} heavy` : ''}`;
      // A lane the run skipped before its first unit says why (§3.8), e.g. `archive: skipped (time)`.
      const skipped = Object.entries(r.stages ?? {})
        .filter(([, s]) => typeof /** @type {any} */ (s)?.skipped === 'string')
        .map(([name, s]) => ` · ${name}: skipped (${/** @type {any} */ (s).skipped})`).join('');
      const head = `  ${r.runId}  ${r.profile ?? '—'}  ${span}  ${exit}`;
      ctx.print(`${head}  ${rate}  enriched ${fmt(e.repos ?? 0)}${extra}${skipped}`);
    }
    ctx.print(`Ledger: ${Object.entries(byState).map(([s, n]) => `${s} ${fmt(n)}`).join(' · ')}`);
    for (const [stage, counts] of Object.entries(bySource).sort()) {
      const failed = units.filter((u) => u.stage === stage && u.state === 'failed');
      const next = failed.map((u) => u.nextAt).filter(Boolean).sort()[0];
      const retry = next ? ` (next try ${when(next)})` : '';
      const tally = `${fmt(counts.done ?? 0)} done · ${fmt(counts.failed ?? 0)} failed`;
      ctx.print(`  ${stage}: ${tally}${retry}`);
    }
    ctx.print(`Saturated windows: ${fmt(saturated.length)}`);
    const order = ['queued', 'deferred', 'enriched', 'quarantined', 'dropped', 'expired', 'heavy', 'gone'];
    ctx.print(`Candidates: ${order.map((s) => `${s} ${fmt(candidates[s] ?? 0)}`).join(' · ')}`);
    if (index) {
      const counts = Object.entries(index.counts ?? {}).filter(([, n]) => n > 0)
        .map(([l, n]) => `${l} ${fmt(n)}`).join(' · ');
      const listed = counts ? ` (${counts})` : '';
      ctx.print(`Index: ${fmt(index.entries.length)} entries${listed}, built ${when(index.generatedAt)}`);
    } else ctx.print('Index: not built yet');
    if (args.flags.units) {
      ctx.print('Units:');
      for (const u of units) {
        const why = String(u.err ?? '').slice(0, 80);
        const extra = u.state === 'failed' ? `  next ${when(u.nextAt)}  ${why}` : '';
        ctx.print(`  ${u.key}  ${u.state}  ${u.attempts}${extra}`);
      }
    }
    if (audit) {
      ctx.print(`Gate audit sample for ${isoWeek(ctx.now())}:`);
      if (Object.keys(audit).length === 0) ctx.print('  no gated repositories yet');
      for (const [id, list] of Object.entries(audit)) {
        ctx.print(`  ${id} (${list.length}):`);
        for (const nwo of list) ctx.print(`    ${nwo}`);
      }
    }
    return 0;
  },
};
