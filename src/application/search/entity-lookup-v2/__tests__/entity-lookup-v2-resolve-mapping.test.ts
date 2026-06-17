import { describe, expect, it } from 'vitest';
import { createEntityId } from '../../../../domain/shared/types/index.js';
import { vi } from 'vitest';
import {
  executeResolveViaEntityLookupV2,
  mapEntityLookupV2ResultToResolveResponse,
  mapLookupV2StatusToResolveStatus,
} from '../entity-lookup-v2-resolve-mapping.js';
import type { EntityLookupV2Result } from '../entity-lookup-v2.dto.js';

function makeV2Result(overrides: Partial<EntityLookupV2Result> = {}): EntityLookupV2Result {
  return {
    status: 'resolved',
    decisionReason: 'ok',
    normalizedQueryViews: {
      raw: 'Opus One',
      strict: 'opus one',
      accentless: 'opus one',
      compact: 'opusone',
      vintageCanonicalized: 'opus one',
      vintageStripped: 'opus one',
      lookupVariants: ['opus one'],
    },
    candidates: [{
      entityId: 'opus-one-2018',
      canonicalLabel: 'Opus One 2018',
      calibratedScore: 0.96,
      rank: 1,
      channelAgreement: 1,
      channelHits: [{ channel: 'exact_alias', matchedView: 'opus one', channelScore: 0.97, channelRank: 1 }],
    }],
    topCandidate: {
      entityId: 'opus-one-2018',
      canonicalLabel: 'Opus One 2018',
      calibratedScore: 0.96,
    },
    clarificationOptions: [],
    evidenceSummary: {
      admissionReasonCode: 'admitted',
      decisionReasonCode: 'exact_identity',
      calibrationTrusted: true,
      queryClass: 'exact_entity',
      candidatePoolSize: 1,
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

describe('entity-lookup-v2-resolve-mapping', () => {
  it('maps resolved V2 outcomes to resolver-shaped candidates and top entity', () => {
    const response = mapEntityLookupV2ResultToResolveResponse(
      makeV2Result(),
      { query: 'Opus One' },
    );

    expect(response.status).toBe('resolved');
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]?.entityId).toEqual(createEntityId('opus-one-2018'));
    expect(response.topEntity?.entityId).toEqual(createEntityId('opus-one-2018'));
    expect(response.decision_trace_ref).toMatch(/^decision:/);
    expect(response.authority_trace_ref).toBe(response.decision_trace_ref);
  });

  it('maps redirect_discovery to failed resolve status', () => {
    expect(mapLookupV2StatusToResolveStatus('redirect_discovery')).toBe('failed');
    const response = mapEntityLookupV2ResultToResolveResponse(
      makeV2Result({ status: 'redirect_discovery', topCandidate: null, candidates: [] }),
      { query: '까쇼' },
    );
    expect(response.status).toBe('failed');
    expect(response.topEntity).toBeUndefined();
  });

  it('forwards request_id when present on the resolve request', () => {
    const response = mapEntityLookupV2ResultToResolveResponse(
      makeV2Result(),
      { query: 'Opus One', requestId: 'req-1' },
    );
    expect(response.request_id).toBe('req-1');
  });

  it('executeResolveViaEntityLookupV2 maps command, forwards context, and projects response', async () => {
    const entityLookupV2UseCase = {
      execute: vi.fn().mockResolvedValue(makeV2Result()),
    };

    const out = await executeResolveViaEntityLookupV2(
      entityLookupV2UseCase,
      {
        query: '  Opus One  ',
        context: { locale: 'ko-KR', currency: 'KRW' },
        queryBudget: { maxCandidates: 5, maxLatencyMs: 500, rerankLimit: 5 },
        requestId: 'req-resolve',
      },
      { abortSignal: new AbortController().signal },
    );

    expect(entityLookupV2UseCase.execute).toHaveBeenCalledWith(
      {
        query: '  Opus One  ',
        locale: 'ko-KR',
        maxCandidates: 5,
        mode: 'default',
        requestId: 'req-resolve',
      },
      { abortSignal: expect.any(AbortSignal) },
    );
    expect(out.status).toBe('resolved');
    expect(out.candidates).toHaveLength(1);
    expect(out.request_id).toBe('req-resolve');
  });

  it('executeResolveViaEntityLookupV2 propagates V2 failures without synthesizing a legacy response', async () => {
    const entityLookupV2UseCase = {
      execute: vi.fn().mockRejectedValue(new Error('lookup unavailable')),
    };

    await expect(
      executeResolveViaEntityLookupV2(entityLookupV2UseCase, { query: 'Opus One' }),
    ).rejects.toThrow('lookup unavailable');
  });
});
