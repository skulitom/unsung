// @ts-check
/**
 * The named fixture sets of DESIGN §14.2 and the `meta.expect` each fixture carries.
 *
 * `meta.expect` fields (all optional; `null` means "no expectation"):
 * - `lane`: a lane or a list of acceptable lanes;
 * - `notLane`: lanes the repository must never land in;
 * - `band`: a band or a list of acceptable bands;
 * - `minS`, `maxS`: bounds on points `S`;
 * - `gates`: `[]` means no quarantine, drop or doubt gate may fire (`g.institutional` marks a lane,
 *   not a verdict on quality, and may fire); a non-empty list means at least one of these gate ids
 *   fires (the §7.2 rule named for that repository);
 * - `outcome`: `quarantined` or `dropped` for the lure and spam set;
 * - `setRule`: an expectation that holds over the whole set rather than one repository;
 * - `note`: why an expectation departs from its set's default (documentation only).
 */

/** @typedef {'seedGems' | 'hardPositives' | 'hardNegatives' | 'luresAndSpam'} SetName */
/**
 * @typedef {{lane?: string | string[] | null, notLane?: string[], band?: string | string[] | null,
 *   minS?: number | null, maxS?: number | null, gates?: string[], outcome?: string, setRule?: string,
 *   note?: string}} Expect
 */

/** Seed gems: lane `promising` or `proven`; `ask-my-tabs` may be `look`. */
export const SEED_GEMS = [
  'codefly-dev/cli', 'inamdarmihir/ask-my-tabs', 'sakajunquality/bunko', 'zaghaghi/toolog',
  'dragonGR/Dropzone', 'wonderingStars/foxsdr', 'montezuma-p/harken', 'nuetzliches/hookaido',
  'bodowd/duckdb_rdkit', 'elacy/terraform-provider-pfsense', 'skulitom/london-time-map',
];

/** Hard positives: not gated; `streamer` (emoji README) reaches 7 points. */
export const HARD_POSITIVES = [
  'gene-git/wg-client', 'legandrop/LGA_NukeShortcuts', 'YQ-RZJ/three.cj', 'HUIXI-AI/RhinoForge',
  '07prajwal2000/streamer',
];

/** Hard negatives: median `S` below the seed median; never `proven`. */
export const HARD_NEGATIVES = [
  'HaveNiceDa/My-Notion', 'ellmos-ai/bach', 'gtfo-ai/platform', 'AKzar1el/god-prompt',
  'gbazad93/AirFlow-ML-Data-Integration', 'ogforange-coder/CodenameEngine-Mobile', 'OBDb/Mazda-3',
];

/** Lures and spam: quarantined or dropped by the §7.2 rule named in `expect.gates`. */
export const LURES_AND_SPAM = [
  'islna637/crush-flake', 'TigerSeparate/zaPReTTeLeGrAM', 'd557wgl3zj/tohuys',
  'henry2026a/bishe-ssm-vue-js-1788757134', 'DaraPalwina/darapalwinanet',
];

/**
 * Seed gems whose recorded star history shows a gain of 10 or more in the last four weeks: by §1.1
 * they are no longer unsung, and §6.7 rule 5 puts them in `rising` (DESIGN §14.2).
 */
const RISING_SEEDS = new Set(['montezuma-p/harken']);
const RISING_NOTE = 'gained 13 stars in the four weeks before recording, so §6.7 rule 5 may make it rising';

/** @type {Record<string, Expect>} */
const LURE_EXPECT = {
  'islna637/crush-flake': { outcome: 'quarantined', lane: 'quarantine', gates: ['g.lure.link'] },
  'TigerSeparate/zaPReTTeLeGrAM': { outcome: 'quarantined', lane: 'quarantine', gates: ['g.lure.script'] },
  'd557wgl3zj/tohuys': { outcome: 'dropped', lane: null, gates: ['g.spam.streak', 'g.spam.farm'] },
  'henry2026a/bishe-ssm-vue-js-1788757134': { outcome: 'dropped', lane: null, gates: ['g.spam.farm'] },
  'DaraPalwina/darapalwinanet': { outcome: 'dropped', lane: null, gates: ['g.spam.streak'] },
};

/** @type {Record<SetName, string[]>} */
export const NAMED_SETS = {
  seedGems: SEED_GEMS,
  hardPositives: HARD_POSITIVES,
  hardNegatives: HARD_NEGATIVES,
  luresAndSpam: LURES_AND_SPAM,
};

/** Recorder `--set` names → the sets they cover. */
export const SET_ALIASES = {
  seeds: /** @type {SetName[]} */ (['seedGems']),
  hard: /** @type {SetName[]} */ (['hardPositives', 'hardNegatives']),
  spam: /** @type {SetName[]} */ (['luresAndSpam']),
  named: /** @type {SetName[]} */ (['seedGems', 'hardPositives', 'hardNegatives', 'luresAndSpam']),
};

/**
 * The set a repository belongs to, or null.
 * @param {string} nwo
 * @returns {SetName | null}
 */
export function setOf(nwo) {
  const key = nwo.toLowerCase();
  for (const [name, list] of Object.entries(NAMED_SETS)) {
    if (list.some((n) => n.toLowerCase() === key)) return /** @type {SetName} */ (name);
  }
  return null;
}

/**
 * `meta.expect` for a named-set repository, or null for any other.
 * @param {string} nwo
 * @returns {Expect | null}
 */
export function expectFor(nwo) {
  const set = setOf(nwo);
  const key = nwo.toLowerCase();
  if (set === 'seedGems') {
    if (key === 'inamdarmihir/ask-my-tabs') {
      return { lane: ['promising', 'proven', 'look'], band: ['gem', 'look'], minS: 5, maxS: null, gates: [] };
    }
    if (RISING_SEEDS.has(key)) {
      return { lane: ['promising', 'proven', 'rising'], band: 'gem', minS: 7, maxS: null, gates: [],
        note: RISING_NOTE };
    }
    return { lane: ['promising', 'proven'], band: 'gem', minS: 7, maxS: null, gates: [] };
  }
  if (set === 'hardPositives') {
    const minS = key === '07prajwal2000/streamer' ? 7 : null;
    return { lane: null, band: null, minS, maxS: null, gates: [] };
  }
  if (set === 'hardNegatives') {
    return {
      lane: null, notLane: ['proven'], band: null, minS: null, maxS: null,
      setRule: 'the median S of the hard negatives is below the median S of the seed gems',
    };
  }
  if (set === 'luresAndSpam') {
    const entry = Object.entries(LURE_EXPECT).find(([n]) => n.toLowerCase() === key);
    return entry ? { band: null, minS: null, maxS: null, ...entry[1] } : null;
  }
  return null;
}
