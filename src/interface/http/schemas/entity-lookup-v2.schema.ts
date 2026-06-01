/**
 * Entity Lookup V2 (`POST /v2/entity-lookup`) — dedicated HTTP contract.
 *
 * This schema family is deliberately NOT derived from the primitive-search
 * request/response shapes (RFC entity-lookup-v2 §5.1 + ticket T-ELV2-01
 * forbidden: "V2 body가 primitive search request를 재사용하는 것" /
 * "V2 response가 search result list를 흉내 내는 것"). Lookup is an entity
 * resolution task: a single query in, a calibrated 4-state decision out.
 *
 * Every object chains `.strict()` (CLAUDE.md rule 10) and every numeric field
 * is `.finite()`-guarded; arrays carry domain-justified `.max(N)` bounds.
 */

import { z } from 'zod';
import { QueryStringSchema } from './search-shared.schema.js';
import {
  LOOKUP_V2_DEFAULT_MAX_CANDIDATES,
  MAX_ERROR_ENVELOPE_REQUEST_ID_CHARS,
  MAX_LOOKUP_V2_CANDIDATES,
  MAX_LOOKUP_V2_CHANNEL_HITS,
  MAX_LOOKUP_V2_CLARIFICATION_OPTIONS,
  MAX_LOOKUP_V2_COVERAGE_ROWS,
  MAX_NORMALIZED_QUERY_VIEW_STRINGS,
} from '../constants.js';
import { LOOKUP_RETRIEVAL_CHANNELS, LOOKUP_V2_STATUSES } from '../../../domain/resolver/v2/lookup-v2-types.js';

/** BCP-47-ish locale tag; kept permissive but bounded (e.g. `ko`, `en-US`). */
const LOOKUP_V2_LOCALE_MAX_CHARS = 35;

/**
 * Request body. Minimal and explicit — no filters, no preferences, no
 * retrieval-lane override (the surface IS the lane).
 */
export const EntityLookupV2RequestSchema = z
  .object({
    query: QueryStringSchema,
    /** Caller locale hint, used by transliteration/script-consistency only. */
    locale: z.string().min(1).max(LOOKUP_V2_LOCALE_MAX_CHARS).optional(),
    /** Candidate fan-out ceiling; defaults applied server-side when omitted. */
    max_candidates: z
      .number()
      .int()
      .finite()
      .min(1)
      .max(MAX_LOOKUP_V2_CANDIDATES)
      .default(LOOKUP_V2_DEFAULT_MAX_CANDIDATES),
    /**
     * Trusted/internal diagnostics knob ONLY — never a public ranking override
     * (RFC §5.1). `diagnostic` asks the engine to populate the full evidence
     * rail; it does not change the decision.
     */
    mode: z.enum(['default', 'diagnostic']).default('default'),
  })
  .strict();

export type EntityLookupV2Request = z.infer<typeof EntityLookupV2RequestSchema>;

/**
 * Explicit normalized-query-view artifact (RFC §5.3 / DoD §2: "normalized
 * query views가 explicit artifact로 남는다"). A curated projection of the
 * domain `NormalizedQueryViews` — the views that actually drive recall.
 */
export const NormalizedQueryViewsWireSchema = z
  .object({
    raw: z.string(),
    strict: z.string(),
    accentless: z.string(),
    compact: z.string(),
    vintage_canonicalized: z.string(),
    vintage_stripped: z.string(),
    transliterated: z.string().optional(),
    phonetic_compact: z.string().optional(),
    lookup_variants: z
      .array(z.string().min(1))
      .max(MAX_NORMALIZED_QUERY_VIEW_STRINGS),
  })
  .strict();

/** Per-channel recall evidence for one candidate. */
const LookupChannelHitWireSchema = z
  .object({
    channel: z.enum(LOOKUP_RETRIEVAL_CHANNELS),
    matched_view: z.string().min(1),
    matched_alias: z.string().min(1).optional(),
    channel_score: z.number().finite().min(0).max(1),
    channel_rank: z.number().int().positive(),
  })
  .strict();

export const LookupV2CandidateSchema = z
  .object({
    entity_id: z.string().min(1),
    canonical_label: z.string().min(1),
    /**
     * Entity type (`wine` / `producer` / `region`). Optional at the wire
     * boundary: the multi-channel retrieval runtime (T-ELV2-04) always knows
     * it, but the resolver-backed baseline path does not surface it yet.
     */
    entity_type: z.string().min(1).optional(),
    /** Calibrated probability this is the intended entity, in [0, 1]. */
    calibrated_score: z.number().finite().min(0).max(1),
    rank: z.number().int().positive(),
    /** Distinct channels that recalled this candidate (union breadth). */
    channel_agreement: z.number().int().nonnegative(),
    channel_hits: z.array(LookupChannelHitWireSchema).max(MAX_LOOKUP_V2_CHANNEL_HITS),
  })
  .strict();

/** Clarification option for an `ambiguous` outcome (graph-backed in T-ELV2-06). */
const LookupV2ClarificationOptionSchema = z
  .object({
    entity_id: z.string().min(1),
    label: z.string().min(1),
    /** Why this candidate differs from its siblings (e.g. vintage, producer). */
    distinguishing_feature: z.string().min(1).optional(),
  })
  .strict();

/** Per-channel coverage rail (latency + hit counts) for observability. */
const LookupV2ChannelCoverageSchema = z
  .object({
    channel: z.enum(LOOKUP_RETRIEVAL_CHANNELS),
    firing: z.boolean(),
    hit_count: z.number().int().nonnegative(),
    latency_ms: z.number().finite().nonnegative(),
  })
  .strict();

/** Decision-grade evidence summary — the resolve spine, one query → one view. */
const LookupV2EvidenceSummarySchema = z
  .object({
    admission_reason_code: z.string().min(1),
    decision_reason_code: z.string().min(1),
    top_confidence: z.number().finite().min(0).max(1).optional(),
    top1_top2_margin: z.number().finite().min(0).max(1).optional(),
    calibration_trusted: z.boolean(),
    query_class: z.string().min(1),
    candidate_pool_size: z.number().int().nonnegative(),
    channel_coverage: z.array(LookupV2ChannelCoverageSchema).max(MAX_LOOKUP_V2_COVERAGE_ROWS),
  })
  .strict();

const LookupV2MetaSchema = z
  .object({
    request_id: z.string().min(1).max(MAX_ERROR_ENVELOPE_REQUEST_ID_CHARS).optional(),
    query_time_ms: z.number().finite().nonnegative(),
    version: z.string().min(1),
    engine_schema_version: z.literal('entity_lookup_v2'),
  })
  .strict();

export const EntityLookupV2ResponseSchema = z
  .object({
    status: z.enum(LOOKUP_V2_STATUSES),
    /** Human-facing one-line reason for the terminal status. */
    decision_reason: z.string().min(1),
    normalized_query_views: NormalizedQueryViewsWireSchema,
    candidates: z.array(LookupV2CandidateSchema).max(MAX_LOOKUP_V2_CANDIDATES),
    /** The selected entity when `status === 'resolved'`, else null. */
    top_candidate: LookupV2CandidateSchema.nullable(),
    clarification_options: z
      .array(LookupV2ClarificationOptionSchema)
      .max(MAX_LOOKUP_V2_CLARIFICATION_OPTIONS),
    evidence_summary: LookupV2EvidenceSummarySchema,
    meta: LookupV2MetaSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    // A resolved lookup MUST carry its selected entity; a non-resolved lookup
    // MUST NOT pretend to have one. This makes the 4-state contract honest at
    // the wire boundary (precision-first: no silent wrong-positive).
    if (value.status === 'resolved' && value.top_candidate === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'status "resolved" requires a non-null top_candidate',
        path: ['top_candidate'],
      });
    }
    if (value.status !== 'resolved' && value.top_candidate !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'top_candidate must be null unless status is "resolved"',
        path: ['top_candidate'],
      });
    }
    // redirect_discovery and failed never carry clarification options; only
    // ambiguous does (clarification is a disambiguation contract).
    if (value.status !== 'ambiguous' && value.clarification_options.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'clarification_options are only valid when status is "ambiguous"',
        path: ['clarification_options'],
      });
    }
  });

export type EntityLookupV2Response = z.infer<typeof EntityLookupV2ResponseSchema>;
