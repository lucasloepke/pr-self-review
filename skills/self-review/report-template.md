# Report comment template

The single source for the PR comment. Fixed section order, fixed headings,
fixed table columns. An empty section stays and says `None`, so the shape
never changes. Only *Changes since the last run* is omitted, on a first run.

## Rendering rules

- Line 1 is exactly `<!-- pr-self-review -->`. The last line is exactly `-->`,
  closing the state block. `scripts/post-report.sh` refuses anything else.
- Severity in tables: `Blocking`, `Important`, `Suggestion`, `Nit`.
- Skeptic column: `Confirmed`, `Reduced`, `Unproven`, or `—` when the finding
  did not go to a skeptic.
- Status is one of: `Fixed in <sha>`, `Open`, `Open — needs author decision`,
  `Deferred`, `Declined`, `Pre-existing`. Nothing else. A reason follows after
  ` — `.
- The Findings table lists every Blocking and Important finding, then the
  Suggestions and Nits that were fixed. Suggestions and Nits not taken go in
  the collapsed block under *Notes for the reviewer*.
- Commit SHAs are filled in after the commits exist; in a dry run a fixed
  finding reads `Fixed in working tree`.
- A check that did not run says `Not run` with the reason in Notes. Never
  leave a row out and never report an unrun check as `Pass`.

## Verdict — first match wins

1. **Not ready** — any Blocking finding is `Open`, or tests are red.
2. **Ready with open items** — any Blocking or Important finding is open,
   deferred or declined; or tests are pending or were not run; or owed proof
   was not produced.
3. **Ready for review** — otherwise, regardless of Suggestions and Nits.

A Blocking finding the author deferred or declined does not hold the verdict
at *Not ready*, but is listed first under *Decisions worth a second opinion*.

## State block

One JSON object, on the lines between `<!-- pr-self-review:state v1` and
`-->`. Severities lower-case (`blocking`); `status` uses the status vocabulary
above; `skeptic` is `confirmed`, `reduced`, `unproven` or `skipped`. Write
every `>` inside the JSON as `>` so no string can close the comment
early. Include every finding ever raised on this PR — fixed, open, deferred,
declined, and Suggestions and Nits not taken — because a finding missing from
state will be raised again.

```json
{"reviewedSha":"", "baseSha":"", "mode":"default", "tier":"Shared", "skill":"0.1.0",
 "brief":{"purpose":"", "acceptance":[], "outOfScope":[], "tiers":[], "unexplained":[], "description":"sufficient", "flagGate":{"required":false}},
 "checks":{"scope":"", "tests":"", "regression":"", "e2e":"", "proof":"", "flagGate":""},
 "findings":[{"id":"", "file":"", "line":0, "lens":"", "severity":"", "claim":"", "intended":"", "observed":"", "failureCase":"", "skeptic":"", "status":"", "reason":""}],
 "rejected":[{"id":"", "file":"", "line":0, "severity":"", "claim":"", "reason":""}]}
```

## Template

```markdown
<!-- pr-self-review -->
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

<!-- pr-self-review:state v1
<state JSON>
-->
```
