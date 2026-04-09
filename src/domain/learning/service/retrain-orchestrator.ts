/**
 * Retrain orchestrator (Epic-18 closed-loop core, T18-6).
 *
 * Glues click-event ingestion to model registry promotion:
 *
 *   feedback events
 *     → position debias (IPS)
 *     → training data extraction
 *     → (STUB) train new model
 *     → compare offline metrics vs current active
 *     → register + activate if improvement >= minNdcgImprovement
 *
 * The actual training step is intentionally a stub — real training lives
 * in an offline pipeline (Python LTR, etc.) scheduled outside this process.
 * This orchestrator owns the JavaScript-side glue: cooldown enforcement,
 * data shaping, metric comparison, registry writes, and structured
 * result reporting for alerting / audit logs. The artifact payload is a
 * framework-agnostic placeholder — callers treat it as an opaque blob
 * keyed by modelId/version.
 */

import type { FeedbackEvent } from '../../feedback/model/feedback-event.js';
import { computeDebiasedRelevance, PositionBasedExaminationModel } from '../../feedback/service/position-debias.js';
import { extractTrainingData } from '../../feedback/service/training-data-extractor.js';
import type { ModelArtifact, ModelTrainingMetrics } from '../model/model-registry-entry.js';
import type { ModelRegistryPort } from '../port/model-registry.port.js';

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const MS_PER_SECOND = 1000;
/** Hours-to-milliseconds conversion (avoids magic multiplier in cooldown check). */
const MS_PER_HOUR = SECONDS_PER_MINUTE * MINUTES_PER_HOUR * MS_PER_SECOND;
/** Decimal places for ndcg/mrr formatting in result reason strings.
 *  4 places resolves up to 0.0001 differences which matches the typical
 *  improvement granularity of LambdaMART runs on the gold split. */
const METRIC_FORMAT_DECIMALS = 4;

/**
 * Placeholder offline metrics for the training stub. The real Python LTR
 * pipeline emits fitted values; these constants yield a deterministic,
 * slightly-improved score relative to {@link STUB_CURRENT_METRICS} so the
 * orchestrator's "promote on improvement" branch is observable in tests
 * until the Python side is wired.
 */
const STUB_NEW_NDCG_AT_10 = 0.72;
const STUB_NEW_MRR = 0.61;

/** Minimum training samples the stub requires before it claims "success". */
const STUB_MIN_SAMPLES_GUARD = 1;

export interface RetrainConfig {
  /** Minimum number of feedback events before retraining is allowed. */
  readonly minEventsForRetrain: number;
  /** Minimum NDCG@10 improvement vs current active model to promote. */
  readonly minNdcgImprovement: number;
  /** Minimum hours between retrains. */
  readonly minHoursBetweenRetrains: number;
}

export interface RetrainResult {
  readonly status: 'success' | 'insufficient_data' | 'no_improvement' | 'failed';
  readonly trainSampleCount: number;
  readonly newModelMetrics?: {
    readonly ndcg_at_10: number;
    readonly mrr: number;
  };
  readonly currentModelMetrics?: {
    readonly ndcg_at_10: number;
    readonly mrr: number;
  };
  readonly reason: string;
}

/**
 * Minimal shape the orchestrator needs from the feedback collector. The
 * real adapter returns `readonly FeedbackEvent[]`; the port is duck-typed
 * as `unknown[]` here so tests and alt implementations don't need to
 * satisfy the full `FeedbackCollectorPort` contract.
 */
export interface FeedbackCollectorReader {
  getAll(): readonly unknown[];
}

function isFeedbackEvent(x: unknown): x is FeedbackEvent {
  if (x === null || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.eventId === 'string' &&
    typeof e.eventType === 'string' &&
    typeof e.timestamp === 'number' &&
    typeof e.requestId === 'string' &&
    typeof e.query === 'string' &&
    typeof e.position === 'number' &&
    typeof e.entityId === 'string'
  );
}

/** Factory for the stub training step — returns deterministic metrics. */
function stubTrain(trainSampleCount: number): ModelTrainingMetrics {
  return {
    ndcg_at_10: STUB_NEW_NDCG_AT_10,
    mrr: STUB_NEW_MRR,
    trainSampleCount,
  };
}

export class RetrainOrchestrator {
  private lastRetrainAt: number | null = null;

  constructor(
    private readonly feedbackCollector: FeedbackCollectorReader,
    private readonly registry: ModelRegistryPort,
    private readonly config: RetrainConfig,
  ) {}

  async run(now: number): Promise<RetrainResult> {
    if (!Number.isFinite(now)) {
      return {
        status: 'failed',
        trainSampleCount: 0,
        reason: 'invalid clock (now is not finite)',
      };
    }

    // --- Cooldown check --------------------------------------------------
    if (this.lastRetrainAt !== null) {
      const elapsedMs = now - this.lastRetrainAt;
      const requiredMs = this.config.minHoursBetweenRetrains * MS_PER_HOUR;
      if (Number.isFinite(elapsedMs) && elapsedMs < requiredMs) {
        const remainingHours = (requiredMs - elapsedMs) / MS_PER_HOUR;
        return {
          status: 'insufficient_data',
          trainSampleCount: 0,
          reason: `cooldown active: ${remainingHours.toFixed(2)}h remaining before next retrain allowed`,
        };
      }
    }

    // --- Pull events -----------------------------------------------------
    // Wrap collector access in try/catch: a failing collector (DB unreachable,
    // S3 timeout, etc.) must NOT crash the orchestrator — return 'failed' so
    // the cron driver can log + retry on the next tick instead of dying.
    let raw: readonly unknown[];
    try {
      raw = this.feedbackCollector.getAll();
    } catch (err: unknown) {
      return {
        status: 'failed',
        trainSampleCount: 0,
        reason: `feedback collector failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const events: FeedbackEvent[] = [];
    for (const r of raw) {
      if (isFeedbackEvent(r)) events.push(r);
    }

    if (events.length < this.config.minEventsForRetrain) {
      return {
        status: 'insufficient_data',
        trainSampleCount: 0,
        reason: `only ${events.length} events available (need >= ${this.config.minEventsForRetrain})`,
      };
    }

    // --- Debias + dataset ------------------------------------------------
    const examinationModel = new PositionBasedExaminationModel();
    const debiased = computeDebiasedRelevance(events, examinationModel);
    const dataset = extractTrainingData(events, debiased, { now: () => now });
    const trainSampleCount = dataset.examples.length;

    if (trainSampleCount < STUB_MIN_SAMPLES_GUARD) {
      return {
        status: 'insufficient_data',
        trainSampleCount,
        reason: `extracted training dataset is empty (events=${events.length}, debiased=${debiased.length})`,
      };
    }

    // --- Train (STUB) ----------------------------------------------------
    let newMetrics: ModelTrainingMetrics;
    try {
      newMetrics = stubTrain(trainSampleCount);
    } catch (err) {
      return {
        status: 'failed',
        trainSampleCount,
        reason: `training stub threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!Number.isFinite(newMetrics.ndcg_at_10) || !Number.isFinite(newMetrics.mrr)) {
      return {
        status: 'failed',
        trainSampleCount,
        reason: 'training stub produced non-finite metrics',
      };
    }

    // --- Compare vs current active --------------------------------------
    const currentEntry = await this.registry.getActive();
    const currentMetrics = currentEntry?.artifact.trainingMetrics;

    if (currentMetrics !== undefined) {
      const improvement = newMetrics.ndcg_at_10 - currentMetrics.ndcg_at_10;
      if (!Number.isFinite(improvement) || improvement < this.config.minNdcgImprovement) {
        this.lastRetrainAt = now;
        return {
          status: 'no_improvement',
          trainSampleCount,
          newModelMetrics: { ndcg_at_10: newMetrics.ndcg_at_10, mrr: newMetrics.mrr },
          currentModelMetrics: { ndcg_at_10: currentMetrics.ndcg_at_10, mrr: currentMetrics.mrr },
          reason: `ndcg improvement ${improvement.toFixed(METRIC_FORMAT_DECIMALS)} < required ${this.config.minNdcgImprovement.toFixed(METRIC_FORMAT_DECIMALS)}`,
        };
      }
    }

    // --- Register + activate --------------------------------------------
    const artifact = this.buildStubArtifact(now, newMetrics);
    try {
      await this.registry.register(artifact);
      await this.registry.activate(artifact.modelId, artifact.version);
    } catch (err) {
      return {
        status: 'failed',
        trainSampleCount,
        newModelMetrics: { ndcg_at_10: newMetrics.ndcg_at_10, mrr: newMetrics.mrr },
        ...(currentMetrics !== undefined
          ? { currentModelMetrics: { ndcg_at_10: currentMetrics.ndcg_at_10, mrr: currentMetrics.mrr } }
          : {}),
        reason: `registry write failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    this.lastRetrainAt = now;
    return {
      status: 'success',
      trainSampleCount,
      newModelMetrics: { ndcg_at_10: newMetrics.ndcg_at_10, mrr: newMetrics.mrr },
      ...(currentMetrics !== undefined
        ? { currentModelMetrics: { ndcg_at_10: currentMetrics.ndcg_at_10, mrr: currentMetrics.mrr } }
        : {}),
      reason:
        currentMetrics === undefined
          ? 'promoted (no prior active model)'
          : `promoted (ndcg +${(newMetrics.ndcg_at_10 - currentMetrics.ndcg_at_10).toFixed(METRIC_FORMAT_DECIMALS)})`,
    };
  }

  /**
   * Assemble a placeholder artifact around the stub metrics. The `model`
   * field is an opaque, framework-agnostic payload — enough to satisfy
   * the type contract; a real offline training pipeline replaces it
   * with the serialized model blob (booster JSON, weights, etc.).
   */
  private buildStubArtifact(now: number, metrics: ModelTrainingMetrics): ModelArtifact {
    const version = `stub-${now}`;
    return {
      modelId: 'ltr-stub',
      version,
      trainedAt: now,
      featureSchemaHash: 'stub-schema-hash',
      model: {
        modelId: 'ltr-stub',
        version,
        payload: {},
      },
      trainingMetrics: metrics,
    };
  }
}
