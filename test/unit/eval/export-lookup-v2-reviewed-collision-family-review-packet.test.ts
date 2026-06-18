import { describe, expect, it } from 'vitest';
import { buildLookupV2ReviewedCollisionFamilyReviewPacketRows } from '../../../scripts/eval/export-lookup-v2-manual-target-family-review-packet.js';

describe('buildLookupV2ReviewedCollisionFamilyReviewPacketRows', () => {
  it('groups reviewed_collision rows into scope-level family target review packets', () => {
    const rows = buildLookupV2ReviewedCollisionFamilyReviewPacketRows({
      draftRows: [
        {
          surface: '실버 오크 17',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_vintage_suffix',
          observedStatus: 'failed',
          benchmarkGoldHint: 'silver oak',
          semanticScopeKey: 'family::silver oak::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'silver oak',
          surfaceFormKind: 'bare',
          triageBucket: 'reviewed_collision',
          collisionStatus: 'active_entity_collision',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'coverage hole A',
          reviewedAt: '2026-06-07T00:00:00.000Z',
        },
        {
          surface: '실버 오크 09',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_vintage_suffix',
          observedStatus: 'failed',
          benchmarkGoldHint: 'Silver Oak',
          semanticScopeKey: 'family::silver oak::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'silver oak',
          surfaceFormKind: 'bare',
          triageBucket: 'reviewed_collision',
          collisionStatus: 'active_entity_collision',
          sourceArtifact: '/tmp/b.json',
          sourceEvidence: 'coverage hole B',
          reviewedAt: '2026-06-07T01:00:00.000Z',
        },
      ],
      runtimeOwnerEvidence: {
        uniqueOwners: new Map(),
        collidingOwners: new Map([['silver oak', ['wine-ce-silver-oak-av', 'wine-ce-silver-oak-napa']]]),
        entityLabels: new Map([
          ['wine-ce-silver-oak-av', 'Silver Oak Alexander Valley Cabernet Sauvignon'],
          ['wine-ce-silver-oak-napa', 'Silver Oak Napa Valley Cabernet Sauvignon'],
        ]),
        entityProducers: new Map([
          ['wine-ce-silver-oak-av', 'Silver Oak'],
          ['wine-ce-silver-oak-napa', 'Silver Oak'],
        ]),
        entityRegions: new Map([
          ['wine-ce-silver-oak-av', 'United States'],
          ['wine-ce-silver-oak-napa', 'United States'],
        ]),
        entityAppellations: new Map([
          ['wine-ce-silver-oak-av', 'Alexander Valley'],
          ['wine-ce-silver-oak-napa', 'Napa Valley'],
        ]),
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map([
          ['silver oak', [
            {
              entityId: 'wine-ce-silver-oak-av',
              witnessSurface: 'Silver Oak',
              witnessSource: 'producer',
            },
            {
              entityId: 'wine-ce-silver-oak-napa',
              witnessSurface: 'Silver Oak',
              witnessSource: 'producer',
            },
          ]],
        ]),
      },
      runtimeDescriptorMap: new Map([
        ['wine-ce-silver-oak-av', {
          entityId: 'wine-ce-silver-oak-av',
          canonicalLabel: 'Silver Oak Alexander Valley Cabernet Sauvignon',
          familyKey: 'silver oak',
          lineKey: 'alexander valley cabernet sauvignon',
          regionKey: 'united states',
          appellationKey: 'alexander valley',
          vintage: 1984,
        }],
        ['wine-ce-silver-oak-napa', {
          entityId: 'wine-ce-silver-oak-napa',
          canonicalLabel: 'Silver Oak Napa Valley Cabernet Sauvignon',
          familyKey: 'silver oak',
          lineKey: 'napa valley cabernet sauvignon',
          regionKey: 'united states',
          appellationKey: 'napa valley',
          vintage: 2014,
        }],
      ]),
    });

    expect(rows).toEqual([
      {
        semanticScopeKey: 'family::silver oak::::::::::bare::ko',
        scopeAxis: 'family',
        familyKey: 'silver oak',
        surfaceFormKind: 'bare',
        reviewScopeKey: 'family::silver oak::::::::::bare::ko',
        legacyReviewScopeKeys: ['silver oak::canonical::realworld_vintage_suffix'],
        benchmarkGoldHint: 'silver oak',
        normalizedBenchmarkGoldHint: 'silver oak',
        benchmarkGoldHintVariants: ['silver oak', 'Silver Oak'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_reviewed_collision_resolution_v1',
        scopeHoleClass: 'realworld_vintage_suffix',
        scopeSuggestedAliasType: 'canonical',
        scopeRisk: 'family_only',
        locales: ['ko'],
        surfaces: ['실버 오크 09', '실버 오크 17'],
        holeClasses: ['realworld_vintage_suffix'],
        suggestedAliasTypes: ['canonical'],
        rowCount: 2,
        sourceArtifacts: ['/tmp/a.json', '/tmp/b.json'],
        sourceEvidenceSamples: ['coverage hole A', 'coverage hole B'],
        runtimeEvidenceStatus: 'collision_candidates',
        runtimeCollisionEntityIds: ['wine-ce-silver-oak-av', 'wine-ce-silver-oak-napa'],
        runtimeCollisionEntityLabels: [
          'Silver Oak Alexander Valley Cabernet Sauvignon',
          'Silver Oak Napa Valley Cabernet Sauvignon',
        ],
        runtimeCollisionWitnesses: [
          {
            entityId: 'wine-ce-silver-oak-av',
            witnessSurface: 'Silver Oak',
            witnessSource: 'producer',
          },
          {
            entityId: 'wine-ce-silver-oak-napa',
            witnessSurface: 'Silver Oak',
            witnessSource: 'producer',
          },
        ],
        runtimeClarificationAxes: ['line', 'appellation', 'vintage'],
        runtimeCollisionScopeDescriptors: [
          {
            entityId: 'wine-ce-silver-oak-av',
            entityLabel: 'Silver Oak Alexander Valley Cabernet Sauvignon',
            familyKey: 'silver oak',
            lineKey: 'alexander valley cabernet sauvignon',
            regionKey: 'united states',
            appellationKey: 'alexander valley',
            vintage: 1984,
          },
          {
            entityId: 'wine-ce-silver-oak-napa',
            entityLabel: 'Silver Oak Napa Valley Cabernet Sauvignon',
            familyKey: 'silver oak',
            lineKey: 'napa valley cabernet sauvignon',
            regionKey: 'united states',
            appellationKey: 'napa valley',
            vintage: 2014,
          },
        ],
        proposedAt: '2026-06-07T01:00:00.000Z',
      },
    ]);
  });
});
