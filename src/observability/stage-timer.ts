/**
 * Per-stage latency timer for retrieval/ranking pipeline observability.
 *
 * Records start/end times for named stages and produces a flat snapshot
 * of elapsed milliseconds. Uses `performance.now()` for sub-millisecond
 * precision (Date.now() is integer-ms only and unsuitable for hot paths).
 *
 * Multi-start of the same stage is allowed but the LAST start wins —
 * callers should never need to handle nested timers; for nested measurement
 * use distinct stage names (e.g. `dense.embed`, `dense.search`).
 *
 * Timer instances are request-scoped — never share across requests.
 */

export interface StageTimer {
  /** Begin timing a named stage. */
  start(stage: string): void;
  /** End timing for a stage and return elapsed ms. Returns 0 if `start` was not called. */
  end(stage: string): number;
  /** Read all completed stages as a flat record. */
  snapshot(): Readonly<Record<string, number>>;
  /** True if the named stage has been started but not ended. */
  isRunning(stage: string): boolean;
}

class StageTimerImpl implements StageTimer {
  private readonly starts = new Map<string, number>();
  private readonly elapsed = new Map<string, number>();

  start(stage: string): void {
    this.starts.set(stage, performance.now());
  }

  end(stage: string): number {
    const startTime = this.starts.get(stage);
    if (startTime === undefined) return 0;
    const elapsedMs = performance.now() - startTime;
    this.elapsed.set(stage, elapsedMs);
    this.starts.delete(stage);
    return elapsedMs;
  }

  snapshot(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [stage, ms] of this.elapsed) {
      out[stage] = ms;
    }
    return out;
  }

  isRunning(stage: string): boolean {
    return this.starts.has(stage);
  }
}

export function createStageTimer(): StageTimer {
  return new StageTimerImpl();
}
