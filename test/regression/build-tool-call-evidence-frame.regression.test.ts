/**
 * ADR-009 Phase 0: invariants on the frame builder utility + toolCallId
 * conventions. Locks the correlation contract that downstream phases
 * (CRAG executor retry and provenance audits) depend on.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import {
  buildToolCallEvidenceFrame,
  toolCallIdForBatchItem,
  toolCallIdForStep,
} from '../../src/domain/agent/service/build-tool-call-evidence-frame.js';

describe('toolCallId conventions', () => {
  it('sequential ID format: ${requestId}-s${stepIndex}', () => {
    expect(toolCallIdForStep('req-42', 0)).toBe('req-42-s0');
    expect(toolCallIdForStep('req-42', 7)).toBe('req-42-s7');
  });

  it('batch item ID format: ${requestId}-s${stepIndex}-p${toolIndex}', () => {
    expect(toolCallIdForBatchItem('req-42', 0, 0)).toBe('req-42-s0-p0');
    expect(toolCallIdForBatchItem('req-42', 3, 2)).toBe('req-42-s3-p2');
  });

  it('batch IDs are unique within a step for any batch size', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 16; i++) {
      ids.add(toolCallIdForBatchItem('req-x', 0, i));
    }
    expect(ids.size).toBe(16);
  });
});

describe('buildToolCallEvidenceFrame', () => {
  it('same inputs produce byte-identical frames (deterministic except timing)', () => {
    const a = buildToolCallEvidenceFrame({
      toolCallId: 'id',
      toolName: 'search_wines',
      requestId: 'rid',
      input: { query: 'opus one' },
      structuredOutput: { kind: 'search_result_set', resultSet: [], resultCount: 0 },
      observation: 'hello',
      invokedAt: new Date('2026-04-15T00:00:00Z'),
      durationMs: 100,
    });
    const b = buildToolCallEvidenceFrame({
      toolCallId: 'id',
      toolName: 'search_wines',
      requestId: 'rid',
      input: { query: 'opus one' },
      structuredOutput: { kind: 'search_result_set', resultSet: [], resultCount: 0 },
      observation: 'hello',
      invokedAt: new Date('2026-04-15T00:00:00Z'),
      durationMs: 100,
    });
    expect(a).toEqual(b);
  });

  it('different observation → different hash → different frame', () => {
    const base = {
      toolCallId: 'id',
      toolName: 'search_wines',
      requestId: 'rid',
      input: {},
      structuredOutput: { kind: 'no_op' as const, reason: 'x' },
      invokedAt: new Date('2026-04-15T00:00:00Z'),
      durationMs: 0,
    };
    const a = buildToolCallEvidenceFrame({ ...base, observation: 'one' });
    const b = buildToolCallEvidenceFrame({ ...base, observation: 'two' });
    expect(a.observationHash).not.toBe(b.observationHash);
    expect(a.observationSnapshot).not.toBe(b.observationSnapshot);
  });

  it('invokedAt is serialized as ISO-8601 UTC', () => {
    const frame = buildToolCallEvidenceFrame({
      toolCallId: 'x',
      toolName: 'search_wines',
      requestId: 'x',
      input: {},
      structuredOutput: { kind: 'no_op', reason: 'x' },
      observation: 'x',
      invokedAt: new Date('2026-04-15T03:14:15.926Z'),
      durationMs: 0,
    });
    expect(frame.invokedAt).toBe('2026-04-15T03:14:15.926Z');
  });
});
