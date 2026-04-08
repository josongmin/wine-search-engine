/**
 * Property-based regression tests using fast-check.
 *
 * These tests assert PROPERTIES (universal truths) that should hold for all
 * inputs, not specific examples. Property-based testing catches edge cases
 * that example-based testing misses — exactly the kind of bugs that slipped
 * through audit rounds 1-7.
 *
 * Append-only. Add new properties; never delete or weaken existing ones.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { escapeLikePattern } from '../../src/infrastructure/adapter/pg-blocking-adapter.js';
import { camelToSnake } from '../../src/interface/http/middleware/snake-case-hook.js';
import { CreateWatchlistRequestSchema } from '../../src/interface/http/schemas/watchlist.schema.js';
import { ConfidenceRefusalPolicy } from '../../src/domain/decision/service/confidence-refusal.js';
import { EmbeddingCacheKeyBuilder } from '../../src/domain/performance/model/cache-key.js';

describe('Property: escapeLikePattern (PostgreSQL LIKE escape)', () => {
  // Dense metacharacter generator: ensures actual escape paths are exercised.
  // Default fc.string() rarely produces %, _, \\ — only ~5% of runs hit them.
  const denseMetaString = fc.array(
    fc.constantFrom('a', 'b', 'x', '%', '_', '\\', "'", '0'),
    { minLength: 0, maxLength: 30 },
  ).map((arr) => arr.join(''));

  it('output never contains unescaped LIKE metacharacters', () => {
    fc.assert(
      fc.property(denseMetaString, (input) => {
        const escaped = escapeLikePattern(input);
        // Walk through escaped string: every %, _, or \ must be preceded by \
        for (let i = 0; i < escaped.length; i++) {
          const ch = escaped[i];
          if (ch === '%' || ch === '_' || ch === '\\') {
            const prev = i > 0 ? escaped[i - 1] : '';
            if (ch === '\\') {
              // backslash must be followed by another metachar
              const next = escaped[i + 1];
              if (next !== '%' && next !== '_' && next !== '\\') {
                return false;
              }
              i++; // skip the escaped char
            } else {
              if (prev !== '\\') return false;
            }
          }
        }
        return true;
      }),
      { numRuns: 500 },
    );
  });

  it('idempotent on safe strings (no metacharacters)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', 'c', '0', '1', ' ', '-'), { maxLength: 30 })
          .map((arr) => arr.join('')),
        (input) => escapeLikePattern(input) === input,
      ),
      { numRuns: 500 },
    );
  });

  it('preserves length-or-grows (never shortens)', () => {
    fc.assert(
      fc.property(denseMetaString, (input) => {
        return escapeLikePattern(input).length >= input.length;
      }),
      { numRuns: 500 },
    );
  });

  it('exact known cases', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('foo_bar')).toBe('foo\\_bar');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
    expect(escapeLikePattern('plain')).toBe('plain');
  });
});

describe('Property: camelToSnake', () => {
  it('exact known cases', () => {
    expect(camelToSnake('fooBar')).toBe('foo_bar');
    expect(camelToSnake('snake_case')).toBe('snake_case');
    expect(camelToSnake('XMLParser')).toBe('x_m_l_parser');
    expect(camelToSnake('ABC')).toBe('a_b_c');
    expect(camelToSnake('camelCaseTest')).toBe('camel_case_test');
  });

  it('idempotent on real camelCase inputs (run twice = run once)', () => {
    fc.assert(
      fc.property(
        // Real camelCase: starts with lowercase, contains some uppercase
        fc.tuple(
          fc.stringMatching(/^[a-z]{1,5}$/),
          fc.array(fc.tuple(fc.stringMatching(/^[A-Z]$/), fc.stringMatching(/^[a-z]{1,5}$/)),
            { minLength: 1, maxLength: 4 }),
        ).map(([head, tail]) => head + tail.map(([u, l]) => u + l).join('')),
        (camel) => {
          const once = camelToSnake(camel);
          const twice = camelToSnake(once);
          return once === twice;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('output is lowercase (no uppercase letters)', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z]+$/), (input) => {
        const out = camelToSnake(input);
        return out === out.toLowerCase();
      }),
      { numRuns: 500 },
    );
  });
});

describe('Property: isPrivateOrReservedHost (via watchlist schema)', () => {
  it('legitimate domains starting with fc/fd/fe never blocked', () => {
    // Generate hostnames that start with fc/fd/fe but are clearly TLD domains
    fc.assert(
      fc.property(
        fc.tuple(
          fc.constantFrom('fc', 'fd', 'fe', 'fcm', 'fdb', 'fed', 'feb', 'fea'),
          fc.stringMatching(/^[a-z]{2,8}$/),
          fc.constantFrom('com', 'org', 'net', 'io'),
        ),
        ([prefix, mid, tld]) => {
          const domain = `${prefix}${mid}.${tld}`;
          const result = CreateWatchlistRequestSchema.safeParse({
            entity_id: 'wine-1',
            trigger_conditions: [{ type: 'critic_score_above', threshold: 90 }],
            callback_url: `https://${domain}/webhook`,
          });
          // These are all legitimate FQDNs and must NOT be rejected
          return result.success;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('any IPv4 in 127.0.0.0/8 is always blocked', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 0, max: 255 }),
          fc.integer({ min: 0, max: 255 }),
          fc.integer({ min: 0, max: 255 }),
        ),
        ([b, c, d]) => {
          const result = CreateWatchlistRequestSchema.safeParse({
            entity_id: 'wine-1',
            trigger_conditions: [{ type: 'critic_score_above', threshold: 90 }],
            callback_url: `https://127.${b}.${c}.${d}/webhook`,
          });
          return !result.success;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('any IPv4 in 10.0.0.0/8 is always blocked', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 0, max: 255 }),
          fc.integer({ min: 0, max: 255 }),
          fc.integer({ min: 0, max: 255 }),
        ),
        ([b, c, d]) => {
          const result = CreateWatchlistRequestSchema.safeParse({
            entity_id: 'wine-1',
            trigger_conditions: [{ type: 'critic_score_above', threshold: 90 }],
            callback_url: `https://10.${b}.${c}.${d}/webhook`,
          });
          return !result.success;
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property: ConfidenceRefusalPolicy', () => {
  it('non-finite values always cause refusal', () => {
    const policy = new ConfidenceRefusalPolicy(0.5);
    expect(policy.shouldRefuse(NaN)).toBe(true);
    expect(policy.shouldRefuse(Infinity)).toBe(true);
    expect(policy.shouldRefuse(-Infinity)).toBe(true);
  });

  it('values strictly below threshold always cause refusal', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0.1), max: Math.fround(1), noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: Math.fround(0.001), max: Math.fround(0.099), noNaN: true, noDefaultInfinity: true }),
        (threshold, delta) => {
          const policy = new ConfidenceRefusalPolicy(threshold);
          const value = threshold - delta;
          fc.pre(value >= 0); // Ensure we're testing in valid range
          return policy.shouldRefuse(value);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('values strictly above threshold do not cause refusal', () => {
    fc.assert(
      fc.property(
        fc.float({ min: Math.fround(0.1), max: Math.fround(0.9), noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: Math.fround(0.001), max: Math.fround(0.099), noNaN: true, noDefaultInfinity: true }),
        (threshold, delta) => {
          const policy = new ConfidenceRefusalPolicy(threshold);
          return !policy.shouldRefuse(threshold + delta);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('Property: EmbeddingCacheKeyBuilder collision-resistance', () => {
  const builder = new EmbeddingCacheKeyBuilder();

  it('same inputs always produce same key', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
        (text, modelId, prefix) => {
          const a = builder.build(text, modelId, prefix);
          const b = builder.build(text, modelId, prefix);
          return a.redisKey === b.redisKey;
        },
      ),
      { numRuns: 100 },
    );
  });

  it('different texts produce different keys (within same model)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.string({ minLength: 1, maxLength: 50 }),
        (textA, textB) => {
          if (textA === textB) return true;
          const a = builder.build(textA, 'model-1');
          const b = builder.build(textB, 'model-1');
          return a.redisKey !== b.redisKey;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * The actual collision bug: ('Search:', 'test') and ('Search', ':test')
   * naive concatenation produces "Search:test" both times. Property test
   * generates pairs that would collide under naive concat and asserts the
   * delimiter prevents the collision.
   */
  it('prefix/text boundary cannot be confused (delimiter property)', () => {
    fc.assert(
      fc.property(
        // Generate (prefix, text) pairs where moving one char from prefix
        // to text would naively produce the same string.
        fc.tuple(
          fc.stringMatching(/^[a-zA-Z]{1,8}$/),
          fc.stringMatching(/^[a-zA-Z]{1,8}$/),
        ),
        ([p, t]) => {
          if (p.length === 0) return true;
          // Move one char from prefix to text
          const altPrefix = p.slice(0, -1);
          const altText = p.slice(-1) + t;
          const a = builder.build(t, 'model-1', p);
          const b = builder.build(altText, 'model-1', altPrefix);
          // The two distinct (prefix, text) pairs MUST hash differently
          return a.redisKey !== b.redisKey;
        },
      ),
      { numRuns: 200 },
    );
  });
});
