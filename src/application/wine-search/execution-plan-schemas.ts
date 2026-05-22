/**
 * Wine search execution-plan schemas.
 *
 * Plan-then-Execute produces a typed `ExecutionPlan` from a
 * `WineSearchAnalysis` and feeds it to an `ExecutionRunner`. This module
 * defines the discriminated-union plan shape and the matching Zod schema.
 *
 * Why a Zod schema for an internal-only union?
 *  - It enforces the same `.strict()` invariants we apply to HTTP-facing
 *    schemas (CLAUDE.md rule 10).
 *  - It doubles as runtime documentation: a router producing a malformed
 *    plan fails fast at the executor boundary instead of corrupting deep
 *    downstream state.
 *  - Numeric inputs that flow through (per-step timeouts, slot budgets)
 *    have `.finite()` guards so NaN cannot poison `Promise.race`.
 *
 * Source-of-truth for input/leg/slot shapes is `wine-search-schemas.ts`.
 * The plan re-uses those typed pieces directly — we never duplicate the
 * `NormalizedConstraint` field set here.
 */

import { z } from 'zod';
import {
  AnalysisContractSchema,
  ComparisonLegSchema,
  NormalizedConstraintSchema,
  ParallelSlotSchema,
  RecommendedBudgetSchema,
  WINE_SEARCH_MAX_ANCHORS,
  WINE_SEARCH_MAX_CONSTRAINTS,
  WINE_SEARCH_MAX_QUERY_CHARS,
  WINE_SEARCH_MIN_VINTAGE_YEAR,
  WINE_SEARCH_MAX_VINTAGE_YEAR,
} from './wine-search-schemas.js';

// ---------------------------------------------------------------------------
// Domain-justified numeric constants (CLAUDE.md rule 15)
// ---------------------------------------------------------------------------

/** Lower bound for parallel-search slots — below this we use a single search. */
const DETERMINISTIC_ROUTER_MIN_SLOTS = 2;
/** Upper bound aligned with `WINE_SEARCH_DECOMPOSITION_MAX_LEGS` (4). Beyond
 *  this the decomposition quality collapses and the runner would oversubscribe
 *  the downstream Vespa worker pool. */
const DETERMINISTIC_ROUTER_MAX_SLOTS = 4;
/** Maximum number of drinkability-template anchor IDs we'll fan out. Aligns
 *  with `WINE_SEARCH_MAX_ANCHORS` (8). */
export const DETERMINISTIC_ROUTER_MAX_DRINKABILITY_ANCHORS = WINE_SEARCH_MAX_ANCHORS;
/** Default per-step timeout when the caller does not provide one. Matches
 *  the search-tool default in `agent-tool-execution-support.ts`. */
export const DETERMINISTIC_ROUTER_DEFAULT_PER_STEP_TIMEOUT_MS = 8_000;
/** Maximum per-step timeout. Bounded so a runaway analysis cannot pin a
 *  worker forever — matches the parallel-batch timeout in
 *  `agent-tool-execution-support.ts`. */

// ---------------------------------------------------------------------------
// SearchUseCaseInput — the slice of `SearchRequest` the planner emits.
//
// We do NOT mirror the entire `SearchRequest` interface because the planner
// has no business choosing context/session/queryBudget — those are caller
// concerns supplied at runner-construction time. We expose only the fields
// the analysis genuinely determines: query, filters, preferences, mode hint,
// limit, and the representative-concept marker for comparison legs.
// ---------------------------------------------------------------------------

const ExecutionSearchModeSchema = z.enum([
  'auto',
  'entity',
  'hybrid',
  'mixed',
]);

const RepresentativeConceptSchema = z.object({
  field: z.enum(['country', 'region', 'appellation', 'grape_primary', 'wine_type']),
  value: z.string().min(1).max(WINE_SEARCH_MAX_QUERY_CHARS),
}).strict();

/** Soft cap on result-set size requested from a single SearchUseCase call.
 *  Aligned with `WINE_SEARCH_PARALLEL_SLOT_MAX_LIMIT` (10). */
const EXECUTION_PLAN_MAX_LIMIT = 100;

export const SearchUseCaseInputSchema = z.object({
  query: z.string().min(1).max(WINE_SEARCH_MAX_QUERY_CHARS),
  filters: z.array(NormalizedConstraintSchema)
    .max(WINE_SEARCH_MAX_CONSTRAINTS)
    .optional(),
  preferences: z.array(NormalizedConstraintSchema)
    .max(WINE_SEARCH_MAX_CONSTRAINTS)
    .optional(),
  mode: ExecutionSearchModeSchema.optional(),
  limit: z.number().int().finite().min(1).max(EXECUTION_PLAN_MAX_LIMIT).optional(),
  representativeConcept: RepresentativeConceptSchema.optional(),
}).strict();
export type SearchUseCaseInput = z.infer<typeof SearchUseCaseInputSchema>;

// ---------------------------------------------------------------------------
// ComparisonUseCaseInput — feeds DecomposedSearchUseCase.execute(...) via the
// runner. We expose only the structurally minimal fields (two legs +
// optional shared filters/preferences) and let the runner translate to the
// underlying call signature.
// ---------------------------------------------------------------------------

const ComparisonIntentSchema = z.enum([
  'compare',
  'recommend_one',
  'list_both',
]);

export const ComparisonUseCaseInputSchema = z.object({
  originalQuery: z.string().min(1).max(WINE_SEARCH_MAX_QUERY_CHARS),
  intent: ComparisonIntentSchema,
  legs: z.tuple([ComparisonLegSchema, ComparisonLegSchema]),
  sharedFilters: z.array(NormalizedConstraintSchema)
    .max(WINE_SEARCH_MAX_CONSTRAINTS)
    .optional(),
  sharedPreferences: z.array(NormalizedConstraintSchema)
    .max(WINE_SEARCH_MAX_CONSTRAINTS)
    .optional(),
}).strict();
export type ComparisonUseCaseInput = z.infer<typeof ComparisonUseCaseInputSchema>;

// ---------------------------------------------------------------------------
// FoodPairingUseCaseInput — the analysis-driven shape we pass into the
// pairing tool. The pairing branch currently lives inside `agent-tools.ts`;
// the runner adapts this shape to the underlying call.
//
// NOTE: see agent-tools.ts:1883-1958 (the `get_food_pairings` case) for the
// full enrichment pipeline (style/tag observation hints). Porting that
// observation-string builder into a standalone use case is a follow-up
// task — this plan only carries the structured input.
// ---------------------------------------------------------------------------

export const PairingColorSchema = z.enum(['red', 'white', 'rosé', 'sparkling', 'both']);
export type PairingColor = z.infer<typeof PairingColorSchema>;

/** Hard upper bound for KRW budgets — matches MAX_PRICE_KRW_BOUND on the
 *  agent side. Re-declared because importing from the agent layer would
 *  couple wine-search to agent internals. The arithmetic agreement is
 *  guarded by Zod parse failure if either side raises its cap. */
const FOOD_PAIRING_MAX_PRICE_KRW = 10_000_000;
const FOOD_PAIRING_MAX_TAGS = 16;
const FOOD_PAIRING_MAX_STYLES = 16;

export const FoodPairingUseCaseInputSchema = z.object({
  food: z.string().min(1).max(WINE_SEARCH_MAX_QUERY_CHARS),
  color: PairingColorSchema.optional(),
  styles: z.array(z.string().min(1).max(WINE_SEARCH_MAX_QUERY_CHARS))
    .max(FOOD_PAIRING_MAX_STYLES)
    .optional(),
  pairingTags: z.array(z.string().min(1).max(WINE_SEARCH_MAX_QUERY_CHARS))
    .max(FOOD_PAIRING_MAX_TAGS)
    .optional(),
  maxPriceKrw: z.number().int().finite().min(1).max(FOOD_PAIRING_MAX_PRICE_KRW).optional(),
}).strict();
export type FoodPairingUseCaseInput = z.infer<typeof FoodPairingUseCaseInputSchema>;

// ---------------------------------------------------------------------------
// Drinkability-template — describes how the runner builds
// `check_drinking_window` calls from search results.
// ---------------------------------------------------------------------------

const DrinkabilityTemplateSchema = z.object({
  /** Year to evaluate the drinking window against. */
  targetYear: z.number().int().finite()
    .min(WINE_SEARCH_MIN_VINTAGE_YEAR)
    .max(WINE_SEARCH_MAX_VINTAGE_YEAR),
  /** Max results from the upstream search to probe. Bounded so a wide search
   *  doesn't cause a fan-out of drinkability checks. */
  maxAnchors: z.number().int().finite()
    .min(1)
    .max(DETERMINISTIC_ROUTER_MAX_DRINKABILITY_ANCHORS),
}).strict();

// ---------------------------------------------------------------------------
// Multi-step handoff — describes a plan we hand off to the MiniLoop
// orchestrator. The MiniLoop is implemented separately (see
// follow-up RFC); the router only emits the contract.
// ---------------------------------------------------------------------------

const MultiStepInitialActionSchema = z.enum(['search', 'compare', 'pair']);

export const MultiStepHandoffSchema = z.object({
  initialAction: MultiStepInitialActionSchema,
  budget: RecommendedBudgetSchema,
  contract: AnalysisContractSchema,
  seedSearchInput: SearchUseCaseInputSchema,
}).strict();
export type MultiStepHandoff = z.infer<typeof MultiStepHandoffSchema>;

// ---------------------------------------------------------------------------
// Reject reasons
// ---------------------------------------------------------------------------

export const PlanRejectReasonSchema = z.enum([
  'analysis_rejected',
  'unsupported_intent',
]);
export type PlanRejectReason = z.infer<typeof PlanRejectReasonSchema>;

// ---------------------------------------------------------------------------
// ExecutionPlan — discriminated union
// ---------------------------------------------------------------------------

export const ExecutionPlanSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('single-search'),
    searchInput: SearchUseCaseInputSchema,
  }).strict(),
  z.object({
    kind: z.literal('parallel-search'),
    searches: z.array(SearchUseCaseInputSchema)
      .min(DETERMINISTIC_ROUTER_MIN_SLOTS)
      .max(DETERMINISTIC_ROUTER_MAX_SLOTS),
    slotHints: z.array(ParallelSlotSchema)
      .min(DETERMINISTIC_ROUTER_MIN_SLOTS)
      .max(DETERMINISTIC_ROUTER_MAX_SLOTS)
      .optional(),
  }).strict(),
  z.object({
    kind: z.literal('comparison'),
    comparisonInput: ComparisonUseCaseInputSchema,
  }).strict(),
  z.object({
    kind: z.literal('food-pairing-then-search'),
    pairingInput: FoodPairingUseCaseInputSchema,
    searchInput: SearchUseCaseInputSchema,
  }).strict(),
  z.object({
    kind: z.literal('search-then-drinkability'),
    searchInput: SearchUseCaseInputSchema,
    drinkabilityTemplate: DrinkabilityTemplateSchema,
  }).strict(),
  z.object({
    kind: z.literal('multi-step'),
    handoff: MultiStepHandoffSchema,
  }).strict(),
  z.object({
    kind: z.literal('reject'),
    reason: PlanRejectReasonSchema,
  }).strict(),
]);
export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

// ---------------------------------------------------------------------------
// Convenience type narrows (callers use these instead of inline `kind ===`)
// ---------------------------------------------------------------------------

