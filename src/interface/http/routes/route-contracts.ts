import { z } from 'zod';
import {
  BatchSearchRequestSchema,
  BatchSearchResponseSchema,
} from '../schemas/batch-search.schema.js';
import {
  HybridRequestSchema,
  InterpretRequestSchema,
  ReplayRequestSchema,
  ResolveRequestSchema,
  SearchRequestSchema,
} from '../schemas/search-request.schema.js';
import {
  ComparisonSearchResponseSchema,
  ErrorResponseSchema,
  InterpretResponseSchema,
  ResolveResponseSchema,
  SearchResponseSchema,
} from '../schemas/search-response.schema.js';
import {
  InterpretResponseV2Schema,
  SearchResponseV2HumanSchema,
} from '../schemas/search-response-v2.schema.js';
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
  HTTP_STATUS_CONFLICT,
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
  MAX_AUTHENTICATED_SUBJECT_CHARS,
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
  | 'forced_hybrid_retrieval'
  | 'planner_only'
  | 'resolver_only';

const AGENT_METRICS_ALERTS_MAX = 20;
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
const MAX_TOOL_INPUT_RECORD_KEYS = 50;

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

const ReadyResponseSchema = z.object({
  ready: z.boolean(),
  timestamp: z.string(),
  checks: z.record(z.object({
    status: z.enum(['up', 'down', 'skipped']),
    required: z.boolean(),
  }).strict()).refine(
    (rec) => Object.keys(rec).length <= READINESS_CHECKS_MAX,
    { message: `checks record must not exceed ${READINESS_CHECKS_MAX} entries` },
  ),
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
    total_tool_calls: z.number().int().nonnegative(),
    avg_duration_ms: z.number().finite().nonnegative(),
    timeouts: z.object({
      llm_step: z.number().int().nonnegative(),
      tool: z.number().int().nonnegative(),
      parallel_batch: z.number().int().nonnegative(),
      event_rate_per_run: z.number().finite().min(0),
    }).strict(),
    alerts: z.array(z.string()).max(AGENT_METRICS_ALERTS_MAX),
  }).strict(),
}).strict();

const ClaudeToolsExecuteRequestSchema = z.object({
  tool_name: z.enum([
    'search_wines',
    'get_food_pairings',
    'check_drinking_window',
    'compare_wines',
  ]),
  tool_input: z.record(z.unknown()).refine(
    (rec) => Object.keys(rec).length <= MAX_TOOL_INPUT_RECORD_KEYS,
    { message: `tool_input must have at most ${MAX_TOOL_INPUT_RECORD_KEYS} keys` },
  ).optional().default({}),
  // request_id must be non-empty when present; regex already enforces alphanumeric+._-
  request_id: z.string().min(1).max(MAX_AUTHENTICATED_SUBJECT_CHARS).regex(/^[a-zA-Z0-9._-]+$/).optional(),
}).strict();

const ClaudeToolsExecuteResponseSchema = z.object({
  tool_name: z.string(),
  tool_result: z.unknown(),
  fallback_applied: z.string().optional(),
  request_id: z.string().min(1),
}).strict();

// Claude tools error responses now use the shared RFC-014 envelope
// (ErrorResponseSchema). The previously hand-rolled flat shape
// `{ error, message, request_id }` violated the contract in CLAUDE.md:
// every 4xx/5xx MUST be `{ error: { request_id, code, message, failure_reason,
// retryable } }`. Keeping this comment as a grep target for future migrations.

const ClaudeToolsListResponseSchema = z.object({
  // Bounded to 100 — there are currently 4 tools; this cap prevents unbounded growth
  // from misconfigured or malicious server responses.
  tools: z.array(z.unknown()).max(100),
  request_id: z.string().min(1),
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
  /** Silent skip counters from src/observability/silent-skip-counters.ts. */
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

export const ClaudeToolsExecuteRouteContract = defineRouteContract({
  operationId: 'tools.execute',
  body: ClaudeToolsExecuteRequestSchema,
  responses: {
    [HTTP_STATUS_OK]: ClaudeToolsExecuteResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
  },
});

export const ClaudeToolsListRouteContract = defineRouteContract({
  operationId: 'tools.list',
  responses: {
    [HTTP_STATUS_OK]: ClaudeToolsListResponseSchema,
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

export const HybridRouteContract = defineRouteContract({
  operationId: 'search.hybrid',
  body: HybridRequestSchema,
  capabilities: [
    'security',
    'decomposition',
    'planner',
    'SAT',
    'cache',
    'forced_hybrid_retrieval',
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

export const InterpretRouteContract = defineRouteContract({
  operationId: 'search.interpret',
  body: InterpretRequestSchema,
  capabilities: [
    'security',
    'planner_only',
  ],
  responses: {
    [HTTP_STATUS_OK]: InterpretResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
});

export const ResolveRouteContract = defineRouteContract({
  operationId: 'entity.resolve',
  body: ResolveRequestSchema,
  capabilities: [
    'security',
    'planner',
    'SAT',
    'resolver_only',
  ],
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

export const ReplayRouteContract = defineRouteContract({
  operationId: 'search.replay',
  body: ReplayRequestSchema,
  responses: {
    [HTTP_STATUS_OK]: SearchResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
    [HTTP_STATUS_CONFLICT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
    [HTTP_STATUS_SERVICE_UNAVAILABLE]: ErrorResponseSchema,
  },
});

export const BatchSearchRouteContract = defineRouteContract({
  operationId: 'search.batch',
  body: BatchSearchRequestSchema,
  responses: {
    [HTTP_STATUS_OK]: BatchSearchResponseSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
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

// ---------------------------------------------------------------------------
// V2 route catalog — handler wiring added in T6.5
// ---------------------------------------------------------------------------

/**
 * V2 route URL constants.
 *
 * Versioning matrix:
 *
 * Human routes:
 *   POST /v2/search              → SearchResponseV2Human (queryType: search | comparison)
 *   POST /v2/search/hybrid       → SearchResponseV2Human
 *   POST /v2/search/interpret    → InterpretResponseV2
 *
 * Machine V2:
 *   NOT exposed via /v2/search/* routes.
 *   Machine/LLM consumers continue to use the /v1/claude-tools seam
 *   (WineToolExecutor). The executor will project SearchResponseV2Machine
 *   when the T6.5 handler wiring is complete.
 *
 * V1 routes:
 *   /v1/search, /v1/search/hybrid, /v1/search/interpret, /v1/entity/resolve,
 *   /v1/batch-search, /v1/search/replay are adapter-compatible and maintained
 *   until post-Wave-3 deprecation.
 *
 * Full migration story — V1 maintenance policy, V2 adoption rules, machine/LLM
 * migration steps, deprecation schedule, and the new-route decision tree:
 *   docs/migration/v1-v2-api-migration.md
 */
export const SEARCH_V2_ROUTES = {
  search: '/v2/search',
  hybrid: '/v2/search/hybrid',
  interpret: '/v2/search/interpret',
} as const;

export const SearchV2RouteContract = defineRouteContract({
  operationId: 'search.v2.execute',
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
  apiVersion: '2',
  responseType: 'human',
  responses: {
    [HTTP_STATUS_OK]: SearchResponseV2HumanSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
  },
});

export const HybridV2RouteContract = defineRouteContract({
  operationId: 'search.v2.hybrid',
  body: HybridRequestSchema,
  capabilities: [
    'security',
    'decomposition',
    'planner',
    'SAT',
    'cache',
    'forced_hybrid_retrieval',
    'ranked_post_route',
  ],
  apiVersion: '2',
  responseType: 'human',
  responses: {
    [HTTP_STATUS_OK]: SearchResponseV2HumanSchema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
  },
});

export const InterpretV2RouteContract = defineRouteContract({
  operationId: 'search.v2.interpret',
  body: InterpretRequestSchema,
  capabilities: [
    'security',
    'planner_only',
  ],
  apiVersion: '2',
  responseType: 'interpret',
  responses: {
    [HTTP_STATUS_OK]: InterpretResponseV2Schema,
    [HTTP_STATUS_BAD_REQUEST]: ErrorResponseSchema,
    [HTTP_STATUS_FORBIDDEN]: ErrorResponseSchema,
    [HTTP_STATUS_REQUEST_TIMEOUT]: ErrorResponseSchema,
    [HTTP_STATUS_TOO_MANY_REQUESTS]: ErrorResponseSchema,
    [HTTP_STATUS_INTERNAL_SERVER_ERROR]: ErrorResponseSchema,
  },
});
