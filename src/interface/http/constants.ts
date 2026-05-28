/**
 * HTTP-layer bounds for Zod schemas and route validation (RFC-014 envelope,
 * list sizes, string caps). Not imported by domain — keep domain facts in
 * `@domain/shared/constants` when multiple layers must agree.
 */

// Rule 30: time-unit constants must come from the SSoT module, not be recomputed.
import { HOURS_PER_DAY, MINUTES_PER_HOUR, SECONDS_PER_MINUTE } from '../../domain/shared/utils/time-units.js';
import { MAX_QUERY_LENGTH } from '../../domain/shared/constants.js';

/** Subject string from X-Authenticated-Subject; matches header/log safety. */
export const MAX_AUTHENTICATED_SUBJECT_CHARS = 128;

/**
 * Max Zod issues echoed into a VALIDATION_ERROR envelope `message`. A batch
 * request can produce dozens of issues; joining them all pushes the message
 * toward MAX_ERROR_ENVELOPE_MESSAGE_CHARS and inflates response/log size (R6 H6).
 * The full issue list still goes to the structured log; clients get the first
 * few plus a "(N more)" suffix.
 */
export const MAX_VALIDATION_ISSUES_IN_MESSAGE = 5;

/** RFC-014 error envelope: request_id max length in JSON body. */
export const MAX_ERROR_ENVELOPE_REQUEST_ID_CHARS = 256;

/** RFC-014 error envelope: machine-readable code length. */
export const MAX_ERROR_ENVELOPE_CODE_CHARS = 128;

/** RFC-014 error envelope: human message (defense-in-depth response size). */
export const MAX_ERROR_ENVELOPE_MESSAGE_CHARS = 4096;

/** RFC-014 error envelope: nullable failure_reason string. */
export const MAX_ERROR_ENVELOPE_FAILURE_REASON_CHARS = 1024;

/** Max HTTPS callback URL length (watchlist webhooks; browser URL practical limit). */
export const MAX_HTTPS_CALLBACK_URL_CHARS = 2048;

/** Watchlist entity_id string bound (stable external id + index key). */
export const MAX_WATCHLIST_ENTITY_ID_CHARS = 256;

/** Max trigger conditions per watchlist (UI + delivery fan-out bound). */
export const MAX_WATCHLIST_TRIGGER_CONDITIONS = 10;

/** Max rows returned for list-watchlist / list-deliveries. */
export const MAX_WATCHLIST_LIST_PAGE_ITEMS = 1000;

/** Price-drop / critic-score triggers use 0–100 percentage scale. */
export const MAX_PERCENT_SCALE = 100;

/** Min inclusive for HTTP status codes in delivery logs (RFC 9110). */
export const MIN_HTTP_STATUS_CODE = 100;

/** Max inclusive for HTTP status codes in delivery logs. */
export const MAX_HTTP_STATUS_CODE = 599;

/** Webhook delivery attempts stored per log entry (retry cap). */
export const MAX_WEBHOOK_DELIVERY_ATTEMPT = 4;

/** Evidence / constraint list caps in search responses (telemetry-safe). */
export const MAX_SEARCH_CONSTRAINT_STRING_LIST = 100;

/** Uncertainty block: missing_info and similar string lists. */
export const MAX_SEARCH_UNCERTAINTY_STRING_LIST = 50;

/** Short flag / reason lists on results and meta. */
export const MAX_SEARCH_SHORT_STRING_LIST = 20;

/** Entity summary: grape names per result. */
export const MAX_ENTITY_SUMMARY_GRAPES = 20;

/** Entity summary: max pairing tags per result. */
export const MAX_ENTITY_SUMMARY_PAIRING_TAGS = 20;

/** Entity summary: max occasion tags per result. */
export const MAX_ENTITY_SUMMARY_OCCASIONS = 20;

/** Entity summary: max certifications per result. */
export const MAX_ENTITY_SUMMARY_CERTIFICATIONS = 20;

/** Entity summary: max flavor descriptor tags per result. */
export const MAX_ENTITY_SUMMARY_FLAVOR_PROFILES = 20;

/** Entity summary: max chars for LLM-generated semantic summary (single-paragraph cap). */
export const MAX_ENTITY_SUMMARY_SEMANTIC_SUMMARY_CHARS = 1024;


/**
 * Bounded relevance_score magnitude: avoids NaN/Infinity and absurd floats
 * breaking percentile telemetry or float32 clients.
 */
export const SEARCH_RELEVANCE_SCORE_ABS_MAX = 1_000_000;

/** Evidence items per result (ranking pipeline truncation aligns). */
export const MAX_SEARCH_EVIDENCE_ITEMS_PER_RESULT = 100;

/** Metadata object key cap on evidence / resolve (object explosion guard). */
export const MAX_SEARCH_METADATA_OBJECT_KEYS = 50;

/** Clarification candidates payload. */
export const MAX_CLARIFICATION_CANDIDATES = 20;

/** Counterfactual rejects appended to search response. */
export const MAX_SEARCH_COUNTERFACTUALS = 100;

/** Parsed constraints transport: unparsed fragment list. */
export const MAX_SEARCH_PARSED_UNPARSED_FRAGMENTS = 50;

/** Retrieval provenance slice list (debug/telemetry). */
export const MAX_SEARCH_RETRIEVAL_PROVENANCE_SLICES = 500;

/** Hard cap on search results per response (defense in depth). */
export const MAX_SEARCH_RESULTS_PER_RESPONSE = 200;

/** Normalized query view: reordered tokens / lookup variants. */
export const MAX_NORMALIZED_QUERY_VIEW_STRINGS = 50;

/** Session context: previous entity ids. */
export const MAX_SESSION_PREVIOUS_ENTITIES = 50;

/** Session: single entity id string length. */
export const MAX_SESSION_ENTITY_ID_CHARS = 256;

/** Session id string length (client-supplied correlation id). */
export const MAX_SESSION_ID_CHARS = 256;

/** Interpret/query budget transport (ms ceiling for client hints). */
export const MAX_QUERY_BUDGET_LATENCY_MS = 30_000;

/** Interpret: max candidates hint. */
export const MAX_QUERY_BUDGET_CANDIDATES = 1_000;

/** Interpret: rerank limit hint. */
export const MAX_QUERY_BUDGET_RERANK_LIMIT = 500;

/** Interpret: optional dense retrieval call cap. */
export const MAX_QUERY_BUDGET_DENSE_CALLS = 100;

/** Secondary intents on interpret response. */
export const MAX_INTERPRET_SECONDARY_INTENTS = 10;

/** Resolve response candidate list cap. */
export const MAX_RESOLVE_CANDIDATES = 200;

/**
 * Max tags on `ResolveCandidate.sources` — one slot per resolver channel enum
 * member (`alias`, `planner_heuristic`, `entity_lookup`, `blocker_seed`).
 */
export const MAX_RESOLVE_CANDIDATE_SOURCES_LIST = 4;

/** Debug refs on search meta. */
export const MAX_SEARCH_META_DEBUG_REFS = 50;

/** Hex length of SHA-256 digest in canonical authority_trace_ref / decision_trace_ref. */
export const AUTHORITY_TRACE_REF_SHA256_HEX_LENGTH = 64;

/** Common HTTP status codes (contract handlers). */
export const HTTP_STATUS_OK = 200;
export const HTTP_STATUS_CREATED = 201;
export const HTTP_STATUS_NO_CONTENT = 204;
export const HTTP_STATUS_BAD_REQUEST = 400;
export const HTTP_STATUS_UNAUTHORIZED = 401;
export const HTTP_STATUS_FORBIDDEN = 403;
export const HTTP_STATUS_NOT_FOUND = 404;
export const HTTP_STATUS_INTERNAL_SERVER_ERROR = 500;
export const HTTP_STATUS_REQUEST_TIMEOUT = 408;
export const HTTP_STATUS_PAYLOAD_TOO_LARGE = 413;
export const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
export const HTTP_STATUS_SERVICE_UNAVAILABLE = 503;
export const HTTP_STATUS_CONFLICT = 409;

/** Inclusive lower bound for HTTP 2xx success range checks. */
export const HTTP_SUCCESS_STATUS_MIN = 200;
/** Exclusive upper bound for HTTP 2xx success range checks. */
export const HTTP_SUCCESS_STATUS_MAX_EXCLUSIVE = 300;

/** Retry-After header seconds for retryable domain 503 (BLOCKING_MISS). */
export const RETRY_AFTER_SECONDS_BLOCKING_MISS = 5;

/** Watchlist list/delivery pagination: default page size and hard cap. */
export const WATCHLIST_PAGE_DEFAULT_LIMIT = 50;
export const WATCHLIST_PAGE_MAX_LIMIT = 200;
export const WATCHLIST_PAGE_MIN_LIMIT = 1;
export const WATCHLIST_OFFSET_MIN = 0;

/** Unsupported media type for JSON-only POST/PUT/PATCH (RFC 9110). */
export const HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE = 415;

/** Default Fastify JSON body size limit (1 MiB) when options omit bodyLimit. */
export const HTTP_DEFAULT_BODY_LIMIT_BYTES = 1_048_576;

/**
 * CORS preflight cache lifetime (seconds): 24 h.
 * Browsers cache the preflight OPTIONS response for this duration,
 * reducing round-trips on credentialed cross-origin requests.
 * Rule 30: domain constant used in server.ts — extract here, not inline.
 */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE; // 86 400 s

/**
 * OpenAPI document cache lifetime (seconds): 1 h.
 * The document is derived from static route contracts and never changes
 * during a process lifetime, so a long CDN/browser cache is safe.
 * Rule 30: domain constant used in openapi.route.ts — extract here, not inline.
 */
export const OPENAPI_CACHE_MAX_AGE_SECONDS =
  MINUTES_PER_HOUR * SECONDS_PER_MINUTE; // 3 600 s

/** Default TCP connection handshake timeout (ms). */
export const HTTP_DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/** Default per-request processing deadline (ms). */
export const HTTP_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Default rate-limit max requests per window when ServerOptions.rateLimitMax
 * is omitted. Aligned with `@fastify/rate-limit` standard guidance for a
 * single-process unauthenticated JSON API (RFC-014 §13). Tunable per
 * deployment via `HTTP_RATE_LIMIT_MAX`.
 *
 * Rule 15 / Rule 30: shared between server.ts and the middleware-stack
 * regression test — keep one source of truth here.
 */
export const RATE_LIMIT_MAX_REQUESTS_DEFAULT = 100;

/**
 * Default rate-limit sliding-window length (ms) when ServerOptions does not
 * override it. 60 000 ms = 1 minute = the documented `timeWindow: '1 minute'`
 * literal previously inlined in server.ts.
 *
 * Rule 30: shared with the regression test that exercises the window.
 */
export const RATE_LIMIT_WINDOW_MS_DEFAULT =
  SECONDS_PER_MINUTE * 1000; // 60 000 ms

/** Minimum per-item timeout for batch search items (ms). */
export const MIN_BATCH_SEARCH_ITEM_TIMEOUT_MS = 1_000;

/** Max items in POST /batch-search `requests` array. */
export const MAX_BATCH_SEARCH_REQUEST_ITEMS = 20;

/** BCP-47 locale tag practical bound in search context. */
export const MAX_SEARCH_CONTEXT_LOCALE_CHARS = 35;

/** ISO 4217 currency code length. */
export const MAX_CURRENCY_CODE_CHARS = 3;

/** Feedback POST: entity reference string (may include namespaced ids). */
export const MAX_FEEDBACK_ENTITY_REF_CHARS = 512;

/**
 * Agent endpoint: natural-language query bound (LLM context / abuse guard).
 * Aliases the domain SSoT `MAX_QUERY_LENGTH` — the agent query is screened by
 * the same ReDoS-guarded sanitizer, so it MUST share that ceiling rather than
 * duplicate the literal (the two silently drifted before; SSoT rule 30).
 */
export const MAX_AGENT_HTTP_QUERY_CHARS = MAX_QUERY_LENGTH;

/** Agent route: hard cap on ReAct steps (matches Zod schema max). */
export const MAX_AGENT_STEPS_CAP = 10;

/**
 * Max keys in a response `stage_timings` map — one entry per instrumented
 * pipeline stage (~30 distinct stage labels today; headroom for future stages).
 * Guards against unbounded response growth (schema bar: every record needs a cap).
 */
export const MAX_STAGE_TIMINGS_KEYS = 64;

/**
 * Max keys in a tool-call `arguments` object. Tool inputs are a bounded field
 * set (the widest tool schema is ~27 fields); the cap guards a runaway LLM from
 * emitting unbounded keys while leaving headroom for reasoning/metadata fields
 * that LLMs routinely add (which is why the tool-input schema is non-strict).
 */
export const MAX_TOOL_CALL_ARGUMENT_KEYS = 64;

/** Claude tool `search_wines` result limit (Zod max, aligns with browse UX). */
export const MAX_WINE_TOOL_SEARCH_RESULTS = 50;

// ─── Audit extension bounds ──────────────────────────────────────────────────

/**
 * Max planner policy decision records in audit_extension.planner_policy_trace.
 * One record per planner stage (6 stages documented); headroom for future stages.
 */
export const MAX_AUDIT_PLANNER_POLICY_TRACE_ITEMS = 20;

/**
 * Max hard-filter drop records in audit_extension.hard_filter_drop_log.
 * Production caps at 5 (AUDIT_DROP_LOG_MAX in post-route phase); headroom for expansion.
 */
export const MAX_AUDIT_HARD_FILTER_DROP_LOG_ITEMS = 10;

/**
 * Max candidate source breakdown entries in resolver_provenance_trace.
 * One entry per resolver channel enum value (alias, planner_heuristic, entity_lookup, blocker_seed).
 */
export const MAX_AUDIT_RESOLVER_SOURCE_BREAKDOWN_ITEMS = 10;

/**
 * Max entity IDs per source breakdown entry.
 * Bounded by MAX_RESOLVE_CANDIDATES; practical limit is much smaller in trace payloads.
 */
export const MAX_AUDIT_SOURCE_BREAKDOWN_ENTITY_IDS = 200;

/**
 * Max blocker seed entity IDs in resolver_provenance_trace.
 */
export const MAX_AUDIT_BLOCKER_SEED_ENTITY_IDS = 50;

/**
 * Max constraint atoms in constraint_resolution_trace.
 */
export const MAX_AUDIT_CONSTRAINT_ATOMS = 100;

/**
 * Max constraint relations in constraint_resolution_trace.
 */
export const MAX_AUDIT_CONSTRAINT_RELATIONS = 100;

/**
 * Max policy outcomes in constraint_resolution_trace.
 */
export const MAX_AUDIT_POLICY_OUTCOMES = 100;

/**
 * Max top-N entity IDs in ranking_delta_trace preRerankTop5 / postRerankTop5.
 * Named "top5" in the domain model but we allow a generous bound for schema stability.
 */
export const MAX_AUDIT_RANKING_TOP_N = 20;
