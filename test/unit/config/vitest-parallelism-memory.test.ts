import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resolveFileParallelism,
  resolveMaxConcurrency,
  vitestMemorySchedulerOptions,
} from '../../../config/vitest/parallelism.js';

describe('config/vitest parallelism memory tuning', () => {
  let snapshotFileParallelism: string | undefined;
  let snapshotMaxConcurrency: string | undefined;

  beforeEach(() => {
    snapshotFileParallelism = process.env.VITEST_FILE_PARALLELISM;
    snapshotMaxConcurrency = process.env.VITEST_MAX_CONCURRENCY;
    delete process.env.VITEST_FILE_PARALLELISM;
    delete process.env.VITEST_MAX_CONCURRENCY;
  });

  afterEach(() => {
    if (snapshotFileParallelism === undefined) {
      delete process.env.VITEST_FILE_PARALLELISM;
    } else {
      process.env.VITEST_FILE_PARALLELISM = snapshotFileParallelism;
    }
    if (snapshotMaxConcurrency === undefined) {
      delete process.env.VITEST_MAX_CONCURRENCY;
    } else {
      process.env.VITEST_MAX_CONCURRENCY = snapshotMaxConcurrency;
    }
  });

  it('resolveFileParallelism defaults when env is unset', () => {
    expect(resolveFileParallelism(false)).toBe(false);
    expect(resolveFileParallelism(true)).toBe(true);
  });

  it('resolveFileParallelism parses common truthy/falsey env values', () => {
    process.env.VITEST_FILE_PARALLELISM = '1';
    expect(resolveFileParallelism(false)).toBe(true);
    process.env.VITEST_FILE_PARALLELISM = 'true';
    expect(resolveFileParallelism(false)).toBe(true);
    process.env.VITEST_FILE_PARALLELISM = '0';
    expect(resolveFileParallelism(true)).toBe(false);
    process.env.VITEST_FILE_PARALLELISM = 'false';
    expect(resolveFileParallelism(true)).toBe(false);
  });

  it('resolveMaxConcurrency falls back to defaultCap when env is unset or invalid', () => {
    expect(resolveMaxConcurrency(3)).toBe(3);
    process.env.VITEST_MAX_CONCURRENCY = 'not-a-number';
    expect(resolveMaxConcurrency(4)).toBe(4);
    process.env.VITEST_MAX_CONCURRENCY = '0';
    expect(resolveMaxConcurrency(5)).toBe(5);
  });

  it('resolveMaxConcurrency honors positive integer env', () => {
    process.env.VITEST_MAX_CONCURRENCY = '7';
    expect(resolveMaxConcurrency(2)).toBe(7);
  });

  it('vitestMemorySchedulerOptions matches resolve helpers with defaults', () => {
    expect(vitestMemorySchedulerOptions()).toEqual({
      fileParallelism: resolveFileParallelism(false),
      maxConcurrency: resolveMaxConcurrency(2),
    });
  });
});
