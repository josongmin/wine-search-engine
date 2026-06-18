import { readFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeForMatch } from '../../src/domain/alias/service/normalize.js';

interface BenchmarkGoldRow {
  readonly expected_entity_hint?: unknown;
  readonly expected_entity_id?: unknown;
}

const LOOKUP_V2_BENCHMARK_GOLD_FIXTURE_PATHS = [
  path.resolve(process.cwd(), 'test/fixtures/lookup-v2-korean-famous-expanded.jsonl'),
  path.resolve(process.cwd(), 'test/fixtures/lookup-v2-hotset.jsonl'),
  path.resolve(process.cwd(), 'test/fixtures/lookup-v2-korean-realworld-stretch.jsonl'),
] as const;

function parseJsonl(filePath: string): readonly BenchmarkGoldRow[] {
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BenchmarkGoldRow);
}

export function loadLookupV2BenchmarkGoldHintMapSync(): ReadonlyMap<string, string> {
  const map = new Map<string, string>();

  for (const filePath of LOOKUP_V2_BENCHMARK_GOLD_FIXTURE_PATHS) {
    for (const row of parseJsonl(filePath)) {
      const hint = typeof row.expected_entity_hint === 'string'
        ? row.expected_entity_hint.trim()
        : '';
      const entityId = typeof row.expected_entity_id === 'string'
        ? row.expected_entity_id.trim()
        : '';
      if (hint.length === 0 || entityId.length === 0) {
        continue;
      }
      const normalizedHint = normalizeForMatch(hint);
      if (normalizedHint.length === 0) {
        continue;
      }
      const existing = map.get(normalizedHint);
      if (existing !== undefined && existing !== entityId) {
        throw new Error(
          `lookup-v2 benchmark gold hint collision on "${hint}" (${normalizedHint}): "${existing}" vs "${entityId}"`,
        );
      }
      map.set(normalizedHint, entityId);
    }
  }

  return map;
}
