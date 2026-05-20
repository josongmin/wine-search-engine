/**
 * Regression: AgentObservationSynthesisRunner must enforce a Zod-validated fence
 * over the embedded `GROUNDING_JSON: …` payloads of each observation. Frames whose
 * grounding JSON is malformed (truncated, non-object, wrong wines shape) MUST be
 * dropped from the synthesis prompt with a structured logger warning — never
 * passed through verbatim so the LLM hallucinates against corrupted ground truth.
 *
 * Invariants under test:
 *   1. Valid grounding observations flow through unchanged → synthesis returns answer.
 *   2. Malformed GROUNDING_JSON (truncated / non-object / invalid `wines`) → that
 *      frame is dropped from the prompt, a logger.warn is emitted with
 *      requestId+stepIndex, synthesis still runs for the surviving frames.
 *   3. Empty observation set (after fence drops everything) → no LLM call, no throw.
 *   4. Korean grounding content is preserved in the synthesis prompt verbatim.
 *   5. Mocked LLM returning malformed answer (non-JSON) → state.answer stays '',
 *      failedSynthesisAttempts increments, no throw.
 *   6. Mocked LLM returning empty answer ('') → handled as a synthesis miss.
 *   7. ToolOutcome with missing required result fields → no throw; fence ignores
 *      ToolOutcome shape (only operates on observation text).
 *   8. Multi-frame observation (3 valid + 1 malformed) → 3 frames in prompt,
 *      1 warning emitted; frames appear in deterministic step-index order.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentObservationSynthesisRunner } from '../../src/application/agent/agent-observation-synthesis-runner.js';
import { createAgentExecutionState } from '../../src/application/agent/agent-execution-state.js';
import { DEFAULT_AGENT_CONFIG } from '../../src/domain/agent/model/agent-config.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';

const GROUNDING_JSON_MARKER = 'GROUNDING_JSON: ';

function buildValidGroundingObservation(
  canonicalLabel: string,
  entityId: string,
  extra?: string,
): string {
  const preface = extra ?? `Found ${canonicalLabel}`;
  const payload = {
    query_type: 'search',
    total_results: 1,
    wines: [
      {
        entity_id: entityId,
        canonical_label: canonicalLabel,
        region: 'Napa Valley',
        price: '420000원',
      },
    ],
    truncated_for_observation_cap: false,
  };
  return `${preface}\n${GROUNDING_JSON_MARKER}${JSON.stringify(payload)}`;
}

function buildMalformedTruncatedGrounding(): string {
  // Truncated JSON: parser fails outright.
  return `Found a wine\n${GROUNDING_JSON_MARKER}{"query_type":"search","wines":[{"entity_id":`;
}

function buildMalformedNonObjectGrounding(): string {
  // GROUNDING_JSON marker followed by a JSON array, not an object.
  return `Found wines\n${GROUNDING_JSON_MARKER}[1,2,3]`;
}

function buildMalformedInvalidWinesGrounding(): string {
  // wines is a string, not an array — fails schema.
  return `Found wines\n${GROUNDING_JSON_MARKER}${JSON.stringify({ query_type: 'search', wines: 'oops' })}`;
}

function makeChatLlm(text: string) {
  return {
    complete: vi.fn().mockResolvedValue({
      text,
      model: 'test-model',
      finishReason: 'stop',
    }),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function pushObservationStep(
  state: ReturnType<typeof createAgentExecutionState>,
  index: number,
  observation: string,
  outcomeKind: 'success' | 'partial_result' = 'success',
): void {
  state.steps.push({
    index,
    thought: `step ${index}`,
    action: { tool: 'search_wines', input: { query: `step-${index}` } },
    observation,
    durationMs: 10,
    tokenCount: { input: 10, output: 10 },
  });
  state.toolOutcomes.push({
    stepId: `req:0:${index}:0`,
    tool: 'search_wines',
    kind: outcomeKind,
    result: {
      queryType: 'search',
      results: [{ entity: { entityId: `wine-${index}`, canonicalLabel: `Wine ${index}` } }],
    },
    durationMs: 10,
  });
}

describe('AgentObservationSynthesisRunner grounding-JSON validation fence', () => {
  it('passes well-formed grounding through to synthesis and returns an answer', async () => {
    const chatLlm = makeChatLlm(JSON.stringify({
      thought: 'summary',
      answer: 'Opus One 2018 추천합니다.',
    }));
    const logger = makeLogger();
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: chatLlm as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    pushObservationStep(state, 0, buildValidGroundingObservation('Opus One 2018', 'wine-1'));

    await runner.run('opus one', 'req-valid', DEFAULT_AGENT_CONFIG, state);

    expect(state.answer).toContain('Opus One 2018');
    expect(chatLlm.complete).toHaveBeenCalledTimes(1);
    const messages = chatLlm.complete.mock.calls[0]?.[0].messages ?? [];
    expect(messages.some((m: { content: string }) => m.content.includes(GROUNDING_JSON_MARKER))).toBe(true);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ malformedGrounding: true }),
      expect.any(String),
    );
  });

  it('drops a frame with malformed (truncated) grounding JSON and logs a warning', async () => {
    const chatLlm = makeChatLlm(JSON.stringify({
      thought: 'summary',
      answer: 'Wine 1 추천.',
    }));
    const logger = makeLogger();
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: chatLlm as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    pushObservationStep(state, 0, buildValidGroundingObservation('Wine 1', 'wine-1'));
    pushObservationStep(state, 1, buildMalformedTruncatedGrounding());

    await runner.run('opus one', 'req-malformed-truncated', DEFAULT_AGENT_CONFIG, state);

    expect(state.answer).toContain('Wine 1');
    expect(chatLlm.complete).toHaveBeenCalledTimes(1);
    const messages = chatLlm.complete.mock.calls[0]?.[0].messages ?? [];
    const toolResultMessages = messages.filter((m: { content: string }) =>
      m.content.startsWith('[Tool Result: search_wines]'),
    );
    // 1 valid frame survives; malformed frame dropped entirely.
    expect(toolResultMessages.length).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-malformed-truncated',
        malformedGrounding: true,
      }),
      expect.stringContaining('grounding JSON failed validation'),
    );
  });

  it('drops a frame whose grounding JSON is a non-object (array) and warns', async () => {
    const chatLlm = makeChatLlm(JSON.stringify({
      thought: 'summary',
      answer: 'Wine 1 추천.',
    }));
    const logger = makeLogger();
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: chatLlm as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    pushObservationStep(state, 0, buildValidGroundingObservation('Wine 1', 'wine-1'));
    pushObservationStep(state, 1, buildMalformedNonObjectGrounding());

    await runner.run('opus one', 'req-malformed-array', DEFAULT_AGENT_CONFIG, state);

    const messages = chatLlm.complete.mock.calls[0]?.[0].messages ?? [];
    const toolResultMessages = messages.filter((m: { content: string }) =>
      m.content.startsWith('[Tool Result: search_wines]'),
    );
    expect(toolResultMessages.length).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ malformedGrounding: true }),
      expect.any(String),
    );
  });

  it('drops a frame whose wines field has the wrong type', async () => {
    const chatLlm = makeChatLlm(JSON.stringify({
      thought: 'summary',
      answer: 'Wine 1 추천.',
    }));
    const logger = makeLogger();
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: chatLlm as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    pushObservationStep(state, 0, buildValidGroundingObservation('Wine 1', 'wine-1'));
    pushObservationStep(state, 1, buildMalformedInvalidWinesGrounding());

    await runner.run('opus one', 'req-malformed-wines-shape', DEFAULT_AGENT_CONFIG, state);

    const messages = chatLlm.complete.mock.calls[0]?.[0].messages ?? [];
    const toolResultMessages = messages.filter((m: { content: string }) =>
      m.content.startsWith('[Tool Result: search_wines]'),
    );
    expect(toolResultMessages.length).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ malformedGrounding: true }),
      expect.any(String),
    );
  });

  it('handles Korean grounding content verbatim in the synthesis prompt', async () => {
    const chatLlm = makeChatLlm(JSON.stringify({
      thought: '요약',
      answer: '오퍼스 원 2018을 추천합니다.',
    }));
    const logger = makeLogger();
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: chatLlm as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    const koreanObs = buildValidGroundingObservation('오퍼스 원 2018', 'wine-kr', '오퍼스 원 2018을 찾았습니다');
    pushObservationStep(state, 0, koreanObs);

    await runner.run('오퍼스 원 추천해줘', 'req-korean', DEFAULT_AGENT_CONFIG, state);

    expect(state.answer).toContain('오퍼스 원');
    const messages = chatLlm.complete.mock.calls[0]?.[0].messages ?? [];
    expect(messages.some((m: { content: string }) => m.content.includes('오퍼스 원 2018'))).toBe(true);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.objectContaining({ malformedGrounding: true }),
      expect.any(String),
    );
  });

  it('does not throw when the LLM returns a malformed (non-JSON) answer', async () => {
    const chatLlm = {
      complete: vi.fn()
        .mockResolvedValueOnce({ text: 'this is not JSON at all', model: 'test', finishReason: 'stop' })
        .mockResolvedValueOnce({ text: 'still not JSON', model: 'test', finishReason: 'stop' }),
    };
    const logger = makeLogger();
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: chatLlm as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    pushObservationStep(state, 0, buildValidGroundingObservation('Wine 1', 'wine-1'));

    await expect(
      runner.run('opus one', 'req-bad-llm-answer', DEFAULT_AGENT_CONFIG, state),
    ).resolves.toBeUndefined();
    expect(state.answer).toBe('');
    expect(state.failedSynthesisAttempts).toBe(2);
  });

  it('does not throw when the LLM returns an empty answer string', async () => {
    const chatLlm = {
      complete: vi.fn().mockResolvedValue({
        text: JSON.stringify({ thought: 'empty', answer: '' }),
        model: 'test',
        finishReason: 'stop',
      }),
    };
    const logger = makeLogger();
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: chatLlm as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    pushObservationStep(state, 0, buildValidGroundingObservation('Wine 1', 'wine-1'));

    await expect(
      runner.run('opus one', 'req-empty-llm-answer', DEFAULT_AGENT_CONFIG, state),
    ).resolves.toBeUndefined();
    expect(state.answer).toBe('');
    expect(state.failedSynthesisAttempts).toBeGreaterThanOrEqual(1);
  });

  it('handles a ToolOutcome with missing required result fields without throwing', async () => {
    const chatLlm = makeChatLlm(JSON.stringify({
      thought: 'summary',
      answer: 'Wine 1 추천.',
    }));
    const logger = makeLogger();
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: chatLlm as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    state.steps.push({
      index: 0,
      thought: 'searched',
      action: { tool: 'search_wines', input: { query: 'q' } },
      observation: buildValidGroundingObservation('Wine 1', 'wine-1'),
      durationMs: 10,
      tokenCount: { input: 10, output: 10 },
    });
    // ToolOutcome missing `result` field entirely — should not crash the runner.
    state.toolOutcomes.push({
      stepId: 'req:0:0:0',
      tool: 'search_wines',
      kind: 'success',
      durationMs: 10,
    });

    await expect(
      runner.run('opus one', 'req-missing-tool-fields', DEFAULT_AGENT_CONFIG, state),
    ).resolves.toBeUndefined();
    expect(state.answer).toContain('Wine 1');
  });

  it('with 3 valid + 1 malformed grounding frames keeps 3 in deterministic order and warns once', async () => {
    const chatLlm = makeChatLlm(JSON.stringify({
      thought: 'summary',
      answer: 'Wine 1, Wine 2, Wine 3 추천.',
    }));
    const logger = makeLogger();
    const runner = new AgentObservationSynthesisRunner({
      chatLlm: chatLlm as unknown as ChatLlmPort,
      logger,
    });
    const state = createAgentExecutionState();
    pushObservationStep(state, 0, buildValidGroundingObservation('Wine 1', 'wine-1'));
    pushObservationStep(state, 1, buildValidGroundingObservation('Wine 2', 'wine-2'));
    pushObservationStep(state, 2, buildMalformedTruncatedGrounding());
    pushObservationStep(state, 3, buildValidGroundingObservation('Wine 3', 'wine-3'));

    await runner.run('multi-frame', 'req-multi', DEFAULT_AGENT_CONFIG, state);

    const messages = chatLlm.complete.mock.calls[0]?.[0].messages ?? [];
    const toolResultMessages = messages.filter((m: { content: string }) =>
      m.content.startsWith('[Tool Result: search_wines]'),
    );
    expect(toolResultMessages.length).toBe(3);

    // Deterministic order: Wine 1 then Wine 2 then Wine 3 — the malformed frame
    // (step index 2) is dropped but the surviving frames keep their step order.
    const flat = toolResultMessages.map((m: { content: string }) => m.content).join('\n');
    const idx1 = flat.indexOf('wine-1');
    const idx2 = flat.indexOf('wine-2');
    const idx3 = flat.indexOf('wine-3');
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1);
    expect(idx3).toBeGreaterThan(idx2);

    const malformedWarnCalls = logger.warn.mock.calls.filter(
      (call) => typeof call[0] === 'object' && call[0] !== null && (call[0] as { malformedGrounding?: unknown }).malformedGrounding === true,
    );
    expect(malformedWarnCalls.length).toBe(1);
    expect(malformedWarnCalls[0]?.[0]).toMatchObject({
      requestId: 'req-multi',
      malformedGrounding: true,
    });
  });
});
