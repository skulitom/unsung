# Blind checks of the first live runs — 11 September 2026

## What was measured

The first live run (`unsung run`, quick profile, ten minutes) censused 3,006 repositories created on
8 September 2026, enriched 484 of them and ranked 130 as Promising. From that run a seeded sample
(seed `20260911`) of 65 repositories was drawn in four strata:

- **Top 25** — the 25 highest-ranked repositories in the gem lanes;
- **Rest of the gem band** — 10 at random from the other 105 gem-band repositories;
- **Worth a look** — 15 at random from the 139 repositories with 5 or 6 points;
- **Low** — 15 at random from the 213 repositories scored 4 points or fewer.

Every repository was labelled blind with the eight categories of DESIGN §1.2. The labeller saw only
`owner/name`, read the repository through the GitHub API (README, file tree, two or three source
files and a test), and never saw its stars or anything Unsung had computed. The top 25 were
labelled twice, by independent labellers who did not know which stratum they were reading.

The labellers were Claude subagents, not people. Treat these numbers as a strong indication rather
than the final word; the human calibration loop of DESIGN §14.3 remains the ground truth.

The per-repository labels are not published. They are fresh judgements of other people's work,
most of it days old, so this write-up names repositories only where the finding is to their credit
and describes the rest without names.

## Results

| Stratum | Repositories | Genuine (G) | G or W | Share genuine |
|---|---:|---:|---:|---:|
| Top 25 | 25 | 22 | 22 | **0.88** |
| Rest of the gem band | 10 | 9 | 9 | 0.90 |
| Worth a look | 15 | 11 | 11 | 0.73 |
| Low | 15 | 4 | 5 | 0.27 |

- The two labellers agreed on 24 of the top 25. The one split is a rebranded fork with modest work
  of its own.
- Points separate genuine repositories from the rest with an AUC of 0.80 over all 65. That is lower
  than the 0.96 measured on the research labels, partly because the sample is drawn from a queue
  already ordered by the free prior, which compresses the range.
- DESIGN §14.4 sets a target of at least 0.7 for blind precision of the gem shelves at 20; the first
  live run reaches 0.88 at 25.

## Where it went wrong

**False positives in the gem band** (4 of 35, plus the split):

| Rank | Points | What the labellers found |
|---:|---:|---|
| 4 | 10 | a re-upload of another author's project, with the README's URLs rewritten |
| 14 | 9 | a learning sandbox: the same thirteen placeholder components in eight frameworks |
| 16 | 9 | a re-upload: 99 of 106 commits are upstream's, about 800 lines of its own |
| — | 7 | a README copied from another project, over leftover code; its clone instructions name that other project, so `s.cloneUrl` (which needs the same repository name) did not fire |

**Missed gems.** 11 of the 15 Worth a look repositories and 4 of the 15 Low ones are genuine. Several
keep their tests outside the root (`Shadorain/omp-prompt-refine`, `vosslab/djot-slide-builder`,
`eamigo86/HyperTodo`), which only the deep stage can see, and in this run deep reached 6 of its top
50. Others are small but complete tools in ecosystems with little metadata: an Android timer, a
Chrome extension, a BepInEx game mod. Recall, not precision, is the weaker side of v0.1.

When the 30 Worth a look and Low repositories were scored again with full deep facts, 3 of the 15
genuine ones reached the gem band, and so did 2 of the 15 that were not genuine. The deep stage
helps, but the rest of the recall gap belongs to the Worth a look shelf and the optional review.

## Re-upload heuristics tested and rejected

Three cheap rules were checked against the labels on the 50 stored records:

| Rule | Catches re-uploads and clones | Also hits genuine repositories |
|---|---|---|
| owner authored fewer than half of the last 20 commits | the rank-16 re-upload and a copied portfolio template | eight, whose commits sit under unlinked e-mail addresses or other accounts |
| history predates creation by more than 30 days (`d.imported`) | the same two | two, among them an emulator built on MAME with substantial work of its own |
| the description says "fork" or "based on" | the rank-16 re-upload | the same emulator; the rebranded fork split the labellers |

None separates re-uploads from genuine derivative work, and the rank-4 re-upload passes all three.
So `d.imported` stays a neutral descriptor, and re-uploads are left to the optional LLM review
(its `re_upload` and `tutorial_clone` flags send a repository to Doubted) and to the content-level
checks planned for v0.2 (near-duplicate detection, the LICENSE-holder check, the root-commit rule).

## The second run, after the review's fixes

The review that followed the first run fixed three things in the pipeline: the GH Archive lane's
share of the budget, a wall-clock reserve for the deep stage, and the order of the census hours.
The second live run (20:37–20:47 UTC, same store) read one GH Archive hour (2,069 release and
publication events, 940 candidates), deepened 50 of its top 50 and ended "finished" at 586 s. It
put the first 8 repositories in the Proven lane and quarantined 3.

A second seeded blind check (seed `20260912`, the same protocol) labelled all 8 Proven
repositories twice, 12 new Promising repositories drawn at random (all from the archive lane), and
the 3 quarantined ones, which were read as text only.

| Stratum | Repositories | Genuine | Notes |
|---|---:|---:|---|
| Proven | 8 | 8 | both labellers agreed on all 8 |
| New Promising (archive lane) | 12 | 12 | |
| Quarantine | 3 | 1 | one real malware lure, one genuine app, one near-empty repository |

The quarantine, in detail:

- **A real malware lure**: a one-commit copy of a popular censorship-circumvention tool with its
  download links rewritten, whose 13 MB batch file writes a base64-encoded executable into `%TEMP%`
  and runs it. `g.lure.script` and `g.lure.link` caught it.
- **A genuine app**: a Flutter app that commits an 83 MB APK built from its own source and links it
  from the README, from an account under 90 days old. It is a false positive of `g.lure.link`. The
  error is on the safe side (the repository is hidden, not harmed), and it is exactly the case the
  gate audit of DESIGN §7.5 exists for.
- **A near-empty repository**: six PNG images and a one-line README. A lure word in its name
  matched, but there is nothing malicious in it.

Three labels are far below the 20 that §7.5 needs before a gate may be demoted, so the gates stay
as they are and the weekly audit sample will decide. One labeller also noted that a genuine
repository had ten releases published within seconds of each other: a reminder that server-stamped
times can be staged, which is why `p.shipped` and `k.releases` ask for releases on distinct days
spread over weeks.

## What changed because of these checks

- The pipeline fixes above.
- Weights `w2` retired the provisional `s.incoherent` penalty: of its five known firings, four were
  on genuine repositories (DESIGN §5.3, note ²).
- No re-upload rule was added, for the reasons above.
