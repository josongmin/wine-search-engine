/**
 * T-CLI-03 DoD #1 — local↔remote parity gate.
 *
 * Every typed CLI facade has two implementations: an in-process `Local…Facade`
 * (calls a container use-case directly) and a `Remote…Facade` (POSTs to an
 * HTTP route and returns the parsed JSON body). Both branches converge into
 * the same `--json` stdout — so any divergence in the on-the-wire JSON shape
 * between the two targets would break the contract `--json` is target-
 * independent.
 *
 * This file is the regression gate that pins that property for ALL five
 * operations the kernel currently exposes:
 *   1. search.run            POST /v1/search
 *   2. search.hybrid         POST /v1/search/hybrid
 *   3. entity.resolve        POST /v1/entity/resolve
 *   4. entity.autocomplete   POST /v1/entity/autocomplete
 *   5. wine-search.run       POST /v1/wine-search
 *
 * For each operation we:
 *   - Feed the local facade a fake container whose use-case returns a known
 *     domain payload.
 *   - Compute the expected wire shape from that domain payload by applying
 *     the SAME `deepKeysToSnake` projector the production route hook uses
 *     (idempotent on snake_case keys, so it covers facades that emit
 *     pre-snake-cased domain objects).
 *   - Feed the remote facade a fake `fetchImpl` that returns
 *     `JSON.stringify(expectedWire)` as a 200 application/json response.
 *   - Assert `localOut === expectedWire === remoteOut` (and pin the
 *     parity claim with `expect(localOut).toEqual(remoteOut)`).
 *
 * The wine-search case is special: the local facade post-projects the
 * orchestrator result through `mapWineSearchResultToResponse`, so we compute
 * `expectedWire` by invoking that mapper directly from a minimal
 * `WineSearchResult`. This way the test stays self-validating: if the mapper
 * evolves the test follows.
 */

import { describe, expect, it } from 'vitest';

import { LocalSearchFacade } from '../local/local-search-facade.js';
import { RemoteSearchFacade } from '../remote/remote-search-facade.js';
import { LocalEntityFacade } from '../local/local-entity-facade.js';
import { RemoteEntityFacade } from '../remote/remote-entity-facade.js';
import { LocalWineSearchFacade } from '../local/local-wine-search-facade.js';
import { RemoteWineSearchFacade } from '../remote/remote-wine-search-facade.js';
import type { ResolvedCliProfile } from '../../../application/cli/context/cli-profile.js';
import { deepKeysToSnake } from '../../../interface/http/middleware/snake-case-hook.js';
import { mapWineSearchResultToResponse } from '../../../interface/http/routes/wine-search-response-mapper.js';
import type { WineSearchResult } from '../../../application/wine-search/wine-search-orchestrator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REMOTE_PROFILE: ResolvedCliProfile = {
  name: 'parity-test',
  target: 'remote',
  baseUrl: 'https://api.example.com',
  authMode: 'none',
  outputFormat: 'json',
};

/** Builds a fake fetch that returns the supplied wire payload as 200 JSON
 *  and records the URL + init it was called with, so each test can assert
 *  the remote facade also targeted the correct route. */
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

// ---------------------------------------------------------------------------
// 1. search.run — POST /v1/search
// ---------------------------------------------------------------------------

describe('search.run local↔remote parity', () => {
  it('emits identical wire JSON from local container + remote HTTP for /v1/search', async () => {
    // Domain payload contains camelCase keys so the snake-case projector
    // actually does work — this is the production search use-case output shape.
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

// ---------------------------------------------------------------------------
// 2. search.hybrid — POST /v1/search/hybrid
// ---------------------------------------------------------------------------

describe('search.hybrid local↔remote parity', () => {
  it('emits identical wire JSON from local container + remote HTTP for /v1/search/hybrid', async () => {
    const domainPayload = {
      queryType: 'hybrid',
      engineDecision: { runtimeCorrelationRef: 'runtime-2' },
      meta: { authorityTraceRef: 'authority-2' },
      results: [{ entityId: 'h1', calibratedScore: 0.85 }],
    };
    const expectedWire = deepKeysToSnake(domainPayload);

    const local = new LocalSearchFacade({
      withContainer: async (work) =>
        await work({
          hybridUseCase: { execute: async () => domainPayload },
        } as never),
    });

    const localOut = await local.hybrid(
      { query: 'opus one 2018' },
      { requestId: 'req-1' },
    );

    const { fetchImpl, calls } = makeFakeFetch(expectedWire);
    const remote = new RemoteSearchFacade(REMOTE_PROFILE, { fetchImpl });

    const remoteOut = await remote.hybrid(
      { query: 'opus one 2018' },
      { requestId: 'req-1' },
    );

    expect(localOut).toEqual(expectedWire);
    expect(remoteOut).toEqual(expectedWire);
    expect(localOut).toEqual(remoteOut);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('https://api.example.com/v1/search/hybrid');
  });
});

// ---------------------------------------------------------------------------
// 3. entity.resolve — POST /v1/entity/resolve
// ---------------------------------------------------------------------------

describe('entity.resolve local↔remote parity', () => {
  it('emits identical wire JSON from local container + remote HTTP for /v1/entity/resolve', async () => {
    // `ResolveResponse` is already wire-shape (snake_case for the wire fields
    // it owns). `LocalEntityFacade` does NOT post-project, so the local result
    // is the use-case result verbatim. `deepKeysToSnake` is idempotent on
    // snake_case keys → expectedWire === domainPayload.
    const domainPayload = {
      status: 'resolved',
      candidates: [
        { entity_id: 'e1', calibrated_score: 0.92 },
        { entity_id: 'e2', calibrated_score: 0.71 },
      ],
      top_entity: { entity_id: 'e1', calibrated_score: 0.92 },
      decision_trace_ref: 'decision-1',
      authority_trace_ref: 'authority-1',
      request_id: 'req-1',
    };
    const expectedWire = deepKeysToSnake(domainPayload);

    const local = new LocalEntityFacade({
      withContainer: async (work) =>
        await work({
          resolveUseCase: { execute: async () => domainPayload },
        } as never),
    });

    const localOut = await local.resolve(
      { query: 'opus one' },
      { requestId: 'req-1' },
    );

    const { fetchImpl, calls } = makeFakeFetch(expectedWire);
    const remote = new RemoteEntityFacade(REMOTE_PROFILE, { fetchImpl });

    const remoteOut = await remote.resolve(
      { query: 'opus one' },
      { requestId: 'req-1' },
    );

    expect(localOut).toEqual(expectedWire);
    expect(remoteOut).toEqual(expectedWire);
    expect(localOut).toEqual(remoteOut);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('https://api.example.com/v1/entity/resolve');
  });
});

// ---------------------------------------------------------------------------
// 4. entity.autocomplete — POST /v1/entity/autocomplete
// ---------------------------------------------------------------------------

describe('entity.autocomplete local↔remote parity', () => {
  it('emits identical wire JSON from local container + remote HTTP for /v1/entity/autocomplete', async () => {
    // `AutocompleteResponse` is fully snake_case → idempotent under
    // `deepKeysToSnake`. Same parity story as resolve.
    const domainPayload = {
      status: 'ok',
      suggestions: [
        {
          entity: {
            entity_id: 'e1',
            canonical_label: 'Opus One',
            entity_type: 'wine',
            vintage: 2018,
          },
          rank: 1,
          calibrated_score: 0.94,
        },
        {
          entity: {
            entity_id: 'e2',
            canonical_label: 'Opus One',
            entity_type: 'wine',
            vintage: 2017,
          },
          rank: 2,
          calibrated_score: 0.88,
        },
      ],
      decision_trace_ref: 'decision-2',
      authority_trace_ref: 'authority-2',
      request_id: 'req-1',
    };
    const expectedWire = deepKeysToSnake(domainPayload);

    const local = new LocalEntityFacade({
      withContainer: async (work) =>
        await work({
          autocompleteUseCase: { execute: async () => domainPayload },
        } as never),
    });

    const localOut = await local.autocomplete(
      { query: 'opus' },
      { requestId: 'req-1' },
    );

    const { fetchImpl, calls } = makeFakeFetch(expectedWire);
    const remote = new RemoteEntityFacade(REMOTE_PROFILE, { fetchImpl });

    const remoteOut = await remote.autocomplete(
      { query: 'opus' },
      { requestId: 'req-1' },
    );

    expect(localOut).toEqual(expectedWire);
    expect(remoteOut).toEqual(expectedWire);
    expect(localOut).toEqual(remoteOut);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('https://api.example.com/v1/entity/autocomplete');
  });
});

// ---------------------------------------------------------------------------
// 5. wine-search.run — POST /v1/wine-search
// ---------------------------------------------------------------------------

describe('wine-search.run local↔remote parity', () => {
  it('emits identical wire JSON from local container + remote HTTP for /v1/wine-search', async () => {
    // Minimal `WineSearchResult` that satisfies the orchestrator surface the
    // mapper reads. Cast through `as never` to avoid coupling this parity
    // test to every optional field on `WineSearchResult` — the mapper itself
    // is the authoritative projector and is what we want to lock parity on.
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

    // expectedWire is what the local facade WILL produce — driven by the
    // production mapper itself, so the test cannot drift from the mapper.
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
