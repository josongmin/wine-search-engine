import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cpuBoundThreads,
  IO_BOUND_THREAD_CAP,
  resolveFileParallelism,
  resolveMaxConcurrency,
  resolveMaxThreads,
  vitestMemorySchedulerOptions,
} from '../../../config/vitest/parallelism.js';

const availableCpus = (): number => os.availableParallelism?.() ?? os.cpus().length;

describe('config/vitest parallelism tuning', () => {
  let snapshotFileParallelism: string | undefined;
  let snapshotMaxConcurrency: string | undefined;
  let snapshotMaxThreads: string | undefined;

  beforeEach(() => {
    snapshotFileParallelism = process.env.VITEST_FILE_PARALLELISM;
    snapshotMaxConcurrency = process.env.VITEST_MAX_CONCURRENCY;
    snapshotMaxThreads = process.env.VITEST_MAX_THREADS;
    delete process.env.VITEST_FILE_PARALLELISM;
    delete process.env.VITEST_MAX_CONCURRENCY;
    delete process.env.VITEST_MAX_THREADS;
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
    if (snapshotMaxThreads === undefined) {
      delete process.env.VITEST_MAX_THREADS;
    } else {
      process.env.VITEST_MAX_THREADS = snapshotMaxThreads;
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

  it('cpuBoundThreads reserves headroom and stays within the core count', () => {
    const cpus = availableCpus();
    const expected = Math.max(1, cpus - 2);
    expect(cpuBoundThreads()).toBe(expected);
    expect(cpuBoundThreads()).toBeGreaterThanOrEqual(1);
    expect(cpuBoundThreads()).toBeLessThanOrEqual(cpus);
  });

  it('IO_BOUND_THREAD_CAP is a small positive cap that protects shared connection pools', () => {
    expect(Number.isInteger(IO_BOUND_THREAD_CAP)).toBe(true);
    expect(IO_BOUND_THREAD_CAP).toBeGreaterThanOrEqual(1);
    // Must stay well below a typical CPU budget so DB/network lanes do not
    // exhaust RDS/Vespa connection pools when fanned out.
    expect(IO_BOUND_THREAD_CAP).toBeLessThanOrEqual(8);
  });

  it('resolveMaxThreads(cpuBoundThreads()) never exceeds the machine core count', () => {
    expect(resolveMaxThreads(cpuBoundThreads())).toBeLessThanOrEqual(availableCpus());
    expect(resolveMaxThreads(cpuBoundThreads())).toBeGreaterThanOrEqual(1);
  });

  it('vitestMemorySchedulerOptions() with no lane stays conservative (forks/benchmark lanes)', () => {
    expect(vitestMemorySchedulerOptions()).toEqual({
      fileParallelism: false,
      maxConcurrency: 2,
    });
  });

  it('vitestMemorySchedulerOptions("cpu") parallelizes pure CPU lanes', () => {
    const opts = vitestMemorySchedulerOptions('cpu');
    expect(opts.fileParallelism).toBe(true);
    expect(opts.maxConcurrency).toBeGreaterThan(2);
  });

  it('vitestMemorySchedulerOptions("io") parallelizes but keeps within-file concurrency low', () => {
    const opts = vitestMemorySchedulerOptions('io');
    expect(opts.fileParallelism).toBe(true);
    // DB/network lanes must not pile concurrent queries inside a single file.
    expect(opts.maxConcurrency).toBe(2);
  });

  it('lane-aware fileParallelism still honors an explicit env override', () => {
    process.env.VITEST_FILE_PARALLELISM = '0';
    expect(vitestMemorySchedulerOptions('cpu').fileParallelism).toBe(false);
    expect(vitestMemorySchedulerOptions('io').fileParallelism).toBe(false);
    process.env.VITEST_FILE_PARALLELISM = '1';
    expect(vitestMemorySchedulerOptions().fileParallelism).toBe(true);
  });
});
