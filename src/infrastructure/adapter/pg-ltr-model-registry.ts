/**
 * PostgreSQL adapter for LTR model registry persistence.
 *
 * Epic 4: LambdaMART learning-to-rank training pipeline
 * Stores trained per-query-class models with versioning and rollback support.
 */

import { nanoid } from 'nanoid';
import type { Pool } from 'pg';
import type { QueryClassWeights } from '../../domain/ranking/index.js';

/**
 * Row shape in ltr_model_registry table.
 */
interface LtrModelRow {
  registry_id: string;
  query_class: string;
  model_version: number;
  is_active: boolean;
  weights: number[];
  bias: number;
  training_example_count: number;
  ndcg5_validation_score: number;
  trained_at: Date;
  created_at: Date;
}

/**
 * Port for storing and retrieving trained LTR models.
 *
 * Uses `string` for queryClass (not the branded QueryClass union) because
 * trainAllModels() returns Map<string, ...> and QueryClassWeights.queryClass
 * is typed as `string`.
 */
export interface LtrModelRegistryPort {
  /**
   * Saves a trained model for a query class.
   * Inserts a new version and marks it as active (deactivating prior versions).
   */
  saveModel(queryClass: string, weights: QueryClassWeights): Promise<void>;

  /**
   * Retrieves the active trained model for a query class.
   */
  getModel(queryClass: string): Promise<QueryClassWeights | null>;

  /**
   * Retrieves all active trained models.
   */
  getAllModels(): Promise<ReadonlyMap<string, QueryClassWeights>>;

  /**
   * Rolls back to the previous model version for a query class.
   * Returns true if rollback succeeded, false if no previous version exists.
   */
  rollbackModel(queryClass: string): Promise<boolean>;

  /**
   * Deletes all models (for testing/retraining).
   */
  clearAllModels(): Promise<void>;
}

/**
 * PostgreSQL-backed LTR model registry with versioning.
 *
 * Stores trained LambdaMART models for each query class with:
 * - Feature weights (normalized, length 8)
 * - Bias term
 * - Training metadata (example count, validation NDCG@5)
 * - Version tracking and rollback capability
 */
export class PgLtrModelRegistry implements LtrModelRegistryPort {
  constructor(private readonly pool: Pool) {}

  async saveModel(queryClass: string, weights: QueryClassWeights): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Deactivate current active model for this query class
      await client.query(
        `UPDATE ltr_model_registry SET is_active = FALSE
         WHERE query_class = $1 AND is_active = TRUE`,
        [queryClass],
      );

      // Determine next version number
      const versionResult = await client.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(model_version), 0) + 1 AS next_version
         FROM ltr_model_registry WHERE query_class = $1`,
        [queryClass],
      );
      const nextVersion = versionResult.rows[0]?.next_version ?? 1;

      // Insert new active version
      const registryId = nanoid();
      await client.query(
        `INSERT INTO ltr_model_registry (
          registry_id, query_class, model_version, is_active,
          weights, bias, training_example_count, ndcg5_validation_score, trained_at
        ) VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7, $8)`,
        [
          registryId,
          queryClass,
          nextVersion,
          Array.from(weights.weights),
          weights.bias,
          weights.trainingExampleCount,
          weights.ndcg5ValidationScore,
          weights.trainedAt,
        ],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getModel(queryClass: string): Promise<QueryClassWeights | null> {
    const result = await this.pool.query<LtrModelRow>(
      `SELECT * FROM ltr_model_registry
       WHERE query_class = $1 AND is_active = TRUE
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
      `SELECT * FROM ltr_model_registry WHERE is_active = TRUE`,
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

  async rollbackModel(queryClass: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Find the current active version
      const activeResult = await client.query<{ model_version: number }>(
        `SELECT model_version FROM ltr_model_registry
         WHERE query_class = $1 AND is_active = TRUE
         LIMIT 1`,
        [queryClass],
      );

      const activeVersion = activeResult.rows[0]?.model_version;
      if (activeVersion == null || activeVersion <= 1) {
        // No previous version to roll back to
        await client.query('ROLLBACK');
        return false;
      }

      // Deactivate current active version
      await client.query(
        `UPDATE ltr_model_registry SET is_active = FALSE
         WHERE query_class = $1 AND model_version = $2`,
        [queryClass, activeVersion],
      );

      // Activate the previous version. Find the actual latest version below
      // the active one — do NOT assume contiguous (version N-1 may have been
      // deleted by clearAllModels or manual DB intervention).
      const prevResult = await client.query<{ model_version: number }>(
        `SELECT model_version FROM ltr_model_registry
         WHERE query_class = $1 AND model_version < $2
         ORDER BY model_version DESC LIMIT 1`,
        [queryClass, activeVersion],
      );
      const prevVersion = prevResult.rows[0]?.model_version;
      if (prevVersion === undefined) {
        // Deactivated the current but nothing to activate → rollback.
        await client.query('ROLLBACK');
        return false;
      }

      const activateResult = await client.query(
        `UPDATE ltr_model_registry SET is_active = TRUE
         WHERE query_class = $1 AND model_version = $2`,
        [queryClass, prevVersion],
      );
      if (activateResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async clearAllModels(): Promise<void> {
    await this.pool.query(`DELETE FROM ltr_model_registry`);
  }
}
