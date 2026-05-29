import { z } from 'zod';
import {
  LookupRequestSchema,
  SearchRequestSchema,
} from '../schemas/search-request.schema.js';
import {
  HybridSearchRequestSchema,
  LexicalSearchRequestSchema,
  LookupWineRequestSchema,
  SemanticSearchRequestSchema,
} from '../schemas/primitive-search.schema.js';
import {
  ComparisonSearchResponseSchema,
  ErrorResponseSchema,
  SearchResponseSchema,
} from '../schemas/search-response.schema.js';
import {
  CreateWatchlistRequestSchema,
  CreateWatchlistResponseSchema,
  GetWatchlistResponseSchema,
  ListWatchlistResponseSchema,
  ListDeliveriesResponseSchema,
  WatchlistAuthHeadersSchema,
  WatchlistErrorResponseSchema,
  WatchlistIdParamsSchema,
} from '../schemas/watchlist.schema.js';
import {
  PostFeedbackRequestSchema,
  PostFeedbackResponseSchema,
} from '../schemas/feedback.schema.js';
import {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_CREATED,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_NO_CONTENT,
  HTTP_STATUS_OK,
  HTTP_STATUS_REQUEST_TIMEOUT,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
  HTTP_STATUS_TOO_MANY_REQUESTS,
  HTTP_STATUS_UNAUTHORIZED,
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

const AGENT_METRICS_ALERTS_MAX = 20;
/** Upper bound on probe `reason` text surfaced in /ready response (H13). */
const READINESS_REASON_MAX_LEN = 512;
/** Upper bound on probe `errorClass` (typically `Error.constructor.name`). */
const READINESS_ERROR_CLASS_MAX_LEN = 128;
const RETRIEVAL_DEGRADATION_ALERTS_MAX = 20;
/** Health/readiness checks: ~6 known checks (pg, redis, vespa, llm, embedding, reranker) + headroom. */
const READINESS_CHECKS_MAX = 20;
/** Upper bound for component count in degradation metrics (6 known components + headroom). */
const RETRIEVAL_DEGRADATION_COMPONENTS_MAX = 12;
/** Upper bound for circuit breaker registry entries. The registry currently
 *  tracks ~10 breakers (llm, embedding, vespa, pg, redis, etc.); 64 gives
 *  ample headroom without allowing unbounded memory growth on serialization. */
const CIRCUIT_BREAKER_REGISTRY_MAX = 64;
/** Upper bound for breaker name/state identifier strings. Breaker names are
 *  short snake_case identifiers ("llm_embedding", "vespa_query"); 128 chars
 *  is comfortably above the longest known breaker id. */
const CIRCUIT_BREAKER_IDENTIFIER_MAX_CHARS = 128;
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

const AgentMetricsResponseSchema = z.object({
  timestamp: z.string(),
  agent: z.object({
    runs: z.number().int().nonnegative(),
    by_termination_reason: z.record(z.number().int().nonnegative()).refine(
      (rec) => Object.keys(rec).length <= AGENT_METRICS_ALERTS_MAX,
      { message: `by_termination_reason must not exceed ${AGENT_METRICS_ALERTS_MAX} keys` },
    ),
    fallback_runs: z.number().int().nonnegative(),
    fallback_rate: z.number().finite().min(0),
    fallback_by_layer: z.record(z.number().int().nonnegative()).refine(
      (rec) => Object.keys(rec).length <= AGENT_METRICS_ALERTS_MAX,
      { message: `fallback_by_layer must not exceed ${AGENT_METRICS_ALERTS_MAX} keys` },
    ),
    reasoning_failure_runs: z.number().int().nonnegative(),
    total_tool_calls: z.number().int().nonnegative(),
    avg_duration_ms: z.number().finite().nonnegative(),
    tool_outcome_kinds: z.record(z.number().int().nonnegative()).refine(
      (rec) => Object.keys(rec).length <= AGENT_METRICS_ALERTS_MAX,
      { message: `tool_outcome_kinds must not exceed ${AGENT_METRICS_ALERTS_MAX} keys` },
    ),
    failed_outcome_kinds: z.record(z.number().int().nonnegative()).refine(
      (rec) => Object.keys(rec).length <= AGENT_METRICS_ALERTS_MAX,
      { message: `failed_outcome_kinds must not exceed ${AGENT_METRICS_ALERTS_MAX} keys` },
    ),
    timeouts: z.object({
      llm_step: z.number().int().nonnegative(),
      tool: z.number().int().nonnegative(),
      parallel_batch: z.number().int().nonnegative(),
      event_rate_per_run: z.number().finite().min(0),
    }).strict(),
    alerts: z.array(z.string()).max(AGENT_METRICS_ALERTS_MAX),
  }).strict(),
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

export const AgentMetricsRouteContract = defineRouteContract({
  operationId: 'system.agentMetrics',
  responses: {
    [HTTP_STATUS_OK]: AgentMetricsResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
  },
});

const RetrievalDegradationMetricsResponseSchema = z.object({
  timestamp: z.string(),
  retrieval: z.object({
    total_retrievals: z.number().int().nonnegative(),
    degradations: z.record(z.number().int().nonnegative()).refine(
      (rec) => Object.keys(rec).length <= RETRIEVAL_DEGRADATION_COMPONENTS_MAX,
      { message: `degradations record must not exceed ${RETRIEVAL_DEGRADATION_COMPONENTS_MAX} keys` },
    ),
    degradation_rate: z.number().finite().min(0),
    alerts: z.array(z.string()).max(RETRIEVAL_DEGRADATION_ALERTS_MAX),
  }).strict(),
  /** Silent skip counters from src/domain/observability/silent-skip-counters.ts. */
  silent_skips: z.record(z.number().int().nonnegative()).refine(
    (rec) => Object.keys(rec).length <= RETRIEVAL_DEGRADATION_COMPONENTS_MAX,
    { message: `silent_skips must not exceed ${RETRIEVAL_DEGRADATION_COMPONENTS_MAX} keys` },
  ).optional(),
  /** Circuit breaker registry snapshot. */
  circuit_breakers: z.array(z.object({
    name: z.string().min(1).max(CIRCUIT_BREAKER_IDENTIFIER_MAX_CHARS),
    state: z.string().min(1).max(CIRCUIT_BREAKER_IDENTIFIER_MAX_CHARS),
    failure_count: z.number().int().nonnegative(),
    open_count: z.number().int().nonnegative(),
  }).strict()).max(CIRCUIT_BREAKER_REGISTRY_MAX).optional(),
}).strict();

export const RetrievalDegradationMetricsRouteContract = defineRouteContract({
  operationId: 'system.retrievalDegradationMetrics',
  responses: {
    [HTTP_STATUS_OK]: RetrievalDegradationMetricsResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
  },
});

export const LookupRouteContract = defineRouteContract({
  operationId: 'search.lookup',
  body: LookupRequestSchema,
  capabilities: [
    'security',
    'planner',
    'SAT',
    'cache',
    'resolver_only',
  ],
  responses: {
    [HTTP_STATUS_OK]: SearchResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
});

export const SearchRouteContract = defineRouteContract({
  operationId: 'search.execute',
  body: SearchRequestSchema,
  capabilities: [
    'security',
    'decomposition',
    'planner',
    'SAT',
    'cache',
    'route_resolution',
    'ranked_post_route',
  ],
  responses: {
    [HTTP_STATUS_OK]: z.union([SearchResponseSchema, ComparisonSearchResponseSchema]),
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
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

export const LookupWineRouteContract = defineRouteContract({
  operationId: 'lookup.wine',
  body: LookupWineRequestSchema,
  capabilities: [
    'security',
    'planner',
    'SAT',
    'cache',
    'resolver_only',
  ],
  responses: {
    [HTTP_STATUS_OK]: SearchResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
});

export const WatchlistListRouteContract = defineRouteContract({
  operationId: 'watchlist.list',
  headers: WatchlistAuthHeadersSchema,
  responses: {
    [HTTP_STATUS_OK]: ListWatchlistResponseSchema,
    [HTTP_STATUS_UNAUTHORIZED]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: WatchlistErrorResponseSchema,
  },
});

export const WatchlistCreateRouteContract = defineRouteContract({
  operationId: 'watchlist.create',
  body: CreateWatchlistRequestSchema,
  headers: WatchlistAuthHeadersSchema,
  responses: {
    [HTTP_STATUS_CREATED]: CreateWatchlistResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_UNAUTHORIZED]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: WatchlistErrorResponseSchema,
  },
});

export const WatchlistGetRouteContract = defineRouteContract({
  operationId: 'watchlist.get',
  params: WatchlistIdParamsSchema,
  headers: WatchlistAuthHeadersSchema,
  responses: {
    [HTTP_STATUS_OK]: GetWatchlistResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_UNAUTHORIZED]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_NOT_FOUND]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: WatchlistErrorResponseSchema,
  },
});

export const WatchlistDeleteRouteContract = defineRouteContract({
  operationId: 'watchlist.delete',
  params: WatchlistIdParamsSchema,
  headers: WatchlistAuthHeadersSchema,
  responses: {
    [HTTP_STATUS_NO_CONTENT]: null,
    [HTTP_STATUS_BAD_REQUEST]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_UNAUTHORIZED]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_NOT_FOUND]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: WatchlistErrorResponseSchema,
  },
});

export const WatchlistDeliveriesRouteContract = defineRouteContract({
  operationId: 'watchlist.listDeliveries',
  params: WatchlistIdParamsSchema,
  headers: WatchlistAuthHeadersSchema,
  responses: {
    [HTTP_STATUS_OK]: ListDeliveriesResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_UNAUTHORIZED]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_NOT_FOUND]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: WatchlistErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: WatchlistErrorResponseSchema,
  },
});

export const FeedbackSubmitRouteContract = defineRouteContract({
  operationId: 'learning.submitFeedback',
  body: PostFeedbackRequestSchema,
  responses: {
    [HTTP_STATUS_CREATED]: PostFeedbackResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
});
