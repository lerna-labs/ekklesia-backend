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

# The ref points at an annotated tag object, not a lightweight tag.
ref_json=$(gh api "repos/$REPO/git/ref/tags/$TAG" 2>/dev/null) ||
  fail "Tag $TAG does not exist in $REPO."
type=$(jq -r .object.type <<<"$ref_json")
object_sha=$(jq -r .object.sha <<<"$ref_json")
[ "$type" = "tag" ] ||
  fail "Tag $TAG is not an annotated tag (ref points at a $type). Create it with git tag -s."

# GitHub reports the tag object's signature as verified.
verified=$(gh api "repos/$REPO/git/tags/$object_sha" --jq .verification.verified)
if [ "$verified" != "true" ]; then
  reason=$(gh api "repos/$REPO/git/tags/$object_sha" --jq .verification.reason)
  fail "Tag $TAG signature is not verified by GitHub (reason: $reason)."
fi

# The tagged commit is an ancestor of origin/main.
commit=$(git rev-parse "refs/tags/$TAG^{commit}")
git merge-base --is-ancestor "$commit" origin/main ||
  fail "Tagged commit $commit for $TAG is not an ancestor of origin/main."

# The tag equals the version in the tagged commit's package.json.
version=$(git show "$commit:package.json" | jq -r .version)
[ "$TAG" = "v$version" ] ||
  fail "Tag $TAG does not match package.json version v$version at $commit."

echo "Tag $TAG is a verified signed annotated tag at $commit on main."
