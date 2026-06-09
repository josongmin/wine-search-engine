#!/usr/bin/env bash
# Sync the latest lookup-v2 pipeline artifacts into public/data so the CSR app
# can load them (no backend). Re-run whenever coverage/write-plane/registries change.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/public/data"
mkdir -p "$OUT"

# Coverage + write-plane artifacts live under /tmp by default (override via env).
COVERAGE="${ELV2_COVERAGE_JSON:-/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json}"
WRITEPLANE="${ELV2_WRITEPLANE_JSON:-/tmp/lookup-v2-drafts/lookup-v2-korean-realworld-stretch-write-plane-summary.json}"
OWNER="${ELV2_OWNER_EVIDENCE:-/tmp/lookup-v2-drafts/manual-target-owner-evidence/missing-runtime-owner-families.jsonl}"

copy() { # src dest
  if [ -f "$1" ]; then cp "$1" "$2" && echo "  ✓ $(basename "$2")  ($(wc -l <"$1" | tr -d ' ') lines)"; else echo "  ✗ MISSING: $1"; fi
}

echo "repo: $REPO"
echo "→ $OUT"
copy "$COVERAGE" "$OUT/coverage.json"
copy "$WRITEPLANE" "$OUT/write-plane-summary.json"
copy "$OWNER" "$OUT/owner-evidence.jsonl"
copy "$REPO/data/gold-wine-catalog.jsonl" "$OUT/gold-catalog.jsonl"
copy "$REPO/data/lookup-v2/korean-exact-safe-registry-v1.jsonl" "$OUT/exact-safe-registry.jsonl"
copy "$REPO/data/lookup-v2/lookup-semantic-scope-target-registry-v1.jsonl" "$OUT/scope-target.jsonl"
copy "$REPO/data/lookup-v2/lookup-semantic-policy-registry-v1.jsonl" "$OUT/policy.jsonl"
copy "$REPO/data/lookup-v2/lookup-family-collision-registry-v1.jsonl" "$OUT/collision.jsonl"
copy "$REPO/data/lookup-v2/lookup-semantic-scope-support-registry-v1.jsonl" "$OUT/scope-support.jsonl"
copy "$REPO/data/lookup-v2/lookup-localized-scope-surface-registry-v1.jsonl" "$OUT/localized-surface.jsonl"
copy "$REPO/data/lookup-v2/lookup-family-core-witness-registry-v1.jsonl" "$OUT/family-core-witness.jsonl"
echo "done."
