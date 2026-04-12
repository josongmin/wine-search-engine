/**
 * Regression: pg-ltr-model-registry — float[] columns returned as string[] by node-postgres.
 *
 * node-postgres does not auto-parse float array columns (OID 1022/1021).
 * The DB driver returns them as string[] at runtime even though the TypeScript
 * generic says number[]. Without an explicit .map(Number) the weights are
 * strings, and any dot-product scoring produces NaN, silently collapsing all
 * LTR rankings to undefined order.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { PgLtrModelRegistry } from '../pg-ltr-model-registry.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    registry_id: 'reg-test-001',
    query_class: 'red_wine',
    model_version: 1,
    is_active: true,
    search_snapshot_id: 'search-snapshot:v1:test',
    eval_dataset_version: 'pg_gold_set_store.v1',
    feature_schema_hash: '9f8a1573d430a37d',
    copied_from_registry_id: null,
    copied_from_snapshot_id: null,
    // node-postgres returns float[] as string[] at runtime:
    weights: ['0.5', '0.3', '-0.1', '0.7', '0.0', '0.2', '-0.4', '0.6'],
    bias: '0.01',
    training_example_count: 1000,
    ndcg5_validation_score: 0.87,
    trained_at: new Date('2026-04-01T00:00:00Z'),
    created_at: new Date('2026-04-01T00:00:00Z'),
    ...overrides,
  };
}

function makePool(rows: unknown[]): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as Pool;
}

function makeClientSequence(responses: readonly unknown[]) {
  const query = vi.fn();
  for (const response of responses) {
    query.mockResolvedValueOnce(response);
  }
  return {
    query,
    release: vi.fn(),
  };
}

// ── getModel ─────────────────────────────────────────────────────────────────

describe('PgLtrModelRegistry.getModel — string[] weights from PG', () => {
  it('parses string[] weights to number[] correctly', async () => {
    const pool = makePool([makeRow()]);
    const registry = new PgLtrModelRegistry(pool);

    const model = await registry.getModel('red_wine');

    expect(model).not.toBeNull();
    const weights = model!.weights;
    // All elements must be genuine numbers, not strings.
    expect(weights.every((w) => typeof w === 'number')).toBe(true);
    expect(weights).toEqual([0.5, 0.3, -0.1, 0.7, 0.0, 0.2, -0.4, 0.6]);
  });

  it('returns null when no active model exists', async () => {
    const pool = makePool([]);
    const registry = new PgLtrModelRegistry(pool);

    expect(await registry.getModel('red_wine')).toBeNull();
  });

  it('throws when any weight is non-finite (NaN from bad DB data)', async () => {
    // A row with an unparseable weight string.
    const pool = makePool([makeRow({ weights: ['0.5', 'not-a-number', '-0.1'] })]);
    const registry = new PgLtrModelRegistry(pool);

    await expect(registry.getModel('red_wine')).rejects.toThrow(/non-finite weights/);
  });

  it('parses bias string to finite number', async () => {
    // node-postgres returns float8 scalar columns as strings too.
    const pool = makePool([makeRow({ bias: '0.01' })]);
    const registry = new PgLtrModelRegistry(pool);

    const model = await registry.getModel('red_wine');
    expect(typeof model!.bias).toBe('number');
    expect(Number.isFinite(model!.bias)).toBe(true);
    expect(model!.bias).toBeCloseTo(0.01);
  });

  it('throws when bias is non-finite', async () => {
    const pool = makePool([makeRow({ bias: 'NaN' })]);
    const registry = new PgLtrModelRegistry(pool);

    await expect(registry.getModel('red_wine')).rejects.toThrow(/non-finite bias/);
  });

  it('dot-product on returned weights and bias does not produce NaN', async () => {
    const pool = makePool([makeRow()]);
    const registry = new PgLtrModelRegistry(pool);

    const model = await registry.getModel('red_wine');
    // Simulate the LTR scoring dot-product operation.
    const features = [1, 0.5, 0.2, 0.8, 0.1, 0.9, 0.3, 0.4];
    const score = model!.weights.reduce((sum, w, i) => sum + w * (features[i] ?? 0), model!.bias);
    expect(Number.isFinite(score)).toBe(true);
  });
});

// ── getAllModels ──────────────────────────────────────────────────────────────

describe('PgLtrModelRegistry.getAllModels — string[] weights from PG', () => {
  it('parses string[] weights to number[] for every row', async () => {
    const rows = [
      makeRow({ query_class: 'red_wine', registry_id: 'r1' }),
      makeRow({
        query_class: 'white_wine',
        registry_id: 'r2',
        weights: ['0.1', '0.2', '0.3', '0.4', '0.5', '0.6', '0.7', '0.8'],
      }),
    ];
    const pool = makePool(rows);
    const registry = new PgLtrModelRegistry(pool);

    const models = await registry.getAllModels();

    expect(models.size).toBe(2);

    for (const [, model] of models) {
      expect(model.weights.every((w) => typeof w === 'number')).toBe(true);
      expect(model.weights.every((w) => Number.isFinite(w))).toBe(true);
    }
  });

  it('throws when a row has non-finite weights, preventing partial NaN propagation', async () => {
    const rows = [
      makeRow({ query_class: 'red_wine', registry_id: 'r1' }),
      makeRow({
        query_class: 'white_wine',
        registry_id: 'r2-bad',
        weights: ['0.1', 'Infinity', '0.3'],
      }),
    ];
    const pool = makePool(rows);
    const registry = new PgLtrModelRegistry(pool);

    await expect(registry.getAllModels()).rejects.toThrow(/non-finite weights/);
  });

  it('returns empty map when no active models exist', async () => {
    const pool = makePool([]);
    const registry = new PgLtrModelRegistry(pool);

    const models = await registry.getAllModels();
    expect(models.size).toBe(0);
  });

  it('passes snapshot id through the active-model query when provided', async () => {
    const pool = makePool([makeRow({ search_snapshot_id: 'search-snapshot:v1:test' })]);
    const registry = new PgLtrModelRegistry(pool);

    await registry.getAllModels('search-snapshot:v1:test');

    expect((pool.query as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual([
      'search-snapshot:v1:test',
    ]);
  });
});

describe('PgLtrModelRegistry.activateSnapshot', () => {
  it('deactivates prior actives and activates the latest model version per class for the snapshot', async () => {
    const client = makeClientSequence([
      undefined,
      { rows: [{ query_class: 'red_wine' }, { query_class: 'white_wine' }] },
      { rowCount: 2 },
      { rowCount: 2 },
      undefined,
    ]);
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;
    const registry = new PgLtrModelRegistry(pool);

    const activated = await registry.activateSnapshot('search-snapshot:v1:test');

    expect(activated).toBe(2);
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('SELECT DISTINCT query_class'),
      ['search-snapshot:v1:test'],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('UPDATE ltr_model_registry'),
      [['red_wine', 'white_wine']],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('WITH latest_per_class AS'),
      ['search-snapshot:v1:test'],
    );
    expect(client.query).toHaveBeenNthCalledWith(5, 'COMMIT');
  });
});

describe('PgLtrModelRegistry.cloneActiveModelsToSnapshot', () => {
  it('clones active models only when target snapshot is empty and feature schema matches', async () => {
    const client = makeClientSequence([
      undefined,
      { rows: [{ count: '0' }] },
      {
        rows: [
          makeRow({
            registry_id: 'reg-red',
            query_class: 'red_wine',
            model_version: 3,
            search_snapshot_id: 'search-snapshot:v1:source',
          }),
          makeRow({
            registry_id: 'reg-white',
            query_class: 'white_wine',
            model_version: 2,
            search_snapshot_id: 'search-snapshot:v1:source',
          }),
        ],
      },
      { rows: [{ next_version: 4 }] },
      { rowCount: 1 },
      { rows: [{ next_version: 3 }] },
      { rowCount: 1 },
      undefined,
    ]);
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;
    const registry = new PgLtrModelRegistry(pool);

    const cloned = await registry.cloneActiveModelsToSnapshot(
      'search-snapshot:v1:source',
      'search-snapshot:v1:target',
      { featureSchemaHash: '9f8a1573d430a37d' },
    );

    expect(cloned).toBe(2);
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('FROM ltr_model_registry'),
      ['search-snapshot:v1:target'],
    );
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('feature_schema_hash = $2'),
      ['search-snapshot:v1:source', '9f8a1573d430a37d'],
    );
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
  });

  it('returns zero when target snapshot already has rows', async () => {
    const client = makeClientSequence([
      undefined,
      { rows: [{ count: '1' }] },
      undefined,
    ]);
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
    } as unknown as Pool;
    const registry = new PgLtrModelRegistry(pool);

    const cloned = await registry.cloneActiveModelsToSnapshot(
      'search-snapshot:v1:source',
      'search-snapshot:v1:target',
      { featureSchemaHash: '9f8a1573d430a37d' },
    );

    expect(cloned).toBe(0);
    expect(client.query).toHaveBeenNthCalledWith(3, 'ROLLBACK');
  });
});
