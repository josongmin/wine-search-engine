import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadRuntimeLtrModels } from '../runtime-ltr-model-loader.js';

const makeValidArtifact = () => ({
  queryClassModels: {
    red_wine: {
      weights: [0.25, 0.12, -0.08, 0.07, 0.13, 0.02, 0.15, 0.18],
      bias: 0.5,
      trainingExampleCount: 420,
      ndcg5ValidationScore: 0.91,
      trainedAt: '2026-04-01T00:00:00.000Z',
    },
    white_wine: {
      weights: [0.15, 0.22, 0.01, -0.08, 0.05, 0.12, 0.18, 0.17],
      bias: 0.1,
      trainingExampleCount: 99,
      ndcg5ValidationScore: 0.75,
      trainedAt: '2026-04-01T00:00:00.000Z',
    },
  },
});

async function writeArtifact(raw: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'runtime-ltr-model-loader-'));
  const filePath = path.join(dir, 'runtime-ltr-models.json');
  await writeFile(filePath, `${JSON.stringify(raw)}\n`);
  return filePath;
}

const tempDirs = new Set<string>();

describe('loadRuntimeLtrModels', () => {
  afterEach(async () => {
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it('loads models from object-map artifact form', async () => {
    const filePath = await writeArtifact(makeValidArtifact());
    tempDirs.add(path.dirname(filePath));

    const models = await loadRuntimeLtrModels(filePath);

    expect(models).toBeDefined();
    expect(models?.size).toBe(2);
    expect(models?.get('red_wine')?.weights).toHaveLength(8);
    expect(models?.get('white_wine')?.weights[0]).toBe(0.15);
  });

  it('loads models from array-form artifact', async () => {
    const filePath = await writeArtifact([
      {
        queryClass: 'sparkling_wine',
        weights: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        bias: 0.9,
        trainingExampleCount: 77,
        ndcg5ValidationScore: 0.64,
        trainedAt: '2026-04-02T00:00:00Z',
      },
    ]);
    tempDirs.add(path.dirname(filePath));

    const models = await loadRuntimeLtrModels(filePath);

    expect(models).toBeDefined();
    expect(models?.size).toBe(1);
    expect(models?.get('sparkling_wine')?.trainingExampleCount).toBe(77);
  });

  it('keeps first duplicate queryClass and drops invalid entries', async () => {
    const filePath = await writeArtifact([
      {
        query_class: 'dup_class',
        weights: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        bias: 0.01,
        trainingExampleCount: 7,
        ndcg5ValidationScore: 0.5,
        trainedAt: '2026-04-01T00:00:00Z',
      },
      {
        queryClass: 'dup_class',
        weights: [0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1],
        bias: 0.02,
        trainingExampleCount: 8,
        ndcg5ValidationScore: 0.51,
        trainedAt: '2026-04-01T00:00:00Z',
      },
      {
        queryClass: 'bad_dim',
        weights: [0.1, 0.2, 0.3], // invalid: strict dim requirement
        bias: 0.01,
        trainingExampleCount: 5,
        ndcg5ValidationScore: 0.5,
        trainedAt: '2026-04-01T00:00:00Z',
      },
      {
        query_class: 'valid_after_bad',
        weights: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
        bias: 0.03,
        trainingExampleCount: 9,
        ndcg5ValidationScore: 0.61,
        trainedAt: '2026-04-01T00:00:00Z',
      },
    ]);
    tempDirs.add(path.dirname(filePath));

    const models = await loadRuntimeLtrModels(filePath);

    expect(models).toBeDefined();
    expect(models?.size).toBe(2);
    expect(models?.get('dup_class')?.bias).toBe(0.01);
    expect(models?.has('bad_dim')).toBe(false);
    expect(models?.get('valid_after_bad')?.bias).toBe(0.03);
  });

  it('returns undefined for missing file', async () => {
    const models = await loadRuntimeLtrModels('/tmp/definitely-missing-runtime-ltr-models.json');
    expect(models).toBeUndefined();
  });

  it('returns undefined when JSON is invalid', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'runtime-ltr-model-loader-'));
    tempDirs.add(dir);
    const filePath = path.join(dir, 'runtime-ltr-models.json');
    await writeFile(filePath, '{ bad json');
    const models = await loadRuntimeLtrModels(filePath);

    expect(models).toBeUndefined();
  });

  it('returns undefined when no valid entries exist', async () => {
    const filePath = await writeArtifact([
      {
        queryClass: 'short_dim',
        weights: [0.1, 0.2],
        bias: 0.01,
        trainingExampleCount: 1,
        ndcg5ValidationScore: 0.4,
        trainedAt: '2026-04-01T00:00:00Z',
      },
    ]);
    tempDirs.add(path.dirname(filePath));

    const models = await loadRuntimeLtrModels(filePath);

    expect(models).toBeUndefined();
  });
});
