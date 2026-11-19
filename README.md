# pr-self-review

A Claude Code skill that reviews **your own** pull request before you ask a
human to: it confirms what the PR is for, runs your checks against the base
branch, has independent reviewers try to break the change, verifies each
finding with a skeptic, fixes what survives, and leaves one report comment on
the PR.

```
/self-review                  # the PR for the current branch
/self-review 123              # a specific PR
/self-review --dry-run        # everything runs; the report goes to a file, nothing is committed, pushed or posted
/self-review --dont-stop      # after you confirm intent, fix and post without pausing
/self-review 123 --update     # after new pushes: re-check open findings, review only what is new
```

## What it does to your repo and PR

Know this before the first run:

| | Default | `--dont-stop` | `--dry-run` |
|---|---|---|---|
| Asks you to confirm what the PR is for | ✅ | ✅ | ✅ (unless `--brief` is given) |
| Opens a **draft** PR if the branch has none | asks first | asks first | never |
| Rewrites a thin PR description | asks first | asks first | never |
| Fixes findings in your working tree | the ones you choose | every confirmed Blocking / Important / Suggestion with a clear fix; never Nits or anything needing a product decision | the ones you choose; left uncommitted |
| Commits (one per finding) and pushes | after one go-ahead | yes | never |
| Posts or edits **one** comment on the PR | after the same go-ahead | yes | never — written to a file |
| Writes `.self-review/suppressions.yml` | only when you ask it to stop raising a kind of finding | no | no |

Everything bound for GitHub is redacted first: tokens, keys, cookies, auth
headers, secret assignments, emails and home paths are masked. On a public
repo the comment is public.

The comment carries a verdict (✅ Ready for review · 🟡 Ready with open
items · ⛔ Not ready), the confirmed intent, a checks table (tests,
regression vs base, proof), every Blocking and Important finding with the
skeptic's verdict and its status, what was not verified, and a hidden state
block so the next run remembers what was decided.

## How it works

1. **Gather** the PR, its diff (split into production and test code), CI
   status, linked issue and any earlier report.
2. **Confirm intent** — the one stop every mode makes: a drafted brief
   (purpose, acceptance criteria, out of scope, risk tier of each area,
   unexplained changes) for you to confirm or correct.
3. **Checks** — your tests, lint and build; failures re-run to spot flaky
   tests and compared with the base branch to separate regressions from
   failures that were already there. Behaviour proof: the PR's changed tests
   run against the base should fail there and pass on the head.
4. **Review** — 1 to 5 fresh reviewers depending on risk (Leaf, Shared,
   Core), each told to hunt hard and report only what it can demonstrate. An
   empty result is a normal outcome. Every Blocking and Important finding
   goes to its own skeptic, which tries to disprove it.
5. **Triage** — "Continue with fixes, or chat about it?" Fix, defer or
   decline each finding; declines can become repo-wide suppressions.
6. **Fix and verify** — each fix is checked by an agent that did not write
   it, at most two rounds.
7. **Report** — rendered from a fixed template in code, redacted, posted.

Severity limits, de-duplication, finding ids, the verdict and the report
format are applied by scripts, not by a model.

## Install

Requirements: [Claude Code](https://claude.com/claude-code), `git`, the
[GitHub CLI](https://cli.github.com) (`gh auth login` done), Node.js 18+.

As a local skill (updates whenever this checkout changes):

```bash
git clone https://github.com/lucasloepke/pr-self-review.git
ln -s "$PWD/pr-self-review/skills/self-review" ~/.claude/skills/self-review
```

The repo is also laid out as a Claude Code plugin (`.claude-plugin/plugin.json`).

## Per-repo settings

All optional, in `.self-review/` at the repo root, committed with the repo:

```yaml
# .self-review/config.yml
tiers:                      # force a review tier by path
  Core: ["src/billing/**", "src/auth/**"]
  Leaf: ["src/marketing/**"]
fanInShared: 3              # files importing a module before it counts as Shared (default 2)
scanners:                   # your own scanners; output goes to the reviewers as leads
  - name: semgrep
    cmd: semgrep --config auto --json
```

`suppressions.yml` is written by the skill when you decline a finding and ask
it not to raise that kind again. Edit it freely.

## Not built yet

- Before/after **screenshots** for visual changes (reported as `⏭️ Not run`;
  this does not hold back the verdict).
- **End-to-end** runs through the live app (reported as `⏭️ Not run`).

## Developing

```bash
node --test test/                                   # unit tests, no dependencies
bash eval/fixture/build.sh /tmp/psr-fixture         # the evaluation fixture
```

`PLAN.md` is the design and build plan; `eval/` holds the fixture, answer
key, scorer and results.
