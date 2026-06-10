import { describe, expect, it, vi } from 'vitest';
import {
  buildChannelHitsForEntity,
  classifyResolveEvidenceGrade,
  mapLookupStrategyToChannel,
} from '../../../src/domain/resolver/v2/channel-provenance.js';
import { ConceptAdmissionGate } from '../../../src/domain/resolver/v2/concept-admission-gate.js';
import { EntityLookupV2UseCase } from '../../../src/application/search/entity-lookup-v2/entity-lookup-v2.usecase.js';
import { createEntityId } from '../../../src/domain/shared/types/index.js';
import type { NormalizedQueryViews } from '../../../src/domain/query/model/query-views.js';
import type { AnchorCandidate } from '../../../src/domain/query/model/anchor-candidate.js';
import type {
  EntityResolverPort,
  QueryPlannerPort,
} from '../../../src/application/search/port/search-pipeline-deps.port.js';

function makeViews(query: string): NormalizedQueryViews {
  const lower = query.toLowerCase();
  return {
    raw: query, strict: lower, accentless: lower, collapsedWhitespace: lower,
    punctuationStripped: lower, compact: lower.replace(/[^\p{L}\p{N}]/gu, ''),
    vintageCanonicalized: lower, vintageStripped: lower,
    semanticVariants: [lower], lookupVariants: [lower],
  };
}

describe('mapLookupStrategyToChannel', () => {
  it.each([
    ['exact', 'exact_alias'],
    ['compact_exact', 'compact_exact'],
    ['transliterated_exact', 'transliteration_exact'],
    // T-04 regression: transliterated_fuzzy must NOT be forged as the
    // identity-grade transliteration_exact (the bare `translit` branch used to
    // fire first). It is a recall strategy → fuzzy_alias.
    ['transliterated_fuzzy', 'fuzzy_alias'],
    ['index_transliterated_fuzzy', 'fuzzy_alias'],
    // transliterated_prefix is emitted LIVE by both wired matchers — it is a
    // recall variant, not identity-grade, so it must NOT map to transliteration_exact
    // (self-review C1 found the original guard let it through).
    ['transliterated_prefix', 'fuzzy_alias'],
    ['index_transliterated_prefix', 'fuzzy_alias'],
    ['lexical_exact', 'fuzzy_alias'],
    ['phonetic_fuzzy', 'jamo_phonetic'],
    ['fuzzy_char_ngram', 'fuzzy_alias'],
    ['semantic_hybrid', 'dense'],
    ['canonical_exact', 'exact_alias'],
  ] as const)('maps %s → %s', (strategy, channel) => {
    expect(mapLookupStrategyToChannel(strategy)).toBe(channel);
  });

  it('returns undefined for an unrecognized strategy', () => {
    expect(mapLookupStrategyToChannel('???')).toBeUndefined();
  });
});

describe('buildChannelHitsForEntity', () => {
  const eid = createEntityId('opus-one-2018');
  const anchors: AnchorCandidate[] = [
    {
      surfaceForm: '오푸스원',
      normalizedForm: '오푸스원',
      candidateEntityIds: [eid],
      lookupStrategies: ['transliterated_exact', 'compact_exact'],
      confidence: 0.95,
    },
  ];

  it('decomposes anchor strategies into a per-channel union (DoD §4)', () => {
    const hits = buildChannelHitsForEntity(eid, 1, anchors, false);
    const channels = hits.map((h) => h.channel).sort();
    expect(channels).toEqual(['compact_exact', 'transliteration_exact']);
    expect(hits.every((h) => h.channelScore === 0.95)).toBe(true);
  });

  it('adds a dense channel for blocker-seeded candidates with no anchor', () => {
    const hits = buildChannelHitsForEntity(createEntityId('x'), 2, anchors, true);
    expect(hits.map((h) => h.channel)).toContain('dense');
  });
});

describe('classifyResolveEvidenceGrade', () => {
  it('treats exact/compact/transliteration channels as identity-grade', () => {
    expect(classifyResolveEvidenceGrade([{ channel: 'exact_alias' }])).toBe('identity_grade');
    expect(classifyResolveEvidenceGrade([{ channel: 'compact_exact' }])).toBe('identity_grade');
    expect(classifyResolveEvidenceGrade([{ channel: 'transliteration_exact' }])).toBe('identity_grade');
  });

  it('treats jamo/phonetic-only evidence as supportive_only', () => {
    expect(classifyResolveEvidenceGrade([{ channel: 'jamo_phonetic' }])).toBe('supportive_only');
  });

  it('treats fuzzy/family/dense-only evidence as recall_only', () => {
    expect(classifyResolveEvidenceGrade([{ channel: 'fuzzy_alias' }])).toBe('recall_only');
    expect(classifyResolveEvidenceGrade([{ channel: 'family_graph' }])).toBe('recall_only');
    expect(classifyResolveEvidenceGrade([{ channel: 'dense' }])).toBe('recall_only');
  });

  it('prefers identity-grade when mixed with supportive or recall channels', () => {
    expect(classifyResolveEvidenceGrade([
      { channel: 'fuzzy_alias' },
      { channel: 'jamo_phonetic' },
      { channel: 'compact_exact' },
    ])).toBe('identity_grade');
  });
});

describe('EntityLookupV2UseCase — channel provenance surfaced end-to-end', () => {
  it('populates channel_hits, channel_agreement, and coverage from anchors', async () => {
    const eid = createEntityId('opus-one-2018');
    const resolver: EntityResolverPort = {
      resolve: vi.fn().mockResolvedValue({
        status: 'resolved',
        candidates: [{ entityId: eid, canonicalLabel: 'Opus One 2018', calibratedScore: 0.96, rank: 1, evidenceRefs: [] }],
        topEntity: { entityId: eid, canonicalLabel: 'Opus One 2018', calibratedScore: 0.96 },
        decisionTrace: {
          queryClass: 'known-item', top1CalibratedScore: 0.96, top2CalibratedScore: undefined,
          calibratedGap: undefined, decisionConfidenceC: 0.96, calibrationTrusted: true,
          ambiguityDetected: false, ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 }, outcomeReasonCodes: ['exact_identity'],
        },
        conformalSetSize: 1,
      }),
    };
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: '오푸스원', normalizedQuery: '오푸스원', intent: 'known_item', route: 'entity',
        retrievalMode: 'entity_lookup', queryClass: 'known-item',
        anchors: [{
          surfaceForm: '오푸스원', normalizedForm: '오푸스원', candidateEntityIds: [eid],
          lookupStrategies: ['transliterated_exact', 'exact'], confidence: 0.97,
        }],
        constraints: { hard: [], soft: [], inferred: [] }, expansions: { lexical: [], semantic: [] },
        policy: {}, uncertainty: {}, normalizedQueryViews: makeViews('오푸스원'),
        plannerVersion: '1', policyRuleVersion: '1', thresholdProfileId: 'default',
      }),
    };
    const doc = { entityId: eid, entityType: 'wine' as const, canonicalLabel: 'Opus One 2018' };
    const useCase = new EntityLookupV2UseCase({
      admissionGate: new ConceptAdmissionGate(),
      lookupPlanner: queryPlanner,
      entityResolver: resolver,
      entityLookup: {
        getDocument: vi.fn().mockResolvedValue(doc),
        getDocuments: vi.fn().mockResolvedValue(new Map([[eid, doc]])),
      },
      querySanitizer: { sanitize: vi.fn((q: string) => ({ safe: true, sanitizedQuery: q })) } as never,
    });

    const out = await useCase.execute({ query: '오푸스원', maxCandidates: 10, mode: 'default' });

    expect(out.status).toBe('resolved');
    const top = out.candidates[0];
    expect(top?.channelAgreement).toBeGreaterThanOrEqual(2);
    const channels = top?.channelHits.map((h) => h.channel) ?? [];
    expect(channels).toContain('transliteration_exact');
    expect(channels).toContain('exact_alias');
    const coverageChannels = out.evidenceSummary.channelCoverage.map((c) => c.channel);
    expect(coverageChannels).toContain('transliteration_exact');
    expect(out.evidenceSummary.channelCoverage.every((c) => c.firing && c.hitCount > 0)).toBe(true);
  });

  it('T-04: prefers the REAL timed retrieval engine coverage/provenance over the anchor reprojection', async () => {
    const eid = createEntityId('opus-one-2018');
    const doc = { entityId: eid, entityType: 'wine' as const, canonicalLabel: 'Opus One 2018' };
    const resolver: EntityResolverPort = {
      resolve: vi.fn().mockResolvedValue({
        status: 'resolved',
        candidates: [{ entityId: eid, canonicalLabel: 'Opus One 2018', calibratedScore: 0.96, rank: 1, evidenceRefs: [] }],
        topEntity: { entityId: eid, canonicalLabel: 'Opus One 2018', calibratedScore: 0.96 },
        decisionTrace: {
          queryClass: 'known-item', top1CalibratedScore: 0.96, top2CalibratedScore: undefined, calibratedGap: undefined,
          decisionConfidenceC: 0.96, calibrationTrusted: true, ambiguityDetected: false, ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 }, outcomeReasonCodes: ['exact_identity'],
        },
        conformalSetSize: 1,
      }),
    };
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'opus one', normalizedQuery: 'opus one', intent: 'known_item', route: 'entity',
        retrievalMode: 'entity_lookup', queryClass: 'known-item',
        anchors: [{ surfaceForm: 'opus one', normalizedForm: 'opus one', candidateEntityIds: [eid], lookupStrategies: ['exact'], confidence: 0.97 }],
        constraints: { hard: [], soft: [], inferred: [] }, expansions: { lexical: [], semantic: [] },
        policy: {}, uncertainty: {}, normalizedQueryViews: makeViews('opus one'),
        plannerVersion: '1', policyRuleVersion: '1', thresholdProfileId: 'default',
      }),
    };
    // Engine returns REAL coverage with non-zero latency + a fuzzy_alias channel
    // that the anchor reprojection (strategy 'exact') would NOT produce.
    const candidateRetrieval = {
      retrieve: vi.fn().mockResolvedValue({
        candidates: [{ entityId: eid, canonicalLabel: 'Opus One 2018', entityType: 'wine', channelHits: [
          { channel: 'fuzzy_alias', matchedView: 'opus one', channelScore: 0.8, channelRank: 1 },
        ] }],
        coverage: [{ channel: 'fuzzy_alias', firing: true, hitCount: 1, latencyMs: 4.2 }],
      }),
    };
    const useCase = new EntityLookupV2UseCase({
      admissionGate: new ConceptAdmissionGate(),
      lookupPlanner: queryPlanner,
      entityResolver: resolver,
      candidateRetrieval,
      entityLookup: { getDocument: vi.fn().mockResolvedValue(doc), getDocuments: vi.fn().mockResolvedValue(new Map([[eid, doc]])) },
      querySanitizer: { sanitize: vi.fn((q: string) => ({ safe: true, sanitizedQuery: q })) } as never,
    });

    const out = await useCase.execute({ query: 'opus one', maxCandidates: 10, mode: 'default' });

    expect(candidateRetrieval.retrieve).toHaveBeenCalledOnce();
    // coverage comes from the ENGINE (real latency, not the 0 reprojection)
    expect(out.evidenceSummary.channelCoverage).toEqual([{ channel: 'fuzzy_alias', firing: true, hitCount: 1, latencyMs: 4.2 }]);
    // candidate channel hits come from the engine, not the anchor 'exact' strategy
    expect(out.candidates[0]?.channelHits.map((h) => h.channel)).toEqual(['fuzzy_alias']);
  });
});
