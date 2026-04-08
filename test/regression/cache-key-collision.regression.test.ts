/**
 * Cache key collision regression tests.
 *
 * Verifies that the cache key builder produces distinct keys for
 * inputs that previously collided due to:
 *  - Delimiter characters in constraint values
 *  - Soft vs hard constraint namespace overlap
 *  - Lexical vs semantic expansion type collision
 *  - Missing snapshot version isolation
 *
 * Append-only — never delete a regression test.
 */

import { describe, it, expect } from 'vitest';
import { QueryCacheKeyBuilder } from '../../src/domain/performance/model/cache-key.js';

const builder = new QueryCacheKeyBuilder();

describe('Cache key collision prevention', () => {
  it('constraint value containing pipe does not collide with adjacent tuples', () => {
    const key1 = builder.build(
      'test query',
      'entity_lookup',
      [['producer', 'eq', 'A|B']],
      [],
    );
    const key2 = builder.build(
      'test query',
      'entity_lookup',
      [['producer', 'eq', 'A'], ['B', 'eq', '']],
      [],
    );
    expect(key1.redisKey).not.toBe(key2.redisKey);
  });

  it('constraint value containing double-pipe does not collide', () => {
    const key1 = builder.build(
      'test query',
      'entity_lookup',
      [['type', 'eq', 'red||white']],
      [],
    );
    const key2 = builder.build(
      'test query',
      'entity_lookup',
      [['type', 'eq', 'red'], ['white', 'eq', '']],
      [],
    );
    expect(key1.redisKey).not.toBe(key2.redisKey);
  });

  it('soft constraint does not collide with identically-named hard constraint', () => {
    const key1 = builder.build(
      'test query',
      'entity_lookup',
      [['region', 'eq', 'Bordeaux']],
      [],
    );
    const key2 = builder.build(
      'test query',
      'entity_lookup',
      [['soft:region', 'eq', 'Bordeaux']],
      [],
    );
    expect(key1.redisKey).not.toBe(key2.redisKey);
  });

  it('lexical expansion does not collide with semantic expansion', () => {
    const key1 = builder.build(
      'test query',
      'entity_lookup',
      [],
      ['L:red', 'S:wine'],
    );
    const key2 = builder.build(
      'test query',
      'entity_lookup',
      [],
      ['L:red', 'L:wine'],
    );
    expect(key1.redisKey).not.toBe(key2.redisKey);
  });

  it('different snapshot IDs produce different keys', () => {
    const key1 = builder.build(
      'test query',
      'entity_lookup',
      [],
      [],
      undefined,
      undefined,
      'snapshot-v1',
    );
    const key2 = builder.build(
      'test query',
      'entity_lookup',
      [],
      [],
      undefined,
      undefined,
      'snapshot-v2',
    );
    expect(key1.redisKey).not.toBe(key2.redisKey);
  });

  it('same inputs produce the same key (deterministic)', () => {
    const key1 = builder.build(
      'bordeaux 2015',
      'hybrid',
      [['country', 'eq', 'France'], ['vintage', 'gte', '2015']],
      ['L:bordeaux', 'S:french wine'],
      'session-123',
      'ko-KR',
      'snapshot-abc',
    );
    const key2 = builder.build(
      'bordeaux 2015',
      'hybrid',
      [['country', 'eq', 'France'], ['vintage', 'gte', '2015']],
      ['L:bordeaux', 'S:french wine'],
      'session-123',
      'ko-KR',
      'snapshot-abc',
    );
    expect(key1.redisKey).toBe(key2.redisKey);
  });

  it('constraint sort order does not affect key (order-independent)', () => {
    const key1 = builder.build(
      'test',
      'hybrid',
      [['a', 'eq', '1'], ['b', 'eq', '2']],
      [],
    );
    const key2 = builder.build(
      'test',
      'hybrid',
      [['b', 'eq', '2'], ['a', 'eq', '1']],
      [],
    );
    expect(key1.redisKey).toBe(key2.redisKey);
  });
});
