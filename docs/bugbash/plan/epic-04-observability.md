# Epic 04 — 관측성 → 학습 데이터 수집 기반

**Phase:** A (기반 정리)
**우선순위:** P1
**의존:** Epic-01 (채널 모듈 통합)
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `학습 불필요`

---

## 왜 — SOTA++ 구조적 의미

관측성은 단순 디버깅이 아니다. **SOTA 시스템의 학습 루프 기반**이다.
- Feature 값 분포를 모르면 normalization 불가 → LTR 학습 불가
- Degradation rate을 모르면 circuit breaker threshold 설정 불가
- Click-through 수집이 없으면 feedback loop 불가
- Component별 latency를 모르면 cascade routing 최적화 불가

**업계 SOTA:**
- Google: 전 signal의 distribution histogram 실시간 모니터링
- Netflix: Feature distribution drift detection → 자동 모델 재학습
- LinkedIn: Per-stage latency budget 추적 → adaptive cascade depth

---

## Task 목록

### T04-1. `console.*` → pino 전환

3곳: retrieval-channel.ts, eval-runner.ts, gen-ai-tracing.ts.
**SOTA 의미:** 상관 ID 없는 로그는 distributed tracing에서 무용.

### T04-2. 무음 스킵 → Metric 표면화

**경계:** degradation policy / circuit breaker / ranking-aware handling은 `Epic-12`의 책임이다.
이 task는 **관측성 표면화**만 담당한다.

| 위치 | metric name |
|------|-------------|
| `combineSemanticEmbeddings` 차원 불일치 | `embedding_dim_mismatch_total` |
| `getOrEmbedBatch` 빈 벡터 | `embedding_empty_vector_total` |
| Redis cache `set` 실패 | `cache_write_failure_total` |
| `toRetrievalChannel` 미인지 채널 | `unknown_channel_fallback_total` |

### T04-3. Feature Distribution Logging

**신규.** SOTA 시스템에서 필수.

**변경:**
- 각 ranking signal의 (min, max, mean, p50, p95) per query batch
- `/metrics/feature-distribution` 엔드포인트
- Feature drift detection: 이전 24h 대비 분포 변화 > 2 sigma → alert
- **이유:** LTR 모델이 학습 시점과 다른 분포의 feature를 받으면 성능 저하

### T04-4. Per-Stage Latency Tracking

**변경:**
- `sparse_search_ms`, `dense_search_ms`, `embedding_ms`, `rerank_ms`, `ltr_ms`, `decision_ms`
- `/metrics/pipeline-latency` 엔드포인트
- **이유:** Epic-16 (Adaptive Cascade)에서 latency budget 기반 routing에 필수

### T04-5. Trace Vocab 완전성

`validateTraceVocab` 확장: `channelScores`, `queryViewMatches` label 검증.

### T04-6. Raw Error 로깅 pino serializer 경유

`server.ts:409` raw error → pino serializer 경유.

---

## 완료 조건

- `console.*` in src/ → 0건
- Feature distribution endpoint 동작
- Per-stage latency tracking 동작
- 모든 무음 스킵에 metric counter
