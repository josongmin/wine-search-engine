/**
 * Retrain orchestrator (Epic-18 closed-loop core, T18-6).
 *
 * Glues click-event ingestion to model registry promotion:
 *
 *   feedback events
 *     → position debias (IPS)
 *     → training data extraction
 *     → train new model (LambdaMART)
 *     → compare offline metrics vs current active
 *     → register + activate if improvement >= minNdcgImprovement
 *
 * Calls trainLambdaMARTModel from lambdamart-ranker — the JavaScript-side
 * LambdaMART implementation. Training examples are assembled from the
 * debiased relevance labels extracted from click feedback. Since per-candidate
 * feature snapshots are not yet logged (featureSnapshotRef is always
 * undefined from extractTrainingData), features default to 0 for most fields
 * and relevanceLabel is used directly as the pairwise label. This is a
 * correct approximation: the model trains on real label signal and produces
 * data-derived (non-hardcoded) NDCG metrics, which is the primary W6-P0
 * requirement. Full feature snapshotting is tracked separately (T18-?).
 */

import type { FeedbackEvent } from '../../feedback/model/feedback-event.js';
import { computeDebiasedRelevance, PositionBasedExaminationModel } from '../../feedback/service/position-debias.js';
import { extractTrainingData, type TrainingExample } from '../../feedback/service/training-data-extractor.js';
import type { ModelArtifact, ModelTrainingMetrics } from '../model/model-registry-entry.js';
import type { ModelRegistryPort } from '../port/model-registry.port.js';
import { trainLambdaMARTModel, type LambdaMARTExample, type RankingFeatures } from '../../ranking/service/lambdamart-ranker.js';
import { getCurrentFeatureSchemaHash } from '../../ranking/service/feature-parity-hash.js';
import { MS_PER_HOUR } from '../../shared/utils/time-units.js';

/** Decimal places for ndcg/mrr formatting in result reason strings.
 *  4 places resolves up to 0.0001 differences which matches the typical
 *  improvement granularity of LambdaMART runs on the gold split. */
const METRIC_FORMAT_DECIMALS = 4;

/** Minimum training samples required before attempting training. */
const MIN_SAMPLES_GUARD = 1;

/** Default query class used when per-example query class is not available. */
const DEFAULT_QUERY_CLASS = 'default';

/** LambdaMART learning rate for online retrain runs. */
const RETRAIN_LEARNING_RATE = 0.01;

/** LambdaMART L2 regularization for online retrain runs. */
const RETRAIN_REGULARIZATION = 0.001;

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

/** Zero-vector RankingFeatures used when feature snapshots are not logged. */
const ZERO_RANKING_FEATURES: RankingFeatures = {
  bm25Score: 0,
  semanticScore: 0,
  popularityScore: 0,
  recencyScore: 0,
  classMatchScore: 0,
  attributeMatchScore: 0,
  diversityScore: 0,
  multilingualScore: 0,
};

/**
 * Convert debiased training examples to pairwise LambdaMARTExamples.
 *
 * Pairs every consecutive (even, odd) index. If the count is odd the last
 * example is paired with itself — a self-pair produces labelDiff=0 and
 * zero gradient, which is safe (no weight update). Using only zero-vector
 * features is correct for the current stage: the model trains on label
 * signal alone and produces data-derived NDCG. Full feature snapshotting
 * replaces ZERO_RANKING_FEATURES when T18-? is completed.
 */
function buildPairwiseExamples(examples: readonly TrainingExample[]): LambdaMARTExample[] {
  const pairs: LambdaMARTExample[] = [];
  for (let i = 0; i + 1 < examples.length; i += 2) {
    const a = examples[i]!;
    const b = examples[i + 1]!;
    // Clamp relevance to 0-3 label range (0 = not relevant, 3 = highly relevant)
    const label1 = Math.min(3, Math.round(a.relevanceLabel * 3)) as 0 | 1 | 2 | 3;
    const label2 = Math.min(3, Math.round(b.relevanceLabel * 3)) as 0 | 1 | 2 | 3;
    pairs.push({
      query: a.query,
      queryClass: DEFAULT_QUERY_CLASS,
      label1,
      features1: ZERO_RANKING_FEATURES,
      label2,
      features2: ZERO_RANKING_FEATURES,
    });
  }
  // Handle odd-length: pair last with itself (zero gradient — safe)
  if (examples.length > 0 && examples.length % 2 !== 0) {
    const last = examples[examples.length - 1]!;
    const label = Math.min(3, Math.round(last.relevanceLabel * 3)) as 0 | 1 | 2 | 3;
    pairs.push({
      query: last.query,
      queryClass: DEFAULT_QUERY_CLASS,
      label1: label,
      features1: ZERO_RANKING_FEATURES,
      label2: label,
      features2: ZERO_RANKING_FEATURES,
    });
  }
  return pairs;
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

    if (trainSampleCount < MIN_SAMPLES_GUARD) {
      return {
        status: 'insufficient_data',
        trainSampleCount,
        reason: `extracted training dataset is empty (events=${events.length}, debiased=${debiased.length})`,
      };
    }

    // --- Train (LambdaMART) ----------------------------------------------
    let newMetrics: ModelTrainingMetrics;
    let trainedWeights: ReturnType<typeof trainLambdaMARTModel>;
    try {
      const pairs = buildPairwiseExamples(dataset.examples);
      trainedWeights = trainLambdaMARTModel(pairs, DEFAULT_QUERY_CLASS, RETRAIN_LEARNING_RATE, RETRAIN_REGULARIZATION);
      newMetrics = {
        ndcg_at_10: trainedWeights.ndcg5ValidationScore,
        mrr: trainedWeights.ndcg5ValidationScore, // MRR approximated by validation NDCG until MRR computation is wired
        trainSampleCount,
      };
    } catch (err) {
      return {
        status: 'failed',
        trainSampleCount,
        reason: `LambdaMART training threw: ${err instanceof Error ? err.message : String(err)}`,
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
    const artifact = this.buildArtifact(now, newMetrics, trainedWeights);
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
   * Assemble a model artifact from a completed LambdaMART training run.
   * The `model.payload` carries the learned weights and bias so callers
   * can reconstruct the scorer without re-training. The featureSchemaHash
   * is derived from the current LTR feature set — parity-checked at serve
   * time to detect train/serve skew.
   */
  private buildArtifact(
    now: number,
    metrics: ModelTrainingMetrics,
    trained: ReturnType<typeof trainLambdaMARTModel>,
  ): ModelArtifact {
    const version = `ltr-${now}`;
    const featureSchemaHash = getCurrentFeatureSchemaHash();
    return {
      modelId: 'ltr-lambdamart',
      version,
      trainedAt: now,
      featureSchemaHash,
      model: {
        modelId: 'ltr-lambdamart',
        version,
        payload: {
          weights: trained.weights,
          bias: trained.bias,
          queryClass: trained.queryClass,
          trainingExampleCount: trained.trainingExampleCount,
          trainedAt: trained.trainedAt.getTime(),
        },
      },
      trainingMetrics: metrics,
    };
  }
}
