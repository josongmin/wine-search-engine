export type RerankerFailureReason =
  | 'timeout'
  | 'http_error'
  | 'parse_error'
  | 'unknown';

export interface RankingDegradationSignal {
  readonly executionMode: 'degraded' | 'heuristic' | 'advisory';
  readonly degradationReasons: readonly string[];
}

export interface RankerRuntimeSignal {
  readonly rerankerStatus: 'executed' | 'failed' | 'skipped';
  readonly rerankerFailureReason?: RerankerFailureReason | undefined;
  readonly degradation?: RankingDegradationSignal | undefined;
}
