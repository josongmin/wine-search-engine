import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveLookupV2LtrSupportState, startCalibrationPreload } from '../lookup-authority.js';
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
        component: 'LookupAuthorityServices',
        searchSnapshotId: 'search-snapshot:v1:test',
        err: expect.any(Error),
      }),
      '[lookup-authority] calibration preload failed; keeping lazy load path authoritative',
    );
  });

  it('does nothing for stub calibration stores', () => {
    const store = new StubCalibrationStore();

    expect(() => startCalibrationPreload(store, { searchSnapshotId: 'search-snapshot:v1:test' })).not.toThrow();
  });
});

describe('resolveLookupV2LtrSupportState', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks lookup-direct LTR as unsupported even when shared LTR config is enabled', () => {
    const infoSpy = vi.spyOn(bootstrapLogger, 'info').mockImplementation(() => bootstrapLogger);

    const result = resolveLookupV2LtrSupportState({
      ltrServingEnabled: true,
      runtimeLtrModelsPath: '/tmp/runtime-ltr-models.json',
    });

    expect(result).toEqual({
      status: 'unsupported',
      reason: 'lookup_domain_model_absent',
    });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        component: 'LookupAuthorityServices',
        ltrServingEnabled: true,
        runtimeLtrModelsPathConfigured: true,
        reason: 'lookup_domain_model_absent',
      }),
      '[lookup-authority] lookup-v2 LTR unsupported; skipping model discovery and reranker wiring',
    );
  });
});
