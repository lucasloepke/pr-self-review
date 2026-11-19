# 2026-11-19 — UI branch on a private sandbox PR

First run against GitHub: `feature/order-status-badge` pushed to a private
sandbox repo, PR #1, report posted there. Deliberately cheap: the brief came
from the key (no brief agent), Leaf tier (one reviewer), one image-check
agent, and **no skeptics** (`--final` marked them not run). Two agents in all.

## What ran, and how it went

| Step | Result |
|---|---|
| `gather.sh 1` on a live PR | ✅ PR metadata, partitioned diff; `ci: none` (the sandbox has no CI) |
| `classify.js` | ✅ Leaf; `styles.css` visual. `src/views/pages.js` came out "behaviour" — fixed: server-rendered views and templates are now visual |
| `scan.js` | ✅ no leads (nothing secret-shaped added) |
| `run-checks.js` | ✅ tests pass, no regression; proof: 1 test fails on base, passes on head |
| `capture.js` | ✅ ~4 s; `/orders` and `/customers` both flagged changed. The customers screenshot shows the planted regression: VIP pills become full-width blocks with white text on pale yellow |
| Image check (1 agent, 4 images) | ✅ all clean; it also noticed the near-invisible VIP text unprompted |
| `publish-assets.sh` | ✅ 4 images on `self-review-assets`, checkout untouched. GitHub's "create a pull request" hint leaked into output — now suppressed |
| `post-report.sh` | ✅ first live post |

## Scores (`node eval/score.js feature/order-status-badge`)

| Measure | Result |
|---|---|
| Catch rate | 2 / 2 — V1 (global `.badge` breaks the customers page) and V2 (status not escaped) both raised at Blocking by a single Leaf reviewer |
| Real findings beyond the key | 2, now in the key: R1 (a status with no colour rule renders unreadable) and R2 (two acceptance criteria untested) |
| Duplicates | 1 — a Nit restating V1 (the stylesheet comment heads a rule that restyles every badge) |
| Noise | 0 |
| Skeptic | not run, by choice |

## Image hosting on a private repo

GitHub kept the three image URLs in the comment as written (no camo proxy),
so the viewer's browser loads them with the viewer's own session. Signed out,
both the `github.com/…/blob/…?raw=true` and the `raw.githubusercontent.com`
URL return 404 — nothing leaks. Signed in, the report's before/after
screenshots (`<img>` + `github.com/…/blob/<commit>/…?raw=true`) render:
confirmed by eye on 2026-11-19. Settled: that URL form is what
`publish-assets.sh` prints and the report uses.
