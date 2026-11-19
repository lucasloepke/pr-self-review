#!/usr/bin/env bash
# Posts the self-review report on a PR, or edits the existing one in place.
# There is one self-review comment per PR, found by its marker line.
#
#   bash post-report.sh <pr-number> <report-file>
#
# Prints the comment URL. Refuses a report that lacks the marker or the state
# block, and refuses a PR that is no longer open. What is posted is a copy
# passed through redact.js (secrets and personal data masked); the masking
# summary goes to stderr, and the state block must still parse afterwards.
set -euo pipefail
SCRIPTS=$(cd "$(dirname "$0")" && pwd)

die() { echo "post-report: $*" >&2; exit 1; }

[[ $# -eq 2 ]] || die "usage: post-report.sh <pr-number> <report-file>"
PR=$1 FILE=$2
MARKER='<!-- pr-self-review -->'

[[ "$PR" =~ ^[0-9]+$ ]] || die "PR must be a number, got '$PR'"
[[ -s "$FILE" ]] || die "report file '$FILE' is missing or empty"
[[ "$(head -n 1 "$FILE")" == "$MARKER" ]] || die "the report's first line must be exactly: $MARKER"
grep -qxF '<!-- pr-self-review:state v1' "$FILE" || die "the report has no state block (a line reading '<!-- pr-self-review:state v1')"
[[ "$(tail -n 1 "$FILE")" == "-->" ]] || die "the state block must close the report: last line must be '-->'"
CHARS=$(wc -m <"$FILE" | tr -d ' ')
((CHARS <= 65536)) || die "the report is $CHARS characters; GitHub's limit is 65536 — collapse or trim sections"

POST=$(mktemp "${TMPDIR:-/tmp}/self-review-report.XXXXXX")
trap 'rm -f "$POST"' EXIT
SUMMARY=$(node "$SCRIPTS/redact.js" mask "$FILE" "$POST") || die "redaction failed"
echo "post-report: redaction $SUMMARY" >&2
node -e '
  const t = require("fs").readFileSync(process.argv[1], "utf8").replace(/\r\n/g, "\n")
  JSON.parse(t.split("<!-- pr-self-review:state v1\n")[1].split("\n-->")[0])
' "$POST" 2>/dev/null || die "the state block is not valid JSON (after redaction) — not posting"

STATE=$(gh pr view "$PR" --json state --jq .state) || die "could not read PR #$PR"
[[ "$STATE" == "OPEN" ]] || die "PR #$PR is $STATE — not posting"

ID=$(gh api "repos/{owner}/{repo}/issues/$PR/comments" --paginate \
  --jq ".[] | select(.body | contains(\"$MARKER\")) | .id" | tail -1)

if [[ -n "$ID" ]]; then
  gh api -X PATCH "repos/{owner}/{repo}/issues/comments/$ID" -F "body=@$POST" --jq .html_url
else
  gh pr comment "$PR" --body-file "$POST"
fi
