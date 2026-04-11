/**
 * Regression: E1-P03 Ranker 5-Stage Tie-Break
 *
 * compareScoredEntriesByFinalScoreDesc에 대한 직접 단위 테스트.
 * 이 함수는 5단계 결정론적 정렬 기준을 구현합니다:
 *
 *   Stage 1: finalScore 내림차순 (NaN → 마지막)
 *   Stage 2: evidenceQualityTier 오름차순 (낮을수록 강한 exact/known-item 증거)
 *   Stage 3: lexicalExactnessTier 오름차순 (낮을수록 더 좋은 표면-형식 매칭)
 *   Stage 4: sparseRank 오름차순 (없으면 Infinity로 처리 → 마지막)
 *   Stage 5: entityId 오름차순 (안정적인 사전순 타이-브레이크)
 *
 * 이 테스트들은 append-only (회귀 테스트 규칙). 절대 삭제하지 마세요.
 */

import { describe, expect, it } from 'vitest';
import {
  compareScoredEntriesByFinalScoreDesc,
  type ScoredEntry,
} from '../../src/domain/ranking/service/ranker.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';
import type { ComponentScores } from '../../src/domain/ranking/model/ranked-result.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/** 최소 유효 ComponentScores — 모든 게이트 통과, 모든 신호 중립. */
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

/** 테스트용 최소 ScoredEntry 생성 헬퍼. */
function makeScoredEntry(
  id: string,
  finalScore: number,
  overrides: Partial<Omit<ScoredEntry, 'entityId' | 'finalScore'>> = {},
): ScoredEntry {
  return {
    entityId: createEntityId(id),
    canonicalLabel: id,
    finalScore,
    componentScores: makeComponentScores(),
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
    ...overrides,
  };
}

// ─── Stage 1: NaN finalScore 처리 ────────────────────────────────────────────
//
// NaN은 Number.isFinite()를 통과하지 못하므로 항상 마지막에 위치해야 합니다.
// `compareScoredEntriesByFinalScoreDesc(NaN, 0.5)` > 0  → NaN이 뒤에 옴
// `compareScoredEntriesByFinalScoreDesc(0.5, NaN)` < 0  → 유한 값이 앞에 옴

describe('compareScoredEntriesByFinalScoreDesc — Stage 1: NaN finalScore', () => {
  it('E1-P03-01: NaN finalScore vs finite: NaN는 항상 뒤에 (양수 반환)', () => {
    const nanEntry = makeScoredEntry('wine-a', NaN);
    const finiteEntry = makeScoredEntry('wine-b', 0.5);

    const result = compareScoredEntriesByFinalScoreDesc(nanEntry, finiteEntry);
    expect(result).toBeGreaterThan(0); // nanEntry > finiteEntry 위치 → finiteEntry가 앞
  });

  it('E1-P03-02: finite finalScore vs NaN: finite가 항상 앞에 (음수 반환)', () => {
    const nanEntry = makeScoredEntry('wine-a', NaN);
    const finiteEntry = makeScoredEntry('wine-b', 0.5);

    const result = compareScoredEntriesByFinalScoreDesc(finiteEntry, nanEntry);
    expect(result).toBeLessThan(0); // finiteEntry < nanEntry 위치 → finiteEntry가 앞
  });

  it('E1-P03-03: sort([NaN, finite])에서 finite가 먼저 나와야 함', () => {
    const nanEntry = makeScoredEntry('wine-a', NaN);
    const finiteEntry = makeScoredEntry('wine-b', 0.5);

    const sorted = [nanEntry, finiteEntry].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-b');
    expect(String(sorted[1]!.entityId)).toBe('wine-a');
  });

  it('E1-P03-04: sort([finite, NaN])에서 finite가 먼저 나와야 함 (입력 순서 불변)', () => {
    const nanEntry = makeScoredEntry('wine-a', NaN);
    const finiteEntry = makeScoredEntry('wine-b', 0.5);

    const sorted = [finiteEntry, nanEntry].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-b');
    expect(String(sorted[1]!.entityId)).toBe('wine-a');
  });

  it('E1-P03-05: 두 NaN 항목은 Stage 5 entityId 오름차순으로 정렬', () => {
    const nanZ = makeScoredEntry('wine-z', NaN);
    const nanA = makeScoredEntry('wine-a', NaN);

    const sorted = [nanZ, nanA].sort(compareScoredEntriesByFinalScoreDesc);
    // 둘 다 NaN → Stage 5: entityId 오름차순
    expect(String(sorted[0]!.entityId)).toBe('wine-a');
    expect(String(sorted[1]!.entityId)).toBe('wine-z');
  });
});

// ─── Stage 4: sparseRank undefined → Infinity 처리 ────────────────────────────
//
// sparseRank가 undefined인 경우 Infinity처럼 처리되어 마지막에 위치해야 합니다.

describe('compareScoredEntriesByFinalScoreDesc — Stage 4: sparseRank undefined=Infinity', () => {
  it('E1-P03-06: sparseRank=undefined vs sparseRank=1: 정의된 rank가 앞에 와야 함', () => {
    const noRank = makeScoredEntry('wine-a', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      // sparseRank: undefined (생략)
    });
    const withRank = makeScoredEntry('wine-b', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      sparseRank: 1,
    });

    // withRank(sparseRank=1)가 noRank(sparseRank=Infinity)보다 앞에 와야 함
    const result = compareScoredEntriesByFinalScoreDesc(noRank, withRank);
    expect(result).toBeGreaterThan(0); // noRank가 뒤에 → withRank가 앞
  });

  it('E1-P03-07: sort에서 sparseRank=1이 sparseRank=undefined보다 앞에 옴', () => {
    const noRank = makeScoredEntry('wine-a', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
    });
    const withRank = makeScoredEntry('wine-b', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      sparseRank: 1,
    });

    const sorted = [noRank, withRank].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-b'); // sparseRank=1
    expect(String(sorted[1]!.entityId)).toBe('wine-a'); // sparseRank=undefined
  });

  it('E1-P03-08: 낮은 sparseRank가 높은 sparseRank보다 앞에 옴', () => {
    const rank3 = makeScoredEntry('wine-a', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      sparseRank: 3,
    });
    const rank1 = makeScoredEntry('wine-b', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      sparseRank: 1,
    });

    const sorted = [rank3, rank1].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-b'); // sparseRank=1
    expect(String(sorted[1]!.entityId)).toBe('wine-a'); // sparseRank=3
  });

  it('E1-P03-09: sparseRank=undefined는 sparseRank=100보다 뒤에 옴', () => {
    const noRank = makeScoredEntry('wine-a', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
    });
    const highRank = makeScoredEntry('wine-b', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      sparseRank: 100,
    });

    const result = compareScoredEntriesByFinalScoreDesc(noRank, highRank);
    expect(result).toBeGreaterThan(0); // noRank(Infinity)가 highRank(100)보다 뒤
  });
});

// ─── Stage 5: entityId 오름차순 (삽입 순서 불변성) ───────────────────────────
//
// 모든 앞선 단계가 동등하다면 entityId 오름차순이 결정론적 타이-브레이크 역할을 합니다.
// 입력 순서에 관계없이 결과가 동일해야 합니다.

describe('compareScoredEntriesByFinalScoreDesc — Stage 5: entityId ascending (insertion-order invariance)', () => {
  it('E1-P03-10: 동일 조건에서 wine-a가 wine-z보다 항상 앞에 옴', () => {
    const wineZ = makeScoredEntry('wine-z', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      sparseRank: 1,
    });
    const wineA = makeScoredEntry('wine-a', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      sparseRank: 1,
    });

    // [Z, A] 순서로 입력
    const sorted1 = [wineZ, wineA].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted1[0]!.entityId)).toBe('wine-a');
    expect(String(sorted1[1]!.entityId)).toBe('wine-z');
  });

  it('E1-P03-11: [A, Z] 순서로 입력해도 wine-a가 먼저 옴 (삽입 순서 불변)', () => {
    const wineA = makeScoredEntry('wine-a', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      sparseRank: 1,
    });
    const wineZ = makeScoredEntry('wine-z', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      sparseRank: 1,
    });

    // [A, Z] 순서로 입력
    const sorted2 = [wineA, wineZ].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted2[0]!.entityId)).toBe('wine-a');
    expect(String(sorted2[1]!.entityId)).toBe('wine-z');
  });

  it('E1-P03-12: 동일한 entityId끼리는 0 반환 (안정 동등)', () => {
    const entry1 = makeScoredEntry('wine-x', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      sparseRank: 1,
    });
    const entry2 = makeScoredEntry('wine-x', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      sparseRank: 1,
    });

    expect(compareScoredEntriesByFinalScoreDesc(entry1, entry2)).toBe(0);
  });

  it('E1-P03-13: 3개 항목도 항상 entityId 오름차순으로 정렬됨', () => {
    const wineC = makeScoredEntry('wine-c', 0.5, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 1 });
    const wineA = makeScoredEntry('wine-a', 0.5, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 1 });
    const wineB = makeScoredEntry('wine-b', 0.5, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 1 });

    const sorted = [wineC, wineA, wineB].sort(compareScoredEntriesByFinalScoreDesc);
    const ids = sorted.map((e) => String(e.entityId));
    expect(ids).toEqual(['wine-a', 'wine-b', 'wine-c']);
  });
});

// ─── Stage 1 + Stage 5 통합: finalScore 우선, 동등 시 entityId ────────────────

describe('compareScoredEntriesByFinalScoreDesc — Stage 1 + Stage 5 통합', () => {
  it('E1-P03-14: 다른 finalScore는 Stage 1에서 결정 (entityId 무시)', () => {
    const highScore = makeScoredEntry('wine-z', 0.9);
    const lowScore = makeScoredEntry('wine-a', 0.1);

    const sorted = [lowScore, highScore].sort(compareScoredEntriesByFinalScoreDesc);
    // wine-z(0.9)가 wine-a(0.1)보다 앞에 와야 함
    expect(String(sorted[0]!.entityId)).toBe('wine-z');
    expect(String(sorted[1]!.entityId)).toBe('wine-a');
  });

  it('E1-P03-15: 동일 finalScore에서 entityId로 결정 (재현성 확인)', () => {
    const wineZ = makeScoredEntry('wine-z', 0.7);
    const wineA = makeScoredEntry('wine-a', 0.7);

    const run1 = [wineZ, wineA].sort(compareScoredEntriesByFinalScoreDesc).map((e) => String(e.entityId));
    const run2 = [wineA, wineZ].sort(compareScoredEntriesByFinalScoreDesc).map((e) => String(e.entityId));
    expect(run1).toEqual(['wine-a', 'wine-z']);
    expect(run2).toEqual(['wine-a', 'wine-z']);
  });
});

// ─── Stage 2: evidenceQualityTier 오름차순 ───────────────────────────────────

describe('compareScoredEntriesByFinalScoreDesc — Stage 2: evidenceQualityTier', () => {
  it('E1-P03-16: tier=0(exact)이 tier=2(ordinary)보다 앞에 옴', () => {
    const exact = makeScoredEntry('wine-a', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
      sparseRank: 1,
    });
    const ordinary = makeScoredEntry('wine-b', 0.5, {
      evidenceQualityTier: 2,
      lexicalExactnessTier: 0,
      sparseRank: 1,
    });

    const sorted = [ordinary, exact].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-a'); // tier=0
    expect(String(sorted[1]!.entityId)).toBe('wine-b'); // tier=2
  });

  it('E1-P03-17: evidenceQualityTier=undefined는 tier=3(unknown)으로 처리', () => {
    const knownItem = makeScoredEntry('wine-a', 0.5, {
      evidenceQualityTier: 0,
    });
    const noTier = makeScoredEntry('wine-b', 0.5, {
      // evidenceQualityTier: undefined (생략)
    });

    const result = compareScoredEntriesByFinalScoreDesc(knownItem, noTier);
    expect(result).toBeLessThan(0); // knownItem(0)이 noTier(3)보다 앞
  });
});

// ─── Stage 3: lexicalExactnessTier 오름차순 ──────────────────────────────────

describe('compareScoredEntriesByFinalScoreDesc — Stage 3: lexicalExactnessTier', () => {
  it('E1-P03-18: tier=0(strict/exact)이 tier=2(vintage)보다 앞에 옴', () => {
    const strictMatch = makeScoredEntry('wine-a', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 0,
    });
    const vintageMatch = makeScoredEntry('wine-b', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 2,
    });

    const sorted = [vintageMatch, strictMatch].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-a'); // tier=0
    expect(String(sorted[1]!.entityId)).toBe('wine-b'); // tier=2
  });

  it('E1-P03-19: lexicalExactnessTier=undefined는 tier=3(unknown)으로 처리', () => {
    const transliterated = makeScoredEntry('wine-a', 0.5, {
      evidenceQualityTier: 0,
      lexicalExactnessTier: 1,
    });
    const noTier = makeScoredEntry('wine-b', 0.5, {
      evidenceQualityTier: 0,
      // lexicalExactnessTier: undefined (생략)
    });

    const result = compareScoredEntriesByFinalScoreDesc(transliterated, noTier);
    expect(result).toBeLessThan(0); // transliterated(1)이 noTier(3)보다 앞
  });
});

// ─── 수학적 완결성: Antisymmetry (반대칭성) ──────────────────────────────────
//
// 비교 함수의 수학적 계약:
//   cmp(A, B) = -cmp(B, A)  (반대칭성)
//   cmp(A, A) = 0           (자기 동등)
//
// 이를 위반하면 JS sort()는 비결정적 결과를 낸다.

describe('compareScoredEntriesByFinalScoreDesc — 수학적 속성: Antisymmetry', () => {
  const baseProps = { evidenceQualityTier: 0 as const, lexicalExactnessTier: 0 as const, sparseRank: 1 };

  it('E1-MATH-01: cmp(A,B)와 cmp(B,A)는 부호가 반대 — 다른 finalScore', () => {
    const high = makeScoredEntry('wine-high', 0.9, baseProps);
    const low = makeScoredEntry('wine-low', 0.1, baseProps);
    const ab = compareScoredEntriesByFinalScoreDesc(high, low);
    const ba = compareScoredEntriesByFinalScoreDesc(low, high);
    expect(Math.sign(ab)).toBe(-Math.sign(ba));
  });

  it('E1-MATH-02: cmp(A,A) = 0 — 자기 동등 (반사성)', () => {
    const entry = makeScoredEntry('wine-x', 0.75, baseProps);
    expect(compareScoredEntriesByFinalScoreDesc(entry, entry)).toBe(0);
  });

  it('E1-MATH-03: cmp(A,B)와 cmp(B,A)는 부호가 반대 — 동일 finalScore, 다른 evidenceQualityTier', () => {
    const tier0 = makeScoredEntry('wine-a', 0.5, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 1 });
    const tier2 = makeScoredEntry('wine-b', 0.5, { evidenceQualityTier: 2, lexicalExactnessTier: 0, sparseRank: 1 });
    const ab = compareScoredEntriesByFinalScoreDesc(tier0, tier2);
    const ba = compareScoredEntriesByFinalScoreDesc(tier2, tier0);
    expect(Math.sign(ab)).toBe(-Math.sign(ba));
  });

  it('E1-MATH-04: cmp(A,B)와 cmp(B,A)는 부호가 반대 — 동일 finalScore, 다른 sparseRank', () => {
    const rank1 = makeScoredEntry('wine-a', 0.5, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 1 });
    const rank5 = makeScoredEntry('wine-b', 0.5, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 5 });
    const ab = compareScoredEntriesByFinalScoreDesc(rank1, rank5);
    const ba = compareScoredEntriesByFinalScoreDesc(rank5, rank1);
    expect(Math.sign(ab)).toBe(-Math.sign(ba));
  });

  it('E1-MATH-05: cmp(A,B)와 cmp(B,A)는 부호가 반대 — NaN vs finite', () => {
    const nanEntry = makeScoredEntry('wine-nan', NaN);
    const finiteEntry = makeScoredEntry('wine-ok', 0.5);
    const ab = compareScoredEntriesByFinalScoreDesc(nanEntry, finiteEntry);
    const ba = compareScoredEntriesByFinalScoreDesc(finiteEntry, nanEntry);
    expect(Math.sign(ab)).toBe(-Math.sign(ba));
  });

  it('E1-MATH-06: antisymmetry on entityId tiebreak — cmp(wine-a, wine-z) = -cmp(wine-z, wine-a)', () => {
    const wineA = makeScoredEntry('wine-a', 0.5, baseProps);
    const wineZ = makeScoredEntry('wine-z', 0.5, baseProps);
    const az = compareScoredEntriesByFinalScoreDesc(wineA, wineZ);
    const za = compareScoredEntriesByFinalScoreDesc(wineZ, wineA);
    expect(Math.sign(az)).toBe(-Math.sign(za));
  });
});

// ─── 수학적 완결성: Transitivity (추이성) ────────────────────────────────────
//
// 정렬 계약:
//   cmp(A,B) < 0 ∧ cmp(B,C) < 0  →  cmp(A,C) < 0
//
// 추이성이 깨지면 100+ 항목 정렬에서 사이클이 발생해 비결정적이 된다.

describe('compareScoredEntriesByFinalScoreDesc — 수학적 속성: Transitivity', () => {
  it('E1-MATH-07: finalScore 기준 추이성 — A(0.9) > B(0.5) > C(0.1) → A > C', () => {
    const a = makeScoredEntry('wine-a', 0.9);
    const b = makeScoredEntry('wine-b', 0.5);
    const c = makeScoredEntry('wine-c', 0.1);
    expect(compareScoredEntriesByFinalScoreDesc(a, b)).toBeLessThan(0); // A before B
    expect(compareScoredEntriesByFinalScoreDesc(b, c)).toBeLessThan(0); // B before C
    expect(compareScoredEntriesByFinalScoreDesc(a, c)).toBeLessThan(0); // A before C ← 추이성
  });

  it('E1-MATH-08: evidenceQualityTier 기준 추이성 — tier0 > tier1 > tier2 → tier0 > tier2', () => {
    const props0 = { evidenceQualityTier: 0 as const, lexicalExactnessTier: 0 as const, sparseRank: 1 };
    const props1 = { evidenceQualityTier: 1 as const, lexicalExactnessTier: 0 as const, sparseRank: 1 };
    const props2 = { evidenceQualityTier: 2 as const, lexicalExactnessTier: 0 as const, sparseRank: 1 };
    const a = makeScoredEntry('wine-a', 0.5, props0);
    const b = makeScoredEntry('wine-b', 0.5, props1);
    const c = makeScoredEntry('wine-c', 0.5, props2);
    expect(compareScoredEntriesByFinalScoreDesc(a, b)).toBeLessThan(0);
    expect(compareScoredEntriesByFinalScoreDesc(b, c)).toBeLessThan(0);
    expect(compareScoredEntriesByFinalScoreDesc(a, c)).toBeLessThan(0); // 추이성
  });

  it('E1-MATH-09: sparseRank 기준 추이성 — rank1 > rank3 > rank10 → rank1 > rank10', () => {
    const props = { evidenceQualityTier: 0 as const, lexicalExactnessTier: 0 as const };
    const a = makeScoredEntry('wine-a', 0.5, { ...props, sparseRank: 1 });
    const b = makeScoredEntry('wine-b', 0.5, { ...props, sparseRank: 3 });
    const c = makeScoredEntry('wine-c', 0.5, { ...props, sparseRank: 10 });
    expect(compareScoredEntriesByFinalScoreDesc(a, b)).toBeLessThan(0);
    expect(compareScoredEntriesByFinalScoreDesc(b, c)).toBeLessThan(0);
    expect(compareScoredEntriesByFinalScoreDesc(a, c)).toBeLessThan(0); // 추이성
  });

  it('E1-MATH-10: entityId 기준 추이성 — wine-a > wine-m > wine-z → wine-a > wine-z', () => {
    const props = { evidenceQualityTier: 0 as const, lexicalExactnessTier: 0 as const, sparseRank: 1 };
    const a = makeScoredEntry('wine-a', 0.5, props);
    const b = makeScoredEntry('wine-m', 0.5, props);
    const c = makeScoredEntry('wine-z', 0.5, props);
    expect(compareScoredEntriesByFinalScoreDesc(a, b)).toBeLessThan(0);
    expect(compareScoredEntriesByFinalScoreDesc(b, c)).toBeLessThan(0);
    expect(compareScoredEntriesByFinalScoreDesc(a, c)).toBeLessThan(0); // 추이성
  });

  it('E1-MATH-11: 크로스-스테이지 추이성 — finalScore > evidenceQualityTier > entityId 순으로 결정', () => {
    // A: score=0.9 → B: score=0.5, tier=0 → C: score=0.5, tier=2
    // A > B (stage 1), B > C (stage 2), A > C (추이성)
    const a = makeScoredEntry('wine-a', 0.9);
    const b = makeScoredEntry('wine-b', 0.5, { evidenceQualityTier: 0 });
    const c = makeScoredEntry('wine-c', 0.5, { evidenceQualityTier: 2 });
    const ab = compareScoredEntriesByFinalScoreDesc(a, b);
    const bc = compareScoredEntriesByFinalScoreDesc(b, c);
    const ac = compareScoredEntriesByFinalScoreDesc(a, c);
    expect(ab).toBeLessThan(0); // A before B
    expect(bc).toBeLessThan(0); // B before C
    expect(ac).toBeLessThan(0); // A before C (추이성)
  });
});

// ─── NaN×NaN: Stage 2-4 낙하 경로 검증 ──────────────────────────────────────
//
// NaN vs NaN인 경우 compareScoredEntriesByFinalScoreDesc는 Stage 1을 건너뛰고
// Stage 2(evidenceQualityTier) → 3(lexicalExactnessTier) → 4(sparseRank) → 5(entityId)로 진행.
// 이 경로 전체가 올바르게 동작하는지 각 단계별로 검증.

describe('compareScoredEntriesByFinalScoreDesc — NaN×NaN: Stage 2-4 진행 경로', () => {
  it('E1-NAN-01: NaN vs NaN — evidenceQualityTier 차이가 결정 (Stage 2 진입)', () => {
    const nanTier0 = makeScoredEntry('wine-z', NaN, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 1 });
    const nanTier2 = makeScoredEntry('wine-a', NaN, { evidenceQualityTier: 2, lexicalExactnessTier: 0, sparseRank: 1 });
    // NaN임에도 tier=0이 tier=2보다 앞에 와야 한다
    const sorted = [nanTier2, nanTier0].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-z'); // tier=0 먼저
    expect(String(sorted[1]!.entityId)).toBe('wine-a'); // tier=2 나중
  });

  it('E1-NAN-02: NaN vs NaN — lexicalExactnessTier 차이가 결정 (Stage 3 진입)', () => {
    // Stage 2가 같을 때 Stage 3으로 진입
    const nanLex0 = makeScoredEntry('wine-x', NaN, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 1 });
    const nanLex2 = makeScoredEntry('wine-y', NaN, { evidenceQualityTier: 0, lexicalExactnessTier: 2, sparseRank: 1 });
    const sorted = [nanLex2, nanLex0].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-x'); // lex=0 먼저
    expect(String(sorted[1]!.entityId)).toBe('wine-y');
  });

  it('E1-NAN-03: NaN vs NaN — sparseRank 차이가 결정 (Stage 4 진입)', () => {
    // Stage 2, 3이 같을 때 Stage 4로 진입
    const nanSparse1 = makeScoredEntry('wine-b', NaN, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 1 });
    const nanSparse5 = makeScoredEntry('wine-a', NaN, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 5 });
    // sparseRank=1이 sparseRank=5보다 앞에 와야 한다 (entityId 사전순과 역방향임을 주목)
    const sorted = [nanSparse5, nanSparse1].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-b'); // rank=1
    expect(String(sorted[1]!.entityId)).toBe('wine-a'); // rank=5
  });

  it('E1-NAN-04: NaN vs NaN — sparseRank=undefined가 정의된 rank보다 뒤에 옴 (Stage 4)', () => {
    const nanSparseUndef = makeScoredEntry('wine-a', NaN, { evidenceQualityTier: 0, lexicalExactnessTier: 0 });
    const nanSparse5 = makeScoredEntry('wine-b', NaN, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 5 });
    const sorted = [nanSparseUndef, nanSparse5].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-b'); // rank=5 < Infinity
    expect(String(sorted[1]!.entityId)).toBe('wine-a'); // Infinity
  });

  it('E1-NAN-05: NaN vs NaN — 모든 Stage 같을 때 entityId 결정 (Stage 5)', () => {
    const nanA = makeScoredEntry('wine-a', NaN, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 1 });
    const nanZ = makeScoredEntry('wine-z', NaN, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 1 });
    const sorted = [nanZ, nanA].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-a');
    expect(String(sorted[1]!.entityId)).toBe('wine-z');
  });

  it('E1-NAN-06: NaN×NaN antisymmetry — Stage 2-5 경로에서도 반대칭성 유지', () => {
    const nanTier0 = makeScoredEntry('wine-x', NaN, { evidenceQualityTier: 0, lexicalExactnessTier: 0, sparseRank: 1 });
    const nanTier2 = makeScoredEntry('wine-y', NaN, { evidenceQualityTier: 2, lexicalExactnessTier: 0, sparseRank: 1 });
    const ab = compareScoredEntriesByFinalScoreDesc(nanTier0, nanTier2);
    const ba = compareScoredEntriesByFinalScoreDesc(nanTier2, nanTier0);
    expect(Math.sign(ab)).toBe(-Math.sign(ba));
  });
});

// ─── sparseRank 단조성 (Monotonicity) ────────────────────────────────────────

describe('compareScoredEntriesByFinalScoreDesc — sparseRank 단조성', () => {
  const baseProps = { evidenceQualityTier: 0 as const, lexicalExactnessTier: 0 as const };

  it('E1-MONO-01: sparseRank 단조성 — rank 1 < 10 < 100 < Infinity (4단계 전체)', () => {
    const entries = [
      makeScoredEntry('wine-d', 0.5, { ...baseProps, sparseRank: 100 }),
      makeScoredEntry('wine-e', 0.5, { ...baseProps }), // sparseRank undefined → Infinity
      makeScoredEntry('wine-a', 0.5, { ...baseProps, sparseRank: 1 }),
      makeScoredEntry('wine-c', 0.5, { ...baseProps, sparseRank: 10 }),
    ];
    const sorted = entries.sort(compareScoredEntriesByFinalScoreDesc);
    const sortedIds = sorted.map((e) => String(e.entityId));
    expect(sortedIds).toEqual(['wine-a', 'wine-c', 'wine-d', 'wine-e']);
  });

  it('E1-MONO-02: sparseRank=1 vs sparseRank=2 — 역순 입력에서도 동일 결과', () => {
    const rank1 = makeScoredEntry('wine-b', 0.5, { ...baseProps, sparseRank: 1 });
    const rank2 = makeScoredEntry('wine-a', 0.5, { ...baseProps, sparseRank: 2 });
    // wine-b(rank=1)가 wine-a(rank=2)보다 앞 — entityId 역순임에도
    const fwd = [rank1, rank2].sort(compareScoredEntriesByFinalScoreDesc).map((e) => String(e.entityId));
    const rev = [rank2, rank1].sort(compareScoredEntriesByFinalScoreDesc).map((e) => String(e.entityId));
    expect(fwd).toEqual(['wine-b', 'wine-a']); // sparseRank가 entityId보다 우선
    expect(rev).toEqual(fwd); // 입력 순서 무관
  });

  it('E1-MONO-03: sparseRank=undefined vs sparseRank=99999 — 정의된 rank가 항상 앞', () => {
    const large = makeScoredEntry('wine-a', 0.5, { ...baseProps, sparseRank: 99999 });
    const undef = makeScoredEntry('wine-b', 0.5, { ...baseProps }); // undefined → Infinity
    const sorted = [undef, large].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-a'); // 99999 < Infinity
    expect(String(sorted[1]!.entityId)).toBe('wine-b');
  });
});

// ─── 입력 순서 불변성 (Insertion-Order Invariance) — 대규모 ──────────────────

describe('compareScoredEntriesByFinalScoreDesc — 입력 순서 불변성 (대규모)', () => {
  function shuffle<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }

  it('E1-INV-01: 50개 항목 — 무작위 순서 5회 셔플해도 정렬 결과 동일', () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      makeScoredEntry(`wine-${String(i).padStart(3, '0')}`, Math.random(), {
        evidenceQualityTier: (i % 4) as 0 | 1 | 2 | 3,
        lexicalExactnessTier: (i % 4) as 0 | 1 | 2 | 3,
        sparseRank: i % 5 === 0 ? undefined : (i % 20) + 1,
      }),
    );
    const canonical = [...entries].sort(compareScoredEntriesByFinalScoreDesc).map((e) => String(e.entityId));
    for (let trial = 0; trial < 5; trial++) {
      const shuffled = shuffle([...entries]).sort(compareScoredEntriesByFinalScoreDesc).map((e) => String(e.entityId));
      expect(shuffled).toEqual(canonical);
    }
  });

  it('E1-INV-02: 30개 동점 항목 — 모든 셔플에서 entityId 오름차순 고정', () => {
    // 모든 항목이 동일한 finalScore, tier, sparseRank → entityId만으로 결정
    const FIXED_SCORE = 0.5;
    const props = { evidenceQualityTier: 0 as const, lexicalExactnessTier: 0 as const, sparseRank: 1 };
    const entries = Array.from({ length: 30 }, (_, i) =>
      makeScoredEntry(`entity-${String(i).padStart(3, '0')}`, FIXED_SCORE, props),
    );
    const expected = [...entries].map((e) => String(e.entityId)).sort(); // 사전순
    for (let trial = 0; trial < 5; trial++) {
      const shuffled = shuffle([...entries]).sort(compareScoredEntriesByFinalScoreDesc).map((e) => String(e.entityId));
      expect(shuffled).toEqual(expected);
    }
  });
});

// ─── EPSILON 경계값 (FINAL_SCORE_SORT_TIE_EPSILON = 1e-12) ───────────────────

describe('compareScoredEntriesByFinalScoreDesc — EPSILON 경계값', () => {
  it('E1-EPS-01: 차이가 EPSILON보다 크면 Stage 1에서 결정됨', () => {
    // 1e-11 > 1e-12 이므로 Stage 1에서 결정
    const a = makeScoredEntry('wine-z', 0.5 + 1e-11); // 더 크지만 entityId는 나중
    const b = makeScoredEntry('wine-a', 0.5);
    const sorted = [b, a].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-z'); // score가 우선 (entityId 무시)
  });

  it('E1-EPS-02: 차이가 EPSILON 이하면 동점으로 처리해 Stage 2+로 진행', () => {
    // 1e-13 < 1e-12 이므로 동점 처리 → Stage 5 entityId로 결정
    const a = makeScoredEntry('wine-z', 0.5 + 1e-13); // 아주 약간 크지만
    const b = makeScoredEntry('wine-a', 0.5);
    const sorted = [a, b].sort(compareScoredEntriesByFinalScoreDesc);
    expect(String(sorted[0]!.entityId)).toBe('wine-a'); // entityId 오름차순 우선 (동점이므로)
  });
});

