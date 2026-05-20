/**
 * ComparisonUseCaseAdapter — leg mapping, parent-context construction,
 * and use-case wiring.
 */

import { describe, expect, it, vi } from 'vitest';
import type { DecomposedSearchUseCase } from '../../../search/decomposed-search.usecase.js';
import type { ComparisonSearchResponse } from '../../../../domain/response/model/comparison-response.js';
import type { NormalizedConstraint } from '../../../../domain/shared/types/index.js';
import {
  ComparisonUseCaseAdapter,
  buildParentContext,
  mapComparisonLegToDecompositionLeg,
  mapComparisonLegsToDecompositionLegs,
} from '../comparison-use-case-adapter.js';
import type { ComparisonUseCaseInput } from '../../execution-plan-schemas.js';

const REQUEST_ID = 'req-cmp-adapter-01';

function makeConstraint(value: string): NormalizedConstraint {
  return {
    attribute: 'country',
    operator: '=' as const,
    value,
    source_phrase: value,
    confidence: 1.0,
    mapping_version: 'test',
  };
}

function makeComparisonInput(overrides: Partial<ComparisonUseCaseInput> = {}): ComparisonUseCaseInput {
  return {
    originalQuery: 'A vs B',
    intent: 'compare',
    legs: [
      { surface: 'A', constraints: [] },
      { surface: 'B', constraints: [] },
    ],
    ...overrides,
  } as ComparisonUseCaseInput;
}

interface StubDecomposedUseCase {
  readonly execute: ReturnType<typeof vi.fn>;
}

function makeUseCase(): StubDecomposedUseCase {
  return {
    execute: vi.fn(() => Promise.resolve({
      queryType: 'comparison',
    } as unknown as ComparisonSearchResponse)),
  };
}

function asUseCase(stub: StubDecomposedUseCase): DecomposedSearchUseCase {
  return stub as unknown as DecomposedSearchUseCase;
}

describe('mapComparisonLegToDecompositionLeg', () => {
  it('lifts surface into rawQuery/retrievalQuery and uses entity-default tuple', () => {
    const leg = mapComparisonLegToDecompositionLeg({ surface: 'Pauillac', constraints: [] });
    expect(leg).toEqual({
      rawQuery: 'Pauillac',
      retrievalQuery: 'Pauillac',
      mode: 'entity',
      retrievalMode: 'auto',
      evidenceSource: 'entity_default',
    });
  });

  it('handles Hangul surfaces verbatim', () => {
    const leg = mapComparisonLegToDecompositionLeg({ surface: '샤또 마고', constraints: [] });
    expect(leg.rawQuery).toBe('샤또 마고');
    expect(leg.retrievalQuery).toBe('샤또 마고');
  });
});

describe('mapComparisonLegsToDecompositionLegs', () => {
  it('produces a two-tuple in the runner order', () => {
    const legs = mapComparisonLegsToDecompositionLegs([
      { surface: 'A', constraints: [] },
      { surface: 'B', constraints: [] },
    ]);
    expect(legs).toHaveLength(2);
    expect(legs[0].rawQuery).toBe('A');
    expect(legs[1].rawQuery).toBe('B');
  });
});

describe('buildParentContext', () => {
  it('returns undefined when no shared / per-side constraints are set', () => {
    expect(buildParentContext(makeComparisonInput())).toBeUndefined();
  });

  it('forwards sharedFilters into filters', () => {
    const ctx = buildParentContext(makeComparisonInput({ sharedFilters: [makeConstraint('France')] }));
    expect(ctx?.filters).toEqual([makeConstraint('France')]);
  });

  it('forwards sharedPreferences into preferences', () => {
    const ctx = buildParentContext(makeComparisonInput({ sharedPreferences: [makeConstraint('Italy')] }));
    expect(ctx?.preferences).toEqual([makeConstraint('Italy')]);
  });

  it('builds perSideFilters when legs carry constraints', () => {
    const input = makeComparisonInput({
      legs: [
        { surface: 'A', constraints: [makeConstraint('France')] },
        { surface: 'B', constraints: [makeConstraint('Italy')] },
      ],
    });
    const ctx = buildParentContext(input);
    expect(ctx?.perSideFilters).toEqual([
      [makeConstraint('France')],
      [makeConstraint('Italy')],
    ]);
  });

  it('uses undefined slots when only one leg has constraints', () => {
    const input = makeComparisonInput({
      legs: [
        { surface: 'A', constraints: [makeConstraint('France')] },
        { surface: 'B', constraints: [] },
      ],
    });
    const ctx = buildParentContext(input);
    expect(ctx?.perSideFilters).toEqual([
      [makeConstraint('France')],
      undefined,
    ]);
  });

  it('drops empty sharedFilters arrays', () => {
    const ctx = buildParentContext(makeComparisonInput({ sharedFilters: [] }));
    expect(ctx).toBeUndefined();
  });
});

describe('ComparisonUseCaseAdapter', () => {
  it('forwards subQueries, intent, originalQuery, requestId, and abortSignal', async () => {
    const stub = makeUseCase();
    const adapter = new ComparisonUseCaseAdapter(asUseCase(stub));
    const ctrl = new AbortController();

    await adapter.execute(
      makeComparisonInput({
        originalQuery: 'A vs B',
        intent: 'recommend_one',
        legs: [
          { surface: 'A', constraints: [] },
          { surface: 'B', constraints: [] },
        ],
      }),
      REQUEST_ID,
      { abortSignal: ctrl.signal },
    );

    expect(stub.execute).toHaveBeenCalledTimes(1);
    const call = stub.execute.mock.calls[0] ?? [];
    expect(call[0]).toEqual(['A', 'B']);
    // call[1] = comparison legs
    expect((call[1] as readonly { rawQuery: string }[])[0]?.rawQuery).toBe('A');
    expect(call[2]).toBe('recommend_one');
    expect(call[3]).toBe('A vs B');
    expect(call[4]).toBe(REQUEST_ID);
    expect(typeof call[5]).toBe('number'); // startTime
    expect(call[7]).toMatchObject({ requestId: REQUEST_ID, abortSignal: ctrl.signal });
  });

  it('passes through the comparison response unchanged', async () => {
    const out = { queryType: 'comparison' } as unknown as ComparisonSearchResponse;
    const stub: StubDecomposedUseCase = { execute: vi.fn(() => Promise.resolve(out)) };
    const adapter = new ComparisonUseCaseAdapter(asUseCase(stub));
    const got = await adapter.execute(makeComparisonInput(), REQUEST_ID);
    expect(got).toBe(out);
  });

  it('propagates errors from the underlying use case', async () => {
    const boom = new Error('decomposition failed');
    const stub: StubDecomposedUseCase = { execute: vi.fn(() => Promise.reject(boom)) };
    const adapter = new ComparisonUseCaseAdapter(asUseCase(stub));
    await expect(adapter.execute(makeComparisonInput(), REQUEST_ID)).rejects.toBe(boom);
  });

  it('attaches per-side filters when legs carry constraints', async () => {
    const stub = makeUseCase();
    const adapter = new ComparisonUseCaseAdapter(asUseCase(stub));
    await adapter.execute(
      makeComparisonInput({
        legs: [
          { surface: 'A', constraints: [makeConstraint('France')] },
          { surface: 'B', constraints: [makeConstraint('Italy')] },
        ],
      }),
      REQUEST_ID,
    );
    const parentContext = stub.execute.mock.calls[0]?.[6];
    expect(parentContext?.perSideFilters).toEqual([
      [makeConstraint('France')],
      [makeConstraint('Italy')],
    ]);
  });

  it('omits abortSignal from options when caller does not provide one', async () => {
    const stub = makeUseCase();
    const adapter = new ComparisonUseCaseAdapter(asUseCase(stub));
    await adapter.execute(makeComparisonInput(), REQUEST_ID);
    const opts = stub.execute.mock.calls[0]?.[7];
    expect(opts).toMatchObject({ requestId: REQUEST_ID });
    expect((opts as { abortSignal?: AbortSignal }).abortSignal).toBeUndefined();
  });
});
