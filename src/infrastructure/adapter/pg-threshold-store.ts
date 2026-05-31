/**
 * E5-U7: Promotion Acceptance Gate — Persistence Layer
 *
 * pg-threshold-store is the persistence layer for promotion thresholds;
 * the offline promotion pipeline reads from this store to evaluate whether a
 * candidate model or weight set meets the bar for production traffic.
 *
 * Threshold updates MUST go through the promotion evaluation pipeline; direct store
 * writes are forbidden outside of initial seeding.
 */

import type { Pool } from 'pg';
import type { ThresholdStore } from '../../domain/query/port/threshold-store.port.js';
import type { ThresholdProfileV1 } from '../../domain/query/model/threshold-profile.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { runAbortablePgQuery } from '../db/abortable-pg-query.js';

const log = bootstrapLogger.child({ component: 'PgThresholdStore' });

interface ThresholdProfileRow {
  profile_id: string;
  profile_data: unknown;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * Runtime validation for ThresholdProfileV1 deserialized from JSONB.
 * Threshold profiles gate model promotions; corrupted data must not be
 * silently accepted. Returns null on shape mismatch (caller decides fallback).
 */
function isValidThresholdProfile(value: unknown): value is ThresholdProfileV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing after typeof/null/Array checks for property access
  const v = value as Record<string, unknown>; // nosemgrep: wine-jsonb-as-cast
  if (typeof v['id'] !== 'string' || v['id'].length === 0) return false;
  if (typeof v['version'] !== 'string' || v['version'].length === 0) return false;
  if (typeof v['perQueryClass'] !== 'object' || v['perQueryClass'] === null) return false;
  if (typeof v['ambiguityPenaltyDefault'] !== 'number'
      || !Number.isFinite(v['ambiguityPenaltyDefault'])) {
    return false;
  }
  return true;
}

function rowToProfile(row: ThresholdProfileRow, context: string): ThresholdProfileV1 | null {
  if (!isValidThresholdProfile(row.profile_data)) {
    log.warn(
      { profileId: row.profile_id, context },
      'threshold_profile_data has invalid shape; rejecting (DB corruption or schema drift)',
    );
    return null;
  }
  return row.profile_data;
}

export class PgThresholdStore implements ThresholdStore {
  constructor(private readonly pool: Pool) {}

  async getProfile(id: string, signal?: AbortSignal): Promise<ThresholdProfileV1 | null> {
    const result = await runAbortablePgQuery<ThresholdProfileRow>(
      this.pool,
      signal,
      `SELECT * FROM threshold_profiles WHERE profile_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row != null ? rowToProfile(row, 'getProfile') : null;
  }

  async getDefault(signal?: AbortSignal): Promise<ThresholdProfileV1> {
    const result = await runAbortablePgQuery<ThresholdProfileRow>(
      this.pool,
      signal,
      `SELECT * FROM threshold_profiles WHERE is_default = TRUE LIMIT 1`,
    );
    const row = result.rows[0];
    if (row != null) {
      const parsed = rowToProfile(row, 'getDefault');
      if (parsed !== null) return parsed;
      // T-E7-02: fail-closed — JSONB shape drift is a deployment/seeding error.
      throw new Error(
        `[PgThresholdStore] default threshold profile JSONB invalid for profile_id="${row.profile_id}". ` +
        'Fix the seeded data or re-run the threshold migration.',
      );
    }
    // T-E7-02: fail-closed — no default row means table never seeded.
    throw new Error(
      '[PgThresholdStore] no default threshold profile in DB. ' +
      'Seed the threshold_profiles table before starting the service.',
    );
  }

  async save(profile: ThresholdProfileV1, signal?: AbortSignal): Promise<void> {
    await runAbortablePgQuery(
      this.pool,
      signal,
      `INSERT INTO threshold_profiles (profile_id, profile_data, is_default, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (profile_id) DO UPDATE SET
         profile_data = EXCLUDED.profile_data,
         is_default = EXCLUDED.is_default,
         updated_at = NOW()`,
      [profile.id, JSON.stringify(profile), false],
    );
  }
}
