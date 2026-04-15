/**
 * ADR-009 Phase 0: Structured Evidence Carrier.
 *
 * Every agent tool call emits one `ToolCallEvidenceFrame` alongside the
 * human-readable observation string. The frame carries the same payload
 * as typed structured data plus replay metadata (hash, schema version,
 * timing, request correlation).
 *
 * Downstream consumers (bench evaluator, claim verifier in Phase 3 GCE,
 * retrieval critic in Phase 2) read `structuredOutput` directly. They must
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
 */
export const TOOL_EVIDENCE_FRAME_SCHEMA_VERSION = 'tool_evidence_v1';
export type ToolEvidenceFrameSchemaVersion = typeof TOOL_EVIDENCE_FRAME_SCHEMA_VERSION;

/** Closed tuple of tool names that emit frames (all current agent tools). */
export const FRAME_EMITTING_TOOLS = [
  'search_wines',
  'compare_wines',
  'check_drinking_window',
  'get_food_pairings',
] as const;
export type FrameEmittingToolName = typeof FRAME_EMITTING_TOOLS[number];

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

export type StructuredOutputKind = ToolCallStructuredOutput['kind'];

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
}

// ─── Zod schema (runtime validation / replay contract) ────────────────────────

/** Upper bound on the observation snapshot length — must match the cap in
 *  `agent-tools.ts` MAX_OBSERVATION_CHARS + slack for the truncation sentinel. */
const OBSERVATION_SNAPSHOT_MAX_LEN = 2_200;
/** SHA-256 hex digest = 64 chars. */
const OBSERVATION_HASH_LEN = 64;
/** Upper bound on toolCallId — request-id derived, bounded by agent step budget. */
const TOOL_CALL_ID_MAX_LEN = 256;

const ToolCallRequestSchema = z.object({
  toolName: z.string().min(1).max(128),
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

export const ToolCallEvidenceFrameSchema = z.object({
  frameSchemaVersion: z.literal(TOOL_EVIDENCE_FRAME_SCHEMA_VERSION),
  toolCallId: z.string().min(1).max(TOOL_CALL_ID_MAX_LEN),
  toolName: z.string().min(1).max(128),
  invokedAt: z.string().min(1),
  requestId: z.string().min(1).max(TOOL_CALL_ID_MAX_LEN),
  request: ToolCallRequestSchema,
  structuredOutput: ToolCallStructuredOutputSchema,
  observationSnapshot: z.string().max(OBSERVATION_SNAPSHOT_MAX_LEN),
  observationHash: z.string().length(OBSERVATION_HASH_LEN),
  durationMs: z.number().finite().nonnegative(),
}).strict();

export type ToolCallEvidenceFrameValidated = z.infer<typeof ToolCallEvidenceFrameSchema>;
