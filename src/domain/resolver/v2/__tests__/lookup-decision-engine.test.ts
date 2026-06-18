import { describe, expect, it } from 'vitest';
import { createEntityId } from '../../../shared/types/index.js';
import type { AnchorCandidate } from '../../../query/model/anchor-candidate.js';
import {
  decideLookupOutcome,
  PERSISTED_AMBIGUITY_SURFACE_REASON_CODE,
  RECALL_ONLY_NO_MATCH_REASON_CODE,
  REVIEWED_FAMILY_COLLISION_REASON_CODE,
  REVIEWED_SCOPE_TARGET_RESOLVED_REASON_CODE,
  UNIQUE_EXACT_IDENTITY_RECALL_WITNESS_RESOLVED_REASON_CODE,
  UNIQUE_FUZZY_RECALL_WITNESS_RESOLVED_REASON_CODE,
  UNIQUE_JAMO_PHONETIC_RECALL_WITNESS_RESOLVED_REASON_CODE,
  VINTAGE_FAMILY_MEMBER_RESOLVED_REASON_CODE,
  VINTAGE_MISMATCH_REASON_CODE,
  type LookupDecisionCandidate,
} from '../lookup-decision-engine.js';

function exactIdentityAnchor(entityId: string): AnchorCandidate {
  return {
    surfaceForm: 'opus one',
    normalizedForm: 'opus one',
    candidateEntityIds: [createEntityId(entityId)],
    lookupStrategies: ['exact'],
    aliasType: 'canonical',
    confidence: 0.97,
    source: 'alias',
  };
}

function candidate(
  entityId: string,
  canonicalLabel: string,
  channelHits: LookupDecisionCandidate['channelHits'],
  channelAgreement = channelHits.length,
): LookupDecisionCandidate {
  return {
    entityId,
    canonicalLabel,
    channelAgreement,
    channelHits,
  };
}

function reviewedFamilyHit(matchedAlias: string, channelRank: number) {
  return {
    channel: 'dense' as const,
    matchedView: 'reviewed_family_recall',
    matchedAlias,
    channelScore: 0.5,
    channelRank,
  };
}

describe('decideLookupOutcome', () => {
  it('downgrades a resolve to ambiguous when the query vintage differs from the entity vintage', () => {
    const out = decideLookupOutcome({
      query: '오퍼스원 2019',
      rawQuery: '오퍼스원 2019',
      decisionReasonCode: 'calibrated_resolved',
      decisionStatus: 'resolved',
      topCandidateEntityId: 'opus-one-2018',
      topCandidateCanonicalLabel: 'Opus One 2018',
      anchors: [exactIdentityAnchor('opus-one-2018')],
      resolveCandidateEntityIds: ['opus-one-2018'],
      allCandidates: [
        candidate('opus-one-2018', 'Opus One 2018', [
          { channel: 'exact_alias', matchedView: 'strict', channelScore: 0.97, channelRank: 1 },
        ]),
      ],
      semanticScopeMatches: [],
      reviewedTargetEntityIds: new Set(),
      hasPersistedAmbiguity: false,
    });

    expect(out.status).toBe('ambiguous');
    expect(out.effectiveDecisionReasonCode).toBe(VINTAGE_MISMATCH_REASON_CODE);
    expect(out.vintageMismatch).toBe(true);
    expect(out.preferVintageMismatchReasonText).toBe(true);
    expect(out.frontPromotedEntityId).toBeUndefined();
  });

  it('promotes a unique vintage-matching sibling over a vintage-blind incumbent', () => {
    const out = decideLookupOutcome({
      query: '칼롱 세귀르 2009',
      rawQuery: '칼롱 세귀르 2009',
      decisionReasonCode: 'calibrated_ambiguous',
      decisionStatus: 'ambiguous',
      anchors: [exactIdentityAnchor('w-calon-2003')],
      resolveCandidateEntityIds: ['w-calon-2003', 'w-calon-2009', 'w-calon-2020'],
      allCandidates: [
        candidate('w-calon-2003', '2003 Château Calon-Ségur', [
          { channel: 'exact_alias', matchedView: 'strict', channelScore: 0.97, channelRank: 1 },
        ]),
        candidate('w-calon-2009', 'Château Calon-Ségur 2009', [
          { channel: 'exact_alias', matchedView: 'strict', channelScore: 0.9, channelRank: 2 },
          { channel: 'family_graph', matchedView: 'line', channelScore: 0.8, channelRank: 1 },
          { channel: 'dense', matchedView: 'semantic', channelScore: 0.7, channelRank: 1 },
        ], 3),
        candidate('w-calon-2020', 'Château Calon-Ségur 2020', [
          { channel: 'family_graph', matchedView: 'line', channelScore: 0.7, channelRank: 2 },
        ]),
      ],
      semanticScopeMatches: [],
      reviewedTargetEntityIds: new Set(),
      hasPersistedAmbiguity: false,
    });

    expect(out.status).toBe('resolved');
    expect(out.effectiveDecisionReasonCode).toBe(VINTAGE_FAMILY_MEMBER_RESOLVED_REASON_CODE);
    expect(out.vintagePromotedEntityId).toBe('w-calon-2009');
    expect(out.frontPromotedEntityId).toBe('w-calon-2009');
  });

  it('normalizes failed -> ambiguous when a persisted ambiguity surface exists', () => {
    const out = decideLookupOutcome({
      query: 'DRC',
      rawQuery: 'DRC',
      decisionReasonCode: 'calibrated_failed',
      decisionStatus: 'failed',
      anchors: [],
      resolveCandidateEntityIds: ['romanee-conti-2015'],
      allCandidates: [
        candidate('romanee-conti-2015', 'DRC Romanée-Conti 2015', [
          { channel: 'exact_alias', matchedView: 'strict', channelScore: 0.06, channelRank: 1 },
        ]),
      ],
      semanticScopeMatches: [],
      reviewedTargetEntityIds: new Set(),
      hasPersistedAmbiguity: true,
    });

    expect(out.status).toBe('ambiguous');
    expect(out.effectiveDecisionReasonCode).toBe(PERSISTED_AMBIGUITY_SURFACE_REASON_CODE);
  });

  it('resolves a reviewed family collision when exactly one reviewed scope target has multi-channel corroboration', () => {
    const out = decideLookupOutcome({
      query: '샤또 앙젤뤼스',
      rawQuery: '샤또 앙젤뤼스',
      decisionReasonCode: 'calibrated_ambiguous',
      decisionStatus: 'ambiguous',
      anchors: [],
      resolveCandidateEntityIds: ['angelus-grand-vin', 'carillon-d-angelus'],
      allCandidates: [
        candidate('angelus-grand-vin', 'Chateau Angelus 2018', [
          reviewedFamilyHit('angelus', 1),
          { channel: 'family_graph', matchedView: 'semantic_scope', channelScore: 0.49, channelRank: 1 },
        ], 2),
        candidate('carillon-d-angelus', 'Carillon d Angelus 2018', [
          reviewedFamilyHit('angelus', 2),
        ]),
      ],
      semanticScopeMatches: [],
      reviewedTargetEntityIds: new Set(['angelus-grand-vin']),
      hasPersistedAmbiguity: false,
    });

    expect(out.status).toBe('resolved');
    expect(out.effectiveDecisionReasonCode).toBe(REVIEWED_SCOPE_TARGET_RESOLVED_REASON_CODE);
    expect(out.resolvedReviewedScopeTargetEntityId).toBe('angelus-grand-vin');
    expect(out.frontPromotedEntityId).toBe('angelus-grand-vin');
  });

  it('resolves a direct reviewed semantic-scope target match', () => {
    const out = decideLookupOutcome({
      query: '솔라이아 2018',
      rawQuery: '솔라이아 2018',
      decisionReasonCode: 'calibrated_failed',
      decisionStatus: 'failed',
      anchors: [],
      resolveCandidateEntityIds: ['solaia-2018'],
      allCandidates: [
        candidate('solaia-2018', "2018 Antinori Tenuta Tignanello 'Solaia'", [
          { channel: 'dense', matchedView: 'semantic_scope', channelScore: 0.4, channelRank: 1 },
        ]),
      ],
      semanticScopeMatches: [{ entityId: 'solaia-2018' }],
      reviewedTargetEntityIds: new Set(),
      hasPersistedAmbiguity: false,
    });

    expect(out.status).toBe('resolved');
    expect(out.effectiveDecisionReasonCode).toBe(REVIEWED_SCOPE_TARGET_RESOLVED_REASON_CODE);
    expect(out.frontPromotedEntityId).toBe('solaia-2018');
  });

  it('preserves reviewed family collision clusters as ambiguous instead of collapsing them to failed', () => {
    const out = decideLookupOutcome({
      query: '실버 오크',
      rawQuery: '실버 오크',
      decisionReasonCode: 'calibrated_failed',
      decisionStatus: 'failed',
      anchors: [],
      resolveCandidateEntityIds: ['silver-oak-alexander', 'silver-oak-napa'],
      allCandidates: [
        candidate('silver-oak-alexander', '1984 Silver Oak Alexander Valley Cabernet Sauvignon', [
          reviewedFamilyHit('silver oak', 1),
        ]),
        candidate('silver-oak-napa', '2014 Silver Oak Napa Valley Cabernet Sauvignon', [
          reviewedFamilyHit('silver oak', 1),
        ]),
      ],
      semanticScopeMatches: [],
      reviewedTargetEntityIds: new Set(),
      hasPersistedAmbiguity: false,
    });

    expect(out.status).toBe('ambiguous');
    expect(out.effectiveDecisionReasonCode).toBe(REVIEWED_FAMILY_COLLISION_REASON_CODE);
    expect(out.frontPromotedEntityId).toBeUndefined();
  });

  it('normalizes recall-only ambiguous garbage -> failed', () => {
    const out = decideLookupOutcome({
      query: 'Chateau Fantaisie 2025',
      rawQuery: 'Chateau Fantaisie 2025',
      decisionReasonCode: 'calibrated_ambiguous',
      decisionStatus: 'ambiguous',
      anchors: [
        {
          surfaceForm: '2019 Château de Nalys Châteauneuf-du-Pape Rouge',
          normalizedForm: '2019 chateau de nalys chateauneuf-du-pape rouge',
          candidateEntityIds: [createEntityId('a')],
          lookupStrategies: ['fuzzy_char_ngram'],
          aliasType: 'translation',
          confidence: 1,
          source: 'alias',
        },
      ],
      resolveCandidateEntityIds: ['a', 'b'],
      allCandidates: [
        candidate('a', '2019 Château de Nalys Châteauneuf-du-Pape Rouge', [
          { channel: 'fuzzy_alias', matchedView: 'ngram', channelScore: 0.25, channelRank: 1 },
        ]),
        candidate('b', '2004 Château La Nerthe Châteauneuf-du-Pape', [
          { channel: 'fuzzy_alias', matchedView: 'ngram', channelScore: 0.25, channelRank: 2 },
        ]),
      ],
      semanticScopeMatches: [],
      reviewedTargetEntityIds: new Set(),
      hasPersistedAmbiguity: false,
    });

    expect(out.status).toBe('failed');
    expect(out.effectiveDecisionReasonCode).toBe(RECALL_ONLY_NO_MATCH_REASON_CODE);
  });

  it('promotes a singleton fuzzy_alias recall witness from failed to resolved', () => {
    const out = decideLookupOutcome({
      query: 'opuss one',
      rawQuery: 'opuss one',
      decisionReasonCode: 'CONFIDENCE_BELOW_THRESHOLD',
      resolverStatus: 'failed',
      topCandidateEntityId: 'opus-one-2018',
      topCandidateCanonicalLabel: 'Opus One 2018',
      anchors: [],
      resolveCandidateEntityIds: ['opus-one-2018'],
      allCandidates: [
        candidate('opus-one-2018', 'Opus One 2018', [
          {
            channel: 'fuzzy_alias',
            matchedView: 'opuss one',
            matchedAlias: 'opus one',
            channelScore: 0.679,
            channelRank: 1,
          },
        ]),
      ],
      semanticScopeMatches: [],
      reviewedTargetEntityIds: new Set(),
      hasPersistedAmbiguity: false,
    });

    expect(out.status).toBe('resolved');
    expect(out.effectiveDecisionReasonCode).toBe(UNIQUE_FUZZY_RECALL_WITNESS_RESOLVED_REASON_CODE);
    expect(out.promotedTopConfidence).toBe(0.679);
  });

  it('promotes a singleton jamo_phonetic recall witness from failed to resolved', () => {
    const out = decideLookupOutcome({
      query: 'romane conti',
      rawQuery: 'romane conti',
      decisionReasonCode: 'CONFIDENCE_BELOW_THRESHOLD',
      resolverStatus: 'failed',
      topCandidateEntityId: 'romanee-conti-2015',
      topCandidateCanonicalLabel: 'Romanée-Conti 2015',
      anchors: [],
      resolveCandidateEntityIds: ['romanee-conti-2015'],
      allCandidates: [
        candidate('romanee-conti-2015', 'Romanée-Conti 2015', [
          {
            channel: 'jamo_phonetic',
            matchedView: 'romane conti',
            matchedAlias: 'romanee conti',
            channelScore: 0.86,
            channelRank: 1,
          },
        ]),
      ],
      semanticScopeMatches: [],
      reviewedTargetEntityIds: new Set(),
      hasPersistedAmbiguity: false,
      resolveThreshold: 0.45,
    });

    expect(out.status).toBe('resolved');
    expect(out.effectiveDecisionReasonCode).toBe(UNIQUE_JAMO_PHONETIC_RECALL_WITNESS_RESOLVED_REASON_CODE);
    expect(out.promotedTopConfidence).toBe(0.86);
  });

  it('promotes a singleton exact_alias recall witness from failed to resolved', () => {
    const out = decideLookupOutcome({
      query: 'Chateau Margaux',
      rawQuery: 'Chateau Margaux',
      decisionReasonCode: 'CONFIDENCE_BELOW_THRESHOLD',
      resolverStatus: 'failed',
      topCandidateEntityId: 'chateau-margaux-2015',
      topCandidateCanonicalLabel: 'Château Margaux 2015',
      anchors: [],
      resolveCandidateEntityIds: ['chateau-margaux-2015'],
      allCandidates: [
        candidate('chateau-margaux-2015', 'Château Margaux 2015', [
          {
            channel: 'exact_alias',
            matchedView: 'chateau margaux',
            matchedAlias: 'Château Margaux',
            channelScore: 0.95,
            channelRank: 1,
          },
        ]),
      ],
      semanticScopeMatches: [],
      reviewedTargetEntityIds: new Set(),
      hasPersistedAmbiguity: false,
    });

    expect(out.status).toBe('resolved');
    expect(out.effectiveDecisionReasonCode).toBe(
      UNIQUE_EXACT_IDENTITY_RECALL_WITNESS_RESOLVED_REASON_CODE,
    );
    expect(out.promotedTopConfidence).toBe(0.95);
  });
});
