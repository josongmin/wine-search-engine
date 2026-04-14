/**
 * Invariant: the SilentSkipKind union declares the 3 kinds introduced by the
 * runtime plane composite-PK migration (learning warmup, learning adapter,
 * alias checker). `SILENT_SKIP_KINDS` array must include them too — parity
 * between the type and the runtime list is what `createZeroedCounts()` relies
 * on to initialize counters without `undefined` holes.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE_PATH = fileURLToPath(
  new URL('../../src/observability/silent-skip-counters.ts', import.meta.url),
);

const REQUIRED_KINDS = [
  'learning_warmup_disabled_snapshot_pointer_missing',
  'learning_adapter_disabled_snapshot_pointer_missing',
  'alias_checker_disabled_snapshot_pointer_missing',
] as const;

describe('SilentSkipKind runtime plane migration entries', () => {
  const src = readFileSync(FILE_PATH, 'utf8');

  for (const kind of REQUIRED_KINDS) {
    it(`declares "${kind}" in the union AND in SILENT_SKIP_KINDS`, () => {
      // Union membership — expect at least 2 matches (type alias + array literal).
      const matches = src.match(new RegExp(kind, 'g')) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  }
});
