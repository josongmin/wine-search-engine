#!/usr/bin/env python3
"""Atomic split: hybrid retrieval input builders from search-usecase-hybrid-candidates.ts."""

from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
MAIN = REPO / "src/application/search/search-usecase-hybrid-candidates.ts"
NEW = REPO / "src/application/search/search-usecase-hybrid-retrieval-input.ts"

HEADER = '''import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { AmbiguousEntityHint } from '../../domain/attribute/model/ambiguous-entity-hint.js';
import type { HybridRetrievalInput } from '../../domain/retrieval/model/retrieval-input.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import { buildRetrievalPlan } from '../../domain/retrieval/service/retrieval-plan-builder.js';
import { buildRetrievalObjective } from '../../domain/retrieval/model/retrieval-objective.js';
import type { NormalizedConstraint } from '../../domain/shared/types/index.js';
import {
  expandSemanticStyleRetrievalTerms,
  resolveSemanticStyleEvidenceProfile,
} from '../../domain/query/service/semantic-style-query-terms.js';
import { recipientProfileToRetrievalTerms } from '../../domain/query/service/recipient-situation-profile.js';
import type { WineTypeValue } from '../../domain/query/model/wine-type-patterns.js';

'''

REEXPORT = '''
export { buildHybridRetrievalInputForPlan } from './search-usecase-hybrid-retrieval-input.js';
export {
  retrievalValueToPhrases,
  uniqueStrings,
  shouldRunTypedRecommendationDiscovery,
  shouldRunAmbiguousEntityBranchExploration,
} from './search-usecase-hybrid-retrieval-input.js';
'''

IMPORTS = '''import {
  buildHybridRetrievalInputForPlan,
  retrievalValueToPhrases,
  uniqueStrings,
  shouldRunTypedRecommendationDiscovery,
  shouldRunAmbiguousEntityBranchExploration,
} from './search-usecase-hybrid-retrieval-input.js';
'''


def slice_between(text: str, start: str, end: str) -> str:
    s = text.index(start)
    e = text.index(end, s)
    return text[s:e].rstrip() + "\n"


def remove_between(text: str, start: str, end: str) -> str:
    s = text.index(start)
    e = text.index(end, s)
    return text[:s] + text[e:]


def main() -> None:
    main_text = MAIN.read_text(encoding="utf-8")

    block_a = slice_between(
        main_text,
        "export function buildHybridRetrievalInputForPlan",
        "function hasHybridSubqueryTopology",
    )
    block_b = slice_between(
        main_text,
        "function uniqueStrings(values: readonly string[])",
        "function isSlotNode(node: unknown)",
    )

    body = block_a + "\n" + block_b
    # Export helpers used by the god file's graph scoping path.
    body = body.replace(
        "function retrievalValueToPhrases(",
        "export function retrievalValueToPhrases(",
        1,
    )
    body = body.replace("function uniqueStrings(", "export function uniqueStrings(", 1)
    body = body.replace(
        "function shouldRunTypedRecommendationDiscovery(",
        "export function shouldRunTypedRecommendationDiscovery(",
        1,
    )
    body = body.replace(
        "function shouldRunAmbiguousEntityBranchExploration(",
        "export function shouldRunAmbiguousEntityBranchExploration(",
        1,
    )

    NEW.write_text(HEADER + body, encoding="utf-8")

    updated = remove_between(
        main_text,
        "export function buildHybridRetrievalInputForPlan",
        "function hasHybridSubqueryTopology",
    )
    updated = remove_between(
        updated,
        "function uniqueStrings(values: readonly string[])",
        "function isSlotNode(node: unknown)",
    )

    import_anchor = "} from './search-usecase-hybrid-browse-seeds.js';\n"
    if import_anchor not in updated:
        raise RuntimeError("browse seeds import anchor missing")
    updated = updated.replace(import_anchor, import_anchor + IMPORTS, 1)

    reexport_anchor = (
        "export {\n"
        "  extractProducerBrowseSeed,\n"
        "  extractRegionBrowseSeed,\n"
        "} from './search-usecase-hybrid-browse-seeds.js';\n\n"
        "export interface CriticRetrievalObservability"
    )
    if reexport_anchor not in updated:
        raise RuntimeError("reexport anchor missing")
    updated = updated.replace(
        reexport_anchor,
        (
            "export {\n"
            "  extractProducerBrowseSeed,\n"
            "  extractRegionBrowseSeed,\n"
            "} from './search-usecase-hybrid-browse-seeds.js';\n"
            + REEXPORT
            + "\nexport interface CriticRetrievalObservability"
        ),
    )

    MAIN.write_text(updated, encoding="utf-8")
    print(f"Wrote {NEW.name} ({len(NEW.read_text().splitlines())} lines)")
    print(f"Updated {MAIN.name} ({len(MAIN.read_text().splitlines())} lines)")


if __name__ == "__main__":
    main()
