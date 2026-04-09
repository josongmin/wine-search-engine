# Epic 05 — 비교 의미론 → Reproducible Evaluation Gate

**Phase:** A (기반)
**우선순위:** P1
**Breaking:** 결과 순서 변경 가능
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `학습 불필요`

---

## 왜 — SOTA++ 구조적 의미

**Evaluation이 reproducible하지 않으면 학습 개선을 측정할 수 없다.**
동일 쿼리 × 동일 데이터 → 다른 결과 순서가 나오면 NDCG 비교가 무의미.

현재 동점 시 순회 순서 의존 (비결정적). NaN 시 undefined behavior.
→ 모든 학습 실험 (Epic-10, 15, 16, 17)의 eval 신뢰도가 근본적으로 훼손됨.

이 epic은 단순 cleanup이 아니라 **Phase B 진입 전 안정 계약**이다.

---

## Task 목록

### T05-1. `compareScore` 유틸

NaN → -Infinity, 동점 → entityId 사전순 tiebreaker. 모든 score 비교 지점 적용.

### T05-2. Eval Rank 계약

1-based rank 통일. `candidatesToEvalSlices`와 `rankedResultsToEvalSlices` 정렬.

### T05-3. `PENALTY_TOOL_DUPLICATE` 수정

graduated penalty (현재 Math.max 역전).

### T05-4. `deriveWineType` → Ontology Lookup

영문 substring → entity-ontology.json lookup table.

---

## 완료 조건

- 동일 입력 → 동일 출력 (deterministic) — 10회 반복 검증 테스트
- NaN score 입력 → deterministic 결과
- Eval NDCG 계산이 순서 안정적
- `Epic-13`이 이 계약 위에서만 실행됨
