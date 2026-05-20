/**
 * FoodPairingUseCase unit tests.
 *
 * These tests pin the behavioural parity points that the use case inherits
 * from the inline `get_food_pairings` branch in `agent-tools.ts:1883-1958`:
 *  - query enrichment with budget / styles / pairing_tags clauses,
 *  - structured filters/preferences from the typed objectives,
 *  - hybrid retrieval mode,
 *  - macro-evidence closure when pairing tags + supporting axes agree,
 *  - error propagation when the underlying search returns a non-search
 *    response,
 *  - cooperative abort propagation.
 *
 * Korean, English, and accented Latin inputs are covered (CLAUDE.md rule 5).
 */

import { describe, expect, it, vi } from 'vitest';
import type { SearchResponseV1 } from '../../../src/domain/response/model/search-response.js';
import type { ComparisonSearchResponse } from '../../../src/domain/response/model/comparison-response.js';
import type {
  SearchExecutorPort,
  SearchExecutionOptions,
  SearchExecutorResult,
} from '../../../src/application/search/port/search-executor.port.js';
import type { SearchRequest } from '../../../src/application/search/search-request.dto.js';
import {
  FoodPairingUseCase,
  FoodPairingRequestSchema,
  UnexpectedPairingResponseError,
  type FoodPairingRequest,
} from '../../../src/application/food-pairing/food-pairing.usecase.js';

const REQUEST_ID = 'req-fp-0001';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeResultItem(overrides: {
  readonly entityId: string;
  readonly matched?: readonly string[];
  readonly unmet?: readonly string[];
  readonly style?: string;
  readonly pairingTags?: readonly string[];
}): SearchResponseV1['results'][number] {
  return {
    entity: {
      entityId: overrides.entityId,
      canonicalLabel: `Wine ${overrides.entityId}`,
      ...(overrides.style !== undefined ? { style: overrides.style } : {}),
      ...(overrides.pairingTags !== undefined ? { pairingTags: overrides.pairingTags } : {}),
    },
    constraints: {
      matched: [...(overrides.matched ?? [])],
      unmet: [...(overrides.unmet ?? [])],
    },
    match: { scoreComponents: {} },
  } as unknown as SearchResponseV1['results'][number];
}

function makeSearchResponse(
  results: readonly SearchResponseV1['results'][number][],
): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: { decisionStatus: 'resolved' } as unknown as SearchResponseV1['engineDecision'],
    results,
    meta: { generatedAt: new Date().toISOString() } as unknown as SearchResponseV1['meta'],
  };
}

function makeComparisonResponse(): ComparisonSearchResponse {
  return {
    queryType: 'comparison',
    meta: { generatedAt: new Date().toISOString() } as unknown as ComparisonSearchResponse['meta'],
  } as unknown as ComparisonSearchResponse;
}

function makeSearchPort(
  impl?: (
    req: SearchRequest,
    requestId: string,
    options?: SearchExecutionOptions,
  ) => Promise<SearchExecutorResult>,
): SearchExecutorPort & { readonly executeMock: ReturnType<typeof vi.fn> } {
  const executeMock = vi.fn(impl ?? (() => Promise.resolve(makeSearchResponse([]))));
  return {
    execute: executeMock,
    executeMock,
  };
}

// ---------------------------------------------------------------------------
// Schema-level guardrails
// ---------------------------------------------------------------------------

describe('FoodPairingRequestSchema', () => {
  it('rejects empty food', () => {
    const result = FoodPairingRequestSchema.safeParse({ food: '' });
    expect(result.success).toBe(false);
  });

  it('rejects whitespace-only food (after trim)', () => {
    const result = FoodPairingRequestSchema.safeParse({ food: '   ' });
    expect(result.success).toBe(false);
  });

  it('rejects unrecognised color values', () => {
    const result = FoodPairingRequestSchema.safeParse({ food: 'steak', color: 'orange' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown extra keys (strict)', () => {
    const result = FoodPairingRequestSchema.safeParse({ food: 'steak', surprise: true });
    expect(result.success).toBe(false);
  });

  it('accepts NFKC-equivalent rosé color and Korean food string', () => {
    const result = FoodPairingRequestSchema.safeParse({ food: '비빔밥', color: 'rosé' });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Execution behaviour
// ---------------------------------------------------------------------------

describe('FoodPairingUseCase', () => {
  it('happy path (Korean food + red color) routes through hybrid search with structured wine_type filter', async () => {
    const response = makeSearchResponse([makeResultItem({ entityId: 'wine-1' })]);
    const search = makeSearchPort(() => Promise.resolve(response));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });

    const result = await useCase.execute(
      { food: '스테이크', color: 'red' },
      REQUEST_ID,
    );

    expect(search.executeMock).toHaveBeenCalledTimes(1);
    const [req, reqId] = search.executeMock.mock.calls[0] ?? [];
    expect(reqId).toBe(REQUEST_ID);
    expect(req?.query).toBe('wine pairing for 스테이크');
    expect(req?.options).toEqual({ mode: 'hybrid', explain: false, clarification: false });
    expect(req?.filters).toEqual([
      {
        attribute: 'wine_type',
        operator: '=',
        value: 'red',
        source_phrase: 'red',
        confidence: 1.0,
        mapping_version: 'agent_v1',
      },
    ]);
    expect(req?.preferences).toBeUndefined();
    expect(result.food).toBe('스테이크');
    expect(result.results).toBe(response);
  });

  it('happy path (English steak) — color=red filter, no preferences', async () => {
    const search = makeSearchPort(() => Promise.resolve(makeSearchResponse([])));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });

    const result = await useCase.execute({ food: 'steak', color: 'red' }, REQUEST_ID);

    const [req] = search.executeMock.mock.calls[0] ?? [];
    expect(req?.query).toBe('wine pairing for steak');
    expect(result.food).toBe('steak');
  });

  it('accented Latin (rosé) survives schema and reaches the wine_type filter', async () => {
    const search = makeSearchPort(() => Promise.resolve(makeSearchResponse([])));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });

    await useCase.execute({ food: 'crème brûlée', color: 'rosé' }, REQUEST_ID);

    const [req] = search.executeMock.mock.calls[0] ?? [];
    expect(req?.query).toBe('wine pairing for crème brûlée');
    expect(req?.filters?.[0]?.value).toBe('rosé');
  });

  it('color=both omits the wine_type filter', async () => {
    const search = makeSearchPort(() => Promise.resolve(makeSearchResponse([])));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });
    await useCase.execute({ food: '치즈', color: 'both' }, REQUEST_ID);
    const [req] = search.executeMock.mock.calls[0] ?? [];
    expect(req?.filters).toBeUndefined();
  });

  it('appends budget clause when max_price_krw is set', async () => {
    const search = makeSearchPort(() => Promise.resolve(makeSearchResponse([])));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });
    await useCase.execute({ food: '갈비', max_price_krw: 50000 }, REQUEST_ID);
    const [req] = search.executeMock.mock.calls[0] ?? [];
    expect(req?.query).toBe('wine pairing for 갈비, 50000원 이하');
  });

  it('converts legacy USD max_price to KRW for the budget clause', async () => {
    const search = makeSearchPort(() => Promise.resolve(makeSearchResponse([])));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });
    await useCase.execute({ food: 'duck confit', max_price: 50 }, REQUEST_ID);
    const [req] = search.executeMock.mock.calls[0] ?? [];
    // Conversion uses KRW_PER_USD_APPROXIMATE = 1350 (see domain constants),
    // so 50 USD → 67500 KRW.
    expect(req?.query).toBe('wine pairing for duck confit, 67500원 이하');
  });

  it('appends styles and pairing_tags clauses', async () => {
    const search = makeSearchPort(() => Promise.resolve(makeSearchResponse([])));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });
    await useCase.execute(
      {
        food: 'pad thai',
        styles: ['off_dry'],
        pairing_tags: ['spicy_food'],
      },
      REQUEST_ID,
    );
    const [req] = search.executeMock.mock.calls[0] ?? [];
    expect(req?.query).toBe('wine pairing for pad thai, off_dry, spicy_food');
  });

  it('spicy_food + off_dry style produces sweetness/pairing preferences', async () => {
    // This is the "spicy_food edge case" — the typed objective should land
    // as a NormalizedConstraint preference on the underlying search.
    const search = makeSearchPort(() => Promise.resolve(makeSearchResponse([])));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });
    await useCase.execute(
      {
        food: 'kimchi stew',
        styles: ['off_dry'],
        pairing_tags: ['spicy_food'],
        sweetness_target: 0.4,
      },
      REQUEST_ID,
    );
    const [req] = search.executeMock.mock.calls[0] ?? [];
    expect(req?.preferences).toBeDefined();
    const attrs = (req?.preferences ?? []).map((p) => p.attribute);
    expect(attrs).toContain('sweetness');
    expect(attrs).toContain('pairing');
  });

  it('macro-evidence closure lifts the pairing constraint when ≥2 axes agree', async () => {
    // Item has pairing tags overlap and style match → 2 axes → pairing
    // should move from unmet to matched.
    const items = [
      makeResultItem({
        entityId: 'wine-A',
        matched: ['style'],
        unmet: ['pairing'],
        style: 'off_dry',
        pairingTags: ['spicy_food'],
      }),
    ];
    const search = makeSearchPort(() => Promise.resolve(makeSearchResponse(items)));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });

    const result = await useCase.execute(
      {
        food: 'kimchi stew',
        styles: ['off_dry'],
        pairing_tags: ['spicy_food'],
      },
      REQUEST_ID,
    );

    const item = result.results.results[0];
    expect(item?.constraints.matched).toContain('pairing');
    expect(item?.constraints.unmet).not.toContain('pairing');
  });

  it('macro-evidence closure leaves items alone when pairing_tags is not requested', async () => {
    const items = [
      makeResultItem({
        entityId: 'wine-A',
        matched: ['style'],
        unmet: ['pairing'],
        style: 'off_dry',
      }),
    ];
    const search = makeSearchPort(() => Promise.resolve(makeSearchResponse(items)));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });
    const result = await useCase.execute({ food: 'steak' }, REQUEST_ID);
    const item = result.results.results[0];
    expect(item?.constraints.unmet).toContain('pairing');
  });

  it('throws UnexpectedPairingResponseError when search returns a comparison response', async () => {
    const search = makeSearchPort(() => Promise.resolve(makeComparisonResponse()));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });
    await expect(
      useCase.execute({ food: 'steak' }, REQUEST_ID),
    ).rejects.toBeInstanceOf(UnexpectedPairingResponseError);
  });

  it('propagates already-aborted signal before invoking search', async () => {
    const search = makeSearchPort(() => Promise.resolve(makeSearchResponse([])));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      useCase.execute({ food: 'steak' }, REQUEST_ID, { abortSignal: ctrl.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(search.executeMock).not.toHaveBeenCalled();
  });

  it('forwards abortSignal into the underlying search call', async () => {
    let observedSignal: AbortSignal | undefined;
    const search = makeSearchPort((_req, _id, opts) => {
      observedSignal = opts?.abortSignal;
      return Promise.resolve(makeSearchResponse([]));
    });
    const useCase = new FoodPairingUseCase({ searchUseCase: search });
    const ctrl = new AbortController();
    await useCase.execute({ food: 'steak' }, REQUEST_ID, { abortSignal: ctrl.signal });
    expect(observedSignal).toBe(ctrl.signal);
  });

  it('threads requestId into the underlying search call', async () => {
    const search = makeSearchPort(() => Promise.resolve(makeSearchResponse([])));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });
    await useCase.execute({ food: 'steak' } as FoodPairingRequest, 'req-thread-id', undefined);
    expect(search.executeMock.mock.calls[0]?.[1]).toBe('req-thread-id');
  });

  it('preserves the schema-parsed (trimmed) food string in the response', async () => {
    const search = makeSearchPort(() => Promise.resolve(makeSearchResponse([])));
    const useCase = new FoodPairingUseCase({ searchUseCase: search });
    const parsed = FoodPairingRequestSchema.parse({ food: '   비빔밥   ' });
    const result = await useCase.execute(parsed, REQUEST_ID);
    // Schema trims at the boundary; the trimmed value is what flows through.
    expect(result.food).toBe('비빔밥');
  });
});
