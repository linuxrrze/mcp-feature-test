#!/usr/bin/env bash
#
# Work out the version a CI run builds, from the git tags (vX.Y.Z) and
# package.json. Prints shell assignments for $GITHUB_OUTPUT:
#   version=X.Y.Z   the version to build
#   release=true    when this run should create the tag v<version> and a
#                   GitHub release (pushes and manual runs on main only)
#
# Usage: bash .github/scripts/next-version.sh <event> <ref>
#   <event>  push | workflow_dispatch | schedule | pull_request | ...
#   <ref>    e.g. refs/heads/main
# Needs the full history and tags (actions/checkout with fetch-depth: 0).
#
# Rules:
#   - HEAD already tagged vX.Y.Z (a re-run): build that version, no release.
#   - schedule (base-image rebuild): re-publish the latest released version,
#     no bump (package.json's version if nothing was released yet).
#   - otherwise bump the latest tag: patch by default; "[minor]" or "[major]"
#     in any commit message since that tag bumps minor or major instead.
#     If package.json has a higher version, that wins (a manual bump).
#     Without any tag yet, package.json's version is the first release.
set -euo pipefail

EVENT=${1:?usage: $0 <event> <ref>}
REF=${2:?usage: $0 <event> <ref>}

semver_re='^[0-9]+\.[0-9]+\.[0-9]+$'
PKG=$(node -p 'require("./package.json").version')
[[ "$PKG" =~ $semver_re ]] || { echo "next-version: package.json version '$PKG' is not X.Y.Z" >&2; exit 1; }

# Highest vX.Y.Z tag (sort -V; tail reads everything, no SIGPIPE under pipefail).
LAST=$(git tag --list 'v[0-9]*' | sed -n 's/^v\([0-9]*\.[0-9]*\.[0-9]*\)$/\1/p' | sort -V | tail -1)
HEAD_TAG=$(git tag --points-at HEAD --list 'v[0-9]*' | sed -n 's/^v\([0-9]*\.[0-9]*\.[0-9]*\)$/\1/p' | sort -V | tail -1)

release=false
if [ -n "$HEAD_TAG" ]; then
  version=$HEAD_TAG
elif [ "$EVENT" = schedule ]; then
  version=${LAST:-$PKG}
else
  if [ -z "$LAST" ]; then
    version=$PKG
  else
    IFS=. read -r MA MI PA <<<"$LAST"
    MSGS=$(git log --format=%B "v$LAST..HEAD")
    case "$MSGS" in
      *'[major]'*) version="$((MA + 1)).0.0" ;;
      *'[minor]'*) version="$MA.$((MI + 1)).0" ;;
      *) version="$MA.$MI.$((PA + 1))" ;;
    esac
    # A manual bump in package.json beyond the computed version wins.
    if [ "$(printf '%s\n%s\n' "$version" "$PKG" | sort -V | tail -1)" = "$PKG" ] && [ "$PKG" != "$version" ]; then
      version=$PKG
    fi
  fi
  if { [ "$EVENT" = push ] || [ "$EVENT" = workflow_dispatch ]; } && [ "$REF" = refs/heads/main ]; then
    release=true
  fi
fi

echo "version=$version"
echo "release=$release"
