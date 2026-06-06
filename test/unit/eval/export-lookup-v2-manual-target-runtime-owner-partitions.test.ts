import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { writeLookupV2ManualTargetRuntimeOwnerPartitions } from '../../../scripts/eval/export-lookup-v2-manual-target-runtime-owner-partitions.js';

describe('writeLookupV2ManualTargetRuntimeOwnerPartitions', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('writes first-class owner-evidence partitions for manual-target family rows', () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'elv2-manual-target-owner-'));
    tempDirs.push(outputDir);

    const index = writeLookupV2ManualTargetRuntimeOwnerPartitions({
      packetRows: [
        {
          reviewScopeKey: 'wine-a::canonical::realworld_brand_suffix',
          benchmarkGoldHint: 'wine a',
          normalizedBenchmarkGoldHint: 'wine a',
          benchmarkGoldHintVariants: ['wine a'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_brand_suffix',
          scopeSuggestedAliasType: 'canonical',
          scopeRisk: 'family_only',
          locales: ['ko'],
          surfaces: ['와인 A'],
          holeClasses: ['realworld_brand_suffix'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['coverage hole A'],
          runtimeEvidenceStatus: 'collision_candidates',
          runtimeCollisionEntityIds: ['wine-a', 'wine-b'],
          runtimeCollisionEntityLabels: ['A', 'B'],
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          reviewScopeKey: 'wine-b::translation::realworld_korean_orthography',
          benchmarkGoldHint: 'wine b',
          normalizedBenchmarkGoldHint: 'wine b',
          benchmarkGoldHintVariants: ['wine b'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_korean_orthography',
          scopeSuggestedAliasType: 'translation',
          scopeRisk: 'family_only',
          locales: ['ko'],
          surfaces: ['와인 비'],
          holeClasses: ['realworld_korean_orthography'],
          suggestedAliasTypes: ['translation'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/b.json'],
          sourceEvidenceSamples: ['coverage hole B'],
          runtimeEvidenceStatus: 'missing_runtime_owner',
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      sourcePacketPath: '/tmp/source.jsonl',
      outputDir,
      generatedAt: '2026-06-06T00:00:00.000Z',
    });

    expect(index.totalRows).toBe(2);
    expect(index.candidateUniqueOwnerRows).toBe(0);
    expect(index.collisionCandidateRows).toBe(1);
    expect(index.missingRuntimeOwnerRows).toBe(1);
    expect(existsSync(index.outputPaths.collisionCandidates)).toBe(true);
    expect(existsSync(index.outputPaths.missingRuntimeOwner)).toBe(true);
    expect(readFileSync(index.outputPaths.collisionCandidates, 'utf8')).toContain('wine-a::canonical::realworld_brand_suffix');
    expect(readFileSync(index.outputPaths.missingRuntimeOwner, 'utf8')).toContain('wine-b::translation::realworld_korean_orthography');
  });
});
