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
- If the app cannot be run here, say so in the report as **not run** with the
  reason.

### 5. Independent review (subagents)

Reviewers are separate subagents with **fresh context**: they get the diff, the
confirmed intent, and repo conventions — not this session's history or the
author's reasoning, so they cannot inherit its blind spots.

- **Two reviewers** by default, in parallel, split so they overlap as little as
  possible:
  - **Does it work?** — correctness, edge cases, error handling, security
    (secrets, injection, authz, new dependencies), compatibility.
  - **Is it honest and maintainable?** — tests (would they fail if the code
    broke?), the AI-code failure modes list below, duplication of existing
    helpers, needless abstraction, dead code, conventions.
- **A third reviewer** is added when the PR is large or risky: roughly more
  than 400 changed lines or 15 files, or it touches auth, payments, migrations,
  or public API. The third takes security + compatibility as a dedicated lens,
  leaving the first reviewer on pure correctness. Thresholds are tunable after
  trying it on real PRs.
- Every finding must carry: `file:line`, a concrete failure scenario
  (input/state → wrong result), and a proposed severity. Findings without a
  concrete scenario are dropped.

### 6. Skeptic verification

- A separate skeptic subagent takes each finding and tries to **disprove** it:
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
- **One reviewer, fix diff only:** a single fresh subagent checks that each fix
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
│       ├── reviewers.md          # reviewer + skeptic prompts, one per lens
│       ├── ai-failure-modes.md   # the checklist above
│       ├── report-template.md    # the PR comment template (single source)
│       └── scripts/
│           ├── gather.sh         # PR metadata + diff + CI in one bundle
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
4. Try it on real PRs: one clean, one with planted bugs (to measure what the
   reviewers catch and what the skeptic wrongly rejects), one where e2e
   cannot run.
5. Package (plugin manifest, README install steps) and release.

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

- **Third-reviewer thresholds:** 400 lines / 15 files / sensitive paths is a
  guess; settle after the trial PRs.
