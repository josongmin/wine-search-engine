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

  it('absent locale does not collide with a caller-supplied "default" literal', () => {
    // Previously the builder used `locale ?? 'default'`, so a user sending
    // `locale: 'default'` silently shared cache buckets with unspecified
    // locale — cross-locale poisoning with zero observable signal.
    const keyAbsent = builder.build(
      'test query',
      'entity_lookup',
      [],
      [],
      undefined,
      undefined,
    );
    const keyDefaultLiteral = builder.build(
      'test query',
      'entity_lookup',
      [],
      [],
      undefined,
      'default',
    );
    expect(keyAbsent.redisKey).not.toBe(keyDefaultLiteral.redisKey);
  });

  it('different present locales produce different keys', () => {
    const keyKo = builder.build(
      'test query',
      'entity_lookup',
      [],
      [],
      undefined,
      'ko-KR',
    );
    const keyEn = builder.build(
      'test query',
      'entity_lookup',
      [],
      [],
      undefined,
      'en-US',
    );
    expect(keyKo.redisKey).not.toBe(keyEn.redisKey);
  });

  it('caller-supplied locale that looks like the sentinel prefix does not collide with absent', () => {
    // The absent sentinel is `l:-`. A caller passing `'l:-'` is still
    // distinct from absent (they are different inputs), so confirm the
    // encoding prefix cannot be spoofed.
    const keyAbsent = builder.build(
      'test query',
      'entity_lookup',
      [],
      [],
      undefined,
      undefined,
    );
    const keySpoof = builder.build(
      'test query',
      'entity_lookup',
      [],
      [],
      undefined,
      'l:-',
    );
    // These SHOULD differ — an explicit caller-supplied 'l:-' is a
    // different semantic input than "locale absent". The prefix treatment
    // ensures caller=>`l:l:-` vs absent=>`l:-`.
    expect(keyAbsent.redisKey).not.toBe(keySpoof.redisKey);
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
