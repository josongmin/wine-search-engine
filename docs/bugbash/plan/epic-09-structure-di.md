# Epic 09 — 구조·DI → 컴포넌트 단위 교체 가능 아키텍처

**Phase:** A (기반 정리)
**우선순위:** P2
**의존:** Epic-01 이후
**Breaking:** Yes (모듈 분해, DI 인터페이스 변경)
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `학습 불필요`

---

## 왜 — SOTA++ 구조적 의미

God class/function이 있으면 **컴포넌트 단위 교체가 불가능**하다.
- Ranker를 LambdaMART로 교체하려면 `SearchUseCase`의 21개 의존성을 건드려야 함
- Intent detector를 neural로 교체하려면 555줄 post-route 함수를 파헤쳐야 함
- 새 signal을 추가하려면 scoring-weights.ts 외 6곳을 수정해야 함 (OCP 위반)

**SOTA 아키텍처:** Plugin-style composition
- Google: Per-stage handler with shared context
- Amazon: 각 ranking signal이 독립 module, registry에 등록
- Elasticsearch: Pipeline of processors, 각각 독립 교체 가능

---

## Task 목록

### T09-1. `env.ts` 서브스키마 분리

529줄 → 도메인별 서브스키마 (db, vespa, ai, retrieval, http, eval).
**SOTA 얼라인:** Feature flag / config를 도메인별로 분리해야 A/B 실험 시 blast radius 축소.

### T09-2. `CandidatePoolService` DI 정상화

Constructor에서 `new RetrievalProfileService()` 등 직접 생성 → 생성자 주입.
**SOTA 얼라인:** Profile을 학습된 것으로 교체할 때 container 설정만 변경.

### T09-3. `SearchUseCase` 의존성 축소

21개 의존성 → 5-7개로 축소 (pre-route, route, post-route 각각 독립 서비스).
**SOTA 얼라인:** 각 phase를 독립적으로 A/B 테스트 가능.

### T09-4. `post-route-phase` 분해

555줄 단일 함수 → phase별 handler:
- `RerankPhaseHandler` — cross-encoder (Epic-10)
- `RankingPhaseHandler` — signal compute + LTR (Epic-10)
- `DecisionPhaseHandler` — calibrated decision (Epic-17)
- `ResponsePhaseHandler` — response build

**SOTA 얼라인:** 각 handler를 독립적으로 교체/비활성화 가능.

### T09-5. `AgentOrchestrator` 분해

~1200줄 → `AgentPlanExecutor` + `AgentToolDispatcher` + `AgentBudgetGuard`.
**SOTA 얼라인:** Tool dispatcher를 ReAct/Plan-and-Execute/Reflection 등 다양한 전략으로 교체 가능.

### T09-6. Signal Registry (OCP 준수)

**현재:** 새 signal 추가 시 6곳 수정 (scoring-weights, mode-weights, signal-computer, score-aggregator, ltr-feature-extractor, evidence-mapper)

**SOTA 방향:**
```typescript
interface RankingSignal {
  readonly name: string;
  compute(candidate: HybridCandidate, context: RankingContext): number;
}

class SignalRegistry {
  register(signal: RankingSignal): void;
  computeAll(candidate, context): FeatureVector;
}
```

새 signal 추가 = 1개 클래스 구현 + registry 등록. 6곳 수정 불필요.

### T09-7. `DecomposedSearchAdapter` mutable delegate 안전화

Runtime NPE 위험 → fail-fast error throw.

### T09-8. `InMemoryJudgmentCache` TTL eviction

Singleton stale 누적 → TTL-based eviction.

### T09-9. `SearchIndexPort` ISP 분리

read+write 혼합 → `SearchIndexReadPort` + `SearchIndexWritePort`.
**SOTA 얼라인:** Read path 최적화 (cache, read replica) 독립 적용 가능.

---

## 완료 조건

- 새 ranking signal 추가 시 수정 파일 수 = 1 (registry 등록만)
- 각 post-route phase handler < 150줄
- `SearchUseCase` 의존성 <= 7개
- `AgentOrchestrator` < 300줄
