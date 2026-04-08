import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isBenchmarkRunnerCliEntrypoint } from '../../../../test/benchmark/agent/runner-cli-entry.js';

describe('isBenchmarkRunnerCliEntrypoint', () => {
  it('returns false when argv1 is undefined', () => {
    expect(isBenchmarkRunnerCliEntrypoint(undefined, import.meta.url)).toBe(false);
  });

  it('returns true when argv1 resolves to the same file as importMetaUrl', () => {
    const path = fileURLToPath(import.meta.url);
    expect(isBenchmarkRunnerCliEntrypoint(path, import.meta.url)).toBe(true);
  });

  it('returns false for a different file path', () => {
    const path = fileURLToPath(import.meta.url);
    expect(isBenchmarkRunnerCliEntrypoint(`${path}.nope`, import.meta.url)).toBe(false);
  });

  it('matches cwd-relative argv against absolute importMetaUrl (tsx-style)', () => {
    const abs = resolve(process.cwd(), 'test/benchmark/agent/runner.ts');
    const url = pathToFileURL(abs).href;
    expect(isBenchmarkRunnerCliEntrypoint('test/benchmark/agent/runner.ts', url)).toBe(true);
  });
});
