# Epic 12 — Degradation: Circuit Breaker + Ranking-Aware Degradation

**Phase:** B (학습 점화)
**우선순위:** P1
**의존:** Epic-04 (관측성)
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `학습 불필요`

---

## v3 재진단: 이전 plan이 과장한 것

### 실제로 이미 있는 것 (코드 감사 결과)

`candidate-pool.ts`의 모든 catch block (lines 140, 168, 233, 269)은:
1. `bootstrapLogger.warn()` / `.error()` 로 **structured 로그 emit 중**
2. `this.degradationObserver?.onDegradation()` **이미 호출 중** (component, severity, reason, fallbackApplied 포함)

→ **"모든 실패를 삼킨다"는 거짓.** Degradation observer 패턴이 이미 존재.

`rule-based-constraint-extractor.ts`의 negation 처리:
- `extractSearchConstraints()`에 `exclude` constraint emission 존재 (lines 208-230, 476-499)
- "빼고", "제외", "without X", "no X" 패턴 처리

→ **"regex가 negation 역전"은 미검증.** 실제 negation handling 코드 존재.

### 실제로 없는 것 (진짜 gap)

1. **Circuit breaker** — 5 failures in 60s → fast-fail. 현재는 매번 시도 후 catch.
2. **Degradation-aware ranking** — ranking이 degradation 상태를 모름. Dense가 죽으면 semantic score가 쓰레기인데 동일 weight 적용.
3. **Error classification** — transient vs systematic 구분 없이 모든 에러를 동일 처리.

---

## Task 목록 (v3: 과장 제거, 진짜 gap만)

### T12-1. Component별 Circuit Breaker

**현재:** 매번 호출 시도 → catch → degrade. 반복 실패 시에도 매번 latency 낭비.

**변경:**
- `CircuitBreakerPort` 인터페이스
- CLOSED → OPEN (5 failures/60s) → HALF_OPEN (30s probe)
- OPEN 상태에서는 **즉시 skip** (catch에 도달하지도 않음)

| Component | 적용 |
|-----------|------|
| Vespa sparse/dense | `vespa_sparse_cb`, `vespa_dense_cb` |
| Embedding service | `embedding_cb` |
| Reranker | `reranker_cb` |
| LLM NL Mapper | `llm_mapper_cb` |
| Learned Matcher | `learned_matcher_cb` |

**학계:** Circuit Breaker Pattern (Nygard, "Release It!" 2007)

---

### T12-2. Degradation-Aware LTR Feature

**현재:** Ranking이 degradation 상태를 모름

**변경:**
- `degradation_vector` feature를 LTR에 포함 (Epic-10 연계)
  - `is_dense_degraded: 0|1`
  - `is_sparse_degraded: 0|1`
  - `is_anchor_degraded: 0|1`
  - `degraded_channel_count: 0-4`
- LightGBM가 자동으로 "dense 죽었을 때는 semantic score 무시" 학습

**SOTA:** Google's degradation-aware serving — per-feature availability mask

---

### T12-3. Error Classification

**변경:**
```typescript
type ErrorClassification = 'transient' | 'systematic' | 'data_quality' | 'unknown';
```
- `transient` → circuit breaker count + retry (1회)
- `systematic` → 즉시 degrade + alert
- `unknown` → degrade + alert + stderr

---

### T12-4. NL Mapper Tier Confidence 표기

**v3 수정:** Negation 역전은 미검증이므로 claim에서 제거. 실제 gap은 **tier confidence 표기 부재.**

**변경:**
- LLM tier 1 성공 → `constraintConfidence: 'high'`
- LLM 실패 → rule-based tier 2 → `constraintConfidence: 'medium'`
- Tier 2 사용 시 `degradation_reasons: ['llm_mapper_fallback']`

---

### T12-5. `/metrics/degradation` 엔드포인트

Component별 circuit breaker state + degradation rate (rolling 5min).
Epic-04 T04-2 (silent skip metrics)를 여기로 통합.

---

## 완료 조건

- 모든 외부 I/O에 circuit breaker
- LTR feature에 `degradation_vector` 포함
- Error classification 동작 (transient vs systematic)
- NL Mapper tier confidence 표기
