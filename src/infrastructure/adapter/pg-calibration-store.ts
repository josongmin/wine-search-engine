import type { Pool } from 'pg';
import type { CalibrationStore, CalibrationParams } from '../../domain/resolver/port/calibration-store.port.js';
import type { QueryClass } from '../../domain/shared/types/index.js';
import { isQueryClass } from '../../domain/shared/types/query-class.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';

const log = bootstrapLogger.child({ component: 'PgCalibrationStore' });

const VALID_METHODS: ReadonlySet<string> = new Set(['platt', 'isotonic', 'temperature']);

interface CalibrationRow {
  query_class: string;
  method: string;
  params: unknown;
  ece: number;
  trained_at: Date;
}

/**
 * Validates that JSONB params is a Record<string, number> with all finite values.
 * Calibration params drive score scaling — corrupted data must not silently propagate.
 */
function isValidNumericRecord(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  for (const v of Object.values(value)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  return true;
}

function rowToCalibrationParams(row: CalibrationRow): CalibrationParams | null {
  if (!VALID_METHODS.has(row.method)) {
    log.warn(
      { queryClass: row.query_class, method: row.method },
      'calibration_params row has invalid method; rejecting',
    );
    return null;
  }
  if (!isValidNumericRecord(row.params)) {
    log.warn(
      { queryClass: row.query_class },
      'calibration_params.params has invalid shape; rejecting (DB corruption or schema drift)',
    );
    return null;
  }
  // TS can't narrow from Set.has(); use equality checks (already validated above)
  const method = row.method === 'platt' || row.method === 'isotonic' || row.method === 'temperature'
    ? row.method
    : ('platt' satisfies CalibrationParams['method']);
  if (!isQueryClass(row.query_class)) {
    log.warn(
      { queryClass: row.query_class },
      'calibration_params row has invalid query_class; rejecting',
    );
    return null;
  }
  return {
    method,
    queryClass: row.query_class,
    params: row.params,
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
