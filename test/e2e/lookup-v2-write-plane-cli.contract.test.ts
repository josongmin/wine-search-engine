import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';
import { loadLookupPolicyConflictBenchmarkHintOwnerMapSync } from '../../scripts/eval/lookup-v2-policy-conflict-registry.js';

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
});
