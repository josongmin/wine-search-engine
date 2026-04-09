# Epic 03 — 점수 척도 명확화 → Unified Feature Space 준비

**Phase:** 유지보수 (Phase B 진행 중 자연스럽게 해소)
**우선순위:** P2
**Breaking:** Yes (타입 레벨)
**2026 라벨:** `LEGACY_RISK`
**학습 필요:** `학습 불필요`

---

## 왜 — SOTA++ 구조적 의미

동일 필드명이 다른 척도를 의미하면 **LTR feature가 오염**된다.
`retrievalFusionScore`가 BM25 raw (0-∞)인지 RRF 총점 (0-1)인지에 따라 LambdaMART가 완전히 다른 모델을 학습한다.
Weight 합이 1.0이 아니면 signal 기여도가 왜곡되어 **feature importance 분석이 불가능**.

**SOTA:** 모든 feature는 명시적 scale과 semantics를 가지며, feature store에서 schema-validated.

---

## Task 목록

### T03-1. `retrievalFusionScore` 의미 분리

Browse/Compare = BM25 raw, Hybrid = RRF 총점 → 이름 분리 또는 branded type.
**SOTA 얼라인:** LTR feature vector에 넣을 때 scale mismatch 방지.

### T03-2. `RetrievalProfile` 가중치 미소비 정리

sparse/dense/anchor 가중치가 RRF-only FusionService에서 미소비 → 제거하거나 weighted RRF 전환.
**SOTA 얼라인:** Epic-16 (Learned Fusion)에서 이 가중치를 학습 대상으로 전환. 현재 미소비면 혼란만.

### T03-3. Scoring Weights 합 불변식

DEFAULT_WEIGHTS 합 0.95, 일부 ModeWeightProfile > 1.0 → 합 = 1.0 보장.
**SOTA 얼라인:** Weight를 LambdaMART로 교체할 때 (Epic-10) fallback weight가 올바른 baseline이어야 함.
컴파일타임 검증: `Object.values(weights).reduce((a,b)=>a+b) === 1.0` assertion.

---

## 완료 조건

- `retrievalFusionScore` 동일 이름 다른 의미 0건
- 모든 weight profile 합 = 1.0 (테스트 assertion)
- 미소비 가중치 0건 또는 명시적 TODO
