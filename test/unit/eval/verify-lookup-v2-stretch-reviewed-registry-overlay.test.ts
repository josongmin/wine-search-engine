import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { CurationTask } from '../../../src/domain/alias/curation/coverage-curation-task.js';
import { normalizeForMatch } from '../../../src/domain/alias/service/normalize.js';
import { verifyLookupV2StretchReviewedRegistryOverlay } from '../../../scripts/eval/verify-lookup-v2-stretch-reviewed-registry-overlay.js';

const OVERLAY_REFRESH_TIMEOUT_MS = 120_000;

describe('verifyLookupV2StretchReviewedRegistryOverlay', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  }, OVERLAY_REFRESH_TIMEOUT_MS);

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
          semanticScopeKey: 'family::petrus::::::::::compact::ko',
          scopeAxis: 'family',
          familyKey: 'petrus',
          surfaceFormKind: 'compact',
          reviewScopeKey: 'petrus::translation::realworld_frenchish_korean_gap',
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          benchmarkGoldHintVariants: ['petrus'],
          proposalStatus: 'target_assigned',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_frenchish_korean_gap',
          scopeSuggestedAliasType: 'translation',
          scopeRisk: 'family_only',
          locales: ['ko'],
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
          semanticConflictKey: 'line::latour::::::::2009::qualified::ko',
          policyConflictSurface: '라뚜르',
          locale: 'ko',
          policyConflictType: 'short_form_collision',
          authorityStatus: 'resolved',
          stretchExpectedStatus: 'ambiguous',
          benchmarkGoldEntityId: 'wine-ce-latour',
          benchmarkGoldEntityIdSources: ['policy_registry_authority'],
          proposalStatus: 'approved_exact_safe',
          reviewTarget: 'lookup_semantic_policy_registry_v1',
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
      runtimeDescriptorMap: new Map([
        ['wine-ce-petrus', { familyKey: 'petrus' }],
      ]),
      approvedScopeSurfaceMap: new Map(),
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
        entityProducers: new Map([['wine-ce-silver-oak', 'Silver Oak']]),
        entityRegions: new Map([['wine-ce-silver-oak', 'United States']]),
        entityAppellations: new Map([['wine-ce-silver-oak', 'Napa Valley']]),
      },
    });

    expect(summary.baseline.draft).toEqual({
      rows: 3,
      autoTargetable: 0,
      localizedSurfaceReview: 0,
      catalogSupportReview: 0,
      reviewedCollision: 0,
      scopePolicyReview: 1,
      reviewedRejected: 0,
      scopeTargetReview: 2,
    });
    expect(summary.overlay.draft).toEqual({
      rows: 3,
      autoTargetable: 2,
      localizedSurfaceReview: 0,
      catalogSupportReview: 0,
      reviewedCollision: 0,
      scopePolicyReview: 0,
      reviewedRejected: 0,
      scopeTargetReview: 1,
    });
    expect(summary.semanticScopeTargetRegistryApply.registryInsertedRows).toBe(1);
    expect(summary.semanticPolicyRegistryApply.registryInsertedRows).toBe(1);
    expect(summary.deltas).toEqual({
      draftAutoTargetable: 2,
      draftCatalogSupportReview: 0,
      draftReviewedCollision: 0,
      draftScopePolicyReview: -1,
      draftScopeTargetReview: -1,
      exactSafePacketRows: 2,
      reviewedAuthorityApprovedRows: 2,
      policyReviewRows: -1,
      policyFamilyReviewRows: -1,
      manualTargetFamilyReviewRows: -1,
    });
    expect(summary.invariants).toEqual({
      autoTargetableNonDecreasing: true,
      catalogSupportReviewNonDecreasing: true,
      reviewedCollisionDirectionRespected: true,
      scopePolicyReviewNonIncreasing: true,
      scopeTargetReviewNonIncreasing: true,
      exactSafePacketNonDecreasing: true,
      reviewedAuthorityApprovedNonDecreasing: true,
      policyPacketNonIncreasing: true,
      policyFamilyPacketNonIncreasing: true,
      manualTargetFamilyPacketNonIncreasing: true,
    });
    expect(existsSync(summary.outputSummaryPath)).toBe(true);
  }, OVERLAY_REFRESH_TIMEOUT_MS);

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
          semanticScopeKey: 'line::cheval blanc::::::::2010::qualified::ko',
          benchmarkGoldHint: 'cheval blanc',
          normalizedBenchmarkGoldHint: 'cheval blanc',
          scopeAxis: 'line',
          familyKey: 'cheval blanc',
          vintage: 2010,
          surfaceFormKind: 'qualified',
          locale: 'ko',
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
      runtimeDescriptorMap: new Map(),
      approvedScopeSurfaceMap: new Map(),
      policyConflictOwners: new Map(),
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
    });

    expect(summary.baseline.draft).toEqual({
      rows: 1,
      autoTargetable: 0,
      localizedSurfaceReview: 0,
      catalogSupportReview: 0,
      reviewedCollision: 0,
      scopePolicyReview: 0,
      reviewedRejected: 0,
      scopeTargetReview: 1,
    });
    expect(summary.overlay.draft).toEqual({
      rows: 1,
      autoTargetable: 1,
      localizedSurfaceReview: 0,
      catalogSupportReview: 0,
      reviewedCollision: 0,
      scopePolicyReview: 0,
      reviewedRejected: 0,
      scopeTargetReview: 0,
    });
    expect(summary.deltas).toEqual({
      draftAutoTargetable: 1,
      draftCatalogSupportReview: 0,
      draftReviewedCollision: 0,
      draftScopePolicyReview: 0,
      draftScopeTargetReview: -1,
      exactSafePacketRows: 1,
      reviewedAuthorityApprovedRows: 1,
      policyReviewRows: 0,
      policyFamilyReviewRows: 0,
      manualTargetFamilyReviewRows: -1,
    });
  }, OVERLAY_REFRESH_TIMEOUT_MS);

  it('proves semantic scope support registry moves reviewed support gaps out of scope_target_review into catalog_support_review', async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), 'elv2-reviewed-registry-overlay-support-'));
    tempDirs.push(workDir);

    const tasks: readonly CurationTask[] = [
      {
        surfaceForm: '살롱 샴페인',
        holeClass: 'realworld_brand_suffix',
        observedStatus: 'failed',
        suggestedAliasType: 'canonical',
        status: 'needs_target',
        benchmarkGoldHint: 'salon',
        reason: 'coverage hole salon',
      },
    ];

    const summary = await verifyLookupV2StretchReviewedRegistryOverlay({
      tasks,
      inputArtifact: '/tmp/sample-entity-no-policy-salon.json',
      generatedAt: '2026-06-07T01:00:00.000Z',
      workDir,
      outputSummaryPath: path.join(workDir, 'summary.json'),
      benchmarkGoldHintMap: new Map(),
      baselineFamilyTargetRegistryRows: [],
      baselinePolicyFamilyDecisionRegistryRows: [],
      baselineSemanticScopeSupportRegistryRows: [],
      existingFamilyTargetRegistryRows: [],
      existingPolicyFamilyDecisionRegistryRows: [],
      existingSemanticScopeSupportRegistryRows: [
        {
          semanticScopeKey: 'family::salon::::::::::bare::ko',
          supportStatus: 'active_entity_absent',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T00:05:00.000Z',
          decisionReason: 'active runtime projection lacks reviewed Salon family support',
          evidenceClass: 'scope_support_review',
        },
      ],
      exactSafeRegistryRows: [],
      knownEntityIds: new Set(),
      runtimeDescriptorMap: new Map(),
      approvedScopeSurfaceMap: new Map(),
      policyConflictOwners: new Map(),
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
    });

    expect(summary.baseline.draft).toEqual({
      rows: 1,
      autoTargetable: 0,
      localizedSurfaceReview: 0,
      catalogSupportReview: 0,
      reviewedCollision: 0,
      scopePolicyReview: 0,
      reviewedRejected: 0,
      scopeTargetReview: 1,
    });
    expect(summary.overlay.draft).toEqual({
      rows: 1,
      autoTargetable: 0,
      localizedSurfaceReview: 0,
      catalogSupportReview: 1,
      reviewedCollision: 0,
      scopePolicyReview: 0,
      reviewedRejected: 0,
      scopeTargetReview: 0,
    });
    expect(summary.deltas).toEqual({
      draftAutoTargetable: 0,
      draftCatalogSupportReview: 1,
      draftReviewedCollision: 0,
      draftScopePolicyReview: 0,
      draftScopeTargetReview: -1,
      exactSafePacketRows: 0,
      reviewedAuthorityApprovedRows: 0,
      policyReviewRows: 0,
      policyFamilyReviewRows: 0,
      manualTargetFamilyReviewRows: -1,
    });
    expect(summary.invariants).toEqual({
      autoTargetableNonDecreasing: true,
      catalogSupportReviewNonDecreasing: true,
      reviewedCollisionDirectionRespected: true,
      scopePolicyReviewNonIncreasing: true,
      scopeTargetReviewNonIncreasing: true,
      exactSafePacketNonDecreasing: true,
      reviewedAuthorityApprovedNonDecreasing: true,
      policyPacketNonIncreasing: true,
      policyFamilyPacketNonIncreasing: true,
      manualTargetFamilyPacketNonIncreasing: true,
    });
  }, OVERLAY_REFRESH_TIMEOUT_MS);

  it('proves family collision registry moves active collision families out of manual_target into reviewed_collision', async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), 'elv2-reviewed-registry-overlay-collision-'));
    tempDirs.push(workDir);

    const tasks: readonly CurationTask[] = [
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
      inputArtifact: '/tmp/sample-entity-no-policy-silver-oak.json',
      generatedAt: '2026-06-07T01:30:00.000Z',
      workDir,
      outputSummaryPath: path.join(workDir, 'summary.json'),
      benchmarkGoldHintMap: new Map(),
      baselineFamilyTargetRegistryRows: [],
      baselinePolicyFamilyDecisionRegistryRows: [],
      baselineSemanticScopeSupportRegistryRows: [],
      baselineFamilyCollisionRegistryRows: [],
      existingFamilyTargetRegistryRows: [],
      existingPolicyFamilyDecisionRegistryRows: [],
      existingSemanticScopeSupportRegistryRows: [],
      existingFamilyCollisionRegistryRows: [
        {
          benchmarkGoldHint: 'silver oak',
          normalizedBenchmarkGoldHint: 'silver oak',
          collisionStatus: 'active_entity_collision',
          reviewedBy: 'codex',
          reviewedAt: '2026-06-07T01:20:00.000Z',
          decisionReason: 'active runtime exposes Napa and Alexander Valley owners',
          evidenceClass: 'collision_support_review',
        },
      ],
      exactSafeRegistryRows: [],
      knownEntityIds: new Set(),
      runtimeDescriptorMap: new Map(),
      approvedScopeSurfaceMap: new Map(),
      policyConflictOwners: new Map(),
      runtimeOwnerEvidence: {
        uniqueOwners: new Map(),
        collidingOwners: new Map([
          [normalizeForMatch('silver oak'), ['wine-a', 'wine-b']],
        ]),
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map([
          [normalizeForMatch('silver oak'), [
            { entityId: 'wine-a', witnessSurface: 'Silver Oak', witnessSource: 'producer' },
            { entityId: 'wine-b', witnessSurface: 'Silver Oak', witnessSource: 'producer' },
          ]],
        ]),
        entityLabels: new Map([
          ['wine-a', 'Silver Oak Alexander Valley Cabernet Sauvignon'],
          ['wine-b', 'Silver Oak Napa Valley Cabernet Sauvignon'],
        ]),
        entityProducers: new Map([
          ['wine-a', 'Silver Oak'],
          ['wine-b', 'Silver Oak'],
        ]),
        entityRegions: new Map([
          ['wine-a', 'United States'],
          ['wine-b', 'United States'],
        ]),
        entityAppellations: new Map([
          ['wine-a', 'Alexander Valley'],
          ['wine-b', 'Napa Valley'],
        ]),
      },
    });

    expect(summary.baseline.draft).toEqual({
      rows: 1,
      autoTargetable: 0,
      localizedSurfaceReview: 0,
      catalogSupportReview: 0,
      reviewedCollision: 0,
      scopePolicyReview: 0,
      reviewedRejected: 0,
      scopeTargetReview: 1,
    });
    expect(summary.overlay.draft).toEqual({
      rows: 1,
      autoTargetable: 0,
      localizedSurfaceReview: 0,
      catalogSupportReview: 0,
      reviewedCollision: 1,
      scopePolicyReview: 0,
      reviewedRejected: 0,
      scopeTargetReview: 0,
    });
    expect(summary.deltas).toEqual({
      draftAutoTargetable: 0,
      draftCatalogSupportReview: 0,
      draftReviewedCollision: 1,
      draftScopePolicyReview: 0,
      draftScopeTargetReview: -1,
      exactSafePacketRows: 0,
      reviewedAuthorityApprovedRows: 0,
      policyReviewRows: 0,
      policyFamilyReviewRows: 0,
      manualTargetFamilyReviewRows: -1,
    });
    expect(summary.invariants).toEqual({
      autoTargetableNonDecreasing: true,
      catalogSupportReviewNonDecreasing: true,
      reviewedCollisionDirectionRespected: true,
      scopePolicyReviewNonIncreasing: true,
      scopeTargetReviewNonIncreasing: true,
      exactSafePacketNonDecreasing: true,
      reviewedAuthorityApprovedNonDecreasing: true,
      policyPacketNonIncreasing: true,
      policyFamilyPacketNonIncreasing: true,
      manualTargetFamilyPacketNonIncreasing: true,
    });
  }, OVERLAY_REFRESH_TIMEOUT_MS);
});
