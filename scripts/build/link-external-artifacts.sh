#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
build_root="${WINE_BUILD_DIR:-${HOME}/.wine-search-engine/build}"

mkdir -p "${build_root}/root" "${build_root}/web"

link_support_path() {
  local target_path="$1"
  local source_path="$2"

  mkdir -p "$(dirname "${target_path}")"
  if [ -L "${target_path}" ]; then
    return 0
  fi
  rm -rf "${target_path}"
  ln -s "${source_path}" "${target_path}"
}

link_artifact() {
  local repo_rel="$1"
  local target_rel="$2"
  local artifact_kind="${3:-file}"
  local repo_path="${repo_root}/${repo_rel}"
  local target_path="${build_root}/${target_rel}"

  mkdir -p "$(dirname "${target_path}")"
  if [ "${artifact_kind}" = "dir" ]; then
    mkdir -p "${target_path}"
  fi

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
  fi

  ln -s "${target_path}" "${repo_path}"
}

link_artifact "dist" "root/dist" "dir"
link_artifact ".tsbuildinfo" "root/.tsbuildinfo"
link_artifact ".tsbuildinfo.build" "root/.tsbuildinfo.build"
link_artifact "coverage" "root/coverage" "dir"
link_artifact "test-results" "root/test-results" "dir"
link_artifact "playwright-report" "root/playwright-report" "dir"
link_artifact "web/.next" "web/.next" "dir"
link_artifact "web/next-env.d.ts" "web/next-env.d.ts"
link_support_path "${build_root}/root/node_modules" "${repo_root}/node_modules"
link_support_path "${build_root}/web/node_modules" "${repo_root}/web/node_modules"

echo
echo "Repo build artifacts now link to: ${build_root}"
