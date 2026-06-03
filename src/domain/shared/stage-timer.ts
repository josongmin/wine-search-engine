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

/**
 * Hard cap on entries returned by {@link StageTimer.snapshot}.
 *
 * The HTTP `stage_timings` response field is schema-bounded (a `.refine` in
 * `search-response.schema.ts`). If a pipeline emitted MORE distinct stages than
 * this, the strict outbound validation would 500 the ENTIRE search over a
 * best-effort telemetry field (observed on the LLM-provider-degradation path,
 * which fans out extra retry/fallback stages). The timer therefore enforces the
 * bound AT THE SOURCE: it keeps the largest-duration stages — the ones that
 * actually matter for latency diagnosis — and drops the rest.
 *
 * This is the SSoT for the bound (rule 30): the interface constant
 * `MAX_STAGE_TIMINGS_KEYS` re-exports this value so the schema cap and the
 * producer cap can never drift.
 */
export const MAX_STAGE_TIMER_SNAPSHOT_KEYS = 64;

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

/**
 * Optional configuration for {@link createStageTimer}.
 *
 * `now` injects a monotone clock for deterministic testing. The default is
 * `performance.now` which is monotone non-decreasing per the W3C HR-Time
 * spec — the same invariant property-based tests assume.
 */
interface StageTimerOptions {
  readonly now?: () => number;
}

class StageTimerImpl implements StageTimer {
  private readonly starts = new Map<string, number>();
  private readonly elapsed = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  start(stage: string): void {
    this.starts.set(stage, this.now());
  }

  end(stage: string): number {
    const startTime = this.starts.get(stage);
    if (startTime === undefined) return 0;
    const elapsedMs = this.now() - startTime;
    this.elapsed.set(stage, elapsedMs);
    this.starts.delete(stage);
    return elapsedMs;
  }

  snapshot(): Readonly<Record<string, number>> {
    if (this.elapsed.size <= MAX_STAGE_TIMER_SNAPSHOT_KEYS) {
      const out: Record<string, number> = {};
      for (const [stage, ms] of this.elapsed) {
        out[stage] = ms;
      }
      return out;
    }
    // Overflow: keep the largest-duration stages (most useful for latency
    // diagnosis); deterministic tie-break by stage name so equal-duration
    // overflow is stable across calls. See MAX_STAGE_TIMER_SNAPSHOT_KEYS.
    const ranked = [...this.elapsed.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    const out: Record<string, number> = {};
    for (let i = 0; i < MAX_STAGE_TIMER_SNAPSHOT_KEYS; i++) {
      const entry = ranked[i];
      if (entry === undefined) break;
      out[entry[0]] = entry[1];
    }
    return out;
  }

  isRunning(stage: string): boolean {
    return this.starts.has(stage);
  }
}

const defaultNow = (): number => performance.now();

export function createStageTimer(options?: StageTimerOptions): StageTimer {
  const now = options?.now ?? defaultNow;
  return new StageTimerImpl(now);
}
