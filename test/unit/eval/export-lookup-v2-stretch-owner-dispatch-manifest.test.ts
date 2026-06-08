import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { writeLookupV2StretchOwnerDispatchManifest } from '../../../scripts/eval/export-lookup-v2-stretch-owner-dispatch-manifest.js';

function writeJsonl(filePath: string, rows: readonly unknown[]): void {
  writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''), 'utf8');
}

describe('writeLookupV2StretchOwnerDispatchManifest', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it('emits deterministic owner-split dispatch packets from gap reasons and clarification axes', () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'elv2-owner-dispatch-'));
    tempDirs.push(outputDir);

    const runtimeGapDir = path.join(outputDir, 'manual-target-owner-evidence', 'missing-runtime-owner-families-by-gap-reason');
    const manualCollisionSourcePath = path.join(outputDir, 'manual-target-owner-evidence', 'collision-candidate-families.jsonl');
    const manualCollisionPacketPath = path.join(outputDir, 'manual-target-family-review-packet.jsonl');
    const reviewedCollisionDir = path.join(outputDir, 'reviewed-collision-by-axis');
    const reviewedCollisionPacketPath = path.join(outputDir, 'reviewed-collision-family-review-packet.jsonl');
    const packetsDir = path.join(outputDir, 'packets');
    rmSync(runtimeGapDir, { recursive: true, force: true });
    rmSync(reviewedCollisionDir, { recursive: true, force: true });
    mkdirSync(runtimeGapDir, { recursive: true });
    mkdirSync(path.dirname(manualCollisionSourcePath), { recursive: true });
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

    writeJsonl(manualCollisionSourcePath, [
      {
        benchmarkGoldHint: 'petrus',
        normalizedBenchmarkGoldHint: 'petrus',
        benchmarkGoldHintVariants: ['petrus'],
        runtimeEvidenceStatus: 'collision_candidates',
        familyReviewRowCount: 1,
        reviewScopeKeys: ['family::petrus::::::::::compact::ko'],
        scopeHoleClasses: ['realworld_frenchish_korean_gap'],
        scopeSuggestedAliasTypes: ['translation'],
        scopeRisks: ['family_only'],
        locales: ['ko'],
        surfaces: ['페트뤼스'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/input.json'],
        sourceEvidenceSamples: ['hole'],
        runtimeCollisionEntityIds: ['wine-a', 'wine-b'],
        runtimeCollisionEntityLabels: ['A', 'B'],
        runtimeClarificationAxes: ['line', 'region', 'vintage'],
      },
    ]);
    writeJsonl(manualCollisionPacketPath, [
      {
        semanticScopeKey: 'family::petrus::::::::::compact::ko',
        scopeAxis: 'family',
        familyKey: 'petrus',
        surfaceFormKind: 'compact',
        reviewScopeKey: 'family::petrus::::::::::compact::ko',
        legacyReviewScopeKeys: ['petrus::translation::realworld_frenchish_korean_gap'],
        benchmarkGoldHint: 'petrus',
        normalizedBenchmarkGoldHint: 'petrus',
        benchmarkGoldHintVariants: ['petrus'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_manual_target_resolution_v1',
        scopeHoleClass: 'realworld_frenchish_korean_gap',
        scopeSuggestedAliasType: 'translation',
        locales: ['ko'],
        scopeRisk: 'family_only',
        surfaces: ['페트뤼스'],
        holeClasses: ['realworld_frenchish_korean_gap'],
        suggestedAliasTypes: ['translation'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/input.json'],
        sourceEvidenceSamples: ['hole'],
        runtimeEvidenceStatus: 'collision_candidates',
        proposedAt: '2026-06-08T02:00:00.000Z',
      },
    ]);

    writeFileSync(
      path.join(reviewedCollisionDir, 'clarification-axis-index.json'),
      JSON.stringify({
        clarificationAxisCounts: {
          line: 1,
        },
      }, null, 2) + '\n',
      'utf8',
    );
    writeJsonl(path.join(reviewedCollisionDir, 'line.jsonl'), [
      {
        benchmarkGoldHint: 'pontet canet',
        normalizedBenchmarkGoldHint: 'pontet canet',
        collisionStatus: 'active_entity_collision',
        collisionTopology: 'single_producer_family_core_only',
        governanceClass: 'native_family_core_collision',
        producerTopology: 'single_producer',
        witnessTopology: 'family_core_only',
        reviewTarget: 'lookup_reviewed_collision_resolution_v1',
        familyScopeRows: 2,
        reviewScopeRowCount: 2,
        reviewScopeKeys: [
          'line::pontet canet::::::::2011::qualified::ko',
          'line::pontet canet::::::::2014::qualified::ko',
        ],
        scopeAxes: ['line'],
        surfaceFormKinds: ['qualified'],
        scopeRisks: ['mixed_vintage_family'],
        locales: ['ko'],
        suggestedAliasTypes: ['canonical'],
        holeClasses: ['realworld_exact_vintage', 'realworld_vintage_suffix'],
        surfaces: ['퐁테 카네 2011', '퐁테 카네 14'],
        sourceArtifacts: ['/tmp/input.json'],
        sourceEvidenceSamples: ['hole a', 'hole b'],
        witnessSources: ['family_core_key'],
        clarificationAxisSignature: 'line',
        runtimeClarificationAxes: ['line'],
        collisionEntityProducers: ['Pontet-Canet'],
        collisionEntityRegions: ['france'],
        collisionEntityAppellations: [],
        producerCardinality: 1,
        regionCardinality: 1,
        appellationCardinality: 0,
        runtimeCollisionEntityIds: ['wine-pc-a', 'wine-pc-b'],
        runtimeCollisionEntityLabels: ['A', 'B'],
      },
    ]);
    writeJsonl(reviewedCollisionPacketPath, [
      {
        semanticScopeKey: 'line::pontet canet::::::::2011::qualified::ko',
        scopeAxis: 'line',
        familyKey: 'pontet canet',
        vintage: 2011,
        surfaceFormKind: 'qualified',
        reviewScopeKey: 'line::pontet canet::::::::2011::qualified::ko',
        legacyReviewScopeKeys: ['pontet canet::canonical::realworld_exact_vintage'],
        benchmarkGoldHint: 'pontet canet',
        normalizedBenchmarkGoldHint: 'pontet canet',
        benchmarkGoldHintVariants: ['pontet canet'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_reviewed_collision_resolution_v1',
        scopeHoleClass: 'realworld_exact_vintage',
        scopeSuggestedAliasType: 'canonical',
        locales: ['ko'],
        scopeRisk: 'mixed_vintage_family',
        surfaces: ['퐁테 카네 2011'],
        holeClasses: ['realworld_exact_vintage'],
        suggestedAliasTypes: ['canonical'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/input.json'],
        sourceEvidenceSamples: ['hole a'],
        runtimeEvidenceStatus: 'collision_candidates',
        proposedAt: '2026-06-08T02:00:00.000Z',
      },
      {
        semanticScopeKey: 'line::pontet canet::::::::2014::qualified::ko',
        scopeAxis: 'line',
        familyKey: 'pontet canet',
        vintage: 2014,
        surfaceFormKind: 'qualified',
        reviewScopeKey: 'line::pontet canet::::::::2014::qualified::ko',
        legacyReviewScopeKeys: ['pontet canet::canonical::realworld_vintage_suffix'],
        benchmarkGoldHint: 'pontet canet',
        normalizedBenchmarkGoldHint: 'pontet canet',
        benchmarkGoldHintVariants: ['pontet canet'],
        proposalStatus: 'needs_target_review',
        reviewTarget: 'lookup_reviewed_collision_resolution_v1',
        scopeHoleClass: 'realworld_vintage_suffix',
        scopeSuggestedAliasType: 'canonical',
        locales: ['ko'],
        scopeRisk: 'mixed_vintage_family',
        surfaces: ['퐁테 카네 14'],
        holeClasses: ['realworld_vintage_suffix'],
        suggestedAliasTypes: ['canonical'],
        rowCount: 1,
        sourceArtifacts: ['/tmp/input.json'],
        sourceEvidenceSamples: ['hole b'],
        runtimeEvidenceStatus: 'collision_candidates',
        proposedAt: '2026-06-08T02:00:00.000Z',
      },
    ]);

    const manifestPath = path.join(outputDir, 'owner-dispatch-manifest.json');
    const manifest = writeLookupV2StretchOwnerDispatchManifest({
      inputArtifact: '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json',
      outputDir,
      generatedAt: '2026-06-08T02:00:00.000Z',
      manualTargetCollisionSourcePath: manualCollisionSourcePath,
      manualTargetCollisionPacketPath: manualCollisionPacketPath,
      runtimeBackfillByGapReasonDir: runtimeGapDir,
      reviewedCollisionByClarificationAxisDir: reviewedCollisionDir,
      reviewedCollisionPacketPath: reviewedCollisionPacketPath,
      manifestPath,
      packetsDir,
    });

    expect(manifest.totalPackets).toBe(3);
    expect(manifest.packetClassCounts).toEqual({
      runtime_backfill: 1,
      manual_target_collision: 1,
      reviewed_collision_scope: 1,
    });
    expect(existsSync(manifestPath)).toBe(true);
    expect(existsSync(path.join(packetsDir, 'runtime-backfill-requested-vintage-missing.json'))).toBe(true);
    expect(existsSync(path.join(packetsDir, 'manual-target-collision-collision-candidates.json'))).toBe(true);
    expect(existsSync(path.join(packetsDir, 'reviewed-collision-line.json'))).toBe(true);
    expect(existsSync(path.join(packetsDir, 'runtime-backfill-requested-vintage-missing.handoff.md'))).toBe(true);
    expect(existsSync(path.join(packetsDir, 'manual-target-collision-collision-candidates.review-template.json'))).toBe(true);
    expect(existsSync(path.join(packetsDir, 'reviewed-collision-line.review-template.json'))).toBe(true);
    expect(existsSync(path.join(packetsDir, 'reviewed-collision-line.handoff.md'))).toBe(true);

    const persisted = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      totalPackets: number;
      packets: Array<{ packetId: string; reviewCommands: string[]; handoffPath: string; reviewTemplatePath?: string }>;
    };
    expect(persisted.totalPackets).toBe(3);
    expect(persisted.packets.find((packet) => packet.packetId === 'runtime-backfill-requested-vintage-missing')?.reviewCommands).toEqual([]);
    expect(persisted.packets.find((packet) => packet.packetId === 'manual-target-collision-collision-candidates')?.reviewCommands).toHaveLength(2);
    expect(persisted.packets.find((packet) => packet.packetId === 'reviewed-collision-line')?.reviewCommands).toHaveLength(2);
    expect(persisted.packets.every((packet) => packet.handoffPath.endsWith('.handoff.md'))).toBe(true);
    expect(
      persisted.packets.find((packet) => packet.packetId === 'manual-target-collision-collision-candidates')?.reviewTemplatePath,
    ).toMatch(/review-template\.json$/);

    const reviewedCollisionTemplate = JSON.parse(
      readFileSync(path.join(packetsDir, 'reviewed-collision-line.review-template.json'), 'utf8'),
    ) as {
      rows: Array<{ reviewScopeKey: string; candidateEntities: Array<{ entityId: string }> }>;
    };
    expect(reviewedCollisionTemplate.rows).toHaveLength(2);
    expect(reviewedCollisionTemplate.rows[0]?.candidateEntities.map((candidate) => candidate.entityId)).toEqual([
      'wine-pc-a',
      'wine-pc-b',
    ]);
  });

  it('loads composite runtime gap signatures using the same file-stem contract as the family cluster writer', () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'elv2-owner-dispatch-composite-'));
    tempDirs.push(outputDir);

    const runtimeGapDir = path.join(outputDir, 'manual-target-owner-evidence', 'missing-runtime-owner-families-by-gap-reason');
    const reviewedCollisionDir = path.join(outputDir, 'reviewed-collision-by-axis');
    mkdirSync(runtimeGapDir, { recursive: true });
    mkdirSync(reviewedCollisionDir, { recursive: true });

    writeFileSync(
      path.join(runtimeGapDir, 'gap-reason-index.json'),
      JSON.stringify({
        gapReasonSignatureCounts: {
          'family_surface_needs_specific_line+requested_vintage_missing': 1,
        },
      }, null, 2) + '\n',
      'utf8',
    );
    writeJsonl(path.join(runtimeGapDir, 'family-surface-needs-specific-line--requested-vintage-missing.jsonl'), [
      {
        benchmarkGoldHint: 'pol roger',
        normalizedBenchmarkGoldHint: 'pol roger',
        benchmarkGoldHintVariants: ['pol roger'],
        runtimeEvidenceStatus: 'missing_runtime_owner',
        familyReviewRowCount: 2,
        reviewScopeKeys: [
          'family::pol roger::::::::::bare::ko',
          'line::pol roger::::::::2018::qualified::ko',
        ],
        scopeHoleClasses: ['realworld_brand_suffix', 'realworld_vintage_suffix'],
        scopeSuggestedAliasTypes: ['canonical'],
        scopeRisks: ['mixed_vintage_family'],
        locales: ['ko'],
        surfaces: ['폴 로저 윈스턴 처칠', '폴 로저 18'],
        rowCount: 2,
        sourceArtifacts: ['/tmp/input.json'],
        sourceEvidenceSamples: ['hole a', 'hole b'],
        runtimeGapReasons: ['family_surface_needs_specific_line', 'requested_vintage_missing'],
        runtimeGapReasonSignature: 'family_surface_needs_specific_line+requested_vintage_missing',
      },
    ]);

    writeFileSync(
      path.join(reviewedCollisionDir, 'clarification-axis-index.json'),
      JSON.stringify({ clarificationAxisCounts: {} }, null, 2) + '\n',
      'utf8',
    );
    writeFileSync(path.join(outputDir, 'manual-target-owner-evidence', 'collision-candidate-families.jsonl'), '', 'utf8');
    writeFileSync(path.join(outputDir, 'manual-target-family-review-packet.jsonl'), '', 'utf8');
    writeFileSync(path.join(outputDir, 'reviewed-collision-family-review-packet.jsonl'), '', 'utf8');

    const manifest = writeLookupV2StretchOwnerDispatchManifest({
      inputArtifact: '/tmp/lookup-v2-coverage-korean-realworld-stretch-entity-no-policy.json',
      outputDir,
      generatedAt: '2026-06-08T03:00:00.000Z',
      manualTargetCollisionSourcePath: path.join(outputDir, 'manual-target-owner-evidence', 'collision-candidate-families.jsonl'),
      manualTargetCollisionPacketPath: path.join(outputDir, 'manual-target-family-review-packet.jsonl'),
      runtimeBackfillByGapReasonDir: runtimeGapDir,
      reviewedCollisionByClarificationAxisDir: reviewedCollisionDir,
      reviewedCollisionPacketPath: path.join(outputDir, 'reviewed-collision-family-review-packet.jsonl'),
      manifestPath: path.join(outputDir, 'owner-dispatch-manifest.json'),
      packetsDir: path.join(outputDir, 'packets'),
    });

    expect(manifest.totalPackets).toBe(1);
    expect(manifest.packets[0]?.packetId).toBe('runtime-backfill-family-surface-needs-specific-line-requested-vintage-missing');
  });
});
