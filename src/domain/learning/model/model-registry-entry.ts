/**
 * Model registry artifact + entry shapes (Epic-18 closed-loop core, T18-6).
 *
 * A `ModelArtifact` is the immutable output of an offline training run
 * plus the metadata needed to serve it in-process: a generic model blob
 * (framework-agnostic — LightGBM, XGBoost, or a learned linear ranker),
 * a feature schema hash for parity checks, and the offline training
 * metrics used by the retrain orchestrator to decide whether to promote
 * the new model. A `ModelRegistryEntry` layers lifecycle state
 * ('shadow' | 'active' | 'rolled_back') plus activation/rollback
 * timestamps on top of the artifact.
 *
 * NOTE: the concrete model shape used to be a LightGBM Zod-validated
 * object. That foundation was deleted because no learning pipeline,
 * click log, or gold split existed to feed it (see
 * `docs/bugbash/2026-04-09-foundation-code-inventory.md` REMOVED
 * section). The placeholder below keeps the registry + retrain
 * orchestrator alive as a generic, framework-agnostic flow so future
 * LTR work can slot a typed model back in without reshaping callers.
 */

export interface ModelTrainingMetrics {
  readonly ndcg_at_10: number;
  readonly mrr: number;
  readonly trainSampleCount: number;
}

/**
 * Generic serialized model payload. The shape is intentionally opaque
 * — callers treat it as an immutable blob keyed by `modelId`/`version`.
 * A future LTR integration can narrow this to a concrete schema once
 * a real training pipeline exists.
 */
export interface SerializedModelPayload {
  readonly modelId: string;
  readonly version: string;
  /** Free-form payload produced by the offline trainer (booster JSON, weights, etc.). */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ModelArtifact {
  readonly modelId: string;
  readonly version: string;
  readonly trainedAt: number;
  readonly featureSchemaHash: string;
  readonly model: SerializedModelPayload;
  readonly trainingMetrics: ModelTrainingMetrics;
}

export type ModelRegistryStatus = 'active' | 'shadow' | 'rolled_back';

export interface ModelRegistryEntry {
  readonly artifact: ModelArtifact;
  readonly status: ModelRegistryStatus;
  readonly activatedAt?: number;
  readonly rolledBackAt?: number;
  readonly rollbackReason?: string;
}
