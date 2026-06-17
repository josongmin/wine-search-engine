import { describe, expect, it, vi } from 'vitest';
import { buildAutocompleteQueryRunner } from '../../../../src/application/search/autocomplete-query-runner.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';
import { wrapEntityDocumentBatchLookupAsResolverProjection } from '../../../../src/application/search/__tests__/resolver-projection-lookup.stub.js';
import type { LookupResolverProjectionPort } from '../../../../src/application/search/port/search-pipeline-deps.port.js';
import type { EntityLookupV2UseCasePort } from '../../../../src/application/search/port/search-route-usecases.port.js';
import type { EntityLookupV2Result } from '../../../../src/application/search/entity-lookup-v2/entity-lookup-v2.dto.js';

function makeLookupV2Result(overrides: Partial<EntityLookupV2Result> = {}): EntityLookupV2Result {
  return {
    status: 'resolved',
    decisionReason: 'Confidently resolved to a single wine entity.',
    normalizedQueryViews: {
      raw: 'opu',
      strict: 'opu',
      accentless: 'opu',
      compact: 'opu',
      vintageCanonicalized: 'opu',
      vintageStripped: 'opu',
      lookupVariants: ['opu'],
    },
    candidates: [],
    topCandidate: null,
    clarificationOptions: [],
    evidenceSummary: {
      admissionReasonCode: 'admit_entity_lookup',
      decisionReasonCode: 'resolved_single_candidate',
      calibrationTrusted: true,
      queryClass: 'short_entity',
      candidatePoolSize: 0,
      channelCoverage: [],
    },
    meta: {
      queryTimeMs: 1,
      version: 'entity-lookup-v2/1.0.0',
      engineSchemaVersion: 'entity_lookup_v2',
    },
    ...overrides,
  };
}

describe('AutocompleteQueryRunner', () => {
  it('hydrates V2 candidates into authoritative autocomplete suggestion cards', async () => {
    const entityId = createEntityId('opus-one-2018');
    const entityLookupV2UseCase: EntityLookupV2UseCasePort = {
      execute: vi.fn().mockResolvedValue(makeLookupV2Result({
        candidates: [
          {
            entityId,
            canonicalLabel: 'Opus One 2018',
            entityType: 'wine',
            rank: 1,
            calibratedScore: 0.97,
            channelAgreement: 1,
            channelHits: [
              {
                channel: 'alias_exact',
                matchedView: 'opu',
                channelScore: 0.97,
                channelRank: 1,
              },
            ],
          },
        ],
        topCandidate: {
          entityId,
          canonicalLabel: 'Opus One 2018',
          entityType: 'wine',
          rank: 1,
          calibratedScore: 0.97,
          channelAgreement: 1,
          channelHits: [],
        },
        meta: {
          requestId: 'req-autocomplete-1',
          queryTimeMs: 1,
          version: 'entity-lookup-v2/1.0.0',
          engineSchemaVersion: 'entity_lookup_v2',
        },
      })),
    };
    const resolverProjectionLookup: LookupResolverProjectionPort = {
      getResolverProjections: vi.fn().mockResolvedValue(new Map([
        [entityId, {
          entityId,
          entityType: 'wine',
          canonicalLabel: 'Opus One 2018',
          aliasesIdentitySafe: ['Opus One 2018'],
          identitySafeKeys: ['opus one'],
          producer: 'Opus One',
          attributeHints: {
            region: 'Napa Valley',
            country: 'United States',
            appellation: 'Oakville',
            vintage: 2018,
            wine_type: 'red',
            grapes: ['Cabernet Sauvignon'],
          },
        }],
      ])),
    };

    const runner = buildAutocompleteQueryRunner({
      entityLookupV2UseCase,
      resolverProjectionLookup,
    });

    const result = await runner.execute({
      query: 'opu',
      requestId: 'req-autocomplete-1',
    });

    expect(entityLookupV2UseCase.execute).toHaveBeenCalledWith(
      {
        query: 'opu',
        requestId: 'req-autocomplete-1',
        maxCandidates: 10,
        mode: 'default',
      },
      undefined,
    );
    expect(resolverProjectionLookup.getResolverProjections).toHaveBeenCalledWith([entityId]);
    expect(result.status).toBe('resolved');
    expect(result.request_id).toBe('req-autocomplete-1');
    expect(result.decision_trace_ref).toBe(result.authority_trace_ref);
    expect(result.suggestions).toMatchObject([
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
        },
        calibrated_score: 0.97,
        rank: 1,
      },
    ]);
  });

  it('falls back to V2 labels when document hydration misses an entity', async () => {
    const entityId = createEntityId('mystery-wine');
    const entityLookupV2UseCase: EntityLookupV2UseCasePort = {
      execute: vi.fn().mockResolvedValue(makeLookupV2Result({
        status: 'ambiguous',
        candidates: [
          {
            entityId,
            canonicalLabel: 'Mystery Wine',
            rank: 1,
            calibratedScore: 0.61,
            channelAgreement: 0.5,
            channelHits: [],
          },
        ],
      })),
    };

    const runner = buildAutocompleteQueryRunner({
      entityLookupV2UseCase,
      resolverProjectionLookup: wrapEntityDocumentBatchLookupAsResolverProjection({
        getDocuments: vi.fn().mockResolvedValue(new Map()),
      }),
    });

    const result = await runner.execute({ query: 'myst' });

    expect(result.status).toBe('ambiguous');
    expect(result.suggestions).toEqual([
      {
        entity: {
          entity_id: entityId,
          canonical_label: 'Mystery Wine',
        },
        rank: 1,
        calibrated_score: 0.61,
      },
    ]);
  });

  it('maps redirect_discovery to failed autocomplete status', async () => {
    const entityLookupV2UseCase: EntityLookupV2UseCasePort = {
      execute: vi.fn().mockResolvedValue(makeLookupV2Result({
        status: 'redirect_discovery',
        evidenceSummary: {
          admissionReasonCode: 'redirect_concept_query',
          decisionReasonCode: 'redirect_concept_query',
          calibrationTrusted: false,
          queryClass: 'concept_query',
          candidatePoolSize: 0,
          channelCoverage: [],
        },
      })),
    };

    const runner = buildAutocompleteQueryRunner({
      entityLookupV2UseCase,
      resolverProjectionLookup: wrapEntityDocumentBatchLookupAsResolverProjection({
        getDocuments: vi.fn().mockResolvedValue(new Map()),
      }),
    });

    const result = await runner.execute({ query: 'full bodied red' });

    expect(result.status).toBe('failed');
    expect(result.suggestions).toEqual([]);
  });
});
