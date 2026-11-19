# preflight — implementation plan

A Claude Code skill for AI review of your pull request: confirm what it is
meant to do, prove it does that without breaking anything, have independent
reviewers try to break it, fix what survives verification, and leave one
uniform report comment on the PR.

Status (v0.2.0): everything except screenshot proof and end-to-end runs is
built under `skills/preflight/` and tested (`node --test test/`). The core
loop has run end to end on the fixture repo (see *First run*); the scripts
have run end to end on it through the installed skill. Nothing has run on a
real PR yet — that, and the evaluation baseline, are next. What remains is
under *Build steps*.

**Shape.** A core loop — intent brief, test check, partitioned parallel
reviewers, per-finding skeptic, triage, fresh-agent fix verification, state
stored on the PR — with additions layered on top: running the app and
producing proof, review depth by risk, an unattended mode, redaction, learned
suppressions and an evaluation harness.

## Usage

```
/preflight                  # PR for the current branch
/preflight 123              # a specific PR
/preflight --dont-stop      # after intent is confirmed, fix and post without pausing
/preflight 123 --update     # after new pushes: re-verify open findings, review only new changes
/preflight --dry-run        # run everything, write the report to a local file; no commit, push or post
/preflight --screenshots    # also capture before/after screenshots of visual changes (opt-in)
```

`--dry-run` also works on a branch with no PR (diffed against the default
branch) and can take a pre-confirmed brief from a file, which is how the
evaluation runs unattended.

## Modes

| | Default | Don't stop |
|---|---|---|
| Confirm intent | Stops for a yes | Stops for a yes |
| After findings | Shows findings, asks **"Continue with fixes, or chat about it?"** | Continues |
| Red tests | Stops, offers to diagnose; the author may proceed | Recorded as Blocking; continues |
| Fixes | The findings the author chose to fix | Every skeptic-confirmed Blocking, Important and Suggestion with a clear fix; Nits are listed, not fixed |
| Commit, push, publish proof, post | Shows the fix diff and the rendered comment, asks once | Does all four |

Intent is the one stop both modes share: it is the only input the skill cannot
derive, and everything after it is judged against it. Anything else that needs
a yes before the review can start — opening a draft PR, writing a missing
description — is asked at that same stop.

**Nothing is committed or pushed without a go-ahead in default mode.** Fixes are
made in the working tree; the author sees the diff; on approval the skill
commits (one commit per finding) and pushes. Fixes applied and committed with
no human in the loop are a known way for bad changes to land, so unattended
committing exists only as the explicit `--dont-stop` opt-in.

Even in don't-stop mode, two kinds of finding are never auto-fixed and go to the
report as `Open — needs author decision`: ones whose fix needs a product or
design choice, and ones the skeptic could not verify where the fix would change
behaviour. Don't-stop means no pauses, not guessing.

Suggestions normally skip the skeptic. In don't-stop mode, any Suggestion that
would be auto-fixed is sent through the skeptic first, so nothing is changed on
one agent's say-so.

Nits are never auto-fixed in don't-stop mode. Reviewer and skeptic agreeing is
good evidence that a *defect* is real, but on matters of taste it only shows two
runs of the same model share a preference — and every extra commit is more diff
for the human reviewer.

## Review depth

Depth follows what is changing, not how many lines changed. Phase 1 sorts every
changed area into a tier; each area is reviewed at its own tier, and the PR as a
whole takes the highest tier present.

| Tier | What lands here | How it is reviewed |
|---|---|---|
| **Core** | Infrastructure, auth, data layer and migrations, build/deploy config, payments, public API | **Deep read.** Whole files, not just hunks; every caller traced; three or more reviewers (callers and security + compatibility get their own); full regression and e2e. |
| **Shared** | Utilities, hooks, shared components, anything imported from several places | **Careful review.** Every call site of a changed signature or behaviour checked; two reviewers; e2e on at least one consumer per changed behaviour. |
| **Leaf** | Presentational components, copy, styling, a single screen | **Proof-led.** Light code read by one reviewer; the weight is on evidence that it looks and behaves right (see Proof). |
| **Inert** | Docs, comments, non-shipping config | Skim for accuracy; no reviewers. |

How an area gets its tier, in order of precedence:

1. The repo's own config (`.preflight/config.yml`: path globs → tier), when
   present.
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
repo (`preflight-assets`, one folder per PR and head SHA) and the comment
links them by commit-pinned URL in a two-column table. To verify during the
build: that these render for viewers of a *private* repo; if not, fall back to
a single stitched image or to links.

**When proof cannot be produced** (app will not run here, base does not build,
route needs credentials or data that are unavailable): the Proof row says
`Not produced` with the reason, and the verdict cannot be better than
*Ready with open items*. It is never left out quietly. A kind of proof the
skill cannot make yet (screenshots, until they are built) is reported
`Not run` instead: shown in the report and under *Not verified*, but it does
not cap the verdict.

## Feature-flag gating

Not a standing requirement. The skill never complains that a change lacks a
feature flag. A focused gating check runs **only when the original issue or
ticket says the work must be gated** (or the author adds that at intent
confirmation).

**Trigger.** In phase 2, the linked issue/ticket and PR body are read for a
gating requirement ("behind a flag", "gated by `<flag>`", "dark launch", a
named flag). If found, it is recorded in the brief's `flagGate` and becomes an
acceptance criterion — so the author confirms it along with everything else. No such
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

## Reviewer stance and convergence

Two failure modes pull in opposite directions: reviewers that wave plausible
code through, and reviewers that always find *something*, so the author is
stuck in a loop. The stance is a deliberate middle: **hunt hard, report
strictly, and stop.**

**Hunt hard.** Each reviewer actively tries to break the change — constructs
inputs, states, orderings and failure conditions; reads callers and surrounding
code, not just the diff; treats the PR description and brief as claims to test.

**Report strictly.** Trying hard to find a defect is not the same as having to
report one.

- **An empty findings list is a valid and expected result.** A reviewer is
  never told a defect exists, and is never asked for a minimum number.
- A clean result must still show its work: the reviewer lists the specific
  attacks it tried that failed. That is the check against laziness — not a
  quota of findings.
- Every finding must give what was **intended** (per the brief), what is
  **observed** (the current code, quoted) and a **failure case** (a concrete
  input or state that goes wrong). No failure case → not a finding. This keeps
  "could be cleaner" out of the serious tiers.
- **Severity ceilings per lens, enforced in code**, whatever the agent returns:
  correctness, error handling and impact on callers can reach Blocking; test
  adequacy, AI-code failure modes, types and stale comments cap at Important;
  simplification caps at Suggestion; style is a Nit.
- Blocking and Important findings each go to a skeptic that tries to disprove
  them before the author sees anything.

**Stop.** The rules that prevent a loop:

1. **No finding below Important affects the verdict.** A PR with open
   Suggestions and Nits is `Ready for review` (the full verdict rule is under
   Report comment format).
2. **Suggestions and Nits are capped** — the top five of each are shown, the
   rest collapsed — and are raised **once**. They are never re-raised on a
   later run.
3. **Decisions are remembered.** Findings have stable ids and their
   dispositions live in the state block on the PR. A finding the author
   deferred or declined is not raised again on re-run; it stays in the
   report under its disposition.
4. **Re-runs review only what is new.** `--update` re-verifies open findings
   and reviews only hunks added since the last reviewed commit — never the
   whole PR from scratch.
5. **Fix rounds are bounded.** Fix verification can only say whether *that
   finding* is resolved and whether *that fix* broke something. It cannot
   raise new Suggestions or Nits. Two rounds at most; anything left is
   reported `Open` and the skill finishes.
6. **A clean run says so plainly.** "No blocking or important findings" is a
   normal, successful outcome, reported as such.

**Catching what slips through** is handled by measurement, not by making
reviewers more trigger-happy: every defect that a human reviewer or production
later finds in a self-reviewed PR is recorded in the misses log and becomes an
evaluation fixture (see Evaluation). Reviewer prompts are then changed only
when the evaluation shows the change catches the miss without raising the
false-positive rate.

**Context rule.** Every review agent — reviewers, skeptics, fix verifiers — is
spawned fresh with none of the spawning session's chat history, never as a
fork. Its brief is a fixed prompt template plus artifacts only: its partition
of the diff, the confirmed intent brief, repo conventions, each area's tier and
the repo's suppression list. It never receives the session's summary or opinion of the
change, the author's reasoning, or other agents' conclusions.

## Pipeline

A phase that could not run is reported as **not run**, never silently skipped or
reported as passing.

### 1. Target, context and prior state

- Current branch's PR via `gh pr view`; optional PR number argument.
- If no PR exists, the branch is pushed and a **draft** PR opened so the
  report has somewhere to live — after the author agrees at the intent stop,
  in both modes. Until then the skill works from the branch and its commits.
- Gather: diff against the merge base, commits, PR title/body, linked issue, CI
  status, the repo's CLAUDE.md / CONTRIBUTING.md / PR template.
- Record the head SHA being reviewed.
- **Load prior state:** find the existing report comment and parse its
  state block (last reviewed SHA, brief, findings with ids and dispositions).
  Used by `--update`, by the *Changes since the last run* section, and so
  decided findings are not re-raised.
- **Partition the diff:** production hunks and test hunks are separated. Test
  fixtures go only to the test lens, so they do not crowd out production code
  in the other reviewers' context.
- Classify each changed area into a review tier and a change kind (see Review
  depth and Proof).

### 2. Confirm intent

One fresh agent drafts an **intent brief** from the PR title/body, commits,
linked issue and a summary of the diff:

- `purpose` — what the PR is for, in a sentence.
- `acceptance[]` — the acceptance criteria: statements that can be checked
  against the running code. Each one is owed a test and proof, and is marked
  covered or uncovered in the report.
- `outOfScope[]` — what the PR is meant to leave alone.
- `tiers[]` — each changed area with its review tier and the reason (see
  Review depth), so the author checks the risk call at the same time.
- `unexplained[]` — files or hunks that nothing in the description, commits
  or ticket accounts for.
- `description` — `sufficient`, or `needs writing` when the body is empty or
  too vague to review against.
- `flagGate` — whether the ticket asks for a feature flag, and which.

**Gate (both modes):** the brief is shown to the author, who confirms or
corrects it.

- Every unexplained change gets a decision: *meant to be there* (it joins the
  acceptance criteria and the description) or *not meant to be there* (it comes
  out of the PR before the review continues). Unplanned edits riding along in
  a PR are a common source of regressions.
- **Description needs writing:** the skill drafts one from the confirmed brief
  (purpose, what changed, how to test, risks); the author approves it at this
  same stop and it is written to the PR before the review runs, since the
  reviewers and the human reader both work from it.

The confirmed brief goes to every review agent and to the top of the report.

### 3. Tests and regression check

- **Use CI's result when it is current.** If the local head equals the pushed
  head and checks exist, read `gh pr checks`. If there are unpushed commits or no CI, discover
  the project's commands (tests, lint, typecheck, build) from package scripts,
  Makefile, CI config, CLAUDE.md and run them locally once.
- **Red is the first Blocking finding.** In default mode the skill stops and
  offers to diagnose; the author may choose to proceed on red, and the report
  records that they did. Don't-stop mode records the finding and continues.
  CI pending → continue, and the report says so.
- For any failure, re-run that check on the merge base to separate
  **regressions** (pass on base, fail on head) from **pre-existing** failures
  (reported, not blocking for this PR).
- **Flaky tests:** a failing test is re-run (up to twice) before it is blamed
  on the PR. Fails-then-passes is reported as `Flaky`, not a regression.
- **Scanners, when the repo already has them:** secret scan, dependency audit
  and static analysis are run if configured, and their output is handed to the
  reviewers as leads. The skill does not install tools.
- If the ticket required feature-flag gating, run the focused gating check
  (see Feature-flag gating).
- Check for weakened safety nets in the diff itself: deleted, skipped or
  loosened tests and assertions, lowered coverage thresholds, disabled lint
  rules, widened types.

### 4. End-to-end test and proof

- Exercise the changed behaviour through the real entry point (running app,
  CLI, API call, browser), driven by the acceptance criteria — not only
  through unit tests.
- Use the project's e2e suite where one exists; otherwise run the app and
  drive the affected flow directly, capturing evidence.
- Cover the happy path plus at least one failure/edge path per criterion.
- Capture the proof owed for each change kind, including before/after
  screenshots for visual changes (see Proof).
- If the app cannot be run here, say so in the report as **not run** with the
  reason.

### 5. Review agents

Launched in parallel through the Workflow tool (Agent-tool fallback with the
same prompts). All follow the stance and context rule above.

The lenses, grouped by the two questions the review asks:

**Does it work?** — findings here can be Blocking.

| Lens | Looks for |
|---|---|
| Correctness and security | Wrong logic, unhandled empty or missing values, boundary errors, concurrency and ordering faults, leaked resources, injection and authorisation holes |
| Error handling | Failures that are caught and hidden, fallbacks that mask a problem without a trace, errors that leave data half-written |
| Impact on callers | Every function, export, endpoint, type or config key the diff changes is looked up across the repo; callers whose behaviour shifts are reported, unaffected ones are not |

**Is it honest and maintainable?** — findings here cap at Important;
simplification caps at Suggestion.

| Lens | Looks for |
|---|---|
| Test adequacy | For each acceptance criterion, the test that would fail if it broke, or "uncovered"; branches and error paths with no test; tests that cannot fail |
| AI-code failure modes | The checklist below |
| Data model and types | Only when they change: states that should be impossible but are now representable, internals exposed to callers |
| Comments and docs | Comments and docstrings near the change that no longer describe the code |
| Simplification | Abstraction with a single use, generality nobody asked for, dead code |

How many agents carry those lenses depends on the PR's tier, so a small PR does
not pay for eight agents:

- **Leaf — one reviewer**, all lenses, light read; the proof carries the
  weight.
- **Shared — two reviewers:** *Does it work?* (bugs, silent failures, caller
  regressions) and *Is it honest and maintainable?* (tests, types, comments,
  AI-code failure modes, simplification).
- **Core — three or more:** caller regressions and security + compatibility
  each get a dedicated agent; the rest as for Shared. Very large diffs
  (roughly 400+ changed lines) also split further.
- Reviewers are told each area's tier, so a Core file in a mostly-Leaf PR
  still gets a deep read.

Whether narrow single-lens agents beat two broad ones is an evaluation
question (see Open questions).

### 6. Skeptic verification

Done inside the workflow, before the author sees anything.

- **One fresh skeptic per finding** for every Blocking and Important finding.
  It gets the finding (location, claim, intended, observed, failure case) and
  the repo — not the reviewer's transcript — and tries to knock it down by
  reading the code, tracing callers and, where possible, reproducing it.
- Verdicts: **confirmed** (shows the code path that fails), **rejected** (shows
  why the failure case cannot occur), **reduced** (real, but a lower severity
  is set) or **unproven** (the code alone could not settle it — the finding is
  kept and marked as such).
- Suggestions and Nits skip the skeptic (except Suggestions about to be
  auto-fixed in don't-stop mode).
- Rejected findings leave triage and are listed in the report.
- Ceilings, de-duplication (same file, nearby line, same claim) and finding
  ids are applied by code, not by a model. An id is `F-` plus a short hash of
  file and claim, so the same finding keeps its id across runs.
- Findings a reviewer matched to a suppression rule arrive in a separate
  list and are only counted (see Learned suppressions).

### 7. Findings and triage

Severity levels, fixed vocabulary:

| Level | Meaning |
|---|---|
| **Blocking** | Breaks stated intent, regression, data loss, security hole. Must not merge. |
| **Important** | Real defect or risk, but narrow or with a workaround. Should fix before merge. |
| **Suggestion** | Improvement with a clear benefit; safe to defer. |
| **Nit** | Style or naming; no behavioural effect. |

- Findings are shown grouped by severity, each as intended / observed /
  failure case in plain language.
- **Gate (default mode):** one question — **"Continue with fixes, or chat
  about it?"**
  - *Continue* fixes every Blocking and Important finding with a clear fix.
  - *Chat* goes through Blocking and Important findings individually, most
    severe first. For each the author picks **Fix**, **Defer** (with a reason,
    and a ticket or follow-up link when there is one) or **Decline** (with a
    reason). A decline should answer the failure case; if it does not, the
    skill points that out a single time and then records the author's answer
    as given. Findings cannot be waved through in bulk. Suggestions and Nits
    are offered as a group to take or skip.
- Don't-stop mode skips this gate.

### 8. Fix

- Fix chosen findings one at a time, smallest change that resolves each; no
  unrelated refactors, nothing outside the PR's scope.
- Where the finding has a clear failure case, add or extend a test that encodes
  it: fails before the fix, passes after.
- Findings that need a product or design decision are **not** auto-fixed.

### 9. Verify the fixes

Not a second run of the pipeline. A fix is judged by an agent that had no part
in writing it.

- **Resolved?** One fresh agent per fixed finding, given only the finding and
  the current file contents — not the fix diff, not the conversation. It
  answers `resolved` (quoting the code that fixes it and why the failure case no
  longer happens), `partial` or `unresolved`. If the code moved, the verifier
  follows it; a line having disappeared proves nothing on its own.
- **Broke anything?** Re-run the tests added or touched plus the tests for the
  changed modules, and the e2e flows whose code the fixes changed. One fresh
  agent reads the combined fix diff for defects the fixes introduced —
  Blocking and Important only.
- `partial` / `unresolved` / new defect → back to phase 8, two rounds at most;
  whatever is left is reported `Open`.
- Not repeated: intent confirmation, the full review, the full e2e run.

### 10. Commit, push and post

- Everything bound for GitHub passes redaction first (see Redaction).
- **Gate (default mode):** the fix diff and the rendered comment are shown;
  one go-ahead covers commit (one commit per finding, message referencing the
  finding id), push, publishing proof images to the assets branch, and
  posting. Don't-stop mode does all of these directly. Commit SHAs in the
  comment are filled in after the commits exist.
- One comment, posted with `gh pr comment`, rendered from a fixed template.
  A re-run **edits** the existing comment; there is one report comment
  per PR.
- The comment ends with the machine-readable **state block**.

### `--update`

After new commits are pushed:

1. Load prior state.
2. Re-verify every finding with status `open` or `fixed` against the pushed
   code (phase 9's "Resolved?" check) — fixed ones too, since the push may
   differ from what was verified locally.
3. Reuse the confirmed brief. If the new hunks contain changes it does not
   account for, the intent stop reopens for those changes only.
4. Run phases 3–6 only on hunks new since the last reviewed SHA, then triage,
   fix and verify anything newly raised as usual (phases 7–9).
5. Update the comment, filling in *Changes since the last run*.

Findings already deferred or declined are carried forward untouched. With no
prior state on the PR, `--update` falls back to a full run.

## Report comment format

Fixed section order, fixed headings, fixed table columns. Empty sections are
kept and say "None" so the shape never changes; only *Changes since the last
run* is omitted on a first run.

```markdown
<!-- preflight -->
## Self-review report

**Verdict:** Ready for review | Ready with open items | Not ready
**Reviewed:** `<head sha>` (base `<base sha>`) · <date> · <default | don't-stop> mode · skill v<version>

### Intent
**Purpose:** <brief.purpose>
**Acceptance criteria:** <each, marked covered / uncovered>
**Out of scope:** <outOfScope>
**Review depth:** <Core | Shared | Leaf | Inert> — <one line on why>

### Checks
| Check | Result | Notes |
|---|---|---|
| Scope matches description | Pass / Fail | |
| Tests (CI @ `<sha>` or local `<cmd>`) | Pass / Fail / Pending / Not run | |
| Regression vs base | Pass / Fail / Not run | <flaky, pre-existing> |
| End-to-end | Pass / Fail / Not run | |
| Review | <n> reviewers, <n> raised, <n> confirmed, <n> rejected, <n> suppressed | |
| Proof | Provided / Not produced | |
| Feature-flag gating | Pass / Fail / Not required | <flag name> |

### Proof
| Before | After |
|---|---|
| <image or output on base> | <image or output on head> |

<gated changes use three columns: Before · After, flag off · After, flag on;
non-visual proof goes in a collapsed block>

### Changes since the last run
- Resolved: <ids>
- Carried over: <ids, and what still fails>
- Newly raised: <ids>

### Findings
| ID | Severity | Location | Issue | Skeptic | Status |
|---|---|---|---|---|---|
| F-3fa9c1 | Blocking | `path:line` | … | Confirmed | Fixed in `<sha>` — <quote of the fixing code> |
| F-b07d42 | Important | `path:line` | … | Unproven | Open — needs author decision |
| F-58e1aa | Important | `path:line` | … | Confirmed | Deferred — <reason> · <ticket> |
| F-c2946f | Important | `path:line` | … | Reduced | Declined — <author's reason> |

**Totals:** <n> blocking · <n> important · <n> suggestion · <n> nit —
<n> fixed · <n> open · <n> deferred · <n> declined

### Rejected by the skeptic
| ID | Raised as | Location | Why rejected |
|---|---|---|---|

### Not verified
<what could not be run or checked, and why; anything withheld by redaction>

### Notes for the reviewer
**Where to look first:** <files with Blocking / Important findings>
**Decisions worth a second opinion:** <ids the author declined>
**Changes beyond the description:** <unexplained changes the author kept>
<details><summary>Suggestions and nits not taken (<n>)</summary> … </details>

<!-- preflight:state v1
{"reviewedSha":"…", "mode":"…", "tier":"…", "brief":{…}, "checks":{…},
 "findings":[{id, file, line, lens, severity, claim, intended, observed,
              failureCase, skeptic, status, reason}],
 "rejected":[…]}
-->
```

Status vocabulary is closed: `Fixed in <sha>`, `Open`, `Open — needs author
decision`, `Deferred`, `Declined`, `Pre-existing`.

Verdict rule, first match wins:

1. **Not ready** — any Blocking finding is `Open`, or tests are red.
2. **Ready with open items** — any Blocking or Important finding is open,
   deferred or declined; or tests are pending or were not run; or owed proof
   was not produced.
3. **Ready for review** — otherwise, regardless of Suggestions and Nits.

A Blocking finding the author deferred or declined does not hold the verdict at
*Not ready* — the author owns that call — but it is listed first under
*Decisions worth a second opinion*.

## Redaction before anything is posted

The report, the proof and the screenshots end up on GitHub — publicly, for a
public repo. Before phase 10 pushes assets or posts the comment:

- Text (command output, request/response, logs, test output) is scanned for
  secrets and personal data — tokens, keys, cookies, auth headers, `.env`
  values, emails, local home paths — and matches are masked.
- Screenshots are taken with seeded or fake data only; a capture from a
  session using real credentials or real user data is not published.
- A reviewer subagent inspects each image for visible secrets or personal data
  before it is pushed to the assets branch.
- Anything that cannot be confidently cleaned is left out and listed under
  *Not verified* as "withheld: may contain sensitive data".
- Don't-stop mode is not exempt: a redaction hit downgrades that item to
  withheld rather than stopping, and never posts it raw.

## Learned suppressions

So the same noise is not raised on every PR:

- When the author declines a finding (`Declined`), the skill offers
  to remember it. Accepted suppressions are written to
  `.preflight/suppressions.yml` in the repo: the pattern, the reason, who
  and when.
- Reviewers receive the suppression list as part of their brief (it is a repo
  artifact, not session history). A finding that matches a rule is not raised;
  the reviewer returns it in a separate `suppressed` list with the rule it
  matched.
- That list is counted in the report ("<n> suppressed by repo rules"), so
  suppressed findings are hidden, not invisible.
- Suppressions never apply to Blocking findings; those are always raised.
- The file is committed, so it is reviewable and shared with anyone else using
  the skill on the repo.

## Evaluation

The skill's quality is measured, not assumed. Built alongside the skill, in
this repo:

- **A fixture repo**, built by a script (`eval/fixture/build.sh <dir>`) rather
  than committed, since its branches are the test cases: a small app with
  tests (and later a UI), and a set of prepared branches, each a realistic PR
  with **known, planted defects** — one or two per branch, drawn from the
  AI-code failure modes list (a test that cannot fail, a swallowed error, an
  ungated entry point, a visual regression, an off-by-one in shared code) —
  plus a few **clean** branches with nothing wrong. Each branch carries its PR
  title and body in `eval/fixture/descriptions/`, since a branch with no PR
  has no description of its own.
- **An answer key** (`eval/expected.json` — JSON, so the scorer needs no
  dependencies): per branch, the defects that must be found (file, line range,
  minimum severity), the unexplained changes the brief must list, the tier it
  should be classified as, and the confirmed intent brief, so the intent stop
  needs no human.
- **Planted false findings:** for each clean branch, at least one plausible
  but false Blocking finding is fed straight to a skeptic, to measure whether
  the skeptic rejects what it should. Reviewers that raise nothing false
  otherwise leave the skeptic's rejecting side untested.
- **A runner:** review agents are Claude Code subagents, so a run needs a
  Claude session — a shell script cannot start them. The runner is a session
  (`claude -p` per branch, headless) running the skill with
  `--dont-stop --dry-run --brief <key brief> --description <file>`, which
  leaves `result.json` and `report.md` in the work folder. `eval/score.js`
  then scores those against the key.
- **Scores:**
  - *Catch rate* — planted defects found at or above the expected severity.
  - *False-positive rate* — findings on clean branches, and findings not in
    the key (each one hand-labelled once as real or noise).
  - *Skeptic loss* — planted defects a reviewer raised but the skeptic
    rejected.
  - *Tier accuracy*, *fix success* (does the fix make the planted defect's
    test pass), cost and wall-clock time per PR.
  - *Duplicates* — one defect reported as two findings (the de-duplication
    thresholds were set from a single example; see First run).
  - *Brief recall* — planted unexplained changes the brief lists.
- **Use:** run before every change to prompts, tiers or reviewer count, and
  compare with the last run. A prompt change that lowers catch rate or raises
  skeptic loss does not ship. Results are recorded in `eval/results/`.
- **Misses log** (`eval/misses.md`): every defect a human reviewer or
  production later finds in a PR the skill had reviewed is written down —
  what it was, which lens should have caught it, why it did not. Each becomes
  a new fixture branch. This is how recall improves without loosening the
  reporting bar.
- Runs are noisy, so each branch is run several times and rates are reported
  with their spread, not as single numbers.

## AI-code failure modes checklist

The AI-code failure modes lens in phase 5 works from this list:

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
preflight/
├── README.md
├── skills/
│   └── preflight/
│       ├── SKILL.md              # the procedure: modes, phases, gates, stance
│       ├── review-workflow.js    # reviewer + skeptic prompts, schemas, ceilings, dedupe, ids
│       ├── ai-failure-modes.md   # the checklist above
│       ├── report-template.md    # the PR comment template (single source)
│       ├── depth-and-proof.md    # tier rules, proof owed per change kind
│       └── scripts/
│           ├── run-workflow.js   # runs review-workflow.js with agents started by the session
│           ├── render-report.js  # report + verdict + state block from JSON, in code
│           ├── gather.sh         # PR metadata, diff, CI, prior state; partitions the diff
│           ├── classify.js       # config + path patterns + fan-in → tier and kind per file
│           ├── scan.js           # secret scan of added lines, npm audit, the repo's scanners → leads
│           ├── run-checks.js     # checks on head, flaky re-runs, base comparison, behaviour proof
│           ├── redact.js         # mask secrets and personal data; scan mode for leads
│           ├── suppressions.js   # .preflight/suppressions.yml: list / add
│           ├── post-report.sh    # redact, find the comment by marker; create or edit
│           ├── lib/yaml-lite.js  # dependency-free YAML subset for .preflight files
│           ├── capture.js        # base worktree + head on their own ports, headless Chrome screenshots
│           └── publish-assets.sh # images to the assets branch (plumbing), commit-pinned URLs
├── eval/
│   ├── fixture/
│   │   ├── build.sh              # builds the fixture repo and its branches
│   │   └── descriptions/         # PR title + body per branch
│   ├── expected.json             # answer key per branch
│   ├── score.js                  # scores a run against the key
│   ├── misses.md                 # defects found later in self-reviewed PRs
│   └── results/                  # scored runs, for comparison over time
└── .claude-plugin/
    └── plugin.json               # optional packaging
```

## First run — 2026-11-18

The core loop run once end to end on a fixture repo (now
`eval/fixture/build.sh`): one branch with four planted defects, one clean
branch, default mode, Shared tier, 17 fresh agents. There is no Workflow tool
in Claude Code sessions today, so agents were started with the Agent tool from
prompts the real `review-workflow.js` built, and their answers were replayed
through it — the code rules ran for real.

| Measured | Result |
|---|---|
| Planted defects caught | 4 / 4 — one by the brief (unexplained change), three by reviewers, all at or above expected severity |
| Findings on the clean branch | 0 Blocking / Important; 1 fair Suggestion |
| Skeptic | 5 / 5 real findings confirmed; 1 / 1 planted false finding rejected, with the line that disproves it |
| Fix verification | 4 / 4 resolved; fix-diff review found nothing new; the open Blocking held the verdict at *Not ready* |
| Cost | ~55–65k tokens per agent; ~770k for the defect branch (brief, 2 reviewers, 5 skeptics, 5 verifiers) |

One run, one toy repo: this shows the loop works end to end, not how good it
is. What it taught, and where each lesson went:

| Lesson | Applied |
|---|---|
| With no suppression rules, a reviewer used the `suppressed` list to park an issue it had talked itself out of, under an invented rule — the report would have claimed a repo suppression | `suppressed` is only in the schema when rules exist, and only entries naming a real rule are counted |
| Two reviewers described one defect in different words; claim-only de-duplication kept both | Findings also merge when they quote mostly the same code and share some wording. Thresholds come from one example: the eval's *Duplicates* score checks them |
| The Agent-tool fallback said to "apply the code by hand" — and without a Workflow tool it is the only path | `scripts/run-workflow.js` runs the workflow and turns each agent call into a prompt file for a fresh subagent; the session loops until nothing is pending |
| The brief called a small route handler Core ("public API") and labelled tests Inert | Brief wording: public API means published to consumers outside the repo; tests take the tier of the code they test. Re-checked on the fixture; the eval's tier accuracy settles it |
| A branch with no PR has no description, so the brief had nothing to work from | `gather.sh --description <file>`; eval branches carry a description file |
| Hand-writing the report's state block (JSON, `>` escaping, verdict rule) is fiddly and easy to get wrong | `scripts/render-report.js` builds the report, verdict and state block from JSON in code |
| No reviewer raised a false finding, so the skeptic's rejecting side would have gone untested | Planted false findings per clean branch in the eval |
| Subagents reply reliably when told to write one JSON file and answer "done" | The driver uses that channel |
| 4 of 6 briefs filed a consequence outside the diff (the customer listing hit by the shared helper change — the planted defect itself) under `unexplained`, where the author cannot answer "meant to be there?" | Not yet: a `risks[]` field in the brief, passed to reviewers as leads, is the candidate. A wording change, so it waits for the eval |

Scores and details: `eval/results/2026-11-18-first-run.md`. The brief tier
wording was checked three runs against three: the PR tier was right 3 / 3 with
the new wording and 0 / 3 with the old.

## Build steps

Core loop first, then the additions, each measured against a working
baseline.

1. ✅ **Core loop:** `SKILL.md` and `review-workflow.js` — intent brief and
   gate, description drafting, CI-aware test check, partitioned reviewers,
   per-finding skeptic, triage, fresh-agent fix verification, state block,
   `--update`, `--dry-run`.
2. ✅ `report-template.md` and `post-report.sh` — lock the output format.
3. ✅ **First-run lessons** (table above): agent driver, description file,
   brief tier wording, report renderer, suppression and de-dupe fixes.
4. **Evaluation** — started: fixture builder (two branches), answer key,
   planted false finding, scorer, first-run results. Still to do: more
   planted-defect and clean branches (seeded from known misses), the headless
   runner, and a baseline — several runs per branch, with spread — before
   adding anything. Then try the brief's `risks[]` against that baseline.
5. ✅ **Live GitHub paths** (`eval/results/2026-11-19-live-paths.md`): a full
   default run on a PR with an existing report (edited in place), `--update`
   after a push, and `--dont-stop` on a new PR, all on the private sandbox.
   Two bugs found and fixed: prior findings matched on wording only, and prior
   findings not raised again dropped out of the report.
6. ✅ Review depth: `depth-and-proof.md`, `classify.js` (config, path
   patterns, fan-in), which the brief starts from. Compare against the
   baseline once it exists.
7. ✅ Regression vs base, flaky re-runs, scanners: `run-checks.js`,
   `scan.js`.
8. **End-to-end and proof** — behaviour proof (`run-checks.js`) and
   screenshots are built: `capture.js` (base worktree + head, headless
   Chrome), `publish-assets.sh` (assets branch, commit-pinned
   `github.com/…/blob/…?raw=true` URLs), the batched image check, and the
   before/after table in the report. Tried on a private sandbox PR
   (`eval/results/2026-11-19-ui-sandbox.md`). **Opt-in (`--screenshots`)**
   until real PRs show it earns its place: it must start the app unaided,
   pushes an assets branch, and in the sandbox run the reviewer found the
   regression from the code alone. Make it default for visual changes if the
   trial shows it starting real apps and catching what review misses; remove
   it if it mostly reports Not run. Still to build: end-to-end runs
   through the live app (`⏭️ Not run`, no cap), and the SKILL.md steps that
   choose routes and the start command.
9. ✅ Redaction: `redact.js`, applied to the report input and again by
   `post-report.sh`; the workflow's `image-check` mode for screenshots.
10. ✅ Don't-stop mode commits, pushes and posts (redaction exists). Not yet
    run end to end.
11. ✅ Learned suppressions: offered after a decline (never Blocking),
    `suppressions.js` writes `.preflight/suppressions.yml`.
12. **Real PRs** — the skill is installed (`~/.claude/skills/preflight`
    links to this repo). Run it on 3–5 real PRs across repos, dry run first;
    record each run and every miss (`eval/misses.md`, then a fixture).
13. ✅ Packaged: `.claude-plugin/plugin.json` (0.2.0) and a README. Not yet
    released or listed; the repo has no licence yet.

## Distribution

Personal use first, public listing later. So from the start:

- Plugin layout and manifest, installed locally by symlink until it is listed.
- Nothing specific to one machine or repo: commands are discovered per project,
  no hardcoded paths. `gh` is the only hard dependency of the core loop;
  screenshot proof also needs a headless browser and is reported as not
  produced without one.
- All per-repo files live in one committed folder, `.preflight/`:
  `config.yml` (tier globs, thresholds, reviewer count — optional, so others
  can tune without forking) and `suppressions.yml`.
- README written for a stranger: what it posts on your PR, what it pushes, and
  what each mode does without asking.

## Open questions

- **Tier heuristics:** the fan-in cut-off for Shared and the path patterns for
  Core are guesses; settle after the trial PRs.
- **Image hosting:** settled (2026-11-19, private sandbox): GitHub leaves
  `github.com/…/blob/<commit>/…?raw=true` image URLs as written, so they load
  with the viewer's session — they render for anyone with access and 404
  for anyone without.
- **Assets branch housekeeping:** prune a PR's images when it merges or closes,
  or keep them so old reports stay intact?
- **Running the base:** two builds and two servers per visual PR is slow. Cache
  base screenshots per base SHA, or accept the cost?
- **Same-model agreement:** reviewers and skeptic are the same model, so their
  agreement is correlated. Run the skeptic on a different model? Measure with
  the eval (skeptic loss, false positives) before deciding.
- **Fast path:** is there a time or cost budget for small PRs beyond the Leaf
  and Inert tiers? Decide from the eval's cost-per-PR numbers. First number:
  ~770k tokens for a 33-line Shared PR with five serious findings, most of it
  per-agent overhead (~55k each), so the skeptic and verifier counts dominate.
  Batching skeptics, or a lighter agent type for them, are the obvious levers.
- **Workflow tool:** the workflow is written for a Workflow tool that Claude
  Code sessions do not have today; `run-workflow.js` is the working path. Keep
  both, or drop the Workflow shape?
- **Narrow or broad reviewers:** one agent per lens (eight agents), or the
  lenses folded into one to three agents by tier as planned? Compare catch
  rate and cost on the eval before fixing the split.
- **Stance calibration:** "hunt hard, empty is valid" is a middle between a
  high-confidence-only reviewer and a must-find-something one. Tune the
  wording against catch rate and false-positive rate, not by feel.
- **Known misses:** which kinds of defect have slipped through self-review so
  far? Those seed the first fixtures and the misses log.
- **Name:** settled — `/preflight` (renamed from `/self-review` on
  2026-11-19; the repo from `pr-self-review` to `pr-preflight`, then `preflight`). Reports
  written under the old name are still found and replaced.
- **Licence:** the repo has none; needed before a public listing.
- **Base dependencies:** `run-checks.js` links `node_modules`, `.venv`,
  `venv` and `vendor` from the head into the base worktree. When the PR
  changes dependencies the base runs against the head's, which can blur a
  regression. Install per worktree instead, at the cost of time?
