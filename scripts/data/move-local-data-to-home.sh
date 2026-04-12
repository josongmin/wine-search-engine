#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
source_dir="${repo_root}/data"
target_dir="${WINE_DATA_DIR:-${HOME}/.wine-search-engine/data}"

mkdir -p "${target_dir}"

move_if_present() {
  local name="$1"
  local from="${source_dir}/${name}"
  local to="${target_dir}/${name}"

  if [ ! -e "${from}" ]; then
    return 0
  fi

  mkdir -p "$(dirname "${to}")"

  if [ -e "${to}" ]; then
    echo "skip ${name} (already exists at ${to})"
    return 0
  fi

  mv "${from}" "${to}"
  echo "moved ${name} -> ${to}"
}

move_dir_if_present() {
  local name="$1"
  local from="${source_dir}/${name}"
  local to="${target_dir}/${name}"

  if [ ! -d "${from}" ]; then
    return 0
  fi

  mkdir -p "$(dirname "${to}")"

  if [ -e "${to}" ]; then
    echo "skip ${name}/ (already exists at ${to})"
    return 0
  fi

  mv "${from}" "${to}"
  echo "moved ${name}/ -> ${to}/"
}

# Top-level names only (matches move_if_present).
move_glob_in_data_root() {
  local pattern="$1"
  shopt -s nullglob
  local paths=( "${source_dir}/${pattern}" )
  shopt -u nullglob
  local p
  for p in "${paths[@]}"; do
    move_if_present "$(basename "${p}")"
  done
}

move_if_present "silver.ndjson"
move_if_present "silver-enriched.ndjson"
move_if_present "silver-enriched-ko.ndjson"
move_if_present "silver-docquery.ndjson"
move_if_present "silver-phase1.ndjson"
move_if_present "silver-phase1b.ndjson"
move_if_present "silver-final.ndjson"
move_if_present "hard-negatives.jsonl"
# Golden query corpora are no longer benchmark SSOT here; keep any local
# snapshots in place instead of auto-promoting them into the shared data dir.
move_if_present "eval-results.json"
move_if_present "eval-with-reranker-bronze.json"
move_if_present "noisy-entity-eval-smoke-results.json"
move_if_present "silver-quality-report.json"

# Pipeline intermediates / machine-local outputs (not committed; see .gitignore data/*).
move_if_present "silver-ko.ndjson"
move_if_present "silver-aliases.ndjson"
move_if_present "golden-queries-bronze.snapshot.jsonl"
move_if_present "golden-queries-silver-tagged.jsonl"
move_if_present "runtime-search-snapshot.json"
move_if_present "triplets-train.jsonl"
move_if_present "noisy-entity-eval-results.json"
move_if_present "ambiguity-registry.ndjson"
move_if_present "eval-results-smoke.json"
move_if_present "agentic-answer-quality-fixture-eval-results.json"
move_if_present "agentic-tool-use-fixture-eval-results.json"
move_if_present "search-feature-behavior-fixture-eval-results.json"
move_if_present "entity-retrieval-fixture-eval-results.json"
move_if_present "performance-latency-fixture-eval-results.json"
move_if_present "performance-load-fixture-eval-results.json"

move_dir_if_present "search-snapshots"

move_glob_in_data_root "offline-eval-*.json"

# Exploratory retrieval-ceiling JSON (writes via resolveDataPath; may exist in repo from older runs).
move_if_present "retrieval-ceiling/exploratory-dry-run-baseline.json"

echo
echo "Repo-local data dir: ${source_dir}"
echo "Active shared data dir: ${target_dir}"
echo "Scripts that use resolveDataPath('data/...') will now prefer ${target_dir}."
