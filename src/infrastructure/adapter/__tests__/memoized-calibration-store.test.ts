import { describe, expect, it } from 'vitest';
import type {
  CalibrationParams,
  CalibrationStore,
  FreshCalibrationLoadResult,
} from '../../../domain/resolver/port/calibration-store.port.js';
import { MemoizedCalibrationStore } from '../memoized-calibration-store.js';

const NOW = new Date('2026-06-06T00:00:00.000Z');

function makeParams(queryClass: CalibrationParams['queryClass']): CalibrationParams {
  return {
    method: 'platt',
    queryClass,
    params: { a: 1, b: 0 },
    trainedAt: NOW,
    fittedAt: NOW,
    ece: 0.05,
  };
}

class FakeCalibrationStore implements CalibrationStore {
  readonly getCalls: string[] = [];
  readonly saveCalls: string[] = [];

  constructor(
    private readonly rows: Map<CalibrationParams['queryClass'], CalibrationParams | null>,
  ) {}

  async getCalibrationParams(queryClass: CalibrationParams['queryClass']): Promise<CalibrationParams | null> {
    this.getCalls.push(queryClass);
    return this.rows.get(queryClass) ?? null;
  }

  async save(queryClass: CalibrationParams['queryClass'], params: CalibrationParams): Promise<void> {
    this.saveCalls.push(queryClass);
    this.rows.set(queryClass, params);
  }

  async loadIfFresh(
    queryClass: CalibrationParams['queryClass'],
    ttlDays: number,
    now: Date = new Date(),
  ): Promise<FreshCalibrationLoadResult> {
    const params = await this.getCalibrationParams(queryClass);
    if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
      throw new Error('ttlDays must be positive finite');
    }
    if (params === null) {
      return { trusted: false, reason: 'missing', params: null };
    }
    if (params.fittedAt == null) {
      return { trusted: false, reason: 'never_fitted', params };
    }
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    return now.getTime() - params.fittedAt.getTime() > ttlMs
      ? { trusted: false, reason: 'stale', params }
      : { trusted: true, params };
  }
}

describe('MemoizedCalibrationStore', () => {
  it('memoizes repeated query-class reads and computes freshness locally', async () => {
    const inner = new FakeCalibrationStore(new Map([
      ['short_entity', makeParams('short_entity')],
    ]));
    const store = new MemoizedCalibrationStore(inner);

    const first = await store.loadIfFresh('short_entity', 14, NOW);
    const second = await store.loadIfFresh('short_entity', 14, NOW);

    expect(first).toEqual(second);
    expect(inner.getCalls).toEqual(['short_entity']);
  });

  it('updates the in-process cache on save', async () => {
    const inner = new FakeCalibrationStore(new Map([
      ['short_entity', null],
    ]));
    const store = new MemoizedCalibrationStore(inner);

    expect(await store.getCalibrationParams('short_entity')).toBeNull();
    expect(inner.getCalls).toEqual(['short_entity']);

    const params = makeParams('short_entity');
    await store.save('short_entity', params);

    const reread = await store.getCalibrationParams('short_entity');
    expect(reread).toEqual(params);
    expect(inner.saveCalls).toEqual(['short_entity']);
    expect(inner.getCalls).toEqual(['short_entity']);
  });

  it('preloads each query class at most once', async () => {
    const inner = new FakeCalibrationStore(new Map([
      ['exact_entity', makeParams('exact_entity')],
      ['short_entity', makeParams('short_entity')],
    ]));
    const store = new MemoizedCalibrationStore(inner);

    await store.preload(['exact_entity', 'short_entity', 'exact_entity']);

    expect(inner.getCalls).toEqual(['exact_entity', 'short_entity']);
  });
});

