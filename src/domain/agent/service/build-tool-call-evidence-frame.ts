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
  type ToolCallEvidenceFrame,
  type ToolCallStructuredOutput,
} from '../model/tool-call-evidence-frame.js';

export interface BuildToolCallEvidenceFrameInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly requestId: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly structuredOutput: ToolCallStructuredOutput;
  readonly observation: string;
  readonly invokedAt: Date;
  readonly durationMs: number;
}

/** SHA-256 hex digest, 64 lowercase chars. */
function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function buildToolCallEvidenceFrame(
  input: BuildToolCallEvidenceFrameInput,
): ToolCallEvidenceFrame {
  return {
    frameSchemaVersion: TOOL_EVIDENCE_FRAME_SCHEMA_VERSION,
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
    observationHash: sha256Hex(input.observation),
    durationMs: input.durationMs,
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
