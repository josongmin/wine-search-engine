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
  type NormalizedConstraint,
} from '@shared/types/index.js';
import {
  MAX_PRODUCED_VINTAGE_YEAR,
  MIN_PRODUCED_VINTAGE_YEAR,
} from '@shared/constants.js';

// Re-export the canonical schema + interface so existing callers of
// `@app/wine-search/wine-search-schemas.js` keep working unchanged. The SSoT
// for `NormalizedConstraintSchema` now lives in `@shared/types`; this file
// continues to expose it under its historical import path.
export { NormalizedConstraintSchema };
export type { NormalizedConstraint };

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

/** Comparison legs: at least 2 (binary comparison), capped at 4 — beyond 4
 *  legs decomposition quality collapses and the orchestrator falls back to
 *  flat search. */
export const WINE_SEARCH_DECOMPOSITION_MIN_LEGS = 2;
export const WINE_SEARCH_DECOMPOSITION_MAX_LEGS = 4;

/** Parallel-slot bounds (e.g. "appetizer + main + dessert" pairing). */
export const WINE_SEARCH_PARALLEL_SLOT_MIN_LIMIT = 1;
export const WINE_SEARCH_PARALLEL_SLOT_MAX_LIMIT = 10;

/** Vintage-year bounds — re-exported from the shared SSoT in
 *  `@shared/constants` (MIN/MAX_PRODUCED_VINTAGE_YEAR). Re-exposed under the
 *  WINE_SEARCH_* prefix so consumers do not need a second import to wire up
 *  the contract. */
export const WINE_SEARCH_MIN_VINTAGE_YEAR = MIN_PRODUCED_VINTAGE_YEAR;
export const WINE_SEARCH_MAX_VINTAGE_YEAR = MAX_PRODUCED_VINTAGE_YEAR;

export const QueryIntentSchema = z.enum([
  'search',
  'compare',
  'pair',
  'drinkability',
  'unknown',
]);
export type QueryIntent = z.infer<typeof QueryIntentSchema>;

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

export const ComparisonLegSchema = z.object({
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

export const RecommendedBudgetSchema = z.object({
  maxSteps: z.number().int()
    .min(WINE_SEARCH_BUDGET_MIN_STEPS)
    .max(WINE_SEARCH_BUDGET_MAX_STEPS),
  perToolCap: z.number().int()
    .min(WINE_SEARCH_MIN_PER_TOOL_CAP)
    .max(WINE_SEARCH_MAX_PER_TOOL_CAP),
}).strict();
export type RecommendedBudget = z.infer<typeof RecommendedBudgetSchema>;

export const WineSearchAnalysisSchema = z.object({
  intent: QueryIntentSchema,
  anchors: z.array(AnchorResolutionSchema).max(WINE_SEARCH_MAX_ANCHORS),
  normalizedConstraints: z.array(NormalizedConstraintSchema).max(WINE_SEARCH_MAX_CONSTRAINTS),
  decomposition: DecompositionSchema.optional(),
  contract: AnalysisContractSchema,
  expectedMultiStep: z.boolean(),
  recommendedBudget: RecommendedBudgetSchema,
  hangulDominant: z.boolean(),
  preservedSurface: z.string().max(WINE_SEARCH_MAX_QUERY_CHARS),
}).strict();
export type WineSearchAnalysis = z.infer<typeof WineSearchAnalysisSchema>;

// NOTE: The structural assignability check for `NormalizedConstraintSchema`
// vs `NormalizedConstraint` lives next to the schema in
// `@shared/types/constraint-bundle-schema.ts` (SSoT). It is intentionally
// not duplicated here.
