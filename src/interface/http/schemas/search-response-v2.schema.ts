/**
 * V2 Search Response Schemas
 *
 * Versioning matrix:
 * ─────────────────────────────────────────────────────────────────────────────
 * Route                        Response Schema              Consumer
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /v1/search              SearchResponseSchema (V1)    Human + adapter
 * POST /v1/search/hybrid       SearchResponseSchema (V1)    Human + adapter
 * POST /v1/search/interpret    InterpretResponseSchema (V1) Human + adapter
 * POST /v1/entity/resolve      ResolveResponseSchema (V1)   Human + adapter
 * POST /v1/batch-search        BatchSearchResponseSchema     Human + adapter
 * POST /v1/search/replay       SearchResponseSchema (V1)    Human + adapter
 * GET|POST /v1/claude-tools    WineToolExecutor result      Machine / LLM
 *
 * POST /v2/search              SearchResponseV2Human        Human
 * POST /v2/search/hybrid       SearchResponseV2Human        Human
 * POST /v2/search/interpret    InterpretResponseV2          Human
 * (machine V2)                 SearchResponseV2Machine      Via /v1/claude-tools seam only
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * V1 contracts are maintained until post-Wave-3 deprecation.
 * Machine V2 is not exposed via /v2/search/* — LLM consumers continue to use
 * the /v1/claude-tools seam, which the WineToolExecutor will wrap with V2
 * machine response projection when ready (T6.5+).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// V2 shared sub-schemas
// ---------------------------------------------------------------------------

const DrinkingWindowV2Schema = z.object({
  start: z.number().int().optional(),
  end: z.number().int().optional(),
}).strict();

const EvidenceItemV2Schema = z.object({
  signal: z.string().min(1),
  value: z.number(),
  weight: z.number(),
}).strict();

const ComponentScoresV2Schema = z.object({
  entityIntegrity: z.number(),
  anchorSimilarity: z.number().optional(),
  semantic: z.number(),
  hardConstraintPass: z.boolean(),
  softConstraint: z.number(),
  attributeAlignment: z.number(),
  preferenceAlignment: z.number(),
  popularity: z.number(),
  availability: z.number(),
  uncertaintyPenalty: z.number(),
}).strict();

// ---------------------------------------------------------------------------
// ResultItemV2Human
// ---------------------------------------------------------------------------

/**
 * Human-readable result card for V2 search responses.
 * Flattened projection of the internal RankedResult / ResultItem —
 * omits internal signal details in favour of readable summary fields.
 */
export const ResultItemV2HumanSchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
  rank: z.number().int().positive(),
  producer: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  vintage: z.number().int().optional(),
  grapePrimary: z.string().min(1).optional(),
  drinkingWindow: DrinkingWindowV2Schema.optional(),
  /** Human-readable explanation of why this result was returned. */
  evidenceSummary: z.string().min(1),
  /** Per-result confidence in [0, 1]. */
  confidence: z.number().min(0).max(1),
  version: z.literal('2'),
  responseType: z.literal('human'),
}).strict();

// ---------------------------------------------------------------------------
// SearchResponseV2Human
// ---------------------------------------------------------------------------

const DECISION_STATUS_V2 = ['resolved', 'ambiguous', 'failed'] as const;

/**
 * One side of an "A vs B" comparison in the human V2 envelope.
 */
export const ComparisonEntityV2HumanSchema = z.object({
  subQuery: z.string().min(1),
  resolutionStatus: z.enum(DECISION_STATUS_V2),
  resultCount: z.number().int().nonnegative(),
  topResult: ResultItemV2HumanSchema.nullable(),
}).strict();

/**
 * Standard ranked-search payload (discriminator {@link queryType} = {@code search}).
 */
export const SearchResponseV2HumanSearchSchema = z.object({
  queryId: z.string().min(1),
  queryType: z.literal('search'),
  results: z.array(ResultItemV2HumanSchema),
  totalCandidates: z.number().int().nonnegative(),
  version: z.literal('2'),
  responseType: z.literal('human'),
}).strict();

/**
 * Decomposed comparison payload (discriminator {@link queryType} = {@code comparison}).
 */
export const SearchResponseV2HumanComparisonSchema = z.object({
  queryId: z.string().min(1),
  queryType: z.literal('comparison'),
  originalQuery: z.string().min(1),
  comparisonIntent: z.enum(['compare', 'recommend_one', 'list_both']),
  overallStatus: z.enum(DECISION_STATUS_V2),
  entities: z.tuple([ComparisonEntityV2HumanSchema, ComparisonEntityV2HumanSchema]),
  totalCandidates: z.number().int().nonnegative(),
  version: z.literal('2'),
  responseType: z.literal('human'),
}).strict();

/**
 * V2 human-readable search response envelope.
 * Returned by POST /v2/search and POST /v2/search/hybrid.
 *
 * Discriminated union: {@code queryType} is {@code search} for normal ranked results,
 * or {@code comparison} for Epic 14 "A vs B" decomposition responses.
 */
export const SearchResponseV2HumanSchema = z.discriminatedUnion('queryType', [
  SearchResponseV2HumanSearchSchema,
  SearchResponseV2HumanComparisonSchema,
]);

// ---------------------------------------------------------------------------
// ResultItemV2Machine
// ---------------------------------------------------------------------------

/**
 * Machine/LLM-optimised result item for V2 machine responses.
 * Exposes full scoring detail for programmatic consumption.
 * NOT returned via /v2/search/* — only via the /v1/claude-tools seam.
 */
export const ResultItemV2MachineSchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
  rank: z.number().int().positive(),
  finalScore: z.number(),
  componentScores: ComponentScoresV2Schema,
  evidenceItems: z.array(EvidenceItemV2Schema),
  retrievalProvenance: z.string().min(1).optional(),
  version: z.literal('2'),
  responseType: z.literal('machine'),
}).strict();

// ---------------------------------------------------------------------------
// SearchResponseV2Machine
// ---------------------------------------------------------------------------

/**
 * V2 machine-optimised search response envelope.
 * Exposed only via the /v1/claude-tools seam (WineToolExecutor), NOT via
 * any /v2/search/* route. Handler wiring deferred to T6.5.
 */
export const SearchResponseV2MachineSchema = z.object({
  queryId: z.string().min(1),
  results: z.array(ResultItemV2MachineSchema),
  version: z.literal('2'),
  responseType: z.literal('machine'),
}).strict();

// ---------------------------------------------------------------------------
// InterpretResponseV2
// ---------------------------------------------------------------------------

/**
 * V2 interpret/explain contract.
 *
 * This is an explain contract — it surfaces what the planner detected and
 * which signals/channels were activated. It is NOT a planner internals dump.
 * Returned by POST /v2/search/interpret.
 */
export const InterpretResponseV2Schema = z.object({
  queryId: z.string().min(1),
  queryText: z.string().min(1),
  /** Query-family label from planner observability (e.g. entity_exact, comparison, pairing). */
  detectedIntent: z.string().min(1),
  /** Decomposition strategy when query was split into sub-queries. */
  decompositionStrategy: z.string().min(1).optional(),
  /** Retrieval channel names that were activated for this query. */
  activeChannels: z.array(z.string().min(1)),
  /** Constraint labels that were applied during query planning. */
  appliedConstraints: z.array(z.string().min(1)),
  /** Ranking signal names that influenced scoring for this query. */
  rankingSignals: z.array(z.string().min(1)),
  /** Planner confidence in the detected intent, in [0, 1]. */
  confidence: z.number().min(0).max(1),
  version: z.literal('2'),
  responseType: z.literal('interpret'),
}).strict();

// ---------------------------------------------------------------------------
// Exported types (inferred from Zod schemas)
// ---------------------------------------------------------------------------

export type ResultItemV2Human = z.infer<typeof ResultItemV2HumanSchema>;
export type ComparisonEntityV2Human = z.infer<typeof ComparisonEntityV2HumanSchema>;
export type SearchResponseV2HumanSearch = z.infer<typeof SearchResponseV2HumanSearchSchema>;
export type SearchResponseV2HumanComparison = z.infer<typeof SearchResponseV2HumanComparisonSchema>;
export type SearchResponseV2Human = z.infer<typeof SearchResponseV2HumanSchema>;
export type ResultItemV2Machine = z.infer<typeof ResultItemV2MachineSchema>;
export type SearchResponseV2Machine = z.infer<typeof SearchResponseV2MachineSchema>;
export type InterpretResponseV2 = z.infer<typeof InterpretResponseV2Schema>;
