import { describe, expect, it } from 'vitest';
import { LocalWineSearchFacade } from '../local-wine-search-facade.js';
import { CliError } from '../../../../application/cli/command/cli-error.js';
import { mapWineSearchResultToResponse } from '../../../../interface/http/routes/wine-search-response-mapper.js';

interface OrchestratorCall {
  input: Record<string, unknown>;
}

function buildFakeOrchestratorResult(): unknown {
  return {
    answer: 'an answer',
    executionSteps: [],
    toolCallCount: 0,
    totalDurationMs: 100,
    tokenUsage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    },
    intent: 'wine_search',
    planKind: 'mini_loop',
    terminationReason: 'final_answer',
    layer: 'agent',
    policyBlocked: false,
  };
}

describe('LocalWineSearchFacade', () => {
  it('throws CliError(execution) when wineSearch wiring is absent', async () => {
    const facade = new LocalWineSearchFacade({
      withContainer: async (work) => await work({ wineSearch: undefined } as never),
    });

    await expect(facade.run({ query: 'q' }, { requestId: 'req-1' })).rejects.toBeInstanceOf(
      CliError,
    );
    await expect(facade.run({ query: 'q' }, { requestId: 'req-1' })).rejects.toMatchObject({
      kind: 'execution',
      message: expect.stringContaining('unavailable') as unknown as string,
    });
  });

  it('invokes the orchestrator with query + requestId and omits unset optional fields', async () => {
    const calls: OrchestratorCall[] = [];
    const orchestratorResult = buildFakeOrchestratorResult();
    const facade = new LocalWineSearchFacade({
      withContainer: async (work) =>
        await work({
          wineSearch: {
            wineSearchOrchestrator: {
              execute: async (input: Record<string, unknown>) => {
                calls.push({ input });
                return orchestratorResult;
              },
            },
          },
        } as never),
    });

    await facade.run({ query: 'opus one' }, { requestId: 'req-2' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ query: 'opus one', requestId: 'req-2' });
    expect(Object.keys(calls[0]?.input ?? {}).sort()).toEqual(['query', 'requestId']);
  });

  it('threads maxSteps / perStepTimeoutMs / agentTimeoutMs / maxTotalTokens / abortSignal through', async () => {
    const calls: OrchestratorCall[] = [];
    const facade = new LocalWineSearchFacade({
      withContainer: async (work) =>
        await work({
          wineSearch: {
            wineSearchOrchestrator: {
              execute: async (input: Record<string, unknown>) => {
                calls.push({ input });
                return buildFakeOrchestratorResult();
              },
            },
          },
        } as never),
    });
    const controller = new AbortController();

    await facade.run(
      {
        query: 'q',
        maxSteps: 5,
        perStepTimeoutMs: 2000,
        agentTimeoutMs: 10000,
        maxTotalTokens: 30000,
      },
      { requestId: 'req-3', abortSignal: controller.signal },
    );

    expect(calls[0]?.input).toEqual({
      query: 'q',
      requestId: 'req-3',
      maxSteps: 5,
      perStepTimeoutMs: 2000,
      agentTimeoutMs: 10000,
      maxTotalTokens: 30000,
      abortSignal: controller.signal,
    });
  });

  it('returns the orchestrator result mapped through mapWineSearchResultToResponse', async () => {
    const orchestratorResult = buildFakeOrchestratorResult();
    const facade = new LocalWineSearchFacade({
      withContainer: async (work) =>
        await work({
          wineSearch: {
            wineSearchOrchestrator: {
              execute: async () => orchestratorResult,
            },
          },
        } as never),
    });

    const result = await facade.run({ query: 'q' }, { requestId: 'req-4' });

    expect(result).toEqual(
      mapWineSearchResultToResponse(
        orchestratorResult as Parameters<typeof mapWineSearchResultToResponse>[0],
        'req-4',
      ),
    );
  });
});
