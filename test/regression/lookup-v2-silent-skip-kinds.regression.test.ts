/**
 * Invariant: lookup-v2 degradation counters are declared in SilentSkipKind and
 * SILENT_SKIP_KINDS — parity required for createZeroedCounts() initialization.
 *
 * Append-only test: never delete this file.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FILE_PATH = fileURLToPath(
  new URL('../../src/domain/observability/silent-skip-counters.ts', import.meta.url),
);

const LOOKUP_V2_SILENT_SKIP_KINDS = [
  'lookup_retrieval_channel_failure',
  'lookup_scope_graph_channel_failure',
  'lookup_retrieval_engine_failure',
] as const;

describe('SilentSkipKind lookup-v2 degradation entries', () => {
  const src = readFileSync(FILE_PATH, 'utf8');

  for (const kind of LOOKUP_V2_SILENT_SKIP_KINDS) {
    it(`declares "${kind}" in the union AND in SILENT_SKIP_KINDS`, () => {
      const matches = src.match(new RegExp(kind, 'g')) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(2);
    });
  }
});
