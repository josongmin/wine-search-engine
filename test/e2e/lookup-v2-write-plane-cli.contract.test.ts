import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { buildLookupSemanticConflictKey } from '../../src/domain/resolver/v2/lookup-semantic-scope.js';
import { buildLookupV2ExactSafeReviewScopeKey } from '../../scripts/eval/export-lookup-v2-exact-safe-family-review-packet.js';
import { loadLookupPolicyConflictBenchmarkHintOwnerMapSync } from '../../scripts/eval/lookup-v2-policy-conflict-registry.js';
import { loadLookupV2SemanticScopeTargetApprovedMapSync } from '../../scripts/eval/lookup-v2-semantic-scope-target-registry.js';

const STRETCH_WRITE_PLANE_CONTRACT_TIMEOUT_MS = 120_000;

function writeJsonl(filePath: string, rows: readonly unknown[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''),
    'utf8',
  );
}

function runEvalScript(scriptPath: string, args: readonly string[]): string {
  return execFileSync(
    'node',
    ['--import', 'tsx', scriptPath, ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
    },
  );
}

describe('lookup-v2 write-plane CLI contracts', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('export-lookup-v2-curation-drafts keeps reviewed policy-owned scope holes visible at the process boundary', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elv2-draft-cli-'));
    tempDirs.push(dir);

    const latourOwner = loadLookupPolicyConflictBenchmarkHintOwnerMapSync().get(normalizeForMatch('latour'));
    expect(latourOwner).toBeDefined();

    const inputPath = path.join(dir, 'coverage.json');
    const outputPath = path.join(dir, 'draft.jsonl');
    const policyConflictRegistryPath = path.join(dir, 'lookup-policy-conflict-registry.jsonl');
    const semanticPolicyRegistryPath = path.join(dir, 'lookup-semantic-policy-registry.jsonl');
    const semanticScopeTargetRegistryPath = path.join(dir, 'lookup-semantic-scope-target-registry.jsonl');
    const semanticScopeSupportRegistryPath = path.join(dir, 'lookup-semantic-scope-support-registry.jsonl');
    const familyCollisionRegistryPath = path.join(dir, 'lookup-family-collision-registry.jsonl');
    const localizedScopeSurfaceRegistryPath = path.join(dir, 'lookup-localized-scope-surface-registry.jsonl');

    writeFileSync(inputPath, JSON.stringify({
      generatedAt: '2026-06-09T00:00:00.000Z',
      curationTasks: [
        {
          surfaceForm: '라뚜르 2009',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'latour',
          operatorBucket: 'scope_target_missing',
          reason: 'process-boundary keep_ambiguous contract',
        },
        {
          surfaceForm: '라뚜르 2014',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'latour',
          operatorBucket: 'scope_target_missing',
          reason: 'process-boundary needs_scope_target contract',
        },
      ],
    }, null, 2) + '\n', 'utf8');

    writeJsonl(policyConflictRegistryPath, [{
      surface: '라뚜르',
      locale: 'ko',
      stretchExpectedStatus: 'ambiguous',
      authorityStatus: 'resolved',
      authorityEntityId: latourOwner!.authorityEntityId,
      conflictType: latourOwner!.conflictType,
      conflictBenchmarkHints: ['latour'],
      sourceEvidence: 'e2e fixture',
      reviewedAt: '2026-06-09T00:00:00.000Z',
    }]);
    writeJsonl(semanticPolicyRegistryPath, [
      {
        semanticConflictKey: 'line::latour::::::::2009::qualified::ko',
        conflictClass: 'short_form_collision',
        entityId: latourOwner!.authorityEntityId,
        decision: 'keep_ambiguous',
        reviewedBy: 'e2e',
        reviewedAt: '2026-06-09T00:00:00.000Z',
        decisionReason: 'reviewed ambiguity must stay visible in draft output',
      },
      {
        semanticConflictKey: 'line::latour::::::::2014::qualified::ko',
        conflictClass: 'short_form_collision',
        entityId: latourOwner!.authorityEntityId,
        decision: 'needs_scope_target',
        reviewedBy: 'e2e',
        reviewedAt: '2026-06-09T00:00:00.000Z',
        decisionReason: 'reviewed scope-target requirement must stay visible in draft output',
      },
    ]);
    writeFileSync(semanticScopeTargetRegistryPath, '', 'utf8');
    writeFileSync(semanticScopeSupportRegistryPath, '', 'utf8');
    writeFileSync(familyCollisionRegistryPath, '', 'utf8');
    writeFileSync(localizedScopeSurfaceRegistryPath, '', 'utf8');

    const stdout = runEvalScript(
      'scripts/eval/export-lookup-v2-curation-drafts.ts',
      [
        '--input', inputPath,
        '--output', outputPath,
        '--policyConflictRegistry', policyConflictRegistryPath,
        '--semanticPolicyRegistry', semanticPolicyRegistryPath,
        '--semanticScopeTargetRegistry', semanticScopeTargetRegistryPath,
        '--semanticScopeSupportRegistry', semanticScopeSupportRegistryPath,
        '--familyCollisionRegistry', familyCollisionRegistryPath,
        '--localizedScopeSurfaceRegistry', localizedScopeSurfaceRegistryPath,
      ],
    );

    expect(stdout).toContain('[elv2-curation-draft] rows=2');
    const rows = readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { surface: string; triageBucket: string; semanticConflictKey?: string });

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surface: '라뚜르 2009',
        triageBucket: 'reviewed_rejected',
        semanticConflictKey: 'line::latour::::::::2009::qualified::ko',
      }),
      expect.objectContaining({
        surface: '라뚜르 2014',
        triageBucket: 'scope_target_review',
        semanticConflictKey: 'line::latour::::::::2014::qualified::ko',
      }),
    ]));
  });

  it('export-lookup-v2-stretch-owner-dispatch-manifest resolves subordinate defaults from outputDir at the process boundary', () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'elv2-owner-dispatch-cli-e2e-'));
    tempDirs.push(outputDir);

    const runtimeGapDir = path.join(outputDir, 'manual-target-owner-evidence', 'missing-runtime-owner-families-by-gap-reason');
    const reviewedCollisionDir = path.join(outputDir, 'lookup-v2-korean-realworld-stretch-reviewed-collision-family-clusters-by-clarification-axis');
    mkdirSync(runtimeGapDir, { recursive: true });
    mkdirSync(reviewedCollisionDir, { recursive: true });

    writeFileSync(
      path.join(runtimeGapDir, 'gap-reason-index.json'),
      JSON.stringify({
        gapReasonSignatureCounts: {
          requested_vintage_missing: 1,
        },
      }, null, 2) + '\n',
      'utf8',
    );
    writeJsonl(path.join(runtimeGapDir, 'requested-vintage-missing.jsonl'), [
      {
        benchmarkGoldHint: 'solaia',
        normalizedBenchmarkGoldHint: 'solaia',
        benchmarkGoldHintVariants: ['solaia'],
        runtimeEvidenceStatus: 'missing_runtime_owner',
        familyReviewRowCount: 1,
        reviewScopeKeys: ['line::solaia::::::::2016::qualified::ko'],
        scopeHoleClasses: ['realworld_exact_vintage'],
        scopeSuggestedAliasTypes: ['canonical'],
        scopeRisks: ['mixed_vintage_family'],
        locales: ['ko'],
        surfaces: ['솔라이아 2016'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/input.json'],
        sourceEvidenceSamples: ['hole'],
        runtimeGapReasons: ['requested_vintage_missing'],
        runtimeGapReasonSignature: 'requested_vintage_missing',
        runtimeGapAvailableVintages: [2018],
      },
    ]);
    writeFileSync(
      path.join(reviewedCollisionDir, 'clarification-axis-index.json'),
      JSON.stringify({ clarificationAxisCounts: {} }, null, 2) + '\n',
      'utf8',
    );
    writeFileSync(path.join(outputDir, 'manual-target-owner-evidence', 'collision-candidate-families.jsonl'), '', 'utf8');
    writeFileSync(path.join(outputDir, 'lookup-v2-korean-realworld-stretch-manual-target-family-review-packet.jsonl'), '', 'utf8');
    writeFileSync(path.join(outputDir, 'lookup-v2-korean-realworld-stretch-reviewed-collision-family-review-packet.jsonl'), '', 'utf8');

    const stdout = runEvalScript(
      'scripts/eval/export-lookup-v2-stretch-owner-dispatch-manifest.ts',
      [
        '--inputArtifact', '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json',
        '--outputDir', outputDir,
      ],
    );

    expect(stdout).toContain('[elv2-owner-dispatch] total_packets=1');
    const manifestPath = path.join(outputDir, 'lookup-v2-korean-realworld-stretch-owner-dispatch-manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      totalPackets: number;
      packets: Array<{ packetId: string; sourceJsonlPath: string }>;
    };
    expect(manifest.totalPackets).toBe(1);
    expect(manifest.packets[0]?.packetId).toBe('runtime-backfill-requested-vintage-missing');
    expect(manifest.packets[0]?.sourceJsonlPath).toBe(path.join(runtimeGapDir, 'requested-vintage-missing.jsonl'));
  });

  it('refresh, overlay verify, and owner-dispatch stay aligned for an isolated no-residue synthetic chain', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elv2-write-plane-chain-'));
    tempDirs.push(dir);

    const petrusScopeKey = 'family::petrus::::::::::compact::ko';
    const petrusApprovedScope = loadLookupV2SemanticScopeTargetApprovedMapSync().get(petrusScopeKey);
    expect(petrusApprovedScope).toBeDefined();

    const latourOwner = loadLookupPolicyConflictBenchmarkHintOwnerMapSync().get(normalizeForMatch('latour'));
    expect(latourOwner).toBeDefined();

    const inputPath = path.join(dir, 'coverage.json');
    const outputDir = path.join(dir, 'write-plane');
    const overlayWorkDir = path.join(dir, 'overlay-work');
    const overlaySummaryPath = path.join(dir, 'overlay-summary.json');
    const familyRegistryPath = path.join(dir, 'lookup-semantic-scope-target-registry.jsonl');
    const policyConflictRegistryPath = path.join(dir, 'lookup-policy-conflict-registry.jsonl');
    const policyRegistryPath = path.join(dir, 'lookup-semantic-policy-registry.jsonl');
    const semanticScopeSupportRegistryPath = path.join(dir, 'lookup-semantic-scope-support-registry.jsonl');
    const familyCollisionRegistryPath = path.join(dir, 'lookup-family-collision-registry.jsonl');
    const exactSafeRegistryPath = path.join(dir, 'korean-exact-safe-registry.jsonl');
    const exactSafeScopeRegistryPath = path.join(dir, 'lookup-exact-safe-scope-registry.jsonl');

    writeFileSync(inputPath, JSON.stringify({
      generatedAt: '2026-06-09T00:00:00.000Z',
      report: {
        hotEntityCount: 3,
        coveredCount: 0,
        holes: [
          { operatorBucket: 'scope_target_missing', observedReasonCode: 'semantic_scope_target_registry' },
          { operatorBucket: 'scope_target_missing', observedReasonCode: 'short_form_collision' },
          { operatorBucket: 'scope_target_missing', observedReasonCode: 'short_form_collision' },
        ],
      },
      curationTasks: [
        {
          surfaceForm: '페트뤼스',
          holeClass: 'realworld_frenchish_korean_gap',
          observedStatus: 'failed',
          suggestedAliasType: 'translation',
          status: 'needs_target',
          benchmarkGoldHint: 'petrus',
          operatorBucket: 'scope_target_missing',
          reason: 'synthetic process-boundary exact-safe authority closure',
        },
        {
          surfaceForm: '라뚜르 2009',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'ambiguous',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'latour',
          operatorBucket: 'scope_target_missing',
          reason: 'synthetic process-boundary reviewed ambiguity closure',
        },
        {
          surfaceForm: '라뚜르 2014',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'ambiguous',
          suggestedAliasType: 'canonical',
          status: 'needs_target',
          benchmarkGoldHint: 'latour',
          operatorBucket: 'scope_target_missing',
          reason: 'synthetic process-boundary reviewed ambiguity closure',
        },
      ],
    }, null, 2) + '\n', 'utf8');

    writeJsonl(familyRegistryPath, [petrusApprovedScope!]);
    writeJsonl(policyConflictRegistryPath, [{
      surface: latourOwner!.surface,
      locale: latourOwner!.locale,
      stretchExpectedStatus: latourOwner!.stretchExpectedStatus,
      authorityStatus: latourOwner!.authorityStatus,
      authorityEntityId: latourOwner!.authorityEntityId,
      conflictType: latourOwner!.conflictType,
      conflictBenchmarkHints: latourOwner!.conflictBenchmarkHints,
      sourceEvidence: 'e2e fixture',
      reviewedAt: '2026-06-09T00:00:00.000Z',
    }]);
    writeJsonl(policyRegistryPath, [
      {
        semanticConflictKey: buildLookupSemanticConflictKey({
          scopeAxis: 'line',
          familyKey: 'latour',
          vintage: 2009,
          surfaceFormKind: 'qualified',
          locale: 'ko',
        }),
        conflictClass: 'short_form_collision',
        entityId: latourOwner!.authorityEntityId,
        decision: 'keep_ambiguous',
        reviewedBy: 'e2e',
        reviewedAt: '2026-06-09T00:00:00.000Z',
        decisionReason: 'reviewed ambiguity must stay rejected for 2009',
      },
      {
        semanticConflictKey: buildLookupSemanticConflictKey({
          scopeAxis: 'line',
          familyKey: 'latour',
          vintage: 2014,
          surfaceFormKind: 'qualified',
          locale: 'ko',
        }),
        conflictClass: 'short_form_collision',
        entityId: latourOwner!.authorityEntityId,
        decision: 'keep_ambiguous',
        reviewedBy: 'e2e',
        reviewedAt: '2026-06-09T00:00:00.000Z',
        decisionReason: 'reviewed ambiguity must stay rejected for 2014',
      },
    ]);
    writeFileSync(semanticScopeSupportRegistryPath, '', 'utf8');
    writeFileSync(familyCollisionRegistryPath, '', 'utf8');
    writeFileSync(exactSafeRegistryPath, '', 'utf8');
    writeJsonl(exactSafeScopeRegistryPath, [{
      reviewScopeKey: buildLookupV2ExactSafeReviewScopeKey({
        entityId: petrusApprovedScope!.entityId!,
        holeClass: 'realworld_frenchish_korean_gap',
        suggestedAliasType: 'translation',
      }),
      entityId: petrusApprovedScope!.entityId!,
      scopeHoleClass: 'realworld_frenchish_korean_gap',
      scopeSuggestedAliasType: 'translation',
      decisionStatus: 'approved',
      reviewedBy: 'e2e',
      reviewedAt: '2026-06-09T00:00:00.000Z',
      decisionReason: 'close synthetic exact-safe family review in-process',
      evidenceClass: 'exact_safe_family_review',
    }]);

    const refreshStdout = runEvalScript(
      'scripts/eval/refresh-lookup-v2-stretch-write-plane.ts',
      [
        '--input', inputPath,
        '--outputDir', outputDir,
        '--semanticScopeTargetRegistry', familyRegistryPath,
        '--policyConflictRegistry', policyConflictRegistryPath,
        '--semanticPolicyRegistry', policyRegistryPath,
        '--semanticScopeSupportRegistry', semanticScopeSupportRegistryPath,
        '--familyCollisionRegistry', familyCollisionRegistryPath,
        '--exactSafeRegistry', exactSafeRegistryPath,
        '--exactSafeScopeRegistry', exactSafeScopeRegistryPath,
      ],
    );

    expect(refreshStdout).toContain('[elv2-stretch-write-plane-refresh] draft_rows=3');
    expect(refreshStdout).toContain('[elv2-stretch-write-plane-refresh] auto_targetable=1');
    expect(refreshStdout).toContain('[elv2-stretch-write-plane-refresh] scope_policy_review=0');
    expect(refreshStdout).toContain('[elv2-stretch-write-plane-refresh] reviewed_collision=0');
    expect(refreshStdout).toContain('[elv2-stretch-write-plane-refresh] scope_target_review=0');
    expect(refreshStdout).toContain('[elv2-stretch-write-plane-refresh] runtime_backfill_packets=0');
    expect(refreshStdout).toContain('[elv2-stretch-write-plane-refresh] reviewed_collision_scope_packets=0');

    const refreshSummaryPath = path.join(outputDir, 'lookup-v2-korean-realworld-stretch-write-plane-summary.json');
    expect(existsSync(refreshSummaryPath)).toBe(true);
    const refreshSummary = JSON.parse(readFileSync(refreshSummaryPath, 'utf8')) as {
      draft: {
        rows: number;
        autoTargetable: number;
        reviewedRejected: number;
        scopePolicyReview: number;
        scopeTargetReview: number;
      };
      exactSafe: {
        packetRows: number;
        reviewedAuthorityApprovedRows: number;
        familyApprovedRows: number;
        familyPendingRows: number;
      };
      remainingWork: {
        ownerDispatchPackets: number;
        ownerDispatchRows: number;
        exactSafePendingFamilyRows: number;
      };
      ownerDispatch: {
        manifest: {
          totalPackets: number;
        };
      };
    };

    expect(refreshSummary.draft).toEqual(expect.objectContaining({
      rows: 3,
      autoTargetable: 1,
      reviewedRejected: 2,
      scopePolicyReview: 0,
      scopeTargetReview: 0,
    }));
    expect(refreshSummary.exactSafe.packetRows).toBe(1);
    expect(refreshSummary.exactSafe.reviewedAuthorityApprovedRows).toBe(1);
    expect(refreshSummary.exactSafe.familyApprovedRows).toBe(1);
    expect(refreshSummary.exactSafe.familyPendingRows).toBe(0);
    expect(refreshSummary.remainingWork.ownerDispatchPackets).toBe(0);
    expect(refreshSummary.remainingWork.ownerDispatchRows).toBe(0);
    expect(refreshSummary.remainingWork.exactSafePendingFamilyRows).toBe(0);
    expect(refreshSummary.ownerDispatch.manifest.totalPackets).toBe(0);

    const overlayStdout = runEvalScript(
      'scripts/eval/verify-lookup-v2-stretch-reviewed-registry-overlay.ts',
      [
        '--input', inputPath,
        '--familyRegistry', familyRegistryPath,
        '--policyConflictRegistry', policyConflictRegistryPath,
        '--policyRegistry', policyRegistryPath,
        '--semanticScopeSupportRegistry', semanticScopeSupportRegistryPath,
        '--familyCollisionRegistry', familyCollisionRegistryPath,
        '--exactSafeRegistry', exactSafeRegistryPath,
        '--exactSafeScopeRegistry', exactSafeScopeRegistryPath,
        '--workDir', overlayWorkDir,
        '--output', overlaySummaryPath,
      ],
    );

    expect(overlayStdout).toContain('[elv2-reviewed-registry-overlay-verify] baseline_auto_targetable=1');
    expect(overlayStdout).toContain('[elv2-reviewed-registry-overlay-verify] overlay_auto_targetable=1');
    expect(overlayStdout).toContain('[elv2-reviewed-registry-overlay-verify] baseline_scope_policy_review=0');
    expect(overlayStdout).toContain('[elv2-reviewed-registry-overlay-verify] overlay_scope_policy_review=0');
    expect(overlayStdout).toContain('[elv2-reviewed-registry-overlay-verify] baseline_scope_target_review=0');
    expect(overlayStdout).toContain('[elv2-reviewed-registry-overlay-verify] overlay_scope_target_review=0');
    expect(overlayStdout).toContain('[elv2-reviewed-registry-overlay-verify] semantic_scope_registry_inserted=0');
    expect(overlayStdout).toContain('[elv2-reviewed-registry-overlay-verify] semantic_policy_registry_inserted=0');

    expect(existsSync(overlaySummaryPath)).toBe(true);
    const overlaySummary = JSON.parse(readFileSync(overlaySummaryPath, 'utf8')) as {
      deltas: {
        draftAutoTargetable: number;
        draftScopePolicyReview: number;
        draftScopeTargetReview: number;
        policyReviewRows: number;
        policyFamilyReviewRows: number;
        manualTargetFamilyReviewRows: number;
      };
      invariants: Record<string, boolean>;
    };
    expect(overlaySummary.deltas).toEqual({
      draftAutoTargetable: 0,
      draftCatalogSupportReview: 0,
      draftReviewedCollision: 0,
      draftScopePolicyReview: 0,
      draftScopeTargetReview: 0,
      exactSafePacketRows: 0,
      reviewedAuthorityApprovedRows: 0,
      policyReviewRows: 0,
      policyFamilyReviewRows: 0,
      manualTargetFamilyReviewRows: 0,
    });
    expect(Object.values(overlaySummary.invariants).every(Boolean)).toBe(true);

    const dispatchStdout = runEvalScript(
      'scripts/eval/export-lookup-v2-stretch-owner-dispatch-manifest.ts',
      [
        '--inputArtifact', inputPath,
        '--outputDir', outputDir,
      ],
    );

    expect(dispatchStdout).toContain('[elv2-owner-dispatch] total_packets=0');
    const manifestPath = path.join(outputDir, 'lookup-v2-korean-realworld-stretch-owner-dispatch-manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      totalPackets: number;
      packetClassCounts: Record<string, number>;
      packets: unknown[];
    };
    expect(manifest.totalPackets).toBe(0);
    expect(manifest.packetClassCounts).toEqual({
      runtime_backfill: 0,
      manual_target_collision: 0,
      reviewed_collision_scope: 0,
    });
    expect(manifest.packets).toEqual([]);
  }, STRETCH_WRITE_PLANE_CONTRACT_TIMEOUT_MS);
});
