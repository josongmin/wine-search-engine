type CacheEligibility =
  | 'cacheable'
  | 'non_cacheable'
  | 'cacheable_but_snapshot_bound';

export const RESPONSE_CACHE_POLICY_REASONS = [
  'heuristic_response',
  'degraded_response',
  'advisory_response',
  'not_blocking_eligible',
  'missing_snapshot_id',
] as const;

export type ResponseCachePolicyReason =
  typeof RESPONSE_CACHE_POLICY_REASONS[number];

interface CachePolicyDecision {
  eligibility: CacheEligibility;
  reason?: ResponseCachePolicyReason;
}

export const RESPONSE_CACHE_READ_BYPASS_REASONS = [
  'cached_not_blocking_eligible',
  'cached_execution_mode_degraded',
  'cached_execution_mode_heuristic',
  'cached_execution_mode_advisory',
  'learning_disabled',
  'dense_retrieval_disabled',
  'reranker_unavailable',
  'runtime_degraded',
  'missing_cached_snapshot_id',
  'missing_cached_contract_version',
  'snapshot_id_drift',
  'contract_version_drift',
  'model_version_drift',
] as const;

type ResponseCacheReadBypassReason =
  typeof RESPONSE_CACHE_READ_BYPASS_REASONS[number];

interface ResponseCacheReadDecision {
  eligibility: 'cache_hit' | 'bypass';
  reason?: ResponseCacheReadBypassReason;
}

export function isDestructiveResponseCacheBypassReason(
  reason: ResponseCacheReadBypassReason | undefined,
): boolean {
  switch (reason) {
    case 'learning_disabled':
    case 'dense_retrieval_disabled':
    case 'reranker_unavailable':
    case 'runtime_degraded':
      return false;
    case undefined:
      return false;
    default:
      return true;
  }
}

export interface CacheReadRuntimeState {
  readonly learningKillSwitchEnabled: boolean;
  readonly denseRetrievalEnabled: boolean;
  readonly rerankerAvailable: boolean;
  readonly currentExecutionModeHint?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
}

export function decideResponseCachePolicy(input: {
  executionMode: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
  snapshotId?: string;
  blockingEligible?: boolean;
}): CachePolicyDecision {
  if (input.executionMode === 'heuristic') {
    return { eligibility: 'non_cacheable', reason: 'heuristic_response' };
  }
  if (input.executionMode === 'degraded') {
    return { eligibility: 'non_cacheable', reason: 'degraded_response' };
  }
  if (input.executionMode === 'advisory') {
    return { eligibility: 'non_cacheable', reason: 'advisory_response' };
  }
  // A response that is not blocking-eligible must never be written to cache:
  // the read policy unconditionally bypasses any cached entry with
  // blockingEligible === false (reason: 'cached_not_blocking_eligible').
  // Writing such entries wastes cache capacity and Redis bandwidth.
  if (input.blockingEligible === false) {
    return { eligibility: 'non_cacheable', reason: 'not_blocking_eligible' };
  }
  if (input.snapshotId === undefined || input.snapshotId === '') {
    return { eligibility: 'non_cacheable', reason: 'missing_snapshot_id' };
  }
  return { eligibility: 'cacheable_but_snapshot_bound' };
}

function recordMismatch(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (left[key] !== right[key]) {
      return true;
    }
  }
  return false;
}

export function decideResponseCacheReadPolicy(input: {
  cachedExecutionMode: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
  cachedBlockingEligible?: boolean;
  cachedSnapshotId?: string;
  cachedContractVersion?: string;
  cachedModelVersions?: Readonly<Record<string, string>>;
  currentSnapshotId: string;
  currentContractVersion: string;
  currentModelVersions?: Readonly<Record<string, string>>;
  runtimeState?: CacheReadRuntimeState;
}): ResponseCacheReadDecision {
  if (input.cachedBlockingEligible === false) {
    return { eligibility: 'bypass', reason: 'cached_not_blocking_eligible' };
  }
  if (input.cachedExecutionMode === 'degraded') {
    return { eligibility: 'bypass', reason: 'cached_execution_mode_degraded' };
  }
  if (input.cachedExecutionMode === 'heuristic') {
    return { eligibility: 'bypass', reason: 'cached_execution_mode_heuristic' };
  }
  if (input.cachedExecutionMode === 'advisory') {
    return { eligibility: 'bypass', reason: 'cached_execution_mode_advisory' };
  }
  if (input.cachedSnapshotId === undefined || input.cachedSnapshotId === '') {
    return { eligibility: 'bypass', reason: 'missing_cached_snapshot_id' };
  }
  if (input.cachedContractVersion === undefined || input.cachedContractVersion === '') {
    return { eligibility: 'bypass', reason: 'missing_cached_contract_version' };
  }
  if (input.runtimeState?.learningKillSwitchEnabled === true) {
    return { eligibility: 'bypass', reason: 'learning_disabled' };
  }
  if (input.runtimeState?.denseRetrievalEnabled === false) {
    return { eligibility: 'bypass', reason: 'dense_retrieval_disabled' };
  }
  if (input.runtimeState?.rerankerAvailable === false) {
    return { eligibility: 'bypass', reason: 'reranker_unavailable' };
  }
  if (
    input.runtimeState?.currentExecutionModeHint !== undefined &&
    input.runtimeState.currentExecutionModeHint !== 'authoritative'
  ) {
    return { eligibility: 'bypass', reason: 'runtime_degraded' };
  }
  if (input.cachedContractVersion !== input.currentContractVersion) {
    return { eligibility: 'bypass', reason: 'contract_version_drift' };
  }
  if (
    (input.currentModelVersions !== undefined && input.cachedModelVersions === undefined) ||
    (input.cachedModelVersions !== undefined && input.currentModelVersions === undefined)
  ) {
    return { eligibility: 'bypass', reason: 'model_version_drift' };
  }
  if (
    input.cachedModelVersions !== undefined
    && input.currentModelVersions !== undefined
    && recordMismatch(input.cachedModelVersions, input.currentModelVersions)
  ) {
    return { eligibility: 'bypass', reason: 'model_version_drift' };
  }
  if (input.cachedSnapshotId !== input.currentSnapshotId) {
    return { eligibility: 'bypass', reason: 'snapshot_id_drift' };
  }
  return { eligibility: 'cache_hit' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache-policy distribution counter (maturity 3 observability).
//
// Rationale: write/read decisions above are pure functions, which makes them
// trivial to test but invisible to ops. Without a tally, "what fraction of
// authoritative responses are skipping the cache because of model drift?"
// requires log-grepping. This module-scoped counter mirrors the
// silent-skip-counters pattern: callers record each decision, ops snapshot
// the totals via `getStats()` / `getReadStats()`.
//
// The counter is intentionally injectable (factory + global singleton) so
// tests can isolate state without depending on the global.
// ─────────────────────────────────────────────────────────────────────────────

export interface CachePolicyWriteStats {
  readonly evaluations: number;
  readonly eligible_count: number;
  readonly ineligible_count: number;
  readonly by_reason: Readonly<Record<ResponseCachePolicyReason, number>>;
}

export interface CachePolicyReadStats {
  readonly evaluations: number;
  readonly hit_count: number;
  readonly bypass_count: number;
  readonly by_reason: Readonly<Record<ResponseCacheReadBypassReason, number>>;
}

export interface CachePolicyDistributionCounter {
  recordWriteDecision(decision: CachePolicyDecision): void;
  recordReadDecision(decision: ResponseCacheReadDecision): void;
  getStats(): CachePolicyWriteStats;
  getReadStats(): CachePolicyReadStats;
  reset(): void;
}

function zeroedWriteByReason(): Record<ResponseCachePolicyReason, number> {
  const out = {} as Record<ResponseCachePolicyReason, number>;
  for (const reason of RESPONSE_CACHE_POLICY_REASONS) {
    out[reason] = 0;
  }
  return out;
}

function zeroedReadByReason(): Record<ResponseCacheReadBypassReason, number> {
  const out = {} as Record<ResponseCacheReadBypassReason, number>;
  for (const reason of RESPONSE_CACHE_READ_BYPASS_REASONS) {
    out[reason] = 0;
  }
  return out;
}

export function createCachePolicyDistributionCounter(): CachePolicyDistributionCounter {
  let writeEvaluations = 0;
  let writeEligible = 0;
  let writeIneligible = 0;
  const writeByReason = zeroedWriteByReason();

  let readEvaluations = 0;
  let readHits = 0;
  let readBypass = 0;
  const readByReason = zeroedReadByReason();

  return {
    recordWriteDecision(decision) {
      writeEvaluations += 1;
      if (decision.eligibility === 'non_cacheable') {
        writeIneligible += 1;
        if (decision.reason !== undefined) {
          writeByReason[decision.reason] += 1;
        }
      } else {
        writeEligible += 1;
      }
    },
    recordReadDecision(decision) {
      readEvaluations += 1;
      if (decision.eligibility === 'cache_hit') {
        readHits += 1;
      } else {
        readBypass += 1;
        if (decision.reason !== undefined) {
          readByReason[decision.reason] += 1;
        }
      }
    },
    getStats() {
      return Object.freeze({
        evaluations: writeEvaluations,
        eligible_count: writeEligible,
        ineligible_count: writeIneligible,
        by_reason: Object.freeze({ ...writeByReason }),
      });
    },
    getReadStats() {
      return Object.freeze({
        evaluations: readEvaluations,
        hit_count: readHits,
        bypass_count: readBypass,
        by_reason: Object.freeze({ ...readByReason }),
      });
    },
    reset() {
      writeEvaluations = 0;
      writeEligible = 0;
      writeIneligible = 0;
      for (const reason of RESPONSE_CACHE_POLICY_REASONS) {
        writeByReason[reason] = 0;
      }
      readEvaluations = 0;
      readHits = 0;
      readBypass = 0;
      for (const reason of RESPONSE_CACHE_READ_BYPASS_REASONS) {
        readByReason[reason] = 0;
      }
    },
  };
}

/**
 * Process-wide shared counter. Production code paths that already call
 * `decideResponseCachePolicy` / `decideResponseCacheReadPolicy` should
 * additionally call the matching `recordResponseCache*Decision` helper to
 * keep ops dashboards populated. Tests that need isolation should use
 * `createCachePolicyDistributionCounter()` or call `.reset()` in setup.
 */
export const globalCachePolicyDistributionCounter: CachePolicyDistributionCounter =
  createCachePolicyDistributionCounter();

export function recordResponseCachePolicyDecision(
  decision: CachePolicyDecision,
  counter: CachePolicyDistributionCounter = globalCachePolicyDistributionCounter,
): void {
  counter.recordWriteDecision(decision);
}

export function recordResponseCacheReadDecision(
  decision: ResponseCacheReadDecision,
  counter: CachePolicyDistributionCounter = globalCachePolicyDistributionCounter,
): void {
  counter.recordReadDecision(decision);
}
