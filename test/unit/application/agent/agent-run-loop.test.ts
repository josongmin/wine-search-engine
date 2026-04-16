import { describe, expect, it, vi } from 'vitest';
import { AgentRunLoop } from '../../../../src/application/agent/agent-run-loop.js';
import { createAgentExecutionState } from '../../../../src/application/agent/agent-execution-state.js';
import { DEFAULT_AGENT_CONFIG } from '../../../../src/domain/agent/model/agent-config.js';
import { StepBudget } from '../../../../src/domain/agent/service/step-budget.js';
import { CircuitBreakerOpenError } from '../../../../src/domain/shared/error/circuit-breaker-open-error.js';
import { DomainError } from '../../../../src/domain/shared/error/domain-error.js';
import { PolicyBlockedError } from '../../../../src/domain/shared/error/policy-blocked.js';

describe('AgentRunLoop', () => {
  it('terminates before planner execution when the token budget is exhausted', async () => {
    const plannerPhaseRunner = { run: vi.fn() };
    const toolExecutionPhase = { run: vi.fn() };
    const loop = new AgentRunLoop({
      plannerPhaseRunner: plannerPhaseRunner as never,
      toolExecutionPhase: toolExecutionPhase as never,
    });
    const state = createAgentExecutionState();
    state.totalInputTokens = DEFAULT_AGENT_CONFIG.maxTotalTokens;

    await loop.run({
      query: 'opus one',
      requestId: 'req-budget',
      effectiveConfig: DEFAULT_AGENT_CONFIG,
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      budget: new StepBudget(DEFAULT_AGENT_CONFIG),
      state,
    });

    expect(state.terminationReason).toBe('budget');
    expect(plannerPhaseRunner.run).not.toHaveBeenCalled();
    expect(toolExecutionPhase.run).not.toHaveBeenCalled();
  });

  it('passes planner output to the tool execution phase and stops when requested', async () => {
    const plannerPhase = {
      stepStartMs: Date.now(),
      parsed: { thought: 'answer', answer: 'done' },
      inputTokens: 1,
      outputTokens: 1,
      wasTruncated: false,
    };
    const plannerPhaseRunner = { run: vi.fn().mockResolvedValue(plannerPhase) };
    const toolExecutionPhase = { run: vi.fn().mockResolvedValue(true) };
    const loop = new AgentRunLoop({
      plannerPhaseRunner: plannerPhaseRunner as never,
      toolExecutionPhase: toolExecutionPhase as never,
    });
    const state = createAgentExecutionState();
    const budget = new StepBudget(DEFAULT_AGENT_CONFIG);
    const contract = { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false };

    await loop.run({
      query: 'opus one',
      requestId: 'req-pass',
      effectiveConfig: DEFAULT_AGENT_CONFIG,
      queryExecutionContract: contract,
      budget,
      state,
    });

    expect(plannerPhaseRunner.run).toHaveBeenCalledTimes(1);
    expect(toolExecutionPhase.run).toHaveBeenCalledWith(
      'req-pass',
      DEFAULT_AGENT_CONFIG,
      budget,
      state,
      contract,
      plannerPhase,
      undefined,
    );
  });

  it('maps policy-blocked execution errors onto blocked state', async () => {
    const plannerPhaseRunner = {
      run: vi.fn().mockResolvedValue({
        stepStartMs: Date.now(),
        parsed: { thought: 'search', action: { tool: 'search_wines', input: { query: 'blocked' } } },
        inputTokens: 1,
        outputTokens: 1,
        wasTruncated: false,
      }),
    };
    const toolExecutionPhase = { run: vi.fn().mockRejectedValue(new PolicyBlockedError('unsafe query')) };
    const loop = new AgentRunLoop({
      plannerPhaseRunner: plannerPhaseRunner as never,
      toolExecutionPhase: toolExecutionPhase as never,
    });
    const state = createAgentExecutionState();

    await loop.run({
      query: 'blocked',
      requestId: 'req-blocked',
      effectiveConfig: DEFAULT_AGENT_CONFIG,
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      budget: new StepBudget(DEFAULT_AGENT_CONFIG),
      state,
    });

    expect(state.policyBlocked).toBe(true);
    expect(state.terminationReason).toBe('blocked');
  });

  it('maps breaker-open execution errors onto reasoning failure and error termination', async () => {
    const plannerPhaseRunner = {
      run: vi.fn().mockResolvedValue({
        stepStartMs: Date.now(),
        parsed: { thought: 'search', action: { tool: 'search_wines', input: { query: 'opus one' } } },
        inputTokens: 1,
        outputTokens: 1,
        wasTruncated: false,
      }),
    };
    const toolExecutionPhase = { run: vi.fn().mockRejectedValue(new CircuitBreakerOpenError('llm.openai.chat')) };
    const loop = new AgentRunLoop({
      plannerPhaseRunner: plannerPhaseRunner as never,
      toolExecutionPhase: toolExecutionPhase as never,
    });
    const state = createAgentExecutionState();

    await loop.run({
      query: 'opus one',
      requestId: 'req-cb-open',
      effectiveConfig: DEFAULT_AGENT_CONFIG,
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      budget: new StepBudget(DEFAULT_AGENT_CONFIG),
      state,
    });

    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.llmCircuitOpen).toBe(true);
    expect(state.terminationReason).toBe('error');
  });

  it('maps generic domain errors onto error termination', async () => {
    const plannerPhaseRunner = {
      run: vi.fn().mockResolvedValue({
        stepStartMs: Date.now(),
        parsed: { thought: 'search', action: { tool: 'search_wines', input: { query: 'opus one' } } },
        inputTokens: 1,
        outputTokens: 1,
        wasTruncated: false,
      }),
    };
    const toolExecutionPhase = { run: vi.fn().mockRejectedValue(new DomainError('generic failure', 'GENERIC_FAILURE')) };
    const loop = new AgentRunLoop({
      plannerPhaseRunner: plannerPhaseRunner as never,
      toolExecutionPhase: toolExecutionPhase as never,
    });
    const state = createAgentExecutionState();

    await loop.run({
      query: 'opus one',
      requestId: 'req-generic-domain-error',
      effectiveConfig: DEFAULT_AGENT_CONFIG,
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      budget: new StepBudget(DEFAULT_AGENT_CONFIG),
      state,
    });

    expect(state.reasoningFailureDetected).toBe(true);
    expect(state.terminationReason).toBe('error');
  });

  it('treats preflight abort as aborted without planner execution', async () => {
    const plannerPhaseRunner = { run: vi.fn() };
    const toolExecutionPhase = { run: vi.fn() };
    const loop = new AgentRunLoop({
      plannerPhaseRunner: plannerPhaseRunner as never,
      toolExecutionPhase: toolExecutionPhase as never,
    });
    const state = createAgentExecutionState();
    const abortController = new AbortController();
    abortController.abort();

    await loop.run({
      query: 'opus one',
      requestId: 'req-preflight-abort',
      effectiveConfig: DEFAULT_AGENT_CONFIG,
      queryExecutionContract: { requiresDrinkabilityCheck: false, hasEntityMetadataSignal: false },
      budget: new StepBudget(DEFAULT_AGENT_CONFIG),
      state,
      abortSignal: abortController.signal,
    });

    expect(state.terminationReason).toBe('aborted');
    expect(plannerPhaseRunner.run).not.toHaveBeenCalled();
    expect(toolExecutionPhase.run).not.toHaveBeenCalled();
  });
});
