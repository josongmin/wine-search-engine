import { z } from 'zod';
import {
  DecisionSnapshotSchema,
  QueryBudgetSchema,
  SessionContextSchema,
} from './search-shared.schema.js';

export const ErrorResponseSchema = z.object({
  error: z.object({
    request_id: z.string(),
    code: z.string(),
    message: z.string(),
    failure_reason: z.string().nullable(),
    retryable: z.boolean(),
  }).strict(),
}).strict();

export type ErrorResponseBody = z.infer<typeof ErrorResponseSchema>;

export const EvidenceItemSchema = z.object({
  type: z.string().min(1),
  source: z.string().min(1),
  contribution: z.string().min(1),
  strength: z.enum(['low', 'medium', 'high']),
  provenance: z.string().min(1),
  metadata: z.record(z.unknown()).optional(),
}).strict();

export const EntitySummarySchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
  type: z.string().min(1),
  producer: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
  vintage: z.number().int().optional(),
  grapes: z.array(z.string().min(1)).optional(),
  priceRange: z.string().min(1).optional(),
}).strict();

export const MatchDetailSchema = z.object({
  matchType: z.enum(['exact', 'alias_exact', 'alias_fuzzy', 'semantic', 'hybrid']),
  anchorUsed: z.boolean().optional(),
  matchedAlias: z.string().min(1).optional(),
  scoreComponents: z.object({
    lexical: z.number(),
    semantic: z.number(),
    attribute: z.number(),
    popularity: z.number(),
    preferenceAlignment: z.number(),
  }).strict(),
}).strict();

export const ConstraintEvaluationSchema = z.object({
  matched: z.array(z.string()),
  unmet: z.array(z.string()),
  inferred: z.array(z.string()),
}).strict();

export const UncertaintyBlockSchema = z.object({
  uncertaintyConfidence: z.number(),
  missingInfo: z.array(z.string()),
  approximationUsed: z.boolean(),
  ambiguityFlags: z.array(z.string()).optional(),
}).strict();

export const DrinkingWindowSchema = z.object({
  drinkingWindowStart: z.number().int(),
  drinkingWindowEnd: z.number().int(),
  currentlyDrinkable: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  modelVersion: z.string().min(1).optional(),
}).strict();

export const ResultItemSchema = z.object({
  entity: EntitySummarySchema,
  relevanceScore: z.number(),
  match: MatchDetailSchema,
  constraints: ConstraintEvaluationSchema,
  uncertainty: UncertaintyBlockSchema,
  evidenceItems: z.array(EvidenceItemSchema).min(1),
  humanReadableEvidenceSummary: z.string().min(1).optional(),
  drinkingWindow: DrinkingWindowSchema.optional(),
  matchReasons: z.array(z.string()).optional(),
  violatedConstraints: z.array(z.string()).optional(),
}).strict();

export const ClarificationCandidateSchema = z.object({
  entityId: z.string().min(1),
  label: z.string().min(1),
  distinguishingFeatures: z.array(z.string()),
}).strict();

export const ClarificationPayloadSchema = z.object({
  reason: z.string().min(1),
  candidates: z.array(ClarificationCandidateSchema),
  suggestionType: z.enum(['disambiguation', 'missing_info']),
}).strict();

export const CounterfactualRejectSchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1).optional(),
  rejectedReason: z.string().min(1),
  evidenceRef: z.string().min(1).optional(),
}).strict();

export const EngineDecisionSchema = z.object({
  decisionStatus: z.enum(['resolved', 'ambiguous', 'failed']),
  nextAction: z.enum(['return_result', 'clarify', 'hybrid_search', 'fail']),
  route: z.string().min(1),
  decisionConfidence: z.number().min(0).max(1),
  confidenceSemantics: z.literal('calibrated_decision_confidence'),
  decisionTraceRef: z.string().min(1),
  decisionSnapshot: DecisionSnapshotSchema,
  failure_reason: z.string().optional(),
  admission_trace_ref: z.string().optional(),
  abstainReason: z.string().optional(),
}).strict();

export const ParsedConstraintsExternSchema = z.object({
  hard: z.array(z.object({
    field: z.string().min(1),
    op: z.string().min(1),
    value: z.string(),
  }).strict()),
  soft: z.array(z.object({
    field: z.string().min(1),
    op: z.string().min(1),
    value: z.string(),
  }).strict()),
  unparsed: z.array(z.string()),
}).strict();

export const SearchResponseMetaSchema = z.object({
  requestId: z.string().min(1).optional(),
  queryTimeMs: z.number().min(0),
  route: z.string().min(1),
  version: z.string().min(1),
  engine_schema_version: z.literal('search_response_v1'),
  decisionSnapshot: DecisionSnapshotSchema.optional(),
  debugRefs: z.array(z.string()).optional(),
  response_hash: z.string().min(1).optional(),
}).strict();

export const SearchResponseSchema = z.object({
  queryType: z.literal('search'),
  engineDecision: EngineDecisionSchema,
  results: z.array(ResultItemSchema),
  counterfactuals: z.array(CounterfactualRejectSchema).optional(),
  clarification: ClarificationPayloadSchema.nullable().optional(),
  meta: SearchResponseMetaSchema,
  retrievalMode: z.enum([
    'entity_lookup',
    'attribute_search',
    'similar_items',
    'entity_resolution',
    'constraint_filter',
    'producer_browse',
    'region_browse',
    'compare_candidates',
    'recommendation',
    'no_match_detection',
  ]).optional(),
  resultType: z.enum([
    'single_entity',
    'entity_set',
    'comparison',
    'no_match',
    'producer_set',
    'region_set',
    'style_set',
    'wine_set',
  ]).optional(),
  parsedConstraints: ParsedConstraintsExternSchema.optional(),
}).strict();

export type SearchResponseBody = z.infer<typeof SearchResponseSchema>;

export const ComparisonEntitySchema = z.object({
  subQuery: z.string().min(1),
  topResult: ResultItemSchema.nullable(),
  resultCount: z.number().int().nonnegative(),
  resolutionStatus: z.enum(['resolved', 'ambiguous', 'failed']),
  allResults: z.array(ResultItemSchema),
}).strict();

export const ComparisonSearchResponseSchema = z.object({
  queryType: z.literal('comparison'),
  originalQuery: z.string().min(1),
  comparisonIntent: z.enum(['compare', 'recommend_one', 'list_both']),
  entities: z.tuple([ComparisonEntitySchema, ComparisonEntitySchema]),
  overallStatus: z.enum(['resolved', 'ambiguous', 'failed']),
  requestId: z.string().min(1),
  executionTimeMs: z.number().min(0),
}).strict();

export type ComparisonSearchResponseBody = z.infer<typeof ComparisonSearchResponseSchema>;

const NormalizedQueryViewsSchema = z.object({
  raw: z.string().min(1),
  strict: z.string().min(1),
  accentless: z.string().min(1),
  collapsedWhitespace: z.string().min(1),
  punctuationStripped: z.string().min(1),
  compact: z.string().min(1),
  vintageCanonicalized: z.string().min(1),
  vintageStripped: z.string().min(1),
  transliterated: z.string().min(1).optional(),
  lookupVariants: z.array(z.string().min(1)),
}).strict();

export const InterpretResponseSchema = z.object({
  rawQuery: z.string().min(1),
  normalizedQuery: z.string().min(1),
  normalizedQueryViews: NormalizedQueryViewsSchema.optional(),
  intent: z.string().min(1),
  secondaryIntents: z.array(z.string().min(1)).optional(),
  route: z.enum(['entity', 'hybrid', 'mixed']),
  retrievalMode: z.string().min(1),
  queryClass: z.string().min(1),
  anchors: z.array(z.unknown()),
  constraints: z.object({
    hard: z.array(z.unknown()),
    soft: z.array(z.unknown()),
    inferred: z.array(z.unknown()),
  }).strict(),
  expansions: z.object({
    lexical: z.array(z.string()),
    semantic: z.array(z.string()),
  }).strict(),
  policy: z.record(z.unknown()),
  uncertainty: z.record(z.unknown()),
  plannerVersion: z.string().min(1),
  policyRuleVersion: z.string().min(1),
  thresholdProfileId: z.string().min(1),
  admission_context: z.object({
    requires_identity_seal: z.boolean(),
    requires_constraint_evidence: z.boolean(),
    requires_anchor_evidence: z.boolean(),
  }).strict().optional(),
  sessionContext: SessionContextSchema.optional(),
  queryBudget: QueryBudgetSchema.optional(),
  targetEntityType: z.string().min(1).optional(),
}).strict();

export type InterpretResponseBody = z.infer<typeof InterpretResponseSchema>;

export const ResolveCandidateSchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
  rank: z.number().int().positive(),
  calibratedScore: z.number().min(0).max(1),
  matchReasons: z.array(z.string()).optional(),
  metadata: z.record(z.unknown()).optional(),
}).passthrough();

export const ResolveTopEntitySchema = z.object({
  entityId: z.string().min(1),
  canonicalLabel: z.string().min(1),
  calibratedScore: z.number().min(0).max(1),
}).strict();

export const ResolveResponseSchema = z.object({
  status: z.enum(['resolved', 'ambiguous', 'failed']),
  candidates: z.array(ResolveCandidateSchema),
  topEntity: ResolveTopEntitySchema.optional(),
  decision_trace_ref: z.string().min(1),
}).strict();

export type ResolveResponseBody = z.infer<typeof ResolveResponseSchema>;
