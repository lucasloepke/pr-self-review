---
name: preflight
description: Use when the author of a pull request or branch wants their own change checked before a human reviews it — "preflight", "self-review", "review my PR before I request review", "is this ready for review", or re-checking after pushing fixes to a PR that already carries a preflight (or older self-review) report.
---

# Preflight

Review **your own** PR before asking a human: confirm what it is meant to do,
have independent reviewers try to break it, fix what survives a skeptic, and
leave one report comment on the PR.

**Stance: hunt hard, report strictly, stop.** The aim is not to find
something. A run with no Blocking or Important findings is a normal,
successful result — say so plainly.

```
/preflight [<pr>] [--dont-stop] [--update] [--dry-run] [--screenshots] [--brief <file>]
             [--description <file>] [--issue <file>]
```

| Flag | Effect |
|---|---|
| *(none)* | Three stops: intent, after findings, before commit/push/post |
| `--dont-stop` | One stop: intent. Then fixes and finishes without pausing |
| `--update` | After new pushes: re-verify open findings, review only new hunks |
| `--dry-run` | Everything runs; the report is written to a file. No commit, push or post. Works with no PR |
| `--screenshots` | For visual changes: start the app on base and head, capture before/after screenshots, publish them to a `preflight-assets` branch. Off by default |
| `--brief <file>` | A pre-confirmed brief (JSON); the intent stop is skipped |
| `--description <file>` | Branch with no PR only: the would-be PR title (first line) and body. Passed to `gather.sh` |
| `--issue <file>` | The linked ticket, same format, when it is not on GitHub. Passed to `gather.sh` |

`<skill>` below is this skill's directory; `<work>` is the folder `gather.sh`
prints as `workDir`.

## Rules that hold in every phase

- **Review agents are fresh.** Brief drafter, reviewers, skeptics and fix
  verifiers run through `<skill>/review-workflow.js`, which gives each a fixed
  prompt plus artifacts. Never fork the session for them, and never add your
  summary, your opinion of the change, the author's reasoning or another
  agent's conclusions to what they receive.
- **Code applies the rules.** Severity ceilings, de-duplication, ids, caps and
  prior-decision matching come back from the workflow already applied. Do not
  re-rank, merge, re-word or drop findings yourself.
- **Not run is said, never skipped.** A phase or check that could not run is
  reported `Not run` with the reason — not omitted, not `Pass`.
- **Every finding is raised once.** Deferred, declined and already-raised
  Suggestions and Nits come back under `carried`; they stay in the report under
  their disposition and are not put to the author again.

## Running the workflow

"Run the workflow with `{…}`" below means: write that object to a new
`<work>/<step>/args.json` (`brief`, `review`, `verify-1`, …) and run it.

- **Workflow tool available:** run `<skill>/review-workflow.js` with it.
- **Otherwise** (the usual case), loop with the driver:

  ```bash
  node <skill>/scripts/run-workflow.js <work>/<step>/args.json <work>/<step>
  ```

  `"status": "pending"` → for every entry in `pending`, start one
  general-purpose subagent — fresh, never a fork — all in one message so they
  run in parallel, each with exactly this prompt and nothing else:
  `Read the file <prompt> and carry out the instructions in it exactly. It is your whole task.`
  When they have all finished, run the driver again. Repeat until
  `"status": "done"`; the workflow's result is the `result` file. If a
  subagent finished without writing its answer, run once more with `--final`
  so it counts as failed rather than waiting forever. Anything under
  `invalid` is a failed agent: say so in the report.

Create one task per phase and work through them in order.

## 1. Gather

```bash
bash <skill>/scripts/gather.sh [<pr>] [--since <sha>] [--description <file>] [--issue <file>]
```

Read `meta.txt`. If `dirty: yes`, tell the author uncommitted changes are not
part of the review. If `pr: none` and this is not a dry run, the draft PR is
opened at the intent stop (phase 2), not before. If `prior-state.json` exists,
load it: its `findings` are passed to the review as `priorFindings`.

Then, in the repo root:

```bash
node <skill>/scripts/classify.js --repo . --work <work>        # tier + kind guesses → classify.json
node <skill>/scripts/scan.js --repo . --work <work>            # scanner leads
node <skill>/scripts/suppressions.js list --repo .             # the repo's learned suppressions
```

Keep `scan.js`'s `leads` and the suppression list for phase 4. Tier rules and
the proof each change kind owes are in `<skill>/depth-and-proof.md`.

## 2. Confirm intent — the stop both modes share

With `--brief <file>`, use that brief and go to phase 3.

Otherwise run the workflow with
`{mode: "brief", repoRoot, workDir, skillDir}` and show the author the brief:
purpose, acceptance criteria, out of scope, each area's tier and why (the
brief starts from `classify.json`; tiers from the repo's config are binding),
unexplained changes, whether a feature flag was asked for. Ask them to
confirm or correct it. At this same stop, settle everything else that needs a
yes before the review can start:

- **Each unexplained change:** *meant to be there* (it joins the acceptance
  criteria and the description) or *not meant to be there* (it comes out of
  the PR before the review continues; re-run phase 1 afterwards).
- **Description needs writing:** draft one from the confirmed brief (purpose,
  what changed, how to test, risks); on approval write it with
  `gh pr edit <n> --body-file`.
- **No PR:** ask to push the branch and open a **draft** PR.

Do not start phase 3 until the author has confirmed. The PR's tier is the
highest tier among its areas.

`flagGate.required` is true only when the ticket or PR body asks for a flag.
Never raise the absence of a feature flag otherwise; the report row then reads
`Not required`.

## 3. Tests, regression and proof

Find the project's test, lint, typecheck and build commands (package scripts,
Makefile, CI config, CLAUDE.md). Then run them through `run-checks.js`, which
re-runs failures (flaky), compares what still fails with the base
(regression or pre-existing) and produces behaviour proof:

```bash
node <skill>/scripts/run-checks.js --repo . --out <work>/checks --base <baseSha> \
  --cmd "<test command>" [--cmd "<lint command>" …] \
  --proof-tests <work>/files-test.txt --test-diff <work>/test.diff
```

- `ci: current` and green → report the Tests row from CI (`CI @ <sha>`); run
  `run-checks.js` with the test command only, for its Regression and Proof
  rows. `ci: current` and red → run it too, to tell regressions from
  pre-existing and flaky failures. `ci: stale` or `none` → run it with every
  command; all three rows come from its `rows`.
- **Red** — `rows.tests.result` is `Fail`: failures that are new on the head —
  is the first Blocking finding. Default mode: stop and offer to diagnose; the
  author may proceed on red, and the report records that they did. Don't-stop
  mode: record it and continue. CI pending → continue; the report says so.
  Pre-existing and flaky failures are noted, never Blocking for this PR.
- **Proof** follows the change kinds in the confirmed brief
  (`depth-and-proof.md`): behaviour, API/CLI or refactor → `rows.proof` and
  `proofMarkdown` (the report's Proof section). Visual → screenshots, below,
  with `--screenshots`; without it, Proof `Not run`, "screenshots are off (run
  with --screenshots)", which does not cap the verdict. Performance → the
  measurement before and after, by hand. Only inert → `Not required`.
- **Screenshots — only with `--screenshots`.** Without the flag, do not start
  the app, capture, or push an assets branch. With it, for visual changes: pick the start command (package
  scripts `dev` / `start`, README, CLAUDE.md) and the pages — every page the
  acceptance criteria name, plus pages that render the changed components or
  styles (a shared stylesheet means the main pages, not just the one the PR is
  about). Then:

  ```bash
  node <skill>/scripts/capture.js --repo . --base <baseSha> --out <work>/shots \
    --start "<start command>" --routes /a,/b [--port-env PORT]
  ```

  A page marked `changed` that the PR is not meant to touch is a lead: add it
  to the leads and look at the image yourself. Before anything is published,
  run the workflow in `image-check` mode on every image; only `publish: true`
  images go further. Not a dry run →
  `bash <skill>/scripts/publish-assets.sh <pr> <headSha> <images…>` and use
  each file's `url`; dry run → use the local paths. Pass
  `screenshots: [{route, before, after, changed}]` to the report. `notRun`
  (no Chrome, the app would not start) → Proof `Not run` with that reason.
- `proof.passOnBase` lists changed tests that pass on the base too. If it is
  not empty, write it to `<work>/leads/pass-on-base.json` and add that to the
  leads: such tests may not test the change.

End-to-end through the running app is not built yet: report it `Not run`,
"not supported yet".

## 4. Review and skeptic

Run the workflow with:

```
{mode: "review", repoRoot, workDir, skillDir, brief, tier, changedLines,
 dontStop, conventions, leads, suppressions, priorFindings}
```

`leads` are the paths from `scan.js` plus `leads/pass-on-base.json` when it
exists; `suppressions` is the list from `suppressions.js list`.

It returns `findings` (already checked by a skeptic where one was owed),
`collapsed`, `rejected`, `carried`, `suppressed`, `discarded`, `reviewers` and
`counts`. A reviewer in `counts.reviewersNotRun` is a check that did not run:
say so in the report.

## 5. Triage

Show the findings grouped by severity, each as intended / observed / failure
case in plain language, with the skeptic's verdict.

**Default mode — one question: "Continue with fixes, or chat about it?"**

- *Continue* → fix every Blocking and Important finding that has a clear fix.
- *Chat* → take Blocking and Important findings one at a time, most severe
  first. For each the author picks **Fix**, **Defer** (a reason, and a ticket
  or follow-up link when there is one) or **Decline** (a reason). If a decline
  does not answer the failure case, say so once, then record the answer as
  given. Offer Suggestions and Nits as one group to take or skip.
- After a **Decline** of an Important, Suggestion or Nit finding, ask once:
  "Stop raising this kind of finding in this repo?" On a yes, describe the
  kind in a sentence (not the single instance) and run
  `node <skill>/scripts/suppressions.js add --repo . --pattern "<kind>" --reason "<their reason>"`.
  The changed `.preflight/suppressions.yml` is committed with the fixes.
  Never offer this for a Blocking finding.

**Don't-stop mode** → no question. Fix every finding the skeptic confirmed or
reduced, at Blocking, Important or Suggestion, that has a clear fix.

In both modes these are not fixed and are reported
`Open — needs author decision`: a finding with `needsDecision`, and a finding
the skeptic left `unproven` whose fix would change behaviour. In don't-stop
mode Nits are listed, never fixed.

## 6. Fix

One finding at a time, the smallest change that resolves it. Nothing
unrelated, nothing outside the PR's scope. Where the finding has a clear
failure case, add or extend a test that fails before the fix and passes after.
Fixes stay in the working tree, uncommitted, until phase 8.

## 7. Verify the fixes

The session that wrote a fix does not grade it. Save the combined fix diff
(`git diff > <work>/fix.diff`) and run the workflow with:

```
{mode: "verify", repoRoot, workDir, skillDir, brief,
 findings: <the fixed findings>, fixDiffPath: "<work>/fix.diff"}
```

Also re-run the tests added or touched and the tests for the changed modules.

- `resolved` → status `Fixed`, with the verifier's quoted evidence.
- `partial`, `unresolved`, a failing test, or anything in `introduced` → back
  to phase 6 for that finding. **Two rounds at most**; whatever is left is
  reported `Open`, and the run moves on.

This is not a second review: do not re-run phases 2–4, and do not raise new
Suggestions or Nits here.

## 8. Report, commit, push, post

Write `<work>/report-input.json` — its fields are listed at the top of
`<skill>/scripts/render-report.js`: the review workflow's result as it came
back, one decision per finding (status from the closed vocabulary, with the
verifier's evidence for `Fixed` and the author's reason for `Deferred` /
`Declined`), every check's result, the confirmed brief and its coverage. Then:

```bash
node <skill>/scripts/render-report.js <work>/report-input.json > <work>/report.md
```

The renderer applies `report-template.md` — section order, vocabulary,
verdict rule, state block — and prints the verdict. It refuses a status or
check result outside the vocabulary. Do not write or edit the report by hand.

**Redaction, before anything is shown or posted:**

```bash
node <skill>/scripts/redact.js mask <work>/report-input.json
```

It masks secrets and personal data (tokens, keys, cookies, auth headers,
secret assignments, emails, home paths) in place and prints what it masked.
If `total` is above 0, add "N items masked as possible secrets or personal
data (<kinds>)" to `notVerified` and render again. `post-report.sh` masks the
posted copy once more as a safety net. Screenshots, when there are any, go
through the workflow's `image-check` mode first; only `publish: true` images
are published, and each withheld one is listed under `notVerified`.

- **`--dry-run`:** stop here. Tell the author where `report.md` is and that
  the fixes are uncommitted in the working tree.
- **Default mode:** show the fix diff and the rendered comment, and ask once.
  On a yes: one commit per finding (message names the finding id), push, add
  each commit to its decision, set `headSha` to the new head (the fixes were
  verified, so the next `--update` starts after them) and render again, then
  `bash <skill>/scripts/post-report.sh <pr> <work>/report.md`.
- **Don't-stop mode:** commit, push and post as above without asking.

`post-report.sh` edits the existing report comment when there is one.
Never post with `gh pr comment` directly.

## `--update`

1. Phase 1, then load `prior-state.json`. With no prior state, do a full run.
2. Re-verify every prior Blocking and Important finding whose status is
   `Open` or `Fixed` with the workflow's `verify` mode (no `fixDiffPath`) —
   fixed ones too, since what was pushed may differ from what was verified.
   Prior Suggestions and Nits are not re-verified: they were raised once and
   come back under `carried`.
3. Re-run `gather.sh --since <reviewedSha>` so the diffs hold only new hunks.
   Reuse the stored brief. If the new hunks contain changes the brief does not
   account for, reopen the intent stop for those changes only.
4. Phases 3–7 on the new hunks, passing
   `scopeNote: "The diffs hold only hunks added since <reviewedSha>."`
5. Phase 8 with `prior` set to `prior-state.json`, which fills in *Changes
   since the last run*. Deferred and declined findings are carried forward
   untouched; findings re-verified in step 2 get a decision from that result.

## Common mistakes

| Mistake | Instead |
|---|---|
| Starting reviewers before the author confirmed the brief | Intent is the one stop no flag removes except `--brief` |
| Telling a reviewer what you think is wrong | Artifacts only; the workflow builds the prompt |
| Padding a clean result with minor findings | Report "No blocking or important findings" |
| Raising a declined finding again on a re-run | It is in `carried`; leave it under its disposition |
| Re-running the whole review after a fix | Verify mode, scoped, two rounds |
| Marking a finding fixed because you fixed it | Only a verifier's `resolved` makes it `Fixed` |
| Committing or pushing in default mode before the go-ahead | Working tree only until the author says yes |
| Dropping the Proof or End-to-end row because it did not run | `Not run` / `Not produced`, with the reason |
| Calling a failure the PR's when it also fails on the base | `run-checks.js` decides: regression, pre-existing or flaky |
| Counting changed tests as proof without running them on the base | Proof is what fails on the base and passes on the head |
| Posting a second comment | `post-report.sh` edits the existing one |
| Showing the author a report before redaction | `redact.js mask` on `report-input.json`, then render |
| Offering to suppress a Blocking finding | Suppressions are for Important and below |
