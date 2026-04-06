export type CacheEligibility =
  | 'cacheable'
  | 'non_cacheable'
  | 'cacheable_but_snapshot_bound';

export interface CachePolicyDecision {
  eligibility: CacheEligibility;
  reason?: string;
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
  if (input.snapshotId === undefined || input.snapshotId === '') {
    return { eligibility: 'non_cacheable', reason: 'missing_snapshot_id' };
  }
  return { eligibility: 'cacheable_but_snapshot_bound' };
}
