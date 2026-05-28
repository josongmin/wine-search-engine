import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkEvalTrainingReleaseToRuntimeState } from '../../../scripts/eval/run-eval-and-train-ltr.ts';
import { loadSearchSnapshotRuntimeState } from '../../../src/infrastructure/health/search-snapshot-readiness.js';
import { hashText } from '../../../src/domain/shared/utils/stable-json.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'eval-training-runtime-provenance-'));
}

function runtimeStatePayload(runtimeStatePathDir: string, snapshotId: string) {
  return {
    schemaVersion: 'search_snapshot_runtime_state.v3',
    snapshotId,
    contentHash: 'content-hash',
    publishedAt: '2026-04-17T00:00:00.000Z',
    manifestPath: path.join(runtimeStatePathDir, 'manifest.json'),
    nlMappingsRuntimePath: path.join(runtimeStatePathDir, 'nl-mappings.json'),
    counts: {
      entities: 10,
      aliases: 12,
      ambiguityRegistry: 2,
      nlMappings: 1,
      activeLtrModels: 1,
    },
    hashes: {
      entities: 'entities-hash',
      aliases: 'aliases-hash',
      ambiguityRegistry: 'ambiguity-hash',
      nlMappings: 'nl-hash',
      activeLtrModels: 'ltr-hash',
    },
    fieldAvailability: {
      appellation: {
        populatedDocCount: 8,
        totalDocCount: 10,
        populatedDocRatio: 0.8,
      },
      body: {
        populatedDocCount: 6,
        totalDocCount: 10,
        populatedDocRatio: 0.6,
      },
      sweetness: {
        populatedDocCount: 6,
        totalDocCount: 10,
        populatedDocRatio: 0.6,
      },
      acidity: {
        populatedDocCount: 6,
        totalDocCount: 10,
        populatedDocRatio: 0.6,
      },
      tannin: {
        populatedDocCount: 6,
        totalDocCount: 10,
        populatedDocRatio: 0.6,
      },
    },
    quality: {
      status: 'canonical',
      blockers: [],
      bypasses: [],
      carryForwardBenchmarkCount: 0,
      experimentalInputsPresent: false,
    },
  };
}

describe('run-eval-and-train-ltr runtime release provenance linkage', () => {
  it('links eval training release provenance into the active runtime state', async () => {
    const dir = await makeTempDir();
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const noisyOutputPath = path.join(dir, 'noisy.json');
    const summaryJsonPath = path.join(dir, 'release-summary.json');
    const summaryMarkdownPath = path.join(dir, 'release-summary.md');
    const snapshotId = 'search-snapshot:v1:test';

    await fs.writeFile(runtimeStatePath, `${JSON.stringify(runtimeStatePayload(dir, snapshotId), null, 2)}\n`);
    await fs.writeFile(noisyOutputPath, '{"benchmark":"noisy-entity-benchmark"}\n');
    await fs.writeFile(summaryJsonPath, '{"snapshot_id":"search-snapshot:v1:test"}\n');
    await fs.writeFile(summaryMarkdownPath, '## Eval + LTR Release Summary\n');

    const result = await linkEvalTrainingReleaseToRuntimeState({
      runtimeStatePath,
      snapshotId,
      evalDatasetVersion: 'pg_gold_set_store.v1',
      featureSchemaHash: 'feature-hash-test',
      noisyEntityOutputPath: noisyOutputPath,
      releaseSummaryOutput: summaryJsonPath,
      releaseSummaryMarkdownOutput: summaryMarkdownPath,
      combinedReleaseGatePassed: true,
      activationStatus: 'activated',
    });

    expect(result).toEqual({
      status: 'linked',
      runtimeStatePath,
    });

    const linked = await loadSearchSnapshotRuntimeState(runtimeStatePath);
    expect(linked.ltrReleaseProvenance).toMatchObject({
      evalDatasetVersion: 'pg_gold_set_store.v1',
      featureSchemaHash: 'feature-hash-test',
      summaryJsonPath,
      summaryJsonHash: hashText('{"snapshot_id":"search-snapshot:v1:test"}\n'),
      summaryMarkdownPath,
      summaryMarkdownHash: hashText('## Eval + LTR Release Summary\n'),
      noisyEntityOutputPath: noisyOutputPath,
      noisyEntityOutputHash: hashText('{"benchmark":"noisy-entity-benchmark"}\n'),
      combinedReleaseGatePassed: true,
      activationStatus: 'activated',
    });
  });

  it('skips linkage when the runtime state file is missing', async () => {
    const dir = await makeTempDir();
    const result = await linkEvalTrainingReleaseToRuntimeState({
      runtimeStatePath: path.join(dir, 'missing-runtime-search-snapshot.json'),
      snapshotId: 'search-snapshot:v1:test',
      evalDatasetVersion: 'pg_gold_set_store.v1',
      featureSchemaHash: 'feature-hash-test',
      noisyEntityOutputPath: path.join(dir, 'noisy.json'),
      releaseSummaryOutput: path.join(dir, 'release-summary.json'),
      releaseSummaryMarkdownOutput: path.join(dir, 'release-summary.md'),
      combinedReleaseGatePassed: true,
      activationStatus: 'activated',
    });

    expect(result).toEqual({
      status: 'skipped',
      runtimeStatePath: path.join(dir, 'missing-runtime-search-snapshot.json'),
      reason: 'runtime_state_missing',
    });
  });

  it('skips linkage when the runtime state snapshot does not match the training snapshot', async () => {
    const dir = await makeTempDir();
    const runtimeStatePath = path.join(dir, 'runtime-search-snapshot.json');
    const noisyOutputPath = path.join(dir, 'noisy.json');
    const summaryJsonPath = path.join(dir, 'release-summary.json');
    const summaryMarkdownPath = path.join(dir, 'release-summary.md');

    await fs.writeFile(
      runtimeStatePath,
      `${JSON.stringify(runtimeStatePayload(dir, 'search-snapshot:v1:active'), null, 2)}\n`,
    );
    await fs.writeFile(noisyOutputPath, '{"benchmark":"noisy-entity-benchmark"}\n');
    await fs.writeFile(summaryJsonPath, '{"snapshot_id":"search-snapshot:v1:other"}\n');
    await fs.writeFile(summaryMarkdownPath, '## Eval + LTR Release Summary\n');

    const result = await linkEvalTrainingReleaseToRuntimeState({
      runtimeStatePath,
      snapshotId: 'search-snapshot:v1:other',
      evalDatasetVersion: 'pg_gold_set_store.v1',
      featureSchemaHash: 'feature-hash-test',
      noisyEntityOutputPath: noisyOutputPath,
      releaseSummaryOutput: summaryJsonPath,
      releaseSummaryMarkdownOutput: summaryMarkdownPath,
      combinedReleaseGatePassed: false,
      activationStatus: 'shadow_only',
    });

    expect(result).toEqual({
      status: 'skipped',
      runtimeStatePath,
      reason: 'runtime_snapshot_mismatch:search-snapshot:v1:active',
    });

    const linked = await loadSearchSnapshotRuntimeState(runtimeStatePath);
    expect(linked.ltrReleaseProvenance).toBeUndefined();
  });
});
