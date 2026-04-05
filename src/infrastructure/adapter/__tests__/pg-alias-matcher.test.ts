import { describe, expect, it } from 'vitest';
import { PgAliasMatcher } from '../pg-alias-matcher.js';

interface AliasRow {
  entity_id: string;
  surface_form: string;
  normalized_value: string;
  confidence: number;
}

class MockPool {
  readonly queries: Array<{ sql: string; params: readonly unknown[] }> = [];

  constructor(private readonly responses: readonly AliasRow[][]) {}

  async query<T extends AliasRow>(sql: string, params: readonly unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ sql, params });
    const next = this.responses[this.queries.length - 1] ?? [];
    return { rows: next as T[] };
  }
}

describe('PgAliasMatcher', () => {
  it('matches compact noisy input like "opusone" against spaced alias values', async () => {
    const pool = new MockPool([
      [
        {
          entity_id: 'entity-opus-one',
          surface_form: 'Opus One',
          normalized_value: 'opus one',
          confidence: 0.92,
        },
      ],
    ]);
    const matcher = new PgAliasMatcher(pool as never);

    const results = await matcher.findMatches('opusone');

    expect(results).toHaveLength(1);
    expect(results[0]?.normalizedForm).toBe('opus one');
    expect(results[0]?.entityIds).toEqual(['entity-opus-one']);
    expect(pool.queries).toHaveLength(1);
  });

  it('falls back to compact char-level fuzzy recall for near-miss noisy aliases', async () => {
    const pool = new MockPool([
      [],
      [
        {
          entity_id: 'entity-romanee-conti',
          surface_form: 'Romanee Conti',
          normalized_value: 'romanee conti',
          confidence: 0.9,
        },
      ],
    ]);
    const matcher = new PgAliasMatcher(pool as never);

    const results = await matcher.findMatches('romane conti');

    expect(results).toHaveLength(1);
    expect(results[0]?.entityIds).toEqual(['entity-romanee-conti']);
    expect(results[0]!.matchConfidence).toBeGreaterThan(0.7);
    expect(pool.queries).toHaveLength(2);
  });

  it('scores fuzzy candidates against multiple normalized variants, including transliterated compact forms', async () => {
    const pool = new MockPool([
      [],
      [
        {
          entity_id: 'entity-opus-one-2018',
          surface_form: 'Opus One 2018',
          normalized_value: 'opus one 2018',
          confidence: 0.94,
        },
      ],
    ]);
    const matcher = new PgAliasMatcher(pool as never);

    const results = await matcher.findMatches('오푸스원 18');

    expect(results).toHaveLength(1);
    expect(results[0]?.entityIds).toEqual(['entity-opus-one-2018']);
    expect(results[0]!.matchConfidence).toBeGreaterThan(0.55);
    expect(pool.queries).toHaveLength(2);
  });

  it('does not run broad fuzzy fallback for very short noisy queries', async () => {
    const pool = new MockPool([[]]);
    const matcher = new PgAliasMatcher(pool as never);

    const results = await matcher.findMatches('dr');

    expect(results).toEqual([]);
    expect(pool.queries).toHaveLength(1);
  });
});
