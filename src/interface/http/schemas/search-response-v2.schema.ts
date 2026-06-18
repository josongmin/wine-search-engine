/**
 * V2 Search Response Schemas
 *
 * Versioning matrix:
 * ─────────────────────────────────────────────────────────────────────────────
 * Route                        Response Schema              Consumer
 * ─────────────────────────────────────────────────────────────────────────────
 * POST /v1/search/hybrid       SearchResponseSchema (V1)    Machine + human adapter
 * POST /v1/search/semantic     SearchResponseSchema (V1)    Machine + human adapter
 * POST /v1/search/lexical      SearchResponseSchema (V1)    Machine + human adapter
 * POST /v2/entity-lookup       EntityLookupV2 (4-state)     Machine + human adapter
 * POST /v1/agent*              WineSearchResponseSchema     Agent runtime
 * (Accept: application/vnd.cuvee.human+json on /v1/*)
 *                              SearchResponseV2Human        Human
 * (machine V2)                 SearchResponseV2Machine      Internal executor seam only
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * There are no dedicated V2 URLs. Human V2 stays a content-
 * negotiated projection on the canonical `/v1/*` search surfaces. Machine V2
 * remains an internal `WineToolExecutor` projection rather than a public HTTP
 * contract.
 */

import { z } from 'zod';
import {
  MAX_CLARIFICATION_CANDIDATES,
  MAX_SEARCH_EVIDENCE_ITEMS_PER_RESULT,
  MAX_SEARCH_METADATA_OBJECT_KEYS,
  MAX_SEARCH_RESULTS_PER_RESPONSE,
} from '../constants.js';
import { CANONICAL_AUTHORITY_TRACE_REF_PATTERN } from './search-response.schema.js';
import {
  MIN_PRODUCED_VINTAGE_YEAR,
  MAX_PRODUCED_VINTAGE_YEAR,
} from '../../../domain/shared/constants.js';
import type { InterpretResponseV2 as InterpretResponseV2Contract } from '@app/search/interpret-response.dto.js';

// ---------------------------------------------------------------------------
// V2 shared sub-schemas
// ---------------------------------------------------------------------------

const DrinkingWindowV2Schema = z.object({
  start: z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR).optional(),
  end: z.number().int().min(MIN_PRODUCED_VINTAGE_YEAR).max(MAX_PRODUCED_VINTAGE_YEAR).optional(),
}).strict().refine(
  (w) => w.start === undefined || w.end === undefined || w.start <= w.end,
  'drinking window start must be <= end',
);

const EvidenceItemV2Schema = z.object({
  signal: z.string().min(1),
  value: z.number().finite(),
  weight: z.number().finite(),
}).strict();

const ComponentScoresV2Schema = z.object({
  entityIntegrity: z.number().finite(),
  anchorSimilarity: z.number().finite().optional(),
  semantic: z.number().finite().optional(),
  hardConstraintPass: z.boolean(),
  softConstraint: z.number().finite(),
  attributeAlignment: z.number().finite().optional(),
  preferenceAlignment: z.number().finite().optional(),
  popularity: z.number().finite().optional(),
  availability: z.number().finite().optional(),
  uncertaintyPenalty: z.number().finite(),
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
  closure: z.string().min(1).optional(),
  country: z.string().min(1).optional(),
  vintage: z.number().int().optional(),
  grapePrimary: z.string().min(1).optional(),
  drinkingWindow: DrinkingWindowV2Schema.optional(),
  /** Human-readable explanation of why this result was returned. */
  evidenceSummary: z.string().min(1),
  /** Per-result confidence in [0, 1]. */
  confidence: z.number().finite().min(0).max(1),
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
  comparisonMode: z.enum(['entity', 'concept']).optional(),
  canonicalConcept: z.string().min(1).optional(),
  conceptEntityType: z.enum(['country', 'region', 'appellation', 'grape_primary', 'wine_type']).optional(),
  conceptAggregate: z.object({
    canonicalConcept: z.string().min(1),
    conceptEntityType: z.enum(['country', 'region', 'appellation', 'grape_primary', 'wine_type']),
    representativeResult: ResultItemV2HumanSchema.nullable(),
    prototypeAxis: z.array(ResultItemV2HumanSchema).max(MAX_SEARCH_RESULTS_PER_RESPONSE),
    aggregateResultCount: z.number().int().nonnegative(),
  }).strict().optional(),
  resolutionStatus: z.enum(DECISION_STATUS_V2),
  resultCount: z.number().int().nonnegative(),
  topResult: ResultItemV2HumanSchema.nullable(),
}).strict();

/**
 * Standard ranked-search payload (discriminator {@link queryType} = {@code search}).
 */
const SearchResponseV2HumanSearchSchemaBase = z.object({
  queryId: z.string().min(1),
  queryType: z.literal('search'),
  results: z.array(ResultItemV2HumanSchema).max(MAX_SEARCH_RESULTS_PER_RESPONSE),
  totalCandidates: z.number().int().nonnegative(),
  authorityTraceRef: z.string().regex(CANONICAL_AUTHORITY_TRACE_REF_PATTERN).optional(),
  runtimeCorrelationRef: z.string().min(1).optional(),
  version: z.literal('2'),
  responseType: z.literal('human'),
}).strict();

export const SearchResponseV2HumanSearchSchema = SearchResponseV2HumanSearchSchemaBase.superRefine((value, ctx) => {
  if (
    value.runtimeCorrelationRef !== undefined
    && value.runtimeCorrelationRef !== value.queryId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'runtimeCorrelationRef must equal queryId on V2 human search responses',
      path: ['runtimeCorrelationRef'],
    });
  }
});

/**
 * Decomposed comparison payload (discriminator {@link queryType} = {@code comparison}).
 */
const SearchResponseV2HumanComparisonSchemaBase = z.object({
  queryId: z.string().min(1),
  queryType: z.literal('comparison'),
  originalQuery: z.string().min(1),
  comparisonIntent: z.enum(['compare', 'recommend_one', 'list_both']),
  overallStatus: z.enum(DECISION_STATUS_V2),
  entities: z.tuple([ComparisonEntityV2HumanSchema, ComparisonEntityV2HumanSchema]),
  totalCandidates: z.number().int().nonnegative(),
  authorityTraceRef: z.string().regex(CANONICAL_AUTHORITY_TRACE_REF_PATTERN).optional(),
  runtimeCorrelationRef: z.string().min(1).optional(),
  version: z.literal('2'),
  responseType: z.literal('human'),
}).strict();

export const SearchResponseV2HumanComparisonSchema = SearchResponseV2HumanComparisonSchemaBase.superRefine((value, ctx) => {
  if (
    value.runtimeCorrelationRef !== undefined
    && value.runtimeCorrelationRef !== value.queryId
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'runtimeCorrelationRef must equal queryId on V2 human comparison responses',
      path: ['runtimeCorrelationRef'],
    });
  }
});

/**
 * V2 human-readable search response envelope.
 * Returned by content negotiation on the canonical `/v1/search/*` primitives.
 *
 * Discriminated union: {@code queryType} is {@code search} for normal ranked results,
 * or {@code comparison} for Epic 14 "A vs B" decomposition responses.
 */
export const SearchResponseV2HumanSchema = z.union([
  SearchResponseV2HumanSearchSchema,
  SearchResponseV2HumanComparisonSchema,
]);

// ---------------------------------------------------------------------------
// ResultItemV2Machine
// ---------------------------------------------------------------------------

/**
 * Machine/LLM-optimised result item for V2 machine responses.
 * Exposes full scoring detail for programmatic consumption.
 * Internal executor projection only — not exposed by any public HTTP route.
 */
export const ResultItemV2MachineSchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
  rank: z.number().int().positive(),
  finalScore: z.number().finite(),
  componentScores: ComponentScoresV2Schema,
  evidenceItems: z.array(EvidenceItemV2Schema).max(MAX_SEARCH_EVIDENCE_ITEMS_PER_RESULT),
  retrievalProvenance: z.string().min(1).optional(),
  version: z.literal('2'),
  responseType: z.literal('machine'),
}).strict();

// ---------------------------------------------------------------------------
// SearchResponseV2Machine
// ---------------------------------------------------------------------------

/**
 * V2 machine-optimised search response envelope.
 * Exposed only via the internal `WineToolExecutor` seam, NOT via any
 * public HTTP route.
 */
export const SearchResponseV2MachineSchema = z.object({
  queryId: z.string().min(1),
  results: z.array(ResultItemV2MachineSchema).max(MAX_SEARCH_RESULTS_PER_RESPONSE),
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
 * Retained for internal explain/diagnostic projections; there is no public
 * V2 explain URL.
 */
export const InterpretResponseV2Schema = z.object({
  queryId: z.string().min(1),
  queryText: z.string().min(1),
  /** Query-family label from planner observability (e.g. entity_exact, comparison, pairing). */
  detectedIntent: z.string().min(1),
  /** Decomposition strategy when query was split into sub-queries. */
  decompositionStrategy: z.string().min(1).optional(),
  /** Retrieval channel names that were activated for this query. */
  activeChannels: z.array(z.string().min(1)).max(MAX_CLARIFICATION_CANDIDATES),
  /** Constraint labels that were applied during query planning. */
  appliedConstraints: z.array(z.string().min(1)).max(MAX_SEARCH_METADATA_OBJECT_KEYS),
  /** Ranking signal names that influenced scoring for this query. */
  rankingSignals: z.array(z.string().min(1)).max(MAX_SEARCH_METADATA_OBJECT_KEYS),
  /** Planner confidence in the detected intent, in [0, 1]. Omitted when uncertainty input is invalid. */
  confidence: z.number().finite().min(0).max(1).optional(),
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

/**
 * The interpret/explain V2 contract is OWNED by the application layer
 * (`@app/search/interpret-response.dto.ts`) per DIP. The Zod schema above is
 * the HTTP-boundary runtime validator; the canonical exported TYPE re-exports
 * the application contract so consumers depend on the inward-pointing type.
 *
 * The two `_Assert*` pins below fail `tsc` if the runtime Zod shape and the
 * application contract ever drift in either direction.
 */
export type InterpretResponseV2 = InterpretResponseV2Contract;

type _InferredInterpretResponseV2 = z.infer<typeof InterpretResponseV2Schema>;
type _AssertInterpretInferToContract =
  _InferredInterpretResponseV2 extends InterpretResponseV2Contract ? true : never;
type _AssertInterpretContractToInfer =
  InterpretResponseV2Contract extends _InferredInterpretResponseV2 ? true : never;
const _interpretInferOk: _AssertInterpretInferToContract = true;
const _interpretContractOk: _AssertInterpretContractToInfer = true;
void _interpretInferOk;
void _interpretContractOk;
