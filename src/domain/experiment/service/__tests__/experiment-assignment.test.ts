import { describe, it, expect } from 'vitest';
import { ExperimentAssigner } from '../experiment-assignment.js';

describe('ExperimentAssigner', () => {
  it('same requestId+experimentId → same variant (deterministic)', () => {
    const a = new ExperimentAssigner([
      { experimentId: 'x', variants: [{ name: 'A', weight: 0.5 }, { name: 'B', weight: 0.5 }] },
    ]);
    const r1 = a.assign('req-123', 'x');
    const r2 = a.assign('req-123', 'x');
    expect(r1.variant).toBe(r2.variant);
    expect(r1.bucket).toBe(r2.bucket);
  });

  it('weight distribution roughly matches over many samples', () => {
    const a = new ExperimentAssigner([
      { experimentId: 'x', variants: [{ name: 'A', weight: 0.7 }, { name: 'B', weight: 0.3 }] },
    ]);
    let countA = 0;
    let countB = 0;
    for (let i = 0; i < 1000; i++) {
      const r = a.assign(`req-${i}`, 'x');
      if (r.variant === 'A') countA++;
      else if (r.variant === 'B') countB++;
    }
    // 70/30 split with FNV hash should land within +/-5% of expected.
    expect(countA).toBeGreaterThan(650);
    expect(countA).toBeLessThan(750);
    expect(countB).toBeGreaterThan(250);
    expect(countB).toBeLessThan(350);
  });

  it('unknown experimentId → control', () => {
    const a = new ExperimentAssigner([]);
    expect(a.assign('req-1', 'nope').variant).toBe('control');
  });

  it('100% variant weight → all assigned', () => {
    const a = new ExperimentAssigner([
      { experimentId: 'x', variants: [{ name: 'all', weight: 1.0 }] },
    ]);
    for (let i = 0; i < 100; i++) {
      expect(a.assign(`req-${i}`, 'x').variant).toBe('all');
    }
  });

  it('multiple experiments are independent', () => {
    const a = new ExperimentAssigner([
      { experimentId: 'x', variants: [{ name: 'A', weight: 1.0 }] },
      { experimentId: 'y', variants: [{ name: 'B', weight: 1.0 }] },
    ]);
    expect(a.assign('req-1', 'x').variant).toBe('A');
    expect(a.assign('req-1', 'y').variant).toBe('B');
  });
});
