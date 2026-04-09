import os from 'node:os';

const availableCpus = (): number => os.availableParallelism?.() ?? os.cpus().length;

function parseEnvBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw === '') {
    return defaultValue;
  }
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

/**
 * When false (default), Vitest runs one test file at a time in the pool, lowering peak RSS.
 * Override with VITEST_FILE_PARALLELISM=1 for throughput on large machines.
 */
export function resolveFileParallelism(defaultValue = false): boolean {
  return parseEnvBoolean(process.env.VITEST_FILE_PARALLELISM, defaultValue);
}

/**
 * Caps concurrent tests within a file (including `test.concurrent` batches).
 * Override with VITEST_MAX_CONCURRENCY.
 */
export function resolveMaxConcurrency(defaultCap = 2): number {
  const parsed = Number.parseInt(process.env.VITEST_MAX_CONCURRENCY ?? '', 10);
  if (Number.isFinite(parsed) && parsed >= 1) {
    return parsed;
  }
  return Math.max(1, defaultCap);
}

export function vitestMemorySchedulerOptions(): {
  fileParallelism: boolean;
  maxConcurrency: number;
} {
  return {
    fileParallelism: resolveFileParallelism(false),
    maxConcurrency: resolveMaxConcurrency(2),
  };
}

export function resolveMaxThreads(defaultCap = 2): number {
  const parsed = Number.parseInt(process.env.VITEST_MAX_THREADS ?? String(defaultCap), 10);
  const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultCap;
  return Math.min(cap, Math.max(1, availableCpus()));
}

export function resolveMaxForks(defaultCap = 1): number {
  const parsed = Number.parseInt(process.env.VITEST_MAX_FORKS ?? String(defaultCap), 10);
  const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : defaultCap;
  return Math.min(cap, Math.max(1, availableCpus()));
}
