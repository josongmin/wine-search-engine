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
        ['petrus', {
          benchmarkGoldHint: 'petrus',
          normalizedBenchmarkGoldHint: 'petrus',
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
        ['라뚜르::wine-ce-latour', {
          policyConflictSurface: '라뚜르',
          entityId: 'wine-ce-latour',
          decision: 'promote_exact_safe',
          reviewedBy: 'registry',
          reviewedAt: '2026-06-06T01:30:00.000Z',
          decisionReason: 'approved latour family decision',
        }],
      ]),
      exactSafeRegistryRows: [],
      runtimeOwnerEvidence: {
        uniqueOwners: new Map([[normalizeForMatch('silver oak'), 'wine-ce-silver-oak']]),
        collidingOwners: new Map(),
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map(),
        entityLabels: new Map([['wine-ce-silver-oak', 'Silver Oak Cabernet Sauvignon']]),
      },
    });

    expect(summary.draft).toEqual({
      rows: 3,
      autoTargetable: 2,
      policyReview: 0,
      manualTarget: 1,
    });
    expect(summary.exactSafe.packetRows).toBe(2);
    expect(summary.exactSafe.bySource).toEqual({
      family_target_registry: 1,
      policy_family_decision_registry: 1,
    });
    expect(summary.exactSafe.approvedRows).toBe(1);
    expect(summary.exactSafe.pendingRows).toBe(1);
    expect(summary.policy.reviewRows).toBe(0);
    expect(summary.policy.familyReviewRows).toBe(0);
    expect(summary.manualTarget.batchIndex.totalRows).toBe(1);
    expect(summary.manualTarget.familyReviewRows).toBe(1);
    expect(summary.manualTarget.suggestions).toEqual({
      candidateUniqueOwner: 1,
      collisionCandidates: 0,
      missingRuntimeOwner: 0,
    });

    expect(existsSync(summary.outputPaths.summary)).toBe(true);
    expect(existsSync(summary.outputPaths.reviewedAuthorityApprovedExactSafePacket)).toBe(true);

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
          proposalStatus: 'needs_review',
          benchmarkGoldEntityIdSource: 'family_target_registry',
        }),
        expect.objectContaining({
          surface: '라뚜르 2009',
          proposalStatus: 'approved',
          benchmarkGoldEntityIdSource: 'policy_family_decision_registry',
        }),
      ]),
    );
  });
});
