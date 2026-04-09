/**
 * HTTP-layer bounds for Zod schemas and route validation (RFC-014 envelope,
 * list sizes, string caps). Not imported by domain — keep domain facts in
 * `@domain/shared/constants` when multiple layers must agree.
 */

/** Subject string from X-Authenticated-Subject; matches header/log safety. */
export const MAX_AUTHENTICATED_SUBJECT_CHARS = 128;

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

/** Response hash string length (hex SHA-256 = 64 chars, add headroom). */
export const MAX_RESPONSE_HASH_CHARS = 128;

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

/** Minimum length for secrets used as HMAC/debug keys (entropy floor). */
export const MIN_SECRET_KEY_LENGTH = 16;

/** Unsupported media type for JSON-only POST/PUT/PATCH (RFC 9110). */
export const HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE = 415;

/** Default Fastify JSON body size limit (1 MiB) when options omit bodyLimit. */
export const HTTP_DEFAULT_BODY_LIMIT_BYTES = 1_048_576;

/** Default TCP connection handshake timeout (ms). */
export const HTTP_DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/** Default per-request processing deadline (ms). */
export const HTTP_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

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

/** Agent endpoint: natural-language query bound (LLM context / abuse guard). */
export const MAX_AGENT_HTTP_QUERY_CHARS = 2000;

/** Agent route: hard cap on ReAct steps (matches Zod schema max). */
export const MAX_AGENT_STEPS_CAP = 10;

/** Claude tool `search_wines` result limit (Zod max, aligns with browse UX). */
export const MAX_WINE_TOOL_SEARCH_RESULTS = 50;
