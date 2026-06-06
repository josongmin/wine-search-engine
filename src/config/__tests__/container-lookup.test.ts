import { afterEach, describe, expect, it, vi } from 'vitest';
import { startCalibrationPreload } from '../container-lookup.js';
import { MemoizedCalibrationStore } from '../../infrastructure/adapter/memoized-calibration-store.js';
import { StubCalibrationStore } from '../container-stubs.js';
import { bootstrapLogger } from '../../domain/shared/bootstrap-logger.js';
import { QUERY_CLASSES } from '../../domain/shared/types/query-class.js';

describe('startCalibrationPreload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('kicks off memoized calibration preload without awaiting it', () => {
    const store = new MemoizedCalibrationStore({
      getCalibrationParams: vi.fn().mockResolvedValue(null),
      save: vi.fn(),
      loadIfFresh: vi.fn(),
    });
    const preloadSpy = vi.spyOn(store, 'preload').mockReturnValue(new Promise(() => {}));

    expect(() => startCalibrationPreload(store, { searchSnapshotId: 'search-snapshot:v1:test' })).not.toThrow();
    expect(preloadSpy).toHaveBeenCalledWith(QUERY_CLASSES);
  });

  it('swallows preload failures and keeps the lazy load path authoritative', async () => {
    const store = new MemoizedCalibrationStore({
      getCalibrationParams: vi.fn().mockResolvedValue(null),
      save: vi.fn(),
      loadIfFresh: vi.fn(),
    });
    const preloadSpy = vi.spyOn(store, 'preload').mockRejectedValue(new Error('pg timeout'));
    const warnSpy = vi.spyOn(bootstrapLogger, 'warn').mockImplementation(() => bootstrapLogger);

    startCalibrationPreload(store, { searchSnapshotId: 'search-snapshot:v1:test' });
    await Promise.resolve();

    expect(preloadSpy).toHaveBeenCalledWith(QUERY_CLASSES);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'LookupDirectContainer',
        searchSnapshotId: 'search-snapshot:v1:test',
        err: expect.any(Error),
      }),
      '[lookup-direct] calibration preload failed; keeping lazy load path authoritative',
    );
  });

  it('does nothing for stub calibration stores', () => {
    const store = new StubCalibrationStore();

    expect(() => startCalibrationPreload(store, { searchSnapshotId: 'search-snapshot:v1:test' })).not.toThrow();
  });
});
