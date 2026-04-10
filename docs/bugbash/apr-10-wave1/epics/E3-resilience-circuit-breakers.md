# E3 — Resilience & Circuit Breakers

**목표**: 외부 서비스(Vespa, Redis, Embedding, Reranker) 중 하나가 죽어도 검색이 degraded mode로 계속 동작하도록 보장한다.
**영향**: 현재 Vespa/embedding/reranker 장애 시 timeout cascade → 전체 검색 다운. circuit breaker 없이 30초 대기 × N 동시 요청.
**SOTA++ 방향**: 모든 외부 호출에 circuit breaker 대칭 적용 + AbortSignal propagation + request_id tracing.

---

## 버그 목록

| ID | 심각도 | 제목 | 파일 |
|----|--------|------|------|
| BUG-03 | 🟠 P1 | `HttpCrossEncoderReranker` circuit breaker 없음 | `reranker.ts` |
| BUG-04 | 🟠 P1 | anchor 임베딩 캐시 bypass + circuit breaker bypass | `candidate-pool.ts:444` |
| W2-BUG-02 | 🟠 P1 | Vespa 클라이언트 circuit breaker 없음 | `vespa-client.ts` |
| W2-BUG-03 | 🟠 P1 | Redis circuit breaker 없음 + silent skip counter 미사용 | `redis-client.ts` |
| W2-BUG-04 | 🟠 P1 | AbortSignal이 Vespa fetch까지 전달 안 됨 | `search-index.port.ts`, `candidate-pool.ts` |
| W2-BUG-05 | 🟠 P1 | request_id downstream 서비스로 전파 안 됨 | `vespa-client.ts`, `embedding-service.ts` |
| RCA5-09 | 🟠 P1 | Embedding circuit breaker 누락 | `embedding-service.ts` |
| RCA5-10 | 🟠 P1 | Container 어댑터 config 미전달 | `container-adapters.ts` |
| SCAN4-08 | 🟠 P1 | 채널별 검색 timeout 미설정 — dense/sparse/rerank 모두 global default 공유 | `candidate-pool.ts`, `vespa-client.ts` |
| SCAN4-02 | 🔴 P0 | OpenAI 임베딩 circuit breaker 미등록 — timeout만 있고 CB 없음, Cohere와 비대칭 | `openai-embedding-service.ts` |
| SCAN4-03 | 🔴 P0 | Vespa 검색 circuit breaker 미등록 — retry 3회만, 장애 시 부하 3배 | `vespa-search-index.ts`, `vespa-client.ts` |
| SCAN4-07 | 🟠 P1 | Vespa 클라이언트 외부 AbortSignal 미전파 — `query()` externalSignal 파라미터 없음 (W2-BUG-04와 연계) | `vespa-client.ts` |
| RCA-03 | 🟠 P1 | 17% 요청 실패 — Vespa 미연결 + embedding URL 없음 + OPENAI_API_KEY 없음 복합 | 설정/환경 |
| RCA-07 | 🟡 P2 | Drinking window ONNX 모델 없음 → readiness `drinking_window_model: down` (heuristic은 동작 중) | `readiness.ts` |

---

## RCA 요약

### BUG-03: HttpCrossEncoderReranker — self-hosted 환경 cascade

**사용 조건**: `COHERE_API_KEY` 없음 + `RERANKER_SERVICE_URL` 설정. Cohere 환경은 해당 없음.

**cascade**:
```
cross-encoder endpoint down
→ fetchWithTimeout() 30초 대기 (DEFAULT_RERANKER_HTTP_TIMEOUT_MS)
→ ranker.ts:658 catch → fallback to viable candidates (결과는 나옴)
→ BUT 매 요청마다 30초 × N 동시 요청 → connection pool 고갈
→ /metrics/degradation에 상태 미노출 → 운영자 blind
```
CohereReranker는 failureThreshold=5, recoveryTimeout=60s CB 존재. 비대칭.

### BUG-04: anchor embedding — 65-75% cache hit rate 손실

dense 경로 (`candidate-pool.ts:366-372`): `cacheService.getOrEmbedBatch()` → Redis + CB.
anchor 경로 (`candidate-pool.ts:444-445`): `embeddingService.embed()` 직접 → Redis 없음, CB 없음.
similar_items/recommendation 모드에서 동일 anchor 반복 → 추정 65-75% hit rate 손실.
embedding 서비스 장애 시 anchor 경로는 exception 전파 (dense는 graceful degrade).

### SCAN4-02: OpenAI 임베딩 CB 미등록

`openai-embedding-service.ts`: timeout 있으나 CB 없음.
`cohere-reranker.ts:75-84`는 `failureThreshold=5, recoveryTimeout=60s` CB 보유 → 비대칭.
RCA5-09와 동일한 근본 원인 (이미 E3에 포함) — SCAN4-02는 파일 단위 추가 확인.
`globalCircuitBreakerRegistry`에 미등록 → `/metrics/degradation` 에서 상태 노출 안 됨.

### SCAN4-03: Vespa CB 미등록

`vespa-search-index.ts` + `vespa-client.ts`: retry 3회 + exponential backoff만 존재.
CB 없음 → Vespa 완전 장애 시 retry 소진에 수십 초 소요, 그 사이 신규 요청도 동일하게 대기.
W2-BUG-02와 동일 근본 원인 — SCAN4-03은 `vespa-search-index.ts` 레벨 추가 확인.

### SCAN4-07: Vespa AbortSignal 미전파 (vespa-client.ts 레벨)

`vespa-client.ts`의 `query()` 메서드 시그니처에 `signal?: AbortSignal` 없음.
W2-BUG-04 (candidate-pool → vespa-client 전달 누락)와 연계.
수정 순서: `vespa-client.query(signal)` → `fetch(url, { signal })` → `candidate-pool` 전달.

### SCAN4-08: 채널별 timeout 미설정

`candidate-pool.ts`의 dense embedding, sparse Vespa, reranker 세 채널이 모두 동일한 global timeout 사용.
Vespa: 낮은 latency 기대 → tight timeout 적합.
Embedding service: 모델 로딩 포함 → 여유 timeout 필요.
Reranker: GPU 의존 → 별도 timeout.
단일 timeout이 모든 채널에 적용되면 Vespa는 너무 길게, embedding은 너무 짧게 설정됨.
CB failureThreshold 설정 시에도 채널별 timeout 기준이 달라야 올바른 open 판단 가능.

### W2-BUG-02: Vespa — timeout만 있고 CB 없음

Vespa 클라이언트: retry + exponential backoff 있음. circuit breaker 없음.
Vespa 장애 시 retry 소진 후 exception → 검색 전체 fail. CB 있으면 빠른 실패 후 degraded mode.

---

## 구현 계획

### Phase 1 — 비대칭 CB 추가 (P1, 패턴 복사)

**E3-P1-1**: `HttpCrossEncoderReranker` circuit breaker
`CohereReranker` 패턴 그대로 복사:
```typescript
const HTTP_RERANKER_BREAKER_NAME = 'http-cross-encoder-rerank';
this.circuitBreaker = createCircuitBreaker({
  name: HTTP_RERANKER_BREAKER_NAME,
  failureThreshold: 5,
  recoveryTimeoutMs: 60_000,
  halfOpenMaxAttempts: 3,
});
globalCircuitBreakerRegistry.register(HTTP_RERANKER_BREAKER_NAME, this.circuitBreaker);
```
`reranker.ts` constructor 수정. `rerank()` 메서드를 `runUnderBreaker()` 래핑.

**E3-P1-2**: anchor embedding → `getOrEmbedBatch()` 래핑
```typescript
// candidate-pool.ts:444-445 교체
const anchorResults = await this.cacheService.getOrEmbedBatch(
  [anchorProfile.semanticSummary],
  this.embeddingModelId,
  this.embeddingService,
);
const anchorEmbedding = anchorProfile.embedding ?? anchorResults[0];
if (!anchorEmbedding) throw new Error('anchor embedding failed — circuit open or cache miss');
```

### Phase 2 — Vespa + Redis CB (P1)

**E3-P1-3**: OpenAI embedding CB 등록 (SCAN4-02 = RCA5-09 보완)
```typescript
// openai-embedding-service.ts constructor
const OPENAI_EMBEDDING_BREAKER_NAME = 'openai-embedding';
this.circuitBreaker = createCircuitBreaker({
  name: OPENAI_EMBEDDING_BREAKER_NAME,
  failureThreshold: 3,
  recoveryTimeoutMs: 30_000,
});
globalCircuitBreakerRegistry.register(OPENAI_EMBEDDING_BREAKER_NAME, this.circuitBreaker);
```

**E3-P2-1**: Vespa 클라이언트 circuit breaker
`vespa-client.ts`에 CB 추가. 기존 retry/backoff와 함께 동작:
- retry: 일시적 오류 대응
- CB: 지속적 오류 시 빠른 실패

failureThreshold, recoveryTimeout은 Vespa SLA 기반으로 설정 (추천: threshold=3, recovery=30s — Vespa가 LLM보다 빠르게 회복).

**E3-P2-2**: Redis circuit breaker + silent skip counter 실제 연결
`redis-client.ts`에 CB 추가.
`silent-skip-counters.ts` (SSoT) 의 counter를 실제 Redis 실패 경로에서 호출.

### Phase 3 — Signal propagation (P1)

**E3-P2-4**: RCA-03 환경 pre-flight 검증 추가
startup 시 Vespa/embedding/reranker URL 존재 여부 + 연결 가능 여부 명시적 체크.
```typescript
// config/bootstrap-logger.ts 또는 readiness.ts
if (!config.vespa.url) throw new Error('VESPA_URL required');
if (!config.embedding.url) log.warn('EMBEDDING_URL not set — embedding degraded');
```
17% baseline failure(RCA-03)는 CB가 아닌 **설정 누락**이 원인 → readiness probe `required` 조건 강화.

**E3-P3-1**: AbortSignal → Vespa fetch까지 전달 ⚠️ SCAN4-07 (vespa-client signature) 완료 후 진행
`SearchIndexPort.search()` 시그니처에 `signal?: AbortSignal` 추가.
`candidate-pool.ts` → `vespa-client.ts` → `fetch(url, { signal })` 체인.
**선행 조건**: SCAN4-07 fix (`vespa-client.query(signal)` 시그니처 추가) 완료 필수.
유저 요청 취소/timeout 시 Vespa HTTP 연결도 즉시 abort.

**E3-P2-3**: 채널별 timeout 분리 (SCAN4-08)
```typescript
// 권장 값 (SLA 기반 — eval 데이터로 tuning 필요)
const VESPA_SEARCH_TIMEOUT_MS = 3_000;
const EMBEDDING_TIMEOUT_MS = 8_000;
const RERANKER_TIMEOUT_MS = 10_000;
```
각 채널 call site에서 개별 timeout 사용. CB failureThreshold도 채널별로 조정.

**E3-P3-2**: request_id downstream 전파
`vespa-client.ts`, `embedding-service.ts`, `reranker.ts` HTTP 헤더에 `X-Request-ID: {requestId}` 추가.
distributed tracing 기반 확보. Vespa access log와 연결 가능.

---

## 완료 기준 (Definition of Done)

- [ ] `HttpCrossEncoderReranker` CB → `/metrics/degradation`에 `http-cross-encoder-rerank` 상태 노출
- [ ] anchor 임베딩 경로에서 Redis cache hit 확인 (캐시 히트 시 embedding API 호출 없음)
- [ ] Vespa CB 등록 → 연속 실패 후 빠른 실패(fast-fail) 동작 확인
- [ ] Redis CB 등록 → silent-skip counter 실제 증가 확인
- [ ] AbortSignal 전파 → 요청 취소 시 Vespa fetch 즉시 중단 확인
- [ ] OpenAI embedding CB 등록 → `/metrics/degradation`에 `openai-embedding` 상태 노출
- [ ] Vespa CB — `vespa-search-index.ts` 레벨 등록 확인
- [ ] `vespa-client.query()` 시그니처에 `signal?: AbortSignal` 추가 확인
- [ ] 채널별 timeout 분리 — Vespa/embedding/reranker 각각 다른 timeout 사용 확인
- [ ] RCA-03: VESPA_URL 없으면 startup 실패 / embedding URL 없으면 `warn` + degraded 모드
- [ ] RCA-07: drinking_window_model readiness — heuristic 동작 중이면 `degraded` (not `down`)
- [ ] Vespa down 시 sparse-only 또는 캐시 응답 fallback 경로 존재 확인
- [ ] request_id Vespa 로그에서 추적 가능
- [ ] Vespa down 시 검색이 30초 대기 없이 degraded 응답 반환 (CB open 후 <100ms)
