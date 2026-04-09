import { describe, it, expect } from 'vitest';
import { InMemoryModelRegistry } from '../in-memory-model-registry.js';
import type {
  ModelArtifact,
  SerializedModelPayload,
} from '../../../domain/learning/model/model-registry-entry.js';

function stubModelPayload(modelId: string, version: string): SerializedModelPayload {
  return {
    modelId,
    version,
    payload: {},
  };
}

function artifact(modelId: string, version: string, ndcg: number = 0.7): ModelArtifact {
  return {
    modelId,
    version,
    trainedAt: 0,
    featureSchemaHash: 'hash',
    model: stubModelPayload(modelId, version),
    trainingMetrics: {
      ndcg_at_10: ndcg,
      mrr: 0.5,
      trainSampleCount: 100,
    },
  };
}

describe('InMemoryModelRegistry', () => {
  it('register adds an entry in shadow state', async () => {
    const reg = new InMemoryModelRegistry();
    await reg.register(artifact('m1', 'v1'));

    const all = await reg.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('shadow');
    expect(all[0]!.artifact.modelId).toBe('m1');
  });

  it('activate marks exactly one entry as active', async () => {
    const reg = new InMemoryModelRegistry();
    await reg.register(artifact('m1', 'v1'));
    await reg.register(artifact('m2', 'v1'));

    await reg.activate('m2', 'v1');

    const active = await reg.getActive();
    expect(active).not.toBeNull();
    expect(active!.artifact.modelId).toBe('m2');
    expect(active!.status).toBe('active');

    const all = await reg.list();
    const activeCount = all.filter((e) => e.status === 'active').length;
    expect(activeCount).toBe(1);
  });

  it('rollback re-activates the previously active entry', async () => {
    const reg = new InMemoryModelRegistry();
    await reg.register(artifact('m1', 'v1'));
    await reg.activate('m1', 'v1');

    await reg.register(artifact('m2', 'v1'));
    await reg.activate('m2', 'v1');

    await reg.rollback('ctr regression');

    const active = await reg.getActive();
    expect(active).not.toBeNull();
    expect(active!.artifact.modelId).toBe('m1');

    const all = await reg.list();
    const rolled = all.find((e) => e.artifact.modelId === 'm2');
    expect(rolled?.status).toBe('rolled_back');
    expect(rolled?.rollbackReason).toBe('ctr regression');
  });

  it('getActive returns null when nothing is active', async () => {
    const reg = new InMemoryModelRegistry();
    expect(await reg.getActive()).toBeNull();

    await reg.register(artifact('m1', 'v1'));
    // Still nothing active — register does not activate.
    expect(await reg.getActive()).toBeNull();
  });

  it('full activation cycle: register A, activate A, register B, activate B, rollback → A active again', async () => {
    const reg = new InMemoryModelRegistry();

    await reg.register(artifact('A', 'v1'));
    await reg.activate('A', 'v1');
    expect((await reg.getActive())!.artifact.modelId).toBe('A');

    await reg.register(artifact('B', 'v1'));
    await reg.activate('B', 'v1');
    expect((await reg.getActive())!.artifact.modelId).toBe('B');

    await reg.rollback('manual');
    expect((await reg.getActive())!.artifact.modelId).toBe('A');

    // B should be in rolled_back state.
    const all = await reg.list();
    const b = all.find((e) => e.artifact.modelId === 'B');
    expect(b?.status).toBe('rolled_back');
  });
});
