/**
 * Property-based regression tests for the cross-encoder reranker port.
 *
 * Targets {@link CohereReranker} (HTTP adapter) and {@link CachedReranker}
 * (transparent memoization wrapper). The Cohere reranker implements
 * {@link RerankerPort}; the cached reranker wraps any RerankerPort
 * implementation and MUST preserve byte-identical output across hit/miss.
 *
 * SOTA++ invariants verified (numRuns: 100):
 *
 *   1. Permutation: every reranked entityId comes from the input candidate
 *      pool — the reranker NEVER injects unseen ids.
 *   2. Bounded by limit: output length ≤ `limit` and ≤ candidate count.
 *   3. Dense 1-based rank: rank values are exactly 1..N with no gaps.
 *   4. Score-monotonic ranking: rank ascending order ⇔ score descending
 *      order (lower rank ⇒ ≥ score of next rank).
 *   5. Deterministic tie-break: when two candidates receive the same
 *      relevance_score, the result order is stable across input
 *      permutations (broken by entityId lexicographic ascending).
 *   6. NaN/Infinity rejection: a Cohere response with a non-finite score
 *      MUST throw — never produce undefined ranks or silent NaN.
 *   7. Out-of-range rejection: scores outside [0, 1] MUST throw — never
 *      clamped silently (that would mask upstream contract drift).
 *   8. Empty input / non-positive limit: returns [] with no HTTP call,
 *      no throw.
 *   9. CachedReranker memoization: same (query, limit, candidates) →
 *      byte-identical output, exactly one inner call.
 *  10. CachedReranker key disjoint on limit: different limits do NOT
 *      collide in the cache.
 *
 * Bumps infra.reranker maturity 3 → 5.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import { CohereReranker } from '../../src/infrastructure/ai/cohere-reranker.js';
import { CachedReranker } from '../../src/infrastructure/ai/cached-reranker.js';
import type {
  RerankerPort,
  RerankCandidate,
  RerankResult,
} from '../../src/domain/ranking/port/reranker.port.js';
import type { CanonicalEntityId } from '../../src/domain/shared/types/index.js';

const FC_RUNS = 100;

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Canonical public entity ids never use the `vivino-` source-record namespace. */
const canonicalEntityIdArb = fc
  .stringMatching(/^[a-z0-9_-]{3,16}$/)
  .filter((s) => !s.startsWith('vivino-'));

/** Distinct candidates so the response index is unambiguous. */
const candidatesArb = fc
  .uniqueArray(canonicalEntityIdArb, { minLength: 1, maxLength: 8 })
  .map((ids): readonly RerankCandidate[] =>
    ids.map((id) => ({ entityId: id as CanonicalEntityId, text: `text-${id}` })),
  );

/** Cohere relevance_score is bounded to [0, 1] (the adapter enforces this). */
const relevanceScoreArb = fc.double({
  min: 0,
  max: 1,
  noNaN: true,
  noDefaultInfinity: true,
});

interface CohereItem {
  readonly index: number;
  readonly relevance_score: number;
}

function buildCohereResponse(
  candidates: readonly RerankCandidate[],
  scoreFor: (i: number) => number,
  topN: number,
): { results: CohereItem[] } {
  const items: CohereItem[] = candidates.map((_, idx) => ({
    index: idx,
    relevance_score: scoreFor(idx),
  }));
  // Cohere returns top_n sorted desc; mimic the production server.
  items.sort((a, b) => b.relevance_score - a.relevance_score);
  return { results: items.slice(0, topN) };
}

function stubCohere(responseBody: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(responseBody), { status: 200 })),
  );
}

function makeReranker(): CohereReranker {
  return new CohereReranker({
    baseUrl: 'https://api.cohere.ai/v2',
    apiKey: 'co-test',
    model: 'rerank-v4.0-pro',
    httpTimeoutMs: 5_000,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Reranker properties (regression)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── Property 1+2+3: permutation, bounded, dense rank ────────────────────
  it('output is a bounded permutation of input with dense 1-based ranks', async () => {
    await fc.assert(
      fc.asyncProperty(
        candidatesArb,
        fc.integer({ min: 1, max: 16 }),
        fc.array(relevanceScoreArb, { minLength: 16, maxLength: 16 }),
        async (candidates, limit, scorePool) => {
          stubCohere(
            buildCohereResponse(candidates, (i) => scorePool[i % scorePool.length] ?? 0, limit),
          );
          const reranker = makeReranker();
          const results = await reranker.rerank('q', candidates, limit);

          // Bounded.
          expect(results.length).toBeLessThanOrEqual(limit);
          expect(results.length).toBeLessThanOrEqual(candidates.length);

          // Permutation: every output entityId came from input.
          const inputIds = new Set(candidates.map((c) => String(c.entityId)));
          for (const r of results) {
            expect(inputIds.has(String(r.entityId))).toBe(true);
          }
          // No duplicate entityIds in output.
          const outIds = results.map((r) => String(r.entityId));
          expect(new Set(outIds).size).toBe(outIds.length);

          // Dense 1-based ranks.
          results.forEach((r, i) => {
            expect(r.rank).toBe(i + 1);
          });
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 4: score-monotonic ─────────────────────────────────────────
  it('rank ascending ⇔ score weakly descending (no inversions)', async () => {
    await fc.assert(
      fc.asyncProperty(
        candidatesArb,
        fc.array(relevanceScoreArb, { minLength: 16, maxLength: 16 }),
        async (candidates, scorePool) => {
          stubCohere(
            buildCohereResponse(
              candidates,
              (i) => scorePool[i % scorePool.length] ?? 0,
              candidates.length,
            ),
          );
          const reranker = makeReranker();
          const results = await reranker.rerank('q', candidates, candidates.length);

          for (let i = 1; i < results.length; i += 1) {
            // Defensive: results[i-1] / results[i] are present by construction.
            const prev = results[i - 1]!;
            const cur = results[i]!;
            expect(prev.score).toBeGreaterThanOrEqual(cur.score);
            expect(Number.isFinite(prev.score)).toBe(true);
            expect(Number.isFinite(cur.score)).toBe(true);
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 5: deterministic tie-break ─────────────────────────────────
  // When two candidates have identical scores, the result MUST be stable
  // across any permutation of the input — broken by entityId ascending.
  it('ties broken deterministically by entityId across input permutations', async () => {
    await fc.assert(
      fc.asyncProperty(
        candidatesArb.filter((c) => c.length >= 2),
        fc.integer({ min: 0, max: 1_000_000 }),
        async (candidates, seed) => {
          // All scores identical to force ties.
          const tiedScore = 0.5;

          const orderA = candidates;
          const orderB = [...candidates].sort((a, b) =>
            // Permute by a seed-derived hash so order differs from input order.
            ((String(a.entityId) + String(seed)).length -
              (String(b.entityId) + String(seed)).length) || (a.entityId < b.entityId ? 1 : -1),
          );

          const runOne = async (cs: readonly RerankCandidate[]): Promise<readonly RerankResult[]> => {
            stubCohere(buildCohereResponse(cs, () => tiedScore, cs.length));
            return makeReranker().rerank('q', cs, cs.length);
          };

          const resultA = await runOne(orderA);
          const resultB = await runOne(orderB);

          // Both runs MUST produce the same id ordering for tied scores —
          // proves the reranker does not leak input-order into its output.
          expect(resultA.map((r) => String(r.entityId))).toStrictEqual(
            resultB.map((r) => String(r.entityId)),
          );
          // And the canonical order MUST be entityId ascending.
          const ids = resultA.map((r) => String(r.entityId));
          const sorted = [...ids].sort();
          expect(ids).toStrictEqual(sorted);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 6: NaN / Infinity rejection ────────────────────────────────
  it('rejects non-finite relevance_score (NaN / ±Infinity) — never silent', async () => {
    await fc.assert(
      fc.asyncProperty(
        candidatesArb,
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        async (candidates, badScore) => {
          // Hand-craft response with one non-finite score. The parser
          // (`isCohereRerankItem`) rejects at the response-shape level, so
          // we expect a parse-error throw.
          stubCohere({
            results: candidates.map((_, i) => ({
              index: i,
              relevance_score: i === 0 ? badScore : 0.5,
            })),
          });
          const reranker = makeReranker();
          await expect(reranker.rerank('q', candidates, candidates.length)).rejects.toThrow(
            /unexpected response shape/,
          );
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 7: out-of-range score rejection ────────────────────────────
  it('rejects relevance_score outside [0, 1] — no silent clamp', async () => {
    await fc.assert(
      fc.asyncProperty(
        candidatesArb,
        // Pick a finite value outside [0, 1].
        fc.oneof(
          fc.double({ min: -1_000, max: -0.0001, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: 1.0001, max: 1_000, noNaN: true, noDefaultInfinity: true }),
        ),
        async (candidates, badScore) => {
          stubCohere({
            results: candidates.map((_, i) => ({
              index: i,
              relevance_score: i === 0 ? badScore : 0.5,
            })),
          });
          const reranker = makeReranker();
          await expect(reranker.rerank('q', candidates, candidates.length)).rejects.toThrow(
            /outside \[0,1\]/,
          );
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 8a: empty candidates ───────────────────────────────────────
  it('returns [] on empty candidates with no HTTP call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const reranker = makeReranker();
    const out = await reranker.rerank('q', [], 5);
    expect(out).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── Property 8b: non-positive limit guard on CachedReranker ─────────────
  it('CachedReranker returns [] on limit <= 0 without invoking inner', async () => {
    await fc.assert(
      fc.asyncProperty(
        candidatesArb,
        fc.integer({ min: -5, max: 0 }),
        async (candidates, limit) => {
          const inner: RerankerPort = { rerank: vi.fn() };
          const cached = new CachedReranker({ modelId: 'm', inner });
          const out = await cached.rerank('q', candidates, limit);
          expect(out).toEqual([]);
          expect(inner.rerank).not.toHaveBeenCalled();
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 9: CachedReranker memoization ──────────────────────────────
  it('CachedReranker returns byte-identical output and calls inner exactly once', async () => {
    await fc.assert(
      fc.asyncProperty(
        candidatesArb,
        fc.integer({ min: 1, max: 5 }),
        async (candidates, limit) => {
          const innerOutput: readonly RerankResult[] = candidates.slice(0, limit).map((c, i) => ({
            entityId: c.entityId,
            score: 1 - i * 0.05,
            rank: i + 1,
          }));
          const innerFn = vi.fn().mockResolvedValue(innerOutput);
          const cached = new CachedReranker({
            modelId: 'm',
            inner: { rerank: innerFn },
          });

          const first = await cached.rerank('q', candidates, limit);
          const second = await cached.rerank('q', candidates, limit);

          expect(first).toEqual(innerOutput);
          expect(second).toEqual(first);
          expect(innerFn).toHaveBeenCalledTimes(1);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });

  // ── Property 10: cache key disjoint on limit ────────────────────────────
  it('CachedReranker treats distinct limits as distinct cache keys', async () => {
    await fc.assert(
      fc.asyncProperty(
        candidatesArb.filter((c) => c.length >= 2),
        fc.tuple(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 })).filter(
          ([a, b]) => a !== b,
        ),
        async (candidates, [limitA, limitB]) => {
          const innerFn = vi.fn().mockImplementation(
            async (_q: string, cs: readonly RerankCandidate[], lim: number) =>
              cs.slice(0, lim).map((c, i) => ({
                entityId: c.entityId,
                score: 1 - i * 0.05,
                rank: i + 1,
              })),
          );
          const cached = new CachedReranker({
            modelId: 'm',
            inner: { rerank: innerFn },
          });
          await cached.rerank('q', candidates, limitA);
          await cached.rerank('q', candidates, limitB);
          expect(innerFn).toHaveBeenCalledTimes(2);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});
