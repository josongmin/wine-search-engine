export type EvalBenchmarkKind =
  | 'noisy_entity'
  | 'offline_eval'
  | 'offline_eval_in_memory_regression'
  | 'offline_eval_live_runtime'
  | 'offline_eval_embedding_sensitive_live_runtime'
  | 'entity_retrieval_fixture'
  | 'search_feature_behavior_fixture'
  | 'search_feature_behavior_structural'
  | 'search_feature_behavior_live'
  | 'agentic_tool_use_fixture';

export type EvalBenchmarkRuntimeActivationStatus = 'activated' | 'shadow_only';

export interface EvalBenchmarkRunProvenance {
  readonly provenanceSchemaVersion: 1;
  readonly corpusId: string;
  readonly corpusHash: string;
  readonly runtimeTarget: string;
  readonly usesLiveApi: boolean;
  readonly smokeSynthesized: boolean;
  readonly thresholdSource: string;
  readonly gateEligible: boolean;
  readonly suiteGatePassed: boolean;
  readonly searchSnapshotId?: string | undefined;
  readonly runtimeActivationStatus?: EvalBenchmarkRuntimeActivationStatus | undefined;
  readonly readinessPassed?: boolean | undefined;
  readonly activeLtrModels?: number | undefined;
  readonly denseRetrievalEnabled?: boolean | undefined;
  readonly queryEmbeddingModel?: string | undefined;
  readonly queryEmbeddingModelVersion?: string | undefined;
  readonly embeddingSensitiveEval?: boolean | undefined;
  readonly labelTierMix?: Readonly<Record<string, number>> | undefined;
  readonly sliceMix?: Readonly<Record<string, number>> | undefined;
  readonly queryClassMix?: Readonly<Record<string, number>> | undefined;
}

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
  /** Legacy compatibility field: derived from provenance.gateEligible && provenance.suiteGatePassed. */
  readonly releaseGatePassed: boolean;
  readonly runtimeActivationStatus?: EvalBenchmarkRuntimeActivationStatus | undefined;
  readonly provenance?: EvalBenchmarkRunProvenance | undefined;
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
  readonly provenance: EvalBenchmarkRunProvenance;
  readonly report: Readonly<Record<string, unknown>>;
  /** runner별 queryable key-value 메트릭 */
  readonly metrics?: Readonly<Record<string, number>> | undefined;
  readonly createdAt?: Date;
}
