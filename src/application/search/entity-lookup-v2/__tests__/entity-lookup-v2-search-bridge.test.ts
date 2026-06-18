import { describe, expect, it, vi } from 'vitest';
import { createCanonicalEntityId } from '../../../../domain/shared/types/index.js';
import type { QueryPlanV1 } from '../../../../domain/query/model/query-plan.js';
import type { EntityLookupV2Result } from '../entity-lookup-v2.dto.js';
import {
  buildEntityResolveResultFromLookupV2,
  executeEntityRouteViaLookupV2,
  mapLookupV2StatusToResolverStatus,
} from '../entity-lookup-v2-search-bridge.js';
import { buildSearchDecisionInput } from '../../search-usecase-decision-input.js';

function makePlan(): QueryPlanV1 {
  return {
    rawQuery: 'Opus One 2018',
    normalizedQuery: 'opus one 2018',
    intent: 'entity_lookup',
    queryClass: 'entity_resolution',
    anchors: [],
    constraints: { hard: [], soft: [], inferred: [] },
    expansions: [],
    uncertainty: { score: 0, sources: [] },
    policy: { abstainThreshold: 0.5, clarifyThreshold: 0.3 },
    retrievalMode: 'entity',
    plannerVersion: '1',
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
  } as QueryPlanV1;
}

function makeCompiled() {
  return {
    execution: {
      effectiveRetrievalMode: 'entity',
      budget: { maxCandidates: 10, enablePrecisionRerank: false },
    },
  } as never;
}

function makeV2Result(overrides: Partial<EntityLookupV2Result> = {}): EntityLookupV2Result {
  return {
    status: 'resolved',
    decisionReason: 'resolved',
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
        entityId: 'opus-one-2018',
        canonicalLabel: 'Opus One 2018',
        calibratedScore: 0.92,
        rank: 1,
        channelAgreement: 1,
        channelHits: [],
      },
    ],
    topCandidate: {
      entityId: 'opus-one-2018',
      canonicalLabel: 'Opus One 2018',
      calibratedScore: 0.92,
      rank: 1,
      channelAgreement: 1,
      channelHits: [],
    },
    clarificationOptions: [],
    evidenceSummary: {
      admissionReasonCode: 'admitted_entity_reference',
      decisionReasonCode: 'resolved_singleton',
      topConfidence: 0.92,
      calibrationTrusted: true,
      queryClass: 'entity_resolution',
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

describe('entity-lookup-v2-search-bridge', () => {
  it('maps V2 terminal statuses into resolver DecisionStatus', () => {
    expect(mapLookupV2StatusToResolverStatus('resolved')).toBe('resolved');
    expect(mapLookupV2StatusToResolverStatus('ambiguous')).toBe('ambiguous');
    expect(mapLookupV2StatusToResolverStatus('failed')).toBe('failed');
    expect(mapLookupV2StatusToResolverStatus('redirect_discovery')).toBe('failed');
  });

  it('builds a minimal valid EntityResolveResult from a resolved V2 outcome', () => {
    const result = buildEntityResolveResultFromLookupV2(makeV2Result(), makePlan());

    expect(result.status).toBe('resolved');
    expect(result.recommendedNextAction).toBe('return_result');
    expect(result.topEntity).toEqual({
      entityId: createCanonicalEntityId('opus-one-2018'),
      canonicalLabel: 'Opus One 2018',
      calibratedScore: 0.92,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.decisionTrace.calibrationTrusted).toBe(true);
    expect(result.conformalSetSize).toBeGreaterThan(0);
  });

  it('projects V2 channel hits into identity lane evidence for decision input', async () => {
    const exactHit = {
      channel: 'exact_alias' as const,
      matchedView: 'strict',
      matchedAlias: 'Opus One 2018',
      channelScore: 0.97,
      channelRank: 1,
    };
    const v2Result = makeV2Result({
      candidates: [{
        entityId: 'opus-one-2018',
        canonicalLabel: 'Opus One 2018',
        calibratedScore: 0.92,
        rank: 1,
        channelAgreement: 1,
        channelHits: [exactHit],
      }],
      topCandidate: {
        entityId: 'opus-one-2018',
        canonicalLabel: 'Opus One 2018',
        calibratedScore: 0.92,
        rank: 1,
        channelAgreement: 1,
        channelHits: [exactHit],
      },
      evidenceSummary: {
        ...makeV2Result().evidenceSummary,
        calibrationTrusted: false,
      },
    });
    const useCase = { execute: vi.fn().mockResolvedValue(v2Result) };
    const plan = makePlan();
    const route = await executeEntityRouteViaLookupV2(plan, makeCompiled(), useCase);

    expect(route.identityResolveResult.candidates[0]?.evidenceRefs).toEqual(['Opus One 2018']);
    expect(route.laneArtifacts.identity[0]?.identityProvenance.exactnessTier).toBe('alias_exact');
    expect(route.laneArtifacts.identity[0]?.identityProvenance.evidenceRefs).toEqual(['Opus One 2018']);

    const decisionInput = buildSearchDecisionInput({
      plan,
      resolveResult: route.identityResolveResult,
      identityResolveResult: route.identityResolveResult,
      rankedResults: route.rankedResults,
      effectiveRoute: 'entity',
      executionContext: {
        retrievalKind: 'entity_lookup',
        winnerIdentityArtifact: route.laneArtifacts.identity[0],
      },
    });

    expect(decisionInput.evidenceSummary.identityEvidence?.identityEvidenceRefCount).toBe(1);
    expect(decisionInput.evidenceSummary.identityEvidence?.exactnessTier).toBe('alias_exact');
  });

  it('projects jamo_phonetic channel hits into alias_phonetic identity evidence', async () => {
    const phoneticHit = {
      channel: 'jamo_phonetic' as const,
      matchedView: 'phonetic',
      matchedAlias: 'romanee conti',
      channelScore: 0.86,
      channelRank: 1,
    };
    const v2Result = makeV2Result({
      candidates: [{
        entityId: 'romanee-conti-2015',
        canonicalLabel: 'Romanée-Conti 2015',
        calibratedScore: 0.86,
        rank: 1,
        channelAgreement: 1,
        channelHits: [phoneticHit],
      }],
      topCandidate: {
        entityId: 'romanee-conti-2015',
        canonicalLabel: 'Romanée-Conti 2015',
        calibratedScore: 0.86,
        rank: 1,
        channelAgreement: 1,
        channelHits: [phoneticHit],
      },
      evidenceSummary: {
        ...makeV2Result().evidenceSummary,
        calibrationTrusted: false,
        decisionReasonCode: 'unique_jamo_phonetic_recall_witness_resolved',
      },
    });
    const useCase = { execute: vi.fn().mockResolvedValue(v2Result) };
    const plan = { ...makePlan(), rawQuery: 'romane conti', normalizedQuery: 'romane conti' } as QueryPlanV1;
    const route = await executeEntityRouteViaLookupV2(plan, makeCompiled(), useCase);

    expect(route.laneArtifacts.identity[0]?.identityProvenance.exactnessTier).toBe('alias_phonetic');
    expect(route.laneArtifacts.identity[0]?.identityProvenance.sourceSignals.phoneticMatch).toBe(0.86);

    const decisionInput = buildSearchDecisionInput({
      plan,
      resolveResult: route.identityResolveResult,
      identityResolveResult: route.identityResolveResult,
      rankedResults: route.rankedResults,
      effectiveRoute: 'entity',
      executionContext: {
        retrievalKind: 'entity_lookup',
        winnerIdentityArtifact: route.laneArtifacts.identity[0],
      },
    });

    expect(decisionInput.evidenceSummary.identityEvidence?.exactnessTier).toBe('alias_phonetic');
  });

  it('projects advisory head and thresholds when V2 abstains with surfaced candidates', () => {
    const exactHit = {
      channel: 'exact_alias' as const,
      matchedView: 'chateau margaux',
      matchedAlias: 'Château Margaux',
      channelScore: 0.95,
      channelRank: 1,
    };
    const result = buildEntityResolveResultFromLookupV2(
      makeV2Result({
        status: 'failed',
        topCandidate: null,
        candidates: [{
          entityId: 'chateau-margaux-2015',
          canonicalLabel: 'Château Margaux 2015',
          calibratedScore: 0,
          rank: 1,
          channelAgreement: 1,
          channelHits: [exactHit],
        }],
        evidenceSummary: {
          ...makeV2Result().evidenceSummary,
          topConfidence: 0,
          calibrationTrusted: false,
          decisionReasonCode: 'CONFIDENCE_BELOW_THRESHOLD',
          queryClass: 'short_entity',
        },
      }),
      { ...makePlan(), queryClass: 'short_entity' } as QueryPlanV1,
    );

    expect(result.status).toBe('failed');
    expect(result.topEntity?.entityId).toBe(createCanonicalEntityId('chateau-margaux-2015'));
    expect(result.decisionConfidenceC).toBe(0.95);
    expect(result.candidates[0]?.evidenceRefs).toEqual(['Château Margaux']);
    expect(result.decisionTrace.appliedThresholds.resolveThreshold).toBe(0.45);
  });

  it('marks redirect_discovery with hybrid_search and degradation', () => {
    const result = buildEntityResolveResultFromLookupV2(
      makeV2Result({
        status: 'redirect_discovery',
        topCandidate: null,
        candidates: [],
        evidenceSummary: {
          admissionReasonCode: 'concept_query',
          decisionReasonCode: 'concept_query',
          calibrationTrusted: true,
          queryClass: 'entity_resolution',
          candidatePoolSize: 0,
          channelCoverage: [],
        },
      }),
      makePlan(),
    );

    expect(result.status).toBe('failed');
    expect(result.recommendedNextAction).toBe('hybrid_search');
    expect(result.degradation).toEqual({ reasons: ['redirect_discovery'] });
  });

  it('executeEntityRouteViaLookupV2 returns an entity-only EntityRouteResult', async () => {
    const v2Result = makeV2Result();
    const useCase = { execute: vi.fn().mockResolvedValue(v2Result) };
    const route = await executeEntityRouteViaLookupV2(makePlan(), makeCompiled(), useCase);

    expect(useCase.execute).toHaveBeenCalledWith(
      { query: 'Opus One 2018', maxCandidates: 10, mode: 'default' },
      undefined,
    );
    expect(route.executionTopology).toBe('entity_only');
    expect(route.retrievalKind).toBe('entity_lookup');
    expect(route.identityResolveResult.status).toBe('resolved');
    expect(route.rankedResults).toHaveLength(1);
  });
});
