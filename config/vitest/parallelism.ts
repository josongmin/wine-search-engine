import os from 'node:os';

const availableCpus = (): number => os.availableParallelism?.() ?? os.cpus().length;

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
