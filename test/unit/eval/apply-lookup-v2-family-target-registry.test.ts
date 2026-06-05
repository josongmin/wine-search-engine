import { describe, expect, it } from 'vitest';
import { applyLookupV2FamilyTargetRegistry } from '../../../scripts/eval/apply-lookup-v2-family-target-registry.js';

describe('applyLookupV2FamilyTargetRegistry', () => {
  it('appends reviewed family target rows into the registry and tracks pending rows', () => {
    const result = applyLookupV2FamilyTargetRegistry({
      familyRows: [
        {
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          benchmarkGoldHintVariants: ['petrus'],
          proposalStatus: 'target_assigned',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          locales: ['ko'],
          surfaces: ['페트뤼스'],
          holeClasses: ['realworld_korean_orthography'],
          suggestedAliasTypes: ['canonical'],
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
          benchmarkGoldHint: 'salon',
          normalizedBenchmarkGoldHint: 'salon',
          benchmarkGoldHintVariants: ['salon'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
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
    });

    expect(result.pendingRows).toBe(1);
    expect(result.approvedRows).toBe(1);
    expect(result.rejectedRows).toBe(0);
    expect(result.registryInsertedRows).toBe(1);
    expect(result.registrySkippedExistingRows).toBe(0);
    expect(result.registryConflictRows).toBe(0);
    expect(result.mergedRows).toEqual([
      expect.objectContaining({
        benchmarkGoldHint: 'petrus',
        normalizedBenchmarkGoldHint: 'petrus',
        entityId: 'wine-ce-petrus',
        decisionStatus: 'approved',
      }),
    ]);
  });

  it('fails closed on conflicting existing owners', () => {
    const result = applyLookupV2FamilyTargetRegistry({
      familyRows: [
        {
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          benchmarkGoldHintVariants: ['petrus'],
          proposalStatus: 'target_assigned',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          locales: ['ko'],
          surfaces: ['페트뤼스'],
          holeClasses: ['realworld_korean_orthography'],
          suggestedAliasTypes: ['canonical'],
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
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          entityId: 'wine-ce-a',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'seed',
          evidenceClass: 'fixture_exact',
        },
      ],
      knownEntityIds: new Set(['wine-ce-a', 'wine-ce-b']),
    });

    expect(result.registryConflictRows).toBe(1);
    expect(result.registryInsertedRows).toBe(0);
  });
});
