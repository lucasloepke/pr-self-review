# pr-self-review — implementation plan (light)

A Claude Code skill that reviews **your own** PR before you ask a human to look at it:
confirm what it is meant to do, prove it does that without breaking anything, have
independent reviewers attack it, fix what survives verification, and leave one
uniform report comment on the PR.

Status: plan only. Nothing is implemented yet.

## Modes

| | Default | Don't stop (`/self-review --dont-stop`, or "self-review, don't stop") |
|---|---|---|
| Confirm intent | Stops for a yes | Stops for a yes |
| After findings | Shows findings, asks **"Continue with fixes, or chat about it?"** | Continues |
| Fixes | The findings the author approved | Every verified Blocking, Important and Suggestion with a clear fix; Nits are listed, not fixed |
| Push + post report | Shows the comment, asks | Pushes and posts |

Intent is the one stop in both modes: it is the only input the skill cannot
derive, and everything after it is judged against it.

Even in don't-stop mode, two kinds of finding are never auto-fixed and go to the
report as `Open — needs author decision`: ones whose fix needs a product or
design choice, and ones the skeptic could not confirm (*plausible*) where the
fix would change behaviour. Don't-stop means no pauses, not guessing.

Nits are capped at zero auto-fixes in don't-stop mode. Reviewer + skeptic
agreement is good evidence that a *defect* is real, but for matters of taste it
only shows two runs of the same model share a preference — and every extra
commit is more diff for the human reviewer. Nits stay in the report as
`Deferred`; default mode can still fix them if the author asks.

## Review depth

Depth follows what is changing, not how many lines changed. Phase 1 sorts every
changed area into a tier; each area is reviewed at its own tier, and the PR as a
whole takes the highest tier present.

| Tier | What lands here | How it is reviewed |
|---|---|---|
| **Core** | Infrastructure, auth, data layer and migrations, build/deploy config, payments, public API | **Deep read.** Whole files, not just hunks; every caller traced; three reviewers (the third on security + compatibility); full regression and e2e. |
| **Shared** | Utilities, hooks, shared components, anything imported from several places | **Careful review.** Every call site of a changed signature or behaviour checked; two reviewers; e2e on at least one consumer per changed behaviour. |
| **Leaf** | Presentational components, copy, styling, a single screen | **Proof-led.** Light code read by one reviewer; the weight is on evidence that it looks and behaves right (see Proof). |
| **Inert** | Docs, comments, non-shipping config | Skim for accuracy; no reviewers. |

How an area gets its tier, in order of precedence:

1. The repo's own config (`.self-review.yml`: path globs → tier), when present.
2. **Fan-in**: how many files import the changed module. High fan-in is Shared
   at least, whatever the folder is called.
3. Path and content heuristics (`auth/`, `migrations/`, `infra/`, CI files,
   `components/ui/`, `*.css`, `*.md`).
4. When unsure, the higher tier.

The tier of each area is shown at intent confirmation, so the author can
correct it at the one stop that always happens, and is printed in the report.

## Proof

Every report carries evidence that the change does what the intent says — a
claim of "works" without an artifact is not accepted. What counts depends on
the kind of change:

| Change | Required proof |
|---|---|
| Visual / UI | **Before and after screenshots, side by side**, same route, viewport and data; both themes or breakpoints when the change affects them |
| Behaviour (bug fix, feature) | A test that fails on the base and passes on the head, plus the e2e evidence from phase 4 |
| API / CLI | Request and response, or command and output, before and after |
| Performance | The measurement, before and after, with the command that produced it |
| Refactor (no behaviour change) | Same test results on base and head; no change in public surface |
| Docs / inert | None |

**Before/after screenshots — how.** The base is checked out into a temporary
git worktree; base and head are each built and served on their own port; the
same routes are captured from both with a headless browser at fixed viewport,
with animations off and seeded data. Routes come from the acceptance criteria
and from mapping changed components to the pages that render them.

**Getting images into the comment.** GitHub has no API for uploading comment
attachments, so images are committed to a dedicated orphan branch in the same
repo (`self-review-assets`, one folder per PR and head SHA) and the comment
links them by commit-pinned URL in a two-column table. To verify during the
build: that these render for viewers of a *private* repo; if not, fall back to
a single stitched image or to links.

**When proof cannot be produced** (app will not run here, base does not build,
route needs credentials or data that are unavailable): the Proof row says
`Not produced` with the reason, and the verdict cannot be better than
*Ready with open items*. It is never left out quietly.

## Feature-flag gating

Not a standing requirement. The skill never complains that a change lacks a
feature flag. A focused gating check runs **only when the original issue or
ticket says the work must be gated** (or the author adds that at intent
confirmation).

**Trigger.** In phase 2, the linked issue/ticket and PR body are read for a
gating requirement ("behind a flag", "gated by `<flag>`", "dark launch", a
named flag). If found, it becomes an acceptance criterion in the intent
statement — so the author confirms it along with everything else. No such
requirement → the report row reads `Not required` and nothing is checked.

**What the focused check covers:**

- Every entry point to the new UI or behaviour is behind the flag — routes,
  nav links, and shared components that render it — not just the main
  component.
- The flag is the one the ticket names (when it names one), defaults to
  **off**, and is registered wherever the repo registers flags.
- **Flag off is a no-op:** with the flag off, the head behaves and looks like
  the base. Proven, not assumed (see below).
- **Flag on works:** the new behaviour meets the other acceptance criteria.
- Tests cover both states.

**Proof, three-way:** for gated visual changes the screenshot set becomes
*base* / *head, flag off* / *head, flag on*. Base and flag-off must match (pixel
diff within a small tolerance); a difference is a finding, since it means the
change leaks outside the gate.

**Severity:** the ticket asked for gating, so a miss is a failure of stated
intent — an ungated entry point or a flag-off difference is **Blocking**.

## Pipeline

A phase that could not run is reported as **not run**, never silently skipped or
reported as passing.

### 1. Target and context

- Current branch's PR via `gh pr view`; optional PR number argument.
- If no PR exists, push the branch and open a **draft** PR so the report has
  somewhere to live (default mode asks first; don't-stop mode just does it).
- Gather: diff against the merge base, commits, PR title/body, linked issue, CI
  status, the repo's CLAUDE.md / CONTRIBUTING.md / PR template.
- Record the head SHA being reviewed.
- Classify each changed area into a review tier and a change kind (see Review
  depth and Proof); these decide how deep later phases go and what evidence
  is owed.

### 2. Confirm intent

- Write a short intent statement: what the PR is meant to change, what it must
  *not* change, and the acceptance criteria. Sources: PR body, linked issue,
  commits.
- **Gate:** show it to the author and get a yes or a correction. This statement
  is the spec every later phase reviews against.
- Flag intent/diff mismatch immediately: changes in the diff that the intent
  does not cover (scope creep, stray files), and stated goals with no matching
  change.

### 3. Regression check

- Discover the project's own commands (tests, lint, typecheck, build) from
  package scripts, Makefile, CI config, CLAUDE.md.
- Run them on the PR head. For any failure, re-run that check on the merge base
  to separate **regressions** (pass on base, fail on head) from **pre-existing**
  failures (reported, not blocking for this PR).
- If the ticket required feature-flag gating, run the focused gating check
  (see Feature-flag gating); its flag-off comparison is a regression check in
  its own right.
- Check for weakened safety nets in the diff itself: deleted, skipped or
  loosened tests and assertions, lowered coverage thresholds, disabled lint
  rules, widened types.

### 4. End-to-end test

- Exercise the changed behaviour through the real entry point (running app,
  CLI, API call, browser), driven by the acceptance criteria from phase 2 —
  not only through unit tests.
- Use the project's e2e suite where one exists; otherwise run the app and
  drive the affected flow directly, capturing evidence (output, screenshot,
  response).
- Cover the happy path plus at least one failure/edge path per criterion.
- Capture the proof owed for each change kind here, including before/after
  screenshots for visual changes (see Proof).
- If the app cannot be run here, say so in the report as **not run** with the
  reason.

### 5. Independent review (subagents)

Two rules apply to **every** review agent in the skill — the reviewers here, the
skeptic in phase 6, and the fix-diff reviewer in phase 9:

**Zero inherited context.** Each is spawned as a fresh subagent with none of the
spawning session's chat history — never a fork of it. Its brief is assembled
from a fixed prompt template plus artifacts only: the diff, the confirmed
intent statement, repo conventions, and each area's tier. The brief never
contains the session's own summary of the change, its opinion of the code, the
author's reasoning, or what other agents concluded. An agent that has read why
the author thinks the code is right will tend to agree; one that has only the
code has to work it out.

**Adversarial by default.** Each starts from the assumption that its target is
wrong and tries to prove it:

- Reviewers assume the PR contains a defect and hunt for it: construct inputs,
  states, orderings and failure conditions that break the change; treat the PR
  description and the intent statement as claims to test, not facts.
  "Looks fine" is not an output — a reviewer reports either findings or the
  specific attacks it tried that failed.
- The skeptic assumes each *finding* is wrong and tries to knock it down.
- The fix-diff reviewer assumes each *fix* is incomplete or breaks something.

Reviewers attack the code, the skeptic attacks the reviewers; only what
survives both reaches the report. The evidence rule below is what keeps
adversarial reviewers from producing noise.

- Reviewer count and reading depth come from the PR's tier (see Review depth):
  one for Leaf, two for Shared, three for Core.
- **Two reviewers** is the usual case, in parallel, split so they overlap as
  little as possible:
  - **Does it work?** — correctness, edge cases, error handling, security
    (secrets, injection, authz, new dependencies), compatibility.
  - **Is it honest and maintainable?** — tests (would they fail if the code
    broke?), the AI-code failure modes list below, duplication of existing
    helpers, needless abstraction, dead code, conventions.
- **A third reviewer** joins for Core-tier PRs and takes security +
  compatibility as a dedicated lens, leaving the first reviewer on pure
  correctness. Sheer size (roughly 400+ changed lines) also adds one, since
  two reviewers lose coverage on a very large diff.
- **Leaf-tier PRs** get a single reviewer covering both lenses lightly; the
  proof carries the weight.
- Reviewers are told each area's tier, so a Core file in a mostly-Leaf PR
  still gets a deep read.
- Every finding must carry: `file:line`, a concrete failure scenario
  (input/state → wrong result), and a proposed severity. Findings without a
  concrete scenario are dropped.

### 6. Skeptic verification

- A separate skeptic subagent — fresh, given only the findings and the code,
  not the reviewers' transcripts — takes each finding and tries to
  **disprove** it:
  read the surrounding code, trace callers, and where possible reproduce it
  (failing test, command, e2e step).
- Verdict per finding: **confirmed** (reproduced or proven from the code),
  **plausible** (cannot disprove, cannot reproduce), **rejected** (with the
  reason).
- Deduplicate, then set final severity. Only confirmed and plausible findings
  go forward; rejected ones are kept for the report.

### 7. Findings report (to the author)

Severity levels, fixed vocabulary:

| Level | Meaning |
|---|---|
| **Blocking** | Breaks stated intent, regression, data loss, security hole. Must not merge. |
| **Important** | Real defect or risk, but narrow or with a workaround. Should fix before merge. |
| **Suggestion** | Improvement with a clear benefit; safe to defer. |
| **Nit** | Style or naming; no behavioural effect. |

- **Gate (default mode):** the author sees the verified list, then one
  question: **"Continue with fixes, or chat about it?"** Continuing fixes
  everything fixable; chatting lets the author drop, downgrade or dispute
  findings first (disputed ones are recorded as `Rejected by author`).
- Don't-stop mode skips this gate.

### 8. Fix

- Fix approved findings one at a time, smallest change that resolves each;
  no unrelated refactors, nothing outside the PR's scope.
- One commit per finding (or tight group), message referencing the finding ID.
- Bugs get a regression test that fails before the fix and passes after.
- Findings that need a product or design decision are **not** auto-fixed; they
  go to the report as *needs author decision*.

### 9. Re-verify

Not a second run of the pipeline — a scoped check sized to the fixes:

- **Always:** re-run the phase 3 commands (tests, lint, types, build) on the
  new head. Cheap, and it is the part that actually catches a broken fix.
- **Only if touched:** re-run the phase 4 e2e flows whose code the fixes
  changed.
- **One reviewer, fix diff only:** a single fresh, adversarial subagent (same
  two rules as phase 5) checks that each fix
  resolves its finding and breaks nothing nearby. No second reviewer and no
  skeptic pass unless it raises something new; skipped entirely when the fix
  diff is trivial (a few mechanical lines) and the checks pass.
- **Not repeated:** intent confirmation, the full-diff review, the full e2e
  run.
- Anything new goes through the skeptic, then back to phase 8, capped at 2
  rounds; whatever is left is reported as `Open`.

### 10. Post the PR report comment

- One comment, posted with `gh pr comment`, rendered from a fixed template so
  it looks identical on every PR.
- Idempotent: the comment carries a hidden marker
  (`<!-- pr-self-review -->`); a re-run **edits** that comment rather than
  adding another.
- **Gate (default mode):** show the rendered comment and get a go-ahead before
  pushing fix commits and posting. Don't-stop mode pushes and posts directly.
- The comment states which mode produced it.

## Report comment format

Fixed section order, fixed headings, fixed table columns. Empty sections are
kept and say "None" so the shape never changes.

```markdown
<!-- pr-self-review -->
## Self-review report

**Verdict:** Ready for review | Ready with open items | Not ready
**Reviewed:** `<head sha>` (base `<base sha>`) · <date> · <default | don't-stop> mode · skill v<version>

### Intent
<confirmed intent statement, 1–3 sentences>

### Checks
| Check | Result | Notes |
|---|---|---|
| Intent matches diff | Pass / Fail | |
| Regression (tests, lint, types, build) | Pass / Fail / Not run | |
| End-to-end | Pass / Fail / Not run | |
| Independent review | <n> reviewers, <n> raised, <n> verified | |
| Proof | Provided / Not produced | |
| Feature-flag gating | Pass / Fail / Not required | <flag name> |

**Review depth:** <Core | Shared | Leaf | Inert> — <one line on why>

### Proof
| Before | After |
|---|---|
| <image or output on base> | <image or output on head> |

<gated changes use three columns: Before · After, flag off · After, flag on>

<one row per route / case; for non-visual changes, the failing-then-passing
test or the before/after output in a collapsed block>

### Findings
| ID | Severity | Location | Issue | Verification | Status |
|---|---|---|---|---|---|
| F1 | Blocking | `path:line` | … | Confirmed | Fixed in `<sha>` |
| F2 | Important | `path:line` | … | Plausible | Open — needs author decision |
| F3 | Suggestion | `path:line` | … | Confirmed | Deferred |

**Totals:** <n> blocking · <n> important · <n> suggestion · <n> nit —
<n> fixed · <n> open · <n> deferred

### Rejected findings
| ID | Raised as | Location | Why rejected |
|---|---|---|---|

### Not verified
<what could not be run or checked, and why>

### Notes for the reviewer
<where to look first, known trade-offs>
```

Status vocabulary is closed: `Fixed in <sha>`, `Open`, `Open — needs author
decision`, `Deferred`, `Rejected by author`, `Pre-existing`.

## AI-code failure modes checklist

Used by the dedicated reviewer in phase 5:

- Calls to APIs, flags, config keys or packages that do not exist or have a
  different signature; new dependencies that are unneeded or unverified.
- Tests that cannot fail: asserting on mocks, tautologies, mocking the thing
  under test, snapshot updated to match the bug.
- Tests or assertions changed to make the suite pass rather than fixing code.
- Errors swallowed or replaced with fallbacks/defaults that hide failures.
- Hardcoded values or special cases that satisfy the test but not the general
  case; stubs and `TODO` placeholders presented as done.
- Reimplementing a helper the codebase already has; speculative abstraction,
  unused parameters, dead code.
- Comments and docstrings that describe code that is no longer there; PR
  description claims the diff does not support.
- Unrelated churn: reformatting, renames, lockfile changes outside scope.
- Leftovers: debug output, commented-out code, `.only`, secrets, local paths.
- Compatibility: public API, schema/migration, config or env changes without
  a migration path or docs.

## Repo layout

```
pr-self-review/
├── README.md
├── skills/
│   └── self-review/
│       ├── SKILL.md              # frontmatter + the pipeline and its gates
│       ├── reviewers.md          # fixed adversarial prompt templates: reviewers, skeptic, fix-diff
│       ├── ai-failure-modes.md   # the checklist above
│       ├── report-template.md    # the PR comment template (single source)
│       ├── depth-and-proof.md    # tier rules, proof owed per change kind
│       └── scripts/
│           ├── gather.sh         # PR metadata + diff + CI in one bundle
│           ├── classify.sh       # fan-in + path heuristics → tier per area
│           ├── capture.sh        # base worktree + head, same routes, screenshots
│           ├── publish-assets.sh # push images to the assets branch, print URLs
│           └── post-report.sh    # find comment by marker; create or edit
└── .claude-plugin/
    └── plugin.json               # optional packaging
```

## Build steps

1. `SKILL.md` — triggers, the two modes, the ten phases, severity and status
   vocabulary.
2. `report-template.md` and `post-report.sh` (idempotent comment) — lock the
   output format first, since everything else feeds it.
3. `reviewers.md`, `ai-failure-modes.md`, `gather.sh`.
4. `depth-and-proof.md` and `classify.sh`.
5. Screenshot proof: `capture.sh` and `publish-assets.sh`. First settle the
   image-hosting question on a private test repo, since the template depends
   on it.
6. Try it on real PRs: one clean, one with planted bugs (to measure what the
   reviewers catch and what the skeptic wrongly rejects), one where e2e
   cannot run, one visual-only, one touching core code.
7. Package (plugin manifest, README install steps) and release.

## Distribution

Personal use first, public listing later. So from the start:

- Plugin layout and manifest, installed locally by symlink until it is listed.
- Nothing specific to one machine or repo: commands are discovered per project,
  no hardcoded paths, `gh` is the only hard dependency.
- Thresholds and reviewer count readable from an optional per-repo config, so
  others can tune without forking.
- README written for a stranger: what it posts on your PR, what it pushes, and
  what each mode does without asking.

## Open questions

- **Tier heuristics:** the fan-in cut-off for Shared and the path patterns for
  Core are guesses; settle after the trial PRs.
- **Image hosting:** does a commit-pinned image on an assets branch render in
  a PR comment on a private repo? Decides between side-by-side table, stitched
  image, or links.
- **Assets branch housekeeping:** prune a PR's images when it merges or closes,
  or keep them so old reports stay intact?
- **Running the base:** two builds and two servers per visual PR is slow. Cache
  base screenshots per base SHA, or accept the cost?
