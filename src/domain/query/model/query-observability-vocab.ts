import type { ConstraintExtractionTrace } from '../../attribute/model/constraint-extraction-trace.js';
import type { QueryPlanV1, QueryPlanV2 } from './query-plan.js';
import type { CompiledWineQuery } from './compiled-wine-query.js';
import type { AmbiguityIntentTrace } from './ambiguity-intent-interpretation.js';

/** Truncate raw query in observability vocab payloads (telemetry size bound). */
const OBSERVABILITY_RAW_QUERY_PREVIEW_CHARS = 200;

/**
 * Type guard that distinguishes a QueryPlanV2 from a QueryPlanV1.
 *
 * V2 carries `suggestedRoute` + `suggestedRetrievalMode` (planner hints, NOT
 * bound execution decisions) and does NOT carry V1's `route` / `retrievalMode`.
 * Checking both conditions prevents misclassification if a V1 plan is ever
 * accidentally spread with extra keys (e.g. `{ ...v1Plan, suggestedRoute: ... }`).
 */
export function isQueryPlanV2(plan: QueryPlanV1 | QueryPlanV2): plan is QueryPlanV2 {
  return 'suggestedRoute' in plan && !('route' in plan);
}

export const QUERY_FAMILY_LABELS = [
  'entity_exact',
  'entity_fuzzy',
  'entity_resolution',
  'attribute_constrained',
  'producer_browse',
  'region_browse',
  'comparison',
  'recommendation',
  'pairing',
  'multi_intent',
  'no_match',
  'ambiguous',
  'unknown',
] as const;

export type QueryFamilyLabel = (typeof QUERY_FAMILY_LABELS)[number];

type PlanLike = QueryPlanV1 | QueryPlanV2;

/** Constraint extraction provenance — tracks rule vs LLM hit rates. */
export type ConstraintExtractionObservability = ConstraintExtractionTrace;

export interface QueryObservabilitySlice {
  readonly queryId: string;
  readonly rawQuery: string;
  readonly queryFamily: QueryFamilyLabel;
  readonly intent: string;
  readonly queryClass: string;
  readonly suggestedRetrievalMode: string;
  readonly suggestedRoute: string;
  readonly anchorCount: number;
  readonly hardConstraintCount: number;
  readonly softConstraintCount: number;
  readonly overallUncertainty: number;
  readonly ambiguityDetected: boolean;
  readonly plannerVersion: string;
  readonly policyRuleVersion: string;
  readonly thresholdProfileId: string;
  readonly decompositionStrategy?: string | undefined;
  readonly decompositionConfidence?: number | undefined;
  /** Constraint extraction provenance (populated when LlmNLMapper is active). */
  readonly constraintExtraction?: ConstraintExtractionObservability | undefined;
  readonly ambiguityIntentSource?: AmbiguityIntentTrace['source'] | undefined;
  readonly ambiguityIntentLatencyMs?: number | null | undefined;
  readonly ambiguityIntentBranchSelectionCount?: number | undefined;
  readonly ambiguityIntentSelectedBranchCount?: number | undefined;
  readonly ambiguityIntentQueryClassOverride?: string | undefined;
}

function getSuggestedRoute(plan: PlanLike): string {
  return isQueryPlanV2(plan) ? plan.suggestedRoute : plan.route;
}

function getSuggestedRetrievalMode(plan: PlanLike): string {
  return isQueryPlanV2(plan) ? plan.suggestedRetrievalMode : plan.retrievalMode;
}

function getObservabilityRoute(plan: PlanLike, compiled?: CompiledWineQuery): string {
  return compiled !== undefined ? compiled.execution.effectiveRoute : getSuggestedRoute(plan);
}

function getObservabilityRetrievalMode(plan: PlanLike, compiled?: CompiledWineQuery): string {
  return compiled !== undefined
    ? compiled.execution.effectiveRetrievalMode
    : getSuggestedRetrievalMode(plan);
}

function isConvergedExactLookupTelemetryContract(
  plan: PlanLike,
  compiled?: CompiledWineQuery,
): boolean {
  const mode = getObservabilityRetrievalMode(plan, compiled);
  return plan.intent === 'entity_exact'
    && plan.queryClass === 'short_entity'
    && mode === 'entity_lookup';
}

export function deriveQueryFamily(
  plan: PlanLike,
  compiled?: CompiledWineQuery,
): QueryFamilyLabel {
  const mode = getObservabilityRetrievalMode(plan, compiled);
  const intent = plan.intent;
  // decompositionHint is optional on both QueryPlanV1 and QueryPlanV2; no 'in' guard needed.
  const decompositionHint = plan.decompositionHint;

  if (mode === 'no_match_detection') return 'no_match';
  if (mode === 'producer_browse') return 'producer_browse';
  if (mode === 'region_browse') return 'region_browse';
  if (mode === 'compare_candidates') return 'comparison';
  if (mode === 'recommendation' || mode === 'similar_items') return 'recommendation';

  // When the planner/runtime have already converged on an exact entity lookup,
  // keep the family aligned with that contract even if a coarse ambiguity bit
  // remains set upstream. This preserves telemetry consistency for exact
  // metadata / freshness queries that intentionally fail closed after an
  // entity lookup attempt.
  if (isConvergedExactLookupTelemetryContract(plan, compiled)) {
    return 'entity_exact';
  }

  if (plan.uncertainty.ambiguityDetected) return 'ambiguous';

  if (decompositionHint?.strategy === 'comparison') return 'comparison';
  if (decompositionHint !== undefined && decompositionHint.strategy !== 'none') {
    return 'multi_intent';
  }

  if (intent === 'entity_exact') return 'entity_exact';
  if (intent === 'entity_fuzzy') return 'entity_fuzzy';
  if (intent === 'pairing_search') return 'pairing';
  if (intent === 'comparison_search' || intent === 'mixed_query') return 'comparison';
  if (intent === 'semantic_discovery' || intent === 'budget_search') return 'entity_resolution';

  if (mode === 'constraint_filter' || mode === 'attribute_search') return 'attribute_constrained';

  return 'unknown';
}

/**
 * Build the query observability slice. Resolution order for `constraintExtraction`:
 * 1. Explicit 4th argument (when callers need an override).
 * 2. `plan.constraintExtraction` when `plan` is QueryPlanV2.
 * 3. `compiled.query.constraintExtraction` (ExecutionCompiler copy of planner output).
 */
export function planToObservabilitySlice(
  queryId: string,
  plan: PlanLike,
  compiled?: CompiledWineQuery,
  constraintExtraction?: ConstraintExtractionObservability,
): QueryObservabilitySlice {
  // decompositionHint is optional on both QueryPlanV1 and QueryPlanV2; no 'in' guard needed.
  const decompositionHint = plan.decompositionHint;

  const resolvedConstraintExtraction =
    constraintExtraction
    ?? (isQueryPlanV2(plan) ? plan.constraintExtraction : undefined)
    ?? compiled?.query.constraintExtraction;
  const ambiguityIntentTrace = isQueryPlanV2(plan) ? plan.ambiguityIntentTrace : undefined;

  // Guard against NaN propagating to downstream confidence computation.
  // plan.uncertainty.overall must be a valid finite number in [0, 1]; if it
  // is somehow NaN (e.g. corrupted planner output), clamp to the max-uncertainty
  // sentinel (1.0) so downstream metrics stay meaningful.
  const overallUncertainty = Number.isFinite(plan.uncertainty.overall)
    ? plan.uncertainty.overall
    : 1;
  const ambiguityDetected = isConvergedExactLookupTelemetryContract(plan, compiled)
    ? false
    : plan.uncertainty.ambiguityDetected;

  return {
    queryId,
    rawQuery: plan.rawQuery.slice(0, OBSERVABILITY_RAW_QUERY_PREVIEW_CHARS),
    queryFamily: deriveQueryFamily(plan, compiled),
    intent: plan.intent,
    queryClass: plan.queryClass,
    suggestedRetrievalMode: getObservabilityRetrievalMode(plan, compiled),
    suggestedRoute: getObservabilityRoute(plan, compiled),
    anchorCount: plan.anchors.length,
    hardConstraintCount: plan.constraints.hard.length,
    softConstraintCount: plan.constraints.soft.length,
    overallUncertainty,
    ambiguityDetected,
    plannerVersion: plan.plannerVersion,
    policyRuleVersion: plan.policyRuleVersion,
    thresholdProfileId: plan.thresholdProfileId,
    ...(decompositionHint !== undefined
      ? {
          decompositionStrategy: decompositionHint.strategy,
          decompositionConfidence: decompositionHint.confidence,
        }
      : {}),
    ...(resolvedConstraintExtraction !== undefined
      ? { constraintExtraction: resolvedConstraintExtraction }
      : {}),
    ...(ambiguityIntentTrace !== undefined
      ? {
          ambiguityIntentSource: ambiguityIntentTrace.source,
          ambiguityIntentLatencyMs: ambiguityIntentTrace.latencyMs,
          ambiguityIntentBranchSelectionCount: ambiguityIntentTrace.branchSelectionCount,
          ambiguityIntentSelectedBranchCount: ambiguityIntentTrace.selectedBranchCount,
          ...(ambiguityIntentTrace.queryClassOverride !== undefined
            ? { ambiguityIntentQueryClassOverride: ambiguityIntentTrace.queryClassOverride }
            : {}),
        }
      : {}),
  };
}
