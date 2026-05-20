/**
 * Observability payload for NL → constraint extraction.
 *
 * RFC-019: The extraction pipeline is a 6-tier deterministic cascade, NOT a
 * fallback chain. Each tier independently fires and augments the constraint
 * bundle. "fallback" was a legacy misnomer — retained as deprecated boolean
 * for backward compat but `source` field is the authoritative path indicator.
 *
 * Tier 1: Symbolic lookup (DEFAULT_MAPPINGS) — phrase → attribute/value
 * Tier 2: Entity Resolver (alias → canonical entity) — grape/region/country/wine_type
 * Tier 3: Ontology Expansion (entity → ancestors/parents) — region→country
 * Tier 4: Compositional Inference (entity+entity → structure prior)
 * Tier 5: LLM Linker (disabled by default) — OOV phrases
 * Tier 6: Regex Extractor — pattern matching for price/vintage/wine_type
 *
 * Shared by NL `mapConstraints` results, `QueryPlanV2`, `QueryUnderstandingSnapshot`,
 * and `CompiledWineQuery.query` — never stored on singleton services (request-scoped only).
 */
export interface ConstraintExtractionTierBreakdown {
    readonly tier1_default_mapping: number;
    readonly tier2_entity_resolver: number;
    readonly tier3_ontology_expansion: number;
    readonly tier4_compositional_inference: number;
    readonly tier5_llm_linker: number;
    /** Tier 6: regex-based extractor. Legacy name retained for JSON compat. */
    readonly tier6_regex_fallback: number;
    readonly unmapped: number;
}
export interface ConstraintExtractionTrace {
    readonly candidatePhraseCount: number;
    readonly candidateSpanCount?: number | undefined;
    readonly ruleTableHitCount: number;
    readonly llmHitCount: number;
    readonly llmSkippedCount: number;
    /**
     * @deprecated Use `source` field instead. This boolean only indicates
     * "Tier 1+2 produced 0 constraints so Tier 6 regex was the sole extractor".
     * It does NOT mean the pipeline "failed" — retained for backward compat.
     */
    readonly fallbackTriggered: boolean;
    /** Authoritative indicator of which tiers contributed to extraction. */
    readonly source: 'rule_only' | 'llm_only' | 'hybrid' | 'fallback' | 'resolver' | 'resolver_plus_llm';
    readonly llmLatencyMs: number | null;
    readonly phraseCacheHits: number;
    readonly phraseCacheNegativeSkipped: number;
    readonly phraseCacheMisses: number;
    readonly llmLinkedEntityCount?: number | undefined;
    readonly resolvedEntityCount?: number | undefined;
    readonly directHardConstraintCount?: number | undefined;
    readonly ontologyExpandedConstraintCount?: number | undefined;
    readonly compositionalInferenceCount?: number | undefined;
    readonly phrasesByTier?: ConstraintExtractionTierBreakdown | undefined;
    readonly categoriesCovered?: readonly string[] | undefined;
    readonly unresolvedSpanSamples?: readonly string[] | undefined;
    readonly semanticConstraintRecall?: number | undefined;
    readonly entityLinkingAccuracy?: number | undefined;
    readonly missedPhrases: readonly string[];
    /**
     * When `source === 'fallback'`, this field distinguishes WHY the fallback
     * fired. Absent when the pipeline produced constraints normally.
     *
     * - `nlmapper_exception`: NLMapper.mapConstraints threw (LLM timeout, API error, etc.)
     * - `llm_schema_validation`: LLM returned parseable JSON that failed Zod validation
     * - `llm_empty_response`: LLM returned a valid but empty constraint set
     */
    readonly fallbackReason?: 'nlmapper_exception' | 'llm_schema_validation' | 'llm_empty_response' | undefined;
}
//# sourceMappingURL=constraint-extraction-trace.d.ts.map