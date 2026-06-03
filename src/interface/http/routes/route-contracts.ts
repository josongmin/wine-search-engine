import { z } from 'zod';
import {
  HybridSearchRequestSchema,
  LexicalSearchRequestSchema,
  LookupWineRequestSchema,
  SemanticSearchRequestSchema,
} from '../schemas/primitive-search.schema.js';
import {
  ComparisonSearchResponseSchema,
  ErrorResponseSchema,
  ResolveResponseSchema,
  SearchResponseSchema,
} from '../schemas/search-response.schema.js';
import {
  EntityLookupV2RequestSchema,
  EntityLookupV2ResponseSchema,
} from '../schemas/entity-lookup-v2.schema.js';
import {
  AliasAuditRequestSchema,
  AliasAuditResponseSchema,
  CoverageHealthRequestSchema,
  CoverageHealthResponseSchema,
  ListProposalsRequestSchema,
  ListProposalsResponseSchema,
  ProposalResponseSchema,
  PublishProposalRequestSchema,
  ReviewProposalRequestSchema,
  SubmitProposalRequestSchema,
} from '../schemas/entity-lookup-v2-ops.schema.js';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_CONFLICT,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_OK,
  HTTP_STATUS_REQUEST_TIMEOUT,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
} from '../constants.js';

type ResponseSchema = z.ZodTypeAny | null;
type SearchRouteCapability =
  | 'security'
  | 'decomposition'
  | 'planner'
  | 'SAT'
  | 'cache'
  | 'route_resolution'
  | 'ranked_post_route'
  | 'resolver_only'
  | 'analysis';

/** Upper bound on probe `reason` text surfaced in /ready response (H13). */
const READINESS_REASON_MAX_LEN = 512;
/** Upper bound on probe `errorClass` (typically `Error.constructor.name`). */
const READINESS_ERROR_CLASS_MAX_LEN = 128;
/** Health/readiness checks: ~6 known checks (pg, redis, vespa, llm, embedding, reranker) + headroom. */
const READINESS_CHECKS_MAX = 20;
export interface HttpRouteContract {
  readonly operationId: string;
  readonly body?: z.ZodTypeAny;
  readonly params?: z.ZodTypeAny;
  readonly headers?: z.ZodTypeAny;
  readonly capabilities?: readonly SearchRouteCapability[];
  readonly responses: Readonly<Record<number, ResponseSchema>>;
  /** API version string for x-version extension (e.g. '2' for V2 routes). */
  readonly apiVersion?: string;
  /** Response type tag for x-response-type extension (e.g. 'human', 'interpret'). */
  readonly responseType?: string;
}

function defineRouteContract<T extends HttpRouteContract>(contract: T): T {
  return Object.freeze(contract);
}

const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  timestamp: z.string(),
  uptime: z.number().finite(),
}).strict();

/** Hard ceiling for snapshot_health.stale_row_count. Reaper keeps this near
 *  zero in steady state; a runaway lag would still serialize below this cap. */
const SNAPSHOT_HEALTH_STALE_ROWS_MAX = 100_000_000;

const SnapshotHealthSchema = z.object({
  active_snapshot_id: z.string().min(1),
  previous_snapshot_id: z.string().min(1).nullable(),
  /** Sum of rows in entities + aliases + ambiguity_registry whose
   *  search_snapshot_id is neither active nor previous — waiting for the reaper. */
  stale_row_count: z.number().int().nonnegative().max(SNAPSHOT_HEALTH_STALE_ROWS_MAX),
  /** Seconds since active_search_snapshot.promoted_at. Enables alerts on
   *  stuck pointers (no publish in N hours) and on reaper lag. */
  pointer_age_seconds: z.number().int().nonnegative(),
}).strict();

const ReadyResponseSchema = z.object({
  ready: z.boolean(),
  timestamp: z.string(),
  checks: z.record(z.object({
    status: z.enum(['up', 'down', 'skipped']),
    required: z.boolean(),
    // Wave 3 / H13 fail-loud: when a probe throws, surface the structured
    // reason + error class so ops can immediately see WHICH probe died and
    // HOW — not just an opaque 'down'.
    reason: z.string().max(READINESS_REASON_MAX_LEN).optional(),
    error_class: z.string().max(READINESS_ERROR_CLASS_MAX_LEN).optional(),
  }).strict()).refine(
    (rec) => Object.keys(rec).length <= READINESS_CHECKS_MAX,
    { message: `checks record must not exceed ${READINESS_CHECKS_MAX} entries` },
  ),
  // Optional snapshot-plane observability block. Optional so the field is
  // allowed to be absent when PG is down or the reader is not wired.
  snapshot_health: SnapshotHealthSchema.optional(),
}).strict();

export const HealthRouteContract = defineRouteContract({
  operationId: 'system.health',
  responses: {
    [HTTP_STATUS_OK]: HealthResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: HealthResponseSchema,
  },
});

export const ReadyRouteContract = defineRouteContract({
  operationId: 'system.ready',
  responses: {
    [HTTP_STATUS_OK]: ReadyResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ReadyResponseSchema,
  },
});

export const ResolveRouteContract = defineRouteContract({
  operationId: 'entity.resolve',
  body: LookupWineRequestSchema,
  capabilities: ['security', 'planner', 'resolver_only'],
  responses: {
    [HTTP_STATUS_OK]: ResolveResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
});

// ---------------------------------------------------------------------------
// T-ELV2-01 — dedicated entity-lookup V2 surface (`POST /v2/entity-lookup`).
// NOT part of the primitive-search family: lookup is an entity-resolution task
// with its own 4-state outcome contract, not a discovery search.
// ---------------------------------------------------------------------------

export const EntityLookupV2RouteContract = defineRouteContract({
  operationId: 'entity.lookup.v2',
  apiVersion: '2',
  body: EntityLookupV2RequestSchema,
  capabilities: ['security', 'planner', 'resolver_only'],
  responses: {
    [HTTP_STATUS_OK]: EntityLookupV2ResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
});

// T-ELV2-07 — trusted operator plane (read). `POST /v2/entity-lookup/ops/inspect`
// returns the FULL decision spine (admission/candidates/scores/decision) for one
// query, always in diagnostic mode, behind the X-Debug-Key trusted gate. Same
// response shape as the public surface; 403 when the debug key is absent.
export const EntityLookupV2OpsInspectRouteContract = defineRouteContract({
  operationId: 'entity.lookup.v2.ops.inspect',
  apiVersion: '2',
  responseType: 'interpret',
  body: EntityLookupV2RequestSchema,
  capabilities: ['security', 'planner', 'resolver_only', 'analysis'],
  responses: {
    [HTTP_STATUS_OK]: EntityLookupV2ResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
});

// ---------------------------------------------------------------------------
// T-ELV2-07 — operator curation plane (`/v2/entity-lookup/ops/*`).
// Reads are X-Debug-Key gated; writes are X-Ops-Write-Key gated at the handler.
// All POST-with-body, matching the ops/inspect read contract above.
// ---------------------------------------------------------------------------

/** Common error statuses for the trusted read ops endpoints. */
const OPS_READ_ERROR_RESPONSES = {
  [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
  [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
  [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
  [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
} as const;

/** Write endpoints add 404 (unknown proposal) + 409 (illegal transition / lost race). */
const OPS_WRITE_ERROR_RESPONSES = {
  ...OPS_READ_ERROR_RESPONSES,
  [HTTP_STATUS_NOT_FOUND]: ErrorResponseSchema,
  [HTTP_STATUS_CONFLICT]: ErrorResponseSchema,
} as const;

export const EntityLookupV2OpsAliasAuditRouteContract = defineRouteContract({
  operationId: 'entity.lookup.v2.ops.alias_audit',
  apiVersion: '2',
  responseType: 'interpret',
  body: AliasAuditRequestSchema,
  capabilities: ['analysis'],
  responses: { [HTTP_STATUS_OK]: AliasAuditResponseSchema, ...OPS_READ_ERROR_RESPONSES },
});

export const EntityLookupV2OpsCoverageHealthRouteContract = defineRouteContract({
  operationId: 'entity.lookup.v2.ops.coverage_health',
  apiVersion: '2',
  responseType: 'interpret',
  body: CoverageHealthRequestSchema,
  capabilities: ['analysis'],
  responses: { [HTTP_STATUS_OK]: CoverageHealthResponseSchema, ...OPS_READ_ERROR_RESPONSES },
});

export const EntityLookupV2OpsListProposalsRouteContract = defineRouteContract({
  operationId: 'entity.lookup.v2.ops.proposals.list',
  apiVersion: '2',
  responseType: 'interpret',
  body: ListProposalsRequestSchema,
  capabilities: ['analysis'],
  responses: { [HTTP_STATUS_OK]: ListProposalsResponseSchema, ...OPS_READ_ERROR_RESPONSES },
});

export const EntityLookupV2OpsSubmitProposalRouteContract = defineRouteContract({
  operationId: 'entity.lookup.v2.ops.proposals.submit',
  apiVersion: '2',
  responseType: 'interpret',
  body: SubmitProposalRequestSchema,
  capabilities: ['analysis'],
  responses: { [HTTP_STATUS_OK]: ProposalResponseSchema, ...OPS_READ_ERROR_RESPONSES },
});

export const EntityLookupV2OpsReviewProposalRouteContract = defineRouteContract({
  operationId: 'entity.lookup.v2.ops.proposals.review',
  apiVersion: '2',
  responseType: 'interpret',
  body: ReviewProposalRequestSchema,
  capabilities: ['analysis'],
  responses: { [HTTP_STATUS_OK]: ProposalResponseSchema, ...OPS_WRITE_ERROR_RESPONSES },
});

export const EntityLookupV2OpsPublishProposalRouteContract = defineRouteContract({
  operationId: 'entity.lookup.v2.ops.proposals.publish',
  apiVersion: '2',
  responseType: 'interpret',
  body: PublishProposalRequestSchema,
  capabilities: ['analysis'],
  responses: { [HTTP_STATUS_OK]: ProposalResponseSchema, ...OPS_WRITE_ERROR_RESPONSES },
});

// ---------------------------------------------------------------------------
// T-IR-01 primitive surface — `/v1/search/{hybrid,semantic,lexical}` and
// `/v1/lookup/wine`. The body shape is identical across all four; the URL
// is the authority on which retrieval lane runs (architecture-decision §2.2).
// ---------------------------------------------------------------------------

const PrimitiveSearchResponseSchema = z.union([SearchResponseSchema, ComparisonSearchResponseSchema]);

const PRIMITIVE_SEARCH_RESPONSES = {
  [HTTP_STATUS_OK]: PrimitiveSearchResponseSchema,
  [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
  [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
  [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
  [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
  [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
  [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
} as const;

const PRIMITIVE_SEARCH_CAPABILITIES = [
  'security',
  'planner',
  'SAT',
  'cache',
  'route_resolution',
  'ranked_post_route',
] as const;

export const HybridSearchRouteContract = defineRouteContract({
  operationId: 'search.hybrid',
  body: HybridSearchRequestSchema,
  capabilities: PRIMITIVE_SEARCH_CAPABILITIES,
  responses: PRIMITIVE_SEARCH_RESPONSES,
});

export const SemanticSearchRouteContract = defineRouteContract({
  operationId: 'search.semantic',
  body: SemanticSearchRequestSchema,
  capabilities: PRIMITIVE_SEARCH_CAPABILITIES,
  responses: PRIMITIVE_SEARCH_RESPONSES,
});

export const LexicalSearchRouteContract = defineRouteContract({
  operationId: 'search.lexical',
  body: LexicalSearchRequestSchema,
  capabilities: PRIMITIVE_SEARCH_CAPABILITIES,
  responses: PRIMITIVE_SEARCH_RESPONSES,
});
