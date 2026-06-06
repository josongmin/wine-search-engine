import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { CurationTask } from '../../../src/domain/alias/curation/coverage-curation-task.js';
import { normalizeForMatch } from '../../../src/domain/alias/service/normalize.js';
import { refreshLookupV2StretchWritePlaneArtifacts } from '../../../scripts/eval/refresh-lookup-v2-stretch-write-plane.js';

describe('refreshLookupV2StretchWritePlaneArtifacts', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds derived write-plane artifacts from reviewed registries', async () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'elv2-stretch-refresh-'));
    tempDirs.push(outputDir);

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

    const summary = await refreshLookupV2StretchWritePlaneArtifacts({
      tasks,
      inputArtifact: '/tmp/sample-entity-no-policy.json',
      generatedAt: '2026-06-06T02:00:00.000Z',
      outputDir,
      benchmarkGoldHintMap: new Map([
        ['petrus', 'wine-ce-petrus-hint-only'],
        ['latour', 'wine-ce-latour-hint-only'],
      ]),
      familyTargetApprovedMap: new Map([
        ['family::petrus::::::::::compact::ko', {
          semanticScopeKey: 'family::petrus::::::::::compact::ko',
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
          scopeAxis: 'family',
          familyKey: 'petrus',
          surfaceFormKind: 'compact',
          locale: 'ko',
          entityId: 'wine-ce-petrus',
          decisionStatus: 'approved',
          reviewedBy: 'registry',
          reviewedAt: '2026-06-06T01:00:00.000Z',
          decisionReason: 'approved petrus family target',
          evidenceClass: 'fixture_exact',
        }],
      ]),
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
      policyFamilyDecisionMap: new Map([
        ['line::latour::::::::2009::qualified::ko::wine-ce-latour', {
          semanticConflictKey: 'line::latour::::::::2009::qualified::ko',
          conflictClass: 'short_form_collision',
          entityId: 'wine-ce-latour',
          decision: 'promote_exact_safe',
          reviewedBy: 'registry',
          reviewedAt: '2026-06-06T01:30:00.000Z',
          decisionReason: 'approved latour family decision',
        }],
      ]),
      familySupportRegistryMap: new Map([
        ['salon', {
          benchmarkGoldHint: 'salon',
          normalizedBenchmarkGoldHint: 'salon',
          supportStatus: 'active_catalog_absent',
          reviewedBy: 'registry',
          reviewedAt: '2026-06-06T01:40:00.000Z',
          decisionReason: 'active catalog lacks reviewed Salon family support',
          evidenceClass: 'catalog_support_review',
        }],
      ]),
      familyCollisionRegistryMap: new Map([
        ['silver oak', {
          benchmarkGoldHint: 'silver oak',
          normalizedBenchmarkGoldHint: 'silver oak',
          collisionStatus: 'active_entity_collision',
          reviewedBy: 'registry',
          reviewedAt: '2026-06-06T01:45:00.000Z',
          decisionReason: 'active runtime exposes multiple reviewed Silver Oak owners',
          evidenceClass: 'collision_support_review',
        }],
      ]),
      exactSafeRegistryRows: [],
      exactSafeScopeRegistryMap: new Map([
        ['wine-ce-petrus::translation::realworld_frenchish_korean_gap', {
          reviewScopeKey: 'wine-ce-petrus::translation::realworld_frenchish_korean_gap',
          entityId: 'wine-ce-petrus',
          scopeHoleClass: 'realworld_frenchish_korean_gap',
          scopeSuggestedAliasType: 'translation',
          decisionStatus: 'rejected',
          reviewedBy: 'registry',
          reviewedAt: '2026-06-06T02:30:00.000Z',
          decisionReason: 'reviewed exact-safe reject',
          evidenceClass: 'exact_safe_family_review',
        }],
      ]),
      runtimeOwnerEvidence: {
        uniqueOwners: new Map(),
        collidingOwners: new Map([[normalizeForMatch('silver oak'), ['wine-ce-silver-oak-av', 'wine-ce-silver-oak-nv']]]),
        entityProducers: new Map([
          ['wine-ce-silver-oak-av', 'Silver Oak'],
          ['wine-ce-silver-oak-nv', 'Silver Oak'],
        ]),
        entityRegions: new Map([
          ['wine-ce-silver-oak-av', 'United States'],
          ['wine-ce-silver-oak-nv', 'United States'],
        ]),
        entityAppellations: new Map([
          ['wine-ce-silver-oak-av', 'Alexander Valley'],
          ['wine-ce-silver-oak-nv', 'Napa Valley'],
        ]),
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map([[normalizeForMatch('silver oak'), [
          { entityId: 'wine-ce-silver-oak-av', witnessSurface: 'Silver Oak', witnessSource: 'producer' },
          { entityId: 'wine-ce-silver-oak-nv', witnessSurface: 'Silver Oak', witnessSource: 'producer' },
        ]]]),
        entityLabels: new Map([
          ['wine-ce-silver-oak-av', 'Silver Oak Alexander Valley Cabernet Sauvignon'],
          ['wine-ce-silver-oak-nv', 'Silver Oak Napa Valley Cabernet Sauvignon'],
        ]),
      },
    });

    expect(summary.draft).toEqual({
      rows: 4,
      autoTargetable: 2,
      scopePolicyReview: 0,
      reviewedRejected: 0,
      catalogAbsent: 1,
      reviewedScopeCollision: 1,
      scopeTargetReview: 0,
    });
    expect(summary.exactSafe.packetRows).toBe(2);
    expect(summary.exactSafe.bySource).toEqual({
      semantic_policy_registry: 1,
      semantic_scope_target_registry: 1,
    });
    expect(summary.exactSafe.reviewedAuthorityApprovedRows).toBe(2);
    expect(summary.exactSafe.reviewedAuthorityPendingRows).toBe(0);
    expect(summary.exactSafe.scopeReviewedRowPacketRows).toBe(2);
    expect(summary.exactSafe.familyApprovedRows).toBe(0);
    expect(summary.exactSafe.familyRejectedRows).toBe(1);
    expect(summary.exactSafe.familyPendingRows).toBe(1);
    expect(summary.policy.reviewRows).toBe(0);
    expect(summary.policy.familyReviewRows).toBe(0);
    expect(summary.manualTarget.batchIndex.totalRows).toBe(0);
    expect(summary.manualTarget.ownerEvidenceIndex.totalRows).toBe(0);
    expect(summary.manualTarget.ownerEvidenceFamilyIndex.totalFamilies).toBe(0);
    expect(summary.manualTarget.ownerEvidenceFamilyIndex.candidateUniqueOwnerFamilies).toBe(0);
    expect(summary.manualTarget.ownerEvidenceIndex.candidateUniqueOwnerRows).toBe(0);
    expect(summary.manualTarget.familyReviewRows).toBe(0);
    expect(summary.catalogAbsent.familyClusterIndex.totalRows).toBe(1);
    expect(summary.catalogAbsent.familyClusterIndex.totalFamilies).toBe(1);
    expect(summary.reviewedCollision.familyClusterIndex.totalRows).toBe(1);
    expect(summary.reviewedCollision.familyClusterIndex.totalFamilies).toBe(1);
    expect(summary.reviewedCollision.familyReviewRows).toBe(1);
    expect(summary.manualTarget.suggestions).toEqual({
      candidateUniqueOwner: 0,
      collisionCandidates: 0,
      missingRuntimeOwner: 0,
    });

    expect(existsSync(summary.outputPaths.summary)).toBe(true);
    expect(existsSync(summary.outputPaths.reviewedAuthorityApprovedExactSafePacket)).toBe(true);
    expect(existsSync(summary.outputPaths.reviewedScopeExactSafePacket)).toBe(true);
    expect(existsSync(summary.outputPaths.reviewedCollisionFamilyReviewPacket)).toBe(true);

    const reviewedAuthorityRows = readFileSync(
      summary.outputPaths.reviewedAuthorityApprovedExactSafePacket,
      'utf8',
    )
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as {
        surface: string;
        proposalStatus: string;
        benchmarkGoldEntityIdSource: string;
      });

    expect(reviewedAuthorityRows).toHaveLength(2);
    expect(reviewedAuthorityRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: '페트뤼스',
          proposalStatus: 'approved',
          benchmarkGoldEntityIdSource: 'semantic_scope_target_registry',
        }),
        expect.objectContaining({
          surface: '라뚜르 2009',
          proposalStatus: 'approved',
          benchmarkGoldEntityIdSource: 'semantic_policy_registry',
        }),
      ]),
    );

    const reviewedScopeRows = readFileSync(
      summary.outputPaths.reviewedScopeExactSafePacket,
      'utf8',
    )
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as {
        surface: string;
        proposalStatus: string;
      });

    expect(reviewedScopeRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          surface: '페트뤼스',
          proposalStatus: 'rejected',
        }),
        expect.objectContaining({
          surface: '라뚜르 2009',
          proposalStatus: 'needs_review',
        }),
      ]),
    );
  }, 30_000);
});
