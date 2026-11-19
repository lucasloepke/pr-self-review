# Review depth and proof

How each changed area is tiered, how deep it is reviewed, and what proof the
report owes for it. `scripts/classify.js` makes the first guess; the brief
agent refines it; the author confirms it at the intent stop.

## Tiers

| Tier | What lands here | Reviewers | How it is read |
|---|---|---|---|
| **Core** | Auth and sessions, data layer and migrations, payments, infrastructure and deploy, CI, build config, a versioned or published API | 4 (5 at 400+ changed lines) | Whole files, every caller traced; security and compatibility get their own reviewer |
| **Shared** | Libraries, utilities, hooks, shared components, dependency manifests, anything imported by several files | 2 | Every call site of a changed signature or behaviour checked |
| **Leaf** | One route, screen or component; styling; copy; assets | 1 | Light read; the proof carries the weight |
| **Inert** | Docs, comments, non-shipping config | 0 | Skim for accuracy |

The PR takes the highest tier among its areas. Reviewers are told each area's
tier, so a Core file in a mostly-Leaf PR still gets a deep read.

**How an area gets its tier** (first match wins, then the highest signal):

1. `.self-review/config.yml` → `tiers:` globs. Binding.
2. Docs and non-shipping files → Inert.
3. Core path patterns (see `classify.js`).
4. Fan-in: imported by `fanInShared` or more non-test files (default 2) → at
   least Shared. JS/TS relative imports and Python modules are counted; other
   languages fall back to path patterns.
5. Shared path patterns (`lib/`, `utils/`, `shared/`, `hooks/`, …).
6. Otherwise Leaf.

A test file takes the tier of the code it tests. When unsure, the higher tier.

```yaml
# .self-review/config.yml — every key optional
tiers:
  Core: ["src/billing/**", "src/auth/**"]
  Leaf: ["src/marketing/**"]
fanInShared: 3
scanners:
  - name: semgrep
    cmd: semgrep --config auto --json
```

## Change kinds and the proof they owe

| Kind | Proof owed | Made by | If it cannot be made |
|---|---|---|---|
| Behaviour (bug fix, feature) | A test that fails on the base and passes on the head | `run-checks.js --proof-tests` | `⚠️ Not produced` (caps the verdict): e.g. the changed tests pass on the base too |
| API / CLI | As behaviour; request/response or command/output before and after when a test cannot show it | `run-checks.js`, else by hand in the session | As behaviour |
| Refactor | Same test results on base and head; no change in public surface | `run-checks.js` | As behaviour |
| Visual | Before/after screenshots, same route, viewport and data | `capture.js`, only with `--screenshots` | `⏭️ Not run` (does not cap): flag off, no Chrome, or the app will not start |
| Performance | The measurement before and after, with its command | By hand | `⚠️ Not produced` |
| Inert | None | — | `➖ Not required` |

Changed tests that pass on the base as well are listed in
`proof.passOnBase`: they may not test the change at all. Pass that list to the
review as a lead.
