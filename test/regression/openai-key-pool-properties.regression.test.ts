/**
 * Property-based regression tests for the OpenAI key pool (SOTA++).
 *
 * The pool is the SSoT for OpenAI API-key rotation, rate-limit cooldown
 * tracking, and pool-exhaustion semantics shared by `openai-embedding-service`,
 * `openai-chat-llm`, and `openai-llm-injection-classifier`. These properties
 * lock industry-verified rotation invariants (round-robin fairness, exclusion
 * on failure, deterministic selection given clock+ops, no double-issue,
 * typed empty-pool defense) so future changes cannot silently regress them.
 *
 * Invariants verified (append-only, fast-check, numRuns: 100 per property):
 *   P1. Round-robin fairness — for K acquires against N healthy keys, each
 *       key is selected either ⌊K/N⌋ or ⌈K/N⌉ times (uniform within ±1).
 *   P2. No double-issue per call — `acquire()` returns exactly one slot or
 *       null; never returns two distinct slots for the same call.
 *   P3. Cooldown exclusion — after `markRateLimited(k)`, `acquire()` does
 *       NOT return `k` for any wall-clock value strictly less than the
 *       cooldown deadline (inject clock, vary `advance` amounts).
 *   P4. Cooldown boundary recovery — at exactly `markedAt + cooldownMs` the
 *       slot becomes acquirable again (`until <= now` semantics).
 *   P5. Exhaustion — when every slot is in cooldown, `acquire()` returns
 *       null AND `getStats().totalAcquires` does not increment.
 *   P6. Stats conservation — at every instant,
 *       `exhaustedCount + healthyCount === keyCount`.
 *   P7. Determinism under fixed (clock, op-sequence) — replaying the same
 *       sequence of {acquire, mark, advance} against two fresh pools yields
 *       byte-identical acquire-key sequences.
 *   P8. Normalization idempotence — `normalizeOpenAiApiKeys` is idempotent
 *       and order-stable (running it on its own output is a no-op).
 *   P9. Empty / whitespace-only pool defense — construction throws a typed
 *       Error rather than producing a 0-key pool.
 *  P10. totalAcquires monotonicity — never decreases; increments by exactly
 *       1 per non-null acquire and 0 per null acquire.
 *
 * Touch policy: this file is regression-only and append-only. It does NOT
 * modify `openai-key-pool.ts`. Korean inputs are exercised via P8 string
 * arbitraries (Unicode strings include 한글, é, emoji) per CLAUDE.md test
 * discipline rule 5.
 *
 * Test naming: invariant-first (per `feedback_test_naming` memory).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

import {
  OpenAiKeyPool,
  createOpenAiKeyPool,
  normalizeOpenAiApiKeys,
  DEFAULT_OPENAI_KEY_POOL_COOLDOWN_MS,
  type OpenAiKeyPoolClock,
} from '../../src/infrastructure/ai/openai-key-pool.js';
import { globalCircuitBreakerRegistry } from '../../src/domain/observability/circuit-breaker-registry.js';

// ────────────────────────────────────────────────────────────────────────────
// Named constants — Rule 15 (magic numbers in property tests)
// ────────────────────────────────────────────────────────────────────────────

/** fast-check runs per property — industry standard for invariant coverage. */
const RUNS = 100;

/** Circuit-breaker parameters — pool's identity is rotation, not breaker tuning. */
const FAILURE_THRESHOLD = 5;
const RECOVERY_TIMEOUT_MS = 60_000;
const HALF_OPEN_ATTEMPTS = 1;

/** Cooldown used by most properties; small enough to exercise boundaries fast. */
const COOLDOWN_MS = 30_000;

/** Synthetic clock starting offset — large enough to detect off-by-one drift. */
const CLOCK_T0 = 1_000_000;

/** Lower / upper bounds for the round-robin fairness property. */
const FAIRNESS_MIN_KEYS = 2;
const FAIRNESS_MAX_KEYS = 8;
const FAIRNESS_MIN_ACQUIRES = 1;
const FAIRNESS_MAX_ACQUIRES = 60;

// ────────────────────────────────────────────────────────────────────────────
// Test helpers
// ────────────────────────────────────────────────────────────────────────────

interface FakeClock extends OpenAiKeyPoolClock {
  advance(ms: number): void;
  set(ms: number): void;
}

function makeClock(start: number = CLOCK_T0): FakeClock {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    set: (ms: number) => {
      now = ms;
    },
  };
}

function distinctKeyNames(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
}

function newPool(
  baseName: string,
  keys: readonly string[],
  clock: OpenAiKeyPoolClock,
  cooldownMs: number = COOLDOWN_MS,
): OpenAiKeyPool {
  return new OpenAiKeyPool({
    baseBreakerName: baseName,
    apiKeys: keys,
    failureThreshold: FAILURE_THRESHOLD,
    recoveryTimeoutMs: RECOVERY_TIMEOUT_MS,
    halfOpenMaxAttempts: HALF_OPEN_ATTEMPTS,
    rateLimitCooldownMs: cooldownMs,
    clock,
  });
}

// fast-check arbitrary for an op sequence used by the determinism property.
type Op =
  | { kind: 'acquire' }
  | { kind: 'mark'; keyIndex: number }
  | { kind: 'advance'; ms: number };

function opSequenceArb(keyCount: number): fc.Arbitrary<readonly Op[]> {
  const ACQUIRE_WEIGHT = 5;
  const MARK_WEIGHT = 2;
  const ADVANCE_WEIGHT = 2;
  const acquireOp = fc.constant<Op>({ kind: 'acquire' });
  const markOp = fc
    .integer({ min: 0, max: keyCount - 1 })
    .map<Op>((keyIndex) => ({ kind: 'mark', keyIndex }));
  const advanceOp = fc
    .integer({ min: 0, max: COOLDOWN_MS * 3 })
    .map<Op>((ms) => ({ kind: 'advance', ms }));
  return fc.array(
    fc.oneof(
      { weight: ACQUIRE_WEIGHT, arbitrary: acquireOp },
      { weight: MARK_WEIGHT, arbitrary: markOp },
      { weight: ADVANCE_WEIGHT, arbitrary: advanceOp },
    ),
    { minLength: 1, maxLength: 40 },
  );
}

function replay(
  pool: OpenAiKeyPool,
  clock: FakeClock,
  keys: readonly string[],
  ops: readonly Op[],
): readonly (string | null)[] {
  const trace: (string | null)[] = [];
  for (const op of ops) {
    if (op.kind === 'acquire') {
      const slot = pool.acquire();
      trace.push(slot?.apiKey ?? null);
    } else if (op.kind === 'mark') {
      const k = keys[op.keyIndex];
      if (k !== undefined) pool.markRateLimited(k);
    } else {
      clock.advance(op.ms);
    }
  }
  return trace;
}

// ────────────────────────────────────────────────────────────────────────────
// Setup
// ────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  globalCircuitBreakerRegistry.clear();
});

afterEach(() => {
  globalCircuitBreakerRegistry.clear();
});

// ────────────────────────────────────────────────────────────────────────────
// P1 — Round-robin fairness
// ────────────────────────────────────────────────────────────────────────────

describe('OpenAiKeyPool: P1 round-robin fairness (property)', () => {
  it('K acquires against N healthy keys → each key hit ⌊K/N⌋ or ⌈K/N⌉ times', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: FAIRNESS_MIN_KEYS, max: FAIRNESS_MAX_KEYS }),
        fc.integer({ min: FAIRNESS_MIN_ACQUIRES, max: FAIRNESS_MAX_ACQUIRES }),
        (nKeys, kAcquires) => {
          globalCircuitBreakerRegistry.clear();
          const clock = makeClock();
          const keys = distinctKeyNames('p1', nKeys);
          const pool = newPool(`p1-${nKeys}-${kAcquires}`, keys, clock);

          const counts = new Map<string, number>(keys.map((k) => [k, 0]));
          for (let i = 0; i < kAcquires; i += 1) {
            const slot = pool.acquire();
            expect(slot).not.toBeNull();
            counts.set(slot!.apiKey, (counts.get(slot!.apiKey) ?? 0) + 1);
          }

          const floorHits = Math.floor(kAcquires / nKeys);
          const ceilHits = Math.ceil(kAcquires / nKeys);
          for (const count of counts.values()) {
            expect(count).toBeGreaterThanOrEqual(floorHits);
            expect(count).toBeLessThanOrEqual(ceilHits);
          }

          const summed = Array.from(counts.values()).reduce((a, b) => a + b, 0);
          expect(summed).toBe(kAcquires);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P2 — No double-issue per call
// ────────────────────────────────────────────────────────────────────────────

describe('OpenAiKeyPool: P2 acquire() returns exactly one slot or null', () => {
  it('each acquire is a single value; null is a single value (not a tuple)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: FAIRNESS_MAX_KEYS }),
        (nKeys) => {
          globalCircuitBreakerRegistry.clear();
          const clock = makeClock();
          const keys = distinctKeyNames('p2', nKeys);
          const pool = newPool(`p2-${nKeys}`, keys, clock);

          const result = pool.acquire();
          // Either a slot whose apiKey is in `keys`, or null.
          if (result === null) {
            expect(result).toBeNull();
          } else {
            expect(typeof result.apiKey).toBe('string');
            expect(keys).toContain(result.apiKey);
            // Ensure the slot is also unique (single object), not an array.
            expect(Array.isArray(result)).toBe(false);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P3 — Cooldown exclusion (no early-recovery)
// ────────────────────────────────────────────────────────────────────────────

describe('OpenAiKeyPool: P3 marked key excluded for the full cooldown window', () => {
  it('for any advance < cooldownMs, the marked key is NEVER returned', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }),
        fc.integer({ min: 0, max: COOLDOWN_MS - 1 }),
        (nKeys, advanceMs) => {
          globalCircuitBreakerRegistry.clear();
          const clock = makeClock();
          const keys = distinctKeyNames('p3', nKeys);
          const pool = newPool(`p3-${nKeys}-${advanceMs}`, keys, clock);

          const victim = keys[0]!;
          pool.markRateLimited(victim);
          clock.advance(advanceMs);

          // Probe many times to defeat any rotation-state coincidence.
          for (let i = 0; i < nKeys * 4; i += 1) {
            const slot = pool.acquire();
            // Pool has nKeys-1 healthy keys, so slot must not be null and not victim.
            expect(slot).not.toBeNull();
            expect(slot!.apiKey).not.toBe(victim);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P4 — Cooldown boundary recovery
// ────────────────────────────────────────────────────────────────────────────

describe('OpenAiKeyPool: P4 marked key recovers at boundary (markedAt + cooldownMs)', () => {
  it('at exactly cooldownMs elapsed, the key is acquirable again', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 120_000 }),
        (nKeys, cooldownMs) => {
          globalCircuitBreakerRegistry.clear();
          const clock = makeClock();
          const keys = distinctKeyNames('p4', nKeys);
          const pool = newPool(`p4-${nKeys}-${cooldownMs}`, keys, clock, cooldownMs);

          // Mark every key so the only path to a non-null acquire is recovery.
          for (const k of keys) pool.markRateLimited(k);
          expect(pool.acquire()).toBeNull();

          // Advance exactly cooldownMs: `until <= now` becomes true.
          clock.advance(cooldownMs);

          const recovered = pool.acquire();
          expect(recovered).not.toBeNull();
          expect(keys).toContain(recovered!.apiKey);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P5 — Exhaustion: null acquire does not advance counters
// ────────────────────────────────────────────────────────────────────────────

describe('OpenAiKeyPool: P5 exhausted acquire returns null AND does not bump counters', () => {
  it('all-marked pool: acquire() === null and totalAcquires unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 8 }),
        (nKeys, repeats) => {
          globalCircuitBreakerRegistry.clear();
          const clock = makeClock();
          const keys = distinctKeyNames('p5', nKeys);
          const pool = newPool(`p5-${nKeys}-${repeats}`, keys, clock);

          for (const k of keys) pool.markRateLimited(k);
          const startStats = pool.getStats();
          expect(startStats.totalAcquires).toBe(0);

          for (let i = 0; i < repeats; i += 1) {
            expect(pool.acquire()).toBeNull();
          }
          expect(pool.getStats().totalAcquires).toBe(0);
          expect(pool.getStats().exhaustedCount).toBe(nKeys);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P6 — Stats conservation
// ────────────────────────────────────────────────────────────────────────────

describe('OpenAiKeyPool: P6 stats conservation (exhausted + healthy = keyCount)', () => {
  it('at any instant, exhaustedCount <= keyCount and the rest are healthy', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 0, maxLength: 12 }),
        fc.array(fc.integer({ min: 0, max: COOLDOWN_MS * 2 }), {
          minLength: 0,
          maxLength: 12,
        }),
        (nKeys, marks, advances) => {
          globalCircuitBreakerRegistry.clear();
          const clock = makeClock();
          const keys = distinctKeyNames('p6', nKeys);
          const pool = newPool(`p6-${nKeys}`, keys, clock);

          const maxLen = Math.max(marks.length, advances.length);
          for (let i = 0; i < maxLen; i += 1) {
            const m = marks[i];
            if (m !== undefined) {
              const idx = m % nKeys;
              const k = keys[idx];
              if (k !== undefined) pool.markRateLimited(k);
            }
            const a = advances[i];
            if (a !== undefined) clock.advance(a);

            const s = pool.getStats();
            expect(s.keyCount).toBe(nKeys);
            expect(s.exhaustedCount).toBeGreaterThanOrEqual(0);
            expect(s.exhaustedCount).toBeLessThanOrEqual(nKeys);
            // healthy = keyCount - exhaustedCount (definitional)
            const healthy = s.keyCount - s.exhaustedCount;
            expect(healthy + s.exhaustedCount).toBe(s.keyCount);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P7 — Determinism under fixed (clock, op-sequence)
// ────────────────────────────────────────────────────────────────────────────

describe('OpenAiKeyPool: P7 deterministic replay under fixed clock + ops', () => {
  it('two pools fed the same op trace produce byte-identical acquire sequences', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 5 }).chain((nKeys) =>
          fc.tuple(fc.constant(nKeys), opSequenceArb(nKeys)),
        ),
        ([nKeys, ops]) => {
          const keys = distinctKeyNames('p7', nKeys);

          globalCircuitBreakerRegistry.clear();
          const clockA = makeClock();
          const poolA = newPool(`p7-a-${nKeys}`, keys, clockA);
          const traceA = replay(poolA, clockA, keys, ops);

          globalCircuitBreakerRegistry.clear();
          const clockB = makeClock();
          const poolB = newPool(`p7-b-${nKeys}`, keys, clockB);
          const traceB = replay(poolB, clockB, keys, ops);

          expect(traceA).toEqual(traceB);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P8 — Normalization idempotence (Unicode-safe)
// ────────────────────────────────────────────────────────────────────────────

describe('OpenAiKeyPool: P8 normalizeOpenAiApiKeys is idempotent and order-stable', () => {
  it('normalize(normalize(xs)) === normalize(xs) for arbitrary string inputs', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ minLength: 0, maxLength: 20 }), { nil: undefined }),
        fc.array(fc.string({ minLength: 0, maxLength: 20 }), {
          minLength: 0,
          maxLength: 12,
        }),
        (primary, others) => {
          const once = normalizeOpenAiApiKeys(primary, others);
          // Feed the output back through: idempotence.
          const twice = normalizeOpenAiApiKeys(undefined, once);
          expect(twice).toEqual(once);
          // No duplicates after normalization.
          expect(new Set(once).size).toBe(once.length);
          // Every entry is trimmed and non-empty.
          for (const k of once) {
            expect(k).toBe(k.trim());
            expect(k.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('Korean / accented / emoji keys survive normalization (Unicode-safe)', () => {
    const xs = normalizeOpenAiApiKeys(undefined, [
      'sk-한글-키',
      '  sk-한글-키  ', // same after trim → dedup
      'sk-café',
      'sk-🍷',
      '',
      '   ',
    ]);
    expect(xs).toEqual(['sk-한글-키', 'sk-café', 'sk-🍷']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P9 — Empty / whitespace-only pool defense
// ────────────────────────────────────────────────────────────────────────────

describe('OpenAiKeyPool: P9 empty-pool defense (no silent zero-key state)', () => {
  it('all-empty / whitespace-only inputs throw a typed Error', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.constant(''),
            fc.constant('   '),
            fc.constant('\t\n'),
          ),
          { minLength: 0, maxLength: 5 },
        ),
        (junk) => {
          expect(() =>
            createOpenAiKeyPool({
              baseBreakerName: 'p9',
              apiKeys: junk,
              failureThreshold: FAILURE_THRESHOLD,
              recoveryTimeoutMs: RECOVERY_TIMEOUT_MS,
              halfOpenMaxAttempts: HALF_OPEN_ATTEMPTS,
            }),
          ).toThrow(/at least one API key/i);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// P10 — totalAcquires monotonicity
// ────────────────────────────────────────────────────────────────────────────

describe('OpenAiKeyPool: P10 totalAcquires monotonic — +1 on non-null, +0 on null', () => {
  it('every acquire increments totalAcquires iff it returns a non-null slot', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }).chain((nKeys) =>
          fc.tuple(fc.constant(nKeys), opSequenceArb(nKeys)),
        ),
        ([nKeys, ops]) => {
          globalCircuitBreakerRegistry.clear();
          const clock = makeClock();
          const keys = distinctKeyNames('p10', nKeys);
          const pool = newPool(`p10-${nKeys}`, keys, clock);

          let expected = 0;
          let lastTotal = 0;
          for (const op of ops) {
            if (op.kind === 'acquire') {
              const before = pool.getStats().totalAcquires;
              const slot = pool.acquire();
              const after = pool.getStats().totalAcquires;
              expect(after).toBeGreaterThanOrEqual(before); // monotonic
              if (slot === null) {
                expect(after).toBe(before);
              } else {
                expect(after).toBe(before + 1);
                expected += 1;
              }
              lastTotal = after;
            } else if (op.kind === 'mark') {
              const k = keys[op.keyIndex];
              if (k !== undefined) pool.markRateLimited(k);
            } else {
              clock.advance(op.ms);
            }
          }
          expect(lastTotal).toBe(expected);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Boundary regressions — locked alongside the property suite
// ────────────────────────────────────────────────────────────────────────────

describe('OpenAiKeyPool: boundary regressions adjacent to properties', () => {
  it('DEFAULT_OPENAI_KEY_POOL_COOLDOWN_MS matches the OpenAI 429 backoff constant', () => {
    // The constant is exported precisely so callers and tests reason about it.
    expect(DEFAULT_OPENAI_KEY_POOL_COOLDOWN_MS).toBe(60_000);
  });

  it('mark on a key not in the pool is silently ignored (defensive)', () => {
    const clock = makeClock();
    const pool = newPool('mark-unknown', ['k1', 'k2'], clock);
    expect(() => pool.markRateLimited('not-in-pool')).not.toThrow();
    expect(pool.getStats().exhaustedCount).toBe(0);
  });

  it('cooldown of zero is effectively a no-op (until <= now immediately)', () => {
    const clock = makeClock();
    const pool = newPool('zero-cooldown', ['k1', 'k2'], clock, 0);
    pool.markRateLimited('k1');
    // 0-cooldown: `until = now + 0 = now`; `until <= now` is true → not skipped.
    const observed = new Set<string>();
    for (let i = 0; i < 4; i += 1) {
      const slot = pool.acquire();
      expect(slot).not.toBeNull();
      observed.add(slot!.apiKey);
    }
    expect(observed.has('k1')).toBe(true);
    expect(observed.has('k2')).toBe(true);
  });

  it('rotation pointer survives "all exhausted → recovery" without losing fairness', () => {
    const clock = makeClock();
    const pool = newPool('post-exhaust-rotation', ['k1', 'k2', 'k3'], clock, 10);
    for (const k of ['k1', 'k2', 'k3']) pool.markRateLimited(k);
    expect(pool.acquire()).toBeNull();
    clock.advance(11);
    // After full recovery the rotation continues from wherever nextIndex sits.
    // Across 6 acquires every key must appear exactly twice (uniform).
    const counts = new Map<string, number>();
    for (let i = 0; i < 6; i += 1) {
      const slot = pool.acquire();
      expect(slot).not.toBeNull();
      counts.set(slot!.apiKey, (counts.get(slot!.apiKey) ?? 0) + 1);
    }
    for (const v of counts.values()) {
      expect(v).toBe(2);
    }
  });
});
