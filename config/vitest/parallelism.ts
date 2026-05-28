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

/**
 * Cores reserved for the OS + the vitest pool coordinator so the box stays
 * responsive and the main process is never starved by worker threads.
 */
const RESERVED_CORES = 2;

/**
 * Within-file concurrency for CPU-bound lanes. Only affects files that opt into
 * `test.concurrent`; raising it lets those batches use spare cores while keeping
 * the default modest so serial files are unaffected.
 */
const CPU_LANE_MAX_CONCURRENCY = 4;

/**
 * Default within-file concurrency for IO-bound lanes. Kept at the conservative
 * baseline so DB/network lanes do not pile concurrent queries inside one file.
 */
const IO_LANE_MAX_CONCURRENCY = 2;

/**
 * Thread budget for pure CPU lanes (unit/dev/regression). Uses every core except
 * the reserved headroom — these tests have no external dependencies, so the only
 * ceiling is the machine itself.
 */
export function cpuBoundThreads(): number {
  return Math.max(1, availableCpus() - RESERVED_CORES);
}

/**
 * Thread cap for IO-bound lanes (integration/watchlist). These share a single
 * RDS instance and a self-hosted Vespa node; fanning out past a handful of
 * workers exhausts connection pools and surfaces as flaky timeouts. Override per
 * machine with VITEST_MAX_THREADS when the shared infra can take more.
 */
export const IO_BOUND_THREAD_CAP = 4;

/**
 * Pool scheduler knobs, tuned per lane class:
 * - no lane (forks/singleFork + benchmark lanes): conservative baseline, unchanged.
 * - 'cpu': parallelize files across cores; higher within-file concurrency.
 * - 'io': parallelize files (capped by maxThreads at the call site) but keep
 *   within-file concurrency low to protect shared connection pools.
 * `fileParallelism` always honors an explicit VITEST_FILE_PARALLELISM override.
 */
export function vitestMemorySchedulerOptions(lane?: 'cpu' | 'io'): {
  fileParallelism: boolean;
  maxConcurrency: number;
} {
  const parallelByDefault = lane !== undefined;
  const concurrencyDefault = lane === 'cpu' ? CPU_LANE_MAX_CONCURRENCY : IO_LANE_MAX_CONCURRENCY;
  return {
    fileParallelism: resolveFileParallelism(parallelByDefault),
    maxConcurrency: resolveMaxConcurrency(concurrencyDefault),
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
