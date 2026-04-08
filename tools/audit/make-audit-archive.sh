#!/usr/bin/env bash
# Build a tarball for external (security / code) auditors.
# Requires: rsync, tar, and either shasum (macOS) or sha256sum (Linux).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
FILTER_BASE="$SCRIPT_DIR/rsync-audit.filter"

WITH_GIT=0
BACKEND_ONLY=0
DRY_RUN=0
OUT_PATH=""

usage() {
  sed -n '1,80p' <<'EOF'
Usage: make-audit-archive.sh [options]

Creates a gzip-compressed tar of the repository under a single top-level
directory "wine-search-engine-audit/", using rsync filters aligned with
root .gitignore and external-audit practice (no node_modules, no secrets, etc.).

Options:
  -o, --output PATH   Output .tar.gz path (default: parent of repo,
                      wine-search-engine-audit-YYYYMMDD-HHMMSS.tgz UTC)
  --with-git          Include .git (history). Default: exclude .git
  --backend-only      Exclude web/ entirely
  --dry-run           rsync -n -v only; no tar written
  -h, --help          This help

Example:
  ./tools/audit/make-audit-archive.sh
  ./tools/audit/make-audit-archive.sh -o ~/Desktop/wine-audit.tgz
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --with-git)
      WITH_GIT=1
      shift
      ;;
    --backend-only)
      BACKEND_ONLY=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -o | --output)
      if [[ $# -lt 2 ]]; then
        echo "error: $1 requires a path" >&2
        exit 1
      fi
      OUT_PATH=$2
      shift 2
      ;;
    *)
      echo "error: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$FILTER_BASE" ]]; then
  echo "error: missing filter file: $FILTER_BASE" >&2
  exit 1
fi

if [[ -z "$OUT_PATH" ]]; then
  PARENT="$(dirname "$REPO_ROOT")"
  OUT_PATH="$PARENT/wine-search-engine-audit-$(date -u +%Y%m%d-%H%M%S).tgz"
fi

FILTER_MERGE=$(mktemp)
cleanup() {
  rm -rf "$STAGING" "$FILTER_MERGE"
}
STAGING=""
trap cleanup EXIT

cp "$FILTER_BASE" "$FILTER_MERGE"
if [[ "$BACKEND_ONLY" -eq 1 ]]; then
  echo "- web/" >>"$FILTER_MERGE"
fi
if [[ "$WITH_GIT" -eq 0 ]]; then
  echo "- .git/" >>"$FILTER_MERGE"
fi

STAGING=$(mktemp -d)
TARGET="$STAGING/wine-search-engine-audit"
mkdir -p "$TARGET"

RSYNC_FLAGS=(-a)
if [[ "$DRY_RUN" -eq 1 ]]; then
  RSYNC_FLAGS+=(-n -v)
fi

rsync "${RSYNC_FLAGS[@]}" --filter="merge $FILTER_MERGE" "$REPO_ROOT/" "$TARGET/"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "dry-run: no archive written" >&2
  exit 0
fi

mkdir -p "$(dirname "$OUT_PATH")"
tar -czf "$OUT_PATH" -C "$STAGING" wine-search-engine-audit

echo "Wrote: $OUT_PATH"
if command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$OUT_PATH"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$OUT_PATH"
else
  echo "warning: install shasum or sha256sum to print SHA-256" >&2
fi
