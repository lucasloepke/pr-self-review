# pr-self-review — implementation plan (light)

A Claude Code skill that reviews **your own** PR before you ask a human to look at it:
catch the embarrassing stuff, check the diff matches what the PR says it does, and
leave the PR easier to review.

Status: plan only. Nothing is implemented yet.

## What it does

1. **Find the target.** Current branch's PR via `gh pr view`; fall back to
   `git merge-base` against the default branch if no PR exists yet. Accept an
   optional PR number / base branch argument.
2. **Gather context.** Diff, commit list, PR title/body, linked issue, CI status.
3. **Review as the author, not a stranger.** Passes, in order:
   - *Intent vs. diff* — does the change do what the description claims; anything
     in the diff the description doesn't mention (scope creep, stray files)?
   - *Leftovers* — debug prints, commented-out code, TODOs, `.only` tests,
     secrets, accidental lockfile/formatting churn.
   - *Correctness* — edge cases, error handling, obvious bugs in changed lines.
   - *Tests* — is new behaviour covered; do the tests actually assert anything?
   - *Reviewability* — PR size, description quality, places a reviewer will
     have questions.
4. **Report.** Findings ranked by severity with `file:line`, each tagged
   `fix` / `explain` / `nit`. Nothing is changed or posted without a go-ahead.
5. **Optional follow-through (ask first).**
   - Apply the `fix` items locally.
   - Post `explain` items as author's-note comments on the PR.
   - Propose an improved PR description.

## Repo layout

```
pr-self-review/
├── README.md                 # what it is, install, usage
├── skills/
│   └── self-review/
│       ├── SKILL.md          # frontmatter + the workflow above
│       ├── checklist.md      # the review passes in detail (loaded on demand)
│       └── scripts/
│           └── gather.sh     # one call: PR metadata + diff + CI as a bundle
└── .claude-plugin/
    └── plugin.json           # so it installs as a plugin (optional, step 4)
```

## Steps

1. Write `SKILL.md` — tight description/triggers ("self-review", "review my PR
   before I request review"), workflow, output format, the ask-before-acting gate.
2. Write `checklist.md` and `gather.sh`.
3. Try it on a couple of real PRs (one small, one messy); tune the checklist
   toward fewer, higher-signal findings.
4. Package: plugin manifest + README with install instructions
   (symlink into `~/.claude/skills/` or install as plugin).
5. Push to GitHub.

## Open questions

- **Distribution:** personal skill only, or a shareable plugin?
- **Posting to the PR:** should author's-note comments be in scope at all, or
  keep it strictly local?
- **Overlap with `/code-review`:** this differs by using the PR description as
  the spec and focusing on author-side hygiene — worth keeping it that narrow?
- **Repo-specific rules:** should it read a project's CLAUDE.md /
  CONTRIBUTING.md / PR template and check against those?
