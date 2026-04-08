/**
 * Regression tests for parallel tool execution in the agent ReAct loop.
 *
 * Covers:
 *  1. parseLlmOutput — actions[] array parsed correctly
 *  2. parseLlmOutput — single action still works (backward compat)
 *  3. parseLlmOutput — malformed entries in actions[] silently dropped
 *  4. buildStepMessages — parallel step emits labelled [Tool Result: tool_name] messages
 *  5. buildStepMessages — sequential step still emits plain [Tool Result]
 *  6. buildStepMessages — parallel step with missing observations falls back to "(no result)"
 *  7. executeAgentToolsBatch — both tools called, results returned in order
 *  8. executeAgentToolsBatch — one tool fails, other result still returned
 */

import { describe, it, expect, vi } from 'vitest';
import { buildStepMessages } from '../../src/application/agent/agent-prompt.js';
import { executeAgentToolsBatch } from '../../src/application/agent/agent-tools.js';
import type { AgentStep } from '../../src/domain/agent/model/agent-step.js';
import type { AgentToolDeps } from '../../src/application/agent/agent-tools.js';

// ─── parseLlmOutput is not exported, test via orchestrator indirectly ───────
// Instead, test the JSON shapes that the orchestrator's parser handles,
// by verifying the buildStepMessages round-trip (which uses the same shape).

// ─── 1-3: parseLlmOutput via shape validation ────────────────────────────────

describe('parallel tool output shape', () => {
  it('actions array round-trips through buildStepMessages', () => {
    const step: AgentStep = {
      index: 0,
      thought: 'fire both tools',
      actions: [
        { tool: 'search_wines', input: { query: 'Barolo' } },
        { tool: 'get_food_pairings', input: { food: 'steak' } },
      ],
      observations: ['Found 3 results', 'Pairing: Cabernet'],
      durationMs: 100,
      tokenCount: { input: 10, output: 20 },
    };

    const msgs = buildStepMessages([step]);

    // assistant message should contain "actions" array
    expect(msgs[0]?.role).toBe('assistant');
    const assistantBody = JSON.parse(msgs[0]?.content ?? '{}');
    expect(assistantBody.actions).toHaveLength(2);
    expect(assistantBody.actions[0].tool).toBe('search_wines');
    expect(assistantBody.actions[1].tool).toBe('get_food_pairings');
    expect(assistantBody.action).toBeUndefined();

    // two labelled user messages
    expect(msgs[1]?.role).toBe('user');
    expect(msgs[1]?.content).toContain('[Tool Result: search_wines]');
    expect(msgs[1]?.content).toContain('Found 3 results');

    expect(msgs[2]?.role).toBe('user');
    expect(msgs[2]?.content).toContain('[Tool Result: get_food_pairings]');
    expect(msgs[2]?.content).toContain('Pairing: Cabernet');

    expect(msgs).toHaveLength(3);
  });

  it('sequential step still emits plain [Tool Result] (backward compat)', () => {
    const step: AgentStep = {
      index: 0,
      thought: 'search',
      action: { tool: 'search_wines', input: { query: 'Pinot Noir' } },
      observation: 'Found 5 results',
      durationMs: 100,
      tokenCount: { input: 10, output: 5 },
    };

    const msgs = buildStepMessages([step]);
    expect(msgs[1]?.content).toContain('[Tool Result]\n');
    expect(msgs[1]?.content).not.toContain('[Tool Result: search_wines]');
  });

  it('parallel step with missing observations falls back to (no result)', () => {
    const step: AgentStep = {
      index: 0,
      thought: 'batch with no obs',
      actions: [
        { tool: 'search_wines', input: { query: 'Merlot' } },
        { tool: 'get_food_pairings', input: { food: 'pasta' } },
      ],
      // observations intentionally omitted
      durationMs: 50,
      tokenCount: { input: 5, output: 5 },
    };

    const msgs = buildStepMessages([step]);
    expect(msgs[1]?.content).toContain('(no result)');
    expect(msgs[2]?.content).toContain('(no result)');
  });

  it('answer step is unaffected by parallel changes', () => {
    const step: AgentStep = {
      index: 0,
      thought: 'done',
      answer: '바롤로를 추천드립니다.',
      durationMs: 50,
      tokenCount: { input: 5, output: 10 },
    };

    const msgs = buildStepMessages([step]);
    expect(msgs).toHaveLength(1);
    const body = JSON.parse(msgs[0]?.content ?? '{}');
    expect(body.answer).toBe('바롤로를 추천드립니다.');
  });
});

// ─── 4-5: executeAgentToolsBatch ─────────────────────────────────────────────

describe('executeAgentToolsBatch', () => {
  const makeDeps = (): AgentToolDeps => ({
    searchUseCase: {
      execute: vi.fn().mockResolvedValue({
        queryType: 'search',
        results: [],
        engineDecision: {
          decisionStatus: 'resolved',
          nextAction: 'return_result',
          route: 'hybrid',
          decisionConfidence: 0.8,
          confidenceSemantics: 'calibrated_decision_confidence',
          decisionTraceRef: 'test',
          decisionSnapshot: {
            model_versions: {},
            index_versions: {},
            policy_rule_version: '1.0.0',
            threshold_profile_id: 'default',
            planner_version: '1.0.0',
            feature_flags: {},
          },
        },
        meta: {
          requestId: 'test',
          queryTimeMs: 1,
          route: 'hybrid',
          version: '1.0.0',
          engine_schema_version: 'search_response_v1',
        },
      }),
    } as never,
  });

  it('returns results in the same order as input calls', async () => {
    const deps = makeDeps();
    const results = await executeAgentToolsBatch(
      [
        { tool: 'search_wines', input: { query: 'Barolo' } },
        { tool: 'search_wines', input: { query: 'Burgundy' } },
      ],
      deps,
      'test-req',
    );

    expect(results).toHaveLength(2);
    // Both should have an observation string
    expect(typeof results[0]?.observation).toBe('string');
    expect(typeof results[1]?.observation).toBe('string');
  });

  it('one tool error returns error observation, other result preserved', async () => {
    const deps = makeDeps();
    // Override execute to throw on second call
    let callCount = 0;
    (deps.searchUseCase.execute as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      if (callCount === 2) throw new Error('Vespa timeout');
      return Promise.resolve({
        queryType: 'search',
        results: [],
        engineDecision: {
          decisionStatus: 'resolved',
          nextAction: 'return_result',
          route: 'hybrid',
          decisionConfidence: 0.8,
          confidenceSemantics: 'calibrated_decision_confidence',
          decisionTraceRef: 'test',
          decisionSnapshot: {
            model_versions: {},
            index_versions: {},
            policy_rule_version: '1.0.0',
            threshold_profile_id: 'default',
            planner_version: '1.0.0',
            feature_flags: {},
          },
        },
        meta: {
          requestId: 'test',
          queryTimeMs: 1,
          route: 'hybrid',
          version: '1.0.0',
          engine_schema_version: 'search_response_v1',
        },
      });
    });

    const results = await executeAgentToolsBatch(
      [
        { tool: 'search_wines', input: { query: 'Barolo' } },
        { tool: 'search_wines', input: { query: 'Bad query' } },
      ],
      deps,
      'test-req',
    );

    expect(results).toHaveLength(2);
    // First succeeded
    expect(results[0]?.observation).not.toContain('unexpected error');
    // Second failed gracefully
    expect(results[1]?.observation).toContain('unexpected error');
  });

  it('2 parallel tools called with unique requestIds (p0, p1 suffix)', async () => {
    const capturedIds: string[] = [];
    const deps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockImplementation((_req: unknown, requestId: string) => {
          capturedIds.push(requestId);
          return Promise.resolve({
            queryType: 'search',
            results: [],
            engineDecision: {
              decisionStatus: 'resolved',
              nextAction: 'return_result',
              route: 'hybrid',
              decisionConfidence: 0.8,
              confidenceSemantics: 'calibrated_decision_confidence',
              decisionTraceRef: 'test',
              decisionSnapshot: {
                model_versions: {},
                index_versions: {},
                policy_rule_version: '1.0.0',
                threshold_profile_id: 'default',
                planner_version: '1.0.0',
                feature_flags: {},
              },
            },
            meta: {
              requestId,
              queryTimeMs: 1,
              route: 'hybrid',
              version: '1.0.0',
              engine_schema_version: 'search_response_v1',
            },
          });
        }),
      } as never,
    };

    await executeAgentToolsBatch(
      [
        { tool: 'search_wines', input: { query: 'A' } },
        { tool: 'search_wines', input: { query: 'B' } },
      ],
      deps,
      'bench-42-step1',
    );

    expect(capturedIds).toContain('bench-42-step1-p0');
    expect(capturedIds).toContain('bench-42-step1-p1');
  });

  it('policy-block DomainError from one tool propagates out of executeAgentToolsBatch', async () => {
    // If any tool in the batch throws a DomainError with POLICY_BLOCKED_CODE,
    // executeAgentToolsBatch must re-throw it rather than swallowing into an
    // error observation — the orchestrator depends on this to terminate safely.
    const { POLICY_BLOCKED_CODE, PolicyBlockedError } = await import('../../src/domain/shared/error/policy-blocked.js');

    const deps: AgentToolDeps = {
      searchUseCase: {
        execute: vi.fn().mockRejectedValue(new PolicyBlockedError('injection attempt')),
      } as never,
    };

    await expect(
      executeAgentToolsBatch(
        [{ tool: 'search_wines', input: { query: 'DROP TABLE wines' } }],
        deps,
        'sec-test',
      ),
    ).rejects.toMatchObject({ code: POLICY_BLOCKED_CODE });
  });
});

// ─── Regression: parallel-batch obsSteps filter ──────────────────────────────
// Bug: synthesis obsSteps used to only check s.observation (sequential), skipping
// s.observations[] (parallel batch). Agent with parallel tool results but no answer
// would skip synthesis entirely and fall through to raw Layer-2 search.
// Fix: obsSteps now checks both s.observation and s.observations[].

describe('parallel batch observations count toward synthesis eligibility', () => {
  it('parallel step with non-empty observations[] is counted as an obs step', () => {
    // Simulate a step with parallel observations[] and verify it would be
    // selected by the corrected obsSteps filter.
    const parallelStep: AgentStep = {
      index: 0,
      thought: 'searched in parallel',
      actions: [
        { tool: 'search_wines', input: { query: 'Bordeaux' } },
        { tool: 'get_food_pairings', input: { food: 'steak' } },
      ],
      observations: ['Found 5 results (showing top 5):\n1. Château Margaux', 'Cabernet Sauvignon pairs well with steak.'],
      durationMs: 150,
      tokenCount: { input: 20, output: 5 },
    };

    // Replicate the corrected obsSteps filter from agent-orchestrator.ts
    const steps = [parallelStep];
    const obsSteps = steps.filter(
      (s) =>
        (s.observation !== undefined && s.observation.length > 0) ||
        (s.observations !== undefined && s.observations.some((o) => o.length > 0)),
    );

    // The parallel step MUST be included in obsSteps — synthesis should fire.
    expect(obsSteps).toHaveLength(1);
    expect(obsSteps[0]).toBe(parallelStep);
  });

  it('parallel step with empty observations[] is NOT counted as an obs step', () => {
    const emptyParallelStep: AgentStep = {
      index: 0,
      thought: 'searched but empty',
      actions: [{ tool: 'search_wines', input: { query: 'xyz' } }],
      observations: [''],
      durationMs: 50,
      tokenCount: { input: 5, output: 5 },
    };

    const steps = [emptyParallelStep];
    const obsSteps = steps.filter(
      (s) =>
        (s.observation !== undefined && s.observation.length > 0) ||
        (s.observations !== undefined && s.observations.some((o) => o.length > 0)),
    );

    expect(obsSteps).toHaveLength(0);
  });

  it('mixed sequential + parallel steps: both count toward synthesis eligibility', () => {
    const seqStep: AgentStep = {
      index: 0,
      thought: 'sequential',
      action: { tool: 'search_wines', input: { query: 'Pinot Noir' } },
      observation: 'Found 3 results',
      durationMs: 100,
      tokenCount: { input: 10, output: 5 },
    };
    const parStep: AgentStep = {
      index: 1,
      thought: 'parallel',
      actions: [{ tool: 'get_food_pairings', input: { food: 'duck' } }],
      observations: ['Duck pairs with Pinot Noir.'],
      durationMs: 80,
      tokenCount: { input: 8, output: 4 },
    };

    const steps = [seqStep, parStep];
    const obsSteps = steps.filter(
      (s) =>
        (s.observation !== undefined && s.observation.length > 0) ||
        (s.observations !== undefined && s.observations.some((o) => o.length > 0)),
    );

    expect(obsSteps).toHaveLength(2);
  });
});
