import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { writeLookupV2ManualTargetOwnerFamilyClusters } from '../../../scripts/eval/export-lookup-v2-manual-target-owner-family-clusters.js';

describe('writeLookupV2ManualTargetOwnerFamilyClusters', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('compresses manual-target scope rows into owner-evidence family clusters', () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'elv2-manual-target-owner-families-'));
    tempDirs.push(outputDir);

    const index = writeLookupV2ManualTargetOwnerFamilyClusters({
      packetRows: [
        {
          reviewScopeKey: 'beaucastel::canonical::realworld_brand_suffix',
          benchmarkGoldHint: 'beaucastel',
          normalizedBenchmarkGoldHint: 'beaucastel',
          benchmarkGoldHintVariants: ['beaucastel'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_brand_suffix',
          scopeSuggestedAliasType: 'canonical',
          scopeRisk: 'family_only',
          locales: ['ko'],
          surfaces: ['보카스텔'],
          holeClasses: ['realworld_brand_suffix'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['hole a'],
          runtimeEvidenceStatus: 'collision_candidates',
          runtimeCollisionEntityIds: ['wine-a', 'wine-b'],
          runtimeCollisionEntityLabels: ['A', 'B'],
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          reviewScopeKey: 'beaucastel::translation::realworld_korean_orthography',
          benchmarkGoldHint: 'beaucastel',
          normalizedBenchmarkGoldHint: 'beaucastel',
          benchmarkGoldHintVariants: ['beaucastel'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_korean_orthography',
          scopeSuggestedAliasType: 'translation',
          scopeRisk: 'family_only',
          locales: ['ko'],
          surfaces: ['보까스텔'],
          holeClasses: ['realworld_korean_orthography'],
          suggestedAliasTypes: ['translation'],
          rowCount: 2,
          sourceArtifacts: ['/tmp/b.json'],
          sourceEvidenceSamples: ['hole b'],
          runtimeEvidenceStatus: 'collision_candidates',
          runtimeCollisionEntityIds: ['wine-a', 'wine-b'],
          runtimeCollisionEntityLabels: ['A', 'B'],
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
        {
          reviewScopeKey: 'salon::canonical::realworld_brand_suffix',
          benchmarkGoldHint: 'salon',
          normalizedBenchmarkGoldHint: 'salon',
          benchmarkGoldHintVariants: ['salon'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_manual_target_resolution_v1',
          scopeHoleClass: 'realworld_brand_suffix',
          scopeSuggestedAliasType: 'canonical',
          scopeRisk: 'family_only',
          locales: ['ko'],
          surfaces: ['살롱'],
          holeClasses: ['realworld_brand_suffix'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/c.json'],
          sourceEvidenceSamples: ['hole c'],
          runtimeEvidenceStatus: 'missing_runtime_owner',
          runtimeGapReason: 'requested_vintage_missing',
          runtimeGapEntityIds: ['wine-salon-2008'],
          runtimeGapEntityLabels: ['2008 Salon'],
          runtimeGapAvailableVintages: [2008],
          proposedAt: '2026-06-06T00:00:00.000Z',
        },
      ],
      sourcePacketPath: '/tmp/manual-target-family-review.jsonl',
      outputDir,
      generatedAt: '2026-06-06T00:00:00.000Z',
    });

    expect(index.totalFamilies).toBe(2);
    expect(index.totalScopeRows).toBe(3);
    expect(index.collisionCandidateFamilies).toBe(1);
    expect(index.missingRuntimeOwnerFamilies).toBe(1);
    expect(existsSync(index.outputPaths.collisionCandidateFamilies)).toBe(true);
    expect(existsSync(index.outputPaths.missingRuntimeOwnerFamilies)).toBe(true);
    expect(existsSync(index.outputPaths.gapReasonIndexPath)).toBe(true);
    expect(index.gapReasonSignatureCounts).toEqual({
      requested_vintage_missing: 1,
    });

    const collision = readFileSync(index.outputPaths.collisionCandidateFamilies, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { benchmarkGoldHint: string; familyReviewRowCount: number; rowCount: number });
    expect(collision).toEqual([
      expect.objectContaining({
        benchmarkGoldHint: 'beaucastel',
        familyReviewRowCount: 2,
        rowCount: 3,
      }),
    ]);

    const missing = readFileSync(index.outputPaths.missingRuntimeOwnerFamilies, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { benchmarkGoldHint: string; runtimeGapReasons?: string[]; runtimeGapAvailableVintages?: number[] });
    expect(missing).toEqual([
      expect.objectContaining({
        benchmarkGoldHint: 'salon',
        runtimeGapReasons: ['requested_vintage_missing'],
        runtimeGapReasonSignature: 'requested_vintage_missing',
        runtimeGapAvailableVintages: [2008],
      }),
    ]);
  });
});
