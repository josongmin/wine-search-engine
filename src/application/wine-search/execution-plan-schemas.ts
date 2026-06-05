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
import { isSourceRecordStylePublicEntityId } from '../../domain/shared/constants/public-entity-id-namespace.js';
import { SIMILAR_TO_ENTITY_ENTITY_ID_MAX_LEN } from '../search/reference-similarity-execution.js';
import {
  AnalysisContractSchema,
  NormalizedConstraintSchema,
  ParallelSlotSchema,
  RecommendedBudgetSchema,
  WineSearchCallerInterpretationSchema,
  WINE_SEARCH_MAX_CONSTRAINTS,
  WINE_SEARCH_MAX_QUERY_CHARS,
  WINE_SEARCH_MAX_RETRIEVAL_K,
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
 *  Sourced from {@link WINE_SEARCH_MAX_RETRIEVAL_K} so the analyzer-emitted
 *  adaptive retrieval k (up to 500 for `exploratory` intent — SSoT
 *  `RETRIEVAL_K_BY_INTENT` in `adaptive-budget.ts`) can flow through to the
 *  use case `limit` arg without being clamped. Centralizing the ceiling
 *  in {@link wine-search-schemas.ts} avoids the silent parse-failure mode
 *  where one module raises the cap and the other rejects the wider value
 *  (CLAUDE.md rule 30). The HTTP-facing response cap
 *  (`MAX_SEARCH_RESULTS_PER_RESPONSE` = 200) still bounds the user-visible
 *  result set; the plan-level `limit` controls the candidate pool size used
 *  by the downstream reranker, which can legitimately exceed the response
 *  cap. */
const EXECUTION_PLAN_MAX_LIMIT = WINE_SEARCH_MAX_RETRIEVAL_K;

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
  callerInterpretation: WineSearchCallerInterpretationSchema.optional(),
  /**
   * T-IR-05: retrieval-lane discriminator set by the primitive agent tools
   * (`search_hybrid` / `search_semantic` / `search_lexical`). Mirrors the
   * HTTP-side `SearchRequest.retrievalLane` so the agent tool path and the
   * `/v1/search/{...}` HTTP path drive the SAME candidate-pool channel
   * gating. The `SearchUseCaseAdapter` forwards it onto the `SearchRequest`.
   * Absent → full hybrid channel mix.
   */
  retrievalLane: z.enum(['hybrid', 'semantic_only', 'lexical_only']).optional(),
  /**
   * RFC-021 T-PSA-02: resolved canonical anchor entity for the
   * `similar_to_entity` reference-similarity primitive. When present, the
   * `SearchUseCaseAdapter` maps it onto a path-authoritative
   * `SearchRequest.anchorEntityId` + `primitiveRoute='similar_to_entity'`, so
   * the deterministic mixed/anchor-similarity plan executes. This — not
   * `query` — is the similarity anchor authority; the agent MUST copy it from a
   * prior `lookup_wine` result, never guess it.
   */
  anchorEntityId: z
    .string()
    .min(1)
    .max(SIMILAR_TO_ENTITY_ENTITY_ID_MAX_LEN)
    // Defense-in-depth (RFC-021 T-PSA-04 audit C2): the shared schema EVERY
    // caller funnels through rejects a source-record (vivino-) anchor, so the
    // adapter's `createCanonicalEntityId(anchorEntityId)` is provably total and
    // can never throw at the use-case seam.
    .refine((value) => !isSourceRecordStylePublicEntityId(value), {
      message: 'anchorEntityId must be a canonical public id, not a source-record (vivino-) id.',
    })
    .optional(),
}).strict();
export type SearchUseCaseInput = z.infer<typeof SearchUseCaseInputSchema>;


// ---------------------------------------------------------------------------
// Multi-step handoff — describes a plan we hand off to the WineAgentLoop
// orchestrator. The WineAgentLoop is implemented separately (see
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
  /**
   * F-FailClosed: the plan requires a tool the operator has disabled via
   * `WINE_SEARCH_DISABLED_TOOLS`. ExecutionRunner returns this rather
   * than dispatching a known-broken tool — keeps the bench rubric clean
   * (no half-baked compare/pair/drinkability outputs).
   */
  'tool_unavailable',
  /**
   * Move 2 (honest failure propagation): the query had no deterministic
   * signal (intent=unknown, no anchors/constraints) AND the analyzer's LLM
   * fallback was ATTEMPTED and FAILED (provider down / malformed output —
   * see `WineSearchAnalysis.llmFallbackOutcome`). Distinct from
   * `unsupported_intent` (a genuinely out-of-scope query) so the synthesizer
   * renders an honest "AI analysis temporarily unavailable" message instead
   * of blaming the user's query. Maps to degradedReason `llm_unavailable`.
   */
  'analysis_unavailable',
]);
export type PlanRejectReason = z.infer<typeof PlanRejectReasonSchema>;

// ---------------------------------------------------------------------------
// ExecutionPlanKind — SSoT for the discriminated-union `kind` field.
//
// This tuple is the single source of truth (CLAUDE.md rule 30) for the set
// of valid plan kinds. Every downstream caller — the router (which emits
// plans), the runner (which dispatches via `switch (plan.kind)`), the
// orchestrator (which inspects `plan.kind` for branching), and tests —
// must import either `EXECUTION_PLAN_KINDS` (for runtime iteration) or
// `ExecutionPlanKind` (for type narrowing), never re-spell the string
// literals. Previously these literals appeared in 4+ files and would drift
// silently when a new plan kind was added in one place but not another.
//
// `as const` keeps the literal type information so
// `typeof EXECUTION_PLAN_KINDS[number]` collapses to the exact union of
// every literal in the tuple below. (Narrowed from 7 → 4 kinds in the
// heuristic-tool purge, 2026-05; drinkability, single/parallel-step, and
// fan-in kinds were consolidated into `single-search` / `parallel-search`
// / `multi-step` with the WineAgentLoop orchestrator.)
//
// NOTE: order is load-bearing for `z.enum` — Zod surfaces the first entry
// as the default in error messages. We list `single-search` first because
// it is the 80% happy-path plan kind (see deterministic-router.ts rule 7).
// ---------------------------------------------------------------------------

export const EXECUTION_PLAN_KINDS = [
  'single-search',
  'parallel-search',
  'multi-step',
  'reject',
] as const;
export type ExecutionPlanKind = typeof EXECUTION_PLAN_KINDS[number];

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
// Compile-time SSoT parity guard
//
// If `ExecutionPlanKind` (the SSoT tuple) and `ExecutionPlan['kind']` (the
// Zod-inferred union) ever diverge — e.g. a new branch is added to the Zod
// union but not to `EXECUTION_PLAN_KINDS`, or vice versa — these two
// `Equals<>` checks fail at `tsc` time. This makes the SSoT invariant
// type-system-enforced; no runtime test is needed for the "both shapes
// agree" property (we still keep a runtime regression for the membership /
// arity property under `__tests__/`).
// ---------------------------------------------------------------------------

// The canonical "type-level equality" trick: two types are equal iff a
// generic function returning `T extends X ? 1 : 2` is assignable in both
// directions. The phantom type parameter `T` is intentionally used only
// inside the conditional — silence the lint rule that flags single-use
// generics, since removing the phantom breaks the trick.
type _AssertEqual<A, B> =
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  (<T>() => T extends A ? 1 : 2) extends
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  (<T>() => T extends B ? 1 : 2) ? true : false;

// Forces a compile error if SSoT tuple and Zod union diverge.
type _ExecutionPlanKindParityCheck =
  _AssertEqual<ExecutionPlanKind, ExecutionPlan['kind']> extends true ? true : never;
// Reference the alias so it is not stripped as unused.
export type __ExecutionPlanKindParityProof = _ExecutionPlanKindParityCheck;

// ---------------------------------------------------------------------------
// Convenience type narrows (callers use these instead of inline `kind ===`)
// ---------------------------------------------------------------------------
