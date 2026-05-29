/**
 * Agent surface — T-IR-02 schemas (single-shot run + server-managed sessions).
 *
 * Canonical request shape is `messages[]` — the legacy single-`query` field
 * is gone. The same surface is reused by both:
 *
 *   POST /v1/agent/run                         — caller-managed history
 *   POST /v1/agent/sessions/:sessionId/turns   — server-managed history
 *
 * Both paths share the same orchestrator (architecture-decision §3.3 — run
 * and turn differ only in history custody and persistence, not in planning).
 *
 * All schemas chain `.strict()` per CLAUDE.md rule 10. None of these are
 * LLM tool-call shapes — they are HTTP contract shapes that MUST fail closed
 * on unknown keys.
 */

import { z } from 'zod';
import { MAX_AGENT_HTTP_QUERY_CHARS } from '../constants.js';

/** Hard cap on the number of messages in a single agent request. Bounded so
 *  a runaway client cannot exhaust the planner's context window. The value
 *  trades off (a) realistic multi-turn conversations (≤ 20 turns is
 *  generous for wine discovery) against (b) protection from accidental
 *  payload explosion via a long history. Tightened later if production
 *  conversations show a tighter natural ceiling. */
const MAX_AGENT_MESSAGES = 64;
/** Hard cap on the per-message `content` string. Mirrors the per-query
 *  `MAX_AGENT_HTTP_QUERY_CHARS` since a single message body is bounded by
 *  the same "max sensible user utterance" reasoning. Codepoint-counted at
 *  the schema layer (see the `messages` refinement). */
const MAX_AGENT_MESSAGE_CONTENT_CHARS = MAX_AGENT_HTTP_QUERY_CHARS;
/** Hard cap on the `name` field — used for tool messages to identify the
 *  tool that produced the content. Short ASCII identifiers in practice. */
const MAX_AGENT_MESSAGE_NAME_CHARS = 256;
/** Hard cap on `metadata` object keys per message — a small bag for client
 *  routing/correlation, not a free-form payload. */
const MAX_AGENT_MESSAGE_METADATA_KEYS = 16;
/** Hard cap on the `client_session_id` and `client_turn_id` identifiers. */
const MAX_CLIENT_IDENTIFIER_CHARS = 128;
/** Hard cap on the `session_id` path parameter. Server-issued; bounded to
 *  protect URL parsing infrastructure from absurd routes. */
const MAX_SESSION_ID_CHARS = 128;
/** Hard cap on an optional ISO-8601 `timestamp` field on a single message.
 *  ISO-8601 with timezone offset and milliseconds maxes around 30 chars; 64
 *  gives headroom for non-standard timezone names without uncapped growth. */
const MAX_AGENT_MESSAGE_TIMESTAMP_CHARS = 64;
/** Hard cap on the per-step LLM timeout (ms). Mirrors `WineSearchRequestSchema`
 *  in `wine-search.schema.ts` — pinned here so the agent surface stays
 *  independent of that legacy schema during the transition. */
const AGENT_OPTIONS_PER_STEP_TIMEOUT_MAX_MS = 60_000;
/** Hard cap on the per-request total token budget (Anthropic Claude-4
 *  Sonnet context window). Same SSoT reasoning as the timeout above. */
const AGENT_OPTIONS_TOTAL_TOKEN_MAX = 200_000;
/** Hard cap on the `context.locale` string (BCP-47 tags are ≤ ~12 chars
 *  in practice; 32 gives generous headroom for extended subtags). */
const MAX_AGENT_CONTEXT_LOCALE_CHARS = 32;
/** Hard cap on the `context.currency` string (ISO-4217 alpha codes are
 *  exactly 3 chars; 8 gives headroom for the rare extended cryptocurrency
 *  ticker without uncapped growth). */
const MAX_AGENT_CONTEXT_CURRENCY_CHARS = 8;
/** Lower bound on per-step and per-agent timeouts (ms). Below 1 s no LLM
 *  round-trip completes; documenting the bound makes it auditable. */
const AGENT_OPTIONS_TIMEOUT_MIN_MS = 1_000;
/** Lower bound on the per-request total token budget. Below 1k tokens the
 *  system prompt alone exhausts the budget. */
const AGENT_OPTIONS_TOTAL_TOKEN_MIN = 1_000;
/** Max bound on max_steps — chosen high enough to never gate, with the real
 *  runtime cap living in the orchestrator (`MAX_AGENT_STEPS_CAP`). The
 *  schema bound exists only to reject pathological 1B-step requests. */
const AGENT_OPTIONS_MAX_STEPS_CAP = 1_024;

function countCodepoints(value: string): number {
  let n = 0;
  for (const ch of value) {
    void ch;
    n += 1;
  }
  return n;
}

const AgentMessageContentSchema = z
  .string()
  .min(1)
  .refine(
    (s) => countCodepoints(s) <= MAX_AGENT_MESSAGE_CONTENT_CHARS,
    { message: `message content exceeds max length of ${String(MAX_AGENT_MESSAGE_CONTENT_CHARS)} codepoints` },
  );

export const AgentMessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type AgentMessageRole = z.infer<typeof AgentMessageRoleSchema>;

export const AgentMessageSchema = z.object({
  role: AgentMessageRoleSchema,
  content: AgentMessageContentSchema,
  /** Optional message identifier — used by tool messages to name the tool
   *  and by client-side dedup/replay logic. */
  name: z.string().min(1).max(MAX_AGENT_MESSAGE_NAME_CHARS).optional(),
  /** Optional ISO-8601 timestamp set by the client. Treated as informational;
   *  the server stamps its own `created_at` on persisted turns. */
  timestamp: z.string().min(1).max(MAX_AGENT_MESSAGE_TIMESTAMP_CHARS).optional(),
  /** Optional client-supplied routing/correlation bag. Bounded key count so
   *  it cannot grow into a free-form payload sink. */
  metadata: z
    .record(z.unknown())
    .refine(
      (rec) => Object.keys(rec).length <= MAX_AGENT_MESSAGE_METADATA_KEYS,
      { message: `metadata exceeds ${String(MAX_AGENT_MESSAGE_METADATA_KEYS)} keys` },
    )
    .optional(),
}).strict();
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

/** Per-request options. Identical shape to the legacy
 *  `WineSearchRequestSchema.options` so the orchestrator integration is a
 *  pass-through during the migration. Field bounds and reasoning are
 *  documented on the original schema (see `wine-search.schema.ts`). */
export const AgentOptionsSchema = z.object({
  max_steps: z.number().int().min(1).max(AGENT_OPTIONS_MAX_STEPS_CAP).optional(),
  per_step_timeout_ms: z.number().int().finite()
    .min(AGENT_OPTIONS_TIMEOUT_MIN_MS)
    .max(AGENT_OPTIONS_PER_STEP_TIMEOUT_MAX_MS)
    .optional(),
  agent_timeout_ms: z.number().int().finite()
    .min(AGENT_OPTIONS_TIMEOUT_MIN_MS)
    .optional(),
  max_total_tokens: z.number().int().finite()
    .min(AGENT_OPTIONS_TOTAL_TOKEN_MIN)
    .max(AGENT_OPTIONS_TOTAL_TOKEN_MAX)
    .optional(),
}).strict();
export type AgentOptions = z.infer<typeof AgentOptionsSchema>;

/** Optional request-wide context. Currently locale/currency only; expand
 *  here when adding caller-injected execution context (not session/history). */
export const AgentContextSchema = z.object({
  locale: z.string().min(1).max(MAX_AGENT_CONTEXT_LOCALE_CHARS).optional(),
  currency: z.string().min(1).max(MAX_AGENT_CONTEXT_CURRENCY_CHARS).optional(),
}).strict();
export type AgentContext = z.infer<typeof AgentContextSchema>;

const MessagesArraySchema = z
  .array(AgentMessageSchema)
  .min(1, 'messages must contain at least one entry')
  .max(MAX_AGENT_MESSAGES, `messages exceed cap of ${String(MAX_AGENT_MESSAGES)}`);

/**
 * `POST /v1/agent/run` — single-shot, caller-managed history. The caller is
 * responsible for stitching prior turns into `messages[]`; the server does
 * not retain state between calls.
 */
export const AgentRunRequestSchema = z.object({
  messages: MessagesArraySchema,
  context: AgentContextSchema.optional(),
  options: AgentOptionsSchema.optional(),
}).strict();
export type AgentRunRequestBody = z.infer<typeof AgentRunRequestSchema>;

/**
 * `POST /v1/agent/sessions` — create a server-managed session. The server
 * mints a `session_id` and the caller appends turns via the `/turns` route.
 *
 * `client_session_id` is the idempotency key — replaying with the same id
 * returns the same session (T-IR-03 wires this against
 * {@link AgentSessionStorePort}).
 */
export const AgentSessionCreateRequestSchema = z.object({
  client_session_id: z.string().min(1).max(MAX_CLIENT_IDENTIFIER_CHARS).optional(),
  context: AgentContextSchema.optional(),
  options: AgentOptionsSchema.optional(),
}).strict();
export type AgentSessionCreateRequestBody = z.infer<typeof AgentSessionCreateRequestSchema>;

/**
 * `POST /v1/agent/sessions/:sessionId/turns` — append a turn to a
 * server-managed session. The server reads prior turns from the session
 * store and stitches them with `messages` from this body to form the
 * effective history (architecture-decision §3.2).
 *
 * `client_turn_id` is the idempotency key. `expected_session_version`
 * enables optimistic-concurrency rejection — when set, the server fails
 * closed if the session's current version does not match.
 */
export const AgentSessionTurnRequestSchema = z.object({
  client_turn_id: z.string().min(1).max(MAX_CLIENT_IDENTIFIER_CHARS),
  messages: MessagesArraySchema,
  context: AgentContextSchema.optional(),
  options: AgentOptionsSchema.optional(),
  expected_session_version: z.number().int().finite().nonnegative().optional(),
}).strict();
export type AgentSessionTurnRequestBody = z.infer<typeof AgentSessionTurnRequestSchema>;

/** Path params for the turn route — exposed so the route registration site
 *  validates the URL parameter alongside the body. */
export const AgentSessionTurnParamsSchema = z.object({
  sessionId: z.string().min(1).max(MAX_SESSION_ID_CHARS),
}).strict();
export type AgentSessionTurnParams = z.infer<typeof AgentSessionTurnParamsSchema>;
