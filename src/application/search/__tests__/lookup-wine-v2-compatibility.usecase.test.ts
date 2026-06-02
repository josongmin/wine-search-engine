import { describe, expect, it, vi } from 'vitest';
import { LookupWineV2CompatibilityUseCase } from '../lookup-wine-v2-compatibility.usecase.js';
import type { EntityLookupV2Result } from '../entity-lookup-v2/entity-lookup-v2.dto.js';
import type { RetrievalDocument } from '../../../domain/retrieval/model/retrieval-document.js';

function makeResolvedResult(): EntityLookupV2Result {
  return {
    status: 'resolved',
    decisionReason: 'Confidently resolved to a single wine entity.',
    normalizedQueryViews: {
      raw: 'Opus One 2018',
      strict: 'opus one 2018',
      accentless: 'opus one 2018',
      compact: 'opusone2018',
      vintageCanonicalized: 'opus one 2018',
      vintageStripped: 'opus one',
      lookupVariants: ['opus one 2018'],
    },
    candidates: [
      {
        entityId: 'wine:opus-one-2018',
        canonicalLabel: 'Opus One 2018',
        entityType: 'wine',
        calibratedScore: 0.99,
        rank: 1,
        channelAgreement: 2,
        channelHits: [
          {
            channel: 'exact_alias',
            matchedView: 'opus one 2018',
            matchedAlias: 'Opus One 2018',
            channelScore: 1,
            channelRank: 1,
          },
        ],
      },
    ],
    topCandidate: {
      entityId: 'wine:opus-one-2018',
      canonicalLabel: 'Opus One 2018',
      entityType: 'wine',
      calibratedScore: 0.99,
      rank: 1,
      channelAgreement: 2,
      channelHits: [
        {
          channel: 'exact_alias',
          matchedView: 'opus one 2018',
          matchedAlias: 'Opus One 2018',
          channelScore: 1,
          channelRank: 1,
        },
      ],
    },
    clarificationOptions: [],
    evidenceSummary: {
      admissionReasonCode: 'admitted_entity_reference',
      decisionReasonCode: 'resolved_single_identity',
      topConfidence: 0.99,
      top1Top2Margin: 0.91,
      calibrationTrusted: true,
      queryClass: 'exact_entity',
      candidatePoolSize: 1,
      channelCoverage: [],
    },
    meta: {
      requestId: 'req-lookup-v2-compat',
      queryTimeMs: 12,
      version: 'entity-lookup-v2/1.0.0',
      engineSchemaVersion: 'entity_lookup_v2',
    },
  };
}

function makeAmbiguousResult(): EntityLookupV2Result {
  return {
    ...makeResolvedResult(),
    status: 'ambiguous',
    decisionReason: 'Multiple plausible wines match this query — clarification is required.',
    candidates: [
      makeResolvedResult().candidates[0]!,
      {
        entityId: 'wine:opus-one-2019',
        canonicalLabel: 'Opus One 2019',
        entityType: 'wine',
        calibratedScore: 0.52,
        rank: 2,
        channelAgreement: 1,
        channelHits: [
          {
            channel: 'jamo_phonetic',
            matchedView: 'opus one',
            matchedAlias: 'Opus One 2019',
            channelScore: 0.6,
            channelRank: 1,
          },
        ],
      },
    ],
    topCandidate: null,
    clarificationOptions: [
      { entityId: 'wine:opus-one-2018', label: 'Opus One 2018', distinguishingFeature: '2018 vintage' },
      { entityId: 'wine:opus-one-2019', label: 'Opus One 2019', distinguishingFeature: '2019 vintage' },
    ],
    evidenceSummary: {
      ...makeResolvedResult().evidenceSummary,
      decisionReasonCode: 'multi_vintage_cluster',
      ambiguityTypes: ['multi_vintage'],
      ambiguitySeverity: 'medium',
      clarificationKind: 'multi_vintage',
    },
  };
}

function makeFailedResult(): EntityLookupV2Result {
  return {
    ...makeResolvedResult(),
    status: 'failed',
    decisionReason: 'Could not confidently identify a wine for this query.',
    candidates: [
      {
        entityId: 'wine:wrong-fuzzy-hit',
        canonicalLabel: 'Wrong Fuzzy Hit',
        entityType: 'wine',
        calibratedScore: 0.97,
        rank: 1,
        channelAgreement: 1,
        channelHits: [
          {
            channel: 'fuzzy_alias',
            matchedView: 'vina espectro',
            matchedAlias: 'Vinas Mora kaamen III',
            channelScore: 0.97,
            channelRank: 1,
          },
        ],
      },
    ],
    topCandidate: null,
    clarificationOptions: [],
    evidenceSummary: {
      ...makeResolvedResult().evidenceSummary,
      decisionReasonCode: 'identity_evidence_required',
      topConfidence: 0.97,
    },
  };
}

function makeDoc(entityId: string, canonicalLabel: string): RetrievalDocument {
  return {
    entityId,
    entityType: 'wine',
    canonicalLabel,
    aliasesIdentitySafe: [canonicalLabel],
    aliasesNoisyRecall: [],
    producer: 'Opus One',
    region: 'Napa Valley',
    grapes: ['Cabernet Sauvignon'],
    searchTextKo: canonicalLabel,
    searchTextEn: canonicalLabel,
    semanticSummary: canonicalLabel,
    pairing: [],
    availability: true,
    popularityScore: 0.9,
  };
}

describe('LookupWineV2CompatibilityUseCase', () => {
  it('maps a resolved V2 authority result onto SearchResponseV1', async () => {
    const entityLookupV2UseCase = {
      execute: vi.fn(async () => makeResolvedResult()),
    };
    const entityLookup = {
      getDocuments: vi.fn(async () => new Map([
        ['wine:opus-one-2018', makeDoc('wine:opus-one-2018', 'Opus One 2018')],
      ])),
    };

    const useCase = new LookupWineV2CompatibilityUseCase({
      entityLookupV2UseCase,
      entityLookup,
    });

    const out = await useCase.execute({ query: 'Opus One 2018', requestId: 'req-1' });

    expect(out.engineDecision.decisionStatus).toBe('resolved');
    expect(out.engineDecision.nextAction).toBe('return_result');
    expect(out.results[0]?.entity.entityId).toBe('wine:opus-one-2018');
    expect(out.results[0]?.entity.canonicalLabel).toBe('Opus One 2018');
    expect(out.resultType).toBe('single_entity');
    expect(out.retrievalMode).toBe('entity_lookup');
    expect(out.meta.authorityTraceRef).toMatch(/^decision:v1:exact_entity:/);
  });

  it('keeps ambiguous candidates visible and emits clarification payload', async () => {
    const entityLookupV2UseCase = {
      execute: vi.fn(async () => makeAmbiguousResult()),
    };
    const entityLookup = {
      getDocuments: vi.fn(async () => new Map([
        ['wine:opus-one-2018', makeDoc('wine:opus-one-2018', 'Opus One 2018')],
        ['wine:opus-one-2019', makeDoc('wine:opus-one-2019', 'Opus One 2019')],
      ])),
    };

    const useCase = new LookupWineV2CompatibilityUseCase({
      entityLookupV2UseCase,
      entityLookup,
    });

    const out = await useCase.execute({ query: 'Opus One' });

    expect(out.engineDecision.decisionStatus).toBe('ambiguous');
    expect(out.engineDecision.nextAction).toBe('clarify');
    expect(out.results).toHaveLength(2);
    expect(out.clarification?.structuredPayload?.kind).toBe('anchor_disambiguation');
    expect(out.clarification?.candidates.map((candidate) => candidate.label)).toEqual([
      'Opus One 2018',
      'Opus One 2019',
    ]);
  });

  it('fails closed on recall-only heads and returns no results', async () => {
    const entityLookupV2UseCase = {
      execute: vi.fn(async () => makeFailedResult()),
    };
    const entityLookup = {
      getDocuments: vi.fn(async () => new Map()),
    };

    const useCase = new LookupWineV2CompatibilityUseCase({
      entityLookupV2UseCase,
      entityLookup,
    });

    const out = await useCase.execute({ query: 'Viña Espectro Maipo Valley Carmenere' });

    expect(out.engineDecision.decisionStatus).toBe('failed');
    expect(out.engineDecision.failure_reason).toBe('CONFIDENCE_BELOW_THRESHOLD');
    expect(out.results).toEqual([]);
    expect(out.resultType).toBe('no_match');
  });
});
