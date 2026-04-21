/**
 * PostgreSQL adapter for LTR model registry persistence.
 *
 * Epic 4: LambdaMART learning-to-rank training pipeline
 * Stores trained per-query-class models with versioning and rollback support.
 */

import { nanoid } from 'nanoid';
import type { Pool } from 'pg';
import type { QueryClassWeights } from '../../domain/ranking/index.js';
import { pgTableHasColumn } from '../db/pg-schema-capabilities.js';

/**
 * Row shape in ltr_model_registry table.
 */
interface LtrModelRow {
  registry_id: string;
  query_class: string;
  model_version: number;
  is_active: boolean;
  search_snapshot_id: string;
  eval_dataset_version: string;
  feature_schema_hash: string;
  copied_from_registry_id: string | null;
  copied_from_snapshot_id: string | null;
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
interface LtrModelRegistryPort {
  /**
   * Saves a trained model for a query class.
   * Inserts a new version and marks it as active (deactivating prior versions).
   */
  saveModel(
    queryClass: string,
    weights: QueryClassWeights,
    metadata: LtrModelSaveMetadata,
  ): Promise<void>;

  /**
   * Retrieves the active trained model for a query class.
   */
  getModel(queryClass: string, searchSnapshotId?: string): Promise<QueryClassWeights | null>;

  /**
   * Retrieves all active trained models.
   */
  getAllModels(searchSnapshotId?: string): Promise<ReadonlyMap<string, QueryClassWeights>>;

  /**
   * Rolls back to the previous model version for a query class.
   * Returns true if rollback succeeded, false if no previous version exists.
   */
  rollbackModel(queryClass: string): Promise<boolean>;

  /**
   * Atomically activates the latest model version per query class for a snapshot.
   */
  activateSnapshot(searchSnapshotId: string): Promise<number>;

  /**
   * Strictly clone active snapshot-bound models into a new snapshot when the
   * document plane and feature schema are proven compatible.
   */
  cloneActiveModelsToSnapshot(
    sourceSnapshotId: string,
    targetSnapshotId: string,
    metadata: LtrModelCloneMetadata,
  ): Promise<number>;

  /**
   * Lists snapshots that currently own active LTR models under a compatible
   * feature schema.
   */
  listActiveSnapshotIds(featureSchemaHash?: string): Promise<readonly string[]>;

  /**
   * Deletes all models (for testing/retraining).
   */
  clearAllModels(): Promise<void>;
}

interface LtrModelSaveMetadata {
  readonly searchSnapshotId: string;
  readonly evalDatasetVersion: string;
  readonly featureSchemaHash: string;
  readonly activate?: boolean;
}

interface LtrModelCloneMetadata {
  readonly featureSchemaHash: string;
}

/**
 * node-postgres returns float[] columns as string[] at runtime — the type
 * parameter on the query result is a compile-time annotation only.
 * Parse each element with Number() and reject non-finite values immediately
 * so that downstream dot-product scoring never silently produces NaN.
 */
function parseLtrWeights(raw: number[], registryId: string): number[] {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- pg returns float[] as string[] at runtime
  const weights = (raw as unknown as string[]).map(Number);
  if (weights.some((w) => !Number.isFinite(w))) {
    throw new Error(`LTR model ${registryId} has non-finite weights`);
  }
  return weights;
}

/**
 * node-postgres also returns scalar float8 columns (bias) as strings.
 * Guard and throw rather than let NaN silently corrupt every LTR score.
 */
function parseLtrBias(raw: number, registryId: string): number {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- pg returns float8 as string at runtime
  const bias = Number(raw as unknown as string);
  if (!Number.isFinite(bias)) {
    throw new Error(`LTR model ${registryId} has non-finite bias`);
  }
  return bias;
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

  private async hasFeatureSchemaHashColumn(): Promise<boolean> {
    return pgTableHasColumn(this.pool, 'ltr_model_registry', 'feature_schema_hash');
  }

  private async hasCloneLineageColumns(): Promise<boolean> {
    const [hasCopiedFromRegistryId, hasCopiedFromSnapshotId] = await Promise.all([
      pgTableHasColumn(this.pool, 'ltr_model_registry', 'copied_from_registry_id'),
      pgTableHasColumn(this.pool, 'ltr_model_registry', 'copied_from_snapshot_id'),
    ]);
    return hasCopiedFromRegistryId && hasCopiedFromSnapshotId;
  }

  async saveModel(
    queryClass: string,
    weights: QueryClassWeights,
    metadata: LtrModelSaveMetadata,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      if (metadata.activate === true) {
        await client.query(
          `UPDATE ltr_model_registry SET is_active = FALSE
           WHERE query_class = $1 AND is_active = TRUE`,
          [queryClass],
        );
      }

      // Determine next version number
      const versionResult = await client.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(model_version), 0) + 1 AS next_version
         FROM ltr_model_registry WHERE query_class = $1`,
        [queryClass],
      );
      const nextVersion = versionResult.rows[0]?.next_version ?? 1;

      // Insert new active version
      const registryId = nanoid();
      if (await this.hasFeatureSchemaHashColumn()) {
        await client.query(
          `INSERT INTO ltr_model_registry (
            registry_id, query_class, model_version, is_active,
            search_snapshot_id, eval_dataset_version,
            feature_schema_hash,
            weights, bias, training_example_count, ndcg5_validation_score, trained_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            registryId,
            queryClass,
            nextVersion,
            metadata.activate === true,
            metadata.searchSnapshotId,
            metadata.evalDatasetVersion,
            metadata.featureSchemaHash,
            Array.from(weights.weights),
            weights.bias,
            weights.trainingExampleCount,
            weights.ndcg5ValidationScore,
            weights.trainedAt,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO ltr_model_registry (
            registry_id, query_class, model_version, is_active,
            search_snapshot_id, eval_dataset_version,
            weights, bias, training_example_count, ndcg5_validation_score, trained_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            registryId,
            queryClass,
            nextVersion,
            metadata.activate === true,
            metadata.searchSnapshotId,
            metadata.evalDatasetVersion,
            Array.from(weights.weights),
            weights.bias,
            weights.trainingExampleCount,
            weights.ndcg5ValidationScore,
            weights.trainedAt,
          ],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getModel(queryClass: string, searchSnapshotId?: string): Promise<QueryClassWeights | null> {
    const result = await this.pool.query<LtrModelRow>(
      `SELECT * FROM ltr_model_registry
       WHERE query_class = $1
         AND is_active = TRUE
         AND ($2::text IS NULL OR search_snapshot_id = $2)
       ORDER BY model_version DESC
       LIMIT 1`,
      [queryClass, searchSnapshotId ?? null],
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      queryClass: row.query_class,
      weights: parseLtrWeights(row.weights, row.registry_id),
      bias: parseLtrBias(row.bias, row.registry_id),
      trainingExampleCount: row.training_example_count,
      ndcg5ValidationScore: row.ndcg5_validation_score,
      trainedAt: row.trained_at,
    };
  }

  async getAllModels(searchSnapshotId?: string): Promise<ReadonlyMap<string, QueryClassWeights>> {
    const result = await this.pool.query<LtrModelRow>(
      `SELECT * FROM ltr_model_registry
       WHERE is_active = TRUE
         AND ($1::text IS NULL OR search_snapshot_id = $1)
       ORDER BY query_class ASC, model_version DESC`,
      [searchSnapshotId ?? null],
    );

    const models = new Map<string, QueryClassWeights>();
    for (const row of result.rows) {
      models.set(row.query_class, {
        queryClass: row.query_class,
        weights: parseLtrWeights(row.weights, row.registry_id),
        bias: parseLtrBias(row.bias, row.registry_id),
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

  async activateSnapshot(searchSnapshotId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const snapshotClassResult = await client.query<{ query_class: string }>(
        `SELECT DISTINCT query_class
         FROM ltr_model_registry
         WHERE search_snapshot_id = $1`,
        [searchSnapshotId],
      );

      const queryClasses = snapshotClassResult.rows.map((row) => row.query_class);
      if (queryClasses.length === 0) {
        await client.query('ROLLBACK');
        return 0;
      }

      await client.query(
        `UPDATE ltr_model_registry
         SET is_active = FALSE
         WHERE query_class = ANY($1::text[]) AND is_active = TRUE`,
        [queryClasses],
      );

      const activateResult = await client.query(
        `WITH latest_per_class AS (
           SELECT query_class, MAX(model_version) AS model_version
           FROM ltr_model_registry
           WHERE search_snapshot_id = $1
           GROUP BY query_class
         )
         UPDATE ltr_model_registry AS target
         SET is_active = TRUE
         FROM latest_per_class
         WHERE target.search_snapshot_id = $1
           AND target.query_class = latest_per_class.query_class
           AND target.model_version = latest_per_class.model_version`,
        [searchSnapshotId],
      );

      await client.query('COMMIT');
      return activateResult.rowCount ?? 0;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async cloneActiveModelsToSnapshot(
    sourceSnapshotId: string,
    targetSnapshotId: string,
    metadata: LtrModelCloneMetadata,
  ): Promise<number> {
    if (!(await this.hasFeatureSchemaHashColumn())) {
      return 0;
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const existingTargetResult = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
         FROM ltr_model_registry
         WHERE search_snapshot_id = $1`,
        [targetSnapshotId],
      );
      const existingTargetCountRaw = existingTargetResult.rows[0]?.count ?? '0';
      const existingTargetCount = Number(existingTargetCountRaw);
      if (!Number.isFinite(existingTargetCount)) {
        throw new Error(
          `cloneActiveModelsToSnapshot: non-finite COUNT from ltr_model_registry: ${existingTargetCountRaw}`,
        );
      }
      if (existingTargetCount > 0) {
        await client.query('ROLLBACK');
        return 0;
      }

      const sourceResult = await client.query<LtrModelRow>(
        `SELECT *
         FROM ltr_model_registry
         WHERE is_active = TRUE
           AND search_snapshot_id = $1
           AND feature_schema_hash = $2
         ORDER BY query_class ASC, model_version ASC`,
        [sourceSnapshotId, metadata.featureSchemaHash],
      );

      if (sourceResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return 0;
      }

      const hasCloneLineageColumns = await this.hasCloneLineageColumns();
      for (const row of sourceResult.rows) {
        const versionResult = await client.query<{ next_version: number }>(
          `SELECT COALESCE(MAX(model_version), 0) + 1 AS next_version
           FROM ltr_model_registry
           WHERE query_class = $1`,
          [row.query_class],
        );
        const nextVersion = versionResult.rows[0]?.next_version ?? 1;
        if (hasCloneLineageColumns) {
          await client.query(
            `INSERT INTO ltr_model_registry (
               registry_id, query_class, model_version, is_active,
               search_snapshot_id, eval_dataset_version, feature_schema_hash,
               copied_from_registry_id, copied_from_snapshot_id,
               weights, bias, training_example_count, ndcg5_validation_score, trained_at
             ) VALUES (
               $1, $2, $3, FALSE,
               $4, $5, $6,
               $7, $8,
               $9, $10, $11, $12, $13
             )`,
            [
              nanoid(),
              row.query_class,
              nextVersion,
              targetSnapshotId,
              row.eval_dataset_version,
              row.feature_schema_hash,
              row.registry_id,
              sourceSnapshotId,
              row.weights,
              row.bias,
              row.training_example_count,
              row.ndcg5_validation_score,
              row.trained_at,
            ],
          );
        } else {
          await client.query(
            `INSERT INTO ltr_model_registry (
               registry_id, query_class, model_version, is_active,
               search_snapshot_id, eval_dataset_version, feature_schema_hash,
               weights, bias, training_example_count, ndcg5_validation_score, trained_at
             ) VALUES (
               $1, $2, $3, FALSE,
               $4, $5, $6,
               $7, $8, $9, $10, $11
             )`,
            [
              nanoid(),
              row.query_class,
              nextVersion,
              targetSnapshotId,
              row.eval_dataset_version,
              row.feature_schema_hash,
              row.weights,
              row.bias,
              row.training_example_count,
              row.ndcg5_validation_score,
              row.trained_at,
            ],
          );
        }
      }

      await client.query('COMMIT');
      return sourceResult.rows.length;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listActiveSnapshotIds(featureSchemaHash?: string): Promise<readonly string[]> {
    const hasFeatureSchemaHashColumn = await this.hasFeatureSchemaHashColumn();
    if (!hasFeatureSchemaHashColumn && featureSchemaHash !== undefined) {
      return [];
    }
    const result = await this.pool.query<{ search_snapshot_id: string }>(
      hasFeatureSchemaHashColumn
        ? `SELECT DISTINCT search_snapshot_id
           FROM ltr_model_registry
           WHERE is_active = TRUE
             AND ($1::text IS NULL OR feature_schema_hash = $1)
           ORDER BY search_snapshot_id ASC`
        : `SELECT DISTINCT search_snapshot_id
           FROM ltr_model_registry
           WHERE is_active = TRUE
           ORDER BY search_snapshot_id ASC`,
      hasFeatureSchemaHashColumn ? [featureSchemaHash ?? null] : [],
    );
    return result.rows.map((row) => row.search_snapshot_id);
  }
}
