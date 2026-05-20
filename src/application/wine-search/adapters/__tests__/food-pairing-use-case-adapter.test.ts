/**
 * FoodPairingUseCaseAdapter — runner-port → FoodPairingUseCase
 * translation.
 */

import { describe, expect, it, vi } from 'vitest';
import type { SearchResponseV1 } from '../../../../domain/response/model/search-response.js';
import type {
  FoodPairingRequest,
  FoodPairingResponse,
  FoodPairingUseCase,
} from '../../../food-pairing/food-pairing.usecase.js';
import {
  FoodPairingUseCaseAdapter,
  mapFoodPairingInputToRequest,
} from '../food-pairing-use-case-adapter.js';
import type { FoodPairingUseCaseInput } from '../../execution-plan-schemas.js';

const REQUEST_ID = 'req-fp-adapter-01';

function makeSearchResponse(): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: { decisionStatus: 'resolved' } as unknown as SearchResponseV1['engineDecision'],
    results: [],
    meta: { generatedAt: new Date().toISOString() } as unknown as SearchResponseV1['meta'],
  };
}

interface StubFoodPairingUseCase {
  readonly execute: ReturnType<typeof vi.fn>;
}

function makeUseCase(
  impl?: (
    req: FoodPairingRequest,
    requestId: string,
    options?: { readonly abortSignal?: AbortSignal | undefined },
  ) => Promise<FoodPairingResponse>,
): StubFoodPairingUseCase {
  return {
    execute: vi.fn(
      impl
      ?? ((req: FoodPairingRequest) =>
        Promise.resolve<FoodPairingResponse>({ food: req.food, results: makeSearchResponse() })),
    ),
  };
}

function asUseCase(stub: StubFoodPairingUseCase): FoodPairingUseCase {
  return stub as unknown as FoodPairingUseCase;
}

describe('mapFoodPairingInputToRequest', () => {
  it('maps minimum input (food only)', () => {
    expect(mapFoodPairingInputToRequest({ food: 'steak' })).toEqual({ food: 'steak' });
  });

  it('preserves Hangul food strings', () => {
    expect(mapFoodPairingInputToRequest({ food: '비빔밥' })).toEqual({ food: '비빔밥' });
  });

  it('translates pairingTags (camel) → pairing_tags (snake)', () => {
    const req = mapFoodPairingInputToRequest({ food: 'pad thai', pairingTags: ['spicy_food'] });
    expect(req.pairing_tags).toEqual(['spicy_food']);
  });

  it('translates maxPriceKrw (camel) → max_price_krw (snake)', () => {
    const req = mapFoodPairingInputToRequest({ food: 'galbi', maxPriceKrw: 50000 });
    expect(req.max_price_krw).toBe(50000);
  });

  it('omits empty styles / pairingTags arrays', () => {
    const req = mapFoodPairingInputToRequest({ food: 'q', styles: [], pairingTags: [] });
    expect(req.styles).toBeUndefined();
    expect(req.pairing_tags).toBeUndefined();
  });

  it('forwards color verbatim including accented rosé', () => {
    expect(mapFoodPairingInputToRequest({ food: 'q', color: 'rosé' }).color).toBe('rosé');
  });
});

describe('FoodPairingUseCaseAdapter', () => {
  it('returns the {food, results} tuple', async () => {
    const stub = makeUseCase();
    const adapter = new FoodPairingUseCaseAdapter(asUseCase(stub));
    const out = await adapter.execute({ food: 'steak' } satisfies FoodPairingUseCaseInput, REQUEST_ID);
    expect(out.food).toBe('steak');
    expect(out.results.queryType).toBe('search');
  });

  it('threads requestId and abortSignal into the use case', async () => {
    const stub = makeUseCase();
    const adapter = new FoodPairingUseCaseAdapter(asUseCase(stub));
    const ctrl = new AbortController();
    await adapter.execute({ food: 'steak' }, REQUEST_ID, { abortSignal: ctrl.signal });
    const call = stub.execute.mock.calls[0] ?? [];
    expect(call[1]).toBe(REQUEST_ID);
    expect((call[2] as { abortSignal?: AbortSignal }).abortSignal).toBe(ctrl.signal);
  });

  it('omits abortSignal from options when caller does not pass one', async () => {
    const stub = makeUseCase();
    const adapter = new FoodPairingUseCaseAdapter(asUseCase(stub));
    await adapter.execute({ food: 'steak' }, REQUEST_ID);
    const opts = stub.execute.mock.calls[0]?.[2] as { abortSignal?: AbortSignal } | undefined;
    expect(opts?.abortSignal).toBeUndefined();
  });

  it('propagates errors from the underlying use case', async () => {
    const boom = new Error('pairing failed');
    const stub = makeUseCase(() => Promise.reject(boom));
    const adapter = new FoodPairingUseCaseAdapter(asUseCase(stub));
    await expect(adapter.execute({ food: 'q' }, REQUEST_ID)).rejects.toBe(boom);
  });

  it('forwards the typed input through the snake_case mapper', async () => {
    const stub = makeUseCase();
    const adapter = new FoodPairingUseCaseAdapter(asUseCase(stub));
    await adapter.execute(
      {
        food: 'pad thai',
        color: 'white',
        styles: ['off_dry'],
        pairingTags: ['spicy_food'],
        maxPriceKrw: 70000,
      },
      REQUEST_ID,
    );
    const req = stub.execute.mock.calls[0]?.[0] as FoodPairingRequest;
    expect(req).toEqual({
      food: 'pad thai',
      color: 'white',
      styles: ['off_dry'],
      pairing_tags: ['spicy_food'],
      max_price_krw: 70000,
    });
  });
});
