/**
 * ADR-009 Phase 0 invariant: `ToolCallEvidenceFrame` carries explicit
 * schema versioning, deterministic observation hashing, and a closed
 * `structuredOutput` discriminated union. Regression locks the contract.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  TOOL_EVIDENCE_FRAME_SCHEMA_VERSION,
  ToolCallEvidenceFrameSchema,
} from '../../src/domain/agent/model/tool-call-evidence-frame.js';
import { buildToolCallEvidenceFrame } from '../../src/domain/agent/service/build-tool-call-evidence-frame.js';

describe('ToolCallEvidenceFrame schema', () => {
  it('schema version is pinned to tool_evidence_v1', () => {
    expect(TOOL_EVIDENCE_FRAME_SCHEMA_VERSION).toBe('tool_evidence_v1');
  });

  it('observationHash is SHA-256 of observationSnapshot (byte-equivalent)', () => {
    const obs = '결과: 오푸스 원 2018, 가격 $450';
    const frame = buildToolCallEvidenceFrame({
      toolCallId: 'req-1-s0',
      toolName: 'search_hybrid',
      requestId: 'req-1',
      input: { query: 'opus one' },
      structuredOutput: { kind: 'search_result_set', resultSet: [], resultCount: 0 },
      observation: obs,
      invokedAt: new Date('2026-04-15T00:00:00Z'),
      durationMs: 42,
    });
    const expected = createHash('sha256').update(obs, 'utf8').digest('hex');
    expect(frame.observationHash).toBe(expected);
    expect(frame.observationHash).toHaveLength(64);
  });

  it('rejects frame without frameSchemaVersion', () => {
    const bad = {
      toolCallId: 'x',
      toolName: 'search_hybrid',
      invokedAt: '2026-04-15T00:00:00.000Z',
      requestId: 'x',
      request: { toolName: 'search_hybrid', input: {} },
      structuredOutput: { kind: 'no_op', reason: 'test' },
      observationSnapshot: 'x',
      observationHash: 'a'.repeat(64),
      durationMs: 0,
    };
    expect(ToolCallEvidenceFrameSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects frame with observationHash of wrong length', () => {
    const frame = buildToolCallEvidenceFrame({
      toolCallId: 'x',
      toolName: 'search_hybrid',
      requestId: 'x',
      input: {},
      structuredOutput: { kind: 'no_op', reason: 'test' },
      observation: 'x',
      invokedAt: new Date(),
      durationMs: 0,
    });
    const tampered = { ...frame, observationHash: 'short-hash' };
    expect(ToolCallEvidenceFrameSchema.safeParse(tampered).success).toBe(false);
  });

  it('accepts every canonical structuredOutput kind', () => {
    const kinds = [
      { kind: 'search_result_set', resultSet: [], resultCount: 0 },
      { kind: 'food_pairing', resultSet: [], resultCount: 0, food: 'steak' },
      { kind: 'tool_error', errorCode: 'INVALID_INPUT', message: 'bad' },
      { kind: 'no_op', reason: 'x' },
    ] as const;
    for (const structuredOutput of kinds) {
      const frame = buildToolCallEvidenceFrame({
        toolCallId: 'x',
        toolName: 'search_hybrid',
        requestId: 'x',
        input: {},
        structuredOutput,
        observation: 'x',
        invokedAt: new Date(),
        durationMs: 0,
      });
      expect(ToolCallEvidenceFrameSchema.safeParse(frame).success).toBe(true);
    }
  });

  it('rejects frame with an unknown structuredOutput.kind', () => {
    const frame = buildToolCallEvidenceFrame({
      toolCallId: 'x',
      toolName: 'search_hybrid',
      requestId: 'x',
      input: {},
      structuredOutput: { kind: 'no_op', reason: 'test' },
      observation: 'x',
      invokedAt: new Date(),
      durationMs: 0,
    });
    const tampered: unknown = {
      ...frame,
      structuredOutput: { kind: 'ungrounded_telepathy', payload: {} },
    };
    expect(ToolCallEvidenceFrameSchema.safeParse(tampered).success).toBe(false);
  });
});
