import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { CurationTask } from '../../../src/domain/alias/curation/coverage-curation-task.js';
import { normalizeForMatch } from '../../../src/domain/alias/service/normalize.js';
import { verifyLookupV2StretchReviewedRegistryOverlay } from '../../../scripts/eval/verify-lookup-v2-stretch-reviewed-registry-overlay.js';

describe('verifyLookupV2StretchReviewedRegistryOverlay', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('proves reviewed registry overlays monotonically reduce unresolved stretch buckets', async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), 'elv2-reviewed-registry-overlay-'));
    tempDirs.push(workDir);

    const tasks: readonly CurationTask[] = [
      {
        surfaceForm: '페트뤼스',
        holeClass: 'realworld_frenchish_korean_gap',
        observedStatus: 'failed',
        suggestedAliasType: 'translation',
        status: 'needs_target',
        benchmarkGoldHint: 'petrus',
        reason: 'coverage hole petrus',
      },
      {
        surfaceForm: '라뚜르 2009',
        holeClass: 'realworld_exact_vintage',
        observedStatus: 'ambiguous',
        suggestedAliasType: 'canonical',
        status: 'needs_target',
        benchmarkGoldHint: 'latour',
        reason: 'coverage hole latour',
      },
      {
        surfaceForm: '실버 오크 카베르네',
        holeClass: 'realworld_brand_suffix',
        observedStatus: 'failed',
        suggestedAliasType: 'canonical',
        status: 'needs_target',
        benchmarkGoldHint: 'silver oak',
        reason: 'coverage hole silver oak',
      },
    ];

    const summary = await verifyLookupV2StretchReviewedRegistryOverlay({
      tasks,
      inputArtifact: '/tmp/sample-entity-no-policy.json',
      generatedAt: '2026-06-06T03:00:00.000Z',
      workDir,
      outputSummaryPath: path.join(workDir, 'summary.json'),
      familyReviewRows: [
        {
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          benchmarkGoldHintVariants: ['petrus'],
          proposalStatus: 'target_assigned',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          locales: ['global'],
          surfaces: ['페트뤼스'],
          holeClasses: ['realworld_frenchish_korean_gap'],
          suggestedAliasTypes: ['translation'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/sample-entity-no-policy.json'],
          sourceEvidenceSamples: ['coverage hole petrus'],
          runtimeEvidenceStatus: 'candidate_unique_owner',
          runtimeEvidenceEntityId: 'wine-ce-petrus',
          runtimeEvidenceEntityLabel: 'Petrus',
          proposedAt: '2026-06-06T02:00:00.000Z',
          targetEntityId: 'wine-ce-petrus',
          reviewedAt: '2026-06-06T02:30:00.000Z',
          reviewedBy: 'codex',
          decisionReason: 'approved petrus family target',
        },
      ],
      policyFamilyReviewRows: [
        {
          policyConflictSurface: '라뚜르',
          locale: 'ko',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSources: ['policy_registry_authority'],
          proposalStatus: 'approved_exact_safe',
          reviewTarget: 'lookup_policy_conflict_resolution_v1',
          benchmarkGoldHints: ['latour'],
          sampleSurfaces: ['라뚜르 2009'],
          holeClasses: ['realworld_exact_vintage'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/sample-entity-no-policy.json'],
          sourceEvidenceSamples: ['coverage hole latour'],
          proposedAt: '2026-06-06T02:10:00.000Z',
          reviewedAt: '2026-06-06T02:40:00.000Z',
          reviewedBy: 'codex',
          decisionReason: 'approved latour policy family decision',
        },
      ],
      benchmarkGoldHintMap: new Map([
        ['petrus', 'wine-ce-petrus-hint-only'],
        ['latour', 'wine-ce-latour-hint-only'],
      ]),
      existingFamilyTargetRegistryRows: [],
      existingPolicyFamilyDecisionRegistryRows: [],
      exactSafeRegistryRows: [],
      knownEntityIds: new Set(['wine-ce-petrus', 'wine-ce-latour', 'wine-ce-silver-oak']),
      policyConflictOwners: new Map([
        ['latour', {
          surface: '라뚜르',
          locale: 'ko',
          stretchExpectedStatus: 'ambiguous',
          authorityStatus: 'resolved',
          authorityEntityId: 'wine-ce-latour',
          conflictType: 'short_form_collision',
          conflictBenchmarkHints: ['latour'],
          sourceEvidence: 'seed',
          reviewedAt: '2026-06-06T00:00:00.000Z',
        }],
      ]),
      runtimeOwnerEvidence: {
        uniqueOwners: new Map([[normalizeForMatch('silver oak'), 'wine-ce-silver-oak']]),
        collidingOwners: new Map(),
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map(),
        entityLabels: new Map([['wine-ce-silver-oak', 'Silver Oak Cabernet Sauvignon']]),
      },
    });

    expect(summary.baseline.draft).toEqual({
      rows: 3,
      autoTargetable: 0,
      policyReview: 1,
      manualTarget: 2,
    });
    expect(summary.overlay.draft).toEqual({
      rows: 3,
      autoTargetable: 2,
      policyReview: 0,
      manualTarget: 1,
    });
    expect(summary.familyTargetRegistryApply.registryInsertedRows).toBe(1);
    expect(summary.policyFamilyDecisionRegistryApply.registryInsertedRows).toBe(1);
    expect(summary.deltas).toEqual({
      draftAutoTargetable: 2,
      draftPolicyReview: -1,
      draftManualTarget: -1,
      exactSafePacketRows: 2,
      reviewedAuthorityApprovedRows: 1,
      policyReviewRows: -1,
      policyFamilyReviewRows: -1,
      manualTargetFamilyReviewRows: -1,
    });
    expect(summary.invariants).toEqual({
      autoTargetableNonDecreasing: true,
      policyReviewNonIncreasing: true,
      manualTargetNonIncreasing: true,
      exactSafePacketNonDecreasing: true,
      reviewedAuthorityApprovedNonDecreasing: true,
      policyPacketNonIncreasing: true,
      policyFamilyPacketNonIncreasing: true,
      manualTargetFamilyPacketNonIncreasing: true,
    });
    expect(existsSync(summary.outputSummaryPath)).toBe(true);
  });

  it('supports baseline registry snapshots that differ from the current overlay registries', async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), 'elv2-reviewed-registry-overlay-baseline-'));
    tempDirs.push(workDir);

    const tasks: readonly CurationTask[] = [
      {
        surfaceForm: '슈발 블랑 2010',
        holeClass: 'realworld_exact_vintage',
        observedStatus: 'failed',
        suggestedAliasType: 'canonical',
        status: 'needs_target',
        benchmarkGoldHint: 'cheval blanc',
        reason: 'coverage hole cheval blanc',
      },
    ];

    const summary = await verifyLookupV2StretchReviewedRegistryOverlay({
      tasks,
      inputArtifact: '/tmp/sample-entity-no-policy-cheval.json',
      generatedAt: '2026-06-06T04:00:00.000Z',
      workDir,
      outputSummaryPath: path.join(workDir, 'summary.json'),
      benchmarkGoldHintMap: new Map(),
      baselineFamilyTargetRegistryRows: [],
      existingFamilyTargetRegistryRows: [
        {
          benchmarkGoldHint: 'cheval blanc',
          normalizedBenchmarkGoldHint: 'cheval blanc',
          entityId: 'wine-ce-cheval-blanc',
          decisionStatus: 'approved',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-06T03:55:00.000Z',
          decisionReason: 'approved cheval blanc family target',
          evidenceClass: 'manual_target_family_review',
        },
      ],
      baselinePolicyFamilyDecisionRegistryRows: [],
      existingPolicyFamilyDecisionRegistryRows: [],
      exactSafeRegistryRows: [],
      knownEntityIds: new Set(['wine-ce-cheval-blanc']),
      policyConflictOwners: new Map(),
      runtimeOwnerEvidence: {
        uniqueOwners: new Map(),
        collidingOwners: new Map(),
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map(),
        entityLabels: new Map(),
      },
    });

    expect(summary.baseline.draft).toEqual({
      rows: 1,
      autoTargetable: 0,
      policyReview: 0,
      manualTarget: 1,
    });
    expect(summary.overlay.draft).toEqual({
      rows: 1,
      autoTargetable: 1,
      policyReview: 0,
      manualTarget: 0,
    });
    expect(summary.deltas).toEqual({
      draftAutoTargetable: 1,
      draftPolicyReview: 0,
      draftManualTarget: -1,
      exactSafePacketRows: 1,
      reviewedAuthorityApprovedRows: 0,
      policyReviewRows: 0,
      policyFamilyReviewRows: 0,
      manualTargetFamilyReviewRows: -1,
    });
  });
});
