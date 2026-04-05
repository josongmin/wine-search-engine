/**
 * BGE-M3 Fine-tuning Service (Simulation)
 *
 * Epic 6: BGE-M3 fine-tuning for wine domain
 * Simulates fine-tuning with synthetic loss computation
 */

/**
 * Training example: (query, positive_doc, negative_doc) triplet.
 */
export interface EmbeddingTriplet {
  readonly query: string;
  readonly positiveDoc: string;
  readonly negativeDoc: string;
  readonly domain?: string;
}

/**
 * Fine-tuned model checkpoint.
 */
export interface EmbeddingModelCheckpoint {
  readonly modelId: string;
  readonly baseModel: string;
  readonly config: FineTuningConfig;
  readonly metrics: ValidationMetrics;
  readonly trainedAt: Date;
  readonly epochsCompleted: number;
  readonly totalTokensProcessed: number;
}

/**
 * Fine-tuning configuration.
 */
export interface FineTuningConfig {
  readonly learningRate: number;
  readonly batchSize: number;
  readonly numEpochs: number;
  readonly warmupRatio: number;
  readonly maxLength: number;
  readonly tripletMargin: number;
  readonly dropoutRate: number;
  readonly temperature: number;
}

/**
 * Validation metrics during fine-tuning.
 */
export interface ValidationMetrics {
  readonly mrr10: number;
  readonly ndcg10: number;
  readonly recall50: number;
  readonly finalLoss: number;
  readonly improvementPercent: number;
}

/** Default fine-tuning configuration. */
export const DEFAULT_FINETUNING_CONFIG: FineTuningConfig = {
  learningRate: 1e-5,
  batchSize: 64,
  numEpochs: 3,
  warmupRatio: 0.1,
  maxLength: 512,
  tripletMargin: 0.3,
  dropoutRate: 0.1,
  temperature: 0.05,
};

/**
 * BGE-M3 Fine-tuner namespace.
 */
export namespace BGEM3Finetuner {
  /**
   * Fine-tunes BGE-M3 model on wine domain triplets (simulation).
   */
  export async function finetune(
    triplets: readonly EmbeddingTriplet[],
    config: FineTuningConfig = DEFAULT_FINETUNING_CONFIG,
    validationTriplets?: readonly EmbeddingTriplet[],
  ): Promise<EmbeddingModelCheckpoint> {
    if (triplets.length === 0) {
      throw new Error('No training triplets provided');
    }

    const startTime = Date.now();
    let totalTokensProcessed = 0;

    let bestValidationMetrics: ValidationMetrics | null = null;
    let finalMetrics: ValidationMetrics | null = null;

    console.warn(`🚀 Fine-tuning BGE-M3 (SIMULATION)`);
    console.warn(`   Training triplets: ${triplets.length}`);
    console.warn(`   Validation triplets: ${validationTriplets?.length ?? 0}`);

    for (let epoch = 0; epoch < config.numEpochs; epoch++) {
      const epochStartTime = Date.now();
      const numBatches = Math.ceil(triplets.length / config.batchSize);
      const tokensPerExample = 150;

      console.warn(`\n   Epoch ${epoch + 1}/${config.numEpochs}`);

      let epochLoss = 0;
      for (let batchIdx = 0; batchIdx < numBatches; batchIdx++) {
        const batchStart = batchIdx * config.batchSize;
        const batchEnd = Math.min(batchStart + config.batchSize, triplets.length);
        const batchSize = batchEnd - batchStart;

        const baselineLoss = 0.35;
        const epochFactor = Math.exp(-0.5 * (epoch + 1));
        const batchFactor = Math.exp(-0.01 * batchIdx);
        const batchLoss = baselineLoss * epochFactor * batchFactor * (0.8 + Math.random() * 0.4);

        epochLoss += batchLoss;
        totalTokensProcessed += batchSize * tokensPerExample;

        if (batchIdx % Math.max(1, Math.floor(numBatches / 5)) === 0) {
          const progress = ((batchIdx + 1) / numBatches * 100).toFixed(0);
          process.stdout.write(`\r     [${progress}%] Loss: ${batchLoss.toFixed(4)}`);
        }
      }

      const avgEpochLoss = epochLoss / numBatches;
      console.warn(`\n     Avg Loss: ${avgEpochLoss.toFixed(4)}`);

      if (validationTriplets && validationTriplets.length > 0) {
        const metrics = computeValidationMetrics(validationTriplets, epoch, avgEpochLoss);

        console.warn(`     Validation NDCG@10: ${metrics.ndcg10.toFixed(4)}`);
        console.warn(`     Validation MRR@10: ${metrics.mrr10.toFixed(4)}`);

        if (!bestValidationMetrics || metrics.ndcg10 > bestValidationMetrics.ndcg10) {
          bestValidationMetrics = metrics;
          console.warn(`     ✨ New best validation score!`);
        }

        finalMetrics = metrics;
      }

      const epochTimeMs = Date.now() - epochStartTime;
      const tokensPerSecond = (config.batchSize * numBatches * tokensPerExample) / (epochTimeMs / 1000);
      console.warn(
        `     Time: ${(epochTimeMs / 1000).toFixed(1)}s, Speed: ${(tokensPerSecond / 1000).toFixed(0)}k tokens/s`,
      );
    }

    const elapsedSeconds = (Date.now() - startTime) / 1000;

    const metricsForCheckpoint = bestValidationMetrics ??
      finalMetrics ?? {
        mrr10: 0.85,
        ndcg10: 0.82,
        recall50: 0.91,
        finalLoss: 0.15,
        improvementPercent: 14,
      };

    console.warn(`\n✅ Fine-tuning complete (${elapsedSeconds.toFixed(1)}s)`);
    console.warn(`   Total tokens processed: ${(totalTokensProcessed / 1e6).toFixed(1)}M`);

    return {
      modelId: `bge-m3-wine-${Date.now()}`,
      baseModel: 'bge-m3',
      config,
      metrics: metricsForCheckpoint,
      trainedAt: new Date(),
      epochsCompleted: config.numEpochs,
      totalTokensProcessed,
    };
  }

  /**
   * Simulates validation metrics computation.
   */
  function computeValidationMetrics(
    _triplets: readonly EmbeddingTriplet[],
    epoch: number,
    loss: number,
  ): ValidationMetrics {
    const baselineNdcg = 0.72;
    const baselineMrr = 0.78;

    const improvementPercent = Math.min(2 + epoch * 6, 14);
    const improvementFactor = 1 + improvementPercent / 100;
    const noise = (Math.random() - 0.5) * 0.02;

    return {
      ndcg10: baselineNdcg * improvementFactor + noise,
      mrr10: baselineMrr * improvementFactor + noise,
      recall50: Math.min(0.95, 0.85 * improvementFactor),
      finalLoss: loss,
      improvementPercent,
    };
  }

  /**
   * Creates wine-domain triplets from golden query evaluation data.
   */
  export function createWineTriplets(
    queries: Array<{ query: string; expectedEntityId: string; domain?: string }>,
    documents: Map<string, string>,
  ): EmbeddingTriplet[] {
    const triplets: EmbeddingTriplet[] = [];

    for (const q of queries) {
      const positiveDoc = documents.get(q.expectedEntityId);
      if (!positiveDoc) continue;

      const documentKeys = Array.from(documents.keys());
      for (let i = 0; i < 3; i++) {
        let negativeKey: string | undefined;
        do {
          const randomIndex = Math.floor(Math.random() * documentKeys.length);
          negativeKey = documentKeys[randomIndex];
        } while (!negativeKey || negativeKey === q.expectedEntityId);

        if (!negativeKey) continue;

        const negativeDoc = documents.get(negativeKey);
        if (!negativeDoc) continue;

        const triplet: EmbeddingTriplet = q.domain !== undefined
          ? {
              query: q.query,
              positiveDoc,
              negativeDoc,
              domain: q.domain,
            }
          : {
              query: q.query,
              positiveDoc,
              negativeDoc,
            };
        triplets.push(triplet);
      }
    }

    return triplets;
  }
}
