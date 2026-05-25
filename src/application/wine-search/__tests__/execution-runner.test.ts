/**
 * ExecutionRunner — plan-kind dispatch, parallelism, abort & timeout.
 *
 * The runner is decoupled from real use cases via local ports. These tests
 * inject stubs so we can assert routing, parallel fan-out, abort
 * propagation, and timeout semantics without touching adapters.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ComparisonSearchResponse } from '@domain/response/model/comparison-response.js';
import type { DrinkingWindowBlock } from '@domain/response/model/result-item.js';
import type { SearchResponseV1 } from '@domain/response/model/search-response.js';
import {
  ExecutionRunner,
  type ComparisonUseCasePort,
  type DrinkabilityProbe,
  type DrinkabilityUseCasePort,
  type SearchUseCasePort,
} from '../execution-runner.js';
import type {
  ComparisonUseCaseInput,
  ExecutionPlan,
  SearchUseCaseInput,
} from '../execution-plan-schemas.js';

const REQUEST_ID = 'req-runner-0001';
const PER_STEP_TIMEOUT_MS = 1_500;

// ---------------------------------------------------------------------------
// Stubbed responses — minimal shape, cast to the public interface since the
// runner doesn't introspect deep fields.
// ---------------------------------------------------------------------------

function makeSearchResponse(entityIds: readonly string[] = []): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: { decisionStatus: 'resolved' } as unknown as SearchResponseV1['engineDecision'],
    results: entityIds.map((id) => ({ entity: { entityId: id } })) as unknown as SearchResponseV1['results'],
    meta: { generatedAt: new Date().toISOString() } as unknown as SearchResponseV1['meta'],
  };
}

function makeComparisonResponse(): ComparisonSearchResponse {
  return {
    queryType: 'comparison',
    meta: { generatedAt: new Date().toISOString() } as unknown as ComparisonSearchResponse['meta'],
  } as unknown as ComparisonSearchResponse;
}

function makeDrinkingWindowBlock(entityIdYear: number): DrinkingWindowBlock {
  return {
    drinkingWindowStart: entityIdYear,
    drinkingWindowEnd: entityIdYear + 10,
    peakYear: entityIdYear + 3,
    currentlyDrinkable: true,
    confidence: 0.8,
    evidenceLevel: 'predicted',
    blockingEligible: false,
    modelVersion: 'test-v1',
  } as unknown as DrinkingWindowBlock;
}

// ---------------------------------------------------------------------------
// Stub ports
// ---------------------------------------------------------------------------

function makeSearchPort(
  impl?: (
    input: SearchUseCaseInput,
    reqId: string,
    opts?: { readonly abortSignal?: AbortSignal | undefined },
  ) => Promise<SearchResponseV1>,
): SearchUseCasePort & { readonly executeMock: ReturnType<typeof vi.fn> } {
  const executeMock = vi.fn(impl ?? (() => Promise.resolve(makeSearchResponse(['e1', 'e2']))));
  return { executeMock, execute: executeMock };
}

function makeComparisonPort(
  impl?: (
    input: ComparisonUseCaseInput,
    reqId: string,
    opts?: { readonly abortSignal?: AbortSignal | undefined },
  ) => Promise<ComparisonSearchResponse>,
): ComparisonUseCasePort & { readonly executeMock: ReturnType<typeof vi.fn> } {
  const executeMock = vi.fn(impl ?? (() => Promise.resolve(makeComparisonResponse())));
  return { executeMock, execute: executeMock };
}

function makeDrinkabilityPort(
  impl?: (
    entityId: string,
    targetYear: number,
    reqId: string,
    opts?: { readonly abortSignal?: AbortSignal | undefined },
  ) => Promise<DrinkabilityProbe | undefined>,
): DrinkabilityUseCasePort & { readonly probeMock: ReturnType<typeof vi.fn> } {
  const probeMock = vi.fn(
    impl
    ?? ((entityId: string, targetYear: number) =>
      Promise.resolve({
        entityId,
        targetYear,
        window: makeDrinkingWindowBlock(targetYear),
      })),
  );
  return { probeMock, probe: probeMock };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ExecutionRunner — plan-kind dispatch', () => {
  it('single-search → invokes searchUseCase once', async () => {
    const search = makeSearchPort();
    const runner = new ExecutionRunner({ searchUseCase: search });
    const plan: ExecutionPlan = {
      kind: 'single-search',
      searchInput: { query: '와인' },
    };
    const out = await runner.run(plan, { requestId: REQUEST_ID, perStepTimeoutMs: PER_STEP_TIMEOUT_MS });
    expect(out.kind).toBe('search-result');
    expect(search.executeMock).toHaveBeenCalledTimes(1);
    expect(search.executeMock.mock.calls[0]?.[0]).toEqual({ query: '와인' });
  });

  it('comparison → invokes comparisonUseCase once', async () => {
    const search = makeSearchPort();
    const compare = makeComparisonPort();
    const runner = new ExecutionRunner({ searchUseCase: search, comparisonUseCase: compare });
    const plan: ExecutionPlan = {
      kind: 'comparison',
      comparisonInput: {
        originalQuery: 'A vs B',
        intent: 'compare',
        legs: [
          { surface: 'A', constraints: [] },
          { surface: 'B', constraints: [] },
        ],
      },
    };
    const out = await runner.run(plan, { requestId: REQUEST_ID, perStepTimeoutMs: PER_STEP_TIMEOUT_MS });
    expect(out.kind).toBe('comparison-result');
    expect(compare.executeMock).toHaveBeenCalledTimes(1);
    expect(search.executeMock).not.toHaveBeenCalled();
  });

  it('comparison plan without wired port → error outcome', async () => {
    const search = makeSearchPort();
    const runner = new ExecutionRunner({ searchUseCase: search });
    const plan: ExecutionPlan = {
      kind: 'comparison',
      comparisonInput: {
        originalQuery: 'A vs B',
        intent: 'compare',
        legs: [
          { surface: 'A', constraints: [] },
          { surface: 'B', constraints: [] },
        ],
      },
    };
    const out = await runner.run(plan, { requestId: REQUEST_ID, perStepTimeoutMs: PER_STEP_TIMEOUT_MS });
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.cause.message).toMatch(/comparisonUseCase port not wired/);
  });

  it('reject plan → rejected outcome, no use case called', async () => {
    const search = makeSearchPort();
    const runner = new ExecutionRunner({ searchUseCase: search });
    const out = await runner.run(
      { kind: 'reject', reason: 'unsupported_intent' },
      { requestId: REQUEST_ID, perStepTimeoutMs: PER_STEP_TIMEOUT_MS },
    );
    expect(out.kind).toBe('rejected');
    if (out.kind !== 'rejected') return;
    expect(out.reason).toBe('unsupported_intent');
    expect(search.executeMock).not.toHaveBeenCalled();
  });

  it('multi-step plan → multi-step-required outcome, no use case called', async () => {
    const search = makeSearchPort();
    const runner = new ExecutionRunner({ searchUseCase: search });
    const out = await runner.run(
      {
        kind: 'multi-step',
        handoff: {
          initialAction: 'search',
          budget: { maxSteps: 4, perToolCap: 3 },
          contract: {
            requiresDrinkabilityCheck: false,
            requiresGroundedWineSearch: true,
            hasEntityMetadataSignal: false,
          },
          seedSearchInput: { query: 'multi' },
        },
      },
      { requestId: REQUEST_ID, perStepTimeoutMs: PER_STEP_TIMEOUT_MS },
    );
    expect(out.kind).toBe('multi-step-required');
    expect(search.executeMock).not.toHaveBeenCalled();
  });
});

describe('ExecutionRunner — parallel-search', () => {
  it('runs all N searches in parallel and gathers results in order', async () => {
    const calls: string[] = [];
    const search = makeSearchPort(async (input, _reqId, _opts) => {
      calls.push(input.query);
      // small delay so the next slot has a chance to start before this one resolves
      await new Promise((r) => setTimeout(r, 5));
      return makeSearchResponse([`hit-${input.query}`]);
    });
    const runner = new ExecutionRunner({ searchUseCase: search });
    const plan: ExecutionPlan = {
      kind: 'parallel-search',
      searches: [
        { query: 'red' },
        { query: 'white' },
        { query: 'sparkling' },
      ],
    };
    const out = await runner.run(plan, { requestId: REQUEST_ID, perStepTimeoutMs: PER_STEP_TIMEOUT_MS });
    expect(out.kind).toBe('parallel-results');
    if (out.kind !== 'parallel-results') return;
    expect(out.results).toHaveLength(3);
    expect(search.executeMock).toHaveBeenCalledTimes(3);
    // Order in output matches input slot order.
    expect(out.results[0]?.results[0]?.entity.entityId).toBe('hit-red');
    expect(out.results[2]?.results[0]?.entity.entityId).toBe('hit-sparkling');
  });

  it('aborts all parallel legs when outer signal aborts', async () => {
    const controller = new AbortController();
    const search = makeSearchPort(async (_input, _reqId, opts) => {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        if (opts?.abortSignal?.aborted === true) {
          onAbort();
          return;
        }
        opts?.abortSignal?.addEventListener('abort', onAbort);
        // never resolves naturally
      });
      return makeSearchResponse([]);
    });
    const runner = new ExecutionRunner({ searchUseCase: search });
    const plan: ExecutionPlan = {
      kind: 'parallel-search',
      searches: [{ query: 'a' }, { query: 'b' }],
    };
    const runPromise = runner.run(plan, {
      requestId: REQUEST_ID,
      abortSignal: controller.signal,
      perStepTimeoutMs: PER_STEP_TIMEOUT_MS,
    });
    // Yield then abort.
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const out = await runPromise;
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.cause.name).toBe('AbortError');
  });
});

describe('ExecutionRunner — search-then-drinkability', () => {
  it('runs search then probes drinkability for up to maxAnchors results', async () => {
    const search = makeSearchPort(async () => makeSearchResponse(['w1', 'w2', 'w3']));
    const probe = makeDrinkabilityPort();
    const runner = new ExecutionRunner({ searchUseCase: search, drinkabilityUseCase: probe });
    const plan: ExecutionPlan = {
      kind: 'search-then-drinkability',
      searchInput: { query: 'Opus One' },
      drinkabilityTemplate: { targetYear: 2026, maxAnchors: 2 },
    };
    const out = await runner.run(plan, { requestId: REQUEST_ID, perStepTimeoutMs: PER_STEP_TIMEOUT_MS });
    expect(out.kind).toBe('search-then-drinkability');
    if (out.kind !== 'search-then-drinkability') return;
    expect(out.drinkability).toHaveLength(2);
    expect(probe.probeMock).toHaveBeenCalledTimes(2);
    expect(out.drinkability[0]?.entityId).toBe('w1');
    expect(out.drinkability[1]?.entityId).toBe('w2');
  });

  it('drops undefined probes (entity carries no drinkability)', async () => {
    const search = makeSearchPort(async () => makeSearchResponse(['has-dw', 'no-dw']));
    const probe = makeDrinkabilityPort(async (entityId, targetYear) => {
      if (entityId === 'no-dw') return undefined;
      return { entityId, targetYear, window: makeDrinkingWindowBlock(targetYear) };
    });
    const runner = new ExecutionRunner({ searchUseCase: search, drinkabilityUseCase: probe });
    const out = await runner.run(
      {
        kind: 'search-then-drinkability',
        searchInput: { query: 'q' },
        drinkabilityTemplate: { targetYear: 2026, maxAnchors: 2 },
      },
      { requestId: REQUEST_ID, perStepTimeoutMs: PER_STEP_TIMEOUT_MS },
    );
    expect(out.kind).toBe('search-then-drinkability');
    if (out.kind !== 'search-then-drinkability') return;
    expect(out.drinkability).toHaveLength(1);
    expect(out.drinkability[0]?.entityId).toBe('has-dw');
  });

  it('without drinkabilityUseCase port → returns search with empty drinkability', async () => {
    const search = makeSearchPort();
    const runner = new ExecutionRunner({ searchUseCase: search });
    const out = await runner.run(
      {
        kind: 'search-then-drinkability',
        searchInput: { query: 'q' },
        drinkabilityTemplate: { targetYear: 2026, maxAnchors: 2 },
      },
      { requestId: REQUEST_ID, perStepTimeoutMs: PER_STEP_TIMEOUT_MS },
    );
    expect(out.kind).toBe('search-then-drinkability');
    if (out.kind !== 'search-then-drinkability') return;
    expect(out.drinkability).toEqual([]);
  });
});

describe('ExecutionRunner — timeout & abort', () => {
  it('per-step timeout fires → error outcome', async () => {
    const search = makeSearchPort(() => new Promise<SearchResponseV1>(() => { /* never resolves */ }));
    const runner = new ExecutionRunner({ searchUseCase: search });
    const out = await runner.run(
      { kind: 'single-search', searchInput: { query: '와인' } },
      { requestId: REQUEST_ID, perStepTimeoutMs: 30 },
    );
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.cause.message).toMatch(/timed out/);
  });

  it('outer abort before start → error outcome (AbortError)', async () => {
    const search = makeSearchPort();
    const runner = new ExecutionRunner({ searchUseCase: search });
    const controller = new AbortController();
    controller.abort();
    const out = await runner.run(
      { kind: 'single-search', searchInput: { query: '와인' } },
      { requestId: REQUEST_ID, abortSignal: controller.signal, perStepTimeoutMs: PER_STEP_TIMEOUT_MS },
    );
    expect(out.kind).toBe('error');
    if (out.kind !== 'error') return;
    expect(out.cause.name).toBe('AbortError');
    expect(search.executeMock).not.toHaveBeenCalled();
  });

  it('Korean query + timeout → error outcome (multi-script regex safety)', async () => {
    const search = makeSearchPort(() => new Promise<SearchResponseV1>(() => { /* never resolves */ }));
    const runner = new ExecutionRunner({ searchUseCase: search });
    const out = await runner.run(
      { kind: 'single-search', searchInput: { query: '부르고뉴 피노누아 추천' } },
      { requestId: REQUEST_ID, perStepTimeoutMs: 30 },
    );
    expect(out.kind).toBe('error');
  });
});
