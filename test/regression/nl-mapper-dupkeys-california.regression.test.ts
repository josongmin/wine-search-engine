import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { NLMapper } from '../../src/domain/attribute/service/nl-mapper.js';
import { listDefaultMappingEntries } from '../../src/domain/attribute/service/nl-mapper.js';
import type { MappingTablePort } from '../../src/domain/attribute/port/mapping-table.port.js';

// Forces fallback to built-in DEFAULT_MAPPINGS (repository always misses).
const nullPort: MappingTablePort = {
  findMapping: async () => null,
  findMappingsByAttribute: async () => [],
  getCurrentVersion: async () => 'v1.0',
};

const mapper = new NLMapper(nullPort);

// The DEFAULT_MAPPINGS literal lives in the extracted vocabulary module; scan
// that source so the duplicate-key sweep stays attached to the actual catalog.
const NL_MAPPER_SOURCE_PATH = fileURLToPath(
  new URL('../../src/domain/attribute/service/nl-mapper-vocabulary.ts', import.meta.url),
);

describe('regression: nl-mapper duplicate keys + california region', () => {
  // ── (a) No duplicate Map keys in DEFAULT_MAPPINGS ────────────────────────
  // A duplicate key in a Map literal silently last-wins; if two declarations
  // disagree on threshold/confidence the earlier one is dead and the effective
  // value drifts invisibly. Detect at the SOURCE level because the runtime Map
  // has already collapsed duplicates.
  it('declares every DEFAULT_MAPPINGS key exactly once in source', () => {
    const source = readFileSync(NL_MAPPER_SOURCE_PATH, 'utf8');
    // Match single-line entries: `  ['key', { ... }],`
    const singleLine = [...source.matchAll(/^\s*\['((?:[^'\\]|\\.)*)',\s*\{/gmu)].map(
      (m) => m[1] as string,
    );
    // Match multi-line entries: `  [\n    'key',` (key on the line after `[`).
    const multiLine = [...source.matchAll(/^\s*\[\s*\n\s*'((?:[^'\\]|\\.)*)',\s*$/gmu)].map(
      (m) => m[1] as string,
    );
    const allKeys = [...singleLine, ...multiLine];

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const key of allKeys) {
      if (seen.has(key)) duplicates.push(key);
      seen.add(key);
    }
    expect(duplicates).toEqual([]);

    // Sanity: the source scan actually found the catalog (guards against the
    // regex silently matching nothing and the assertion passing vacuously).
    expect(allKeys.length).toBeGreaterThan(50);
  });

  // The phrases that previously had conflicting duplicate declarations must
  // resolve to the intended (currently-effective, last-wins) thresholds.
  it.each([
    ['평점 높은', 'critic_score', 0.8, 0.85],
    ['점수 높은', 'critic_score', 0.8, 0.85],
    ['평점 좋은', 'critic_score', 0.7, 0.8],
    ['점수 좋은', 'critic_score', 0.7, 0.8],
    ['드라이', 'sweetness', 0.2, 0.8],
  ])('%s resolves to %s=%d (conf %d) with no silent override', async (
    phrase,
    attr,
    value,
    confidence,
  ) => {
    const m = await mapper.mapPhrase(phrase);
    expect(m).not.toBeNull();
    expect(m!.mappedAttribute).toBe(attr);
    expect(m!.value).toBe(value);
    expect(m!.mappingConfidence).toBe(confidence);
  });

  // ── (b) california is a REGION, not a country ────────────────────────────
  it('maps "california" to region=California (not country=United States)', async () => {
    const m = await mapper.mapPhrase('california');
    expect(m).not.toBeNull();
    expect(m!.mappedAttribute).toBe('region');
    expect(m!.operator).toBe('=');
    expect(m!.value).toBe('California');
  });

  // ── Adjacent regression: untouched country/region surfaces still work ────
  it.each([
    ['미국', 'country', 'United States'],
    ['usa', 'country', 'United States'],
  ])('country surface "%s" is unchanged → %s=%s', async (phrase, attr, value) => {
    const m = await mapper.mapPhrase(phrase);
    expect(m).not.toBeNull();
    expect(m!.mappedAttribute).toBe(attr);
    expect(m!.value).toBe(value);
  });

  it('region surface "보르도" is unchanged → region=Bordeaux', async () => {
    const m = await mapper.mapPhrase('보르도');
    expect(m).not.toBeNull();
    expect(m!.mappedAttribute).toBe('region');
    expect(m!.value).toBe('Bordeaux');
  });

  // The deduped runtime view must agree: california is region-attributed and
  // no longer contributes a country=United States alias.
  it('listDefaultMappingEntries has california under region only', () => {
    const entries = listDefaultMappingEntries();
    const california = entries.filter(([key]) => key === 'california');
    expect(california).toHaveLength(1);
    expect(california[0]![1].mappedAttribute).toBe('region');
    expect(california[0]![1].value).toBe('California');
  });
});
