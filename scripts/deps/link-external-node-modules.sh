#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
deps_root="${WINE_DEPS_DIR:-${HOME}/.wine-search-engine/deps}"

mkdir -p "${deps_root}/root" "${deps_root}/web"

link_dependency_dir() {
  local repo_rel="$1"
  local target_rel="$2"
  local repo_path="${repo_root}/${repo_rel}"
  local target_path="${deps_root}/${target_rel}"

  mkdir -p "$(dirname "${target_path}")"

  if [ -L "${repo_path}" ]; then
    return 0
  fi

  if [ -e "${repo_path}" ]; then
    if [ -e "${target_path}" ] || [ -L "${target_path}" ]; then
      rm -rf "${repo_path}"
      echo "relinked ${repo_rel} -> ${target_path}"
    else
      mv "${repo_path}" "${target_path}"
      echo "moved ${repo_rel} -> ${target_path}"
    fi
  else
    mkdir -p "${target_path}"
  fi

  ln -s "${target_path}" "${repo_path}"
}

link_dependency_dir "node_modules" "root/node_modules"

echo
echo "Repo root dependencies now link to: ${deps_root}/root/node_modules"
echo "web/node_modules stays repo-local because Next/Turbopack rejects symlinks that point outside the project root."
