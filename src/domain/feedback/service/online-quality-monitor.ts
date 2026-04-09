/**
 * Online quality monitoring for Epic-18 closed-loop core (T18-5).
 *
 * Maintains a rolling pair of windows (current + previous) that track
 * impression / click counters, plus top-position CTR and degradation
 * flag rate. `rotateWindow` swaps current → previous and returns a
 * snapshot pair with deltas so upstream alerting / auto-rollback
 * logic can compare the live window against the immediately prior one.
 */

/** Position considered "top" for top-position CTR measurements. */
const TOP_POSITION = 0;

export interface QualitySnapshot {
  readonly windowMs: number;
  readonly impressions: number;
  readonly clicks: number;
  readonly ctr: number;
  readonly zeroResultRate: number;
  /** CTR at position 0 (clicks_pos0 / impressions_pos0). */
  readonly topPositionCtr: number;
  readonly degradationFlagRate: number;
}

export interface QualityDelta {
  readonly ctrDelta: number;
  readonly zeroResultDelta: number;
}

export interface QualityMonitorState {
  readonly current: QualitySnapshot;
  readonly previous: QualitySnapshot | undefined;
  readonly delta: QualityDelta | undefined;
}

interface WindowCounters {
  impressions: number;
  clicks: number;
  zeroResultImpressions: number;
  degradedImpressions: number;
  topPositionImpressions: number;
  topPositionClicks: number;
}

function makeWindow(): WindowCounters {
  return {
    impressions: 0,
    clicks: 0,
    zeroResultImpressions: 0,
    degradedImpressions: 0,
    topPositionImpressions: 0,
    topPositionClicks: 0,
  };
}

function safeDiv(num: number, denom: number): number {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom <= 0) return 0;
  return num / denom;
}

function snapshot(w: WindowCounters, windowMs: number): QualitySnapshot {
  return {
    windowMs,
    impressions: w.impressions,
    clicks: w.clicks,
    ctr: safeDiv(w.clicks, w.impressions),
    zeroResultRate: safeDiv(w.zeroResultImpressions, w.impressions),
    topPositionCtr: safeDiv(w.topPositionClicks, w.topPositionImpressions),
    degradationFlagRate: safeDiv(w.degradedImpressions, w.impressions),
  };
}

export class OnlineQualityMonitor {
  private current: WindowCounters = makeWindow();
  private previousSnapshot: QualitySnapshot | undefined;

  constructor(private readonly windowMs: number) {}

  recordImpression(position: number, isZeroResult: boolean, isDegraded: boolean): void {
    if (!Number.isFinite(position) || position < 0) return;
    this.current.impressions++;
    if (isZeroResult) this.current.zeroResultImpressions++;
    if (isDegraded) this.current.degradedImpressions++;
    if (position === TOP_POSITION) this.current.topPositionImpressions++;
  }

  recordClick(position: number): void {
    if (!Number.isFinite(position) || position < 0) return;
    this.current.clicks++;
    if (position === TOP_POSITION) this.current.topPositionClicks++;
  }

  /**
   * Rotate windows: the accumulated "current" counters become the new
   * "previous" snapshot, and a fresh empty window replaces `current`.
   * Returns the snapshot pair plus CTR / zero-result deltas.
   *
   * Note: the returned `current` reflects the window that was just closed
   * (i.e. the window that accumulated counters up until `now`), not the
   * empty window that is now open.
   */
  rotateWindow(_now: number): QualityMonitorState {
    const closed = snapshot(this.current, this.windowMs);
    const prior = this.previousSnapshot;
    this.previousSnapshot = closed;
    this.current = makeWindow();

    // exactOptionalPropertyTypes: omit `delta` / `previous` keys entirely
    // when there is no prior window, instead of assigning `undefined`.
    if (prior === undefined) {
      return {
        current: closed,
        previous: undefined,
        delta: undefined,
      } satisfies QualityMonitorState;
    }
    const delta: QualityDelta = {
      ctrDelta: closed.ctr - prior.ctr,
      zeroResultDelta: closed.zeroResultRate - prior.zeroResultRate,
    };
    return {
      current: closed,
      previous: prior,
      delta,
    } satisfies QualityMonitorState;
  }
}
