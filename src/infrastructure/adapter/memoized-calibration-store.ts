import type {
  CalibrationParams,
  CalibrationStore,
  FreshCalibrationLoadResult,
} from '../../domain/resolver/port/calibration-store.port.js';
import { QUERY_CLASSES, type QueryClass } from '../../domain/shared/types/query-class.js';
import { MS_PER_DAY } from '../../domain/shared/utils/time-units.js';

function evaluateFreshness(
  params: CalibrationParams | null,
  ttlDays: number,
  now: Date,
): FreshCalibrationLoadResult {
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new Error(
      `MemoizedCalibrationStore.loadIfFresh: ttlDays must be a positive finite number, got ${String(ttlDays)}`,
    );
  }
  if (params === null) {
    return { trusted: false, reason: 'missing', params: null };
  }
  if (params.fittedAt == null) {
    return { trusted: false, reason: 'never_fitted', params };
  }
  const ageMs = now.getTime() - params.fittedAt.getTime();
  const ttlMs = ttlDays * MS_PER_DAY;
  if (!Number.isFinite(ageMs) || ageMs > ttlMs) {
    return { trusted: false, reason: 'stale', params };
  }
  return { trusted: true, params };
}

/**
 * Process-local memoized calibration store.
 *
 * Resolver calibration params are effectively immutable for a running process:
 * they change only when operators publish new calibration rows. Pulling the
 * same query-class row from PG on every lookup turns resolver latency into a
 * repeated control-plane round-trip. This adapter caches the validated row
 * once and computes freshness locally from `fittedAt`.
 */
export class MemoizedCalibrationStore implements CalibrationStore {
  private readonly paramsByQueryClass = new Map<QueryClass, Promise<CalibrationParams | null>>();

  constructor(private readonly inner: CalibrationStore) {}

  async preload(queryClasses: readonly QueryClass[] = QUERY_CLASSES): Promise<void> {
    await Promise.all(queryClasses.map(async (queryClass) => {
      await this.getCalibrationParams(queryClass);
    }));
  }

  async getCalibrationParams(
    queryClass: QueryClass,
    signal?: AbortSignal,
  ): Promise<CalibrationParams | null> {
    const cached = this.paramsByQueryClass.get(queryClass);
    if (cached !== undefined) {
      return cached;
    }

    const loadPromise = this.inner.getCalibrationParams(queryClass, signal)
      .catch((error) => {
        if (this.paramsByQueryClass.get(queryClass) === loadPromise) {
          this.paramsByQueryClass.delete(queryClass);
        }
        throw error;
      });
    this.paramsByQueryClass.set(queryClass, loadPromise);
    return loadPromise;
  }

  async save(
    queryClass: QueryClass,
    params: CalibrationParams,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.inner.save(queryClass, params, signal);
    this.paramsByQueryClass.set(queryClass, Promise.resolve(params));
  }

  async loadIfFresh(
    queryClass: QueryClass,
    ttlDays: number,
    now: Date = new Date(),
    signal?: AbortSignal,
  ): Promise<FreshCalibrationLoadResult> {
    const params = await this.getCalibrationParams(queryClass, signal);
    return evaluateFreshness(params, ttlDays, now);
  }
}

