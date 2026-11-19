# 2026-11-19 — live GitHub paths on the private sandbox

The three paths that had never run against GitHub, on
`lucasloepke/self-review-sandbox` (private). The author's choices at each stop
were made in the session. Leaf tier throughout; 17 agents in all.

## A — full default run on PR #1, which already had a report

| Step | Result |
|---|---|
| Gather | ✅ found the existing report comment, parsed its state block (5 findings, all Open) and stored brief |
| Review with prior findings | ❌ then ✅ — see *Fixed* below: a reworded Suggestion was raised again and an Important got a new id; after the fix the Important kept F-2ed5b6 and the Suggestion came back under `carried` |
| Skeptics | 3 / 3 confirmed |
| Fix, verify | 3 fixes; their new tests fail on the old code; 3 / 3 resolved; fix-diff review found nothing |
| Commit, push | ✅ one commit per finding, each naming its id |
| Post | ✅ **edited** the existing comment (2 comments before and after); verdict ✅ Ready for review; *Changes since the last run* right |

## B — `--update` after a new push to PR #1

The push added an "active filter" label that puts the raw `status` query
parameter into the page (planted reflected XSS).

| Step | Result |
|---|---|
| Gather `--since` | ✅ only the new commit (3 changed lines) |
| Reopened intent stop | the new label was not in the brief; confirmed, one acceptance criterion added |
| Re-verify | 3 / 3 earlier fixes still resolved on the pushed code |
| Review of new hunks | ✅ the planted XSS at Blocking, plus a real bug not planted: the label claims a filter this branch never applies, and a test gap |
| Triage | all three deferred (to exercise that path); skeptics skipped |
| Post | ❌ then ✅ — see *Fixed*: earlier findings would have dropped out of the report. After the fix: same comment edited again; 🟡 Ready with open items; the deferred Blocking listed under *Decisions worth a second opinion*; state holds all 8 findings |

## C — `--dont-stop` on a new PR #2 (the clean branch)

| Step | Result |
|---|---|
| Review | 0 serious findings; 1 Suggestion (blank status counts all orders) |
| Skeptic (don't-stop sends Suggestions it would fix) | reduced it to a Nit needing a product decision, so it was not auto-fixed |
| Post | ✅ no pause; new comment; verdict ✅ Ready for review |

## Fixed because of this run

- **Prior findings matched on wording only.** On a second run the reviewer
  reworded two findings: an already-raised Suggestion was raised again and an
  Important lost its id. Prior findings now also match on mostly the same
  quoted code plus some shared wording (`samePrior` in `review-workflow.js`;
  the real pair is a test).
- **Prior findings not raised again vanished.** A scoped `--update` (or a
  finding simply not seen again) left earlier findings out of the report and
  its state, so a later run could raise them again — run A had already lost
  the first run's Nit. `render-report.js` now carries every prior finding
  forward with its status or an updated decision.
- **`--update` re-verified every open finding, Suggestions included.** Only
  Blocking and Important findings are re-verified now; Suggestions and Nits
  were raised once.
- **Which head a report records after fix commits.** The new head, since the
  fixes were verified, so the next `--update` starts after them (SKILL.md).
