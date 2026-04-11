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
});
