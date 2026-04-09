# Epic 01 — SSoT (Single Source of Truth) 통합

**Phase:** A (기반 정리)
**우선순위:** P1 — 모든 Epic의 기반
**Breaking:** Yes (export 경로 변경, 중복 모듈 삭제)
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `학습 불필요`

---

## 왜 — 구조적 의미

SSoT 부재는 단순한 코드 중복이 아니다. **실험 불가능성**의 원인이다.
RRF k를 튜닝하려면 한 곳만 바꿔야 하는데 4곳에 흩어져 있으면 실험 자체가 불가능.
SOTA 시스템은 모든 하이퍼파라미터가 **단일 config**에서 관리되어 sweep/A/B가 즉시 가능.

현재 확인된 SSoT 위반 8건:
1. RRF 상수 (rrf.ts + candidate-pool.ts)
2. Channel whitelist (candidate-pool + evidence-accumulator + trace-vocab-aligner)
3. Vintage regex (4곳, 범위 불일치)
4. KRW/USD 환율 (3곳, 값 불일치)
5. titleCase (3곳)
6. fetchWithSummary (2곳)
7. Fusion 테스트 (2곳)
8. Metric 함수 (constraint-extraction-evaluator orphaned)

---

## Task 목록

### T01-1. Retrieval Channel 단일 모듈

`toCanonicalCandidateChannel` 2곳 독립 → `retrieval-channel.ts` 단일 export.
**변경 대상:** candidate-pool.ts, evidence-accumulator.ts, trace-vocab-aligner.ts

### T01-2. Vintage Strip 단일 모듈

4곳 → `src/domain/shared/utils/vintage.ts`. 범위: 1850-2030 (도메인 사실).
18xx 불일치 해소. Unicode boundary 통일.

### T01-3. RRF `reciprocalRankContribution` 통합

candidate-pool.ts:532 private 함수 삭제 → rrf.ts export 사용.
**이유:** Epic-16 (Learned Fusion)에서 k를 tunable하게 만들려면 단일 진입점 필수.

### T01-4. 중복 테스트 파일 정리

fusion.test.ts ×2, rrf.test.ts ×2 → co-located 위치만 유지.

### T01-5. KRW/USD 환율 단일 상수

3곳 (rule-based-constraint-extractor, claim-extractor, wine-ontology) + ETL (vivino-to-silver)
→ `shared/constants.ts` 단일 `KRW_PER_USD_APPROXIMATE` 파생.

### T01-6. titleCase 단일 모듈

3곳 → `src/domain/shared/utils/title-case.ts`.

### T01-7. `fetchWithHitSummary` / `fetchWithFeatureSummary` 통합

`fetchWithSummary<T>(ids, yql, summaryName, parser)` 제네릭 헬퍼.

### T01-8. Orphaned Metric 함수 정리 (SSOT-3)

`constraint-extraction-evaluator.ts` 삭제 → `constraint-metrics.ts`로 병합.

---

## 완료 조건

- 각 로직의 정의가 **정확히 1개 파일**에만 존재
- `grep` 검증 스크립트 (`npm run verify:ssot`) 추가 권장
