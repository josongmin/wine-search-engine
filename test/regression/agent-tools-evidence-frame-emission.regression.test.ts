/**
 * ADR-009 Phase 0: `executeAgentTool` emits an evidence frame when (and
 * only when) the caller supplies `toolCallId`. Feature-flag off (no
 * toolCallId) preserves the pre-ADR-009 shape for legacy call sites.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it, vi } from 'vitest';
import { executeAgentTool } from '../../src/application/agent/agent-tools.js';
import type { AgentToolDeps } from '../../src/application/agent/agent-tools.js';
import type { SearchResponseV1 } from '../../src/domain/response/model/search-response.js';
import { TOOL_EVIDENCE_FRAME_SCHEMA_VERSION } from '../../src/domain/agent/model/tool-call-evidence-frame.js';

function makeDeps(response: SearchResponseV1): AgentToolDeps {
  return {
    searchUseCase: { execute: vi.fn().mockResolvedValue(response) },
  };
}

function buildSearchResponse(results: SearchResponseV1['results']): SearchResponseV1 {
   
  return {
    queryType: 'search' as const,
    engineDecision: {} as never,
    results,
    meta: {} as never,
  };
}

describe('executeAgentTool evidence frame emission', () => {
  it('omits evidenceFrame when caller does not supply toolCallId (legacy path)', async () => {
    const response = buildSearchResponse([]);
    const result = await executeAgentTool(
      'search_wines',
      { query: 'opus one' },
      makeDeps(response),
      'req-legacy',
      // No toolCallId passed.
    );
    expect(result.evidenceFrame).toBeUndefined();
    expect(typeof result.observation).toBe('string');
  });

  it('emits evidenceFrame tagged with search_result_set when toolCallId provided', async () => {
    const response = buildSearchResponse([]);
    const result = await executeAgentTool(
      'search_wines',
      { query: 'opus one' },
      makeDeps(response),
      'req-1',
      { toolCallId: 'req-1-s0' },
    );
    expect(result.evidenceFrame).toBeDefined();
    expect(result.evidenceFrame?.frameSchemaVersion).toBe(TOOL_EVIDENCE_FRAME_SCHEMA_VERSION);
    expect(result.evidenceFrame?.toolCallId).toBe('req-1-s0');
    expect(result.evidenceFrame?.structuredOutput.kind).toBe('search_result_set');
    expect(result.evidenceFrame?.observationSnapshot).toBe(result.observation);
  });

  it('emits tool_error frame on Zod validation failure', async () => {
     
    const badInput = { query: 123 as unknown as string };
    const result = await executeAgentTool(
      'search_wines',
      badInput,
      makeDeps(buildSearchResponse([])),
      'req-bad',
      { toolCallId: 'req-bad-s0' },
    );
    expect(result.evidenceFrame?.structuredOutput.kind).toBe('tool_error');
    if (result.evidenceFrame?.structuredOutput.kind === 'tool_error') {
      expect(result.evidenceFrame.structuredOutput.errorCode).toBe('INVALID_INPUT');
    }
  });

  it('emits no_op frame when called with an unknown tool', async () => {
    const result = await executeAgentTool(
      'telepathy',
      {},
      makeDeps(buildSearchResponse([])),
      'req-unk',
      { toolCallId: 'req-unk-s0' },
    );
    expect(result.evidenceFrame?.structuredOutput.kind).toBe('no_op');
  });
});
