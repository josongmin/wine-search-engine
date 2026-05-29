/**
 * Wine search analyzer — typed output contract.
 *
 * This module defines the Zod schemas and inferred types emitted by
 * `QueryAnalyzerService`. It is the *contract* that downstream Plan-then-
 * Execute components (planner, executor, synthesizer) consume.
 *
 * Design notes:
 *  - The canonical Zod mirror of `NormalizedConstraint` lives next to its
 *    interface in `@shared/types/constraint-bundle-schema.ts` (SSoT per
 *    CLAUDE.md rules 25/30). This module imports the schema from there and
 *    re-exports it so existing callers of `@app/wine-search/wine-search-schemas`
 *    keep working unchanged (strangler-fig migration step).
 *  - All schemas chain `.strict()` per CLAUDE.md rule 10. None of these are
 *    LLM tool-call shapes — they are server-side contract shapes that MUST
 *    fail closed on unknown keys.
 *  - Every numeric bound is a named const (CLAUDE.md rule 15) with a domain
 *    justification comment.
 *  - Korean regex boundaries (where used downstream) follow rule 8 and 24.
 */

import { z } from 'zod';
import {
  NormalizedConstraintSchema,

} from '@shared/types/index.js';
import { QUERY_INTENTS } from '@domain/query/model/query-intent.js';
import { QUERY_CLASSES } from '@domain/shared/types/query-class.js';
import { SOFT_CONSTRAINT_ATTRIBUTES } from '@shared/constants/constraint-attributes.js';
import { canonicalizePriceConstraintLike } from '@shared/utils/canonical-price.js';
import {
  MAX_PRODUCED_VINTAGE_YEAR,
  MIN_PRODUCED_VINTAGE_YEAR,
} from '@shared/constants.js';

// Re-export the canonical schema + interface so existing callers of
// `@app/wine-search/wine-search-schemas.js` keep working unchanged. The SSoT
// for `NormalizedConstraintSchema` now lives in `@shared/types`; this file
// continues to expose it under its historical import path.
export { NormalizedConstraintSchema };

/** Matches `MAX_AGENT_HTTP_QUERY_CHARS` in `src/interface/http/constants.ts`.
 *  Re-declared at module scope to keep this contract independent of the
 *  HTTP interface layer (domain ports must not depend on interface code).
 *  The arithmetic agreement between layers is verified by Zod parse failure
 *  if the HTTP layer ever raises its own cap above this value. */
export const WINE_SEARCH_MAX_QUERY_CHARS = 2000;

/** Domain justification: empirical compound Korean queries observed at most
 *  six distinct anchor entities (e.g. "보르도 2018 vs 부르고뉴 피노누아 vs
 *  나파 카베르네"). Allow up to 8 to leave headroom without unbounding. */
export const WINE_SEARCH_MAX_ANCHORS = 8;

/** Aligned with `LlmConstraintItemSchema` array `.max(50)` and downstream
 *  cap usage; 32 covers the worst observed compound query (6 entities * ~5
 *  constraints each ≈ 30) while remaining well under the LLM contract cap. */
export const WINE_SEARCH_MAX_CONSTRAINTS = 32;

/** Plan-then-Execute step budgets. Minimum 1 (refuse path), maximum 10 to
 *  match the heaviest adaptive-budget classification (`nested_condition`
 *  uses 8; we leave a small margin for synthesis). */
export const WINE_SEARCH_BUDGET_MIN_STEPS = 1;
export const WINE_SEARCH_BUDGET_MAX_STEPS = 10;

/** Per-tool invocation cap. Mirrors `step-budget.ts` MIN_PER_TOOL_CALL_CAP
 *  (3) on the lower bound; 6 matches max(MIN, ceil(maxSteps*0.6)) for
 *  maxSteps=10. */
export const WINE_SEARCH_MIN_PER_TOOL_CAP = 2;
export const WINE_SEARCH_MAX_PER_TOOL_CAP = 6;

/** Adaptive retrieval `k` bounds. Minimum 1 (degraded entity-lookup path
 *  still must request at least one candidate). Maximum 500 matches the
 *  widest `exploratory` value in `RETRIEVAL_K_BY_INTENT` (SSoT —
 *  `src/domain/agent/service/adaptive-budget.ts`). The cap is intentionally
 *  generous so the analyzer can emit the full SOTA range without clamping.
 *
 *  Exported so {@link execution-plan-schemas.ts}'s `SearchUseCaseInputSchema`
 *  can reuse the same `limit` ceiling (CLAUDE.md rule 30 — single source for
 *  cross-module bounds). */
export const WINE_SEARCH_MIN_RETRIEVAL_K = 1;
export const WINE_SEARCH_MAX_RETRIEVAL_K = 500;
export const WINE_SEARCH_MIN_RESULT_LIMIT = 1;
export const WINE_SEARCH_MAX_RESULT_LIMIT = 50;

/** Comparison legs: at least 2 (binary comparison), capped at 4 — beyond 4
 *  legs decomposition quality collapses and the orchestrator falls back to
 *  flat search. */
const WINE_SEARCH_DECOMPOSITION_MIN_LEGS = 2;
const WINE_SEARCH_DECOMPOSITION_MAX_LEGS = 4;

/** Parallel-slot bounds (e.g. "appetizer + main + dessert" pairing). */
const WINE_SEARCH_PARALLEL_SLOT_MIN_LIMIT = 1;
const WINE_SEARCH_PARALLEL_SLOT_MAX_LIMIT = 10;

/** Vintage-year bounds — internal aliases that pin
 *  `AnalysisContractSchema.exactMetadataTargetVintage` to the same window as
 *  `@shared/constants` (`MIN/MAX_PRODUCED_VINTAGE_YEAR`). Not exported —
 *  external callers should import the shared constant directly to keep the
 *  domain SSoT visible. */
const WINE_SEARCH_MIN_VINTAGE_YEAR = MIN_PRODUCED_VINTAGE_YEAR;
const WINE_SEARCH_MAX_VINTAGE_YEAR = MAX_PRODUCED_VINTAGE_YEAR;

/**
 * Analyzer-emitted query intent — the 5-way deterministic classification used
 * by {@link WineSearchAnalysisSchema}. Distinct from the 8-way **domain**
 * `QueryIntent` enum in `@domain/query/model/query-intent` (entity_exact,
 * facet_search, pairing_search, …), which is the authority for downstream
 * router/runner/caller-interpretation logic. These two enums were silently
 * colliding under the same name (CLAUDE.md rule 30) — the analyzer-side is now
 * renamed to make the layering explicit. The caller-interpretation field on
 * the analyzer output still references the domain enum via
 * {@link WineSearchCallerInterpretationSchema}.
 */
export const AnalyzerIntentSchema = z.enum([
  'search',
  'compare',
  'pair',
  'drinkability',
  'unknown',
]);
export type AnalyzerIntent = z.infer<typeof AnalyzerIntentSchema>;

export const AnchorEntityTypeSchema = z.enum([
  'producer',
  'wine',
  'appellation',
  'region',
  'country',
  'grape',
  'style',
]);
export type AnchorEntityType = z.infer<typeof AnchorEntityTypeSchema>;

export const AnchorResolutionSchema = z.object({
  surface: z.string().min(1).max(WINE_SEARCH_MAX_QUERY_CHARS),
  canonicalValue: z.string().min(1).max(WINE_SEARCH_MAX_QUERY_CHARS),
  entityType: AnchorEntityTypeSchema,
  confidence: z.number().finite().min(0).max(1),
}).strict();
export type AnchorResolution = z.infer<typeof AnchorResolutionSchema>;

const ComparisonLegSchema = z.object({
  surface: z.string().min(1).max(WINE_SEARCH_MAX_QUERY_CHARS),
  constraints: z.array(NormalizedConstraintSchema).max(WINE_SEARCH_MAX_CONSTRAINTS),
}).strict();

export const ParallelSlotSchema = z.object({
  wineType: z.string().min(1).max(WINE_SEARCH_MAX_QUERY_CHARS),
  limit: z.number().int().min(WINE_SEARCH_PARALLEL_SLOT_MIN_LIMIT).max(WINE_SEARCH_PARALLEL_SLOT_MAX_LIMIT).optional(),
}).strict();

export const DecompositionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('comparison'),
    legs: z.array(ComparisonLegSchema)
      .min(WINE_SEARCH_DECOMPOSITION_MIN_LEGS)
      .max(WINE_SEARCH_DECOMPOSITION_MAX_LEGS),
  }).strict(),
  z.object({
    kind: z.literal('parallel-slot'),
    slots: z.array(ParallelSlotSchema)
      .min(WINE_SEARCH_DECOMPOSITION_MIN_LEGS)
      .max(WINE_SEARCH_DECOMPOSITION_MAX_LEGS),
  }).strict(),
]);
export type Decomposition = z.infer<typeof DecompositionSchema>;

export const AnalysisRequiredToolSchema = z.enum([
  'search_wines',
  'compare_wines',
  'check_drinking_window',
  'get_food_pairings',
]);
export type AnalysisRequiredTool = z.infer<typeof AnalysisRequiredToolSchema>;

export const AnalysisContractSchema = z.object({
  requiresDrinkabilityCheck: z.boolean(),
  requiredTool: AnalysisRequiredToolSchema.optional(),
  requiresGroundedWineSearch: z.boolean(),
  hasEntityMetadataSignal: z.boolean(),
  exactMetadataTargetVintage: z.number()
    .int()
    .finite()
    .min(WINE_SEARCH_MIN_VINTAGE_YEAR)
    .max(WINE_SEARCH_MAX_VINTAGE_YEAR)
    .optional(),
}).strict();
export type AnalysisContract = z.infer<typeof AnalysisContractSchema>;

export const WineSearchCallerInterpretationSchema = z.object({
  authority: z.literal('caller'),
  intent: z.enum(QUERY_INTENTS),
  queryClass: z.enum(QUERY_CLASSES),
}).strict();
export type WineSearchCallerInterpretation = z.infer<typeof WineSearchCallerInterpretationSchema>;

export const RecommendedBudgetSchema = z.object({
  maxSteps: z.number().int()
    .min(WINE_SEARCH_BUDGET_MIN_STEPS)
    .max(WINE_SEARCH_BUDGET_MAX_STEPS),
  perToolCap: z.number().int()
    .min(WINE_SEARCH_MIN_PER_TOOL_CAP)
    .max(WINE_SEARCH_MAX_PER_TOOL_CAP),
  /** Adaptive retrieval `k` (Vespa candidate-pool size). Optional for
   *  backwards-compat with existing call sites and fixtures that only
   *  populated step budgets. When absent, the deterministic router falls
   *  back to its built-in default (no behavior change vs the pre-lever
   *  baseline). The analyzer ALWAYS emits this field — SSoT
   *  `RETRIEVAL_K_BY_INTENT` in `adaptive-budget.ts`. */
  retrievalK: z.number().int()
    .finite()
    .min(WINE_SEARCH_MIN_RETRIEVAL_K)
    .max(WINE_SEARCH_MAX_RETRIEVAL_K)
    .optional(),
}).strict();
export type RecommendedBudget = z.infer<typeof RecommendedBudgetSchema>;

export const ConstraintTierBundleSchema = z.object({
  hard: z.array(NormalizedConstraintSchema).max(WINE_SEARCH_MAX_CONSTRAINTS),
  soft: z.array(NormalizedConstraintSchema).max(WINE_SEARCH_MAX_CONSTRAINTS),
  inferred: z.array(NormalizedConstraintSchema).max(WINE_SEARCH_MAX_CONSTRAINTS),
}).strict();
export type ConstraintTierBundle = z.infer<typeof ConstraintTierBundleSchema>;

/**
 * Outcome of the optional LLM-backed disambiguation fallback. The deterministic
 * pipeline runs first; only when intent=`unknown` AND no anchors AND no
 * constraints AND a `StructuredLlmPort` is wired does the analyzer call the
 * LLM. The fallback can succeed, fail (timeout / refusal / validation /
 * partial / circuit-open / unknown), or be skipped outright.
 *
 * Before this field existed, a fallback failure was silently "softened" to
 * `intent='search'` without any downstream signal — orchestrator metrics and
 * logs could not distinguish a confident `intent=search` from a deterministic
 * `unknown` that got promoted only because the LLM blew up. This flag closes
 * that observability gap. It is optional (omitted in legacy fixtures and
 * direct schema-parse round-trips that don't go through the analyzer) so
 * existing callers remain unaffected.
 *
 * Failure-reason taxonomy mirrors the `StructuredLlm*Error` classes in
 * `@domain/ai/port/structured-llm.port.ts`:
 *   - `'timeout'`          → `StructuredLlmTimeoutError`
 *   - `'refusal'`          → `StructuredLlmRefusalError`
 *   - `'validation'`       → `StructuredLlmValidationError`
 *   - `'partial_output'`   → `StructuredLlmPartialOutputError`
 *   - `'circuit_open'`     → `StructuredLlmCircuitOpenError`
 *   - `'unknown'`          → any other thrown error
 */
export const LlmFallbackOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not_attempted') }).strict(),
  z.object({ kind: z.literal('success') }).strict(),
  z.object({
    kind: z.literal('failed_softened_to_search'),
    failureReason: z.enum([
      'timeout',
      'refusal',
      'validation',
      'partial_output',
      'circuit_open',
      'unknown',
    ]),
  }).strict(),
]);
export type LlmFallbackOutcome = z.infer<typeof LlmFallbackOutcomeSchema>;

export const WineSearchAnalysisSchema = z.object({
  intent: AnalyzerIntentSchema,
  anchors: z.array(AnchorResolutionSchema).max(WINE_SEARCH_MAX_ANCHORS),
  constraints: ConstraintTierBundleSchema.optional(),
  normalizedConstraints: z.array(NormalizedConstraintSchema).max(WINE_SEARCH_MAX_CONSTRAINTS),
  requestedResultLimit: z.number().int()
    .min(WINE_SEARCH_MIN_RESULT_LIMIT)
    .max(WINE_SEARCH_MAX_RESULT_LIMIT)
    .optional(),
  decomposition: DecompositionSchema.optional(),
  contract: AnalysisContractSchema,
  expectedMultiStep: z.boolean(),
  recommendedBudget: RecommendedBudgetSchema,
  hangulDominant: z.boolean(),
  preservedSurface: z.string().max(WINE_SEARCH_MAX_QUERY_CHARS),
  callerInterpretation: WineSearchCallerInterpretationSchema.optional(),
  /** Observability trace for the optional LLM fallback. See
   *  {@link LlmFallbackOutcomeSchema} for branch semantics. Optional for
   *  backward compatibility with existing fixtures and external callers; the
   *  `QueryAnalyzerService` always populates it. */
  llmFallbackOutcome: LlmFallbackOutcomeSchema.optional(),
}).strict();
export type WineSearchAnalysis = z.infer<typeof WineSearchAnalysisSchema>;

function isSoftTierConstraint(constraint: z.infer<typeof NormalizedConstraintSchema>): boolean {
  const isNegationOperator = constraint.operator === 'exclude' || constraint.operator === 'not_in';
  return !isNegationOperator && SOFT_CONSTRAINT_ATTRIBUTES.has(constraint.attribute);
}

function canonicalizeConstraint(
  constraint: z.infer<typeof NormalizedConstraintSchema>,
): z.infer<typeof NormalizedConstraintSchema> {
  return canonicalizePriceConstraintLike(constraint);
}

function canonicalizeConstraintTierBundle(
  bundle: ConstraintTierBundle,
): ConstraintTierBundle {
  return {
    hard: bundle.hard.map(canonicalizeConstraint),
    soft: bundle.soft.map(canonicalizeConstraint),
    inferred: bundle.inferred.map(canonicalizeConstraint),
  };
}

function flattenConstraintTierBundle(
  bundle: ConstraintTierBundle,
): readonly z.infer<typeof NormalizedConstraintSchema>[] {
  return [
    ...bundle.hard,
    ...bundle.soft,
    ...bundle.inferred,
  ];
}

function classifyLegacyNormalizedConstraints(
  constraints: readonly z.infer<typeof NormalizedConstraintSchema>[],
): ConstraintTierBundle {
  const hard: z.infer<typeof NormalizedConstraintSchema>[] = [];
  const soft: z.infer<typeof NormalizedConstraintSchema>[] = [];
  for (const constraint of constraints) {
    const canonicalConstraint = canonicalizeConstraint(constraint);
    if (isSoftTierConstraint(canonicalConstraint)) {
      soft.push(canonicalConstraint);
      continue;
    }
    hard.push(canonicalConstraint);
  }
  return {
    hard,
    soft,
    inferred: [],
  };
}

export function getCanonicalConstraintTierBundle(
  analysis: Pick<WineSearchAnalysis, 'constraints' | 'normalizedConstraints'>,
): ConstraintTierBundle {
  if (analysis.constraints === undefined) {
    return classifyLegacyNormalizedConstraints(analysis.normalizedConstraints);
  }
  const canonicalCount =
    analysis.constraints.hard.length
    + analysis.constraints.soft.length
    + analysis.constraints.inferred.length;
  if (canonicalCount === 0 && analysis.normalizedConstraints.length > 0) {
    return classifyLegacyNormalizedConstraints(analysis.normalizedConstraints);
  }
  return canonicalizeConstraintTierBundle(analysis.constraints);
}

export function getCanonicalNormalizedConstraints(
  analysis: Pick<WineSearchAnalysis, 'constraints' | 'normalizedConstraints'>,
): readonly z.infer<typeof NormalizedConstraintSchema>[] {
  return flattenConstraintTierBundle(getCanonicalConstraintTierBundle(analysis));
}

// NOTE: The structural assignability check for `NormalizedConstraintSchema`
// vs `NormalizedConstraint` lives next to the schema in
// `@shared/types/constraint-bundle-schema.ts` (SSoT). It is intentionally
// not duplicated here.
