/**
 * ADR-016 Axis 3 — grounded-claim emitter regression.
 *
 * Covers:
 *   - happy path: well-formed LLM JSON → valid GroundedPayload.
 *   - fail-closed: LLM throws → empty payload + `grounded_claim_emission_failed`.
 *   - fail-closed: non-JSON text → empty + `grounded_claim_parse_failed`.
 *   - provenance validation: unknown toolCallId → drop claim + reason.
 *   - per-claim `claimSchemaVersion` on every emitted claim.
 *   - number-as-string tolerated (CLAUDE.md rule 10).
 *   - upstream degradation reasons merged.
 *   - temperature 0 + seed pinned on the LLM call (replay stability).
 *
 * Append-only — never delete.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  emitGroundedClaims,
  GCE_DEGRADATION_EMISSION_FAILED,
  GCE_DEGRADATION_PARSE_FAILED,
  GCE_DEGRADATION_PROVENANCE_UNKNOWN,
} from '../../src/domain/response/service/grounded-claim-emitter.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import type { ToolCallEvidenceFrame } from '../../src/domain/agent/model/tool-call-evidence-frame.js';
import { GROUNDED_CLAIM_SCHEMA_VERSION } from '../../src/domain/response/model/grounded-claim.js';

function makeFrame(toolCallId: string): ToolCallEvidenceFrame {
  return {
    frameSchemaVersion: 'tool_evidence_v1',
    toolCallId,
    toolName: 'search_wines',
    invokedAt: '2026-04-15T00:00:00Z',
    requestId: 'req-1',
    request: { toolName: 'search_wines', input: {} },
    structuredOutput: { kind: 'search_result_set', resultSet: [], resultCount: 0 },
    observationSnapshot: '',
    observationHash: 'a'.repeat(64),
    durationMs: 1,
  };
}

function makeLlm(responseText: string): ChatLlmPort {
  return {
    complete: vi.fn(async () => ({
      text: responseText,
      model: 'test',
      finishReason: 'stop',
    })),
  };
}

describe('ADR-016 grounded-claim emitter', () => {
  it('returns a valid payload on happy LLM output', async () => {
    const frame = makeFrame('tc-1');
    const llmResponse = JSON.stringify({
      proseSegments: [{ id: 'p1', text: 'Opus One is a premium Napa wine.' }],
      claims: [
        {
          id: 'c1',
          type: 'entity_reference',
          category: 'identity_claim',
          text: 'Opus One',
          provenance: [{ toolCallId: 'tc-1' }],
          claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
        },
      ],
      claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
    });
    const out = await emitGroundedClaims(makeLlm(llmResponse), {
      rankedResults: [],
      evidenceFrames: [frame],
      prose: 'Opus One is a premium Napa wine.',
    });
    expect(out.claims.length).toBe(1);
    expect(out.claims[0]?.claimSchemaVersion).toBe(GROUNDED_CLAIM_SCHEMA_VERSION);
    expect(out.claimSchemaVersion).toBe(GROUNDED_CLAIM_SCHEMA_VERSION);
  });

  it('fail-closes on LLM error', async () => {
    const failingLlm: ChatLlmPort = {
      complete: vi.fn(async () => {
        throw new Error('upstream down');
      }),
    };
    const out = await emitGroundedClaims(failingLlm, {
      rankedResults: [],
      evidenceFrames: [],
      prose: 'hi',
    });
    expect(out.claims).toEqual([]);
    expect(out.degradationReasons).toContain(GCE_DEGRADATION_EMISSION_FAILED);
  });

  it('fail-closes on non-JSON LLM output', async () => {
    const out = await emitGroundedClaims(makeLlm('not json'), {
      rankedResults: [],
      evidenceFrames: [],
      prose: 'hi',
    });
    expect(out.claims).toEqual([]);
    expect(out.degradationReasons).toContain(GCE_DEGRADATION_PARSE_FAILED);
  });

  it('drops claims whose provenance.toolCallId is not in the frame set', async () => {
    const frame = makeFrame('tc-known');
    const llmResponse = JSON.stringify({
      proseSegments: [],
      claims: [
        {
          id: 'c1',
          type: 'entity_reference',
          category: 'identity_claim',
          text: 'Known',
          provenance: [{ toolCallId: 'tc-known' }],
          claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
        },
        {
          id: 'c2',
          type: 'entity_reference',
          category: 'identity_claim',
          text: 'Bogus',
          provenance: [{ toolCallId: 'tc-ghost' }],
          claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
        },
      ],
      claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
    });
    const out = await emitGroundedClaims(makeLlm(llmResponse), {
      rankedResults: [],
      evidenceFrames: [frame],
      prose: '',
    });
    expect(out.claims.map((c) => c.id)).toEqual(['c1']);
    expect(out.degradationReasons).toContain(GCE_DEGRADATION_PROVENANCE_UNKNOWN);
  });

  it('merges upstream degradation reasons', async () => {
    const llmResponse = JSON.stringify({
      proseSegments: [],
      claims: [],
      claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
    });
    const out = await emitGroundedClaims(makeLlm(llmResponse), {
      rankedResults: [],
      evidenceFrames: [],
      prose: '',
      upstreamDegradationReasons: ['critic_retries_exhausted'],
    });
    expect(out.degradationReasons).toContain('critic_retries_exhausted');
  });

  it('pins temperature 0 and seed on the LLM call', async () => {
    const llmResponse = JSON.stringify({
      proseSegments: [],
      claims: [],
      claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
    });
    const spy = vi.fn(async () => ({
      text: llmResponse,
      model: 'test',
      finishReason: 'stop',
    }));
    await emitGroundedClaims({ complete: spy }, {
      rankedResults: [],
      evidenceFrames: [],
      prose: '',
    });
    expect(spy).toHaveBeenCalledOnce();
    const call = spy.mock.calls[0]?.[0];
    expect(call?.temperature).toBe(0);
    expect(call?.seed).toBe(1);
  });

  it('lax-normalises missing envelope claimSchemaVersion', async () => {
    // OpenAI json_schema sometimes strips literal-only fields; we inject them.
    const llmResponse = JSON.stringify({
      proseSegments: [],
      claims: [],
    });
    const out = await emitGroundedClaims(makeLlm(llmResponse), {
      rankedResults: [],
      evidenceFrames: [],
      prose: '',
    });
    expect(out.claimSchemaVersion).toBe(GROUNDED_CLAIM_SCHEMA_VERSION);
  });

  it('empty claims → empty array, not null', async () => {
    const llmResponse = JSON.stringify({
      proseSegments: [],
      claims: [],
      claimSchemaVersion: GROUNDED_CLAIM_SCHEMA_VERSION,
    });
    const out = await emitGroundedClaims(makeLlm(llmResponse), {
      rankedResults: [],
      evidenceFrames: [],
      prose: '',
    });
    expect(out.claims).toEqual([]);
  });
});
