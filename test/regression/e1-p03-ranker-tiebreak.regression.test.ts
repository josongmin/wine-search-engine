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
