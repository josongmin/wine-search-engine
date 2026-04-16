import { describe, expect, it, vi } from 'vitest';
import { isAliasTableAvailable, PgAliasMatcher } from '../pg-alias-matcher.js';

interface AliasRow {
  entity_id: string;
  surface_form: string;
  normalized_value: string;
  confidence: number;
}

// T-010/W2: MockPool now intercepts active_search_snapshot pointer reads so
// the production read path (which resolves the pointer before every lookup)
// can run against mocked aliases data.
const POINTER_ROW = Object.freeze({
  active_snapshot_id: 'test-snapshot-id',
  previous_snapshot_id: null,
  content_hash: 'test-hash',
  promoted_at: new Date('2026-04-14T00:00:00Z'),
});

class MockPool {
  readonly queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  private aliasQueryIdx = 0;

  constructor(private readonly responses: readonly AliasRow[][]) {}

  async query(sql: string, params: readonly unknown[]): Promise<{ rows: unknown[] }> {
    if (sql.includes('FROM active_search_snapshot')) {
      // Pointer queries are invisible to the alias-query index (tests count alias calls, not pointer calls).
      return { rows: [POINTER_ROW] };
    }
    this.queries.push({ sql, params });
    const next = this.responses[this.aliasQueryIdx] ?? [];
    this.aliasQueryIdx++;
    if (typeof sql === 'string' && sql.includes('FROM unnest')) {
      const queryIds = Array.isArray(params?.[0]) ? (params[0] as readonly number[]) : [];
      return {
        rows: next.map((row, index) => ({
          ...row,
          queryId: queryIds[index] ?? queryIds[queryIds.length - 1],
        })),
      };
    }
    return { rows: [...next] };
  }
}

class MissingAliasPool {
  readonly queries: Array<{ sql: string; params: readonly unknown[] }> = [];

  async query(sql: string, params: readonly unknown[]): Promise<{ rows: unknown[] }> {
    this.queries.push({ sql, params });
    if (sql.includes('FROM active_search_snapshot')) {
      return { rows: [POINTER_ROW] };
    }
    const err = new Error('relation "aliases" does not exist') as Error & { code?: string };
    err.code = '42P01';
    throw err;
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
    expect(results[0]?.lookupStrategy).toContain('compact_exact');
    expect(pool.queries).toHaveLength(1);
  });

  it('labels transliterated exact matches when Korean input collapses onto a latin alias', async () => {
    const pool = new MockPool([
      [
        {
          entity_id: 'entity-chateau-margaux',
          surface_form: 'Chateau Margaux',
          normalized_value: 'chateau margaux',
          confidence: 0.95,
        },
      ],
    ]);
    const matcher = new PgAliasMatcher(pool as never);

    const results = await matcher.findMatches('샤토 마고');

    expect(results).toHaveLength(1);
    expect(results[0]?.entityIds).toEqual(['entity-chateau-margaux']);
    expect(results[0]?.lookupStrategy).toContain('transliterated_exact');
  });

  it('labels phonetic exact matches when consonant skeletons align', async () => {
    const pool = new MockPool([
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
    expect(results[0]?.lookupStrategy).toContain('phonetic_exact');
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

  it('resolves batch lookups for multiple queries without serial alias path bottlenecks', async () => {
    const pool = new MockPool([
      [
        {
          entity_id: 'entity-opus-one',
          surface_form: 'Opus One',
          normalized_value: 'opus one',
          confidence: 0.93,
        },
      ],
      [
        {
          entity_id: 'entity-chateau-margaux',
          surface_form: 'Chateau Margaux',
          normalized_value: 'chateau margaux',
          confidence: 0.91,
        },
      ],
    ]);
    const matcher = new PgAliasMatcher(pool as never);

    const batch = await matcher.findMatchesBatch(['opusone', 'chateau margaux']);

    expect(batch.get('opusone')?.[0]?.entityIds).toEqual(['entity-opus-one']);
    expect(batch.get('chateau margaux')?.[0]?.entityIds).toEqual(['entity-chateau-margaux']);
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

  it('fails closed to empty matches when aliases table is absent', async () => {
    const pool = {
      async query(): Promise<never> {
        const err = new Error('relation "aliases" does not exist') as Error & { code?: string };
        err.code = '42P01';
        throw err;
      },
    };
    const matcher = new PgAliasMatcher(pool as never);

    await expect(matcher.findMatches('opusone')).resolves.toEqual([]);
  });

  it('caches aliases table existence checks per pool', async () => {
    const query = vi.fn(async () => ({
      rows: [{ aliases_exists: true }],
    }));
    const pool = { query } as never;

    expect(await isAliasTableAvailable(pool)).toBe(true);
    expect(await isAliasTableAvailable(pool)).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('short-circuits aliases table misses after first 42P01', async () => {
    const pool = new MissingAliasPool();
    const matcher = new PgAliasMatcher(pool as never);

    await matcher.findMatches('opusone');
    await matcher.findMatches('opusone');

    const pointerQueries = pool.queries.filter((query) =>
      query.sql.includes('FROM active_search_snapshot'),
    );
    const aliasQueries = pool.queries.filter((query) =>
      query.sql.includes('FROM unnest'),
    );
    expect(pointerQueries).toHaveLength(1);
    expect(aliasQueries).toHaveLength(1);
  });
});
