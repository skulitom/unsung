// @ts-check
/**
 * The detail pane (DESIGN §10.2): the Why panel — the chip waterfall summing to `S`, why not
 * higher, what would raise confidence and the rank line (§6.8), each chip linking to evidence at
 * the scored commit — then the three meters side by side, the README through the safe renderer, a
 * tree summary, the last commit headlines, weekly star gains, the verdict with its verified quotes,
 * and the support ladder. A quarantined repository shows identity and gate reasons only.
 *
 * `state.lib.explain` and `state.lib.toSafeBlocks` come from src/core/explain.mjs and
 * src/core/readme.mjs when they load; without them the pane explains from the index entry and
 * shows the README as plain text.
 */

import { treeSummary } from '../../src/core/views.mjs';
import { el, plainText, renderBlocks, replace, safeLink } from '../render.mjs';
import {
  CATEGORIES, DESCRIPTORS, attentionStrip, button, chipState, confidencePill, count, descriptorChips,
  formatDate, laneBadge, numOrNull, pct, qualityMeter, relTime, repoName, signed, sparkline, triageBar,
} from './parts.mjs';
import { WARNING, quarantineItem } from './quarantine.mjs';

/** @typedef {import('../../src/core/schema.mjs').IndexEntry} IndexEntry */
/** @typedef {(action: Record<string, any>) => void} Dispatch */

/** Registry order of the positive signals (§6.8), for ordering chips and hints. */
export const POSITIVE_ORDER = Object.freeze(['q.release', 'p.testsRun', 'p.shipped', 'q.tests',
  'q.examples', 'p.coherent', 'q.usage', 'q.ci', 'q.manifest', 'q.deps', 'q.code', 'q.licence', 'q.readme']);

/** What would earn each positive signal, for "why not higher" when explain.mjs is not there. */
export const HINTS = Object.freeze({
  'q.licence': 'a licence GitHub can detect',
  'q.readme': 'a README of at least 1 KB',
  'q.usage': 'two fenced code blocks in the README showing how to use it',
  'q.ci': 'a CI workflow',
  'q.manifest': 'a build manifest at the root, such as package.json, Cargo.toml or go.mod',
  'q.deps': 'a lockfile, or a manifest with no dependencies',
  'q.tests': 'tests: a test directory or test files',
  'q.code': 'at least 50 KB of code',
  'q.release': 'a release or a tag',
  'q.examples': 'an examples or demo directory',
  'p.testsRun': 'CI that runs the tests and passes',
  'p.shipped': 'two or more releases on different days, at least a week apart',
  'p.coherent': 'a README whose cited files and scripts exist',
});

/** What would raise confidence (§5.4), when explain.mjs is not there. */
export const CONFIDENCE_HINTS = Object.freeze([
  'Time: pushes on 5 or more days spread over at least 30 days, as GitHub records them',
  'Releases: three or more over four weeks or more',
  'People: issues or pull requests from established accounts other than the owner',
  'CI verified: the tests run green in CI',
  'Owner history: contribution years on GitHub before 2024',
]);

/** Signals where only the most negative of a group counts (§6.1). */
const GROUPS = Object.freeze({ 's.prose': 'prose', 's.mdheavy': 'prose' });

/**
 * @typedef {object} Chip
 * @property {string} id
 * @property {string} label
 * @property {number} points
 * @property {'hit' | 'miss' | 'unknown' | 'na'} state
 * @property {string} [reason]
 * @property {{label: string, url: string, quote?: string}[]} [evidence]
 * @property {string | null} [group]
 * @property {number} [weight]
 */

/**
 * @typedef {object} Explanation
 * @property {string} headline
 * @property {Chip[]} chips
 * @property {{label: string, points: number, hint: string}[]} whyNotHigher
 * @property {string[]} raiseConfidence
 * @property {string} rankLine
 * @property {boolean} fromIndex whether this was built from the index entry alone
 */

/**
 * @param {unknown} v
 * @returns {string}
 */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = /** @type {Record<string, unknown>} */ (v);
    return [o.label, o.text, o.hint, o.what, o.reason].filter((x) => typeof x === 'string').join(': ');
  }
  return '';
}

/**
 * @param {string} id
 * @returns {number}
 */
function rank(id) {
  const i = POSITIVE_ORDER.indexOf(id);
  return i < 0 ? POSITIVE_ORDER.length : i;
}

/**
 * @param {string} id
 * @returns {string | undefined}
 */
function hintFor(id) {
  return /** @type {Record<string, string>} */ (HINTS)[id];
}

/**
 * The explanation from `explain(score, weights)` (§6.8).
 * @param {any} x
 * @param {(c: any) => Chip} toChip
 * @returns {Explanation}
 */
function fromExplain(x, toChip) {
  const why = Array.isArray(x.whyNotHigher) ? x.whyNotHigher : [];
  return {
    headline: textOf(x.headline),
    chips: (Array.isArray(x.chips) ? x.chips : []).map(toChip),
    whyNotHigher: why.map((/** @type {any} */ w) => ({
      label: typeof w === 'string' ? w : String(w.label ?? w.id ?? ''),
      points: numOrNull(w?.points) ?? 0,
      hint: typeof w === 'string' ? '' : textOf(w.hint ?? w.reason ?? ''),
    })),
    raiseConfidence: (Array.isArray(x.raiseConfidence) ? x.raiseConfidence : []).map(textOf).filter(Boolean),
    rankLine: textOf(x.rankLine),
    fromIndex: false,
  };
}

/**
 * The explanation for the Why panel: from `explain(score, weights)` when available, else from the
 * stored score or the index entry and the model's weights.
 * @param {Partial<IndexEntry>} entry
 * @param {any} record
 * @param {any} model
 * @param {{explain?: Function | null}} lib
 * @returns {Explanation}
 */
export function explanationFor(entry, record, model, lib) {
  const weights = model?.weights ?? null;
  const score = record?.score ?? null;
  const signals = new Map((Array.isArray(score?.signals) ? score.signals : [])
    .map((/** @type {any} */ s) => [s.id, s]));
  /** @param {any} c @returns {Chip} */
  const toChip = (c) => {
    const sig = signals.get(c.id);
    const weight = numOrNull(sig?.weight) ?? numOrNull(weights?.signals?.[c.id]?.points);
    return {
      id: String(c.id ?? ''), label: String(c.label ?? sig?.label ?? c.id ?? ''),
      points: numOrNull(c.points) ?? 0, state: chipState(c),
      reason: typeof sig?.reason === 'string' ? sig.reason : '',
      evidence: Array.isArray(sig?.evidence) ? sig.evidence : [],
      group: sig?.group ?? /** @type {Record<string, string>} */ (GROUPS)[c.id] ?? null,
      weight: weight ?? undefined,
    };
  };
  if (typeof lib.explain === 'function' && score) {
    try {
      return fromExplain(lib.explain(score, weights), toChip);
    } catch {
      // Fall through to the explanation built here.
    }
  }
  const scoring = ['quality', 'proof', 'slop', 'judge'];
  const source = Array.isArray(score?.signals)
    ? score.signals.filter((/** @type {any} */ s) => scoring.includes(s.kind))
    : Array.isArray(entry.chips) ? entry.chips : [];
  const chips = source.map(toChip);
  const S = numOrNull(score?.S) ?? numOrNull(entry.S) ?? 0;
  const k = numOrNull(score?.confidence?.k) ?? numOrNull(entry.k) ?? 0;
  const a = numOrNull(score?.attention?.a) ?? numOrNull(entry.a) ?? 0;
  const gem = numOrNull(score?.gem) ?? numOrNull(entry.gem) ?? S;
  const kW = numOrNull(weights?.gem?.kWeight) ?? 1.5;
  const aW = numOrNull(weights?.gem?.aWeight) ?? 1.5;
  const missed = chips.filter((c) => (c.state === 'miss' || c.state === 'unknown')
    && !c.id.startsWith('s.') && c.id !== 'llm.review').sort((x, y) => rank(x.id) - rank(y.id));
  const items = Array.isArray(score?.confidence?.items) ? score.confidence.items : [];
  const weak = items.filter((/** @type {any} */ i) => !(numOrNull(i.strength) ?? 0))
    .map((/** @type {any} */ i) => `${i.label}${i.reason ? `: ${i.reason}` : ''}`);
  const band = entry.kBand ?? score?.confidence?.band ?? 'low';
  return {
    headline: `${S} points · Quality ${pct(score?.quality ?? entry.quality)} · Confidence ${band} · `
      + `${count(entry.stars ?? 0)} stars`,
    chips,
    whyNotHigher: missed.map((c) => {
      const hint = hintFor(c.id) ?? c.label;
      return { label: c.label, points: c.weight ?? 1,
        hint: c.state === 'unknown' ? `not known yet (${hint})` : hint };
    }),
    raiseConfidence: weak.length > 0 ? weak : [...CONFIDENCE_HINTS],
    rankLine: `Rank ${gem.toFixed(2)} = ${S} points + ${(kW * k).toFixed(2)} confidence `
      + `− ${(aW * a).toFixed(2)} attention`,
    fromIndex: true,
  };
}

/**
 * The chip waterfall: every scoring chip that counted, with a running total that ends at `S`.
 * Within a group only the most negative penalty counts (§6.1); the other is marked. A hit worth no
 * points — a signal retired to weight 0, such as `s.incoherent` since weights w2 (§5.3) — is noted
 * under the sum, so the panel still says what was measured without counting it.
 * @param {Chip[]} chips
 * @param {number} S
 * @param {number | null} pointsMax
 * @returns {any}
 */
function waterfall(chips, S, pointsMax) {
  const hits = chips.filter((c) => c.state === 'hit' && c.points !== 0);
  const noted = chips.filter((c) => c.state === 'hit' && c.points === 0);
  /** @type {Map<string, Chip>} */
  const worst = new Map();
  for (const c of hits) {
    if (!c.group) continue;
    const cur = worst.get(c.group);
    if (!cur || c.points < cur.points) worst.set(c.group, c);
  }
  const ordered = [
    ...hits.filter((c) => c.points > 0).sort((x, y) => rank(x.id) - rank(y.id)),
    ...hits.filter((c) => c.points < 0).sort((x, y) => x.points - y.points),
  ];
  /** @param {Chip} c */
  const evidenceOf = (c) => (c.evidence ?? []).slice(0, 3).map((ev) => [
    safeLink(ev.url, ev.label || 'evidence'), ev.quote ? el('q', null, ev.quote) : null,
  ]);
  const notes = noted.map((c) => {
    const evidence = evidenceOf(c);
    return el('li', { class: ['wf-row', 'noted'] }, [
      el('span', { class: 'wf-points' }, signed(0)),
      el('span', { class: 'wf-label' }, c.label),
      el('span', { class: 'wf-note' }, 'no points'),
      el('span', { class: 'wf-reason' }, c.reason ? `${c.reason}; noted, not scored` : 'Noted, not scored'),
      evidence.length > 0 ? el('span', { class: 'wf-evidence' }, evidence) : null,
    ]);
  });
  let running = 0;
  const rows = ordered.map((c) => {
    const counted = !c.group || worst.get(c.group) === c;
    if (counted) running += c.points;
    const evidence = evidenceOf(c);
    return el('li', { class: ['wf-row', c.points > 0 ? 'plus' : 'minus', counted ? null : 'not-counted'] }, [
      el('span', { class: 'wf-points' }, signed(c.points)),
      el('span', { class: 'wf-label' }, c.label),
      el('span', { class: 'wf-total', title: 'Running total' }, counted ? String(running) : 'not counted'),
      c.reason ? el('span', { class: 'wf-reason' }, c.reason) : null,
      counted ? null : el('span', { class: 'wf-reason' }, 'Only the larger penalty of this group counts.'),
      evidence.length > 0 ? el('span', { class: 'wf-evidence' }, evidence) : null,
    ]);
  });
  return el('div', { class: 'waterfall' }, [
    el('ol', { class: 'wf', 'aria-label': 'Points, chip by chip' }, rows),
    el('p', { class: 'wf-sum' }, [el('b', null, `= ${S} points`),
      pointsMax ? ` of ${pointsMax} available` : null]),
    notes.length > 0 ? el('ul', { class: 'wf-noted', 'aria-label': 'Noted without points' }, notes) : null,
  ]);
}

/**
 * The three meters side by side (§10.2).
 * @param {Partial<IndexEntry>} entry
 * @param {any} record
 * @param {any} model
 * @returns {any}
 */
function meters(entry, record, model) {
  const fittedOn = model?.calibration?.fittedOn;
  const labels = numOrNull(fittedOn?.labels) ?? 149;
  const uniformPositives = numOrNull(fittedOn?.uniformPositives) ?? 9;
  const coverage = numOrNull(entry.coverage);
  const watchers = numOrNull(record?.facts?.watchers);
  const qNote = `Quality ${pct(entry.quality)}: the estimated share of genuine repositories among `
    + `labelled ones with this many points (${labels} labels, ${uniformPositives} genuine in the `
    + 'uniform sample).';
  const hatch = coverage !== null && coverage < 0.8
    ? el('p', { class: 'hatch-note' }, `Incomplete evidence: ${Math.round(coverage * 100)} % of the `
      + 'checks could be made.')
    : null;
  return el('div', { class: 'meters3' }, [
    el('section', { class: 'm-panel m-quality' }, [
      el('h4', null, 'Quality'), qualityMeter(entry, { large: true }),
      el('p', { class: 'muted' }, qNote), hatch,
    ]),
    el('section', { class: 'm-panel m-confidence' }, [
      el('h4', null, 'Confidence'), confidencePill(entry),
      el('p', { class: 'muted' }, 'Corroboration that is costly to fake. Low confidence is shown, never '
        + 'hidden: fresh solo work belongs here too.'),
    ]),
    el('section', { class: 'm-panel m-attention' }, [
      el('h4', null, 'Attention'), attentionStrip(entry),
      watchers !== null
        ? el('p', { class: 'muted' }, `${count(Math.max(0, watchers - 1))} watching besides the owner`)
        : null,
      el('p', { class: 'muted' }, 'Stars never count toward quality; they only take a repository out of '
        + 'Unsung.'),
    ]),
  ]);
}

/**
 * The support ladder (§11.5), built from what the record shows. Install commands are left to the
 * gallery's ladder; the explorer offers the links a reader can check for themselves.
 * @param {string} nwo
 * @param {any} facts
 * @returns {any}
 */
function supportLadder(nwo, facts) {
  const repo = `https://github.com/${nwo}`;
  const owner = nwo.split('/')[0];
  const releases = numOrNull(facts?.releases?.count) ?? 0;
  const funding = Array.isArray(facts?.funding) ? facts.funding : [];
  const discussions = Boolean(facts?.hasDiscussions);
  const where = discussions ? `${repo}/discussions` : facts?.hasIssues === false ? null : `${repo}/issues`;
  const sponsor = funding.length > 0
    ? funding.slice(0, 3).map((/** @type {any} */ f) => safeLink(f.url, f.platform))
    : facts?.ownerInfo?.sponsorsListing ? safeLink(`https://github.com/sponsors/${owner}`, 'GitHub Sponsors')
      : null;
  /** @type {[string, any][]} */
  const steps = [];
  if (facts?.homepageUrl) steps.push(['Try it', safeLink(facts.homepageUrl, 'the demo')]);
  steps.push(['Star it yourself', safeLink(repo, 'the repository')]);
  if (releases > 0) steps.push(['Follow releases', safeLink(`${repo}/releases.atom`, 'the releases feed')]);
  if (where) {
    steps.push(['Give feedback after trying it', [safeLink(where, discussions ? 'Discussions' : 'Issues'),
      el('span', { class: 'muted' }, ' — say what you tried and what happened, and be kind.')]]);
  }
  if (sponsor) steps.push(['Sponsor', sponsor]);
  return el('ol', { class: 'ladder' }, steps.map(([label, body]) => el('li', null, [el('b', null, label), ' ',
    body])));
}

/**
 * A tree summary from `treeSummary` (§10.2, §10.7).
 * @param {any} tree
 * @returns {any}
 */
export function treeView(tree) {
  if (!tree) return el('p', { class: 'muted' }, 'The tree has not been fetched yet.');
  const head = tree.source === 'tree'
    ? `${count(tree.files)} files${tree.truncated ? ' (GitHub truncated the listing)' : ''}`
    : 'Root listing (the full tree comes with the deep stage)';
  const items = tree.top.map((/** @type {any} */ t) => el('li', {
    class: t.type === 'tree' ? 'dir' : 'file',
  }, [
    t.type === 'tree' ? `${t.name}/` : t.name,
    t.files !== null && t.type === 'tree' ? el('span', { class: 'muted' }, ` ${count(t.files)}`) : null,
  ]));
  return el('div', { class: 'tree' }, [
    el('p', { class: 'muted' }, head),
    el('ul', { class: 'tree-list' }, items),
    tree.more > 0 ? el('p', { class: 'muted' }, `and ${tree.more} more`) : null,
  ]);
}

/**
 * The reviewer's verdict: category, pitch, summary, scores and the claims whose quotes were
 * verified against the pack (§8.5). All of it is text.
 * @param {any} verdict the RepoRecord verdict, or the index entry's `{category, pitch, points}`
 * @returns {any}
 */
function verdictView(verdict) {
  if (!verdict) return null;
  const out = verdict.output ?? null;
  const category = out?.category ?? verdict.category;
  const name = /** @type {Record<string, string[]>} */ (CATEGORIES)[category]?.[0] ?? category;
  const pitch = out?.pitch ?? verdict.pitch;
  const claims = Array.isArray(out?.claims) ? out.claims.slice(0, 12) : [];
  const scores = out?.scores && typeof out.scores === 'object' ? Object.entries(out.scores) : [];
  const points = numOrNull(verdict.effect?.points) ?? numOrNull(verdict.points);
  const claimItems = claims.map((/** @type {any} */ c) => el('li', null, [
    String(c.text ?? ''), ' ', el('code', null, String(c.path ?? '')),
    c.quote ? el('q', null, String(c.quote)) : null,
  ]));
  return el('section', { class: 'verdict' }, [
    el('h3', null, 'Reviewer'),
    el('p', null, [el('span', { class: ['badge', `cat-${category}`] }, `${category} · ${name}`),
      points !== null ? ` ${signed(points)} point${Math.abs(points) === 1 ? '' : 's'}` : null,
      verdict.status && verdict.status !== 'ok' ? ` (${verdict.status})` : null]),
    pitch ? el('p', { class: 'pitch' }, `“${pitch}”`) : null,
    out?.summary ? el('p', null, out.summary) : null,
    scores.length > 0
      ? el('p', { class: 'muted' }, scores.map(([k, v]) => `${k} ${v}/4`).join(' · ')) : null,
    claimItems.length > 0 ? el('ul', { class: 'claims' }, claimItems) : null,
    verdict.effect?.reason ? el('p', { class: 'muted' }, verdict.effect.reason) : null,
  ]);
}

/**
 * The README through the safe block renderer (§10.8), or as plain text without it.
 * @param {any} facts
 * @param {{toSafeBlocks?: Function | null}} lib
 * @returns {any}
 */
export function readmeView(facts, lib) {
  const readme = facts?.readme;
  if (readme === null) return el('p', { class: 'muted' }, 'No README.');
  if (!readme || typeof readme.text !== 'string') {
    return el('p', { class: 'muted' }, 'The README is not stored.');
  }
  let body = null;
  if (typeof lib.toSafeBlocks === 'function') {
    try {
      body = renderBlocks(lib.toSafeBlocks(readme.text, { maxBytes: 32768 }), { quarantined: false });
    } catch {
      body = null;
    }
  }
  return el('div', null, [
    el('p', { class: 'muted' }, [readme.name ?? 'README',
      readme.bytes ? ` · ${count(readme.bytes)} bytes` : null,
      readme.truncated ? ' · cut to the first part' : null]),
    body ?? plainText(readme.text),
  ]);
}

/**
 * A collapsible section.
 * @param {string} title
 * @param {any} body
 * @param {{open?: boolean, cls?: string}} [opts]
 * @returns {any}
 */
function section(title, body, { open = true, cls } = {}) {
  if (!body) return null;
  return el('details', { class: ['section', cls ?? null], open }, [el('summary', null, title), body]);
}

/**
 * @param {any[]} commits
 * @returns {any}
 */
function commitList(commits) {
  if (commits.length === 0) return null;
  return el('ol', { class: 'commits' }, commits.map((c) => el('li', null, [
    el('span', { class: 'muted' }, formatDate(c.at, { year: false })), ' ', String(c.headline ?? ''),
    c.authorLogin ? el('span', { class: 'muted' }, ` — ${c.authorLogin}`) : null,
  ])));
}

/**
 * @param {any} history the facts' `starHistory`
 * @returns {any}
 */
function starView(history) {
  const weeks = Array.isArray(history?.weeks) ? history.weeks : [];
  if (weeks.length === 0) return null;
  return el('div', null, [
    sparkline(weeks.map((/** @type {any} */ w) => w.gained)),
    el('p', { class: 'muted' }, `${count(history.gain4w ?? 0)} gained in the last four weeks; `
      + `${weeks.length} weeks shown, oldest first.`),
  ]);
}

/**
 * @typedef {object} DetailState
 * @property {{nwo: string | null, record: any, loading: boolean, error: string | null}} detail
 * @property {IndexEntry | null} entry the index entry of the repository, when it has one
 * @property {boolean} why whether the Why panel is open
 * @property {boolean} [overlay] shown full screen (narrow layouts)
 * @property {any} model
 * @property {{explain?: Function | null, toSafeBlocks?: Function | null}} lib
 * @property {string | null} [reasonMenu]
 * @property {string | null} [chord]
 * @property {string} now
 * @property {string} [mode]
 */

/**
 * An IndexEntry-shaped view of a record that is not in the index (a shared link, an added repo).
 * @param {string} nwo
 * @param {any} record
 * @returns {IndexEntry}
 */
function entryFromRecord(nwo, record) {
  const score = record?.score ?? {};
  const facts = record?.facts ?? {};
  return /** @type {IndexEntry} */ ({
    id: record?.id ?? nwo, nwo, lane: score.lane ?? 'look', gates: [],
    S: score.S, pointsMax: score.pointsMax, coverage: score.coverage, quality: score.quality,
    k: score.confidence?.k, kBand: score.confidence?.band, a: score.attention?.a, gem: score.gem,
    stars: facts.stars, forks: facts.forks, description: facts.description, lang: facts.primaryLanguage,
    createdAt: facts.createdAt,
    descriptors: (Array.isArray(score.descriptors) ? score.descriptors : [])
      .map((/** @type {any} */ d) => d.id),
  });
}

/**
 * Render the detail pane.
 * @param {any} root
 * @param {DetailState} state
 * @param {Dispatch} dispatch
 * @returns {void}
 */
export function render(root, state, dispatch) {
  const { detail } = state;
  const record = detail.record;
  const nwo = detail.nwo ?? state.entry?.nwo ?? null;
  const back = state.overlay
    ? button('Back to the queue', {
      key: 'Esc', cls: 'back', onClick: () => dispatch({ type: 'closeDetail' }),
    })
    : null;
  if (!nwo) {
    replace(root, el('div', { class: 'detail-empty' }, [
      el('p', null, 'Pick a card to see why it scored as it did.'),
      el('p', { class: 'muted' }, 'j and k move through the queue; e shows or hides the Why panel.'),
    ]));
    return;
  }
  const entry = state.entry;
  if (entry?.lane === 'quarantine' || record?.quarantined === true) {
    replace(root, el('article', { class: 'detail quarantined', 'aria-label': nwo }, [
      back,
      el('h2', null, nwo),
      el('p', { class: 'warning', role: 'note' }, WARNING),
      quarantineItem({ id: entry?.id ?? record?.id ?? nwo, nwo, gates: record?.gates ?? entry?.gates ?? [] }),
    ]));
    return;
  }
  const facts = record?.facts ?? null;
  const view = entry ?? entryFromRecord(nwo, record);
  const x = explanationFor(view, record, state.model, state.lib);
  const fb = /** @type {any} */ (view.feedback) ?? {};
  const saved = (typeof fb.last === 'string' ? fb.last : fb.last?.action) === 'gem';
  const commits = Array.isArray(facts?.commits?.recent) ? facts.commits.recent.slice(0, 20) : [];
  const S = numOrNull(record?.score?.S) ?? numOrNull(view.S) ?? 0;
  const licence = facts?.licence ? (facts.licence === 'NOASSERTION' ? 'a licence' : facts.licence) : null;
  const whyToggle = button(state.why ? 'Hide why' : 'Show why', {
    key: 'e', cls: 'why-toggle', expanded: state.why, onClick: () => dispatch({ type: 'why' }),
  });
  const whyBody = state.why ? [
    el('p', { class: 'rank-line' }, x.rankLine),
    waterfall(x.chips, S, numOrNull(view.pointsMax)),
    x.whyNotHigher.length > 0 ? [el('h4', null, 'Why not higher'), el('ul', { class: 'why-not' },
      x.whyNotHigher.map((w) => el('li', null, [el('b', null, `+${w.points || 1}`), ` ${w.label}`,
        w.hint ? el('span', { class: 'muted' }, ` — ${w.hint}`) : null])))] : null,
    x.raiseConfidence.length > 0 ? [el('h4', null, 'What would raise confidence'),
      el('ul', { class: 'raise' }, x.raiseConfidence.map((r) => el('li', null, r)))] : null,
    x.fromIndex && !record?.score ? el('p', { class: 'muted' }, 'Explained from the index; evidence links '
      + 'appear once the full score is stored.') : null,
  ] : null;
  const descriptors = Array.isArray(record?.score?.descriptors) && record.score.descriptors.length > 0
    ? el('ul', null, record.score.descriptors.map((/** @type {any} */ d) => el('li', null, [
      el('b', null, /** @type {Record<string, string[]>} */ (DESCRIPTORS)[d.id]?.[0] ?? d.label ?? d.id),
      d.detail ? ` — ${d.detail}` : null])))
    : null;
  const menuOpen = state.reasonMenu === view.id || state.chord === 'notgood';
  replace(root, el('article', { class: 'detail', 'aria-label': nwo }, [
    back,
    el('header', { class: 'detail-head' }, [
      el('h2', null, repoName(nwo, { link: false })),
      view.description ? el('p', { class: 'desc' }, view.description) : null,
      el('p', { class: 'meta-row' }, [
        laneBadge(view.lane),
        view.lang ? el('span', { class: 'lang' }, view.lang) : null,
        view.createdAt ? el('span', null, `created ${formatDate(view.createdAt)}`) : null,
        facts?.pushedAt ? el('span', null, `pushed ${relTime(facts.pushedAt, state.now)}`) : null,
        licence ? el('span', null, licence) : null,
        record?.example ? el('span', { class: 'badge example' }, 'Example') : null,
      ]),
      el('p', { class: 'links' }, [safeLink(`https://github.com/${nwo}`, 'Open on GitHub'),
        facts?.homepageUrl ? [' · ', safeLink(facts.homepageUrl, 'Demo')] : null]),
      descriptorChips(view.descriptors),
    ]),
    detail.loading ? el('p', { class: 'muted', role: 'status' }, 'Loading the full record…') : null,
    detail.error ? el('p', { class: 'error', role: 'alert' }, detail.error) : null,
    el('section', { class: ['why', state.why ? null : 'collapsed'], 'aria-label': 'Why' }, [
      el('h3', null, [whyToggle, ' ', el('span', { class: 'headline' }, x.headline)]),
      whyBody,
    ]),
    meters(view, record, state.model),
    triageBar(view, dispatch, { reasonMenu: menuOpen, saved, published: Boolean(fb.published) }),
    verdictView(record?.verdict ?? view.verdict),
    section('Descriptors', descriptors),
    section('README', facts ? readmeView(facts, state.lib) : null, { cls: 'readme-section' }),
    section('Tree', facts ? treeView(treeSummary(facts)) : null, { open: false }),
    section('Recent commits', commitList(commits), { open: false }),
    section('Stars by week', starView(facts?.starHistory), { open: false }),
    section('Support the project', supportLadder(nwo, facts), { open: false }),
  ]));
}
