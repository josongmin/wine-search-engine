#!/usr/bin/env python3
"""Atomic split: browse seed extractors from search-usecase-hybrid-candidates.ts."""

from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MAIN = REPO / "src/application/search/search-usecase-hybrid-candidates.ts"
NEW = REPO / "src/application/search/search-usecase-hybrid-browse-seeds.ts"

BROWSE_SEEDS_MODULE = '''import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';

function isReadonlyStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function extractProducerBrowseSeed(plan: QueryPlanV1): string | undefined {
  // Tiebreak by surfaceForm for deterministic anchor selection when confidence is equal.
  // Without a tiebreaker, equal-confidence anchors produce different producer_browse seeds
  // across identical queries (JS sort is not stable across all V8 versions for equal keys).
  const strongestAnchor = [...plan.anchors].sort((left, right) => {
    const diff = right.confidence - left.confidence;
    // Locale-independent byte comparison for deterministic cross-system ordering.
    // localeCompare() produces different results across Node versions / OS locales.
    return diff !== 0 ? diff : left.surfaceForm < right.surfaceForm ? -1 : left.surfaceForm > right.surfaceForm ? 1 : 0;
  })[0];
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- intentional: empty string from trim() should fall through to normalizedForm
  const candidate = strongestAnchor?.surfaceForm.trim() || strongestAnchor?.normalizedForm.trim();
  return candidate !== undefined && candidate.length > 0 ? candidate : undefined;
}

export function extractRegionBrowseSeed(plan: QueryPlanV1): string | undefined {
  // Primary: explicit region/appellation/country constraint — most reliable signal.
  const regionConstraint = [...plan.constraints.hard, ...plan.constraints.soft, ...plan.constraints.inferred].find(
    (constraint) =>
      constraint.attribute === 'region' ||
      constraint.attribute === 'appellation' ||
      constraint.attribute === 'country',
  );

  if (regionConstraint !== undefined) {
    if (typeof regionConstraint.value === 'string' && regionConstraint.value.trim().length > 0) {
      return regionConstraint.value.trim();
    }
    if (isReadonlyStringArray(regionConstraint.value) && regionConstraint.value.length > 0) {
      return regionConstraint.value[0];
    }
  }

  // Secondary: hierarchical slash-notation queries (e.g. "Burgundy / Pinot Noir").
  // Only treat as a region seed when the query is clearly structured this way.
  const hierarchy = plan.normalizedQuery
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (hierarchy.length >= 2) {
    return hierarchy.join(' / ');
  }

  // No reliable region signal — return undefined rather than guessing from
  // the full query text. A false seed produces a wrong region_browse execution.
  return undefined;
}
'''

REEXPORT_BLOCK = '''
export {
  extractProducerBrowseSeed,
  extractRegionBrowseSeed,
} from './search-usecase-hybrid-browse-seeds.js';
'''

IMPORT_LINE = "import {\n  extractProducerBrowseSeed,\n  extractRegionBrowseSeed,\n} from './search-usecase-hybrid-browse-seeds.js';\n"


def main() -> None:
    main_text = MAIN.read_text(encoding="utf-8")

    # Write new module
    NEW.write_text(BROWSE_SEEDS_MODULE, encoding="utf-8")

    # Remove browse seed block through extractRegionBrowseSeed (includes isReadonlyStringArray).
    start_marker = "export function extractProducerBrowseSeed(plan: QueryPlanV1)"
    end_marker = "\nexport interface HybridCandidateRetrievalPorts"
    start_idx = main_text.index(start_marker)
    end_idx = main_text.index(end_marker, start_idx)
    block_before = main_text[:start_idx]
    block_after = main_text[end_idx + 1 :]  # keep leading newline on interface

    # Insert import after SEARCH_TOOL_DIVERSITY import block
    import_anchor = "import { SEARCH_TOOL_DIVERSITY_WINE_TYPES } from './search-tool-diversity.js';\n"
    if import_anchor not in block_before:
        raise RuntimeError("import anchor not found")
    block_before = block_before.replace(
        import_anchor,
        import_anchor + IMPORT_LINE,
    )

    # Insert re-export before projectRewritesForDecisionInput or after interfaces - put after SPECIALIZED_HYBRID constant area
    # Better: after HybridCandidateRetrievalResult interface closing - actually put re-exports at end of type exports section
    # Simplest: add re-export right after IMPORT_LINE area as separate exports at bottom of exports... 
    # Standard pattern from scorer: re-export after imports in a dedicated section before first interface
    reexport_anchor = "export interface CriticRetrievalObservability {"
    if reexport_anchor not in block_before:
        raise RuntimeError("reexport anchor not found")
    block_before = block_before.replace(
        reexport_anchor,
        REEXPORT_BLOCK.strip() + "\n\n" + reexport_anchor,
    )

    MAIN.write_text(block_before + block_after, encoding="utf-8")
    print(f"Wrote {NEW.relative_to(REPO)}")
    print(f"Updated {MAIN.relative_to(REPO)}")


if __name__ == "__main__":
    main()
