# Pending Calibration & Design Decisions Inventory

**날짜**: 2026-04-10
**출처**: Phase 1-3 비판적 리뷰 5바퀴 (R1-R8) 합집합
**상태**: 모두 코드 레벨 구현 완료, **데이터 기반 calibration 또는 인프라 설계 결정** 대기

---

## 1. Per-Class Fusion Config — RRF k + channel weights

### 배경
Reciprocal Rank Fusion (Cormack et al. 2009)은 `1/(k+rank)` 공식으로 다중 retrieval 채널 결과를 합산한다. k 값과 채널별 weight는 query 유형에 따라 최적값이 다르다 (entity lookup은 lexical 채널 우세, pairing은 semantic 우세).

### 해결하고자 하는 것
Query class별로 최적 RRF k + sparse/dense/anchor weight를 데이터 기반으로 calibrate하여 retrieval recall@20 ceiling을 올린다. 현재는 직관 기반 placeholder 값이 들어있음.

### 현재 상황
- **파일**: `src/domain/retrieval/service/per-class-fusion-config.ts`
- **상수 위치**:
  - L18: `RRF_K_DEFAULT = 60` (Cormack 논문 기반 — **justified**)
  - L24: `RRF_K_TIGHT = 30` (specific_wine용 — **placeholder**)
  - L29: `RRF_K_COMPARE = 40` (comparison용 — **placeholder**)
  - L35: `RRF_K_LOOSE = 80` (pairing용 — **placeholder**)
  - L38-50: `WEIGHT_NEUTRAL=1.0`, `WEIGHT_DAMPED=0.8`, `WEIGHT_HALF=0.5`, `WEIGHT_BOOST_MILD=1.5`, `WEIGHT_BOOST_STRONG=2.0` — 모두 **placeholder**, "rule-of-thumb starting points; will be replaced by calibrated values from sweep harness" 주석 기재
- **필요 작업**: golden-queries-silver.jsonl 기반 grid sweep (`W0-4` in epic plan)
- **차단 요소**: Epic-13 retrieval ceiling metrics 완성 필요 (코드 완료, human gold split 미생성)

---

## 2. Query Difficulty Estimator — Score Weights

### 배경
Query difficulty는 cascade routing (easy→sparse only, hard→full pipeline)의 입력 신호로, latency vs recall tradeoff를 결정한다. Estimator는 토큰 수, anchor confidence, negation 유무, 다국어 혼합 등을 가중합하여 0-1 difficulty score를 산출한다.

### 해결하고자 하는 것
Score weight 분배를 데이터 기반으로 calibrate. 현재 5개 signal의 weight가 arbitrary round number.

### 현재 상황
- **파일**: `src/domain/retrieval/service/query-difficulty-estimator.ts`
- **상수 위치**:
  - L43: `EASY_ANCHOR_CONFIDENCE = 0.9` — resolver confidence 분포 기반 (**justified**)
  - L46: `EASY_TOKEN_COUNT_MAX = 2` — domain knowledge (**justified**)
  - L52: `HARD_TOKEN_COUNT_MIN = 6` — **unjustified**, 5/7/8 대비 근거 없음
  - L68-72: score weights `[0.3, 0.3, 0.15, 0.1, 0.15]` — 합계 1.0이지만 **unjustified**, 어떤 signal이 difficulty에 더 correlate하는지 sweep 데이터 없음
  - L75: `TOKEN_COUNT_SATURATION = 10` — **unjustified**, clamping point
- **필요 작업**: query log + golden set으로 signal-difficulty correlation 측정 → weight fitting
- **차단 요소**: query log 수집 (Epic-18 feedback event ingestion)

---

## 3. Dynamic Top-K Selector — Tier Widths

### 배경
Retrieval channel별 candidate 개수(top-K)를 query difficulty와 latency budget에 따라 동적 조정한다. K가 크면 recall 높지만 latency 증가, K가 작으면 반대.

### 해결하고자 하는 것
Difficulty tier별 + budget tier별 optimal K를 P95 latency 프로파일링 기반으로 calibrate.

### 현재 상황
- **파일**: `src/domain/retrieval/service/dynamic-top-k-selector.ts`
- **상수 위치**:
  - L36-38: Easy tier `[50, 20, 10]` (sparse, dense, anchor)
  - L41-43: Medium tier `[200, 100, 50]`
  - L47-49: Hard tier `[500, 300, 100]`
  - L55-57: Absolute caps `[1000, 600, 200]`
  - 모두 **placeholder** — "deterministic priors...will be replaced when latency profiling data exists" 주석 기재
- **필요 작업**: production latency P95 프로파일링 (Vespa query ms per K per channel)
- **차단 요소**: production 트래픽 또는 load test harness

---

## 4. Hedge Retrieval Policy — Confidence Thresholds

### 배경
Multi-intent query (예: "보르도 레드 vs 부르고뉴 피노 누아르")에서 단일 intent만 실행하면 recall이 절반으로 떨어진다. Hedge retrieval은 두 intent를 동시 실행하여 이를 방지한다. Confidence threshold가 hedge 발동 여부를 결정.

### 해결하고자 하는 것
False hedge (불필요한 2배 retrieval cost) vs missed hedge (recall 손실) 최적 지점을 click-through 데이터로 찾는다.

### 현재 상황
- **파일**: `src/domain/query/service/hedge-retrieval-policy.ts`
- **상수 위치**:
  - L28: `HEDGE_HIGH_CONFIDENCE = 0.85` — **placeholder**, "initial guess; will be tuned with click-through data" 주석
  - L35: `HEDGE_LOW_CONFIDENCE = 0.6` — **placeholder**, 동일 주석
  - L42: `HEDGE_TIE_WINDOW = 0.1` — **placeholder**, 동일 주석
- **필요 작업**: A/B test with click-through 비교 (hedge on vs off per confidence band)
- **차단 요소**: Epic-18 click event ingestion + Epic-15 learned intent classifier

---

## 5. Position-Debiased Relevance — Examination Propensities

### 배경
사용자가 검색 결과를 볼 확률은 position에 따라 급감한다 (position 0 = 100%, position 4 = ~20%). IPS (Inverse Propensity Scoring) 가중치로 click signal을 교정해야 LTR 학습 데이터가 position bias에 오염되지 않는다. (Joachims et al. 2017 "Unbiased Learning-to-Rank with Biased Feedback")

### 해결하고자 하는 것
실제 사용자 examination 확률 분포를 click log에서 fitting. 현재는 round-number placeholder.

### 현재 상황
- **파일**: `src/domain/feedback/service/position-debias.ts`
- **상수 위치**:
  - L18: `POSITION_PROPENSITIES = [1.0, 0.6, 0.4, 0.3, 0.2]` — **placeholder**, "placeholder until click logs allow fitting" 주석
  - L21: `TAIL_PROPENSITY_BASE = 0.1` — position 5+ decay base
  - L23: `MIN_PROPENSITY = 0.01` — IPS division zero-guard
- **필요 작업**: EM (Expectation-Maximization) 기반 examination model fitting (Wang et al. 2018 "Position Bias Estimation for Unbiased Learning to Rank in Personal Search")
- **차단 요소**: Epic-18 click event 수집 (최소 10K impressions per position)

---

## 6. Auto-Rollback Decision — Quality Thresholds

### 배경
모델 배포 후 온라인 품질 모니터가 CTR drop이나 zero-result spike를 감지하면 자동 롤백한다. Threshold가 너무 민감하면 false alarm, 너무 둔감하면 품질 사고 미탐지.

### 해결하고자 하는 것
Production baseline CTR/zero-result 분포에서 적정 threshold를 설정.

### 현재 상황
- **파일**: `src/domain/feedback/service/auto-rollback-decision.ts`
- **상수 위치**:
  - L17: `DEFAULT_CTR_DROP_PCT = 0.10` (10% relative drop) — **unjustified**, 업계 기준 미기재
  - L19: `DEFAULT_ZERO_RESULT_RISE_ABS = 0.05` (5pp absolute rise) — **unjustified**
  - L21: `DEFAULT_MIN_SAMPLES = 1000` — **unjustified**, 통계적 유의성 근거 없음 (Z-test 기반이면 ~385 필요, Bayesian이면 다름)
- **필요 작업**: production baseline 측정 → 신뢰구간 기반 threshold 도출
- **차단 요소**: production 트래픽 축적

---

## 7. Intent Authority Handoff — Learned Model Margin

### 배경
Rule-based intent classifier (high-precision prior)와 future learned classifier (higher recall)가 의견 불일치 시, 어느 쪽을 따를지 결정하는 margin. Margin보다 큰 confidence 차이가 나면 더 자신 있는 쪽을 따름.

### 해결하고자 하는 것
Margin을 intent classification 정확도 데이터로 calibrate. 현재 0.15는 arbitrary round number.

### 현재 상황
- **파일**: `src/domain/query/service/intent-authority.ts`
- **상수 위치**:
  - L39: `LEARNED_AUTHORITY_MARGIN = 0.15` — **unjustified**, "why 0.15 and not 0.10 or 0.20?" 리뷰 지적
- **필요 작업**: rule vs learned classifier 정확도 비교 → optimal margin sweep
- **차단 요소**: learned intent classifier 학습 (Epic-15 Phase C)

---

## 8. Silent Skip Counters — Metrics Endpoint 미노출

### 배경
Pipeline에서 embedding dimension mismatch, empty vector, cache write failure 등이 `continue` / early return으로 처리되면서 관측 사각지대가 발생. Silent skip counter 모듈이 이를 카운팅하지만, /metrics 엔드포인트에 노출되지 않아 운영자가 볼 수 없음.

### 해결하고자 하는 것
`globalSilentSkipCounter.snapshot()`를 /metrics/degradation 또는 별도 endpoint에 노출.

### 현재 상황
- **파일**: `src/observability/silent-skip-counters.ts`
- **상수 위치**:
  - L99: `globalSilentSkipCounter` — module-scope singleton
- **increment() 호출 사이트** (4곳):
  - `src/domain/retrieval/service/semantic-embedding-combiner.ts:12,34,60` — `embedding_dim_mismatch`, `embedding_empty_vector`
  - `src/domain/retrieval/service/candidate-pool.ts:281` — `embedding_empty_vector`
  - `src/domain/retrieval/model/retrieval-channel.ts:108` — `unknown_channel_fallback`
- **snapshot() 호출 사이트**: **0곳** (production에서 호출 없음)
- **필요 작업**: `globalCircuitBreakerRegistry.snapshot()` 와 함께 /metrics/degradation endpoint에 노출
- **차단 요소**: 없음 (즉시 가능 — health.route.ts에 endpoint 추가)

---

## 9. Wine KG Seed Loader — Missing File Startup Crash

### 배경
`data/entity-ontology.json` (140 entities, 101 edges)에서 Wine KG를 로드하는 loader가 파일 없으면 ENOENT 에러로 application이 크래시한다. Empty KG로 graceful degradation하는 경로가 없음.

### 해결하고자 하는 것
파일 누락 시 빈 KG로 fallback + startup warning. KG가 없으면 compositional inference와 entity expansion이 비활성화되지만, core search는 동작해야 한다.

### 현재 상황
- **파일**: `src/domain/knowledge-graph/loader/load-seed-kg.ts`
- **크래시 위치**: L137 — `readFile(filePath, 'utf8')` 가 ENOENT throw
- **Production 호출**: **0곳** — 현재 test-only foundation code. Production wiring 시 반드시 try/catch + empty KG fallback 필요.
- **필요 작업**:
  1. `loadSeedKG`에 `{ allowEmpty: true }` 옵션 추가
  2. ENOENT catch → `bootstrapLogger.warn` + empty KG 반환
  3. container.ts에서 wiring 시 이 옵션 사용
- **차단 요소**: 없음 (즉시 가능)

---

## 10. Circuit Breaker OPEN — No LLM Failover Strategy

### 배경
LLM adapter (Anthropic/OpenAI)에 circuit breaker가 장착되어 5회 연속 5xx 시 60초간 OPEN. OPEN 상태에서는 `CircuitBreakerOpenError`가 throw되고, 호출자(agent orchestrator, search usecase)는 이를 generic error로 처리하여 사용자에게 "service unavailable" 반환.

### 해결하고자 하는 것
OPEN 시 대안 전략:
1. **Provider failover**: Anthropic OPEN → OpenAI로 전환 (또는 역방향)
2. **Graceful degradation**: LLM 없이 retrieval-only 결과 반환 (agent mode 비활성, search mode 유지)
3. **Cached response**: 동일 query의 이전 응답이 cache에 있으면 그것 반환

### 현재 상황
- **파일**: `src/infrastructure/ai/llm-circuit-breaker-classifier.ts`
- **OPEN throw 위치**: L136 — `throw new CircuitBreakerOpenError(breakerName)`
- **호출자 catch 현황**:
  - `src/application/agent/agent-orchestrator.ts` — generic error catch → "service unavailable" 반환
  - `src/application/search/search.usecase.ts` — generic error catch → 500 에러
  - **CircuitBreakerOpenError를 명시적으로 catch하는 코드**: 0곳
- **필요 작업**:
  1. Container에 primary/secondary LLM adapter 등록
  2. 호출자에서 `CircuitBreakerOpenError` catch → secondary adapter로 retry
  3. Secondary도 OPEN이면 → retrieval-only degraded response
- **차단 요소**: secondary LLM adapter 설정 (env.ts에 fallback API key 추가)

---

## 우선순위 밴드

| 밴드 | 항목 | 이유 |
|------|------|------|
| **즉시 가능** | #8 (metrics 노출), #9 (KG loader fallback) | 차단 요소 없음, 코드만 추가 |
| **데이터 수집 후** | #1 (fusion sweep), #2 (difficulty weights), #3 (top-K), #5 (propensities), #6 (rollback thresholds) | golden set / click log / latency profiling 필요 |
| **모델 학습 후** | #4 (hedge thresholds), #7 (authority margin) | learned intent classifier 의존 |
| **인프라 설계** | #10 (LLM failover) | secondary provider 계약 + env 설정 |

---

*Generated from Phase 1-3 critical review rounds R1-R8 on 2026-04-10.*
