/**
 * Threshold Store Fail-Closed Integration Test (T-E7-02)
 *
 * Verifies PgThresholdStore.getDefault() fails loudly on empty/corrupted DB.
 * After T-E7-02, getDefault() throws instead of returning DEFAULT_THRESHOLD_PROFILE.
 */
import { describe, it, expect, vi } from 'vitest';
import { PgThresholdStore } from '../../src/infrastructure/adapter/pg-threshold-store.js';

// ---------------------------------------------------------------------------
// Pool mock factory
// ---------------------------------------------------------------------------

interface MockQueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number;
}

function makeMockPool(queryFn: () => MockQueryResult) {
  return { query: vi.fn().mockResolvedValue(queryFn()) };
}

// A valid threshold profile shape (matches isValidThresholdProfile checks:
// id: string, version: string, perQueryClass: object, ambiguityPenaltyDefault: finite number)
const DB_PROFILE = {
  id: 'test-profile-1',
  version: '1.0.0',
  perQueryClass: { short_entity: { resolveThreshold: 0.45, clarifyThreshold: 0.35 } },
  ambiguityPenaltyDefault: 0.15,
  resolveThreshold: 0.45,
  clarifyThreshold: 0.35,
  failThreshold: 0.2,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Threshold Store Fail-Closed (T-E7-02)', () => {
  describe('getDefault() — empty DB', () => {
    it('throws when no default row exists', async () => {
      const pool = makeMockPool(() => ({ rows: [], rowCount: 0 }));
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock pool
      const store = new PgThresholdStore(pool as never);

      await expect(store.getDefault()).rejects.toThrow('no default threshold profile in DB');
    });
  });

  describe('getDefault() — corrupted JSONB', () => {
    it('throws on null profile_data', async () => {
      const pool = makeMockPool(() => ({
        rows: [{ profile_id: 'p1', profile_data: null, is_default: true, created_at: new Date(), updated_at: new Date() }],
        rowCount: 1,
      }));
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock pool
      const store = new PgThresholdStore(pool as never);

      await expect(store.getDefault()).rejects.toThrow('JSONB invalid');
    });

    it('throws on string profile_data', async () => {
      const pool = makeMockPool(() => ({
        rows: [{ profile_id: 'p2', profile_data: 'not-json', is_default: true, created_at: new Date(), updated_at: new Date() }],
        rowCount: 1,
      }));
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock pool
      const store = new PgThresholdStore(pool as never);

      await expect(store.getDefault()).rejects.toThrow('JSONB invalid');
    });

    it('throws on empty object profile_data', async () => {
      const pool = makeMockPool(() => ({
        rows: [{ profile_id: 'p3', profile_data: {}, is_default: true, created_at: new Date(), updated_at: new Date() }],
        rowCount: 1,
      }));
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock pool
      const store = new PgThresholdStore(pool as never);

      await expect(store.getDefault()).rejects.toThrow('JSONB invalid');
    });

    it('throws on NaN ambiguityPenaltyDefault', async () => {
      const pool = makeMockPool(() => ({
        rows: [{ profile_id: 'p4', profile_data: { ...DB_PROFILE, ambiguityPenaltyDefault: NaN }, is_default: true, created_at: new Date(), updated_at: new Date() }],
        rowCount: 1,
      }));
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock pool
      const store = new PgThresholdStore(pool as never);

      await expect(store.getDefault()).rejects.toThrow('JSONB invalid');
    });
  });

  describe('getDefault() — valid row', () => {
    it('returns the DB profile when data is valid', async () => {
      const pool = makeMockPool(() => ({
        rows: [{ profile_id: 'valid-1', profile_data: DB_PROFILE, is_default: true, created_at: new Date(), updated_at: new Date() }],
        rowCount: 1,
      }));
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- mock pool
      const store = new PgThresholdStore(pool as never);

      const result = await store.getDefault();
      expect(result.resolveThreshold).toBe(0.45);
      expect(result.clarifyThreshold).toBe(0.35);
    });
  });
});
