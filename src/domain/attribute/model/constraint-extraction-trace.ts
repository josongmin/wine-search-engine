/**
 * Observability payload for NL → constraint extraction (rule table vs LLM).
 * Shared by NL `mapConstraints` results, `QueryPlanV2`, `QueryUnderstandingSnapshot`,
 * and `CompiledWineQuery.query` — never stored on singleton services (request-scoped only).
 */
export interface ConstraintExtractionTierBreakdown {
  readonly tier1_default_mapping: number;
  readonly tier2_entity_resolver: number;
  readonly tier3_ontology_expansion: number;
  readonly tier4_compositional_inference: number;
  readonly tier5_llm_linker: number;
  readonly tier6_regex_fallback: number;
  readonly unmapped: number;
}

export interface ConstraintExtractionTrace {
  readonly candidatePhraseCount: number;
  readonly candidateSpanCount?: number | undefined;
  readonly ruleTableHitCount: number;
  readonly llmHitCount: number;
  readonly llmSkippedCount: number;
  readonly fallbackTriggered: boolean;
  readonly source:
    | 'rule_only'
    | 'llm_only'
    | 'hybrid'
    | 'fallback'
    | 'resolver'
    | 'resolver_plus_llm';
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
}
