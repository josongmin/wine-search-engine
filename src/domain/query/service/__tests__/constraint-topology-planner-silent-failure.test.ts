import { describe, it, expect, vi, afterEach } from 'vitest';
import { ConstraintTopologyPlanner } from '../constraint-topology-planner.js';
import type { ChatLlmPort } from '../../../ai/port/chat-llm.port.js';
import { bootstrapLogger } from '../../../shared/bootstrap-logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// Gate-opening query: contains a Korean topology intent keyword ('각각'),
// so `plan()` proceeds to the LLM call instead of returning early.
const GATE_OPEN_QUERY = '레드와인 각각 추천해줘';

function makePlannerWith(complete: ChatLlmPort['complete']): ConstraintTopologyPlanner {
  const llm: ChatLlmPort = { complete };
  return new ConstraintTopologyPlanner(llm);
}

describe('ConstraintTopologyPlanner — silent-failure observability', () => {
  it('returns null AND logs a warning when the LLM call throws', async () => {
    const warnSpy = vi
      .spyOn(bootstrapLogger, 'warn')
      .mockImplementation(() => bootstrapLogger);

    const planner = makePlannerWith(() => {
      throw new Error('upstream 5xx');
    });

    const result = await planner.plan({
      atoms: [],
      normalizedQuery: GATE_OPEN_QUERY,
      slotIds: [],
    });

    // Behavior preserved: still abstains with null.
    expect(result).toBeNull();
    // New behavior: the failure is observable (no longer silent).
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [logObj, msg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(logObj).toHaveProperty('err');
    expect(msg).toContain('ConstraintTopologyPlanner');
  });

  it('returns null AND logs a warning when the LLM returns non-JSON text', async () => {
    const warnSpy = vi
      .spyOn(bootstrapLogger, 'warn')
      .mockImplementation(() => bootstrapLogger);

    const planner = makePlannerWith(async () => ({
      text: 'not json at all {{{',
      model: 'test-model',
      finishReason: 'stop',
    }));

    const result = await planner.plan({
      atoms: [],
      normalizedQuery: GATE_OPEN_QUERY,
      slotIds: [],
    });

    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [logObj] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(logObj).toHaveProperty('err');
  });

  // Regression: adjacent legitimate path. A valid-but-empty topology
  // response is a *normal* abstention (LLM says "no disjunction") and MUST
  // NOT be logged as a failure — only genuine call/parse failures warn.
  it('returns null WITHOUT logging when the LLM emits a valid empty topology', async () => {
    const warnSpy = vi
      .spyOn(bootstrapLogger, 'warn')
      .mockImplementation(() => bootstrapLogger);

    const planner = makePlannerWith(async () => ({
      text: JSON.stringify({
        origin: 'planner_emitted',
        rootNodeId: 'topology/root',
        nodes: [],
        edges: [],
      }),
      model: 'test-model',
      finishReason: 'stop',
    }));

    const result = await planner.plan({
      atoms: [],
      normalizedQuery: GATE_OPEN_QUERY,
      slotIds: [],
    });

    expect(result).toBeNull();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
