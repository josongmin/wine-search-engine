import { describe, expect, it } from 'vitest';

import { LocalSearchFacade } from '../local/local-search-facade.js';
import { RemoteSearchFacade } from '../remote/remote-search-facade.js';
import { LocalWineSearchFacade } from '../local/local-wine-search-facade.js';
import { RemoteWineSearchFacade } from '../remote/remote-wine-search-facade.js';
import type { ResolvedCliProfile } from '../../../application/cli/context/cli-profile.js';
import { deepKeysToSnake } from '../../../interface/http/middleware/snake-case-hook.js';
import { mapWineSearchResultToResponse } from '../../../interface/http/routes/wine-search-response-mapper.js';
import type { WineSearchResult } from '../../../application/wine-search/wine-search-orchestrator.js';

const REMOTE_PROFILE: ResolvedCliProfile = {
  name: 'parity-test',
  target: 'remote',
  baseUrl: 'https://api.example.com',
  authMode: 'none',
  outputFormat: 'json',
};

function makeFakeFetch(wirePayload: unknown): {
  readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  readonly calls: Array<{ input: string; init?: RequestInit | undefined }>;
} {
  const calls: Array<{ input: string; init?: RequestInit | undefined }> = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ input, init });
    return new Response(JSON.stringify(wirePayload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

describe('search.run local↔remote parity', () => {
  it('emits identical wire JSON from local container + remote HTTP for /v1/search', async () => {
    const domainPayload = {
      queryType: 'search',
      engineDecision: { runtimeCorrelationRef: 'runtime-1' },
      meta: { authorityTraceRef: 'authority-1' },
      results: [
        { entityId: 'e1', calibratedScore: 0.9 },
        { entityId: 'e2', calibratedScore: 0.7 },
      ],
    };
    const expectedWire = deepKeysToSnake(domainPayload);

    const local = new LocalSearchFacade({
      withContainer: async (work) =>
        await work({
          searchUseCase: { execute: async () => domainPayload },
        } as never),
    });

    const localOut = await local.run(
      { query: 'opus one 2018', retrievalMode: 'entity' },
      { requestId: 'req-1' },
    );

    const { fetchImpl, calls } = makeFakeFetch(expectedWire);
    const remote = new RemoteSearchFacade(REMOTE_PROFILE, { fetchImpl });

    const remoteOut = await remote.run(
      { query: 'opus one 2018', retrievalMode: 'entity' },
      { requestId: 'req-1' },
    );

    expect(localOut).toEqual(expectedWire);
    expect(remoteOut).toEqual(expectedWire);
    expect(localOut).toEqual(remoteOut);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('https://api.example.com/v1/search');
  });
});

describe('wine-search.run local↔remote parity', () => {
  it('emits identical wire JSON from local container + remote HTTP for /v1/wine-search', async () => {
    const orchestratorResult = {
      answer: 'A representative wine answer.',
      layer: 'primary',
      groundedOnToolResults: true,
      toolOutcomes: [],
      executionSteps: [
        {
          index: 0,
          source: 'analyzer',
          summary: 'analyzed query',
          durationMs: 12,
        },
      ],
      toolCallCount: 0,
      tokenUsage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      totalDurationMs: 42,
      terminationReason: 'answer',
      policyBlocked: false,
      intent: 'general_search',
      planKind: 'single',
    } as unknown as WineSearchResult;
    const expectedWire = mapWineSearchResultToResponse(orchestratorResult, 'req-1');

    const local = new LocalWineSearchFacade({
      withContainer: async (work) =>
        await work({
          wineSearch: {
            wineSearchOrchestrator: {
              execute: async () => orchestratorResult,
            },
          },
        } as never),
    });

    const localOut = await local.run(
      { query: 'a complex wine search question' },
      { requestId: 'req-1' },
    );

    const { fetchImpl, calls } = makeFakeFetch(expectedWire);
    const remote = new RemoteWineSearchFacade(REMOTE_PROFILE, { fetchImpl });

    const remoteOut = await remote.run(
      { query: 'a complex wine search question' },
      { requestId: 'req-1' },
    );

    expect(localOut).toEqual(expectedWire);
    expect(remoteOut).toEqual(expectedWire);
    expect(localOut).toEqual(remoteOut);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('https://api.example.com/v1/wine-search');
  });
});
