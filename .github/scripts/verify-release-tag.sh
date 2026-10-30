#!/usr/bin/env bash
# Verifies that a release tag is a GitHub-verified signed annotated tag on main
# whose name matches the version in package.json. Usage: verify-release-tag.sh <tag>
# Reads GITHUB_REPOSITORY and GH_TOKEN from the environment.
set -euo pipefail

TAG="${1:?usage: verify-release-tag.sh <tag>}"
REPO="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

fail() {
  echo "::error::$1"
  exit 1
}

ref_json=$(gh api "repos/$REPO/git/ref/tags/$TAG" 2>/dev/null) ||
  fail "Tag $TAG does not exist in $REPO."
type=$(jq -r .object.type <<<"$ref_json")
object_sha=$(jq -r .object.sha <<<"$ref_json")
[ "$type" = "tag" ] ||
  fail "Tag $TAG is not an annotated tag (ref points at a $type). Create it with git tag -s."

tag_json=$(gh api "repos/$REPO/git/tags/$object_sha")
verified=$(jq -r .verification.verified <<<"$tag_json")
reason=$(jq -r .verification.reason <<<"$tag_json")
target_type=$(jq -r .object.type <<<"$tag_json")
commit=$(jq -r .object.sha <<<"$tag_json")
[ "$verified" = "true" ] ||
  fail "Tag $TAG signature is not verified by GitHub (reason: $reason)."
[ "$target_type" = "commit" ] ||
  fail "Tag $TAG points at a $target_type, not a commit."

expected="${GITHUB_SHA:-$commit}"
[ "$commit" = "$expected" ] ||
  fail "Signed tag $TAG points at $commit, but the pushed commit is $expected."
git cat-file -e "$commit^{commit}" 2>/dev/null ||
  fail "Commit $commit for $TAG does not exist in the local clone."

git merge-base --is-ancestor "$commit" origin/main ||
  fail "Tagged commit $commit for $TAG is not an ancestor of origin/main."

version=$(git show "$commit:package.json" | jq -r .version)
[ "$TAG" = "v$version" ] ||
  fail "Tag $TAG does not match package.json version v$version at $commit."

echo "Tag $TAG is a verified signed annotated tag at $commit on main."
