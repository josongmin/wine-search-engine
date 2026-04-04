import type { Pool } from 'pg';
import type { CalibrationStore, CalibrationParams } from '../../domain/resolver/port/calibration-store.port.js';
import type { QueryClass } from '../../domain/shared/types/index.js';

interface CalibrationRow {
  query_class: string;
  method: string;
  params: unknown;
  ece: number;
  trained_at: Date;
}

function rowToCalibrationParams(row: CalibrationRow): CalibrationParams {
  return {
    method: row.method as CalibrationParams['method'],
    queryClass: row.query_class as QueryClass,
    params: row.params as Record<string, number>,
    trainedAt: row.trained_at,
    ece: row.ece,
  };
}

export class PgCalibrationStore implements CalibrationStore {
  constructor(private readonly pool: Pool) {}

  async getCalibrationParams(queryClass: QueryClass): Promise<CalibrationParams | null> {
    const result = await this.pool.query<CalibrationRow>(
      `SELECT * FROM calibration_params WHERE query_class = $1`,
      [queryClass],
    );
    const row = result.rows[0];
    return row != null ? rowToCalibrationParams(row) : null;
  }

  async save(queryClass: QueryClass, params: CalibrationParams): Promise<void> {
    await this.pool.query(
      `INSERT INTO calibration_params (query_class, method, params, ece, trained_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (query_class) DO UPDATE SET
         method = EXCLUDED.method,
         params = EXCLUDED.params,
         ece = EXCLUDED.ece,
         trained_at = EXCLUDED.trained_at`,
      [
        queryClass,
        params.method,
        JSON.stringify(params.params),
        params.ece,
        params.trainedAt,
      ],
    );
  }
}
