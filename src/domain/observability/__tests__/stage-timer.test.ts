import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStageTimer } from '../../shared/stage-timer.js';

describe('StageTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records elapsed ms for a single stage', () => {
    const timer = createStageTimer();
    const startNow = 1000;
    const endNow = 1042.5;
    const spy = vi.spyOn(performance, 'now').mockReturnValueOnce(startNow).mockReturnValueOnce(endNow);
    timer.start('sparse');
    const elapsed = timer.end('sparse');
    expect(elapsed).toBeCloseTo(42.5, 1);
    expect(timer.snapshot()['sparse']).toBeCloseTo(42.5, 1);
    spy.mockRestore();
  });

  it('returns 0 from end() when start() was never called', () => {
    const timer = createStageTimer();
    expect(timer.end('never_started')).toBe(0);
  });

  it('tracks multiple independent stages', () => {
    const timer = createStageTimer();
    const spy = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)   // sparse start
      .mockReturnValueOnce(10)  // dense start
      .mockReturnValueOnce(15)  // sparse end → 15
      .mockReturnValueOnce(30); // dense end → 20
    timer.start('sparse');
    timer.start('dense');
    expect(timer.end('sparse')).toBe(15);
    expect(timer.end('dense')).toBe(20);
    const snap = timer.snapshot();
    expect(snap['sparse']).toBe(15);
    expect(snap['dense']).toBe(20);
    spy.mockRestore();
  });

  it('snapshot is empty before any stages complete', () => {
    const timer = createStageTimer();
    timer.start('sparse');
    expect(Object.keys(timer.snapshot())).toHaveLength(0);
  });

  it('isRunning reflects start/end state', () => {
    const timer = createStageTimer();
    expect(timer.isRunning('dense')).toBe(false);
    timer.start('dense');
    expect(timer.isRunning('dense')).toBe(true);
    timer.end('dense');
    expect(timer.isRunning('dense')).toBe(false);
  });

  it('overwrites previous start when start() called twice', () => {
    const timer = createStageTimer();
    const spy = vi.spyOn(performance, 'now')
      .mockReturnValueOnce(0)   // first start
      .mockReturnValueOnce(50)  // second start (overwrites)
      .mockReturnValueOnce(80); // end → 30 (not 80)
    timer.start('llm');
    timer.start('llm');
    expect(timer.end('llm')).toBe(30);
    spy.mockRestore();
  });
});
