#!/usr/bin/env bash
# Publishes report images to the repo's self-review-assets branch, under
# pr-<n>/<head sha>/, and prints commit-pinned URLs. Uses git plumbing with a
# temporary index: the working tree, index and current branch are untouched.
#
#   bash publish-assets.sh <pr-number> <head-sha> <image>...
#
# Prints one JSON object: {"commit", "files": [{"file", "path", "url", "raw"}]}
#   url  https://github.com/<owner>/<repo>/blob/<commit>/<path>?raw=true — loads with
#        the viewer's own session, so it also works on private repositories
#   raw  https://raw.githubusercontent.com/<owner>/<repo>/<commit>/<path>
# Env: SELF_REVIEW_REMOTE (default origin), SELF_REVIEW_REPO (owner/name; default from gh).
set -euo pipefail

die() { echo "publish-assets: $*" >&2; exit 1; }
[[ $# -ge 3 ]] || die "usage: publish-assets.sh <pr-number> <head-sha> <image>..."
PR=$1 SHA=$2; shift 2
[[ "$PR" =~ ^[0-9]+$ ]] || die "PR must be a number, got '$PR'"
[[ "$SHA" =~ ^[0-9a-f]{7,40}$ ]] || die "head sha must be hex, got '$SHA'"
for f in "$@"; do
  [[ -s "$f" ]] || die "'$f' is missing or empty"
  [[ "$f" =~ \.(png|jpe?g|gif|webp)$ ]] || die "'$f' is not an image (png, jpg, gif, webp)"
done

REMOTE=${SELF_REVIEW_REMOTE:-origin}
BRANCH=self-review-assets
SLUG=${SELF_REVIEW_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)} || die "cannot tell the repository (gh repo view failed)"
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"

git fetch -q "$REMOTE" "+refs/heads/$BRANCH:refs/remotes/$REMOTE/$BRANCH" 2>/dev/null || true
PARENT=$(git rev-parse --verify -q "refs/remotes/$REMOTE/$BRANCH" || true)

INDEX=$(mktemp "${TMPDIR:-/tmp}/self-review-index.XXXXXX")
trap 'rm -f "$INDEX"' EXIT
export GIT_INDEX_FILE=$INDEX
if [[ -n "$PARENT" ]]; then git read-tree "$PARENT"; else git read-tree --empty; fi

DIR="pr-$PR/${SHA:0:12}"
PATHS=()
for f in "$@"; do
  name=$(basename "$f" | tr -c 'A-Za-z0-9._\n-' '-')
  blob=$(git hash-object -w "$f")
  git update-index --add --cacheinfo "100644,$blob,$DIR/$name"
  PATHS+=("$f" "$DIR/$name")
done

TREE=$(git write-tree)
COMMIT=$(git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "self-review assets: PR #$PR at ${SHA:0:12}")
git push -q "$REMOTE" "$COMMIT:refs/heads/$BRANCH" || die "push to $REMOTE/$BRANCH failed"
unset GIT_INDEX_FILE

node -e '
  const [slug, commit, ...pairs] = process.argv.slice(1)
  const files = []
  for (let i = 0; i < pairs.length; i += 2) files.push({
    file: pairs[i], path: pairs[i + 1],
    url: `https://github.com/${slug}/blob/${commit}/${pairs[i + 1]}?raw=true`,
    raw: `https://raw.githubusercontent.com/${slug}/${commit}/${pairs[i + 1]}`
  })
  process.stdout.write(JSON.stringify({ commit, files }, null, 2) + "\n")
' "$SLUG" "$COMMIT" "${PATHS[@]}"
