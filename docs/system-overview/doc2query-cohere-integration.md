# Doc2Query + Cohere Rerank 통합 (결정 / 아키텍처 / 운영)

> **Audience:** retrieval 품질 / 인프라 결정 리뷰어. 인덱싱 단계 흐름은 [`ingestion-pipeline.md`](./ingestion-pipeline.md), 런타임 리트리버 흐름은 [`retriever-pipeline.md`](./retriever-pipeline.md).

**한 줄:** 1차 retrieval recall은 **Doc2Query (index-time, OpenAI gpt-5.x)** 가 합성 쿼리를 BM25 인덱스에 깔아서 책임지고, ranking precision은 **Cohere Rerank API (CircuitBreaker 보호)** 가 top-K 재정렬로 책임진다. SPLADE / ColBERT 스캐폴딩은 트리에 남아 있지만 composition root에서 import 0 — dormant.

**Last updated:** 2026-04-11

---

## 목차

1. [결정 요약](#1-결정-요약)
2. [왜 이 조합인가 (다른 옵션은 왜 dropped)](#2-왜-이-조합인가-다른-옵션은-왜-dropped)
3. [아키텍처](#3-아키텍처)
4. [관련 파일](#4-관련-파일)
5. [환경 변수 / DI 동작](#5-환경-변수--di-동작)
6. [Vespa 스키마 변경](#6-vespa-스키마-변경)
7. [멱등성 / 백필 / 재생성](#7-멱등성--백필--재생성)
8. [관측성 / 운영 스위치](#8-관측성--운영-스위치)
9. [범위 밖 (의도적 dormant)](#9-범위-밖-의도적-dormant)
10. [관련 RFC / 메모리](#10-관련-rfc--메모리)

---

## 1. 결정 요약

| 항목 | 채택 | 폐기 / 보류 |
|---|---|---|
| Recall 천장 | **Doc2Query** (index-time LLM expansion) | SPLADE (query-time encoder), Doc2Query × SPLADE 동시 |
| Precision 천장 | **Cohere Rerank API** (managed) | ColBERT (self-host late-interaction), 자체 호스트 cross-encoder만 |
| Reranker fallback | 자체 호스트 `HttpCrossEncoderReranker` (`RERANKER_SERVICE_URL`) | — |
| Doc2Query 모델 | **OpenAI `OPENAI_DOC2QUERY_MODEL`** (런타임 chat과 분리, default `gpt-5.x`) | T5 doc2query-msmarco (영어 한정, 한국어 와인 도메인 부적합) |
| 한국어 전략 | 단일 LLM이 영/한 혼합 출력 (7개 중 2개 한국어) | `synthetic_queries_ko` 별도 필드 |

---

## 2. 왜 이 조합인가 (다른 옵션은 왜 dropped)

### Doc2Query vs SPLADE
- **Doc2Query는 index-time 전용**. LLM이 와인 문서당 합성 쿼리 N개를 만들고, BM25 array<string> 필드에 들어간다. 런타임 query path에는 어떤 추가 비용도 없다.
- **SPLADE는 query-time encoder가 필수** — 매 요청마다 sparse-vector encoding 30~80ms 추가. 또한 Vespa `learned_sparse` rank-profile이 현재 주석 처리되어 있다 (필드 `learned_sparse_weights tensor<float>(token{})`가 `dotProduct` rank feature와 호환되지 않음 — `weightedset`으로 마이그레이션 필요). 마이그레이션 작업이 차단 요소.
- **두 가지를 동시에**? 둘 다 paraphrase / 표현 불일치 recall을 잡으므로 신호가 강하게 겹친다 (diminishing returns), 그러면서 인프라 비용은 곱으로 늘어난다.

### Cohere vs ColBERT vs 자체 cross-encoder
- 기존 인프라: `RerankerPort` 와 `HttpCrossEncoderReranker` 가 이미 wired. 신규 어댑터를 같은 포트로 swap-in 하면 DI 1줄로 끝.
- ColBERT는 token-level embedding을 Vespa에 인덱싱해야 하고 (스키마/serving 부담), 와인 도메인에 fine-tune까지 가야 의미 있는 게인. 자체 호스트 비용 우위가 운영 부담을 상쇄하지 못한다.
- Cohere `rerank-v4.0-pro`는 다국어 (KO/EN 혼합) 와인 쿼리에 학습된 generic cross-encoder로 1차 후보 풀의 상위 20개에 대해 충분한 precision을 준다. CircuitBreaker로 OpenAI/Anthropic chat과 동등한 failure budget 공유.

### 모델 분리 (OPENAI_DOC2QUERY_MODEL ≠ OPENAI_CHAT_MODEL)
- ETL은 한 번에 ~7,000 와인 × 7 쿼리 = ~49,000 호출. 런타임 chat과 같은 모델을 강제하면 비용/품질 trade-off를 따로 못 잡는다.
- `OpenAiChatLlm` 어댑터는 그대로 (런타임 chat path에 영향 0). Doc2Query 호출 시 per-call `request.model` override만 다른 모델로 라우팅.

---

## 3. 아키텍처

### 인덱싱 (index-time, 한 번 실행)

```
EnrichedSilverRecord  (silver-enriched-ko.ndjson)
    │
    ▼
generate-doc-queries.ts (CLI)
    │  ├─ loadConfig() → OpenAiChatLlm
    │  ├─ OpenAiDoc2QueryGenerator(chatLlm, model: doc2queryModel)
    │  └─ contentHash + modelId fingerprint → idempotent skip
    ▼
EnrichedSilverRecord {
  ...prior fields,
  syntheticQueries: ["napa cabernet", "리베라 델 두에로 ...", ...],
  doc2queryFingerprint: { modelId, contentHash, generatedAt }
}
    │
    ▼
silver-docquery.ndjson
    │
    ▼  (Track C 단계 — critic / certifications / pairings / drinking-window)
    ▼
index-to-vespa.ts
    │  silverToIndexable → silverToRetrievalDoc → toVespaFields
    │  syntheticQueries (typed) → "synthetic_queries" (Vespa array<string>)
    ▼
Vespa wine_entity
    └── synthetic_queries field, indexed with BM25
```

### 런타임 (HTTP /v1/search 또는 /v1/agent의 search_wines 도구)

```
HTTP request
    │
    ▼
SearchUseCase.execute()
    │
    ├─ Pre-Route Phase (SecurityGate, QueryPlanner, ConstraintSAT, CacheLookup)
    │
    └─ Hybrid 경로
         │
         ├─ CandidatePoolService.execute()  (legacy generate() alias still delegates here)
         │     └─ sparse_bm25 channel → SearchIndexPort.sparseSearch()
         │           └─ Vespa rank profile = bm25_wine
         │              └─ + bm25(synthetic_queries) * 0.6  ← AUTOMATIC
         │
         └─ Ranker.rank()
               ├─ (선택) RerankerPort.rerank(query, top-K, limit)
               │     └─ CohereReranker
               │           └─ runUnderLlmBreaker(circuitBreaker, ...)
               │                 └─ POST api.cohere.ai/v2/rerank
               └─ (선택) learned LTR rerank
```

핵심: **Doc2Query는 인덱스에만 영향**이고, **Cohere는 `Ranker.rank()` 내부 precision stage의 cross-encoder adapter만 교체**한다. learned LTR이 로드되어 있으면 같은 `Ranker.rank()` 호출 안에서 추가 rerank가 이어질 수 있다.

---

## 4. 관련 파일

### Doc2Query
| 파일 | 역할 |
|---|---|
| `scripts/etl/generate-doc-queries.ts` | CLI 진입점 — fingerprint, idempotency, atomic write |
| `src/infrastructure/ai/openai-doc2query-generator.ts` | `Doc2QueryGeneratorPort` 구현, 시스템 프롬프트, JSON 추출, 길이 정규화 |
| `src/domain/retrieval/port/doc2query-generator.port.ts` | 포트 계약 |
| `src/infrastructure/adapter/stub-doc2query-generator.ts` | dev/test fallback (deterministic 4-token windowing) |
| `src/config/container-adapters.ts` `doc2queryGenerator` | DI 선택: chatLlm 있으면 OpenAI, 없으면 Stub |
| `scripts/etl/types.ts` `Doc2QueryFingerprint`, `EnrichedSilverRecord.syntheticQueries` | ETL typed schema |
| `scripts/etl/index-to-vespa.ts` `silverToIndexable` / `silverToRetrievalDoc` | typed field 통과 |
| `src/infrastructure/vespa/mapping.ts` `toVespaFields` / `fromVespaFields` | 도메인 ↔ Vespa 매핑 |
| `src/domain/retrieval/model/retrieval-document.ts` `syntheticQueries?: readonly string[]` | 도메인 모델 필드 |
| `vespa/app/schemas/wine_entity.sd` `field synthetic_queries`, `bm25_wine()` | Vespa 스키마 + rank profile |

### Cohere Rerank
| 파일 | 역할 |
|---|---|
| `src/infrastructure/ai/cohere-reranker.ts` | `RerankerPort` 구현, CircuitBreaker 등록, `runUnderLlmBreaker` 래핑 |
| `src/infrastructure/ai/llm-circuit-breaker-classifier.ts` | service-failure / caller-fault / abort 분류 (4xx 비-429는 caller-fault → CB 트립 안 함) |
| `src/observability/circuit-breaker-registry.ts` | `cohere-rerank` 이름 등록 → `/health` 노출 |
| `src/config/env-schemas/retrieval.schema.ts` | `COHERE_API_KEY`, `COHERE_RERANK_MODEL`, `COHERE_BASE_URL` |
| `src/config/container-adapters.ts` (L162-173) | DI 선택: cohere primary, self-host fallback |
| `src/domain/ranking/port/reranker.port.ts` | 포트 계약 (CohereReranker / HttpCrossEncoderReranker 공유) |

---

## 5. 환경 변수 / DI 동작

| Env | 기본값 | 효과 |
|---|---|---|
| `OPENAI_API_KEY` | (unset) | unset이면 Doc2Query 어댑터가 `StubDoc2QueryGenerator`로 fallback (dev/test boot 보장). production은 set 필수. |
| `OPENAI_CHAT_MODEL` | `gpt-5.4-mini` | 런타임 chat 어댑터 default. **Doc2Query에는 영향 없음.** |
| `OPENAI_DOC2QUERY_MODEL` | `gpt-5.3-mini` | Doc2Query 어댑터가 per-call override로 사용. 모델 변경 시 fingerprint mismatch → 다음 ETL 실행 시 자동 재생성. |
| `COHERE_API_KEY` | (unset) | set이면 `CohereReranker` primary. unset이면 self-host fallback. |
| `COHERE_RERANK_MODEL` | `rerank-v4.0-pro` | Cohere 호출 모델 |
| `COHERE_BASE_URL` | `https://api.cohere.ai/v2` | Cohere 엔드포인트 |
| `RERANKER_SERVICE_URL` | (unset) | 자체 호스트 fallback URL |
| `RERANK_BLEND_SCALE` | (default in env.ts) | reranker 점수와 1차 fusion 점수 블렌드 비율. 0.0 → reranker 무력화 (shadow run) |

DI 분기 (`container-adapters.ts:162-173`):

```
if config.cohere.apiKey != null:
  reranker = CohereReranker(...)
elif config.reranker.url != null:
  reranker = HttpCrossEncoderReranker()
else:
  reranker = undefined  → Ranker가 cross-encoder rerank를 skip
```

주의:

- 이 DI는 **cross-encoder adapter 선택**만 담당한다.
- learned LTR 모델 주입은 `container-runtime-support.ts`에서 registry 로드 후 `buildRanker(..., support?.ltrModels)`로 별도 처리된다.
- 따라서 `COHERE_API_KEY`가 없어도, LTR model이 있으면 `Ranker.rank()` 내부 learned rerank는 계속 동작할 수 있다.

---

## 6. Vespa 스키마 변경

`vespa/app/schemas/wine_entity.sd`

**신규 필드** (document `wine_entity` 안):
```
field synthetic_queries type array<string> {
  indexing: summary | index
  index: enable-bm25
}
```

**fieldset default**: `synthetic_queries` 추가됨.

**rank profile `lexical` → `bm25_wine()`** (모든 다른 profile이 상속):
```
function bm25_wine() {
  expression {
    bm25(canonical_label) * 4
    + bm25(aliases_identity_safe) * 3
    + bm25(aliases_noisy_recall) * 2
    + bm25(flavor_profiles) * 1.8
    + bm25(producer) * 1.5
    + bm25(appellation) * 1.5
    + bm25(classification) * 1.3
    + bm25(grape_primary) * 1.2
    + bm25(search_text_en)
    + bm25(search_text_ko)
    + bm25(synthetic_queries) * 0.6
  }
}
```

가중치 0.6 근거:
- `search_text_*` (1.0) 보다 약 — 합성 콘텐츠는 진짜 텍스트보다 weak signal로 취급.
- `aliases_*` (3.0/2.0) 보다 훨씬 약 — alias가 가장 강한 entity-identity 신호임을 보존.
- 0이 아니라 0.6 — paraphrase / 표현 불일치 recall에는 명확히 기여.

`match-features` 블록 3곳 (lexical / hybrid / wine_aware) 모두 `bm25(synthetic_queries)` 추가 → 디버그 / 관측성에서 channel 기여도 측정 가능.

---

## 7. 멱등성 / 백필 / 재생성

### Fingerprint
```typescript
doc2queryFingerprint = {
  modelId: 'openai:gpt-5.3-mini',
  contentHash: sha256(canonicalLabel + producer + region + grape + style + price + searchTextEn[:240]),
  generatedAt: ISO-8601,
}
```

### Skip 룰
다음 ETL 실행 시 record의 `doc2queryFingerprint`가 존재하고:
- `modelId`가 현재 generator의 modelId와 같고
- `contentHash`가 현재 doc text 해시와 같으면

→ **OpenAI 호출 없이 prior `syntheticQueries` 그대로 보존**.

### 재생성 트리거
| 변경 | 자동 재생성? |
|---|---|
| 와인 가격 / 등급 / 설명 업데이트 → contentHash drift | ✅ |
| `OPENAI_DOC2QUERY_MODEL` 값 변경 → modelId drift | ✅ |
| 시스템 프롬프트 수정 (코드 변경) | ❌ — `--force` 필요 |
| 명시적 강제 재생성 | `--force` 플래그 |

### 백필
```bash
# 1. Vespa 재배포 (synthetic_queries 필드 추가됐으므로)
just vespa-deploy   # 또는 scripts/deploy-vespa.sh

# 2. Doc2Query 백필 — 멱등이라 안전, 중간에 끊겨도 OK
npx tsx --env-file=.env.local scripts/etl/generate-doc-queries.ts \
  --input data/silver-enriched-ko.ndjson \
  --output data/silver-docquery.ndjson

# 3. (필요 시) Track C 다시
npx tsx --env-file=.env.local scripts/etl/run-track-c.ts

# 4. Vespa 재색인 — 새 ndjson 으로
npx tsx --env-file=.env.local scripts/etl/index-to-vespa.ts \
  --input data/silver-docquery.ndjson

# 5. 서버 재기동 — Cohere primary 자동 적용 (COHERE_API_KEY 이미 set일 때)
```

비용 어림 (Anthropic Haiku 단가 기준 추정 — 실제는 OpenAI gpt-5.x 단가 확인 필요):
- 7,000 docs × 1 호출/doc × ~250 input tok + ~150 output tok ≈ ~$3-5 단발성.

---

## 8. 관측성 / 운영 스위치

### Cohere CircuitBreaker
- 이름: `cohere-rerank`
- `globalCircuitBreakerRegistry` 등록 → `/health` endpoint와 metrics에서 자동 노출
- failureThreshold = 5 / recoveryTimeoutMs = 60_000 / halfOpenMaxAttempts = 3
- OPEN 시: `Ranker`가 `CircuitBreakerOpenError`를 받고 cross-encoder rerank skip → 1차 fusion 결과 그대로 반환

### Pipeline debug steps (Cohere)
- `HTTP_RERANKER_OK`
- `HTTP_RERANKER_TIMEOUT`
- `HTTP_RERANKER_HTTP_ERROR`
- `HTTP_RERANKER_NETWORK_ERROR`
- `HTTP_RERANKER_PARSE_ERROR`

### 롤백 스위치 표

| 실패 대상 | 스위치 | 효과 |
|---|---|---|
| Cohere API 다운 | (자동) CircuitBreaker OPEN | 60초 동안 호출 0, half-open 복구 |
| Cohere 자체를 끄고 싶음 | `unset COHERE_API_KEY` + 재기동 | DI가 self-host fallback 자동 선택 |
| Cohere 호출은 유지하되 점수만 무효화 (shadow 측정) | `RERANK_BLEND_SCALE=0.0` | reranker 호출 OK, 블렌드 0 |
| Doc2Query 데이터 자체를 비활성 | rank profile에서 `* 0.6` → `* 0.0` 또는 feed 시 필드 omit | 인덱스는 살아 있지만 ranking 기여 0 |
| Doc2Query 모델 변경 | `OPENAI_DOC2QUERY_MODEL` 값 변경 + `--force` 또는 자연 drift | 다음 ETL run에서 전체 재생성 |

---

## 9. 범위 밖 (의도적 dormant)

다음 모듈은 트리에 남아 있지만 **composition root에서 import 0** — 향후 실험을 막지 않기 위함이고, 지금 production path에 wired 되어 있지 않다.

| 파일 | 상태 |
|---|---|
| `src/domain/retrieval/port/splade-encoder.port.ts` | dormant |
| `src/infrastructure/adapter/stub-splade-encoder.ts` | dormant (unit test에서만 import) |
| `src/domain/retrieval/port/colbert-reranker.port.ts` | dormant |
| `src/domain/retrieval/port/doc2query-generator.port.ts` | **wired** (Doc2Query) |
| `src/infrastructure/adapter/stub-doc2query-generator.ts` | dev/test fallback |
| Vespa `learned_sparse` rank-profile | **주석 처리** (`wine_entity.sd:683-694`) — `dotProduct`/tensor 호환 문제. SPLADE 통합 보류 사유. |

이 코드를 새로 import 하기 전에 [§2](#2-왜-이-조합인가-다른-옵션은-왜-dropped) 의 결정 근거를 다시 검토할 것.

---

## 10. 관련 RFC / 메모리

- 기존 retrieval roadmap: `docs/bugbash/plan/epic-10-ranking-sota.md` T10-8 (reranker는 별도 milestone), `docs/bugbash/plan/epic-16-learned-fusion-cascade.md` T16-6 (late-interaction)
- RFC-012 — Hybrid retrieval (sparse + dense + fusion). Doc2Query는 sparse 채널에 자연스럽게 들어감.
- RFC-013 — Ranking signals. Cohere reranker는 cross-encoder 단계의 한 가지 구현체.
- 관련 메모리(local agent memory): `decision-reranker-cohere.md` — "Retrieval stack: Doc2Query + Cohere only"

---

## 빠른 파일 인덱스

| 파일 |
|---|
| `scripts/etl/generate-doc-queries.ts` |
| `src/infrastructure/ai/openai-doc2query-generator.ts` |
| `src/infrastructure/ai/cohere-reranker.ts` |
| `src/infrastructure/ai/llm-circuit-breaker-classifier.ts` |
| `src/config/container-adapters.ts` |
| `src/config/env-schemas/ai.schema.ts` |
| `src/config/env-schemas/retrieval.schema.ts` |
| `src/domain/retrieval/model/retrieval-document.ts` |
| `src/infrastructure/vespa/mapping.ts` |
| `vespa/app/schemas/wine_entity.sd` |
