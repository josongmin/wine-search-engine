import { describe, expect, it } from 'vitest';
import { applyLookupV2SemanticScopeTargetRegistry } from '../../../scripts/eval/apply-lookup-v2-semantic-scope-target-registry.js';

describe('applyLookupV2SemanticScopeTargetRegistry', () => {
  it('appends reviewed semantic scope rows into the registry and tracks pending rows', () => {
    const result = applyLookupV2SemanticScopeTargetRegistry({
      familyRows: [
        {
          semanticScopeKey: 'family::petrus::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'petrus',
          surfaceFormKind: 'bare',
          reviewScopeKey: 'family::petrus::::::::::bare::ko',
          legacyReviewScopeKeys: ['petrus::translation::realworld_korean_orthography'],
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          benchmarkGoldHintVariants: ['petrus'],
          proposalStatus: 'target_assigned',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_korean_orthography',
          scopeSuggestedAliasType: 'translation',
          scopeRisk: 'family_only',
          locales: ['ko'],
          surfaces: ['페트뤼스'],
          holeClasses: ['realworld_korean_orthography'],
          suggestedAliasTypes: ['translation'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          runtimeEvidenceStatus: 'missing_runtime_owner',
          proposedAt: '2026-06-06T00:00:00.000Z',
          targetEntityId: 'wine-ce-petrus',
          reviewedAt: '2026-06-06T01:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'reviewed target',
        },
        {
          semanticScopeKey: 'line::salon::::::::2012::qualified::ko',
          scopeAxis: 'line',
          familyKey: 'salon',
          vintage: 2012,
          surfaceFormKind: 'qualified',
          reviewScopeKey: 'line::salon::::::::2012::qualified::ko',
          legacyReviewScopeKeys: ['salon::canonical::realworld_exact_vintage'],
          benchmarkGoldHint: 'salon',
          normalizedBenchmarkGoldHint: 'salon',
          benchmarkGoldHintVariants: ['salon'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_exact_vintage',
          scopeSuggestedAliasType: 'canonical',
          scopeRisk: 'mixed_vintage_family',
          locales: ['ko'],
          surfaces: ['살롱 2012'],
          holeClasses: ['realworld_exact_vintage'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/b.json'],
          sourceEvidenceSamples: ['coverage hole'],
          runtimeEvidenceStatus: 'missing_runtime_owner',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      existingRegistryRows: [],
      knownEntityIds: new Set(['wine-ce-petrus']),
      runtimeDescriptorMap: new Map([
        ['wine-ce-petrus', {
          familyKey: 'petrus',
        }],
      ]),
    });

    expect(result.pendingRows).toBe(1);
    expect(result.approvedRows).toBe(1);
    expect(result.rejectedRows).toBe(0);
    expect(result.registryInsertedRows).toBe(1);
    expect(result.registrySkippedExistingRows).toBe(0);
    expect(result.registryConflictRows).toBe(0);
    expect(result.mergedRows).toEqual([
      expect.objectContaining({
        semanticScopeKey: 'family::petrus::::::::::bare::ko',
        benchmarkGoldHint: 'petrus',
        familyKey: 'petrus',
        entityId: 'wine-ce-petrus',
        decisionStatus: 'approved',
      }),
    ]);
  });

  it('fails closed on conflicting existing owners', () => {
    const result = applyLookupV2SemanticScopeTargetRegistry({
      familyRows: [
        {
          semanticScopeKey: 'family::petrus::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'petrus',
          surfaceFormKind: 'bare',
          reviewScopeKey: 'family::petrus::::::::::bare::ko',
          legacyReviewScopeKeys: ['petrus::translation::realworld_korean_orthography'],
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          benchmarkGoldHintVariants: ['petrus'],
          proposalStatus: 'target_assigned',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_korean_orthography',
          scopeSuggestedAliasType: 'translation',
          scopeRisk: 'family_only',
          locales: ['ko'],
          surfaces: ['페트뤼스'],
          holeClasses: ['realworld_korean_orthography'],
          suggestedAliasTypes: ['translation'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          runtimeEvidenceStatus: 'missing_runtime_owner',
          proposedAt: '2026-06-06T00:00:00.000Z',
          targetEntityId: 'wine-ce-b',
          reviewedAt: '2026-06-06T01:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'reviewed target',
        },
      ],
      existingRegistryRows: [
        {
          semanticScopeKey: 'family::petrus::::::::::bare::ko',
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          scopeAxis: 'family',
          familyKey: 'petrus',
          surfaceFormKind: 'bare',
          locale: 'ko',
          entityId: 'wine-ce-a',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'seed',
          evidenceClass: 'fixture_exact',
        },
      ],
      knownEntityIds: new Set(['wine-ce-a', 'wine-ce-b']),
      runtimeDescriptorMap: new Map([
        ['wine-ce-a', { familyKey: 'petrus' }],
        ['wine-ce-b', { familyKey: 'petrus' }],
      ]),
    });

    expect(result.registryConflictRows).toBe(1);
    expect(result.registryInsertedRows).toBe(0);
  });

  it('preserves reviewed_collision evidence class when applying collision family reviews', () => {
    const result = applyLookupV2SemanticScopeTargetRegistry({
      familyRows: [
        {
          semanticScopeKey: 'line::silver oak::::::::2017::qualified::ko',
          scopeAxis: 'line',
          familyKey: 'silver oak',
          vintage: 2017,
          surfaceFormKind: 'qualified',
          reviewScopeKey: 'line::silver oak::::::::2017::qualified::ko',
          legacyReviewScopeKeys: ['silver oak::canonical::realworld_vintage_suffix'],
          benchmarkGoldHint: 'silver oak',
          normalizedBenchmarkGoldHint: 'silver oak',
          benchmarkGoldHintVariants: ['silver oak'],
          proposalStatus: 'target_assigned',
          reviewTarget: 'lookup_reviewed_collision_resolution_v1',
          scopeHoleClass: 'realworld_vintage_suffix',
          scopeSuggestedAliasType: 'canonical',
          scopeRisk: 'mixed_vintage_family',
          locales: ['ko'],
          surfaces: ['실버 오크 17'],
          holeClasses: ['realworld_vintage_suffix'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/c.json'],
          sourceEvidenceSamples: ['coverage hole'],
          runtimeEvidenceStatus: 'collision_candidates',
          runtimeCollisionEntityIds: ['wine-ce-silver-oak-av', 'wine-ce-silver-oak-napa'],
          runtimeCollisionEntityLabels: ['Silver Oak Alexander Valley Cabernet Sauvignon', 'Silver Oak Napa Valley Cabernet Sauvignon'],
          proposedAt: '2026-06-07T00:00:00.000Z',
          targetEntityId: 'wine-ce-silver-oak-av',
          reviewedAt: '2026-06-07T01:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'reviewed collision target',
        },
      ],
      existingRegistryRows: [],
      knownEntityIds: new Set(['wine-ce-silver-oak-av', 'wine-ce-silver-oak-napa']),
      runtimeDescriptorMap: new Map([
        ['wine-ce-silver-oak-av', { familyKey: 'silver oak', vintage: 2017 }],
        ['wine-ce-silver-oak-napa', { familyKey: 'silver oak', vintage: 2017 }],
      ]),
    });

    expect(result.registryInsertedRows).toBe(1);
    expect(result.mergedRows).toEqual([
      expect.objectContaining({
        semanticScopeKey: 'line::silver oak::::::::2017::qualified::ko',
        entityId: 'wine-ce-silver-oak-av',
        evidenceClass: 'reviewed_collision_family_review',
      }),
    ]);
  });

  it('fails closed when the reviewed row family scope does not match the runtime descriptor owner', () => {
    const result = applyLookupV2SemanticScopeTargetRegistry({
      familyRows: [
        {
          semanticScopeKey: 'family::solaia::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'solaia',
          surfaceFormKind: 'bare',
          reviewScopeKey: 'family::solaia::::::::::bare::ko',
          legacyReviewScopeKeys: ['solaia::canonical::realworld_brand_suffix'],
          benchmarkGoldHint: 'solaia',
          normalizedBenchmarkGoldHint: 'solaia',
          benchmarkGoldHintVariants: ['solaia'],
          proposalStatus: 'target_assigned',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_brand_suffix',
          scopeSuggestedAliasType: 'canonical',
          scopeRisk: 'family_only',
          locales: ['ko'],
          surfaces: ['솔라이아 또스카나'],
          holeClasses: ['realworld_brand_suffix'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/d.json'],
          sourceEvidenceSamples: ['coverage hole'],
          runtimeEvidenceStatus: 'candidate_unique_owner',
          proposedAt: '2026-06-07T00:00:00.000Z',
          targetEntityId: 'wine-ce-solaia',
          reviewedAt: '2026-06-07T01:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'reviewed target',
        },
      ],
      existingRegistryRows: [],
      knownEntityIds: new Set(['wine-ce-solaia']),
      runtimeDescriptorMap: new Map([
        ['wine-ce-solaia', { familyKey: 'tenuta tignanello solaia', vintage: 2018 }],
      ]),
    });

    expect(result.registryInsertedRows).toBe(0);
    expect(result.registryConflictRows).toBe(1);
  });
});
