/**
 * PostgreSQL adapter for LTR model registry persistence.
 *
 * Epic 4: LambdaMART learning-to-rank training pipeline
 * Stores trained per-query-class models and their metadata.
 */

import { nanoid } from 'nanoid';
import type { Pool } from 'pg';
import type { QueryClassWeights } from '../../domain/ranking/index.js';
import type { QueryClass } from '../../domain/shared/types/index.js';

/**
 * Row shape in ltr_model_registry table.
 */
interface LtrModelRow {
  registry_id: string;
  query_class: string;
  weights: number[];
  bias: number;
  training_example_count: number;
  ndcg5_validation_score: number;
  trained_at: Date;
  created_at: Date;
}

/**
 * Port for storing and retrieving trained LTR models.
 */
export interface LtrModelRegistryPort {
  /**
   * Saves a trained model for a query class.
   * Overwrites any existing model for that class.
   */
  saveModel(queryClass: QueryClass, weights: QueryClassWeights): Promise<void>;

  /**
   * Retrieves the latest trained model for a query class.
   */
  getModel(queryClass: QueryClass): Promise<QueryClassWeights | null>;

  /**
   * Retrieves all trained models.
   */
  getAllModels(): Promise<ReadonlyMap<string, QueryClassWeights>>;

  /**
   * Deletes all models (for testing/retraining).
   */
  clearAllModels(): Promise<void>;
}

/**
 * PostgreSQL-backed LTR model registry.
 *
 * Stores trained LambdaMART models for each query class with:
 * - Feature weights (normalized, length 8)
 * - Bias term
 * - Training metadata (example count, validation NDCG@5)
 * - Timestamp for versioning
 */
export class PgLtrModelRegistry implements LtrModelRegistryPort {
  constructor(private readonly pool: Pool) {}

  async saveModel(queryClass: QueryClass, weights: QueryClassWeights): Promise<void> {
    const registryId = nanoid();
    await this.pool.query(
      `INSERT INTO ltr_model_registry (
        registry_id, query_class, weights, bias,
        training_example_count, ndcg5_validation_score, trained_at, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (query_class) DO UPDATE SET
        registry_id = EXCLUDED.registry_id,
        weights = EXCLUDED.weights,
        bias = EXCLUDED.bias,
        training_example_count = EXCLUDED.training_example_count,
        ndcg5_validation_score = EXCLUDED.ndcg5_validation_score,
        trained_at = EXCLUDED.trained_at,
        created_at = EXCLUDED.created_at`,
      [
        registryId,
        queryClass,
        weights.weights as number[],
        weights.bias,
        weights.trainingExampleCount,
        weights.ndcg5ValidationScore,
        weights.trainedAt,
        new Date(),
      ],
    );
  }

  async getModel(queryClass: QueryClass): Promise<QueryClassWeights | null> {
    const result = await this.pool.query<LtrModelRow>(
      `SELECT * FROM ltr_model_registry
       WHERE query_class = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [queryClass],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      queryClass: row.query_class,
      weights: row.weights,
      bias: row.bias,
      trainingExampleCount: row.training_example_count,
      ndcg5ValidationScore: row.ndcg5_validation_score,
      trainedAt: row.trained_at,
    };
  }

  async getAllModels(): Promise<ReadonlyMap<string, QueryClassWeights>> {
    const result = await this.pool.query<LtrModelRow>(
      `SELECT DISTINCT ON (query_class) * FROM ltr_model_registry
       ORDER BY query_class, created_at DESC`,
    );

    const models = new Map<string, QueryClassWeights>();
    for (const row of result.rows) {
      models.set(row.query_class, {
        queryClass: row.query_class,
        weights: row.weights,
        bias: row.bias,
        trainingExampleCount: row.training_example_count,
        ndcg5ValidationScore: row.ndcg5_validation_score,
        trainedAt: row.trained_at,
      });
    }

    return models;
  }

  async clearAllModels(): Promise<void> {
    await this.pool.query(`DELETE FROM ltr_model_registry`);
  }
}
