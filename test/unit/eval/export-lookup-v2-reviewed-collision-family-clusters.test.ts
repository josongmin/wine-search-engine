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
      packetRows: [
        {
          semanticScopeKey: 'line::silver oak::::::::2018::qualified::ko',
          scopeAxis: 'line',
          familyKey: 'silver oak',
          vintage: 2018,
          surfaceFormKind: 'qualified',
          reviewScopeKey: 'line::silver oak::::::::2018::qualified::ko',
          legacyReviewScopeKeys: ['silver oak::canonical::realworld_exact_vintage'],
          benchmarkGoldHint: 'silver oak',
          normalizedBenchmarkGoldHint: 'silver oak',
          benchmarkGoldHintVariants: ['silver oak'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_reviewed_collision_resolution_v1',
          scopeHoleClass: 'realworld_exact_vintage',
          scopeSuggestedAliasType: 'canonical',
          scopeRisk: 'mixed_vintage_family',
          locales: ['ko'],
          surfaces: ['실버 오크 2018'],
          holeClasses: ['realworld_exact_vintage'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['hole a'],
          runtimeEvidenceStatus: 'collision_candidates',
          runtimeCollisionEntityIds: ['wine-a', 'wine-b'],
          runtimeCollisionEntityLabels: [
            'Silver Oak Alexander Valley Cabernet Sauvignon',
            'Silver Oak Napa Valley Cabernet Sauvignon',
          ],
          runtimeCollisionWitnesses: [
            { entityId: 'wine-a', witnessSurface: 'Silver Oak', witnessSource: 'producer' },
            { entityId: 'wine-b', witnessSurface: 'Silver Oak', witnessSource: 'producer' },
          ],
          runtimeClarificationAxes: ['line', 'region', 'appellation'],
          runtimeCollisionScopeDescriptors: [
            {
              entityId: 'wine-a',
              entityLabel: 'Silver Oak Alexander Valley Cabernet Sauvignon',
              familyKey: 'silver oak',
              lineKey: 'alexander valley cabernet sauvignon',
              regionKey: 'united states',
              appellationKey: 'alexander valley',
              vintage: 1984,
            },
            {
              entityId: 'wine-b',
              entityLabel: 'Silver Oak Napa Valley Cabernet Sauvignon',
              familyKey: 'silver oak',
              lineKey: 'napa valley cabernet sauvignon',
              regionKey: 'united states',
              appellationKey: 'napa valley',
              vintage: 2014,
            },
          ],
          proposedAt: '2026-06-07T01:20:00.000Z',
        },
        {
          semanticScopeKey: 'family::silver oak::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'silver oak',
          surfaceFormKind: 'bare',
          reviewScopeKey: 'family::silver oak::::::::::bare::ko',
          legacyReviewScopeKeys: ['silver oak::canonical::realworld_brand_suffix'],
          benchmarkGoldHint: 'silver oak',
          normalizedBenchmarkGoldHint: 'silver oak',
          benchmarkGoldHintVariants: ['silver oak'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_reviewed_collision_resolution_v1',
          scopeHoleClass: 'realworld_brand_suffix',
          scopeSuggestedAliasType: 'canonical',
          scopeRisk: 'family_only',
          locales: ['ko'],
          surfaces: ['실버 오크 카베르네'],
          holeClasses: ['realworld_brand_suffix'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/b.json'],
          sourceEvidenceSamples: ['hole b'],
          runtimeEvidenceStatus: 'collision_candidates',
          runtimeCollisionEntityIds: ['wine-a', 'wine-b'],
          runtimeCollisionEntityLabels: [
            'Silver Oak Alexander Valley Cabernet Sauvignon',
            'Silver Oak Napa Valley Cabernet Sauvignon',
          ],
          runtimeCollisionWitnesses: [
            { entityId: 'wine-a', witnessSurface: 'Silver Oak', witnessSource: 'producer' },
            { entityId: 'wine-b', witnessSurface: 'Silver Oak', witnessSource: 'producer' },
          ],
          runtimeClarificationAxes: ['line', 'region', 'appellation'],
          runtimeCollisionScopeDescriptors: [
            {
              entityId: 'wine-a',
              entityLabel: 'Silver Oak Alexander Valley Cabernet Sauvignon',
              familyKey: 'silver oak',
              lineKey: 'alexander valley cabernet sauvignon',
              regionKey: 'united states',
              appellationKey: 'alexander valley',
              vintage: 1984,
            },
            {
              entityId: 'wine-b',
              entityLabel: 'Silver Oak Napa Valley Cabernet Sauvignon',
              familyKey: 'silver oak',
              lineKey: 'napa valley cabernet sauvignon',
              regionKey: 'united states',
              appellationKey: 'napa valley',
              vintage: 2014,
            },
          ],
          proposedAt: '2026-06-07T01:20:00.000Z',
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
    expect(index.totalReviewScopeRows).toBe(2);
    expect(index.totalFamilies).toBe(1);
    expect(existsSync(outputPath)).toBe(true);
    expect(index.clarificationAxisCounts).toEqual({
      'line-region-appellation': 1,
    });

    const [cluster] = readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        benchmarkGoldHint: string;
        familyScopeRows: number;
        reviewScopeRowCount: number;
        collisionStatus: string;
        reviewTarget: string;
        clarificationAxisSignature: string;
        runtimeCollisionEntityIds: string[];
      });

    expect(cluster).toEqual(expect.objectContaining({
      benchmarkGoldHint: 'silver oak',
      familyScopeRows: 2,
      reviewScopeRowCount: 2,
      collisionStatus: 'active_entity_collision',
      reviewTarget: 'lookup_reviewed_collision_resolution_v1',
      collisionTopology: 'single_producer_producer_only',
      clarificationAxisSignature: 'line-region-appellation',
      governanceClass: 'producer_surface_region_line_collision',
      runtimeCollisionEntityIds: ['wine-a', 'wine-b'],
    }));
  });

  it('classifies reviewed family-core collisions separately from producer-surface collisions', () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'elv2-reviewed-collision-families-'));
    tempDirs.push(outputDir);
    const outputPath = path.join(outputDir, 'reviewed-collision.jsonl');

    const index = writeLookupV2ReviewedCollisionFamilyClusters({
      packetRows: [
        {
          semanticScopeKey: 'family::beaucastel::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'beaucastel',
          surfaceFormKind: 'bare',
          reviewScopeKey: 'family::beaucastel::::::::::bare::ko',
          legacyReviewScopeKeys: ['beaucastel::canonical::realworld_producer_prefixed'],
          benchmarkGoldHint: 'beaucastel',
          normalizedBenchmarkGoldHint: 'beaucastel',
          benchmarkGoldHintVariants: ['beaucastel'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_reviewed_collision_resolution_v1',
          scopeHoleClass: 'realworld_producer_prefixed',
          scopeSuggestedAliasType: 'canonical',
          scopeRisk: 'family_only',
          locales: ['ko'],
          surfaces: ['샤또 보카스텔'],
          holeClasses: ['realworld_producer_prefixed'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 1,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['hole a'],
          runtimeEvidenceStatus: 'collision_candidates',
          runtimeCollisionEntityIds: ['wine-a', 'wine-b'],
          runtimeCollisionEntityLabels: [
            '1989 Chateau de Beaucastel Chateauneuf-du-Pape',
            '2007 Chateau de Beaucastel Coudoulet de Beaucastel Cotes-du-Rhone',
          ],
          runtimeCollisionWitnesses: [
            { entityId: 'wine-a', witnessSurface: 'beaucastel', witnessSource: 'reviewed_family_core_registry' },
            { entityId: 'wine-b', witnessSurface: 'beaucastel', witnessSource: 'reviewed_family_core_registry' },
          ],
          runtimeClarificationAxes: ['line', 'region', 'appellation', 'vintage'],
          runtimeCollisionScopeDescriptors: [
            {
              entityId: 'wine-a',
              entityLabel: '1989 Chateau de Beaucastel Chateauneuf-du-Pape',
              familyKey: 'beaucastel',
              lineKey: 'chateau de beaucastel chateauneuf du pape',
              regionKey: 'france',
              appellationKey: 'chateauneuf du pape',
              vintage: 1989,
            },
            {
              entityId: 'wine-b',
              entityLabel: '2007 Chateau de Beaucastel Coudoulet de Beaucastel Cotes-du-Rhone',
              familyKey: 'beaucastel',
              lineKey: 'chateau de beaucastel coudoulet de beaucastel cotes du rhone',
              regionKey: 'cotes du rhone',
              appellationKey: 'cotes du rhone',
              vintage: 2007,
            },
          ],
          proposedAt: '2026-06-07T01:20:00.000Z',
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
      sourcePacketPath: '/tmp/reviewed-collision-family-review-packet.jsonl',
      outputPath,
      generatedAt: '2026-06-07T01:20:00.000Z',
    });

    expect(index.governanceCounts).toEqual({
      reviewed_family_core_collision: 1,
    });
  });

  it('preserves packet-level clarification axes and scope descriptors into family clusters', () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'elv2-reviewed-collision-families-'));
    tempDirs.push(outputDir);
    const outputPath = path.join(outputDir, 'reviewed-collision.jsonl');

    const index = writeLookupV2ReviewedCollisionFamilyClusters({
      packetRows: [
        {
          semanticScopeKey: 'family::cos destournel::::::::::bare::ko',
          scopeAxis: 'family',
          familyKey: 'cos destournel',
          surfaceFormKind: 'bare',
          reviewScopeKey: 'family::cos destournel::::::::::bare::ko',
          legacyReviewScopeKeys: ['cos destournel::canonical::realworld_brand_suffix'],
          benchmarkGoldHint: 'cos destournel',
          normalizedBenchmarkGoldHint: 'cos destournel',
          benchmarkGoldHintVariants: ['cos destournel'],
          proposalStatus: 'needs_target_review',
          reviewTarget: 'lookup_reviewed_collision_resolution_v1',
          scopeHoleClass: 'realworld_brand_suffix',
          scopeSuggestedAliasType: 'canonical',
          scopeRisk: 'family_only',
          locales: ['ko'],
          surfaces: ['코스 데스투르넬'],
          holeClasses: ['realworld_brand_suffix'],
          suggestedAliasTypes: ['canonical'],
          rowCount: 2,
          sourceArtifacts: ['/tmp/a.json'],
          sourceEvidenceSamples: ['hole a'],
          runtimeEvidenceStatus: 'collision_candidates',
          runtimeCollisionEntityIds: ['wine-a', 'wine-b'],
          runtimeCollisionEntityLabels: ['A', 'B'],
          runtimeCollisionWitnesses: [
            { entityId: 'wine-a', witnessSurface: 'cos destournel', witnessSource: 'family_core_key' },
            { entityId: 'wine-b', witnessSurface: 'cos destournel', witnessSource: 'reviewed_family_core_registry' },
          ],
          runtimeClarificationAxes: ['line', 'region', 'appellation', 'vintage'],
          runtimeCollisionScopeDescriptors: [
            {
              entityId: 'wine-a',
              entityLabel: 'A',
              familyKey: 'cos destournel',
              lineKey: 'cos destournel',
              regionKey: 'france',
              vintage: 2009,
            },
            {
              entityId: 'wine-b',
              entityLabel: 'B',
              familyKey: 'pagodes de cos',
              lineKey: 'pagodes de cos',
              regionKey: 'saint estephe',
              appellationKey: 'saint estephe',
              vintage: 2006,
            },
          ],
          proposedAt: '2026-06-07T01:20:00.000Z',
        },
      ],
      runtimeOwnerEvidence: {
        uniqueOwners: new Map(),
        collidingOwners: new Map([
          ['cos destournel', ['wine-a', 'wine-b']],
        ]),
        entityProducers: new Map([
          ['wine-a', "Cos d'Estournel"],
          ['wine-b', "Cos d'Estournel"],
        ]),
        entityRegions: new Map([
          ['wine-a', 'France'],
          ['wine-b', 'Saint-Estephe'],
        ]),
        entityAppellations: new Map([
          ['wine-a', 'France'],
          ['wine-b', 'Saint-Estephe'],
        ]),
        uniqueOwnerWitnesses: new Map(),
        collidingOwnerWitnesses: new Map(),
        entityLabels: new Map([
          ['wine-a', 'A'],
          ['wine-b', 'B'],
        ]),
      },
      sourcePacketPath: '/tmp/reviewed-collision-family-review-packet.jsonl',
      outputPath,
      generatedAt: '2026-06-07T01:20:00.000Z',
    });

    expect(index.totalRows).toBe(2);
    expect(index.totalReviewScopeRows).toBe(1);
    expect(index.clarificationAxisCounts).toEqual({
      'line-region-appellation-vintage': 1,
    });

    const [cluster] = readFileSync(outputPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        clarificationAxisSignature: string;
        runtimeClarificationAxes: string[];
        reviewScopeKeys: string[];
        runtimeCollisionScopeDescriptors: Array<{ entityId: string }>;
      });

    expect(cluster).toEqual(expect.objectContaining({
      clarificationAxisSignature: 'line-region-appellation-vintage',
      runtimeClarificationAxes: ['line', 'region', 'appellation', 'vintage'],
      reviewScopeKeys: ['family::cos destournel::::::::::bare::ko'],
    }));
    expect(cluster.runtimeCollisionScopeDescriptors).toHaveLength(2);
  });
});
