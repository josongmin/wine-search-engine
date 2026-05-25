#!/usr/bin/env python3
"""Prompt E: reviewed knip cleanup — single atomic pass."""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def strip_export_keyword(text: str, names: frozenset[str]) -> str:
    for name in names:
        text = re.sub(
            rf"^export (const|function|async function|type|interface) {re.escape(name)}\b",
            rf"\1 {name}",
            text,
            flags=re.MULTILINE,
        )
    return text


def main() -> None:
    # 1. Delete unused file
    dead_file = ROOT / "src/application/search/compare-tool-shared-constraints.ts"
    if dead_file.exists():
        dead_file.unlink()

    # 2. agent-tool-execution-support — drop unused exports; keep withTimeout + buildToolOutcome
    ates = ROOT / "src/application/agent/agent-tool-execution-support.ts"
    ates_text = read(ates)
    ates_text = ates_text.replace("export const MAX_TOOLS_PER_BATCH = 4;\n\n", "")
    for block_start in (
        "export function formatPolicyBlockedObservation",
        "export interface TimeoutErrorLike",
        "export function getToolTimeoutMs",
        "export function getParallelBatchTimeoutMs",
        "export function buildObservationPairs",
    ):
        idx = ates_text.find(block_start)
        if idx == -1:
            continue
        # Remove from block_start through end of function (next export or EOF)
        rest = ates_text[idx:]
        next_export = rest.find("\nexport ", 1)
        if next_export == -1:
            ates_text = ates_text[:idx]
        else:
            ates_text = ates_text[:idx] + ates_text[idx + next_export :]
    # Re-add private timeout helper used by withTimeout
    if "function makeTimeoutError" not in ates_text:
        insert = (
            "\ninterface TimeoutErrorLike extends Error {\n"
            "  readonly code?: string;\n"
            "}\n\n"
            "function makeTimeoutError(message: string): TimeoutErrorLike {\n"
            "  return Object.assign(new Error(message), { code: 'TIMEOUT' });\n"
            "}\n\n"
        )
        ates_text = ates_text.replace(
            "export async function withTimeout",
            insert + "export async function withTimeout",
        )
    # Drop unused imports after removing formatPolicyBlockedObservation
    ates_text = ates_text.replace(
        "import type { AgentToolCallPair } from '../../domain/agent/model/agent-step.js';\n",
        "",
    )
    ates_text = ates_text.replace(
        "import type { DomainError } from '../../domain/shared/error/domain-error.js';\n",
        "",
    )
    ates_text = ates_text.replace(
        "import { PolicyBlockedError } from '../../domain/shared/error/policy-blocked.js';\n",
        "",
    )
    write(ates, ates_text)

    # 3. lookup-wine-execution — remove dead executeLookupAsEntitySearch
    lookup = ROOT / "src/application/search/lookup-wine-execution.ts"
    lookup_text = read(lookup)
    lookup_text = re.sub(
        r"\n/\*\*\n \* Dispatch options for \{\@link executeLookupAsEntitySearch\}.*?"
        r"return options\.searchUseCase\.execute\([^;]+;\n\}\n",
        "\n",
        lookup_text,
        flags=re.DOTALL,
    )
    lookup_text = lookup_text.replace(
        " *  - {@link executeLookupAsEntitySearch} — the dispatch primitive for the\n"
        " *    HTTP / batch path: takes a {@link SearchExecutorPort}, builds a\n"
        " *    {@link SearchRequest} that forces `mode: 'entity'`, clamps `limit` to\n"
        " *    {@link LOOKUP_WINE_LIMIT_MAX}, forwards the abort signal.\n"
        " *  - {@link normalizeLookupWineInput}",
        " *  - {@link normalizeLookupWineInput}",
    )
    lookup_text = lookup_text.replace("Three exports:", "Two exports:")
    lookup_text = lookup_text.replace(
        "import type { SearchExecutorPort, SearchExecutorResult } from './port/search-executor.port.js';\n",
        "",
    )
    for name in (
        "LookupWineInput",
        "NormalizedLookupWineInput",
        "InvalidLookupWineInput",
        "LookupWineInputNormalizationResult",
    ):
        lookup_text = lookup_text.replace(f"export type {name}", f"type {name}")
        lookup_text = lookup_text.replace(f"export interface {name}", f"interface {name}")
    write(lookup, lookup_text)

    # 4. decomposition-detector
    decomp = ROOT / "src/domain/query/service/decomposition-detector.ts"
    decomp_text = read(decomp)
    decomp_text = re.sub(
        r"\nexport function buildComparisonDecompositionLegsForRetrieval\([^}]+\}\n\}\n",
        "\n",
        decomp_text,
        flags=re.DOTALL,
    )
    decomp_text = decomp_text.replace(
        "export function buildComparisonDecompositionLegs(",
        "function buildComparisonDecompositionLegs(",
    )
    write(decomp, decomp_text)

    # 5. tool-outcome — remove unused buildSynthesisContext
    tout = ROOT / "src/domain/agent/model/tool-outcome.ts"
    tout_text = read(tout)
    tout_text = re.sub(
        r"\n// ─── buildSynthesisContext.*?\n\}\n",
        "\n",
        tout_text,
        flags=re.DOTALL,
    )
    write(tout, tout_text)

    # 6. agent-tool-attempt-schema — remove unused parse helpers
    schema = ROOT / "src/domain/agent/model/agent-tool-attempt-schema.ts"
    schema_text = read(schema)
    schema_text = re.sub(
        r"\n/\*\*\n \* Parse and validate a known tool.*?"
        r"return bounded;\n\}\n",
        "\n",
        schema_text,
        flags=re.DOTALL,
    )
    schema_text = schema_text.replace("export const LookupWineAttemptInputSchema", "const LookupWineAttemptInputSchema")
    for name in (
        "SearchToolAttemptInput",
        "LookupWineAttemptInput",
        "FoodPairingAttemptInput",
        "DrinkingWindowAttemptInput",
        "CompareWinesAttemptInput",
        "KnownAgentToolAttempt",
        "UnknownAgentToolAttempt",
        "AgentToolAttempt",
    ):
        schema_text = schema_text.replace(f"export type {name}", f"type {name}")
        schema_text = schema_text.replace(f"export interface {name}", f"interface {name}")
    schema_text = schema_text.replace("export const MAX_UNKNOWN_TOOL_INPUT_KEYS", "const MAX_UNKNOWN_TOOL_INPUT_KEYS")
    write(schema, schema_text)

    # 7. search-tool-contract — unexport symbols not imported by tool-schemas / peers
    stc = ROOT / "src/application/search/search-tool-contract.ts"
    keep_export = frozenset(
        {
            "SEARCH_TOOL_RETRIEVAL_MODES",
            "SEARCH_TOOL_WINE_TYPES",
            "SEARCH_TOOL_DRINKING_WINDOW_VALUES",
            "FOOD_PAIRING_COLORS",
            "SEARCH_TOOL_DESCRIPTION",
            "LOOKUP_WINE_TOOL_DESCRIPTION",
            "LOOKUP_WINE_LIMIT_MAX",
            "LOOKUP_WINE_QUERY_DESCRIPTION",
            "SEARCH_TOOL_MAX_STYLES",
            "FOOD_PAIRING_SWEETNESS_TARGET_MIN",
            "FOOD_PAIRING_SWEETNESS_TARGET_MAX",
            "SEARCH_TOOL_APPELLATION_DESCRIPTION",
            "SEARCH_TOOL_CERTIFICATION_DESCRIPTION",
            "SEARCH_TOOL_COUNTRY_DESCRIPTION",
            "SEARCH_TOOL_REGION_DESCRIPTION",
            "SEARCH_TOOL_EXCLUDE_GRAPES_DESCRIPTION",
            "SEARCH_TOOL_EXCLUDE_REGIONS_DESCRIPTION",
            "SEARCH_TOOL_EXCLUDE_WINE_TYPES_DESCRIPTION",
            "SEARCH_TOOL_LIMIT_DESCRIPTION",
            "SEARCH_TOOL_OCCASION_DESCRIPTION",
            "SEARCH_TOOL_GIFT_SUITABILITY_MIN_DESCRIPTION",
            "SEARCH_TOOL_BEGINNER_SUITABILITY_MIN_DESCRIPTION",
            "SEARCH_TOOL_PRODUCER_PRESTIGE_MIN_DESCRIPTION",
            "SEARCH_TOOL_POPULARITY_MIN_DESCRIPTION",
            "SEARCH_TOOL_RECIPIENT_PROFILE_DESCRIPTION",
            "SEARCH_TOOL_SWEETNESS_MIN_DESCRIPTION",
            "SEARCH_TOOL_SWEETNESS_MAX_DESCRIPTION",
            "SEARCH_TOOL_ACIDITY_MIN_DESCRIPTION",
            "SEARCH_TOOL_ACIDITY_MAX_DESCRIPTION",
            "SEARCH_TOOL_TANNIN_MAX_DESCRIPTION",
            "SEARCH_TOOL_DRINKING_WINDOW_DESCRIPTION",
            "SEARCH_TOOL_DRINKING_WINDOW_TARGET_YEAR_DESCRIPTION",
            "SEARCH_TOOL_GRAPE_PRIMARY_DESCRIPTION",
            "SEARCH_TOOL_MAX_ALCOHOL_PCT_DESCRIPTION",
            "SEARCH_TOOL_MAX_EXCLUDE_FILTERS",
            "SEARCH_TOOL_MIN_PRICE_KRW_DESCRIPTION",
            "SEARCH_TOOL_MAX_PRICE_KRW_DESCRIPTION",
            "SEARCH_TOOL_QUERY_DESCRIPTION",
            "SEARCH_TOOL_RETRIEVAL_MODE_DESCRIPTION",
            "SEARCH_TOOL_STYLE_DESCRIPTION",
            "SEARCH_TOOL_STYLES_DESCRIPTION",
            "SEARCH_TOOL_VINTAGE_MAX",
            "SEARCH_TOOL_VINTAGE_MAX_DESCRIPTION",
            "SEARCH_TOOL_VINTAGE_MIN",
            "SEARCH_TOOL_VINTAGE_MIN_DESCRIPTION",
            "SEARCH_TOOL_WANT_DIVERSITY_DESCRIPTION",
            "SEARCH_TOOL_WINE_TYPE_DESCRIPTION",
            "buildEntityIdToolField",
            "buildFoodPairingFieldShape",
            "buildSearchToolFieldShape",
            "buildSearchToolQueryField",
            "validateSearchToolVintageRange",
            "buildCompareToolFieldShape",
            "sanitizeOptionalToolNulls",
            "buildSearchToolStructuredPreferences",
            "buildSearchToolStyleQueryTerms",
        },
    )
    stc_text = read(stc)
    for m in re.finditer(r"^export (const|function) (\w+)", stc_text, re.MULTILINE):
        name = m.group(2)
        if name not in keep_export:
            stc_text = stc_text.replace(m.group(0), f"{m.group(1)} {name}", 1)
    write(stc, stc_text)

    # 8. Other modules — unexport knip-flagged symbols
    patches: list[tuple[Path, frozenset[str]]] = [
        (
            ROOT / "src/application/search/search-tool-diversity.ts",
            frozenset({"queryMentionsWineType", "mergeSearchResponsesForDiversityDiscovery"}),
        ),
        (
            ROOT / "src/application/search/search-tool-query-policy.ts",
            frozenset({"buildSearchToolPriceClauses"}),
        ),
        (
            ROOT / "src/application/search/search-tool-retrieval-core.ts",
            frozenset(
                {
                    "shouldPreserveRepresentativeAnchorOnlyQuery",
                    "shouldPreferTypedStructuredQuery",
                },
            ),
        ),
        (
            ROOT / "src/application/wine-search/wine-search-schemas.ts",
            frozenset({"WINE_SEARCH_MIN_RETRIEVAL_K", "WINE_SEARCH_MAX_RETRIEVAL_K"}),
        ),
        (
            ROOT / "src/config/container-structured-llm.ts",
            frozenset({"DEFAULT_WINE_SEARCH_OPENAI_MODEL"}),
        ),
        (
            ROOT / "src/infrastructure/ml/drinking-window-predictor.ts",
            frozenset({"DRINKING_WINDOW_MODEL_VERSION"}),
        ),
        (
            ROOT / "test/benchmark/agent/benchmark-insight-generator.ts",
            frozenset({"printBenchmarkInsights"}),
        ),
    ]
    for path, names in patches:
        write(path, strip_export_keyword(read(path), names))

    # 9. scenarios.ts — remove unused profile ID blocks (keep ROBUSTNESS imports used elsewhere)
    scenarios = ROOT / "test/benchmark/agent/scenarios.ts"
    scen_text = read(scenarios)
    marker = "export const STANDARD_SCENARIO_IDS"
    if marker in scen_text:
        scen_text = scen_text[: scen_text.index(marker)].rstrip() + "\n"
        write(scenarios, scen_text)

    # 10. Fix regression import paths
    c2 = ROOT / "test/regression/c2-downstream-appellation-retrieval.regression.test.ts"
    c2_text = read(c2)
    c2_text = c2_text.replace(
        "../../src/observability/log-search-event.js",
        "../../src/domain/observability/log-search-event.js",
    )
    write(c2, c2_text)

    partial = ROOT / "test/regression/partial-resolution-graceful-opt-in.regression.test.ts"
    partial_text = read(partial)
    partial_text = partial_text.replace(
        "../../src/application/search/port/entity-document-lookup.port.js",
        "../../src/application/search/port/search-pipeline-deps.port.js",
    )
    write(partial, partial_text)

    print("knip-prompt-e-apply: done")


if __name__ == "__main__":
    main()
