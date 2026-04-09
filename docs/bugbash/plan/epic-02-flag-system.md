# Epic 02 — 플래그·킬스위치 → A/B 실험 가능 Feature Gate

**Phase:** A (기반 정리)
**우선순위:** P1
**Breaking:** Yes (이중 게이트 삭제, ghost phase 제거)
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `학습 불필요`

---

## 왜 — SOTA++ 구조적 의미

킬스위치가 이중 게이트(하드코딩 상수 + 런타임 플래그)로 존재하면 **A/B 실험이 불가능**하다.
Feature를 활성화/비활성화하려면 **단일 제어점**이 있어야 하고, 그 제어점이 **query-level granularity**로 동작해야 한다.

**업계 SOTA:**
- Google: Per-query feature flags with experiment assignment (Vizier)
- Netflix: Zuul + feature flag service → per-request routing
- Uber: Per-trip experiment assignment with holdout groups
- LaunchDarkly/Split.io: Feature flag as first-class infra

**현재:** 3층 플래그 (env → kill-switch-policy → 하드코딩 상수) + ghost phase (`rerank`)

---

## Task 목록

### T02-1. Learned Sparse 단일 게이트

`LEARNED_SPARSE_CHANNEL_ENABLED = false` (컴파일타임) + `killSwitchLearning` (런타임) → **`killSwitch.learning` 단일 게이트**.
**SOTA 얼라인:** SPLADE 활성화 (Epic-16)의 전제 조건. 단일 게이트여야 query-level on/off 가능.

### T02-2. Dense 킬스위치 Pre-flight Guard

킬스위치 on인데 ANN 호출 가능 → **pre-flight guard로 호출 자체 차단**.
**SOTA 얼라인:** 비용 제어. Dense off 시 embedding 호출도 스킵 → latency + cost 절감.

### T02-3. Ghost Phase (`rerank`) 제거

`allPhases`에 열거 + `shouldExecutePhase` 항상 false → **제거**.
Epic-10에서 실제 reranker 도입 시 복원.

### T02-4. `resolveChannelMix` 미사용 인자 제거

void 인자 삭제. API 표면 최소화.

### T02-5. Feature Gate → Query-Level Granularity (구조 준비)

**현재:** 킬스위치는 app-level boolean (전체 on/off)

**SOTA 방향:** Per-query feature flag
```typescript
interface FeatureGate {
  isEnabled(feature: string, context: { queryId: string; userId?: string; experimentBucket?: number }): boolean;
}
```

Phase A에서는 인터페이스만 정의 + 기존 킬스위치를 이 인터페이스 뒤로 래핑.
Epic-18 (Feedback Loop)에서 experiment assignment와 연결.

---

## 완료 조건

- `LEARNED_SPARSE_CHANNEL_ENABLED` 하드코딩 0건
- `rerank` phase 열거 0건
- Dense 킬스위치 on → embedding + denseSearch 모두 미호출
- `FeatureGate` 인터페이스 존재, 킬스위치가 이를 통해 평가