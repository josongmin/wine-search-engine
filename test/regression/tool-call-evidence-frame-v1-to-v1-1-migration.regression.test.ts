/**
 * ADR-009 + ADR-015 invariant: ToolCallEvidenceFrame v1 → v1.1 schema
 * migration is a pure superset.
 *
 * Locks:
 *   - v1 envelopes (no `retryCount`) parse unchanged under the v1.1
 *     Zod schema and produce hashes identical to pre-PR6.
 *   - v1.1 envelopes carry `retryCount` and produce distinct
 *     `observationHash` values for byte-identical observations across
 *     different retry counts.
 *   - `retryCount=0` and `retryCount=undefined` produce different
 *     hashes (the retry-count suffix is only appended when the field
 *     is set). This preserves v1 hash stability while still surfacing
 *     a deterministic v1.1 hash for retryCount=0.
 *   - Unknown schema versions fail closed.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  TOOL_EVIDENCE_FRAME_SCHEMA_VERSION,
  TOOL_EVIDENCE_FRAME_SCHEMA_VERSION_V1_1,
  ToolCallEvidenceFrameSchema,
} from '../../src/domain/agent/model/tool-call-evidence-frame.js';
import { buildToolCallEvidenceFrame } from '../../src/domain/agent/service/build-tool-call-evidence-frame.js';

describe('ToolCallEvidenceFrame v1 → v1.1 migration', () => {
  it('v1 envelope (no retryCount) parses under v1.1 schema unchanged', () => {
    const v1Envelope = {
      frameSchemaVersion: TOOL_EVIDENCE_FRAME_SCHEMA_VERSION,
      toolCallId: 'req-1-s0',
      toolName: 'search_wines',
      invokedAt: '2026-04-15T00:00:00.000Z',
      requestId: 'req-1',
      request: { toolName: 'search_wines', input: { query: 'opus one' } },
      structuredOutput: { kind: 'no_op' as const, reason: 'stub' },
      observationSnapshot: 'obs',
      observationHash: createHash('sha256').update('obs', 'utf8').digest('hex'),
      durationMs: 1,
    };
    const parsed = ToolCallEvidenceFrameSchema.safeParse(v1Envelope);
    expect(parsed.success).toBe(true);
  });

  it('v1.1 envelope carries retryCount and serialises with v1.1 schema string', () => {
    const frame = buildToolCallEvidenceFrame({
      toolCallId: 'req-1-s0',
      toolName: 'search_wines',
      requestId: 'req-1',
      input: { query: 'opus one' },
      structuredOutput: { kind: 'search_result_set', resultSet: [], resultCount: 0 },
      observation: 'obs',
      invokedAt: new Date('2026-04-15T00:00:00Z'),
      durationMs: 1,
      retryCount: 1,
    });
    expect(frame.frameSchemaVersion).toBe(TOOL_EVIDENCE_FRAME_SCHEMA_VERSION_V1_1);
    expect(frame.retryCount).toBe(1);
    expect(ToolCallEvidenceFrameSchema.safeParse(frame).success).toBe(true);
  });

  it('byte-identical observations across retry counts produce DISTINCT observationHash values', () => {
    const obs = 'observation text';
    const r0 = buildToolCallEvidenceFrame({
      toolCallId: 'a',
      toolName: 'search_wines',
      requestId: 'r',
      input: {},
      structuredOutput: { kind: 'no_op', reason: 'x' },
      observation: obs,
      invokedAt: new Date(0),
      durationMs: 0,
      retryCount: 0,
    });
    const r1 = buildToolCallEvidenceFrame({
      toolCallId: 'a',
      toolName: 'search_wines',
      requestId: 'r',
      input: {},
      structuredOutput: { kind: 'no_op', reason: 'x' },
      observation: obs,
      invokedAt: new Date(0),
      durationMs: 0,
      retryCount: 1,
    });
    const r2 = buildToolCallEvidenceFrame({
      toolCallId: 'a',
      toolName: 'search_wines',
      requestId: 'r',
      input: {},
      structuredOutput: { kind: 'no_op', reason: 'x' },
      observation: obs,
      invokedAt: new Date(0),
      durationMs: 0,
      retryCount: 2,
    });
    expect(r0.observationHash).not.toBe(r1.observationHash);
    expect(r1.observationHash).not.toBe(r2.observationHash);
    expect(r0.observationHash).not.toBe(r2.observationHash);
  });

  it('omitting retryCount preserves pre-PR6 v1 hash stability', () => {
    const obs = 'stable observation';
    const noRetry = buildToolCallEvidenceFrame({
      toolCallId: 'a',
      toolName: 'search_wines',
      requestId: 'r',
      input: {},
      structuredOutput: { kind: 'no_op', reason: 'x' },
      observation: obs,
      invokedAt: new Date(0),
      durationMs: 0,
    });
    const expected = createHash('sha256').update(obs, 'utf8').digest('hex');
    expect(noRetry.observationHash).toBe(expected);
    expect(noRetry.frameSchemaVersion).toBe(TOOL_EVIDENCE_FRAME_SCHEMA_VERSION);
    expect(noRetry.retryCount).toBeUndefined();
  });

  it('unknown frameSchemaVersion fails Zod parse closed', () => {
    const bogus = {
      frameSchemaVersion: 'tool_evidence_v999',
      toolCallId: 'x',
      toolName: 'search_wines',
      invokedAt: '2026-04-15T00:00:00.000Z',
      requestId: 'x',
      request: { toolName: 'search_wines', input: {} },
      structuredOutput: { kind: 'no_op' as const, reason: 'x' },
      observationSnapshot: 'x',
      observationHash: 'a'.repeat(64),
      durationMs: 0,
    };
    expect(ToolCallEvidenceFrameSchema.safeParse(bogus).success).toBe(false);
  });
});

describe('hybrid-candidates wiring lock (PR4 deferred wiring picked up)', () => {
  it('search-usecase-hybrid-candidates.ts routes the generic hybrid retrieval through executeGraphAware', async () => {
    // Grep regression: locks the wiring done in PR6. If a future refactor
    // drops the `executeGraphAware` call, this test fires loud.
    const fs = await import('node:fs');
    const url = await import('node:url');
    const path = await import('node:path');
    const REPO_ROOT = path.resolve(
      url.fileURLToPath(new URL('../../', import.meta.url)),
    );
    const file = fs.readFileSync(
      path.join(REPO_ROOT, 'src/application/search/search-usecase-hybrid-candidates.ts'),
      'utf8',
    );
    expect(file).toMatch(/await\s+executeGraphAware\(/);
    // The previous direct candidatePool.execute path must NOT be the
    // last expression assigned to `candidates` — it lives only inside
    // executeGraphAware now.
    const directExecuteHits = file.match(
      /const\s+candidates\s*=\s*ports\.candidatePool\.execute/,
    );
    expect(directExecuteHits).toBeNull();
  });
});
