import { describe, expect, it } from 'vitest';
import {
  projectV2AdvisoryTopConfidence,
  projectV2AliasMatches,
  projectV2EvidenceRefs,
  projectV2RankOneCandidate,
  projectV2ResolvedCandidate,
  projectV2ResolverCandidate,
  projectV2SourceSignals,
} from '../entity-lookup-v2-candidate-projection.js';
import type { EntityLookupV2Result, LookupV2CandidateView } from '../entity-lookup-v2.dto.js';

function candidate(over: Partial<LookupV2CandidateView> = {}): LookupV2CandidateView {
  return {
    entityId: 'opus-one-2018',
    canonicalLabel: 'Opus One 2018',
    entityType: 'wine',
    rank: 1,
    calibratedScore: 0.91,
    channelAgreement: 1,
    channelHits: [
      { channel: 'exact_alias', matchedView: 'opus one', matchedAlias: 'Opus One', channelScore: 0.97, channelRank: 1 },
    ],
    ...over,
  };
}

function v2Result(over: Partial<EntityLookupV2Result> = {}): EntityLookupV2Result {
  const top = candidate();
  return {
    status: 'resolved',
    decisionReason: 'resolved',
    normalizedQueryViews: {
      raw: 'Opus One',
      strict: 'opus one',
      accentless: 'opus one',
      compact: 'opusone',
      vintageCanonicalized: 'opus one',
      vintageStripped: 'opus one',
      lookupVariants: ['opus one'],
    },
    candidates: [top],
    topCandidate: top,
    clarificationOptions: [],
    evidenceSummary: {
      admissionReasonCode: 'admitted_entity_reference',
      decisionReasonCode: 'resolved',
      calibrationTrusted: true,
      queryClass: 'known-item',
      candidatePoolSize: 1,
      channelCoverage: [],
    },
    meta: {
      queryTimeMs: 1,
      version: 'lookup-v2',
      engineSchemaVersion: 'entity_lookup_v2',
    },
    ...over,
  };
}

describe('entity-lookup-v2-candidate-projection', () => {
  it('dedupes alias surfaces from channel hits', () => {
    const hits = [
      { channel: 'exact_alias' as const, matchedView: 'opus one', matchedAlias: 'Opus One', channelScore: 0.97, channelRank: 1 },
      { channel: 'compact_exact' as const, matchedView: 'opusone', matchedAlias: 'Opus One', channelScore: 0.93, channelRank: 1 },
    ];
    expect(projectV2AliasMatches(hits)).toEqual([{ aliasValue: 'Opus One', matchScore: 0.97 }]);
    expect(projectV2EvidenceRefs(hits)).toEqual(['Opus One']);
  });

  it('maps identity-grade channel hits into resolver source signals', () => {
    const signals = projectV2SourceSignals([
      { channel: 'exact_alias', matchedView: 'opus one', channelScore: 0.97, channelRank: 1 },
      { channel: 'fuzzy_alias', matchedView: 'opus 1', channelScore: 0.6, channelRank: 2 },
    ]);
    expect(signals.aliasExactMatch).toBe(0.97);
    expect(signals.aliasFuzzyMatch).toBe(0.6);
    expect(signals.editDistanceScore).toBeCloseTo(0.48);
  });

  it('projects resolver and resolved candidate shapes for search post-route wiring', () => {
    const view = candidate();
    const resolver = projectV2ResolverCandidate(view);
    expect(resolver.entityId).toBe('opus-one-2018');
    expect(resolver.source).toBe('entity_lookup');
    expect(resolver.aliasMatches[0]?.aliasValue).toBe('Opus One');

    const resolved = projectV2ResolvedCandidate(view);
    expect(resolved.calibratedScore).toBe(0.91);
    expect(resolved.evidenceRefs).toEqual(['Opus One']);
  });

  it('prefers topCandidate for rank-one projection and advisory confidence fallbacks', () => {
    const ranked = candidate({ rank: 2, calibratedScore: 0.4 });
    const top = candidate({ rank: 1, calibratedScore: 0.95 });
    const result = v2Result({ topCandidate: top, candidates: [ranked, top] });
    expect(projectV2RankOneCandidate(result)?.rank).toBe(1);
    expect(projectV2AdvisoryTopConfidence(top, 0.88)).toBe(0.88);
    expect(projectV2AdvisoryTopConfidence(top, undefined)).toBe(0.95);
    expect(projectV2AdvisoryTopConfidence(undefined, undefined)).toBe(0);
  });
});
