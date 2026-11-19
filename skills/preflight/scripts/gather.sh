#!/usr/bin/env bash
# Collects everything the review works from into one folder and partitions
# the diff into production and test hunks.
#
#   bash gather.sh [<pr-number>] [--since <sha>] [--out <dir>]
#                  [--description <file>] [--issue <file>]
#
#   <pr-number>   review that PR (its branch must be checked out); default: the
#                 PR of the current branch, or the bare branch when it has none
#   --since <sha> diff from <sha> instead of the merge base (used by --update)
#   --out <dir>   where to write; default: <git-dir>/preflight
#   --description <file>  no PR only: the would-be PR title (first line, a
#                 leading "# " is dropped) and body (the rest)
#   --issue <file>  the linked ticket, same format; overrides the PR's link
#
# Writes: meta.txt, pr.json, issue.json, checks.json, prior-state.json,
# commits.txt, diffstat.txt, files-prod.txt, files-test.txt, full.diff,
# prod.diff, test.diff, conventions.txt. Files with nothing to hold are absent.
# The diff is of committed code (… HEAD); uncommitted changes are flagged in
# meta.txt as dirty, not reviewed.
set -euo pipefail

die() { echo "gather: $*" >&2; exit 1; }

PR="" SINCE="" OUT="" DESC="" ISSUE_FILE=""
while (($#)); do
  case "$1" in
    --since) SINCE="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --description) DESC="${2:-}"; shift 2 ;;
    --issue) ISSUE_FILE="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) PR="$1"; shift ;;
  esac
done
[[ -z "$PR" || "$PR" =~ ^[0-9]+$ ]] || die "PR must be a number, got '$PR'"
for f in "$DESC" "$ISSUE_FILE"; do
  [[ -z "$f" || -s "$f" ]] || die "'$f' is missing or empty"
done
DESC=${DESC:+$(cd "$(dirname "$DESC")" && pwd)/$(basename "$DESC")}
ISSUE_FILE=${ISSUE_FILE:+$(cd "$(dirname "$ISSUE_FILE")" && pwd)/$(basename "$ISSUE_FILE")}

# Title on the first line (a leading "# " dropped), body after it → JSON.
text_to_json() { # <file> <extra-json-fields>
  node -e '
    const [file, extra] = process.argv.slice(1)
    const lines = require("fs").readFileSync(file, "utf8").replace(/\r\n/g, "\n").split("\n")
    const title = lines.shift().replace(/^#\s+/, "").trim()
    const body = lines.join("\n").trim()
    process.stdout.write(JSON.stringify({ title, body, ...JSON.parse(extra) }))
  ' "$1" "$2"
}

ROOT=$(git rev-parse --show-toplevel) || die "not inside a git repository"
cd "$ROOT"
OUT=${OUT:-$(git rev-parse --absolute-git-dir)/preflight}
mkdir -p "$OUT"
for f in meta.txt pr.json issue.json checks.json prior-state.json commits.txt diffstat.txt \
         files-prod.txt files-test.txt full.diff prod.diff test.diff conventions.txt; do
  rm -f "$OUT/$f"
done

BRANCH=$(git branch --show-current)
HEAD_SHA=$(git rev-parse HEAD)
MARKER='<!-- preflight -->'
LEGACY_MARKER='<!-- pr-self-review -->'   # reports written before the rename

# --- PR -----------------------------------------------------------------------
NUMBER="" BASE="" PUSHED_SHA="" PR_STATE=""
if line=$(gh pr view ${PR:+"$PR"} --json number,baseRefName,headRefName,headRefOid,state \
            --jq '[.number,.baseRefName,.headRefName,.headRefOid,.state]|@tsv' 2>/dev/null) && [[ -n "$line" ]]; then
  IFS=$'\t' read -r NUMBER BASE PR_BRANCH PUSHED_SHA PR_STATE <<<"$line"
  [[ "$PR_BRANCH" == "$BRANCH" ]] || die "PR #$NUMBER is for branch '$PR_BRANCH' but '$BRANCH' is checked out — check out the PR branch first"
  [[ -z "$DESC" ]] || die "PR #$NUMBER has its own description; --description is only for a branch with no PR"
  gh pr view "$NUMBER" --json number,title,body,url,state,isDraft,baseRefName,headRefName,headRefOid >"$OUT/pr.json"
elif [[ -n "$PR" ]]; then
  die "could not read PR #$PR (gh auth status? right repo?)"
else
  BASE=$(gh repo view --json defaultBranchRef --jq .defaultBranchRef.name 2>/dev/null || true)
  if [[ -z "$BASE" ]]; then
    BASE=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||' || true)
  fi
  if [[ -z "$BASE" ]]; then
    for b in main master; do
      if git rev-parse --quiet --verify "$b" >/dev/null; then BASE=$b; break; fi
    done
  fi
  [[ -n "$BASE" ]] || die "no PR for this branch and no default branch found"
  [[ "$BRANCH" != "$BASE" ]] || die "on the default branch '$BASE' with no PR — nothing to review"
  [[ -z "$DESC" ]] || text_to_json "$DESC" '{"state":"NONE","source":"--description"}' >"$OUT/pr.json"
fi

# --- Range --------------------------------------------------------------------
git fetch --quiet origin "$BASE" 2>/dev/null || true
if git rev-parse --quiet --verify "origin/$BASE" >/dev/null; then BASE_REF="origin/$BASE"; else BASE_REF="$BASE"; fi
MERGE_BASE=$(git merge-base "$BASE_REF" HEAD) || die "no merge base between $BASE_REF and HEAD"
FROM=$MERGE_BASE
if [[ -n "$SINCE" ]]; then
  FROM=$(git rev-parse --quiet --verify "$SINCE^{commit}") || die "--since $SINCE is not a commit in this repo"
fi

# --- Diff, partitioned --------------------------------------------------------
TEST_RE='(^|/)(tests?|specs?|__tests__|__mocks__|__snapshots__|fixtures|testdata|e2e|cypress)/|[._-](test|spec)\.[^/]+$|_test\.[^/]+$|(^|/)test_[^/]+\.py$|(^|/)conftest\.py$'
git diff --name-only "$FROM" HEAD >"$OUT/files-all.tmp"
grep -E "$TEST_RE" "$OUT/files-all.tmp" >"$OUT/files-test.txt" || true
grep -vE "$TEST_RE" "$OUT/files-all.tmp" >"$OUT/files-prod.txt" || true
rm -f "$OUT/files-all.tmp"

partition() { # <list-file> <out-diff>
  : >"$2"
  [[ -s "$1" ]] || return 0
  local paths=()
  while IFS= read -r p; do paths+=("$p"); done <"$1"
  git diff "$FROM" HEAD -- "${paths[@]}" >"$2"
}
git diff "$FROM" HEAD >"$OUT/full.diff"
partition "$OUT/files-prod.txt" "$OUT/prod.diff"
partition "$OUT/files-test.txt" "$OUT/test.diff"
git diff --stat "$FROM" HEAD >"$OUT/diffstat.txt"
git log --format='%h %s%n%b' "$MERGE_BASE..HEAD" >"$OUT/commits.txt"
CHANGED_LINES=$(git diff --numstat "$FROM" HEAD | awk '{n += $1 + $2} END {print n + 0}')

# --- Repo conventions ---------------------------------------------------------
for f in CLAUDE.md AGENTS.md CONTRIBUTING.md .github/pull_request_template.md .github/PULL_REQUEST_TEMPLATE.md \
         .preflight/config.yml .preflight/suppressions.yml; do
  [[ -f "$f" ]] && echo "$f" >>"$OUT/conventions.txt"
done

# --- CI, linked issue, prior state (PR only) -----------------------------------
PRIOR_COMMENT=""
if [[ -n "$NUMBER" ]]; then
  gh pr checks "$NUMBER" --json name,state,bucket,link >"$OUT/checks.json" 2>/dev/null || rm -f "$OUT/checks.json"

  ISSUE=$(gh pr view "$NUMBER" --json body --jq .body 2>/dev/null |
    grep -oiE '(clos|fix|resolv)(e|es|ed)?:? +#[0-9]+' | head -1 | grep -oE '[0-9]+$' || true)
  if [[ -n "$ISSUE" && -z "$ISSUE_FILE" ]]; then
    gh issue view "$ISSUE" --json number,title,body,url >"$OUT/issue.json" 2>/dev/null || rm -f "$OUT/issue.json"
  fi

  PRIOR_COMMENT=$(gh api "repos/{owner}/{repo}/issues/$NUMBER/comments" --paginate \
    --jq ".[] | select(.body | contains(\"$MARKER\") or contains(\"$LEGACY_MARKER\")) | .id" 2>/dev/null | tail -1 || true)
  if [[ -n "$PRIOR_COMMENT" ]]; then
    gh api "repos/{owner}/{repo}/issues/comments/$PRIOR_COMMENT" \
      --jq '.body | gsub("\r\n"; "\n") | ((split("<!-- preflight:state v1\n")[1]) // (split("<!-- pr-self-review:state v1\n")[1]) // "") | (split("\n-->")[0] // empty)' \
      >"$OUT/prior-state.json" 2>/dev/null || true
    grep -q '{' "$OUT/prior-state.json" 2>/dev/null || rm -f "$OUT/prior-state.json"
  fi
fi

[[ -z "$ISSUE_FILE" ]] || text_to_json "$ISSUE_FILE" '{"source":"--issue"}' >"$OUT/issue.json"

# --- Summary ------------------------------------------------------------------
DIRTY=no; [[ -n "$(git status --porcelain)" ]] && DIRTY=yes
if [[ -z "$NUMBER" ]]; then CI=none
elif [[ "$PUSHED_SHA" != "$HEAD_SHA" ]]; then CI=stale
elif [[ -s "$OUT/checks.json" && "$(tr -d '[:space:]' <"$OUT/checks.json")" != "[]" ]]; then CI=current
else CI=none; fi

{
  echo "repoRoot: $ROOT"
  echo "workDir: $OUT"
  echo "branch: $BRANCH"
  echo "pr: ${NUMBER:-none}"
  echo "prState: ${PR_STATE:-none}"
  echo "base: $BASE"
  echo "baseSha: $MERGE_BASE"
  echo "headSha: $HEAD_SHA"
  echo "pushedSha: ${PUSHED_SHA:-none}"
  echo "diffFrom: $FROM"
  echo "ci: $CI"
  echo "dirty: $DIRTY"
  echo "changedLines: $CHANGED_LINES"
  echo "prodFiles: $(grep -c '' "$OUT/files-prod.txt" || true)"
  echo "testFiles: $(grep -c '' "$OUT/files-test.txt" || true)"
  echo "priorComment: ${PRIOR_COMMENT:-none}"
  echo "priorState: $([[ -f "$OUT/prior-state.json" ]] && echo yes || echo no)"
} >"$OUT/meta.txt"
cat "$OUT/meta.txt"
