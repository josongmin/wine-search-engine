export type EvalBenchmarkKind =
  | 'noisy_entity'
  | 'offline_eval'
  | 'entity_retrieval_fixture'
  | 'search_feature_behavior_fixture'
  | 'agentic_tool_use_fixture';

export interface EvalBenchmarkRun {
  readonly runId: string;
  readonly benchmarkKind: EvalBenchmarkKind;
  readonly snapshotId?: string | undefined;
  readonly evalDatasetVersion: string;
  readonly featureSchemaHash: string;
  readonly queryCount: number;
  readonly recallAt1?: number;
  readonly recallAt3?: number;
  readonly mrr?: number;
  readonly falseExactRate?: number;
  readonly releaseGatePassed: boolean;
  readonly activationStatus: 'activated' | 'shadow_only';
  readonly report: Readonly<Record<string, unknown>>;
  /** runner별 queryable key-value 메트릭 */
  readonly metrics?: Readonly<Record<string, number>> | undefined;
  readonly createdAt: Date;
}

export interface EvalBenchmarkRunInput {
  readonly benchmarkKind: EvalBenchmarkKind;
  readonly snapshotId?: string | undefined;
  readonly evalDatasetVersion: string;
  readonly featureSchemaHash: string;
  readonly queryCount: number;
  readonly recallAt1?: number;
  readonly recallAt3?: number;
  readonly mrr?: number;
  readonly falseExactRate?: number;
  readonly releaseGatePassed: boolean;
  readonly activationStatus: 'activated' | 'shadow_only';
  readonly report: Readonly<Record<string, unknown>>;
  /** runner별 queryable key-value 메트릭 */
  readonly metrics?: Readonly<Record<string, number>> | undefined;
  readonly createdAt?: Date;
}
