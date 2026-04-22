import { describe, expect, it, vi } from 'vitest';
import { AutocompleteUseCase } from '../../../../src/application/search/autocomplete.usecase.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import type { EntityDocumentLookupPort } from '../../../../src/application/search/port/search-pipeline-deps.port.js';
import type { ResolveUseCasePort } from '../../../../src/application/search/port/search-route-usecases.port.js';

describe('AutocompleteUseCase', () => {
  it('hydrates resolver candidates into authoritative autocomplete suggestion cards', async () => {
    const entityId = createEntityId('opus-one-2018');
    const resolveUseCase: ResolveUseCasePort = {
      execute: vi.fn().mockResolvedValue({
        status: 'resolved',
        candidates: [
          {
            entityId,
            canonicalLabel: 'Opus One 2018',
            rank: 1,
            calibratedScore: 0.97,
            evidenceRefs: ['resolver:alias_exact:opus-one-2018'],
            source: 'alias',
            sources: ['alias'],
          },
        ],
        topEntity: {
          entityId,
          canonicalLabel: 'Opus One 2018',
          calibratedScore: 0.97,
        },
        decision_trace_ref: 'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        authority_trace_ref: 'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        request_id: 'req-autocomplete-1',
      }),
    };
    const entityLookup: EntityDocumentLookupPort = {
      getDocuments: vi.fn().mockResolvedValue(new Map([
        [entityId, {
          entityId,
          entityType: 'wine',
          canonicalLabel: 'Opus One 2018',
          aliasesIdentitySafe: ['Opus One 2018'],
          aliasesNoisyRecall: ['opus one'],
          producer: 'Opus One',
          region: 'Napa Valley',
          country: 'United States',
          appellation: 'Oakville',
          grapes: ['Cabernet Sauvignon'],
          searchTextKo: '오푸스원 2018 나파 밸리',
          searchTextEn: 'Opus One 2018 Napa Valley',
          semanticSummary: 'Flagship Napa Valley Bordeaux blend.',
          style: 'full red',
          priceBand: 'luxury',
          pairing: ['steak'],
          availability: true,
          popularityScore: 0.98,
          vintageYear: 2018,
          wineType: 'red',
        }],
      ])),
    };

    const useCase = new AutocompleteUseCase({
      resolveUseCase,
      entityLookup,
    });

    const result = await useCase.execute({
      query: 'opu',
      requestId: 'req-autocomplete-1',
    });

    expect(resolveUseCase.execute).toHaveBeenCalledWith(
      { query: 'opu', requestId: 'req-autocomplete-1' },
      undefined,
    );
    expect(entityLookup.getDocuments).toHaveBeenCalledWith([entityId]);
    expect(result).toMatchObject({
      status: 'resolved',
      suggestions: [
        {
          entity: {
            entity_id: entityId,
            canonical_label: 'Opus One 2018',
            entity_type: 'wine',
            producer: 'Opus One',
            region: 'Napa Valley',
            country: 'United States',
            appellation: 'Oakville',
            vintage: 2018,
            wine_type: 'red',
            grapes: ['Cabernet Sauvignon'],
            availability: true,
          },
          calibrated_score: 0.97,
          rank: 1,
          source: 'alias',
        },
      ],
      decision_trace_ref: 'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      authority_trace_ref: 'decision:v1:short_entity:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      request_id: 'req-autocomplete-1',
    });
  });

  it('falls back to resolver labels when document hydration misses an entity', async () => {
    const entityId = createEntityId('mystery-wine');
    const resolveUseCase: ResolveUseCasePort = {
      execute: vi.fn().mockResolvedValue({
        status: 'ambiguous',
        candidates: [
          {
            entityId,
            canonicalLabel: 'Mystery Wine',
            rank: 1,
            calibratedScore: 0.61,
            evidenceRefs: [],
            source: 'blocker_seed',
            blockerSeed: true,
          },
        ],
        topEntity: undefined,
        decision_trace_ref: 'decision:v1:short_entity:1111111111111111111111111111111111111111111111111111111111111111',
        authority_trace_ref: 'decision:v1:short_entity:1111111111111111111111111111111111111111111111111111111111111111',
      }),
    };

    const useCase = new AutocompleteUseCase({
      resolveUseCase,
      entityLookup: {
        getDocuments: vi.fn().mockResolvedValue(new Map()),
      },
    });

    const result = await useCase.execute({ query: 'myst' });

    expect(result.suggestions).toEqual([
      {
        entity: {
          entity_id: entityId,
          canonical_label: 'Mystery Wine',
        },
        rank: 1,
        calibrated_score: 0.61,
        source: 'blocker_seed',
        blocker_seed: true,
      },
    ]);
  });
});
