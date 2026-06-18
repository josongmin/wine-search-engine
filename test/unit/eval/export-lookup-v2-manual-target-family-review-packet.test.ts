import { describe, expect, it } from 'vitest';
import { buildLookupV2ManualTargetFamilyReviewPacketRows } from '../../../scripts/eval/export-lookup-v2-manual-target-family-review-packet.js';

describe('buildLookupV2ManualTargetFamilyReviewPacketRows', () => {
  it('groups scope_target_review rows by semantic scope key', () => {
    const rows = buildLookupV2ManualTargetFamilyReviewPacketRows({
      draftRows: [
        {
          surface: '칼롱 세귀르',
          locale: 'ko',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_korean_orthography',
          observedStatus: 'failed',
          benchmarkGoldHint: 'calon segur',
          semanticScopeKey: 'family::calon segur::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'calon segur',
          surfaceFormKind: 'bare',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'coverage hole A',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          surface: '칼롱세귀르',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_compact_alias',
          observedStatus: 'failed',
          benchmarkGoldHint: 'Calon Segur',
          semanticScopeKey: 'family::calon segur::::::::::compact::ko',
          scopeAxis: 'family',
          familyKey: 'calon segur',
          surfaceFormKind: 'compact',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/b.json',
          sourceEvidence: 'coverage hole B',
          reviewedAt: '2026-06-06T01:00:00.000Z',
        },
        {
          surface: '샤또 라뚜르',
          locale: 'ko',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_producer_prefixed',
          observedStatus: 'failed',
          benchmarkGoldHint: 'latour',
          semanticScopeKey: 'family::latour::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'latour',
          surfaceFormKind: 'bare',
          triageBucket: 'scope_policy_review',
          sourceArtifact: '/tmp/c.json',
          sourceEvidence: 'coverage hole C',
          reviewedAt: '2026-06-06T02:00:00.000Z',
        },
      ],
      runtimeOwnerEvidence: {
        uniqueOwners: new Map([['calon segur', 'wine-ce-calon-segur']]),
        collidingOwners: new Map(),
        entityLabels: new Map([['wine-ce-calon-segur', 'Calon Segur 2010']]),
        entityProducers: new Map([['wine-ce-calon-segur', 'Chateau Calon-Segur']]),
        entityRegions: new Map([['wine-ce-calon-segur', 'France']]),
        entityAppellations: new Map([['wine-ce-calon-segur', 'Saint-Estephe']]),
        uniqueOwnerWitnesses: new Map([
          ['calon segur', [
            {
              entityId: 'wine-ce-calon-segur',
              witnessSurface: 'Calon Segur 2010',
              witnessSource: 'canonical_label',
            },
            {
              entityId: 'wine-ce-calon-segur',
              witnessSurface: 'Calon Segur',
              witnessSource: 'aliases_noisy_recall',
            },
          ]],
        ]),
        collidingOwnerWitnesses: new Map(),
      },
      runtimeDescriptorMap: new Map([
        ['wine-ce-calon-segur', {
          entityId: 'wine-ce-calon-segur',
          canonicalLabel: 'Calon Segur 2010',
          familyKey: 'calon segur',
        }],
      ]),
    });

    expect(rows).toEqual([
      {
        semanticScopeKey: 'family::calon segur::::::::::bare::ko',
        scopeAxis: 'family',
        familyKey: 'calon segur',
        surfaceFormKind: 'bare',
        reviewScopeKey: 'family::calon segur::::::::::bare::ko',
        legacyReviewScopeKeys: ['calon segur::translation::realworld_korean_orthography'],
        benchmarkGoldHint: 'calon segur',
        normalizedBenchmarkGoldHint: 'calon segur',
        benchmarkGoldHintVariants: ['calon segur'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_manual_target_resolution_v1',
        scopeHoleClass: 'realworld_korean_orthography',
        scopeSuggestedAliasType: 'translation',
        scopeRisk: 'family_only',
        locales: ['ko'],
        surfaces: ['칼롱 세귀르'],
        holeClasses: ['realworld_korean_orthography'],
        suggestedAliasTypes: ['translation'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/a.json'],
        sourceEvidenceSamples: ['coverage hole A'],
        runtimeEvidenceStatus: 'candidate_unique_owner',
        runtimeEvidenceEntityId: 'wine-ce-calon-segur',
        runtimeEvidenceEntityLabel: 'Calon Segur 2010',
        runtimeEvidenceWitnesses: [
          {
            entityId: 'wine-ce-calon-segur',
            witnessSurface: 'Calon Segur 2010',
            witnessSource: 'canonical_label',
          },
          {
            entityId: 'wine-ce-calon-segur',
            witnessSurface: 'Calon Segur',
            witnessSource: 'aliases_noisy_recall',
          },
        ],
        proposedAt: '2026-06-06T00:00:00.000Z',
      },
      {
        semanticScopeKey: 'family::calon segur::::::::::compact::ko',
        scopeAxis: 'family',
        familyKey: 'calon segur',
        surfaceFormKind: 'compact',
        reviewScopeKey: 'family::calon segur::::::::::compact::ko',
        legacyReviewScopeKeys: ['calon segur::canonical::realworld_compact_alias'],
        benchmarkGoldHint: 'Calon Segur',
        normalizedBenchmarkGoldHint: 'calon segur',
        benchmarkGoldHintVariants: ['Calon Segur'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_manual_target_resolution_v1',
        scopeHoleClass: 'realworld_compact_alias',
        scopeSuggestedAliasType: 'canonical',
        scopeRisk: 'family_only',
        locales: ['ko'],
        surfaces: ['칼롱세귀르'],
        holeClasses: ['realworld_compact_alias'],
        suggestedAliasTypes: ['canonical'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/b.json'],
        sourceEvidenceSamples: ['coverage hole B'],
        runtimeEvidenceStatus: 'candidate_unique_owner',
        runtimeEvidenceEntityId: 'wine-ce-calon-segur',
        runtimeEvidenceEntityLabel: 'Calon Segur 2010',
        runtimeEvidenceWitnesses: [
          {
            entityId: 'wine-ce-calon-segur',
            witnessSurface: 'Calon Segur 2010',
            witnessSource: 'canonical_label',
          },
          {
            entityId: 'wine-ce-calon-segur',
            witnessSurface: 'Calon Segur',
            witnessSource: 'aliases_noisy_recall',
          },
        ],
        proposedAt: '2026-06-06T01:00:00.000Z',
      },
    ]);
  });

  it('collapses mixed fixture classes that share one semantic scope into one review row', () => {
    const rows = buildLookupV2ManualTargetFamilyReviewPacketRows({
      draftRows: [
        {
          surface: '슈발 블랑 2010',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'ambiguous',
          benchmarkGoldHint: 'cheval blanc',
          semanticScopeKey: 'family::cheval blanc::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'cheval blanc',
          surfaceFormKind: 'bare',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/coverage.json',
          sourceEvidence: 'exact vintage gap',
          reviewedAt: '2026-06-07T00:00:00.000Z',
        },
        {
          surface: '슈발블랑 2015',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_spaced_alias',
          observedStatus: 'ambiguous',
          benchmarkGoldHint: 'cheval blanc',
          semanticScopeKey: 'family::cheval blanc::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'cheval blanc',
          surfaceFormKind: 'bare',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/coverage.json',
          sourceEvidence: 'spaced alias gap',
          reviewedAt: '2026-06-07T00:01:00.000Z',
        },
      ],
      runtimeOwnerEvidence: {
        uniqueOwners: new Map(),
        collidingOwners: new Map(),
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map(),
        entityLabels: new Map(),
        entityProducers: new Map(),
        entityRegions: new Map(),
        entityAppellations: new Map(),
      },
      runtimeDescriptorMap: new Map(),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        semanticScopeKey: 'family::cheval blanc::::::::::bare::ko',
        reviewScopeKey: 'family::cheval blanc::::::::::bare::ko',
        legacyReviewScopeKeys: [
          'cheval blanc::canonical::realworld_exact_vintage',
          'cheval blanc::canonical::realworld_spaced_alias',
        ],
        scopeHoleClass: 'realworld_exact_vintage',
        scopeSuggestedAliasType: 'canonical',
        holeClasses: ['realworld_exact_vintage', 'realworld_spaced_alias'],
        suggestedAliasTypes: ['canonical'],
        surfaces: ['슈발 블랑 2010', '슈발블랑 2015'],
        rowCount: 2,
        runtimeGapReason: 'runtime_family_missing',
      }),
    ]);
  });

  it('keeps mixed-vintage line scopes closed but still allows a family scope to bind to a structural singleton owner', () => {
    const rows = buildLookupV2ManualTargetFamilyReviewPacketRows({
      draftRows: [
        {
          surface: '폴 로저 윈스턴 처칠',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_brand_suffix',
          observedStatus: 'failed',
          benchmarkGoldHint: 'pol roger',
          semanticScopeKey: 'family::pol roger::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'pol roger',
          surfaceFormKind: 'bare',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/coverage.json',
          sourceEvidence: 'brand suffix gap',
          reviewedAt: '2026-06-07T00:00:00.000Z',
        },
        {
          surface: '폴 로저 18',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_vintage_suffix',
          observedStatus: 'failed',
          benchmarkGoldHint: 'pol roger',
          semanticScopeKey: 'line::pol roger::::::::2018::qualified::ko',
          scopeAxis: 'line',
          familyKey: 'pol roger',
          vintage: 2018,
          surfaceFormKind: 'qualified',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/coverage.json',
          sourceEvidence: 'vintage gap',
          reviewedAt: '2026-06-07T00:01:00.000Z',
        },
        {
          surface: '솔라이아 2018',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'solaia',
          semanticScopeKey: 'line::solaia::::::::2018::qualified::ko',
          scopeAxis: 'line',
          familyKey: 'solaia',
          vintage: 2018,
          surfaceFormKind: 'qualified',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/coverage.json',
          sourceEvidence: 'exact vintage gap',
          reviewedAt: '2026-06-07T00:02:00.000Z',
        },
      ],
      runtimeOwnerEvidence: {
        uniqueOwners: new Map([
          ['pol roger', 'wine-ce-pol-roger-2020'],
          ['solaia', 'wine-ce-solaia-2018'],
        ]),
        collidingOwners: new Map(),
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map(),
        entityLabels: new Map([
          ['wine-ce-pol-roger-2020', '2020 Pol Roger Champagne'],
          ['wine-ce-solaia-2018', '2018 Solaia'],
        ]),
        entityProducers: new Map(),
        entityRegions: new Map(),
        entityAppellations: new Map(),
      },
      runtimeDescriptorMap: new Map([
        ['wine-ce-pol-roger-2020', {
          entityId: 'wine-ce-pol-roger-2020',
          canonicalLabel: '2020 Pol Roger Champagne',
          familyKey: 'pol roger',
          vintage: 2020,
        }],
        ['wine-ce-solaia-2018', {
          entityId: 'wine-ce-solaia-2018',
          canonicalLabel: '2018 Solaia',
          familyKey: 'solaia',
          vintage: 2018,
        }],
      ]),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        semanticScopeKey: 'family::pol roger::::::::::bare::ko',
        scopeRisk: 'mixed_vintage_family',
        runtimeEvidenceStatus: 'candidate_unique_owner',
        runtimeEvidenceEntityId: 'wine-ce-pol-roger-2020',
      }),
      expect.objectContaining({
        semanticScopeKey: 'line::pol roger::::::::2018::qualified::ko',
        scopeRisk: 'mixed_vintage_family',
        runtimeEvidenceStatus: 'missing_runtime_owner',
        runtimeGapReason: 'requested_vintage_missing',
        runtimeGapAvailableVintages: [2020],
      }),
      expect.objectContaining({
        semanticScopeKey: 'line::solaia::::::::2018::qualified::ko',
        scopeRisk: 'mixed_vintage_family',
        runtimeEvidenceStatus: 'candidate_unique_owner',
        runtimeEvidenceEntityId: 'wine-ce-solaia-2018',
      }),
    ]);
  });

  it('promotes a collision set to candidate_unique_owner when exactly one runtime descriptor matches the full requested scope', () => {
    const rows = buildLookupV2ManualTargetFamilyReviewPacketRows({
      draftRows: [
        {
          surface: '오푸스원 2018',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'opus one',
          semanticScopeKey: 'line::opus one::오푸스원::::::2018::qualified::ko',
          scopeAxis: 'line',
          familyKey: 'opus one',
          lineKey: '오푸스원',
          vintage: 2018,
          surfaceFormKind: 'qualified',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/coverage.json',
          sourceEvidence: 'exact vintage gap',
          reviewedAt: '2026-06-08T00:00:00.000Z',
        },
      ],
      runtimeOwnerEvidence: {
        uniqueOwners: new Map(),
        collidingOwners: new Map([
          ['opus one', [
            'opus-one-2018',
            'wine-ce-5b9b06d3a1acd3f2394424d420b56e1d0cce85e5b4e924c006e1ade3819787a3',
            'wine-ce-d39efce2cbe92cf403923d5e53dbb15fec3b4f7e738f25933a7e892d57002e63',
          ]],
        ]),
        entityLabels: new Map([
          ['opus-one-2018', 'Opus One 2018'],
          ['wine-ce-5b9b06d3a1acd3f2394424d420b56e1d0cce85e5b4e924c006e1ade3819787a3', '1987 Opus One Opus One'],
          ['wine-ce-d39efce2cbe92cf403923d5e53dbb15fec3b4f7e738f25933a7e892d57002e63', '2019 Opus One Overture'],
        ]),
        entityProducers: new Map(),
        entityRegions: new Map(),
        entityAppellations: new Map(),
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map([
          ['opus one', [
            {
              entityId: 'opus-one-2018',
              witnessSurface: 'opus one',
              witnessSource: 'family_core_key',
            },
            {
              entityId: 'wine-ce-5b9b06d3a1acd3f2394424d420b56e1d0cce85e5b4e924c006e1ade3819787a3',
              witnessSurface: 'opus one',
              witnessSource: 'family_core_key',
            },
            {
              entityId: 'wine-ce-d39efce2cbe92cf403923d5e53dbb15fec3b4f7e738f25933a7e892d57002e63',
              witnessSurface: 'Opus One',
              witnessSource: 'producer',
            },
          ]],
        ]),
      },
      runtimeDescriptorMap: new Map([
        ['opus-one-2018', {
          entityId: 'opus-one-2018',
          canonicalLabel: 'Opus One 2018',
          familyKey: 'opus one',
          lineKey: '오푸스원',
          vintage: 2018,
        }],
        ['wine-ce-5b9b06d3a1acd3f2394424d420b56e1d0cce85e5b4e924c006e1ade3819787a3', {
          entityId: 'wine-ce-5b9b06d3a1acd3f2394424d420b56e1d0cce85e5b4e924c006e1ade3819787a3',
          canonicalLabel: '1987 Opus One Opus One',
          familyKey: 'opus one',
          lineKey: '오푸스원',
          vintage: 1987,
        }],
        ['wine-ce-d39efce2cbe92cf403923d5e53dbb15fec3b4f7e738f25933a7e892d57002e63', {
          entityId: 'wine-ce-d39efce2cbe92cf403923d5e53dbb15fec3b4f7e738f25933a7e892d57002e63',
          canonicalLabel: '2019 Opus One Overture',
          familyKey: 'overture',
          lineKey: 'opus one overture',
          vintage: 2019,
        }],
      ]),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        semanticScopeKey: 'line::opus one::오푸스원::::::2018::qualified::ko',
        runtimeEvidenceStatus: 'candidate_unique_owner',
        runtimeEvidenceEntityId: 'opus-one-2018',
        runtimeEvidenceEntityLabel: 'Opus One 2018',
        runtimeEvidenceWitnesses: [
          {
            entityId: 'opus-one-2018',
            witnessSurface: 'opus one',
            witnessSource: 'family_core_key',
          },
        ],
      }),
    ]);
  });

  it('reclassifies scoped collision sets with zero exact matches into runtime backfill work', () => {
    const rows = buildLookupV2ManualTargetFamilyReviewPacketRows({
      draftRows: [
        {
          surface: 'Opus 원 2019',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_mixed_script_alias',
          observedStatus: 'failed',
          benchmarkGoldHint: 'opus one',
          semanticScopeKey: 'line::opus one::::::::2019::mixed_script::ko',
          scopeAxis: 'line',
          familyKey: 'opus one',
          vintage: 2019,
          surfaceFormKind: 'mixed_script',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/coverage.json',
          sourceEvidence: 'mixed-script vintage gap',
          reviewedAt: '2026-06-08T00:00:00.000Z',
        },
      ],
      runtimeOwnerEvidence: {
        uniqueOwners: new Map(),
        collidingOwners: new Map([
          ['opus one', [
            'opus-one-2018',
            'wine-ce-5b9b06d3a1acd3f2394424d420b56e1d0cce85e5b4e924c006e1ade3819787a3',
            'wine-ce-d39efce2cbe92cf403923d5e53dbb15fec3b4f7e738f25933a7e892d57002e63',
          ]],
        ]),
        entityLabels: new Map([
          ['opus-one-2018', 'Opus One 2018'],
          ['wine-ce-5b9b06d3a1acd3f2394424d420b56e1d0cce85e5b4e924c006e1ade3819787a3', '1987 Opus One Opus One'],
          ['wine-ce-d39efce2cbe92cf403923d5e53dbb15fec3b4f7e738f25933a7e892d57002e63', '2019 Opus One Overture'],
        ]),
        entityProducers: new Map(),
        entityRegions: new Map(),
        entityAppellations: new Map(),
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map([
          ['opus one', [
            {
              entityId: 'opus-one-2018',
              witnessSurface: 'opus one',
              witnessSource: 'family_core_key',
            },
            {
              entityId: 'wine-ce-5b9b06d3a1acd3f2394424d420b56e1d0cce85e5b4e924c006e1ade3819787a3',
              witnessSurface: 'opus one',
              witnessSource: 'family_core_key',
            },
            {
              entityId: 'wine-ce-d39efce2cbe92cf403923d5e53dbb15fec3b4f7e738f25933a7e892d57002e63',
              witnessSurface: 'Opus One',
              witnessSource: 'producer',
            },
          ]],
        ]),
      },
      runtimeDescriptorMap: new Map([
        ['opus-one-2018', {
          entityId: 'opus-one-2018',
          canonicalLabel: 'Opus One 2018',
          familyKey: 'opus one',
          lineKey: '오푸스원',
          regionKey: 'napa valley',
          appellationKey: 'napa valley ava',
          vintage: 2018,
        }],
        ['wine-ce-5b9b06d3a1acd3f2394424d420b56e1d0cce85e5b4e924c006e1ade3819787a3', {
          entityId: 'wine-ce-5b9b06d3a1acd3f2394424d420b56e1d0cce85e5b4e924c006e1ade3819787a3',
          canonicalLabel: '1987 Opus One Opus One',
          familyKey: 'opus one',
          lineKey: '오푸스원',
          regionKey: 'united states',
          vintage: 1987,
        }],
        ['wine-ce-d39efce2cbe92cf403923d5e53dbb15fec3b4f7e738f25933a7e892d57002e63', {
          entityId: 'wine-ce-d39efce2cbe92cf403923d5e53dbb15fec3b4f7e738f25933a7e892d57002e63',
          canonicalLabel: '2019 Opus One Overture',
          familyKey: 'overture',
          lineKey: 'opus one overture',
          regionKey: 'united states',
          vintage: 2019,
        }],
      ]),
    });

    expect(rows).toEqual([
      expect.objectContaining({
        semanticScopeKey: 'line::opus one::::::::2019::mixed_script::ko',
        runtimeEvidenceStatus: 'missing_runtime_owner',
        runtimeGapReason: 'requested_vintage_missing',
        runtimeGapAvailableVintages: [1987, 2018],
      }),
    ]);
  });
});
