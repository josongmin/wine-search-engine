import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { writeLookupV2CatalogAbsentFamilyClusters } from '../../../scripts/eval/export-lookup-v2-catalog-absent-family-clusters.js';

describe('writeLookupV2CatalogAbsentFamilyClusters', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('compresses catalog_support_review rows into reviewed family clusters', () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'elv2-catalog-absent-families-'));
    tempDirs.push(outputDir);
    const outputPath = path.join(outputDir, 'catalog-absent.jsonl');

    const index = writeLookupV2CatalogAbsentFamilyClusters({
      draftRows: [
        {
          surface: '살롱 샴페인',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_brand_suffix',
          observedStatus: 'failed',
          benchmarkGoldHint: 'salon',
          triageBucket: 'catalog_support_review',
          supportStatus: 'active_catalog_absent',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'hole a',
          reviewedAt: '2026-06-07T00:05:00.000Z',
        },
        {
          surface: 'Salon 2012',
          locale: 'global',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'salon',
          triageBucket: 'catalog_support_review',
          supportStatus: 'active_catalog_absent',
          sourceArtifact: '/tmp/b.json',
          sourceEvidence: 'hole b',
          reviewedAt: '2026-06-07T00:05:00.000Z',
        },
      ],
      sourceDraftPath: '/tmp/draft.jsonl',
      outputPath,
      generatedAt: '2026-06-07T00:05:00.000Z',
    });

    expect(index.totalRows).toBe(2);
    expect(index.totalFamilies).toBe(1);
    expect(existsSync(outputPath)).toBe(true);

    const [cluster] = readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        benchmarkGoldHint: string;
        normalizedBenchmarkGoldHint: string;
        familyScopeRows: number;
        supportStatus: string;
      });

    expect(cluster).toEqual(expect.objectContaining({
      benchmarkGoldHint: 'salon',
      normalizedBenchmarkGoldHint: 'salon',
      familyScopeRows: 2,
      supportStatus: 'active_catalog_absent',
    }));
  });
});
