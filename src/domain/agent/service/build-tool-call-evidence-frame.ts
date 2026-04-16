/**
 * ADR-009 Phase 0: construct a ToolCallEvidenceFrame from the inputs and
 * output of an agent tool invocation.
 *
 * Pure function — no I/O. Kept as a service (not inline in agent-tools.ts)
 * so it can be unit-tested in isolation and so other callers (parallel batch
 * dispatcher, test harness) can reuse the exact same construction.
 */

import { createHash } from 'node:crypto';
import {
  TOOL_EVIDENCE_FRAME_SCHEMA_VERSION,
  TOOL_EVIDENCE_FRAME_SCHEMA_VERSION_V1_1,
  type ToolCallEvidenceFrame,
  type ToolCallStructuredOutput,
} from '../model/tool-call-evidence-frame.js';

interface BuildToolCallEvidenceFrameInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly requestId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly structuredOutput: ToolCallStructuredOutput;
  readonly observation: string;
  readonly invokedAt: Date;
  readonly durationMs: number;
  /**
   * ADR-015 Axis 2: internal critic retry attempt number (0-based). When
   * supplied, the frame is emitted at schema v1.1 and the retry count is
   * folded into `observationHash` so byte-identical observations across
   * retries produce distinct hashes. `undefined` (the default) preserves
   * pre-PR6 v1 behaviour byte-for-byte.
   */
  readonly retryCount?: number | undefined;
}

/** SHA-256 hex digest, 64 lowercase chars. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function buildToolCallEvidenceFrame(
  input: BuildToolCallEvidenceFrameInput,
): ToolCallEvidenceFrame {
  // ADR-015 hash contract:
  //   - retryCount === undefined  → hash = sha256(observation)
  //                                 (v1 behaviour, byte-identical pre-PR6)
  //   - retryCount !== undefined  → hash = sha256(observation + `|retry=${n}`)
  //                                 (v1.1 behaviour; collision-breaking)
  // The suffix is only appended when `retryCount` is set so that v1 frames
  // re-emitted without critic context stay hash-stable.
  const hashInput =
    input.retryCount === undefined
      ? input.observation
      : `${input.observation}|retry=${input.retryCount}`;
  const frameSchemaVersion =
    input.retryCount === undefined
      ? TOOL_EVIDENCE_FRAME_SCHEMA_VERSION
      : TOOL_EVIDENCE_FRAME_SCHEMA_VERSION_V1_1;
  return {
    frameSchemaVersion,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    invokedAt: input.invokedAt.toISOString(),
    requestId: input.requestId,
    request: {
      toolName: input.toolName,
      input: input.input,
    },
    structuredOutput: input.structuredOutput,
    observationSnapshot: input.observation,
    observationHash: sha256Hex(hashInput),
    durationMs: input.durationMs,
    ...(input.retryCount !== undefined ? { retryCount: input.retryCount } : {}),
  };
}

/**
 * Convention used across the agent codebase:
 *  - sequential call: `${requestId}-s${stepIndex}`
 *  - parallel batch : `${requestId}-s${stepIndex}-p${toolIndex}`
 *
 * Matching this convention is what lets downstream consumers correlate the
 * frame with the `AgentStep.actionPairs[i]` entry without additional joins.
 */
export function toolCallIdForStep(requestId: string, stepIndex: number): string {
  return `${requestId}-s${stepIndex}`;
}

export function toolCallIdForBatchItem(
  requestId: string,
  stepIndex: number,
  toolIndex: number,
): string {
  return `${requestId}-s${stepIndex}-p${toolIndex}`;
}
