import type { DenseHit, SparseHit } from '../port/search-index.port.js';
import type { RetrievalDegradationCode, RetrievalDegradationSignal } from '../port/retrieval-degradation-observer.port.js';
import type { CandidateChannel, CandidateDropRecord, RrfFusionTrace } from './candidate-envelope.js';
import type { HybridCandidate } from './hybrid-candidate.js';

export type RetrievalLaneStatus = 'ok' | 'empty' | 'infra_failure' | 'disabled';

export interface RetrievalExecutionLane<THit> {
  readonly status: RetrievalLaneStatus;
  readonly hits: readonly THit[];
  readonly degraded: boolean;
  readonly error?: string | undefined;
  readonly inputCount?: number | undefined;
  readonly outputCount?: number | undefined;
}

export interface RetrievalExecutionLanes {
  readonly sparse?: RetrievalExecutionLane<SparseHit> | undefined;
  readonly learnedSparse?: RetrievalExecutionLane<DenseHit> | undefined;
  readonly dense?: RetrievalExecutionLane<DenseHit> | undefined;
  readonly anchor?: RetrievalExecutionLane<DenseHit> | undefined;
  readonly relative?: RetrievalExecutionLane<never> | undefined;
}

export interface RetrievalExecutionDegradation {
  readonly signals: readonly RetrievalDegradationSignal[];
  readonly codes: readonly RetrievalDegradationCode[];
}

export interface RetrievalExecutionTelemetry {
  readonly queryClass?: string | undefined;
  readonly route?: string | undefined;
  readonly runtimeRetrievalMode?: string | undefined;
  readonly retrievalProfile?: string | undefined;
  readonly vespaRankProfile?: string | undefined;
  readonly activeChannels?: readonly CandidateChannel[] | undefined;
  readonly filtersApplied?: readonly string[] | undefined;
  readonly skippedPhases?: readonly string[] | undefined;
}

/**
 * Typed retrieval contract returned directly from CandidatePool execution.
 *
 * The array view preserves backward compatibility for callers that still treat
 * retrieval output as `readonly HybridCandidate[]`. New metadata lives on the
 * same returned object so application/search can migrate incrementally away
 * from mutable `getLast*()` accessors.
 */
export interface RetrievalExecutionResult extends ReadonlyArray<HybridCandidate> {
  readonly kind?: 'retrieval_execution_result' | undefined;
  readonly candidates?: readonly HybridCandidate[] | undefined;
  readonly lanes?: RetrievalExecutionLanes | undefined;
  readonly degradation?: RetrievalExecutionDegradation | undefined;
  readonly degradationSignals?: readonly RetrievalDegradationSignal[] | undefined;
  readonly degradationCodes?: readonly RetrievalDegradationCode[] | undefined;
  readonly fusionTrace?: RrfFusionTrace | undefined;
  readonly dropLog?: readonly CandidateDropRecord[] | undefined;
  readonly telemetry?: RetrievalExecutionTelemetry | undefined;
}

export interface BuildRetrievalExecutionResultInput {
  readonly candidates: readonly HybridCandidate[];
  readonly lanes: RetrievalExecutionLanes;
  readonly degradation: RetrievalExecutionDegradation;
  readonly fusionTrace?: RrfFusionTrace | undefined;
  readonly dropLog: readonly CandidateDropRecord[];
  readonly telemetry: RetrievalExecutionTelemetry;
}

export function buildRetrievalExecutionResult(
  input: BuildRetrievalExecutionResultInput,
): RetrievalExecutionResult {
  const arrayView = [...input.candidates] as HybridCandidate[];
  Object.defineProperties(arrayView, {
    kind: { value: 'retrieval_execution_result' as const, enumerable: false },
    candidates: { value: arrayView as readonly HybridCandidate[], enumerable: false },
    lanes: { value: input.lanes, enumerable: false },
    degradation: { value: input.degradation, enumerable: false },
    degradationSignals: { value: input.degradation.signals, enumerable: false },
    degradationCodes: { value: input.degradation.codes, enumerable: false },
    fusionTrace: { value: input.fusionTrace, enumerable: false },
    dropLog: { value: input.dropLog, enumerable: false },
    telemetry: { value: input.telemetry, enumerable: false },
  });
  return arrayView as RetrievalExecutionResult;
}
