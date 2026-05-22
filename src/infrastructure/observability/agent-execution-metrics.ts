import type {
  AgentExecutionObserver,
  AgentExecutionRecord,
} from '../../domain/agent/port/agent-execution-observer.port.js';

/**
 * Default head-sampling rate for agent execution metrics.
 *
 * 1.0 = record every execution. Matches the OTel `SAMPLING_RATE_DEFAULT`
 * (`src/infrastructure/telemetry/tracer.ts`) so agent metrics and tracing share
 * a single sampling policy in dev / pre-prod. Production deployments may lower
 * this via constructor injection to align with `OTEL_TRACES_SAMPLER_ARG`.
 *
 * Sampling decision MUST be deterministic per traceId (TraceIdRatioBasedSampler
 * invariant, OTel sampling spec §3.2) — given the same traceId, the same
 * collector ALWAYS yields the same sample/drop decision. This is enforced via
 * a numeric hash of the traceId compared against `rate * 2^32`.
 *
 * Kept as a named constant (test discipline rule 15 / SSoT rule 30) so any
 * future sampling-policy audit can be located by grep, not by reading scoring
 * logic line by line.
 */
export const AGENT_METRICS_SAMPLING_RATE_DEFAULT = 1.0;

/**
 * In-memory aggregation window for agent execution metrics, in hours.
 *
 * 7 days (168h) matches the retention SLA documented in the YAML feature
 * catalog (`tools/feature-catalog/features/observability/agent-execution-metrics.yaml`)
 * and aligns with Datadog/Honeycomb's default 7-day rolling-window dashboards.
 *
 * The collector is a monotone counter — it does not evict by time itself.
 * Operators are expected to call `reset()` at the start of each retention
 * window (typically wired to a daily cron or rolling-window snapshot). This
 * constant documents the intent and is exposed so the health-check route can
 * surface "metrics aggregated over up to N hours" honestly.
 *
 * Kept as a named constant (test discipline rule 15) so retention audits land
 * in one place.
 */
const HOURS_PER_DAY = 24;
const RETENTION_DAYS = 7;
export const AGENT_METRICS_RETENTION_HOURS = HOURS_PER_DAY * RETENTION_DAYS;

/**
 * Maximum sampler hash space — 2^32. The TraceIdRatioBasedSampler spec
 * (OTel sampling spec §3.2.1) compares a deterministic hash of the traceId
 * against `rate * upperBound`. We use 2^32 because the test/production
 * traceId hash is a 32-bit FNV-1a-style mix; any value >= bound is "drop",
 * < bound is "sample".
 */
const SAMPLER_HASH_UPPER_BOUND = 0x1_0000_0000;

/**
 * Deterministic 32-bit unsigned hash of a hex traceId, used to make the
 * sampling decision identical across calls with the same traceId
 * (TraceIdRatioBasedSampler invariant). XOR-folds the eight 4-hex chunks of
 * a 32-char traceId; tolerant of shorter inputs (test traces).
 */
/**
 * djb2-style shift constant (×31 = (<<5) − x). Standard string-hash mixing
 * factor; documented here so the magic-number lint doesn't have to.
 */
const DJB2_SHIFT = 5;

function hashTraceId(traceId: string): number {
  let acc = 0;
  for (let i = 0; i < traceId.length; i += 1) {
    const code = traceId.charCodeAt(i);
    acc = ((acc << DJB2_SHIFT) - acc + code) >>> 0;
  }
  return acc >>> 0;
}

/**
 * Returns whether a given traceId should be sampled at the supplied rate.
 *
 * - rate >= 1.0 → ALWAYS sampled (matches AlwaysOnSampler)
 * - rate <= 0.0 → NEVER sampled (matches AlwaysOffSampler)
 * - 0 < rate < 1 → deterministic per-traceId decision
 *
 * Exported for property-test access — same input traceId MUST yield the same
 * decision across runs (OTel sampling spec invariant).
 */
export function shouldSampleAgentExecution(
  traceId: string | undefined,
  rate: number,
): boolean {
  if (!Number.isFinite(rate)) return true;
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  if (traceId === undefined || traceId.length === 0) {
    // No traceId → conservative: sample (avoid silently dropping un-traced runs).
    return true;
  }
  const bound = Math.floor(rate * SAMPLER_HASH_UPPER_BOUND);
  return hashTraceId(traceId) < bound;
}

interface AgentExecutionMetrics {
  readonly runs: number;
  readonly byTerminationReason: Readonly<Record<string, number>>;
  readonly fallbackRuns: number;
  readonly fallbackRate: number;
  readonly fallbackByLayer: Readonly<Record<string, number>>;
  readonly reasoningFailureRuns: number;
  readonly totalToolCalls: number;
  readonly avgDurationMs: number;
  readonly toolOutcomeKinds: Readonly<Record<string, number>>;
  readonly failedOutcomeKinds: Readonly<Record<string, number>>;
  readonly timeouts: {
    readonly llmStep: number;
    readonly tool: number;
    readonly parallelBatch: number;
    readonly eventRatePerRun: number;
  };
  readonly alerts: readonly string[];
}

const MIN_RUNS_FOR_ALERT = 20;
const FALLBACK_RATE_ALERT_THRESHOLD = 0.3;
const TIMEOUT_EVENT_RATE_ALERT_THRESHOLD = 0.2;
const PARALLEL_BATCH_TIMEOUT_RATE_ALERT_THRESHOLD = 0.1;

/**
 * Per-call options for {@link AgentExecutionMetricsCollector.onExecutionComplete}.
 *
 * `traceId` is optional and used for deterministic sampling — pass the active
 * OTel SpanContext.traceId when available so the sample/drop decision is
 * stable across the trace (TraceIdRatioBasedSampler invariant).
 */
interface AgentExecutionRecordOptions {
  readonly traceId?: string | undefined;
}

export class AgentExecutionMetricsCollector implements AgentExecutionObserver {
  private runs = 0;
  private fallbackRuns = 0;
  private reasoningFailureRuns = 0;
  private totalToolCalls = 0;
  private totalDurationMs = 0;
  private timeoutLlmStep = 0;
  private timeoutTool = 0;
  private timeoutParallelBatch = 0;
  private readonly byTerminationReason = new Map<string, number>();
  private readonly fallbackByLayer = new Map<string, number>();
  private readonly toolOutcomeKinds = new Map<string, number>();
  private readonly failedOutcomeKinds = new Map<string, number>();
  private readonly samplingRate: number;

  constructor(options: { readonly samplingRate?: number } = {}) {
    const requested = options.samplingRate ?? AGENT_METRICS_SAMPLING_RATE_DEFAULT;
    // Clamp to [0,1] to honor OTel spec; non-finite falls back to default.
    if (!Number.isFinite(requested)) {
      this.samplingRate = AGENT_METRICS_SAMPLING_RATE_DEFAULT;
    } else if (requested < 0) {
      this.samplingRate = 0;
    } else if (requested > 1) {
      this.samplingRate = 1;
    } else {
      this.samplingRate = requested;
    }
  }

  /** Exposes the active sampling rate for diagnostics + tests. */
  getSamplingRate(): number {
    return this.samplingRate;
  }

  /** Retention SLA window (hours) — surfaced via health route. */
  getRetentionHours(): number {
    return AGENT_METRICS_RETENTION_HOURS;
  }

  onExecutionComplete(record: AgentExecutionRecord, opts?: AgentExecutionRecordOptions): void {
    if (!shouldSampleAgentExecution(opts?.traceId, this.samplingRate)) {
      return;
    }
    this.runs++;
    if (record.fallbackApplied) this.fallbackRuns++;
    if (record.synthesis?.reasoningFailure === true) {
      this.reasoningFailureRuns++;
    }
    if (record.synthesis?.fallbackApplied !== null && record.synthesis?.fallbackApplied !== undefined) {
      this.fallbackByLayer.set(
        record.synthesis.fallbackApplied,
        (this.fallbackByLayer.get(record.synthesis.fallbackApplied) ?? 0) + 1,
      );
    }
    this.totalToolCalls += record.toolCallCount;
    this.totalDurationMs += record.totalDurationMs;
    this.timeoutLlmStep += record.timeoutStats.llmStep;
    this.timeoutTool += record.timeoutStats.tool;
    this.timeoutParallelBatch += record.timeoutStats.parallelBatch;
    this.byTerminationReason.set(
      record.terminationReason,
      (this.byTerminationReason.get(record.terminationReason) ?? 0) + 1,
    );
    for (const kind of record.toolOutcomeKinds ?? []) {
      this.toolOutcomeKinds.set(kind, (this.toolOutcomeKinds.get(kind) ?? 0) + 1);
    }
    for (const kind of record.failedOutcomeKinds ?? []) {
      this.failedOutcomeKinds.set(kind, (this.failedOutcomeKinds.get(kind) ?? 0) + 1);
    }
  }

  getMetrics(): AgentExecutionMetrics {
    const byReason: Record<string, number> = {};
    for (const [k, v] of this.byTerminationReason.entries()) {
      byReason[k] = v;
    }
    const fallbackByLayer: Record<string, number> = {};
    for (const [k, v] of this.fallbackByLayer.entries()) {
      fallbackByLayer[k] = v;
    }
    const toolOutcomeKinds: Record<string, number> = {};
    for (const [k, v] of this.toolOutcomeKinds.entries()) {
      toolOutcomeKinds[k] = v;
    }
    const failedOutcomeKinds: Record<string, number> = {};
    for (const [k, v] of this.failedOutcomeKinds.entries()) {
      failedOutcomeKinds[k] = v;
    }
    const fallbackRate = this.runs > 0 ? this.fallbackRuns / this.runs : 0;
    const timeoutEventTotal = this.timeoutLlmStep + this.timeoutTool + this.timeoutParallelBatch;
    const timeoutEventRatePerRun = this.runs > 0 ? timeoutEventTotal / this.runs : 0;
    const parallelBatchTimeoutRate = this.runs > 0 ? this.timeoutParallelBatch / this.runs : 0;
    const alerts: string[] = [];
    if (this.runs >= MIN_RUNS_FOR_ALERT) {
      if (fallbackRate >= FALLBACK_RATE_ALERT_THRESHOLD) {
        alerts.push('agent_fallback_rate_high');
      }
      if (timeoutEventRatePerRun >= TIMEOUT_EVENT_RATE_ALERT_THRESHOLD) {
        alerts.push('agent_timeout_event_rate_high');
      }
      if (parallelBatchTimeoutRate >= PARALLEL_BATCH_TIMEOUT_RATE_ALERT_THRESHOLD) {
        alerts.push('agent_parallel_batch_timeout_rate_high');
      }
    }
    return {
      runs: this.runs,
      byTerminationReason: byReason,
      fallbackRuns: this.fallbackRuns,
      fallbackRate,
      fallbackByLayer,
      reasoningFailureRuns: this.reasoningFailureRuns,
      totalToolCalls: this.totalToolCalls,
      avgDurationMs: this.runs > 0 ? this.totalDurationMs / this.runs : 0,
      toolOutcomeKinds,
      failedOutcomeKinds,
      timeouts: {
        llmStep: this.timeoutLlmStep,
        tool: this.timeoutTool,
        parallelBatch: this.timeoutParallelBatch,
        eventRatePerRun: timeoutEventRatePerRun,
      },
      alerts,
    };
  }

  reset(): void {
    this.runs = 0;
    this.fallbackRuns = 0;
    this.reasoningFailureRuns = 0;
    this.totalToolCalls = 0;
    this.totalDurationMs = 0;
    this.timeoutLlmStep = 0;
    this.timeoutTool = 0;
    this.timeoutParallelBatch = 0;
    this.byTerminationReason.clear();
    this.fallbackByLayer.clear();
    this.toolOutcomeKinds.clear();
    this.failedOutcomeKinds.clear();
  }
}

let globalCollector: AgentExecutionMetricsCollector | undefined;

export function getAgentExecutionMetricsCollector(): AgentExecutionMetricsCollector {
  globalCollector ??= new AgentExecutionMetricsCollector();
  return globalCollector;
}
