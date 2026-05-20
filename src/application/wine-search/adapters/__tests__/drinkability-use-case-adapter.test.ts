/**
 * DrinkabilityUseCaseAdapter — entity-lookup + use-case wiring tests.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CanonicalEntityId } from '../../../../domain/shared/types/index.js';
import { createCanonicalEntityId } from '../../../../domain/shared/types/index.js';
import type { RetrievalDocument } from '../../../../domain/retrieval/model/retrieval-document.js';
import type { DrinkingWindowBlock } from '../../../../domain/response/model/result-item.js';
import type {
  DrinkingWindowCheckRequest,
  DrinkingWindowUseCasePort,
} from '../../../drinking-window/port/drinking-window-usecase.port.js';
import {
  DrinkabilityUseCaseAdapter,
  mapRetrievalDocumentToCheckRequest,
} from '../drinkability-use-case-adapter.js';

const REQUEST_ID = 'req-dw-adapter-01';

function makeDoc(overrides: Partial<RetrievalDocument> = {}): RetrievalDocument {
  return {
    entityId: createCanonicalEntityId('entity-1'),
    entityType: 'wine',
    canonicalLabel: 'Test Wine',
    producer: 'Test Producer',
    region: 'Test Region',
    grapes: ['Cabernet Sauvignon'],
    aliasesIdentitySafe: [],
    aliasesNoisyRecall: [],
    searchTextKo: '',
    searchTextEn: '',
    semanticSummary: '',
    style: 'red',
    priceBand: '$20-$30',
    pairing: [],
    availability: true,
    popularityScore: 0.5,
    vintageYear: 2020,
    grapePrimaryEnc: 1,
    regionEnc: 2,
    countryEnc: 3,
    tannin: 4,
    acidity: 3,
    avgCriticProxyScore: 88,
    ...overrides,
  } as unknown as RetrievalDocument;
}

function makeBlock(): DrinkingWindowBlock {
  return {
    drinkingWindowStart: 2024,
    drinkingWindowEnd: 2030,
    peakYear: 2027,
    currentlyDrinkable: true,
    confidence: 'high',
    evidenceLevel: 'learned',
    blockingEligible: true,
    modelVersion: 'test-v1',
  } as unknown as DrinkingWindowBlock;
}

function makeUseCasePort(
  impl?: (req: DrinkingWindowCheckRequest) => Promise<DrinkingWindowBlock>,
): DrinkingWindowUseCasePort & { readonly checkMock: ReturnType<typeof vi.fn> } {
  const checkMock = vi.fn(impl ?? (() => Promise.resolve(makeBlock())));
  return { check: checkMock, checkMock };
}

describe('mapRetrievalDocumentToCheckRequest', () => {
  it('returns undefined when vintage is missing', () => {
    const doc = makeDoc({ vintageYear: undefined });
    expect(mapRetrievalDocumentToCheckRequest(doc, 2027)).toBeUndefined();
  });

  it('returns undefined when vintage is NaN', () => {
    const doc = makeDoc({ vintageYear: Number.NaN });
    expect(mapRetrievalDocumentToCheckRequest(doc, 2027)).toBeUndefined();
  });

  it('fills the predictor-required fields from the projection', () => {
    const req = mapRetrievalDocumentToCheckRequest(makeDoc(), 2027);
    expect(req).toMatchObject({
      vintage: 2020,
      grapePrimaryEnc: 1,
      regionEnc: 2,
      countryEnc: 3,
      tannin: 4,
      acidity: 3,
      avgCriticProxyScore: 88,
      targetYear: 2027,
    });
  });

  it('falls back to the documented constants when encoded / sensory fields are absent', () => {
    const doc = makeDoc({
      grapePrimaryEnc: undefined,
      regionEnc: undefined,
      countryEnc: undefined,
      tannin: undefined,
      acidity: undefined,
      avgCriticProxyScore: undefined,
    });
    const req = mapRetrievalDocumentToCheckRequest(doc, 2027);
    expect(req?.grapePrimaryEnc).toBe(0);
    expect(req?.regionEnc).toBe(0);
    expect(req?.countryEnc).toBe(0);
    expect(req?.tannin).toBe(3);
    expect(req?.acidity).toBe(3);
    // DEFAULT_DRINKING_WINDOW_CRITIC_PROXY_SCORE = 80
    expect(req?.avgCriticProxyScore).toBe(80);
  });

  it('forwards optional prior drinking-window fields when present', () => {
    const doc = makeDoc({
      drinkingWindowStart: 2024,
      drinkingWindowEnd: 2030,
      drinkingWindowModelVersion: 'snapshot:v1',
    });
    const req = mapRetrievalDocumentToCheckRequest(doc, 2027);
    expect(req?.priorDrinkingWindowStart).toBe(2024);
    expect(req?.priorDrinkingWindowEnd).toBe(2030);
    expect(req?.priorDrinkingWindowModelVersion).toBe('snapshot:v1');
  });
});

describe('DrinkabilityUseCaseAdapter', () => {
  it('returns undefined when the entity lookup yields nothing', async () => {
    const useCasePort = makeUseCasePort();
    const adapter = new DrinkabilityUseCaseAdapter({
      drinkingWindowUseCase: useCasePort,
      entityLookup: () => Promise.resolve(undefined),
    });
    const result = await adapter.probe('missing-id', 2027, REQUEST_ID);
    expect(result).toBeUndefined();
    expect(useCasePort.checkMock).not.toHaveBeenCalled();
  });

  it('returns undefined when the projection lacks vintage', async () => {
    const useCasePort = makeUseCasePort();
    const adapter = new DrinkabilityUseCaseAdapter({
      drinkingWindowUseCase: useCasePort,
      entityLookup: () => Promise.resolve(makeDoc({ vintageYear: undefined })),
    });
    const result = await adapter.probe('entity-1', 2027, REQUEST_ID);
    expect(result).toBeUndefined();
    expect(useCasePort.checkMock).not.toHaveBeenCalled();
  });

  it('returns a probe with the entityId / targetYear / block when lookup + check succeed', async () => {
    const block = makeBlock();
    const useCasePort = makeUseCasePort(() => Promise.resolve(block));
    const adapter = new DrinkabilityUseCaseAdapter({
      drinkingWindowUseCase: useCasePort,
      entityLookup: () => Promise.resolve(makeDoc()),
    });
    const result = await adapter.probe('entity-1', 2027, REQUEST_ID);
    expect(result).toEqual({
      entityId: 'entity-1',
      targetYear: 2027,
      window: block,
    });
  });

  it('passes the canonical entityId to the lookup port', async () => {
    let observed: CanonicalEntityId | undefined;
    const useCasePort = makeUseCasePort();
    const adapter = new DrinkabilityUseCaseAdapter({
      drinkingWindowUseCase: useCasePort,
      entityLookup: (id) => {
        observed = id;
        return Promise.resolve(makeDoc());
      },
    });
    await adapter.probe('entity-1', 2027, REQUEST_ID);
    expect(observed).toBe(createCanonicalEntityId('entity-1'));
  });

  it('throws AbortError when caller pre-aborts', async () => {
    const useCasePort = makeUseCasePort();
    const lookupMock = vi.fn(() => Promise.resolve(makeDoc()));
    const adapter = new DrinkabilityUseCaseAdapter({
      drinkingWindowUseCase: useCasePort,
      entityLookup: lookupMock,
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(adapter.probe('entity-1', 2027, REQUEST_ID, { abortSignal: ctrl.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(lookupMock).not.toHaveBeenCalled();
    expect(useCasePort.checkMock).not.toHaveBeenCalled();
  });

  it('forwards the abortSignal into the entity lookup', async () => {
    let observed: AbortSignal | undefined;
    const useCasePort = makeUseCasePort();
    const adapter = new DrinkabilityUseCaseAdapter({
      drinkingWindowUseCase: useCasePort,
      entityLookup: (_id, opts) => {
        observed = opts?.abortSignal;
        return Promise.resolve(makeDoc());
      },
    });
    const ctrl = new AbortController();
    await adapter.probe('entity-1', 2027, REQUEST_ID, { abortSignal: ctrl.signal });
    expect(observed).toBe(ctrl.signal);
  });

  it('propagates check() errors', async () => {
    const boom = new Error('predictor blew up');
    const useCasePort = makeUseCasePort(() => Promise.reject(boom));
    const adapter = new DrinkabilityUseCaseAdapter({
      drinkingWindowUseCase: useCasePort,
      entityLookup: () => Promise.resolve(makeDoc()),
    });
    await expect(adapter.probe('entity-1', 2027, REQUEST_ID)).rejects.toBe(boom);
  });
});
