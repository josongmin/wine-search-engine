/**
 * ADR-009 Phase 0: `AgentResult` and `AgentStep` both carry optional
 * `evidenceFrames` fields. The bench runner's `evidenceFrameCoverage`
 * metric and Phase 3 `provenanceRef.toolCallId` both depend on these
 * fields being present in the public type surface.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import type { AgentResult } from '../../src/domain/agent/model/agent-result.js';
import type { AgentStep } from '../../src/domain/agent/model/agent-step.js';
import type { ToolCallEvidenceFrame } from '../../src/domain/agent/model/tool-call-evidence-frame.js';

describe('AgentResult / AgentStep evidenceFrames contract', () => {
  it('AgentResult.evidenceFrames is assignable from a ToolCallEvidenceFrame[]', () => {
    const frames: readonly ToolCallEvidenceFrame[] = [];
    const result = {
      answer: '',
      steps: [],
      totalDurationMs: 0,
      totalTokens: { input: 0, output: 0 },
      toolCallCount: 0,
      fallbackApplied: false,
      terminationReason: 'answer' as const,
      evidenceFrames: frames,
    } satisfies AgentResult;
    expect(result.evidenceFrames).toBe(frames);
  });

  it('AgentStep.evidenceFrames is optional and typed', () => {
    const step: AgentStep = {
      index: 0,
      thought: '',
      durationMs: 0,
      tokenCount: { input: 0, output: 0 },
    };
    expect(step.evidenceFrames).toBeUndefined();
  });

  it('AgentStep accepts evidenceFrames aligned with actionPairs', () => {
    const frames: readonly ToolCallEvidenceFrame[] = [];
    const step: AgentStep = {
      index: 0,
      thought: '',
      actionPairs: [{ action: { tool: 'search_wines', input: {} }, observation: 'x' }],
      durationMs: 0,
      tokenCount: { input: 0, output: 0 },
      evidenceFrames: frames,
    };
    expect(step.evidenceFrames).toBe(frames);
  });
});
