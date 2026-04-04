import type { Pool } from 'pg';
import type { ThresholdStore } from '../../domain/query/port/threshold-store.port.js';
import type { ThresholdProfileV1 } from '../../domain/query/model/threshold-profile.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../domain/query/model/threshold-profile.js';

interface ThresholdProfileRow {
  profile_id: string;
  profile_data: unknown;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToProfile(row: ThresholdProfileRow): ThresholdProfileV1 {
  return row.profile_data as ThresholdProfileV1;
}

export class PgThresholdStore implements ThresholdStore {
  constructor(private readonly pool: Pool) {}

  async getProfile(id: string): Promise<ThresholdProfileV1 | null> {
    const result = await this.pool.query<ThresholdProfileRow>(
      `SELECT * FROM threshold_profiles WHERE profile_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row != null ? rowToProfile(row) : null;
  }

  async getDefault(): Promise<ThresholdProfileV1> {
    const result = await this.pool.query<ThresholdProfileRow>(
      `SELECT * FROM threshold_profiles WHERE is_default = TRUE LIMIT 1`,
    );
    const row = result.rows[0];
    if (row != null) {
      return rowToProfile(row);
    }
    // Guaranteed non-null fallback per port contract
    return DEFAULT_THRESHOLD_PROFILE;
  }

  async save(profile: ThresholdProfileV1): Promise<void> {
    await this.pool.query(
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
