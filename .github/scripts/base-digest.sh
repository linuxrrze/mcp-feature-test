#!/usr/bin/env bash
# Copied unchanged from docker-images/.gitea/scripts/base-digest.sh (git.linux-ng.de/marcel/docker-images);
# keep in sync with it.
#
# Print the current registry digest of a Dockerfile's base image, so a
# workflow can rebuild when the base is re-published under the same tag
# (e.g. ubuntu:26.04 picking up security fixes) -- not only when the tracked
# package/app version moves.
#
# Usage (in a workflow's change-detection step):
#   DIGEST=$(bash .gitea/scripts/base-digest.sh <path/to/Dockerfile>)
#   DIGEST=$(bash .gitea/scripts/base-digest.sh --ref <image:tag>)
#
# --ref is for a base whose FROM line takes its tag from a build ARG
# (`FROM nextcloud:${NEXTCLOUD_BASE_TAG}`): the workflow knows the resolved
# tag, so it passes the full reference instead of the Dockerfile.
#
# The base is the last FROM that is neither `scratch` nor an earlier build
# stage (so `FROM ubuntu:26.04 AS builder` + `FROM scratch` resolves to
# ubuntu:26.04). Only a HEAD request on the manifest is made: no image pull,
# and Docker Hub doesn't count HEAD requests against its pull rate limit.
# Anonymous access; a registry answering 401 gets the standard bearer-token
# dance (the token endpoint comes from its WWW-Authenticate header).
set -euo pipefail

usage() { echo "usage: $0 <Dockerfile> | --ref <image:tag>" >&2; exit 2; }
if [ "${1:-}" = --ref ]; then
  [ $# -eq 2 ] && [ -n "$2" ] || usage
  BASE=$2
else
  [ $# -eq 1 ] || usage
  DOCKERFILE=$1

# Resolve the base image reference.
BASE=$(awk '
  toupper($1) == "FROM" {
    ref = ""
    for (i = 2; i <= NF; i++) { if ($i !~ /^--/) { ref = $i; break } }
    for (j = i + 1; j <= NF; j++) { if (toupper($j) == "AS" && j < NF) stage[tolower($(j + 1))] = 1 }
    if (ref != "" && tolower(ref) != "scratch" && !(tolower(ref) in stage)) base = ref
  }
  END { print base }
' "$DOCKERFILE")
[ -n "$BASE" ] || { echo "base-digest: no base image found in $DOCKERFILE" >&2; exit 1; }
fi
case "$BASE" in
  *'$'*) echo "base-digest: base '$BASE' uses a build ARG -- pass the resolved reference via --ref instead" >&2; exit 1 ;;
esac

# Split into registry / repository / tag (Docker Hub defaults).
REF=${BASE%@*}
NAME=$REF TAG=latest
if [[ "${REF##*/}" == *:* ]]; then NAME=${REF%:*}; TAG=${REF##*:}; fi
FIRST=${NAME%%/*}
if [[ "$NAME" == */* ]] && { [[ "$FIRST" == *.* ]] || [[ "$FIRST" == *:* ]] || [ "$FIRST" = localhost ]; }; then
  REGISTRY=$FIRST; REPO=${NAME#*/}
else
  REGISTRY=registry-1.docker.io; REPO=$NAME
  [[ "$REPO" == */* ]] || REPO="library/$REPO"
fi

URL="https://$REGISTRY/v2/$REPO/manifests/$TAG"
ACCEPT='application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'

header() { tr -d '\r' | awk -v h="$1" 'tolower($1) == tolower(h) ":" { $1 = ""; sub(/^ /, ""); v = $0 } END { print v }'; }

HDRS=$(curl -sSI -H "Accept: $ACCEPT" "$URL")
# (awk reads all of its input: no early-closing pipe under pipefail)
STATUS=$(printf '%s\n' "$HDRS" | awk 'NR == 1 { print $2 }')
if [ "$STATUS" = 401 ]; then
  CHALLENGE=$(printf '%s\n' "$HDRS" | header www-authenticate)
  REALM=$(printf '%s' "$CHALLENGE" | sed -n 's/.*realm="\([^"]*\)".*/\1/p')
  SERVICE=$(printf '%s' "$CHALLENGE" | sed -n 's/.*service="\([^"]*\)".*/\1/p')
  [ -n "$REALM" ] || { echo "base-digest: $URL needs auth, but no bearer realm offered" >&2; exit 1; }
  TOKEN=$(curl -sSf "$REALM?service=$SERVICE&scope=repository:$REPO:pull" \
    | sed -n 's/.*"\(access_\)\{0,1\}token" *: *"\([^"]*\)".*/\2/p')
  [ -n "$TOKEN" ] || { echo "base-digest: could not get a pull token from $REALM" >&2; exit 1; }
  HDRS=$(curl -sSI -H "Accept: $ACCEPT" -H "Authorization: Bearer $TOKEN" "$URL")
fi

DIGEST=$(printf '%s\n' "$HDRS" | header docker-content-digest)
[[ "$DIGEST" == sha256:* ]] || { echo "base-digest: no Docker-Content-Digest for $BASE ($URL)" >&2; exit 1; }
echo "$DIGEST"
