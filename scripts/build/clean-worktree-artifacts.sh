#!/usr/bin/env bash
# Remove generated / bulky paths from the repo tree (ignored by git).
# Safe when dist/coverage are symlinks: only the link in the repo is removed.
# pnpm content-addressed store is outside the repo — see .npmrc store-dir.
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "${repo_root}"

paths=(
  .cache
  .claude/worktrees
  dist
  coverage
  test-results
  playwright-report
  .tsbuildinfo
  .tsbuildinfo.build
  out
  web/out
  web/.next
  .eslintcache
  .turbo
  node_modules
  web/node_modules
)

for p in "${paths[@]}"; do
  if [ -e "${p}" ] || [ -L "${p}" ]; then
    rm -rf "${p}"
    echo "removed ${p}"
  fi
done

shopt -s nullglob
archive_paths=(
  *.tar
  *.tar.gz
  *.tar.bz2
  *.tar.xz
  *.tgz
  *.zip
  *.7z
  *.rar
  .DS_Store
  docs/.DS_Store
)
shopt -u nullglob

for p in "${archive_paths[@]}"; do
  if [ -e "${p}" ] || [ -L "${p}" ]; then
    rm -rf "${p}"
    echo "removed ${p}"
  fi
done

echo
echo "Next: pnpm install --frozen-lockfile"
echo "Optional (root deps + build outputs outside the tree):"
echo "  bash scripts/deps/link-external-node-modules.sh"
echo "  bash scripts/build/link-external-artifacts.sh"
