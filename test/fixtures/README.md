# Test fixtures

> **Notice.** These files hold excerpts of public GitHub repositories (metadata, file listings and
> README text capped at 8 KB), kept **for testing only**. They are not a mirror and are never
> served or published. Any repository's fixture is **removed on request**: open an issue naming
> the repository and its directory under `repos/` is deleted and the sets below are adjusted.

Everything here is data for `npm test`. Tests never touch the network, never read `data/`, and
never spawn `claude`. Formats follow DESIGN §14.2; this file records the details that section
leaves open, and where every file came from. `redteam/` belongs to WP3 and `llm/` to WP5.

## Layout

| Path | What it is |
|---|---|
| `labelled/labels.json` | `{nwo: {cat, flags, note, stratum}}` — the 149 hand labels of the haystack study |
| `repos/<owner>__<name>/meta.json` | provenance, label, stratum, named set and `expect` (below) |
| `repos/<owner>__<name>/enrich.json` | one repository node in the §3.5 ENRICH shape |
| `repos/<owner>__<name>/enrich.research.json` | the converted research snapshot, kept beside a recorded `enrich.json` |
| `repos/<owner>__<name>/deep.json` | the §3.6 Deep fragment node |
| `repos/<owner>__<name>/files.json` | `{path: {byteSize, text} \| null}` — workflow files and a manifest (§3.6 step 5) |
| `repos/<owner>__<name>/tree.json` | recursive tree: `{sha, truncated, tree: [{path, type, size?}]}` |
| `repos/<owner>__<name>/activity.json` | one page of `/activity`: `[{id, ref, timestamp, activity_type}]` |
| `repos/<owner>__<name>/stars.json` | `/stargazers/history?per_page=8`: `[{week, total, days}]`, newest first |
| `github/graphql/<name>.json` | `{request: {query, variables}, status, headers, body}` |
| `github/rest/<name>.json` | `{request: {path}, status, headers, body}` |
| `search/<name>.json` | recorded census pages: a normal window and a saturated one |
| `gharchive/2026-09-10-15.sample.json.gz` | 502 lines of one GH Archive hour |
| `index.sample.json` | an Index (§4.3) of 38 entries for UI work |

Directory names keep the repository's original case (`skulitom__london-time-map`); they are not
`repoPath()` names, which §4.1 reserves for `data/`.

## Provenance

- **Research conversion.** `node tools/convert-research.mjs research/raw/haystack` (the research
  directory is kept out of git). The snapshots were fetched on 11 September 2026 by
  `deep_fetch.py`; `meta.recordedAt` is each snapshot's file time. Stratum `search` is the 80
  repositories of samples S1–S8 (`picked.json`), `uniform` the 69 of the ID walk (`U_new`,
  `U_old`). 147 repositories have a snapshot; `asot8tn56n/mseauu` and `m1lwmpmzom/ovxmxv` answered
  HTTP 502 in research and are `meta.json`-only fixtures labelled X.
- **Live recording**, 11 September 2026, with `tools/record-fixtures.mjs` and the §3 documents
  verbatim:
  1. `--set named --census --samples` — the four named sets with deep responses, both census
     windows, and the `github/` samples;
  2. `--set rostamlabs/rostam --set llamastash/llamastash` — two repositories past the star cap,
     taken from the archive lookup, so the Graduated lane has real members (not a named set);
  3. `--set seeds` — re-recorded the seed gems so that the `github/` batch samples show them.

  Budget used in total: 13 searches (≥ 2.5 s apart), 40 GraphQL points and 116 REST requests.
  No named repository had vanished, so none fell back to its research snapshot; had one done so,
  `meta.source` would read `research` and `meta.recording` would say why.
- **GH Archive.** `node tools/sample-gharchive.mjs --hour 2026-09-10-15`: the hour held 36,654
  events; the sample keeps 248 ReleaseEvents (10 of them prereleases), all 22 PublicEvents,
  170 PushEvents and 62 others, in their original order, byte for byte. Lines carrying an e-mail
  address were skipped, so the sample is biased, not uniform. **Two lines contain a raw U+2028
  naturally** (sample lines 91 and 304); nothing was inserted.
- **Index sample.** `node tools/make-index-sample.mjs` (see below).

## `meta.json`

| Field | Meaning |
|---|---|
| `source` | `recorded` (live) or `research` (converted snapshot) |
| `recordedAt` | when the data was fetched; `null` only for the two meta-only fixtures |
| `nwo` | `owner/name` as asked for |
| `label`, `stratum`, `sample` | labelled repositories only: category, `search` or `uniform`, research sample |
| `set`, `expect` | named-set repositories only (below) |
| `readme` | `{name, originalBytes, keptBytes, excerpt}` — whether the README text is an excerpt |
| `labelledSnapshot` | `"enrich.research.json"` when a labelled repository was also recorded |
| `researchRecordedAt`, `researchReadme` | provenance of that research snapshot |
| `deep` | what the deep stage fetched: tree entries, truncation, activity events, files, stars |
| `recording` | present when a recording attempt found the repository gone |
| `missing` | why a fixture has no snapshot |
| `nameWithOwnerNow` | present when the repository answers under a new name |

**Which snapshot a label belongs to.** The research labels and every number measured in DESIGN
(§5.3 evidence, §6.2 calibration, AUCs) were made on the research snapshots. For the 27 labelled
repositories that were also recorded, that snapshot is `enrich.research.json`; evaluation code
that should reproduce the design's numbers reads `meta.labelledSnapshot` when it is present.
Measured this way the fixtures give pooled AUC 0.961 and uniform AUC 0.945, 6 of 6 genuine at
`S ≥ 7` on the uniform stratum, and the root-level firing counts of §5.3 exactly, with the two
exceptions under *Caveats*.

### `expect` (named sets of §14.2)

`lane` (a lane or a list of acceptable lanes), `notLane`, `band` (a band or a list), `minS`,
`maxS`, `gates`, `outcome` and `setRule`; `null` or absent means no expectation.

- `gates: []` — no quarantine, drop or doubt gate fires (`g.institutional` marks a lane and may);
  a non-empty list — at least one of those gate ids fires.
- `outcome` — `quarantined` or `dropped`, for the lure and spam set.
- `setRule` — holds over the set, not one repository (the hard negatives' median `S` is below
  the seed gems' median).

| Set (`meta.set`) | Repositories | `expect` |
|---|---|---|
| `seedGems` | the 11 of §14.2 | `lane: ["promising","proven"]`, `band: "gem"`, `minS: 7`, `gates: []`; `ask-my-tabs` also allows `look` with `minS: 5` |
| `hardPositives` | the 5 of §14.2 | `gates: []`; `streamer` `minS: 7` |
| `hardNegatives` | the 7 of §14.2 | `notLane: ["proven"]`, `setRule` |
| `luresAndSpam` | the 5 of §14.2 | `crush-flake` → `g.lure.link`, `zaPReTTeLeGrAM` → `g.lure.script` (quarantined); `tohuys` → `g.spam.streak`/`g.spam.farm`, `henry2026a/…` → `g.spam.farm`, `darapalwinanet` → `g.spam.streak` (dropped) |

## `enrich.json`

The node GitHub returned for one alias of the §3.5 enrich query, with three fixture rules:

1. **`readme.name`** is added (§14.2: "with its name"). A README that only the README-repair query
   found (`gene-git/wg-client` → `README.rst`) is folded into `readme` under its real name; the
   raw repair response is `github/graphql/readme-repair.json`.
2. **README text is capped at 8 KB.** `byteSize` stays the true size. A longer README becomes an
   *excerpt* that keeps what the rules read: the first 4 KB exactly (template, spam and script
   rules), then later lines in original order by priority — every fence line, any line a gate
   reads (clone URLs, archive or executable links, file hosts, HTML comments, invisible
   characters, reviewer-addressing and drainer phrases, gambling words), the opening lines of each
   fenced block, the rest of the fenced blocks, then prose. A plain 8 KB cut would have removed
   the second code block from 16 of the 49 long research READMEs and flipped `q.usage` on 11
   genuine repositories; the excerpt keeps every fence count and gate line (checked on all 49).
   README references for `p.coherent` in dropped prose can be lost, so that signal may differ
   from a live run on a long README. `package.json`, workflow and manifest texts are capped at
   16 KB (§4.1).
3. Nothing else is changed. Research snapshots were mapped as §14.2 says: `r1`…`r6` → `readme`,
   `pkg`, `wf` and `root` as they were, languages trimmed to 8 and topics to 12, histories to 20
   nodes; `hasDiscussionsEnabled`, `oid`, `statusCheckRollup`, release `nodes`, organisation
   repository counts and contribution years are **absent**, so the signals that need them are
   `unknown`. Commit bodies and author names and e-mail addresses were dropped. `id` is present
   for the search stratum (from the research search results) and absent for the uniform stratum,
   whose research run did not record it.

## Deep-stage files

Recorded for all 28 named repositories and the two graduated examples. `tree.json` keeps at most
5,000 entries (`meta.deep.treeCapped` says whether the cap bit) and drops each entry's `sha`, `mode`
and `url`. `activity.json` keeps the four fields §3.6 reads. `stars.json` is exactly GitHub's
answer: `week` is a Unix time in seconds and `total` the stars gained that week; it exists only at
three stars or more. `files.json` maps each fetched path to its blob, `null` when absent.

## `github/` samples

| File | Shows |
|---|---|
| `graphql/enrich-batch.json` | an 11-repository enrich batch (the seed gems) |
| `graphql/readme-repair.json` | the README repair query (`$e0 = "HEAD:README.rst"`) |
| `graphql/deep-batch.json`, `graphql/files-batch.json` | a Deep batch of five and its file fetches |
| `graphql/exists.json` | the §3.7 re-check over ten ids plus one unknown id → a `NOT_FOUND` node |
| `graphql/archive-lookup.json` | a lean lookup of 100 repositories from the archive sample; alias `r53` is `NOT_FOUND` |
| `rest/tree.json`, `rest/activity.json`, `rest/stargazers-history.json` | deep REST responses (slimmed as above) |
| `rest/activity-304.json` | the same activity request with `If-None-Match` → 304, empty body |
| `rest/repo.json`, `readme.json`, `contents-root.json`, `releases.json`, `commits.json` | the §3.10 REST fallback set for `zaghaghi/toolog` |
| `rest/repositories-since.json` | `/repositories?since=1365300000` for the ID walk |
| `rest/not-found.json` | a 404 |

Only these response headers are kept: `content-type`, `date`, `etag`, `last-modified`, `link`,
`retry-after`, `x-github-api-version-selected` and `x-ratelimit-*`. Request headers are never
stored. REST bodies are slimmed where they carry bulk or personal data: `readme.json` holds the
8 KB excerpt (base64), `commits.json` keeps sha, message, dates and logins (no names or e-mail
addresses), `releases.json`, `contents-root.json` and `repositories-since.json` keep the fields
the fallback reads, and `repo.json` drops the viewer-specific `permissions`.

GitHub answered the conditional activity request (`If-None-Match: W/"…"`) with a 304 whose
`etag` is the *strong* form `"…"`; an HTTP cache should compare the opaque tag, not the string.

### Query assembly

The §3 texts are used verbatim; DESIGN does not fix how aliased documents are assembled, so the
recorder does it like this (`tools/lib/queries.mjs`), and WP1's builders should match:

```graphql
query($o0: String!, $n0: String!, $o1: String!, $n1: String!) {
  rateLimit { cost remaining resetAt }
  r0: repository(owner: $o0, name: $n0) { ...Enrich }
  r1: repository(owner: $o1, name: $n1) { ...Enrich }
}
fragment Enrich on Repository {
  …the §3.5 fragment, verbatim…
}
```

The operation comes first (so the read-only guard sees `query`), then the fragment, then a newline.
Deep and lean lookups are the same with `...Deep` and `...Lean` (`fragment Lean on Repository`
wraps the §3.2 node fields). Object expressions that come from repository content are variables,
never interpolated: README repair uses `readme: object(expression: $e<i>)` and file fetches
`f<j>: object(expression: $e<i>_<j>)`, with values such as `"HEAD:README.rst"`. The re-check is
`query($ids: [ID!]!) { rateLimit {…} nodes(ids: $ids) { … } }`. Census pages send the §3.2
document with `{q, first: 100}` on the probe and `{q, first: 100, after}` after it.

## `search/`

`{name, day, scope, fromIso, toIso, unitKey, q, recordedAt, repositoryCount, saturated, pages}`,
each page an envelope as above.

- `normal-2026-09-08T0400.json` — `created:2026-09-08T04:00:00Z..2026-09-08T04:07:59Z`, 224 hits,
  a probe and two pages with crafted cursors (`cursor:100`, `cursor:200`); 224 distinct nodes.
- `saturated-2026-09-08T14.json` — the 14:00 hour, 2,734 hits, paged to the 1,000-result cap: the
  probe and nine crafted-cursor pages (`cursor:100` … `cursor:900`, never `after + first > 1000`),
  1,000 distinct nodes. No real ≤ 60 s window exceeds 1,000 under the base query, so this is the
  response shape a saturated leaf produces rather than a leaf the planner would reach.

## `gharchive/`

Gzipped NDJSON exactly as GH Archive serves it. Split it on `\n` by hand: a `readline`-style
split also breaks at U+2028 and turns lines 91 and 304 into two halves that do not parse.

## `index.sample.json`

Built by `node tools/make-index-sample.mjs` with the real pipeline: every repository fixture with
an enrich snapshot becomes Facts (the enrich node plus any recorded deep responses), is scored by
`applyScore` (`scoreFacts`) with the files in `config/`, and indexed by `buildIndex`; the sample
then keeps a quota per lane, seed gems first, then recorded fixtures, then by rank. It is for UI
work only. All eight lanes appear: `promising` 14, `proven` 3 (`duckdb_rdkit`,
`terraform-provider-pfsense`, `hookaido`), `look` 8, `doubted` 3, `institutional` 5 (allow-listed
organisations), `rising` 1 (`montezuma-p/harken`, 13 stars in four weeks), `graduated` 2
(`rostamlabs/rostam`, `llamastash/llamastash`) and `quarantine` 2 (`crush-flake` by `g.lure.link`,
`zaPReTTeLeGrAM` by `g.lure.script`). Two parts are illustrative rather than computed:

- `verdict` on three entries: its category is the repository's research label (`C` for
  `HaveNiceDa/My-Notion`, `S` for `AKzar1el/god-prompt`, `G` for `codefly-dev/cli`), its claims
  quote the README verbatim, its effect follows §8.5 (−2 and Doubted, or +1) and the record says
  `illustrative: true`. No LLM was run. The third doubted entry, `kagura-agent/wiki`, is doubted by
  `g.injection`: its README says "as an AI agent".
- `lastRun` describes the fixture recording as a RunSummary.

`node tools/make-index-sample.mjs --check` prints the §5.3 firing counts and AUCs of the real
signals on the research snapshots; `--report` scores each named-set fixture against its `expect`
with the real scorer.

## Re-recording

```sh
node tools/convert-research.mjs research/raw/haystack          # offline
node tools/sample-gharchive.mjs --hour 2026-09-10-15           # data.gharchive.org only
node tools/record-fixtures.mjs --set named --census --samples  # api.github.com; needs gh or GITHUB_TOKEN
node tools/record-fixtures.mjs --set seeds
node tools/make-index-sample.mjs
```

The recorder takes the token from `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token` inside its own
process, never prints it, sends it only to `api.github.com`, and refuses to write any file that
would contain it. It stops at `--max-search 25`, `--max-points 400` and `--max-rest 400`. An
ad-hoc `--set owner/name` list never overwrites the `github/` samples. `--set labelled` exists for
the first calibration task of §14.3.

## Caveats

- **`montezuma-p/harken` is Rising.** It gained 13 stars in the four weeks before recording (12 in
  the newest week), so §6.7 rule 5 puts it in `rising`, not the `promising` or `proven` its seed
  expectation names. Its `expect` is left exactly as §14.2 states.
- **`HaveNiceDa/My-Notion` with deep data.** The approximate scorer gives it `S = 9` and `K = 0.55`,
  which is `proven` unless a verdict demotes it; §14.2 says a hard negative is never proven.
- **`lexicons.aiAddress`.** Without word boundaries the §7.2 pattern `as an? (AI|LLM|…)` also
  matches "as an Airflow connection" (`gbazad93/AirFlow-ML-Data-Integration`); with `\b…\b` it
  fires only on `kagura-agent/wiki`. No genuine fixture is affected either way.
- **`s.webui`.** On the fixtures the §5.3 rule as written ("at least 4 commits") fires on 0 / 7;
  the evidence column's 0 / 9 was measured without that floor (two coursework repositories have
  two commits each).
- **`q.tests`.** The §5.2 test paths give 33 / 8 on the research snapshots; the evidence column's
  36 / 8 came from a wider list of test directory names (`specs/`, `integration_test/`, …).
- No 502 or `RESOURCE_LIMITS_EXCEEDED` response was recorded (none occurred); script them with
  `test/support/fake-fetch.mjs`. No `graphql/enrich-not-found.json` exists because no named
  repository had vanished; the `NOT_FOUND` shapes are in `exists.json` and `archive-lookup.json`.
- The research snapshots of the seed gems predate their recordings by one to two hours; the
  recorded data can differ from them (new commits, releases, stars).
