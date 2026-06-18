import { describe, expect, it } from 'vitest';
import { applyLookupV2PolicyFamilyDecisionRegistry } from '../../../scripts/eval/apply-lookup-v2-policy-family-decision-registry.js';

describe('applyLookupV2PolicyFamilyDecisionRegistry', () => {
  it('appends reviewed family policy decisions into the registry', () => {
    const result = applyLookupV2PolicyFamilyDecisionRegistry({
      familyRows: [
        {
          policyConflictSurface: '라뚜르',
          locale: 'ko',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSources: ['policy_registry_authority'],
          proposalStatus: 'approved_exact_safe',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          benchmarkGoldHints: ['latour'],
          sampleSurfaces: ['라뚜르 2009'],
          holeClasses: ['realworld_exact_vintage'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-06T00:00:00.000Z',
          reviewedAt: '2026-06-06T01:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'reviewed policy',
        },
      ],
      existingRegistryRows: [],
    });

    expect(result.pendingRows).toBe(0);
    expect(result.approvedRows).toBe(1);
    expect(result.registryInsertedRows).toBe(1);
    expect(result.registryConflictRows).toBe(0);
    expect(result.mergedRows).toEqual([
      expect.objectContaining({
        semanticConflictKey: '라뚜르',
        entityId: 'wine-ce-latour',
        decision: 'promote_exact_safe',
      }),
    ]);
  });

  it('fails closed on conflicting existing decisions', () => {
    const result = applyLookupV2PolicyFamilyDecisionRegistry({
      familyRows: [
        {
          policyConflictSurface: '라뚜르',
          locale: 'ko',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSources: ['policy_registry_authority'],
          proposalStatus: 'kept_ambiguous',
          reviewTarget: 'lookup_policy_conflict_registry_v1',
          benchmarkGoldHints: ['latour'],
          sampleSurfaces: ['라뚜르 2009'],
          holeClasses: ['realworld_exact_vintage'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole'],
          proposedAt: '2026-06-06T00:00:00.000Z',
          reviewedAt: '2026-06-06T01:00:00.000Z',
          reviewedBy: 'op',
          decisionReason: 'reviewed policy',
        },
      ],
      existingRegistryRows: [
        {
          semanticConflictKey: '라뚜르',
          conflictClass: 'short_form_collision',
          entityId: 'wine-ce-latour',
          decision: 'promote_exact_safe',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T00:00:00.000Z',
          decisionReason: 'seed',
        },
      ],
    });

    expect(result.registryConflictRows).toBe(1);
    expect(result.registryInsertedRows).toBe(0);
  });
});
