/**
 * ADR-009 Phase 0: Structured Evidence Carrier.
 *
 * Every agent tool call emits one `ToolCallEvidenceFrame` alongside the
 * human-readable observation string. The frame carries the same payload
 * as typed structured data plus replay metadata (hash, schema version,
 * timing, request correlation).
 *
 * Downstream consumers (bench evaluator, retrieval critic in Phase 2)
 * read `structuredOutput` directly. They must
 * NOT parse `observationSnapshot` — that field is retained only for prompt
 * audit / replay transparency.
 */

import { z } from 'zod';
import type { ComparisonSearchResponse } from '../../response/model/comparison-response.js';
import type { DrinkingWindowBlock, ResultItem } from '../../response/model/result-item.js';
import type { CanonicalEntityId } from '../../shared/types/index.js';

/**
 * Schema version tag. Carried per-frame so replay and bench harnesses can
 * detect schema drift deterministically. Increment when adding new
 * `structuredOutput.kind` variants or breaking a shape.
 *
 * ADR-015 Axis 2: v1.1 is a **pure superset** of v1. The only structural
 * change is an optional `retryCount` field used by the executor-internal
 * critic retry loop to break `observationHash` collisions on byte-identical
 * retries. Builders emit v1.1 when `retryCount !== undefined`; otherwise
 * they continue emitting v1 so pre-PR6 replays and hashes stay stable.
 */
export const TOOL_EVIDENCE_FRAME_SCHEMA_VERSION = 'tool_evidence_v1';
export const TOOL_EVIDENCE_FRAME_SCHEMA_VERSION_V1_1 = 'tool_evidence_v1_1';
export type ToolEvidenceFrameSchemaVersion =
  | typeof TOOL_EVIDENCE_FRAME_SCHEMA_VERSION
  | typeof TOOL_EVIDENCE_FRAME_SCHEMA_VERSION_V1_1;

/**
 * Typed, discriminated structured output. Closed union — adding a new tool
 * means adding a new variant AND bumping `TOOL_EVIDENCE_FRAME_SCHEMA_VERSION`.
 */
export type ToolCallStructuredOutput =
  | {
      readonly kind: 'search_result_set';
      readonly resultSet: readonly ResultItem[];
      readonly resultCount: number;
    }
  | {
      /**
       * Discriminator for `lookup_wine` (high-precision identity resolution).
       * Distinct from `search_result_set` so downstream consumers that run
       * search-specific invariants (negation/quality-tag/exact-lookup
       * contract guards) correctly skip lookup outputs rather than
       * mis-treating them as constraint-filtered search results.
       * See SOLID audit LSP-MED — lookup MUST NOT inherit search invariants.
       */
      readonly kind: 'lookup_result_set';
      readonly resultSet: readonly ResultItem[];
      readonly resultCount: number;
    }
  | {
      readonly kind: 'comparison_result';
      readonly response: ComparisonSearchResponse;
    }
  | {
      readonly kind: 'drinking_window';
      readonly entityId: CanonicalEntityId;
      readonly window: DrinkingWindowBlock;
      readonly targetYear: number;
    }
  | {
      readonly kind: 'food_pairing';
      readonly resultSet: readonly ResultItem[];
      readonly resultCount: number;
      readonly food: string;
    }
  | {
      readonly kind: 'tool_error';
      readonly errorCode: string;
      readonly message: string;
    }
  | {
      readonly kind: 'no_op';
      readonly reason: string;
    };

export interface ToolCallRequest {
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * The evidence frame. One per tool invocation, whether single or within a
 * parallel batch.
 *
 * `toolCallId` convention:
 *   - sequential call: `${requestId}-s${stepIndex}`
 *   - parallel batch  : `${requestId}-s${stepIndex}-p${toolIndex}`
 *
 * Downstream consumers read `structuredOutput` directly. `observationSnapshot`
 * is the exact text the LLM was shown (byte-equivalent); `observationHash` is
 * SHA-256 over that text and is what replay checks against.
 */
export interface ToolCallEvidenceFrame {
  readonly frameSchemaVersion: ToolEvidenceFrameSchemaVersion;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly invokedAt: string;                    // ISO-8601 UTC
  readonly requestId: string;
  readonly request: ToolCallRequest;
  readonly structuredOutput: ToolCallStructuredOutput;
  readonly observationSnapshot: string;
  readonly observationHash: string;              // sha256 hex, 64 chars
  readonly durationMs: number;
  /**
   * ADR-015 Axis 2: internal critic retry attempt number (0-based). Present
   * only when the frame was produced by a retry iteration of the
   * executor-internal self-critique loop. When present, it is folded into
   * `observationHash` input so byte-identical observations across retries
   * do not collide. Absent on all pre-PR6 frames and on the first
   * (non-retry) iteration; the absence preserves v1 hash stability.
   */
  readonly retryCount?: number | undefined;
}

// ─── Zod schema (runtime validation / replay contract) ────────────────────────

/** Upper bound on the observation snapshot length — must match the cap in
 *  `agent-tools.ts` MAX_OBSERVATION_CHARS + slack for the truncation sentinel. */
const OBSERVATION_SNAPSHOT_MAX_LEN = 2_200;
/** SHA-256 hex digest = 64 chars. */
const OBSERVATION_HASH_LEN = 64;
/** Upper bound on toolCallId — request-id derived, bounded by agent step budget. */
const TOOL_CALL_ID_MAX_LEN = 256;
/** Upper bound on tool names. Current tool names are ≤20 chars; 128 leaves
 *  headroom for future additions without unbounded growth. Repeated for both
 *  the request wrapper and the envelope. */
const TOOL_NAME_MAX_LEN = 128;

const ToolCallRequestSchema = z.object({
  toolName: z.string().min(1).max(TOOL_NAME_MAX_LEN),
  input: z.record(z.unknown()),
}).strict();

/** The schema is intentionally permissive on `structuredOutput.resultSet` /
 *  `response` / `window` — those shapes are owned by their respective domain
 *  modules and would cause a circular dep if re-validated here. Callers that
 *  need strict validation should chain `.pipe(ResultItemSchema.array())` etc. */
const ToolCallStructuredOutputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('search_result_set'),
    resultSet: z.array(z.unknown()),
    resultCount: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('lookup_result_set'),
    resultSet: z.array(z.unknown()),
    resultCount: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal('comparison_result'),
    response: z.unknown(),
  }).strict(),
  z.object({
    kind: z.literal('drinking_window'),
    entityId: z.string().min(1),
    window: z.unknown(),
    targetYear: z.number().int(),
  }).strict(),
  z.object({
    kind: z.literal('food_pairing'),
    resultSet: z.array(z.unknown()),
    resultCount: z.number().int().nonnegative(),
    food: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('tool_error'),
    errorCode: z.string().min(1),
    message: z.string(),
  }).strict(),
  z.object({
    kind: z.literal('no_op'),
    reason: z.string(),
  }).strict(),
]);

/** Upper bound on retryCount — `CRITIC_RETRY_MAX = 3` in
 *  retrieval-critic; 16 leaves headroom for future loop-cap bumps while
 *  keeping the validation bound auditable. */
const RETRY_COUNT_MAX = 16;

export const ToolCallEvidenceFrameSchema = z.object({
  frameSchemaVersion: z.union([
    z.literal(TOOL_EVIDENCE_FRAME_SCHEMA_VERSION),
    z.literal(TOOL_EVIDENCE_FRAME_SCHEMA_VERSION_V1_1),
  ]),
  toolCallId: z.string().min(1).max(TOOL_CALL_ID_MAX_LEN),
  toolName: z.string().min(1).max(TOOL_NAME_MAX_LEN),
  invokedAt: z.string().min(1),
  requestId: z.string().min(1).max(TOOL_CALL_ID_MAX_LEN),
  request: ToolCallRequestSchema,
  structuredOutput: ToolCallStructuredOutputSchema,
  observationSnapshot: z.string().max(OBSERVATION_SNAPSHOT_MAX_LEN),
  observationHash: z.string().length(OBSERVATION_HASH_LEN),
  durationMs: z.number().finite().nonnegative(),
  retryCount: z.number().int().nonnegative().max(RETRY_COUNT_MAX).optional(),
}).strict();
