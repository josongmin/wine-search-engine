import type {
  CandidateChannel,
  RetrievalChannelFiringState,
  RetrievalChannelTrace,
} from '../model/candidate-envelope.js';
import type {
  RetrievalExecutionLane,
  RetrievalLaneStatus,
} from '../model/retrieval-execution-result.js';
import { CircuitBreakerOpenError } from '../../shared/error/circuit-breaker-open-error.js';

/**
 * Wave 2 — classify a thrown error into the per-channel telemetry
 * firing-state bucket. The buckets are deliberately narrow so dashboards
 * can colour-code "expected dormant" vs "real infra failure" without
 * inspecting log strings.
 *
 * Heuristic-free: every branch is driven by a typed class / standard
 * DOM contract (CircuitBreakerOpenError, AbortError, plain Error).
 */
export function classifyChannelError(
  err: unknown,
): 'circuit_breaker_open' | 'timeout' | 'error' {
  if (err instanceof CircuitBreakerOpenError) return 'circuit_breaker_open';
  // AbortError is the canonical Web-standard timeout marker — fetch + AbortSignal
  // both surface `name === 'AbortError'` when the per-channel deadline fires.
  if (err instanceof Error && err.name === 'AbortError') return 'timeout';
  return 'error';
}

/**
 * Wave 2 — derive a single `RetrievalChannelTrace` row from a channel's
 * lane result. The mapping is deterministic and documented:
 *
 *  - When the channel was not selected for this request (`active=false`)
 *    AND the lane was not invoked → `dormant`. This is the EXPECTED off
 *    state; operators do NOT alert on it.
 *  - When the lane reported `infra_failure` AND classified its error as
 *    `circuit_breaker_open` / `timeout` → surface that exact kind.
 *  - When the lane reported `infra_failure` from any other class →
 *    `error` (still degraded, but not breaker-open / timeout).
 *  - Otherwise (`ok` / `empty` / `disabled` with active=true and no
 *    degradation) → `active`. `disabled` happens when the channel is
 *    administratively gated (e.g. dense kill switch); we map it to
 *    `dormant` so dashboards don't read "active 0 hits" for an
 *    operator-disabled channel.
 */
export function buildChannelTrace(input: {
  readonly channel: CandidateChannel;
  readonly active: boolean;
  readonly result: {
    readonly status: RetrievalLaneStatus;
    readonly degraded: boolean;
    readonly degradation?: {
      readonly errorKind?: 'circuit_breaker_open' | 'timeout' | 'error' | undefined;
    } | undefined;
  };
  readonly hits: ReadonlyArray<unknown>;
  readonly topKInput: number;
  readonly fusionContribution: number;
}): RetrievalChannelTrace {
  let firingState: RetrievalChannelFiringState;
  if (input.result.status === 'disabled' || !input.active) {
    firingState = 'dormant';
  } else if (input.result.status === 'infra_failure') {
    const kind = input.result.degradation?.errorKind ?? 'error';
    firingState = kind;
  } else {
    firingState = 'active';
  }
  return {
    channel: input.channel,
    firingState,
    hitCount: input.hits.length,
    // When the channel did not run, the top-K it WOULD have used is
    // meaningless to operators — report 0 to keep the row truthful.
    topKInput: firingState === 'dormant' ? 0 : input.topKInput,
    fusionContribution: input.fusionContribution,
  };
}

export function toExecutionLane<THit>(
  lane: {
    readonly status: RetrievalLaneStatus;
    readonly hits: readonly THit[];
    readonly degraded: boolean;
    readonly degradation?: { readonly reason: string } | undefined;
  },
): RetrievalExecutionLane<THit> {
  return {
    status: lane.status,
    hits: lane.hits,
    degraded: lane.degraded,
    error: lane.degradation?.reason,
  };
}
