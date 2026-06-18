import { describe, expect, it } from 'vitest';
import { buildLookupReviewedFamilyRecallRuntimeArtifact } from '../../../scripts/etl/build-lookup-semantic-runtime-pack.js';

describe('buildLookupReviewedFamilyRecallRuntimeArtifact', () => {
  it('materializes reviewed collision families into snapshot-published recall-only owner sets', () => {
    const artifact = buildLookupReviewedFamilyRecallRuntimeArtifact({
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-07T00:00:00.000Z',
      entityProjectionDocuments: [
        {
          entityId: 'wine-silver-oak-alexander',
          entityType: 'wine',
          canonicalLabel: '1984 Silver Oak Alexander Valley Cabernet Sauvignon',
          aliasesIdentitySafe: ['Silver Oak Alexander Valley Cabernet Sauvignon'],
          aliasesNoisyRecall: [],
          producer: 'Silver Oak',
          region: 'United States',
          grapes: ['Cabernet Sauvignon'],
          searchTextKo: '',
          searchTextEn: '',
          semanticSummary: '',
          pairing: [],
          availability: true,
          popularityScore: 0.8,
        },
        {
          entityId: 'wine-silver-oak-napa',
          entityType: 'wine',
          canonicalLabel: '2014 Silver Oak Napa Valley Cabernet Sauvignon',
          aliasesIdentitySafe: ['Silver Oak Napa Valley Cabernet Sauvignon'],
          aliasesNoisyRecall: [],
          producer: 'Silver Oak',
          region: 'United States',
          grapes: ['Cabernet Sauvignon'],
          searchTextKo: '',
          searchTextEn: '',
          semanticSummary: '',
          pairing: [],
          availability: true,
          popularityScore: 0.8,
        },
      ],
      reviewedCollisionRows: [
        {
          benchmarkGoldHint: 'silver oak',
          normalizedBenchmarkGoldHint: 'silver oak',
          collisionStatus: 'active_entity_collision',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T00:00:00.000Z',
          decisionReason: 'collision',
          evidenceClass: 'collision_support_review',
        },
      ],
      localizedScopeSurfaceRows: [
        {
          componentKind: 'family',
          componentKey: 'silver oak',
          localSurface: '실버 오크',
          normalizedLocalSurface: '실버 오크',
          locale: 'ko',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T00:00:00.000Z',
          decisionReason: 'localized review',
          evidenceClass: 'localized_scope_surface_review',
        },
        {
          componentKind: 'family',
          componentKey: 'silver oak',
          localSurface: '실버오크',
          normalizedLocalSurface: '실버오크',
          locale: 'ko',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T00:00:00.000Z',
          decisionReason: 'localized review',
          evidenceClass: 'localized_scope_surface_review',
        },
      ],
    });

    expect(artifact.entries['silver oak']).toEqual({
      normalizedSurface: 'silver oak',
      familyKey: 'silver oak',
      entityIds: ['wine-silver-oak-alexander', 'wine-silver-oak-napa'],
      recallWeight: 0.5,
      localizedSurfaces: ['실버 오크', '실버오크'],
      witnessSources: ['producer'],
    });
  });

  it('fails closed when a reviewed collision row has no active collision owners in the snapshot', () => {
    expect(() => buildLookupReviewedFamilyRecallRuntimeArtifact({
      snapshotId: 'search-snapshot:v1:test',
      generatedAt: '2026-06-07T00:00:00.000Z',
      entityProjectionDocuments: [
        {
          entityId: 'wine-bollinger',
          entityType: 'wine',
          canonicalLabel: '2019 Bollinger La Cote Aux Enfants',
          aliasesIdentitySafe: ['Bollinger La Cote Aux Enfants'],
          aliasesNoisyRecall: [],
          producer: 'Bollinger',
          region: 'France',
          grapes: ['Pinot Noir'],
          searchTextKo: '',
          searchTextEn: '',
          semanticSummary: '',
          pairing: [],
          availability: true,
          popularityScore: 0.7,
        },
      ],
      reviewedCollisionRows: [
        {
          benchmarkGoldHint: 'bollinger',
          normalizedBenchmarkGoldHint: 'bollinger',
          collisionStatus: 'active_entity_collision',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T00:00:00.000Z',
          decisionReason: 'collision',
          evidenceClass: 'collision_support_review',
        },
      ],
    })).toThrow(/no active collision owners/i);
  });
});
