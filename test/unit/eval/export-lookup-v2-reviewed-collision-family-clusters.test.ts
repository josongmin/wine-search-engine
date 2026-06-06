import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { writeLookupV2ReviewedCollisionFamilyClusters } from '../../../scripts/eval/export-lookup-v2-reviewed-collision-family-clusters.js';

describe('writeLookupV2ReviewedCollisionFamilyClusters', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('compresses reviewed_collision rows into family clusters with runtime collision evidence', () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'elv2-reviewed-collision-families-'));
    tempDirs.push(outputDir);
    const outputPath = path.join(outputDir, 'reviewed-collision.jsonl');

    const index = writeLookupV2ReviewedCollisionFamilyClusters({
      draftRows: [
        {
          surface: '실버 오크 카베르네',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_brand_suffix',
          observedStatus: 'failed',
          benchmarkGoldHint: 'silver oak',
          triageBucket: 'reviewed_collision',
          collisionStatus: 'active_entity_collision',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'hole a',
          reviewedAt: '2026-06-07T01:20:00.000Z',
        },
        {
          surface: '실버 오크 2018',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_exact_vintage',
          observedStatus: 'failed',
          benchmarkGoldHint: 'silver oak',
          triageBucket: 'reviewed_collision',
          collisionStatus: 'active_entity_collision',
          sourceArtifact: '/tmp/b.json',
          sourceEvidence: 'hole b',
          reviewedAt: '2026-06-07T01:20:00.000Z',
        },
      ],
      runtimeOwnerEvidence: {
        uniqueOwners: new Map(),
        collidingOwners: new Map([
          ['silver oak', ['wine-a', 'wine-b']],
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
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map([
          ['silver oak', [
            { entityId: 'wine-a', witnessSurface: 'Silver Oak', witnessSource: 'producer' },
            { entityId: 'wine-b', witnessSurface: 'Silver Oak', witnessSource: 'producer' },
          ]],
        ]),
        entityLabels: new Map([
          ['wine-a', 'Silver Oak Alexander Valley Cabernet Sauvignon'],
          ['wine-b', 'Silver Oak Napa Valley Cabernet Sauvignon'],
        ]),
      },
      sourceDraftPath: '/tmp/draft.jsonl',
      outputPath,
      generatedAt: '2026-06-07T01:20:00.000Z',
    });

    expect(index.totalRows).toBe(2);
    expect(index.totalFamilies).toBe(1);
    expect(existsSync(outputPath)).toBe(true);

    const [cluster] = readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        benchmarkGoldHint: string;
        familyScopeRows: number;
        collisionStatus: string;
        runtimeCollisionEntityIds: string[];
      });

    expect(cluster).toEqual(expect.objectContaining({
      benchmarkGoldHint: 'silver oak',
      familyScopeRows: 2,
      collisionStatus: 'active_entity_collision',
      collisionTopology: 'single_producer_producer_only',
      governanceClass: 'producer_surface_region_line_collision',
      runtimeCollisionEntityIds: ['wine-a', 'wine-b'],
    }));
  });

  it('classifies reviewed family-core collisions separately from producer-surface collisions', () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'elv2-reviewed-collision-families-'));
    tempDirs.push(outputDir);
    const outputPath = path.join(outputDir, 'reviewed-collision.jsonl');

    const index = writeLookupV2ReviewedCollisionFamilyClusters({
      draftRows: [
        {
          surface: '샤또 보카스텔',
          locale: 'ko',
          suggestedAliasType: 'canonical',
          holeClass: 'realworld_producer_prefixed',
          observedStatus: 'failed',
          benchmarkGoldHint: 'beaucastel',
          triageBucket: 'reviewed_collision',
          collisionStatus: 'active_entity_collision',
          sourceArtifact: '/tmp/a.json',
          sourceEvidence: 'hole a',
          reviewedAt: '2026-06-07T01:20:00.000Z',
        },
      ],
      runtimeOwnerEvidence: {
        uniqueOwners: new Map(),
        collidingOwners: new Map([
          ['beaucastel', ['wine-a', 'wine-b']],
        ]),
        entityProducers: new Map([
          ['wine-a', 'Chateau de Beaucastel'],
          ['wine-b', 'Chateau de Beaucastel'],
        ]),
        entityRegions: new Map([
          ['wine-a', 'France'],
          ['wine-b', 'Cotes-du-Rhone'],
        ]),
        entityAppellations: new Map([
          ['wine-a', 'Chateauneuf-du-Pape'],
          ['wine-b', 'Cotes-du-Rhone'],
        ]),
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map([
          ['beaucastel', [
            { entityId: 'wine-a', witnessSurface: 'beaucastel', witnessSource: 'reviewed_family_core_registry' },
            { entityId: 'wine-b', witnessSurface: 'beaucastel', witnessSource: 'reviewed_family_core_registry' },
          ]],
        ]),
        entityLabels: new Map([
          ['wine-a', '1989 Chateau de Beaucastel Chateauneuf-du-Pape'],
          ['wine-b', '2007 Chateau de Beaucastel Coudoulet de Beaucastel Cotes-du-Rhone'],
        ]),
      },
      sourceDraftPath: '/tmp/draft.jsonl',
      outputPath,
      generatedAt: '2026-06-07T01:20:00.000Z',
    });

    expect(index.governanceCounts).toEqual({
      reviewed_family_core_collision: 1,
    });
  });
});
