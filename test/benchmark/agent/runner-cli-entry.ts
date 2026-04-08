/**
 * Detect whether this module is the Node/tsx CLI entrypoint (vs import for tests/types).
 * Uses resolved paths so relative argv (`./runner.ts`) still matches `import.meta.url`.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isBenchmarkRunnerCliEntrypoint(
  argv1: string | undefined,
  importMetaUrl: string,
): boolean {
  if (argv1 === undefined) return false;
  try {
    const resolvedEntry = resolve(argv1);
    const thisFile = fileURLToPath(importMetaUrl);
    if (resolvedEntry === thisFile) return true;
    if (process.platform === 'win32' && resolvedEntry.toLowerCase() === thisFile.toLowerCase()) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
