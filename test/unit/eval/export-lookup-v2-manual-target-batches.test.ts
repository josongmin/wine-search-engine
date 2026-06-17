import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLookupV2ManualTargetBatches,
  writeLookupV2ManualTargetBatches,
} from '../../../scripts/eval/export-lookup-v2-manual-target-batches.js';

describe('buildLookupV2ManualTargetBatches', () => {
  it('groups only manual_target rows by holeClass deterministically', () => {
    const batches = buildLookupV2ManualTargetBatches([
      {
        surface: 'A',
        locale: 'ko',
        suggestedAliasType: 'canonical',
        holeClass: 'realworld_exact_vintage',
        observedStatus: 'failed',
        triageBucket: 'scope_target_review',
        sourceArtifact: '/tmp/a.json',
        sourceEvidence: 'a',
        reviewedAt: '2026-06-05T00:00:00.000Z',
      },
      {
        surface: 'B',
        locale: 'ko',
        suggestedAliasType: 'canonical',
        holeClass: 'realworld_exact_vintage',
        observedStatus: 'failed',
        triageBucket: 'scope_target_review',
        sourceArtifact: '/tmp/a.json',
        sourceEvidence: 'b',
        reviewedAt: '2026-06-05T00:00:00.000Z',
      },
      {
        surface: 'C',
        locale: 'ko',
        suggestedAliasType: 'translation',
        holeClass: 'realworld_brand_suffix',
        observedStatus: 'failed',
        triageBucket: 'scope_target_review',
        sourceArtifact: '/tmp/a.json',
        sourceEvidence: 'c',
        reviewedAt: '2026-06-05T00:00:00.000Z',
      },
      {
        surface: 'D',
        locale: 'ko',
        suggestedAliasType: 'canonical',
        holeClass: 'realworld_brand_suffix',
        observedStatus: 'failed',
        triageBucket: 'auto_targetable',
        sourceArtifact: '/tmp/a.json',
        sourceEvidence: 'd',
        reviewedAt: '2026-06-05T00:00:00.000Z',
      },
      {
        surface: 'E',
        locale: 'ko',
        suggestedAliasType: 'canonical',
        holeClass: 'realworld_exact_vintage',
        observedStatus: 'failed',
        triageBucket: 'policy_review',
        policyConflictHint: 'latour',
        sourceArtifact: '/tmp/a.json',
        sourceEvidence: 'e',
        reviewedAt: '2026-06-05T00:00:00.000Z',
      },
    ]);

    expect([...batches.keys()]).toEqual([
      'realworld_brand_suffix',
      'realworld_exact_vintage',
    ]);
    expect(batches.get('realworld_brand_suffix')?.map((row) => row.surface)).toEqual(['C']);
    expect(batches.get('realworld_exact_vintage')?.map((row) => row.surface)).toEqual(['A', 'B']);
  });
});

describe('writeLookupV2ManualTargetBatches', () => {
  it('writes per-class JSONL files plus an index', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'elv2-manual-target-batches-'));
    const index = writeLookupV2ManualTargetBatches({
      draftRows: [
        {
          surface: 'A',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'a',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        },
        {
          surface: 'B',
          locale: 'ko',
          suggestedAliasType: 'translation',
          holeClass: 'realworld_brand_suffix',
          observedStatus: 'failed',
          triageBucket: 'scope_target_review',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'b',
          reviewedAt: '2026-06-05T00:00:00.000Z',
        },
      ],
      sourceDraftPath: '/tmp/draft.jsonl',
      outputDir: dir,
      generatedAt: '2026-06-05T01:00:00.000Z',
    });

    expect(index.totalRows).toBe(2);
    expect(index.batches).toEqual([
      {
        holeClass: 'realworld_brand_suffix',
        rowCount: 1,
        outputPath: path.join(dir, 'realworld-brand-suffix.jsonl'),
      },
      {
        holeClass: 'realworld_exact_vintage',
        rowCount: 1,
        outputPath: path.join(dir, 'realworld-exact-vintage.jsonl'),
      },
    ]);

    const exactVintageRows = await fs.readFile(path.join(dir, 'realworld-exact-vintage.jsonl'), 'utf8');
    expect(exactVintageRows).toContain('"surface":"A"');

    const indexJson = JSON.parse(await fs.readFile(path.join(dir, 'index.json'), 'utf8')) as {
      totalRows: number;
      batches: readonly { holeClass: string; rowCount: number }[];
    };
    expect(indexJson.totalRows).toBe(2);
    expect(indexJson.batches.map((row) => row.holeClass)).toEqual([
      'realworld_brand_suffix',
      'realworld_exact_vintage',
    ]);
  });
});
