import { Pool } from 'pg';
import { QUERY_CLASSES } from '../../../../src/domain/shared/types/query-class.js';
import { DEFAULT_THRESHOLD_PROFILE } from '../../../../src/domain/query/model/threshold-profile.js';
import { PgCalibrationStore } from '../../../../src/infrastructure/adapter/pg-calibration-store.js';
import { PgThresholdStore } from '../../../../src/infrastructure/adapter/pg-threshold-store.js';
import type { CalibrationStore, CalibrationParams } from '../../../../src/domain/resolver/port/calibration-store.port.js';
import type { ThresholdStore } from '../../../../src/domain/query/port/threshold-store.port.js';
import {
  InMemoryCalibrationStore,
  InMemoryThresholdStore,
} from '../../../integration/helpers/in-memory-adapters.js';

export interface VespaTestRealStores {
  readonly calibrationStore: CalibrationStore;
  readonly thresholdStore: ThresholdStore;
  readonly backing: 'memory' | 'pg';
  close(): Promise<void>;
}

const DEFAULT_TEST_DB_URL = 'postgresql://wine:wine_test@localhost:5433/wine_engine_test';

function buildIdentityCalibrationParams(
  queryClass: (typeof QUERY_CLASSES)[number],
): CalibrationParams {
  return {
    method: 'isotonic',
    queryClass,
    params: { breakpoint_count: 0 },
    trainedAt: new Date(0),
    ece: 1,
  };
}

async function seedPgBackedStores(
  thresholdStore: PgThresholdStore,
  calibrationStore: PgCalibrationStore,
): Promise<void> {
  await thresholdStore.save(DEFAULT_THRESHOLD_PROFILE);
  await Promise.all(
    QUERY_CLASSES.map((queryClass) =>
      calibrationStore.save(queryClass, buildIdentityCalibrationParams(queryClass)),
    ),
  );
}

export async function createVespaTestRealStores(): Promise<VespaTestRealStores> {
  const connectionString = process.env['TEST_DB_URL'];
  if (connectionString === undefined || connectionString.trim().length === 0) {
    return {
      calibrationStore: new InMemoryCalibrationStore(),
      thresholdStore: new InMemoryThresholdStore(),
      backing: 'memory',
      async close() {
        return;
      },
    };
  }

  const pool = new Pool({
    connectionString: connectionString.trim() || DEFAULT_TEST_DB_URL,
    max: 2,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 5_000,
  });

  try {
    await pool.query('SELECT 1');
    const thresholdStore = new PgThresholdStore(pool);
    const calibrationStore = new PgCalibrationStore(pool);
    await seedPgBackedStores(thresholdStore, calibrationStore);

    return {
      calibrationStore,
      thresholdStore,
      backing: 'pg',
      async close() {
        await pool.end();
      },
    };
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw new Error(
      `Failed to initialize Vespa E2E PG-backed stores via TEST_DB_URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
