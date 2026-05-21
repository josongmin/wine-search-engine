/**
 * Regression (property-based): retrieval.ranking-pipeline determinism core.
 *
 * `compareScoredEntriesByFinalScoreDesc`는 랭킹 파이프라인의 결정론적 정렬
 * 코어입니다 (ranker.ts step 5: `viable.sort(...)`). 기존 example-based 스위트
 * (`e1-p03-ranker-tiebreak.regression.test.ts`)는 구체적 시나리오를 고정하고,
 * 이 스위트는 fast-check로 *보편* 불변식을 numRuns:100으로 탐색합니다.
 *
 * 탐색하는 불변식 (각 numRuns:100):
 *   - ranking determinism      — 동일 후보 집합 → 동일 정렬 (5회 반복 안정)
 *   - stable tie-break         — 동점 후보 → entityId 오름차순 결정론적 순서
 *   - score monotonicity       — 더 높은 finalScore가 항상 ≥ 위치 (앞)
 *   - NaN-safety               — NaN/누락 점수 → crash 없이 항상 마지막
 *   - permutation invariance   — 입력 순서 무관, 점수+stable key만 결과 결정
 *   - Korean entity            — 한글 canonicalLabel 후보가 손상 없이 통과
 *   - empty set                — 빈 후보 → 빈 결과, throw 없음
 *   - comparator contract      — antisymmetry / reflexivity (sort 계약 전제)
 *
 * Append-only 회귀 파일 — 케이스 삭제 금지. CLAUDE.md "Test discipline" 참조.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  compareScoredEntriesByFinalScoreDesc,
  type ScoredEntry,
} from '../../src/domain/ranking/service/ranker.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import type { ComponentScores } from '../../src/domain/ranking/model/ranked-result.js';

const FC_RUNS = 100;

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeComponentScores(overrides?: Partial<ComponentScores>): ComponentScores {
  return {
    entityIntegrity: 0.8,
    semantic: 0.5,
    hardConstraintPass: true,
    softConstraint: 0.5,
    attributeAlignment: 0.5,
    preferenceAlignment: 0.5,
    popularity: 0.3,
    availability: 1.0,
    uncertaintyPenalty: 0.1,
    ...overrides,
  };
}

interface ScoredEntrySpec {
  readonly id: string;
  readonly finalScore: number;
  readonly evidenceQualityTier: number;
  readonly lexicalExactnessTier: number;
  readonly sparseRank: number | undefined;
  readonly canonicalLabel?: string;
}

function makeScoredEntry(spec: ScoredEntrySpec): ScoredEntry {
  return {
    entityId: createEntityId(spec.id),
    canonicalLabel: spec.canonicalLabel ?? spec.id,
    finalScore: spec.finalScore,
    componentScores: makeComponentScores(),
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    evidenceQualityTier: spec.evidenceQualityTier,
    lexicalExactnessTier: spec.lexicalExactnessTier,
    ...(spec.sparseRank !== undefined ? { sparseRank: spec.sparseRank } : {}),
  };
}

/** Stable-key sort that mirrors the comparator's deterministic ordering. */
function stableKeyOf(e: ScoredEntry): string {
  return String(e.entityId);
}

/** Deterministic permutation (Fisher-Yates) seeded from a fast-check integer. */
function permute<T>(arr: readonly T[], seed: number): T[] {
  const a = [...arr];
  let state = (seed >>> 0) || 1;
  const next = (): number => {
    // xorshift32 — deterministic, no Math.random (replayable failures).
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

// ─── arbitraries ────────────────────────────────────────────────────────────

const tierArb = fc.integer({ min: 0, max: 3 });
const sparseArb = fc.option(fc.integer({ min: 1, max: 500 }), { nil: undefined });
// Finite scores only here; NaN-safety is covered by a dedicated property.
const finiteScoreArb = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });

const specArb: fc.Arbitrary<ScoredEntrySpec> = fc.record({
  id: fc.string({ minLength: 1, maxLength: 12 }).map((s) => `e-${s.replace(/\s+/g, '_')}`),
  finalScore: finiteScoreArb,
  evidenceQualityTier: tierArb,
  lexicalExactnessTier: tierArb,
  sparseRank: sparseArb,
});

/** Specs with UNIQUE entityIds (so the comparator total-orders them). */
const uniqueSpecsArb: fc.Arbitrary<readonly ScoredEntrySpec[]> = fc
  .array(specArb, { minLength: 1, maxLength: 40 })
  .map((specs) => {
    const seen = new Set<string>();
    const out: ScoredEntrySpec[] = [];
    for (const s of specs) {
      let id = s.id;
      let n = 0;
      while (seen.has(id)) {
        id = `${s.id}#${n++}`;
      }
      seen.add(id);
      out.push({ ...s, id });
    }
    return out;
  });

// ─── Property: ranking determinism ──────────────────────────────────────────

describe('ranking-pipeline determinism — sort core', () => {
  it('RP-DET-01: 동일 후보 집합 → 동일 정렬 (5회 반복 안정)', () => {
    fc.assert(
      fc.property(uniqueSpecsArb, (specs) => {
        const base = specs.map(makeScoredEntry);
        const canonical = [...base]
          .sort(compareScoredEntriesByFinalScoreDesc)
          .map((e) => String(e.entityId));
        for (let r = 0; r < 5; r++) {
          const again = [...base]
            .sort(compareScoredEntriesByFinalScoreDesc)
            .map((e) => String(e.entityId));
          expect(again).toEqual(canonical);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });
});

// ─── Property: permutation invariance ───────────────────────────────────────

describe('ranking-pipeline determinism — permutation invariance', () => {
  it('RP-PERM-01: 입력 순서 무관 — 임의 셔플해도 정렬 결과 동일', () => {
    fc.assert(
      fc.property(uniqueSpecsArb, fc.integer({ min: 1, max: 2 ** 31 - 1 }), (specs, seed) => {
        const base = specs.map(makeScoredEntry);
        const canonical = [...base]
          .sort(compareScoredEntriesByFinalScoreDesc)
          .map((e) => String(e.entityId));
        const shuffled = permute(base, seed)
          .sort(compareScoredEntriesByFinalScoreDesc)
          .map((e) => String(e.entityId));
        expect(shuffled).toEqual(canonical);
      }),
      { numRuns: FC_RUNS },
    );
  });
});

// ─── Property: stable tie-break (entityId ascending) ────────────────────────

describe('ranking-pipeline determinism — stable tie-break', () => {
  it('RP-TIE-01: 전체 동점 후보 → entityId 오름차순 결정론적 순서', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 16 }), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        (rawIds, seed) => {
          // Every entry identical except entityId → only Stage-5 decides order.
          const specs: ScoredEntrySpec[] = rawIds.map((raw) => ({
            id: `tie-${raw.replace(/\s+/g, '_')}`,
            finalScore: 0.5,
            evidenceQualityTier: 0,
            lexicalExactnessTier: 0,
            sparseRank: 1,
          }));
          const entries = specs.map(makeScoredEntry);
          const expected = entries.map(stableKeyOf).sort(); // lexicographic ascending
          const sorted = permute(entries, seed)
            .sort(compareScoredEntriesByFinalScoreDesc)
            .map(stableKeyOf);
          expect(sorted).toEqual(expected);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});

// ─── Property: score monotonicity ───────────────────────────────────────────

describe('ranking-pipeline determinism — score monotonicity', () => {
  // 코어 비교자는 FINAL_SCORE_SORT_TIE_EPSILON(1e-12) 이내 차이를 동점으로 보고
  // tie-break 단계로 넘긴다. 따라서 단조성 불변식은 "앞 점수 ≥ 뒤 점수 − epsilon":
  // epsilon보다 큰 역전(앞이 뒤보다 유의미하게 작음)은 절대 발생하지 않아야 한다.
  const TIE_EPSILON = 1e-12;
  it('RP-MONO-01: 더 높은 finalScore가 항상 앞 — epsilon 초과 역전 없음', () => {
    fc.assert(
      fc.property(uniqueSpecsArb, (specs) => {
        const sorted = specs.map(makeScoredEntry).sort(compareScoredEntriesByFinalScoreDesc);
        for (let i = 0; i + 1 < sorted.length; i++) {
          const cur = sorted[i]!.finalScore;
          const nxt = sorted[i + 1]!.finalScore;
          // 모두 유한 — 앞 점수는 (뒤 점수 − epsilon) 이상이어야 한다 (내림차순).
          // epsilon 밴드 내 동점은 tie-break(entityId)로 결정되므로 허용.
          expect(cur).toBeGreaterThanOrEqual(nxt - TIE_EPSILON);
        }
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('RP-MONO-02: 엄격히 더 높은 점수의 후보는 더 낮은 점수보다 항상 앞', () => {
    fc.assert(
      fc.property(
        finiteScoreArb,
        fc.double({ min: 1e-3, max: 100, noNaN: true, noDefaultInfinity: true }),
        (lowScore, delta) => {
          const high = makeScoredEntry({
            id: 'e-zzz-high', // entityId가 사전순으로 뒤지만 점수가 우선해야 함
            finalScore: lowScore + delta,
            evidenceQualityTier: 3,
            lexicalExactnessTier: 3,
            sparseRank: undefined,
          });
          const low = makeScoredEntry({
            id: 'e-aaa-low',
            finalScore: lowScore,
            evidenceQualityTier: 0,
            lexicalExactnessTier: 0,
            sparseRank: 1,
          });
          const sorted = [low, high].sort(compareScoredEntriesByFinalScoreDesc);
          expect(String(sorted[0]!.entityId)).toBe('e-zzz-high');
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});

// ─── Property: NaN-safety ───────────────────────────────────────────────────

describe('ranking-pipeline determinism — NaN-safety', () => {
  it('RP-NAN-01: NaN/Infinity 점수 후보 → crash 없이 항상 유한 점수 뒤로', () => {
    const nonFiniteArb = fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
    fc.assert(
      fc.property(
        fc.array(specArb, { minLength: 0, maxLength: 20 }),
        fc.array(nonFiniteArb, { minLength: 1, maxLength: 8 }),
        (finiteSpecs, nonFiniteScores) => {
          const seen = new Set<string>();
          const uniq = (id: string): string => {
            let out = id;
            let n = 0;
            while (seen.has(out)) out = `${id}#${n++}`;
            seen.add(out);
            return out;
          };
          const finiteEntries = finiteSpecs.map((s) =>
            makeScoredEntry({ ...s, id: uniq(s.id) }),
          );
          const nonFiniteEntries = nonFiniteScores.map((score, i) =>
            makeScoredEntry({
              id: uniq(`nf-${i}`),
              finalScore: score,
              evidenceQualityTier: 0,
              lexicalExactnessTier: 0,
              sparseRank: 1,
            }),
          );
          const all = [...nonFiniteEntries, ...finiteEntries];
          // Must not throw.
          const sorted = all.sort(compareScoredEntriesByFinalScoreDesc);
          // Every finite-scored entry must precede every non-finite entry.
          let lastFiniteIdx = -1;
          let firstNonFiniteIdx = sorted.length;
          for (let i = 0; i < sorted.length; i++) {
            if (Number.isFinite(sorted[i]!.finalScore)) {
              lastFiniteIdx = i;
            } else if (firstNonFiniteIdx === sorted.length) {
              firstNonFiniteIdx = i;
            }
          }
          if (lastFiniteIdx >= 0 && firstNonFiniteIdx < sorted.length) {
            expect(lastFiniteIdx).toBeLessThan(firstNonFiniteIdx);
          }
          // Length preserved (no candidate dropped/crashed).
          expect(sorted.length).toBe(all.length);
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});

// ─── Property: Korean entity flows through intact ───────────────────────────

describe('ranking-pipeline determinism — Korean entity', () => {
  // 한글/혼합 라벨이 정렬 코어를 손상 없이 통과하고 결정론적으로 정렬되는지 확인.
  const koreanLabels = ['샤또 마고', '돔 페리뇽', '오퍼스 원', '로마네 콩티', '몬테스 알파'] as const;

  it('RP-KO-01: 한글 canonicalLabel 후보 — 라벨 보존 + 결정론적 정렬', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: koreanLabels.length - 1 }), {
          minLength: 1,
          maxLength: koreanLabels.length,
        }),
        finiteScoreArb,
        fc.integer({ min: 1, max: 2 ** 31 - 1 }),
        (labelIdxs, score, seed) => {
          const entries = labelIdxs.map((idx, i) =>
            makeScoredEntry({
              id: `ko-${i}`,
              finalScore: score, // 전부 동점 → entityId tie-break로 결정론 보장
              evidenceQualityTier: 0,
              lexicalExactnessTier: 0,
              sparseRank: 1,
              canonicalLabel: koreanLabels[idx]!,
            }),
          );
          const canonical = [...entries]
            .sort(compareScoredEntriesByFinalScoreDesc)
            .map((e) => String(e.entityId));
          const shuffled = permute(entries, seed)
            .sort(compareScoredEntriesByFinalScoreDesc)
            .map((e) => String(e.entityId));
          // 입력 순서 무관 결정론
          expect(shuffled).toEqual(canonical);
          // 한글 라벨이 손상 없이 보존됨
          const labelById = new Map(entries.map((e) => [String(e.entityId), e.canonicalLabel]));
          for (const id of canonical) {
            const label = labelById.get(id)!;
            expect((koreanLabels as readonly string[]).includes(label)).toBe(true);
          }
        },
      ),
      { numRuns: FC_RUNS },
    );
  });
});

// ─── Property: empty candidate set ──────────────────────────────────────────

describe('ranking-pipeline determinism — empty set', () => {
  it('RP-EMPTY-01: 빈 후보 → 빈 결과, throw 없음', () => {
    const empty: ScoredEntry[] = [];
    expect(() => empty.sort(compareScoredEntriesByFinalScoreDesc)).not.toThrow();
    expect(empty.sort(compareScoredEntriesByFinalScoreDesc)).toEqual([]);
  });

  it('RP-EMPTY-02: 단일 후보 → 자기 자신 (정렬 불변)', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const single = [makeScoredEntry(spec)];
        const sorted = [...single].sort(compareScoredEntriesByFinalScoreDesc);
        expect(sorted.map((e) => String(e.entityId))).toEqual(single.map((e) => String(e.entityId)));
      }),
      { numRuns: FC_RUNS },
    );
  });
});

// ─── Property: comparator algebraic contract (sort 전제) ─────────────────────

describe('ranking-pipeline determinism — comparator contract', () => {
  it('RP-CONTRACT-01: antisymmetry — sign(cmp(a,b)) === -sign(cmp(b,a))', () => {
    fc.assert(
      fc.property(specArb, specArb, (sa, sb) => {
        // 서로 다른 entityId 보장 (동일 id면 0 — 그 경우도 -0 === 0 으로 통과)
        const a = makeScoredEntry({ ...sa, id: `a-${sa.id}` });
        const b = makeScoredEntry({ ...sb, id: `b-${sb.id}` });
        const ab = compareScoredEntriesByFinalScoreDesc(a, b);
        const ba = compareScoredEntriesByFinalScoreDesc(b, a);
        expect(Math.sign(ab)).toBe(-Math.sign(ba));
      }),
      { numRuns: FC_RUNS },
    );
  });

  it('RP-CONTRACT-02: reflexivity — cmp(a,a) === 0', () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const a = makeScoredEntry(spec);
        expect(compareScoredEntriesByFinalScoreDesc(a, a)).toBe(0);
      }),
      { numRuns: FC_RUNS },
    );
  });
});
