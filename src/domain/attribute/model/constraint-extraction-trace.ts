/**
 * Observability payload for NL → constraint extraction (rule table vs LLM).
 * Shared by NL `mapConstraints` results, `QueryPlanV2`, `QueryUnderstandingSnapshot`,
 * and `CompiledWineQuery.query` — never stored on singleton services (request-scoped only).
 */
export interface ConstraintExtractionTrace {
  readonly candidatePhraseCount: number;
  readonly ruleTableHitCount: number;
  readonly llmHitCount: number;
  readonly llmSkippedCount: number;
  readonly fallbackTriggered: boolean;
  readonly source: 'rule_only' | 'llm_only' | 'hybrid' | 'fallback';
  readonly llmLatencyMs: number | null;
  readonly phraseCacheHits: number;
  readonly phraseCacheNegativeSkipped: number;
  readonly phraseCacheMisses: number;
  readonly missedPhrases: readonly string[];
}
