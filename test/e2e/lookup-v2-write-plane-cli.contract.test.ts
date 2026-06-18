import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import {
  buildLookupSemanticConflictKey,
  buildLookupSemanticScopeKey,
} from '../../src/domain/resolver/v2/lookup-semantic-scope.js';
import { buildLookupV2ExactSafeReviewScopeKey } from '../../scripts/eval/export-lookup-v2-exact-safe-family-review-packet.js';

const STRETCH_WRITE_PLANE_CONTRACT_TIMEOUT_MS = 120_000;
const FIXTURE_REVIEWED_AT = '2026-06-09T00:00:00.000Z';
const SYNTHETIC_LATOUR_OWNER = {
  surface: '라뚜르',
  locale: 'ko',
  stretchExpectedStatus: 'ambiguous',
  authorityStatus: 'resolved',
  authorityEntityId: 'fixture:entity:latour',
  conflictType: 'short_form_collision',
  conflictBenchmarkHints: ['latour'],
  sourceEvidence: 'e2e fixture',
  reviewedAt: FIXTURE_REVIEWED_AT,
} as const;
const SYNTHETIC_PETRUS_APPROVED_SCOPE = {
  semanticScopeKey: buildLookupSemanticScopeKey({
    scopeAxis: 'family',
    familyKey: 'petrus',
    surfaceFormKind: 'compact',
    locale: 'ko',
  }),
  benchmarkGoldHint: 'petrus',
  normalizedBenchmarkGoldHint: normalizeForMatch('petrus'),
  scopeAxis: 'family',
  familyKey: 'petrus',
  surfaceFormKind: 'compact',
  locale: 'ko',
  entityId: 'fixture:entity:petrus-2016',
  decisionStatus: 'approved',
  reviewedBy: 'e2e',
  reviewedAt: FIXTURE_REVIEWED_AT,
  decisionReason: 'synthetic reviewed scope-target anchor for isolated CLI contract coverage',
  evidenceClass: 'reviewed_scope_target',
} as const;

function writeJsonl(filePath: string, rows: readonly unknown[]): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''),
    'utf8',
  );
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
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

    const inputPath = path.join(dir, 'coverage.json');
    const outputPath = path.join(dir, 'draft.jsonl');
    const policyConflictRegistryPath = path.join(dir, 'lookup-policy-conflict-registry.jsonl');
    const semanticPolicyRegistryPath = path.join(dir, 'lookup-semantic-policy-registry.jsonl');
    const semanticScopeTargetRegistryPath = path.join(dir, 'lookup-semantic-scope-target-registry.jsonl');
    const semanticScopeSupportRegistryPath = path.join(dir, 'lookup-semantic-scope-support-registry.jsonl');
    const familyCollisionRegistryPath = path.join(dir, 'lookup-family-collision-registry.jsonl');
    const localizedScopeSurfaceRegistryPath = path.join(dir, 'lookup-localized-scope-surface-registry.jsonl');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const projectionPath = path.join(dir, 'lookup-entity-projection.json');

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
      ...SYNTHETIC_LATOUR_OWNER,
    }]);
    writeJsonl(semanticPolicyRegistryPath, [
      {
        semanticConflictKey: 'line::latour::::::::2009::qualified::ko',
        conflictClass: 'short_form_collision',
        entityId: SYNTHETIC_LATOUR_OWNER.authorityEntityId,
        decision: 'keep_ambiguous',
        reviewedBy: 'e2e',
        reviewedAt: FIXTURE_REVIEWED_AT,
        decisionReason: 'reviewed ambiguity must stay visible in draft output',
      },
      {
        semanticConflictKey: 'line::latour::::::::2014::qualified::ko',
        conflictClass: 'short_form_collision',
        entityId: SYNTHETIC_LATOUR_OWNER.authorityEntityId,
        decision: 'needs_scope_target',
        reviewedBy: 'e2e',
        reviewedAt: FIXTURE_REVIEWED_AT,
        decisionReason: 'reviewed scope-target requirement must stay visible in draft output',
      },
    ]);
    writeFileSync(semanticScopeTargetRegistryPath, '', 'utf8');
    writeFileSync(semanticScopeSupportRegistryPath, '', 'utf8');
    writeFileSync(familyCollisionRegistryPath, '', 'utf8');
    writeFileSync(localizedScopeSurfaceRegistryPath, '', 'utf8');
    writeJson(runtimeStatePath, {
      lookupEntityProjectionPath: projectionPath,
    });
    writeJson(projectionPath, {
      documents: [
        {
          entityId: SYNTHETIC_LATOUR_OWNER.authorityEntityId,
          canonicalLabel: 'Chateau Latour',
          producer: 'Chateau Latour',
          region: 'France',
          appellation: 'Pauillac',
          familyCoreKeys: ['latour'],
          aliasesIdentitySafe: ['Latour'],
          aliasesNoisyRecall: [],
        },
      ],
    });

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
        '--runtimeState', runtimeStatePath,
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

  it('export-lookup-v2-exact-safe-proposal-packet and localized scope sync honor injected runtime registry context at the process boundary', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elv2-runtime-bound-export-'));
    tempDirs.push(dir);

    const draftPath = path.join(dir, 'draft.jsonl');
    const exactSafeRegistryPath = path.join(dir, 'korean-exact-safe-registry.jsonl');
    const exactSafeScopeRegistryPath = path.join(dir, 'lookup-exact-safe-scope-registry.jsonl');
    const semanticScopeRegistryPath = path.join(dir, 'lookup-semantic-scope-target-registry.jsonl');
    const localizedRegistryPath = path.join(dir, 'lookup-localized-scope-surface-registry.jsonl');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const projectionPath = path.join(dir, 'lookup-entity-projection.json');
    const exactSafeOutputPath = path.join(dir, 'exact-safe-proposals.jsonl');
    const localizedOutputPath = path.join(dir, 'localized-scope-surface-registry.jsonl');

    writeJsonl(draftPath, [{
      surface: '페트뤼스',
      locale: 'ko',
      suggestedAliasType: 'translation',
      holeClass: 'realworld_frenchish_korean_gap',
      observedStatus: 'failed',
      benchmarkGoldHint: 'petrus',
      benchmarkGoldEntityId: SYNTHETIC_PETRUS_APPROVED_SCOPE.entityId,
      benchmarkGoldEntityIdSource: 'semantic_scope_target_registry',
      semanticScopeKey: SYNTHETIC_PETRUS_APPROVED_SCOPE.semanticScopeKey,
      scopeAxis: 'family',
      familyKey: 'petrus',
      surfaceFormKind: 'compact',
      triageBucket: 'auto_targetable',
      sourceArtifact: '/tmp/lookup-v2-coverage.json',
      sourceEvidence: 'synthetic reviewed scope-target authority',
      reviewedAt: FIXTURE_REVIEWED_AT,
    }]);
    writeFileSync(exactSafeRegistryPath, '', 'utf8');
    writeJsonl(exactSafeScopeRegistryPath, [{
      reviewScopeKey: buildLookupV2ExactSafeReviewScopeKey({
        entityId: SYNTHETIC_PETRUS_APPROVED_SCOPE.entityId,
        holeClass: 'realworld_frenchish_korean_gap',
        suggestedAliasType: 'translation',
      }),
      entityId: SYNTHETIC_PETRUS_APPROVED_SCOPE.entityId,
      scopeHoleClass: 'realworld_frenchish_korean_gap',
      scopeSuggestedAliasType: 'translation',
      decisionStatus: 'approved',
      reviewedBy: 'e2e',
      reviewedAt: FIXTURE_REVIEWED_AT,
      decisionReason: 'synthetic exact-safe approval',
      evidenceClass: 'exact_safe_family_review',
    }]);
    writeJsonl(semanticScopeRegistryPath, [SYNTHETIC_PETRUS_APPROVED_SCOPE]);
    writeFileSync(localizedRegistryPath, '', 'utf8');
    writeJson(runtimeStatePath, {
      lookupEntityProjectionPath: projectionPath,
    });
    writeJson(projectionPath, {
      documents: [
        {
          entityId: SYNTHETIC_PETRUS_APPROVED_SCOPE.entityId,
          canonicalLabel: 'Petrus 2016',
          producer: 'Petrus',
          region: 'France',
          appellation: 'Pomerol',
          vintageYear: 2016,
          familyCoreKeys: ['petrus'],
          aliasesIdentitySafe: ['Petrus'],
          aliasesNoisyRecall: [],
        },
      ],
    });

    const proposalStdout = runEvalScript(
      'scripts/eval/export-lookup-v2-exact-safe-proposal-packet.ts',
      [
        '--input', draftPath,
        '--output', exactSafeOutputPath,
        '--registry', exactSafeRegistryPath,
        '--exactSafeScopeRegistry', exactSafeScopeRegistryPath,
        '--semanticScopeTargetRegistry', semanticScopeRegistryPath,
        '--runtimeState', runtimeStatePath,
      ],
    );

    expect(proposalStdout).toContain('[elv2-exact-safe-proposal-packet] input_rows=1');
    expect(proposalStdout).toContain('[elv2-exact-safe-proposal-packet] packet_rows=1');
    const exactSafeRows = readFileSync(exactSafeOutputPath, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { entityId: string; proposalStatus: string });
    expect(exactSafeRows).toEqual([
      expect.objectContaining({
        entityId: SYNTHETIC_PETRUS_APPROVED_SCOPE.entityId,
        proposalStatus: 'approved',
      }),
    ]);

    const localizedStdout = runEvalScript(
      'scripts/eval/sync-lookup-v2-localized-scope-surface-registry-from-draft.ts',
      [
        '--input', draftPath,
        '--registry', localizedRegistryPath,
        '--semanticScopeRegistry', semanticScopeRegistryPath,
        '--runtimeState', runtimeStatePath,
        '--output', localizedOutputPath,
      ],
    );

    expect(localizedStdout).toContain('[elv2-localized-scope-surface-sync] candidate_draft_rows=1');
    expect(localizedStdout).toContain('[elv2-localized-scope-surface-sync] approved_scope_rows=1');
    expect(localizedStdout).toContain('[elv2-localized-scope-surface-sync] inserted_rows=1');
    const localizedRows = readFileSync(localizedOutputPath, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { componentKey: string; localSurface: string; locale: string });
    expect(localizedRows).toEqual([
      expect.objectContaining({
        componentKey: 'petrus',
        localSurface: '페트뤼스',
        locale: 'ko',
      }),
    ]);
  });

  it('policy family/apply CLIs honor injected runtime registry context at the process boundary', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elv2-runtime-bound-policy-'));
    tempDirs.push(dir);

    const familyRowsPath = path.join(dir, 'policy-family-review-reviewed.jsonl');
    const rowPacketPath = path.join(dir, 'policy-review-packet.jsonl');
    const registryPath = path.join(dir, 'lookup-semantic-policy-registry.jsonl');
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const projectionPath = path.join(dir, 'lookup-entity-projection.json');
    const reviewedRowsOutputPath = path.join(dir, 'policy-review-reviewed-from-family.jsonl');
    const exactSafePacketOutputPath = path.join(dir, 'policy-review-approved-exact-safe-packet.jsonl');
    const semanticConflictKey = buildLookupSemanticConflictKey({
      scopeAxis: 'line',
      familyKey: 'latour',
      vintage: 2009,
      surfaceFormKind: 'qualified',
      locale: 'ko',
    });

    writeJsonl(registryPath, [{
      semanticConflictKey,
      conflictClass: 'short_form_collision',
      entityId: SYNTHETIC_LATOUR_OWNER.authorityEntityId,
      decision: 'promote_exact_safe',
      reviewedBy: 'e2e',
      reviewedAt: FIXTURE_REVIEWED_AT,
      decisionReason: 'synthetic policy promotion',
    }]);
    writeJsonl(familyRowsPath, [{
      semanticConflictKey,
      policyConflictSurface: SYNTHETIC_LATOUR_OWNER.surface,
      locale: 'ko',
      policyConflictType: SYNTHETIC_LATOUR_OWNER.conflictType,
      authorityStatus: SYNTHETIC_LATOUR_OWNER.authorityStatus,
      stretchExpectedStatus: SYNTHETIC_LATOUR_OWNER.stretchExpectedStatus,
      benchmarkGoldEntityId: SYNTHETIC_LATOUR_OWNER.authorityEntityId,
      benchmarkGoldEntityIdSources: ['policy_registry_authority'],
      proposalStatus: 'approved_exact_safe',
      reviewTarget: 'lookup_semantic_policy_registry_v1',
      benchmarkGoldHints: ['latour'],
      sampleSurfaces: ['라뚜르 2009'],
      holeClasses: ['realworld_exact_vintage'],
      suggestedAliasTypes: ['canonical'],
      rowCount: 1,
      sourceArtifacts: ['/tmp/lookup-v2-coverage.json'],
      sourceEvidenceSamples: ['coverage hole'],
      proposedAt: FIXTURE_REVIEWED_AT,
      reviewedAt: FIXTURE_REVIEWED_AT,
      reviewedBy: 'e2e',
      decisionReason: 'synthetic approved family review',
    }]);
    writeJsonl(rowPacketPath, [{
      surface: '라뚜르 2009',
      locale: 'ko',
      suggestedAliasType: 'canonical',
      holeClass: 'realworld_exact_vintage',
      observedStatus: 'ambiguous',
      benchmarkGoldHint: 'latour',
      benchmarkGoldEntityId: SYNTHETIC_LATOUR_OWNER.authorityEntityId,
      benchmarkGoldEntityIdSource: 'policy_registry_authority',
      semanticConflictKey,
      policyConflictSurface: SYNTHETIC_LATOUR_OWNER.surface,
      policyConflictType: SYNTHETIC_LATOUR_OWNER.conflictType,
      authorityStatus: SYNTHETIC_LATOUR_OWNER.authorityStatus,
      stretchExpectedStatus: SYNTHETIC_LATOUR_OWNER.stretchExpectedStatus,
      proposalStatus: 'needs_policy_review',
      reviewTarget: 'lookup_semantic_policy_registry_v1',
      sourceArtifact: '/tmp/lookup-v2-coverage.json',
      sourceEvidence: 'synthetic policy review row',
      proposedAt: FIXTURE_REVIEWED_AT,
    }]);
    writeJson(runtimeStatePath, {
      lookupEntityProjectionPath: projectionPath,
    });
    writeJson(projectionPath, {
      documents: [
        {
          entityId: SYNTHETIC_LATOUR_OWNER.authorityEntityId,
          canonicalLabel: 'Chateau Latour',
          producer: 'Chateau Latour',
          region: 'France',
          appellation: 'Pauillac',
          familyCoreKeys: ['latour'],
          aliasesIdentitySafe: ['Latour'],
          aliasesNoisyRecall: [],
        },
      ],
    });

    const familyApplyStdout = runEvalScript(
      'scripts/eval/apply-lookup-v2-policy-family-review-packet.ts',
      [
        '--families', familyRowsPath,
        '--rows', rowPacketPath,
        '--registry', registryPath,
        '--runtimeState', runtimeStatePath,
        '--output', reviewedRowsOutputPath,
      ],
    );

    expect(familyApplyStdout).toContain('[elv2-policy-family-apply] approved_exact_safe_rows=1');
    expect(familyApplyStdout).toContain('[elv2-policy-family-apply] pending_rows=0');
    const reviewedRows = readFileSync(reviewedRowsOutputPath, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { proposalStatus: string; reviewedBy?: string });
    expect(reviewedRows).toEqual([
      expect.objectContaining({
        proposalStatus: 'approved_exact_safe',
        reviewedBy: 'e2e',
      }),
    ]);

    const policyApplyStdout = runEvalScript(
      'scripts/eval/apply-lookup-v2-policy-review-packet.ts',
      [
        '--input', reviewedRowsOutputPath,
        '--registry', registryPath,
        '--runtimeState', runtimeStatePath,
        '--output', exactSafePacketOutputPath,
      ],
    );

    expect(policyApplyStdout).toContain('[elv2-policy-review-apply] approved_exact_safe_rows=1');
    expect(policyApplyStdout).toContain('[elv2-policy-review-apply] exact_safe_packet_rows=1');
    const exactSafePacketRows = readFileSync(exactSafePacketOutputPath, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { entityId: string; proposalStatus: string; benchmarkGoldEntityIdSource: string });
    expect(exactSafePacketRows).toEqual([
      expect.objectContaining({
        entityId: SYNTHETIC_LATOUR_OWNER.authorityEntityId,
        proposalStatus: 'approved',
        benchmarkGoldEntityIdSource: 'semantic_policy_registry',
      }),
    ]);
  });

  it('refresh, overlay verify, and owner-dispatch stay aligned for an isolated no-residue synthetic chain', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'elv2-write-plane-chain-'));
    tempDirs.push(dir);

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
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const projectionPath = path.join(dir, 'lookup-entity-projection.json');

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

    writeJsonl(familyRegistryPath, [SYNTHETIC_PETRUS_APPROVED_SCOPE]);
    writeJsonl(policyConflictRegistryPath, [{
      ...SYNTHETIC_LATOUR_OWNER,
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
        entityId: SYNTHETIC_LATOUR_OWNER.authorityEntityId,
        decision: 'keep_ambiguous',
        reviewedBy: 'e2e',
        reviewedAt: FIXTURE_REVIEWED_AT,
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
        entityId: SYNTHETIC_LATOUR_OWNER.authorityEntityId,
        decision: 'keep_ambiguous',
        reviewedBy: 'e2e',
        reviewedAt: FIXTURE_REVIEWED_AT,
        decisionReason: 'reviewed ambiguity must stay rejected for 2014',
      },
    ]);
    writeFileSync(semanticScopeSupportRegistryPath, '', 'utf8');
    writeFileSync(familyCollisionRegistryPath, '', 'utf8');
    writeFileSync(exactSafeRegistryPath, '', 'utf8');
    writeJsonl(exactSafeScopeRegistryPath, [{
      reviewScopeKey: buildLookupV2ExactSafeReviewScopeKey({
        entityId: SYNTHETIC_PETRUS_APPROVED_SCOPE.entityId,
        holeClass: 'realworld_frenchish_korean_gap',
        suggestedAliasType: 'translation',
      }),
      entityId: SYNTHETIC_PETRUS_APPROVED_SCOPE.entityId,
      scopeHoleClass: 'realworld_frenchish_korean_gap',
      scopeSuggestedAliasType: 'translation',
      decisionStatus: 'approved',
      reviewedBy: 'e2e',
      reviewedAt: FIXTURE_REVIEWED_AT,
      decisionReason: 'close synthetic exact-safe family review in-process',
      evidenceClass: 'exact_safe_family_review',
    }]);
    writeJson(runtimeStatePath, {
      lookupEntityProjectionPath: projectionPath,
    });
    writeJson(projectionPath, {
      documents: [
        {
          entityId: SYNTHETIC_PETRUS_APPROVED_SCOPE.entityId,
          canonicalLabel: 'Petrus 2016',
          producer: 'Petrus',
          region: 'France',
          appellation: 'Pomerol',
          vintageYear: 2016,
          familyCoreKeys: ['petrus'],
          aliasesIdentitySafe: ['Petrus'],
          aliasesNoisyRecall: [],
        },
        {
          entityId: SYNTHETIC_LATOUR_OWNER.authorityEntityId,
          canonicalLabel: 'Chateau Latour',
          producer: 'Chateau Latour',
          region: 'France',
          appellation: 'Pauillac',
          familyCoreKeys: ['latour'],
          aliasesIdentitySafe: ['Latour'],
          aliasesNoisyRecall: [],
        },
      ],
    });

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
        '--runtimeState', runtimeStatePath,
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
      operationalResidue: {
        draftRows: number;
        structurallyClosedRows: number;
        structurallyClosedPercent: number;
        terminalReviewedRows: number;
        autoTargetableRows: number;
        manualReviewRows: number;
        exactSafePendingFamilyRows: number;
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
    expect(refreshSummary.operationalResidue).toEqual(expect.objectContaining({
      draftRows: 3,
      structurallyClosedRows: 3,
      structurallyClosedPercent: 100,
      terminalReviewedRows: 2,
      autoTargetableRows: 1,
      manualReviewRows: 0,
      exactSafePendingFamilyRows: 0,
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
        '--runtimeState', runtimeStatePath,
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
        operationalStructurallyClosedRows: number;
        operationalManualReviewRows: number;
        operationalTerminalReviewedRows: number;
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
      operationalStructurallyClosedRows: 0,
      operationalManualReviewRows: 0,
      operationalTerminalReviewedRows: 0,
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
