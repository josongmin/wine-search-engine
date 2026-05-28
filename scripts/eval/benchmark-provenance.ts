import fs from 'node:fs/promises';
import type {
  EvalBenchmarkKind,
  EvalBenchmarkRunProvenance,
} from '../../src/domain/evaluation/model/eval-benchmark-run.js';
import { hashStableJson, hashText } from '../../src/domain/shared/utils/stable-json.js';

export interface EvalBenchmarkReportProvenance {
  readonly benchmark_kind: EvalBenchmarkKind;
  readonly provenance_schema_version: 1;
  readonly corpus_id: string;
  readonly corpus_hash: string;
  readonly runtime_target: string;
  readonly uses_live_api: boolean;
  readonly smoke_synthesized: boolean;
  readonly threshold_source: string;
  readonly gate_eligible: boolean;
  readonly suite_gate_passed: boolean;
  readonly search_snapshot_id: string | null;
  readonly runtime_activation_status: string | null;
  readonly readiness_passed: boolean | null;
  readonly active_ltr_models: number | null;
  readonly dense_retrieval_enabled?: boolean | null;
  readonly query_embedding_model?: string | null;
  readonly query_embedding_model_version?: string | null;
  readonly embedding_sensitive_eval?: boolean;
  readonly label_tier_mix?: Readonly<Record<string, number>> | undefined;
  readonly slice_mix?: Readonly<Record<string, number>> | undefined;
  readonly query_class_mix?: Readonly<Record<string, number>> | undefined;
  readonly feature_schema_hash: string;
  readonly comparison_compatibility_key: string;
  readonly run_provenance_key: string;
}

export async function hashFileUtf8(path: string): Promise<string> {
  const content = await fs.readFile(path, 'utf8');
  return hashText(content);
}

export function countStringMix(values: readonly string[]): Readonly<Record<string, number>> | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function buildComparisonCompatibilityKey(args: {
  readonly benchmarkKind: EvalBenchmarkKind;
  readonly provenance: EvalBenchmarkRunProvenance;
}): string {
  return hashStableJson({
    benchmarkKind: args.benchmarkKind,
    corpusHash: args.provenance.corpusHash,
    runtimeTarget: args.provenance.runtimeTarget,
    usesLiveApi: args.provenance.usesLiveApi,
    thresholdSource: args.provenance.thresholdSource,
    gateEligible: args.provenance.gateEligible,
    denseRetrievalEnabled: args.provenance.denseRetrievalEnabled ?? null,
    queryEmbeddingModel: args.provenance.queryEmbeddingModel ?? null,
    queryEmbeddingModelVersion: args.provenance.queryEmbeddingModelVersion ?? null,
    embeddingSensitiveEval: args.provenance.embeddingSensitiveEval ?? false,
  });
}

export function buildRunProvenanceKey(args: {
  readonly benchmarkKind: EvalBenchmarkKind;
  readonly provenance: EvalBenchmarkRunProvenance;
  readonly featureSchemaHash: string;
}): string {
  return hashStableJson({
    comparisonCompatibilityKey: buildComparisonCompatibilityKey(args),
    searchSnapshotId: args.provenance.searchSnapshotId ?? null,
    featureSchemaHash: args.featureSchemaHash,
    runtimeActivationStatus: args.provenance.runtimeActivationStatus ?? null,
    readinessPassed: args.provenance.readinessPassed ?? null,
    activeLtrModels: args.provenance.activeLtrModels ?? null,
    denseRetrievalEnabled: args.provenance.denseRetrievalEnabled ?? null,
    queryEmbeddingModel: args.provenance.queryEmbeddingModel ?? null,
    queryEmbeddingModelVersion: args.provenance.queryEmbeddingModelVersion ?? null,
    embeddingSensitiveEval: args.provenance.embeddingSensitiveEval ?? false,
    smokeSynthesized: args.provenance.smokeSynthesized,
  });
}

export function toReportProvenance(args: {
  readonly benchmarkKind: EvalBenchmarkKind;
  readonly provenance: EvalBenchmarkRunProvenance;
  readonly featureSchemaHash: string;
}): EvalBenchmarkReportProvenance {
  return {
    benchmark_kind: args.benchmarkKind,
    provenance_schema_version: args.provenance.provenanceSchemaVersion,
    corpus_id: args.provenance.corpusId,
    corpus_hash: args.provenance.corpusHash,
    runtime_target: args.provenance.runtimeTarget,
    uses_live_api: args.provenance.usesLiveApi,
    smoke_synthesized: args.provenance.smokeSynthesized,
    threshold_source: args.provenance.thresholdSource,
    gate_eligible: args.provenance.gateEligible,
    suite_gate_passed: args.provenance.suiteGatePassed,
    search_snapshot_id: args.provenance.searchSnapshotId ?? null,
    runtime_activation_status: args.provenance.runtimeActivationStatus ?? null,
    readiness_passed: args.provenance.readinessPassed ?? null,
    active_ltr_models: args.provenance.activeLtrModels ?? null,
    ...(args.provenance.denseRetrievalEnabled !== undefined
      ? { dense_retrieval_enabled: args.provenance.denseRetrievalEnabled }
      : {}),
    ...(args.provenance.queryEmbeddingModel !== undefined
      ? { query_embedding_model: args.provenance.queryEmbeddingModel }
      : {}),
    ...(args.provenance.queryEmbeddingModelVersion !== undefined
      ? { query_embedding_model_version: args.provenance.queryEmbeddingModelVersion }
      : {}),
    ...(args.provenance.embeddingSensitiveEval !== undefined
      ? { embedding_sensitive_eval: args.provenance.embeddingSensitiveEval }
      : {}),
    ...(args.provenance.labelTierMix !== undefined ? { label_tier_mix: args.provenance.labelTierMix } : {}),
    ...(args.provenance.sliceMix !== undefined ? { slice_mix: args.provenance.sliceMix } : {}),
    ...(args.provenance.queryClassMix !== undefined ? { query_class_mix: args.provenance.queryClassMix } : {}),
    feature_schema_hash: args.featureSchemaHash,
    comparison_compatibility_key: buildComparisonCompatibilityKey(args),
    run_provenance_key: buildRunProvenanceKey(args),
  };
}
