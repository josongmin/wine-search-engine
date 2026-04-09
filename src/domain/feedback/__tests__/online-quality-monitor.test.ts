import { describe, it, expect } from 'vitest';
import { OnlineQualityMonitor } from '../service/online-quality-monitor.js';

describe('OnlineQualityMonitor', () => {
  it('empty window → ctr=0', () => {
    const m = new OnlineQualityMonitor(60_000);
    const state = m.rotateWindow(0);
    expect(state.current.ctr).toBe(0);
    expect(state.current.impressions).toBe(0);
    expect(state.current.zeroResultRate).toBe(0);
    expect(state.current.topPositionCtr).toBe(0);
    expect(state.previous).toBeUndefined();
    expect(state.delta).toBeUndefined();
  });

  it('single click → ctr computed correctly', () => {
    const m = new OnlineQualityMonitor(60_000);
    m.recordImpression(0, false, false);
    m.recordImpression(1, false, false);
    m.recordImpression(2, false, false);
    m.recordImpression(3, false, false);
    m.recordClick(1);
    const { current } = m.rotateWindow(0);
    expect(current.impressions).toBe(4);
    expect(current.clicks).toBe(1);
    expect(current.ctr).toBeCloseTo(0.25, 6);
  });

  it('rotateWindow swaps current → previous', () => {
    const m = new OnlineQualityMonitor(60_000);
    m.recordImpression(0, false, false);
    m.recordClick(0);
    m.rotateWindow(0); // first rotation: closes window1

    m.recordImpression(0, false, false);
    m.recordImpression(1, false, false);
    const state = m.rotateWindow(60_000); // closes window2

    expect(state.previous).toBeDefined();
    expect(state.previous!.impressions).toBe(1);
    expect(state.previous!.clicks).toBe(1);
    expect(state.current.impressions).toBe(2);
    expect(state.current.clicks).toBe(0);
  });

  it('delta computed correctly between windows', () => {
    const m = new OnlineQualityMonitor(60_000);
    // Window 1: 2 imp, 1 click, 0 zero-result → ctr=0.5
    m.recordImpression(0, false, false);
    m.recordImpression(1, false, false);
    m.recordClick(0);
    m.rotateWindow(0);

    // Window 2: 4 imp, 1 click (ctr=0.25), 2 zero-result (0.5)
    m.recordImpression(0, false, false);
    m.recordImpression(1, true, false);
    m.recordImpression(2, true, false);
    m.recordImpression(3, false, false);
    m.recordClick(0);
    const state = m.rotateWindow(60_000);

    expect(state.delta).toBeDefined();
    expect(state.delta!.ctrDelta).toBeCloseTo(0.25 - 0.5, 6);
    expect(state.delta!.zeroResultDelta).toBeCloseTo(0.5 - 0.0, 6);
  });

  it('top position CTR isolated from other positions', () => {
    const m = new OnlineQualityMonitor(60_000);
    // 2 impressions at pos 0 with 1 click
    m.recordImpression(0, false, false);
    m.recordImpression(0, false, false);
    m.recordClick(0);
    // 2 impressions at pos 3 with 2 clicks (doesn't affect top CTR)
    m.recordImpression(3, false, false);
    m.recordImpression(3, false, false);
    m.recordClick(3);
    m.recordClick(3);

    const { current } = m.rotateWindow(0);
    expect(current.topPositionCtr).toBeCloseTo(0.5, 6);
    expect(current.ctr).toBeCloseTo(3 / 4, 6);
  });
});
