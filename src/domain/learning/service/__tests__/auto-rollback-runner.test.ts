import { describe, it, expect, vi } from 'vitest';
import { AutoRollbackRunner } from '../auto-rollback-runner.js';
import type { QualitySnapshot } from '../../../feedback/service/online-quality-monitor.js';
import type { RollbackThresholds } from '../../../feedback/service/auto-rollback-decision.js';
import type { ModelRegistryPort } from '../../port/model-registry.port.js';
import type { ModelRegistryEntry } from '../../model/model-registry-entry.js';

function snapshot(partial: Partial<QualitySnapshot>): QualitySnapshot {
  return {
    windowMs: 60_000,
    impressions: 10_000,
    clicks: 1_000,
    ctr: 0.1,
    zeroResultRate: 0.02,
    topPositionCtr: 0.2,
    degradationFlagRate: 0.0,
    ...partial,
  };
}

const thresholds: RollbackThresholds = {
  ctrDropPct: 0.1,
  zeroResultRiseAbs: 0.05,
  minSamples: 1_000,
};

function makeRegistry(overrides: Partial<ModelRegistryPort> = {}): ModelRegistryPort {
  return {
    register: vi.fn<ModelRegistryPort['register']>(async () => {}),
    activate: vi.fn<ModelRegistryPort['activate']>(async () => {}),
    rollback: vi.fn<ModelRegistryPort['rollback']>(async () => {}),
    getActive: vi.fn<ModelRegistryPort['getActive']>(async (): Promise<ModelRegistryEntry | null> => null),
    list: vi.fn<ModelRegistryPort['list']>(async (): Promise<readonly ModelRegistryEntry[]> => []),
    ...overrides,
  };
}

describe('AutoRollbackRunner', () => {
  it('no regression → rolledBack=false and registry.rollback not called', async () => {
    const registry = makeRegistry();
    const runner = new AutoRollbackRunner(registry, thresholds);

    const baseline = snapshot({ ctr: 0.1, zeroResultRate: 0.02 });
    const current = snapshot({ ctr: 0.11, zeroResultRate: 0.015 });

    const result = await runner.checkAndRollback(current, baseline);
    expect(result.rolledBack).toBe(false);
    expect(result.reasons).toEqual([]);
    expect(registry.rollback).not.toHaveBeenCalled();
  });

  it('CTR drop beyond threshold → registry.rollback called with joined reasons', async () => {
    const rollbackSpy = vi.fn(async (_reason: string): Promise<void> => {});
    const registry = makeRegistry({ rollback: rollbackSpy });
    const runner = new AutoRollbackRunner(registry, thresholds);

    const baseline = snapshot({ ctr: 0.2 });
    // 50% relative drop — well above the 10% threshold.
    const current = snapshot({ ctr: 0.1 });

    const result = await runner.checkAndRollback(current, baseline);
    expect(result.rolledBack).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
    const reasonArg = rollbackSpy.mock.calls[0]![0];
    expect(reasonArg).toMatch(/ctr/i);
  });

  it('registry.rollback throwing propagates to caller', async () => {
    const registry = makeRegistry({
      rollback: vi.fn(async () => {
        throw new Error('registry write failed');
      }),
    });
    const runner = new AutoRollbackRunner(registry, thresholds);

    const baseline = snapshot({ ctr: 0.2 });
    const current = snapshot({ ctr: 0.05 });

    await expect(runner.checkAndRollback(current, baseline)).rejects.toThrow('registry write failed');
  });
});
