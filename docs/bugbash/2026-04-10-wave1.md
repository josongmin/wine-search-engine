# Bugbash Wave 1 — 2026-04-10

8-에이전트 병렬 감사 결과 정리. 실제 코드 기반 근거 포함.
이미 픽스된 항목(`critic_score_max`, `producer_prestige_max`, region/grapes 스키마 index, request-abort-signal 메모리 누수, buildWineText Korean 신호)은 제외.

---

## P0 — 사일런트 데이터 손실 (지금 당장 틀린 결과)

### BUG-01: `region` positive 필터 토큰 drop

**문제**
`constraintToSparseFilterTokens()`는 `region = 'Barolo'` 제약에 대해 `region:Barolo` 토큰을 생성한다.
`buildSparseFilters()` switch 문에 `case 'region':` 핸들러가 없다. 토큰은 조용히 무시되고 YQL에 아무 절도 추가되지 않는다.
`region_not:` (부정) 케이스는 존재한다. positive만 빠졌다.

**근거**
- `src/domain/retrieval/service/constraint-to-sparse-filter-tokens.ts:66-67` — `case 'region': return stringEq('region')` → `region:value` 토큰 생성
- `src/infrastructure/vespa/mapping.ts` — switch 전체에 `case 'region':` 없음 (grep 확인)
- `case 'region_not':` 는 line ~985에 존재

**긴급도** 🔴 P0
사용자가 "부르고뉴 와인 보여줘"처럼 지역 필터링하면 region 제약이 무조건 무시된다. 엉뚱한 지역 와인이 결과에 섞인다. 사일런트 시맨틱 오류.

---

### BUG-02: `synthetic_queries` 필드 Vespa 스키마 미선언

**문제**
`toVespaFields()`는 `doc.syntheticQueries`가 있으면 `fields['synthetic_queries']`에 serialize한다.
그러나 `vespa-schema.sd` document 블록에 `synthetic_queries` 필드 선언이 없다.
Vespa는 스키마에 없는 필드를 인덱싱하지 않으므로 Doc2Query 기반 BM25 매칭이 실제로 동작하지 않는다.

**근거**
- `src/infrastructure/vespa/mapping.ts:308-310` — serialize 코드 존재
- `src/domain/retrieval/model/retrieval-document.ts:122` — `syntheticQueries?: readonly string[]` 선언
- `src/infrastructure/vespa/vespa-schema.sd` 전체 — `synthetic_queries` 필드 없음 (grep 확인)
- `retrieval-document.ts:112-120` 주석: "stored in dedicated Vespa BM25 field (`synthetic_queries`)"라고 기재되어 있으나 스키마에 없음

**긴급도** 🔴 P0
Doc2Query 기능 자체가 작동 안 함. TS에서 쓰고 있는 데이터가 Vespa에서 전혀 인덱싱 안 됨.
픽스: `vespa-schema.sd`에 `field synthetic_queries type array<string> { indexing: summary | attribute | index }` 추가.

---

## P1 — 운영 리스크 (장애 시 cascading failure)

### BUG-03: `HttpCrossEncoderReranker` circuit breaker 없음

**문제**
`CohereReranker`는 circuit breaker를 생성하고 `globalCircuitBreakerRegistry`에 등록한다.
`HttpCrossEncoderReranker`에는 circuit breaker가 전혀 없다.
cross-encoder 엔드포인트 다운 시: 매 요청마다 `httpTimeoutMs` (보통 30초+) 대기 → 쿼리 레이턴시 폭발 → 연쇄 장애.
readiness 체크도 이 컴포넌트의 상태를 모른다.

**근거**
- `src/infrastructure/ai/cohere-reranker.ts:63-85` — `createCircuitBreaker()` + `globalCircuitBreakerRegistry.register()` 패턴
- `src/infrastructure/vespa/reranker.ts:70-84` — constructor에 circuit breaker 없음, `url`과 `httpTimeoutMs`만 저장
- `src/observability/circuit-breaker-registry.ts` — HttpCrossEncoderReranker는 등록된 breaker 없음

**긴급도** 🟠 P1
재시도 없이 타임아웃 대기만 반복. CohereReranker 대비 비대칭 resilience. 운영 중 cross-encoder 노드 재시작 시 전체 검색 레이턴시 급등.

---

### BUG-04: anchor 임베딩 캐시 bypass

**문제**
semantic query 임베딩은 `this.cacheService.getOrEmbedBatch()`를 통해 캐시된다.
anchor 임베딩은 `anchorProfile.embedding`이 undefined일 때 `this.embeddingService.embed()`를 직접 호출한다.
캐시 서비스를 우회하므로 동일한 anchor를 가진 요청이 반복되어도 매번 embedding API를 호출한다.

**근거**
- `src/domain/retrieval/service/candidate-pool.ts:444-445`
  ```typescript
  const anchorEmbedding = anchorProfile.embedding
    ?? await this.embeddingService.embed(anchorProfile.semanticSummary);
  ```
- semantic 경로 (`candidate-pool.ts:366-372`): `cacheService.getOrEmbedBatch()` 정상 사용
- 두 경로가 비대칭

**긴급도** 🟠 P1
similar_items / recommendation 모드에서 anchor 임베딩마다 불필요한 API 호출 + 레이턴시. 캐시 서비스의 circuit breaker 보호도 우회됨.

---

## P2 — 구조적 갭 / Dead Code

### BUG-05: `RECIPROCAL_RANK_FUSION_DEFAULT_K` dead constant

**문제**
`fusion.ts`에 `const RECIPROCAL_RANK_FUSION_DEFAULT_K = 60`이 선언되어 있다.
이 상수는 해당 파일 내 어디에도 사용되지 않는다. 실제 k값은 `per-class-fusion-config.ts`의 `rrfK` 필드에서 가져온다.
SSOT인 `src/domain/shared/utils/rrf.ts`의 `RRF_DEFAULT_K = 60`과 별개로 중복 선언.

**근거**
- `src/domain/retrieval/service/fusion.ts:37` — 선언만 있음
- `src/domain/retrieval/service/fusion.ts` 전체 — `RECIPROCAL_RANK_FUSION_DEFAULT_K` 참조 없음
- `src/domain/shared/utils/rrf.ts:9` — `export const RRF_DEFAULT_K = 60` (SSOT)
- CLAUDE.md Rule 30: 2개 이상 파일에서 쓰는 상수는 shared 모듈에서만 관리

**긴급도** 🟡 P2
기능 버그는 아니지만 나중에 k값 튜닝 시 `rrf.ts`만 수정하고 `fusion.ts`는 그대로 두면 혼란 발생. Dead code 제거.

---

### BUG-06: `hardFilterTokens` retrieval plan에서 미소비

**문제**
`buildRetrievalPlan()`은 `hardFilterTokens`를 계산해서 plan 객체에 포함한다.
그런데 `candidate-pool.ts`는 이 필드를 읽지 않고 `hardConstraintsToSparseFilterTokens(input.hardConstraints)`를 직접 다시 호출한다.
즉 같은 계산이 두 번 일어나고, plan의 `hardFilterTokens`는 아무도 읽지 않는다.

**근거**
- `src/domain/retrieval/service/retrieval-plan-builder.ts:56` — `readonly hardFilterTokens: readonly string[]` 선언
- `src/domain/retrieval/service/retrieval-plan-builder.ts:81` — 계산
- `src/domain/retrieval/service/retrieval-plan-builder.ts:118` — plan 객체에 포함
- `src/domain/retrieval/service/candidate-pool.ts:215` — `hardConstraintsToSparseFilterTokens(input.hardConstraints)` 직접 호출 (plan 무시)
- 프로덕션 코드 전체에서 `hardFilterTokens` 읽는 곳: 없음 (테스트만 존재)

**긴급도** 🟡 P2
기능 버그는 아님. 유지보수 트랩: plan의 필드를 바꿔도 retrieval에 반영 안 됨. 향후 혼란 원인.
옵션A: `hardFilterTokens` 필드 삭제 + candidate-pool 직접 계산 유지.
옵션B: candidate-pool을 plan의 `hardFilterTokens` 소비로 변경.

---

### BUG-07: LTR 26-feature vs 8-feature 두 시스템 공존 (dead code)

**문제**
`ltr-features.ts`는 26개 feature의 `LTRFeatureVector` 인터페이스와 추출 로직을 정의한다.
`ltr-feature-extractor.ts`는 8개 feature의 `RankingFeatures`를 정의하고 실제 ranker에서 사용된다.
`ltr-features.ts`는 프로덕션 코드 어디에서도 import되지 않는다 — 테스트에서만 참조.

**근거**
- `src/domain/ranking/service/ltr-features.ts` — 26-feature vector 정의
- `src/domain/ranking/service/ltr-feature-extractor.ts` — 8-feature `RankingFeatures`, ranker.ts:224에서 사용
- `src/domain/ranking/service/ranker.ts:224` — `extractLTRFeatures()` from `ltr-feature-extractor.ts`
- `ltr-features.ts` production import: 없음

**긴급도** 🟡 P2
train-serve skew 위험: 누군가 26-feature 버전으로 오프라인 학습하면 serve time의 8-feature 인터페이스와 불일치. 혼란 제거 필요.

---

### BUG-08: `rerank_score` LTR feature 누락 — train-serve skew

**문제**
`ranker.ts`는 cross-encoder score를 정규화해서 최종 score에 blend한다 (serve time 동작).
`RankingFeatures` (8-feature)에는 `rerank_score` 필드가 없다.
LTR 모델은 reranker가 최종 순위에 기여하는 신호를 전혀 학습하지 못한다.

**근거**
- `src/domain/ranking/service/ranker.ts:825-872` — cross-encoder score 계산 + blend
- `src/domain/ranking/service/ltr-feature-extractor.ts:69-94` — 8개 feature, rerank_score 없음
- `src/domain/ranking/service/ltr-feature-extractor.ts:14-23` — `RankingFeatures` 인터페이스

**긴급도** 🟡 P2
LTR 모델을 실제로 학습/배포하기 전까지는 직접 장애는 없음. 하지만 LTR 훈련 시작하면 즉시 문제가 됨. feature 추가 먼저 해놓고 데이터 수집해야 나중에 쓸 수 있음.

---

## P3 — SOTA++ 정확도 갭 (틀리진 않지만 미달)

### BUG-09: 숫자 budget 제약이 soft[]로 분류됨

**문제**
"5만원 이하", "50달러 미만" 같이 명확한 상한 예산은 hard constraint여야 한다.
현재 rule-based extractor는 이를 `soft[]`로 emit한다.
사용자가 예산 초과 결과를 받는다.

**근거**
- `src/domain/query/service/rule-based-constraint-extractor.ts:276-296` — price 제약 soft push
- 주석: "price filters are user preferences, not hard requirements" — SOTA++ e-commerce 기준 불일치
- `constraint-compiler.ts:24-27` — `SOFT_CONSTRAINT_ATTRIBUTES`에 `price_usd` 없음에도 extractor 단에서 soft 처리

**긴급도** 🔵 P3
예산 제약 필터링 품질에 직접 영향. 단, 현재 soft 제약도 ranking boost로는 작동하므로 완전 무시는 아님.

---

### BUG-10: `oak_treatment`, `certifications`, `producer_type` 추출기 커버리지 없음

**문제**
Vespa 스키마에 세 필드가 선언되어 있고 `buildSparseFilters()`에 핸들러도 있다.
그러나 rule-based extractor와 nl-mapper 어디에도 이 속성을 추출하는 로직이 없다.
"유기농 와인", "소규모 도메인", "오크 숙성 안 한 것" 같은 쿼리에서 제약이 생성되지 않는다.

**근거**
- `src/infrastructure/vespa/vespa-schema.sd:134-136` (oak_treatment), `116-118` (certifications), `131-133` (producer_type)
- `src/domain/retrieval/service/constraint-to-sparse-filter-tokens.ts:96-106` — 세 속성 모두 토큰 생성 로직 있음
- rule-based-constraint-extractor.ts, nl-mapper.ts — 세 속성 emit 없음

**긴급도** 🔵 P3
필터 파이프라인은 완성되어 있는데 입력(추출)만 없음. 반쪽짜리 구현.

---

### BUG-11: hybrid/prestige rank profile이 `search_text_ko`/`search_text_en` 미활용

**문제**
`bm25` rank profile만 `bm25(search_text_ko) + bm25(search_text_en)`을 포함한다.
`hybrid`, `prestige_hybrid`, `popularity_native` profile은 `bm25(canonical_label)`만 사용한다.
한국어 테이스팅 노트, 영문 설명이 인덱싱되어 있지만 메인 검색 경로에서 활용 안 됨.

**근거**
- `src/infrastructure/vespa/vespa-schema.sd:159-163` — bm25 profile: 3개 필드 합산
- `src/infrastructure/vespa/vespa-schema.sd:174-181` — hybrid profile: `canonical_label`만
- `src/infrastructure/vespa/vespa-schema.sd:266-276` — prestige_hybrid: `canonical_label`만

**긴급도** 🔵 P3
한국어 쿼리에서 hybrid 모드가 canonical_label BM25에만 의존. `search_text_ko` 기여 없음.

---

## 픽스 우선순위 요약

| 순서 | 항목 | 예상 작업 | 파일 |
|------|------|----------|------|
| 1 | BUG-01 region positive 필터 drop | `case 'region':` 추가 | mapping.ts |
| 2 | BUG-02 synthetic_queries 스키마 누락 | 필드 선언 추가 | vespa-schema.sd |
| 3 | BUG-03 HttpCrossEncoderReranker circuit breaker | CohereReranker 패턴 복사 | reranker.ts |
| 4 | BUG-04 anchor 임베딩 캐시 bypass | getOrEmbedBatch 래핑 | candidate-pool.ts |
| 5 | BUG-05 dead constant 제거 | 상수 삭제 | fusion.ts |
| 6 | BUG-06 hardFilterTokens dead field | 필드 삭제 or 소비 | retrieval-plan-builder.ts |
| 7 | BUG-07 LTR dead 26-feature 정리 | ltr-features.ts 정리/삭제 여부 결정 | ltr-features.ts |
| 8 | BUG-08 rerank_score LTR feature 추가 | RankingFeatures 확장 | ltr-feature-extractor.ts |
| 9 | BUG-09 budget constraint hard 분류 | extractor 로직 변경 | rule-based-constraint-extractor.ts |
| 10 | BUG-10 oak/cert/producer_type 추출기 | extractor 확장 | rule-based-constraint-extractor.ts |
| 11 | BUG-11 rank profile search_text 추가 | profile 수정 | vespa-schema.sd |

---

*감사 수행: 8-에이전트 병렬, 2026-04-10*
*이미 픽스된 항목: critic_score_max/producer_prestige_max YQL 핸들러, region/grapes 스키마 index, request-abort-signal 메모리 누수, buildWineText Korean 신호, negation-yql regression R-NEG-21~23*

---

## Eval RCA — Bronze 결과 (NDCG 0.105, 83% ambiguous)

> 5-에이전트 병렬 RCA 수행: 2026-04-10. 평가 결과 `/tmp/bronze-eval-*.json` 기반.

---

### RCA-01: 83% ambiguous — entropy abstain gate 과도하게 발동

**문제**
bronze eval에서 500건 중 415건(83%)이 `ambiguous` 상태로 반환됨.
`abstain-policy.ts`의 entropy threshold=0.82가 원인.
LTR 모델 미학습 + Cohere reranker 미연결 상태에서 모든 후보의 점수가 균일하게 분포 → entropy ≈ 0.9997 → 항상 threshold 초과 → 전량 abstain.
실제 사용자는 응답이 아닌 "모르겠어요"를 받는 것.

**근거**
- `src/domain/decision/service/abstain-policy.ts:18` — `ENTROPY_THRESHOLD = 0.82`
- entropy 계산: candidate score가 균일하면 Shannon entropy = log2(N)/log2(N) → 1.0 > 0.82
- LTR 모델 DB 테이블: 비어 있음 (fallback to heuristic weights)
- Cohere API 키: 설정 시 `rerankerConfigured=true`지만 env에 없으면 비활성
- eval 출력 `execution_mode`: 대부분 `heuristic_weights` (LTR graceful fallback)

**긴급도** 🔴 P0
전체 eval 결과를 무효화. 서비스 배포 시 대부분의 쿼리가 응답 없이 돌아옴.
단기 fix: entropy threshold를 0.95~0.97로 상향 조정 (균일 분포 허용) 또는 LTR/reranker 연결.
근본 fix: LTR 모델 학습 (`run-eval-and-train-ltr.ts`) + Cohere API 키 환경변수 설정.

---

### RCA-02: NDCG@10 = 0.105 (baseline 0.390 대비 -73%)

**문제**
전체 NDCG@10이 0.105. Scenario별로 B-H 모두 0. Scenario A(heuristic drinking window) 만 값 존재.
`ndcg_succeeded_only = 0.860` — 실제로 응답이 나온 쿼리만 보면 품질은 좋음.
하지만 83%가 ambiguous로 처리되어 전체 평균을 끌어내림.
즉 NDCG regression의 실제 원인은 RCA-01과 동일: abstain gate.

**근거**
- eval JSON: `by_scenario: { B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0 }`
- `ndcg_succeeded_only: 0.860` — 성공한 케이스는 정상 품질
- baseline `~0.390`은 abstain gate가 없던 시점 측정
- `recall@100 = 51.3%` — retrieval 자체도 저하 (expected 85%)

**긴급도** 🔴 P0
KPI 지표 자체가 무의미. RCA-01 fix가 이 지표도 복구함.
recall@100 = 51.3% 별도 조사 필요 (BM25 saturation? Vespa schema mismatch?).

---

### RCA-03: 17% failed — retrieval/server 에러

**문제**
500건 중 약 85건(17%)이 `failed` 상태. 원인은 복합:
1. Vespa 미연결 환경에서 retrieval 실패 (connection refused)
2. `nl-mappings.json` 파일 없음 → NLMapper 초기화 시 fallback 경고 but continue
3. 서버 startup 경고: `embedding.url` 없음 + `OPENAI_API_KEY` 없음 → embedding 호출 시 TypeError
4. `execution_mode` 필드가 response 최상위에 없음 → eval harness parse 오류 가능성

**근거**
- `~/.wine-search-engine/data/nl-mappings.json` — 파일 없음 (확인됨)
- `src/config/env.ts` — `embedding.url` optional, fallback `'up'` stub 추가됨 (readiness.ts)
- eval harness: `result.execution_mode` 파싱 — response envelope 구조 변경 시 필드 위치 불일치
- 서버 로그 (dev): `[readiness] embedding: stub, reporting up` 경고

**긴급도** 🟠 P1
17%는 실제 에러. 우선순위:
1. Vespa 연결 확인 (로컬 docker or remote)
2. `nl-mappings.json` 생성 스크립트 실행
3. eval harness `execution_mode` 필드 경로 확인

---

### RCA-04: Conformal calibration alpha 불일치 (0.3 vs 0.1)

**문제**
decision gate는 `DEFAULT_ALPHA = 0.3` 사용 (70% coverage 목표).
eval validation은 `CONFORMAL_ALPHA = 0.1` 기대 (90% coverage 목표).
두 값이 다른 모듈에 분산 선언되어 SSoT 위반.
추가로: DB에 calibration params 없음 → identity mapping → confidence 미calibration → avoidable_abstain_rate 91.2%.

**근거**
- `src/domain/decision/service/conformal-calibration.ts` — `DEFAULT_ALPHA = 0.3`
- eval validation 코드 — `CONFORMAL_ALPHA = 0.1` (별도 선언)
- `calibration_store` readiness probe: production 환경에서 `required: true` (readiness.ts:181-188)
- DB calibration 테이블: 비어 있음 → `getCalibrationParams()` 404/empty → identity fallback

**긴급도** 🟠 P1
alpha 불일치가 eval 지표를 왜곡. `avoidable_abstain_rate = 91.2%`는 calibration 없을 때의 당연한 결과.
fix: alpha 상수를 SSoT 모듈로 통합. calibration 데이터 생성 스크립트 실행.

---

### RCA-05: LTR 모델 미학습 (graceful fallback 중)

**문제**
`ranker.ts`의 LambdaMART ranker가 DB에서 모델 가중치를 찾지 못해 heuristic weights로 fallback.
heuristic weights = hand-tuned constants, 학습된 gradient가 없음.
예상 품질 손실: -10~15% NDCG (실측 대신 추정).

**근거**
- LTR 모델 DB 테이블: 비어 있음
- `src/domain/ranking/service/lambdamart-ranker.ts` — graceful fallback to `DEFAULT_WEIGHTS` 존재
- `scripts/run-eval-and-train-ltr.ts` — 학습 스크립트 존재하지만 미실행
- eval 출력 `execution_mode: 'heuristic_weights'` 확인됨

**긴급도** 🟡 P2
현재는 서비스 자체가 동작. 단 ranking 품질이 최적이 아님.
fix: eval 코퍼스 준비 후 `npm run train:ltr` 또는 동등한 스크립트 실행.

---

### RCA-06: eval 코퍼스 파일 없음 (`/tmp/test300-v3.ndjson`)

**문제**
eval harness가 참조하는 코퍼스 `/tmp/test300-v3.ndjson` 없음.
현재 존재하는 파일: `/tmp/pilot200-*.ndjson` (파일명 다름).
`pilot200`으로 돌리면 bronze eval은 가능하지만 정식 300-query 벤치마크 불가.

**근거**
- `ls /tmp/test300-v3.ndjson` → No such file
- `ls /tmp/pilot200*` → 존재 확인됨
- eval 스크립트: `--corpus /tmp/test300-v3.ndjson` 하드코딩 여부 확인 필요

**긴급도** 🟡 P2
pilot200으로 우회 가능. 정식 벤치마크 전 코퍼스 파일 경로 정리 필요.

---

### RCA-07: Drinking window ONNX 모델 없음 (heuristic 동작 중)

**문제**
`drinkingWindowPredictor.modelVersion`이 `'unknown'` 또는 `'heuristic-*'`로 시작하면 readiness probe가 `'down'`을 반환.
실제 기능(heuristic)은 동작하지만 readiness 엔드포인트가 `drinking_window_model: down`을 표시.
운영자가 비정상으로 오인할 수 있음.

**근거**
- `src/config/readiness.ts:162-165` — `modelVersion.startsWith('heuristic') ? 'down' : 'up'`
- (이번 세션에서 `=== 'unknown'`으로 변경됨, but `heuristic-*` 버전은 여전히 down)
- ONNX 모델 파일: 로컬에 없음

**긴급도** 🟡 P2
기능 장애 아님. readiness 지표 노이즈. ONNX 모델 학습/배포 시 자동 해소.

---

## Eval RCA 픽스 우선순위 요약

| 순서 | 항목 | 액션 | 예상 효과 |
|------|------|------|----------|
| 1 | RCA-01 entropy abstain threshold | `ENTROPY_THRESHOLD` 0.82 → 0.95~0.97 | 83% → <20% ambiguous |
| 2 | RCA-02 NDCG regression | RCA-01 fix로 자동 복구 | NDCG 0.105 → 0.7+ |
| 3 | RCA-03 17% failed | Vespa 연결 + nl-mappings 생성 | 실제 에러 제거 |
| 4 | RCA-04 alpha SSoT + calibration | 상수 통합 + calibration 데이터 생성 | avoidable_abstain_rate 개선 |
| 5 | RCA-05 LTR 학습 | `run-eval-and-train-ltr.ts` 실행 | ranking +10~15% NDCG |
| 6 | RCA-06 코퍼스 파일 경로 | 파일명 정리 또는 symlink | 정식 벤치마크 가능 |
| 7 | RCA-07 drinking window probe | heuristic 버전도 'up'으로 처리 | readiness 노이즈 제거 |

*Eval RCA 수행: 5-에이전트 병렬, 2026-04-10*

---

## Agent Data Audit — 10-에이전트 병렬 감사 결과 (2026-04-10)

저장 데이터 활용도(Redis 캐시 read/write, JSONB 검증, 신규 모듈 wiring, 스키마 품질) 집중 감사.

---

### BUG-12: `feature-parity-hash.ts` production에 미연결 (dead module)

**문제**
`src/domain/ranking/service/feature-parity-hash.ts`가 신규 추가됐지만 어떤 composition root도 import하지 않음.
`getCurrentFeatureSchemaHash()`, `LTR_FEATURE_SCHEMA_VERSION` 모두 참조 없음.
`src/domain/ranking/index.ts`, `training.ts` barrel export에도 미포함. 테스트 파일도 없음.

**근거**
- `src/domain/ranking/service/feature-parity-hash.ts` — exports: `hashFeatureSchema`, `getCurrentFeatureSchemaHash`, `LTR_FEATURE_SCHEMA_VERSION`
- `src/config/`, `src/application/`, `src/interface/` 전체 — import 없음
- `src/domain/ranking/service/lambdamart-ranker.ts` — import 없음
- CLAUDE.md Rule 33: 컴파일은 되지만 import 안 되는 foundation code는 dead weight

**예상 wiring 위치**
- `ltr-training-service.ts` — 학습 시 schema hash 기록
- promotion gate — 모델 promote 시 train-time hash == serve-time hash 검증
- `src/config/container-*.ts` — 서버 startup 시 hash 로깅 + fast-fail

**긴급도** 🟠 P1
train-serve schema skew 방지가 목적인 모듈인데 아무 곳에도 연결 안 됨. BUG-07(LTR dead code)와 복합 위험.

---

### BUG-13: `extractExtendedLTRFeatures()` 테스트 전무

**문제**
`src/domain/ranking/service/ltr-feature-extractor.ts`에 `extractExtendedLTRFeatures()` 신규 추가.
`criticScoreFeature`(default 0.0)와 `producerPrestigeFeature`(default 0.5) 두 필드 추가.
그러나 `__tests__/ltr-feature-extractor.test.ts`에 이 함수에 대한 테스트가 **단 하나도 없음**.

**근거**
- `src/domain/ranking/service/ltr-feature-extractor.ts:113-119` — `extractExtendedLTRFeatures()` 정의
- `src/domain/ranking/__tests__/ltr-feature-extractor.test.ts` — `extractLTRFeatures()` 5개 테스트만 존재, extended 함수 참조 없음
- 비대칭 default: `criticScore ?? 0.0` vs `producerPrestige ?? LTR_PRODUCER_PRESTIGE_FEATURE_DEFAULT(0.5)` — 테스트 없으면 regression 탐지 불가

**누락된 케이스**
- `criticScore: undefined` → 0.0 default 확인
- `producerPrestige: undefined` → 0.5 default 확인 (0.0이 아님!)
- extended 함수 출력 총 10개 필드 존재 확인
- `criticScore: 0` (유효한 0 값) → `||` fallback 버그 탐지용

**긴급도** 🟠 P1
CLAUDE.md Test Discipline 위반. 비대칭 default 버그가 조용히 들어올 수 있음.

---

### BUG-14: `rule-based-constraint-extractor.ts:83` lookahead 문자 클래스 오류

**문제**
price 상한 패턴 lookahead가 `(?!\p{L})(?!\p{N})` 형태로, 이는 "letter THEN digit" 2-char 시퀀스를 부정하는 패턴임.
파일 내 주석(line 81-82)이 직접 "AND-sequence checks… never matches anything"이라고 경고하지만 수정 안 됨.
올바른 형태는 `(?![\p{L}\p{N}])` (character class).

**근거**
- `src/domain/query/service/rule-based-constraint-extractor.ts:83`
  ```typescript
  /(?<!\p{L})(?<!\p{N})under\s+\$?(\d+)(?!\p{L})(?!\p{N})/iu
  ```
- lookbehind 쪽(`(?<!\p{L})(?<!\p{N})`)은 두 개의 독립 lookbehind라 정상 동작
- lookahead 쪽(`(?!\p{L})(?!\p{N})`)은 sequence 형태라 오동작
- CLAUDE.md Rule 24 위반

**긴급도** 🟠 P1
`"under $50 bottles"` 같은 패턴에서 경계 탐지 실패 가능. `(?![\p{L}\p{N}])` 로 교체 + 테스트 추가.

---

### BUG-15: `SOFT_CONSTRAINT_ATTRIBUTES` 3곳 중복 정의 — 버전 간 속성 누락

**문제**
`constraint-compiler.ts`에 10개 속성 SSoT가 있지만, `planner.ts`와 `result-grouper.ts`에 독립 리터럴 배열이 존재.
`planner.ts` 버전은 `price_band`, `occasion`, `critic_score`, `fruit_intensity`, `finish` 5개 속성 누락.
이 5개 속성을 가진 제약이 planner에서 "soft"로 분류되지 않아 query routing이 틀림.

**근거**
- `src/domain/query/service/constraint-compiler.ts:24-27` — 10개 속성 SSoT
- `src/domain/retrieval/service/planner.ts` — 독립 배열 선언 (5개 누락)
- `src/domain/response/service/result-grouper.ts` — 독립 배열 선언 (subset)
- CLAUDE.md Rule 25, 30 위반

**긴급도** 🟠 P1
`price_band`/`critic_score` 제약이 planner에서 hard로 오분류 → 검색 결과 라우팅 오류.
fix: `SOFT_CONSTRAINT_ATTRIBUTES`를 shared constants 모듈로 추출, planner/result-grouper import로 교체.

---

### BUG-16: `RedisCache.get<T>()` deprecated 메서드 — unsafe 직접 캐스트

**문제**
`src/infrastructure/adapter/redis-cache.ts:72` — `get<T>()` 메서드가 `parsed as T`로 Zod 검증 없이 직접 캐스트.
메서드 자체에 `@deprecated` 주석이 달려 있지만 여전히 코드베이스 일부에서 호출됨.
poisoned/schema-drifted 캐시 항목을 타입 오류 없이 반환함.

**근거**
- `src/infrastructure/adapter/redis-cache.ts:72` — `return parsed as T;`
- 주석: "casts JSON.parse output directly to T without runtime validation"
- `getValidated()`, `getValidatedWithStats()` (line 86-166) 가 안전한 대체제로 존재
- CLAUDE.md Rule 12 위반

**긴급도** 🟡 P2
`get<T>()` 호출부를 `getValidated()` 또는 `getValidatedWithStats()`로 전환 후 deprecated 메서드 제거.

---

### BUG-17: `RedisQueryCache.set()` / `RedisEmbeddingCache.set()` write-time 검증 없음

**문제**
`RedisPhraseCache`는 `setValidated()`로 write-time Zod 검증 후 저장.
`RedisQueryCache.set()`과 `RedisEmbeddingCache.set()`은 unvalidated `.set()` 직접 호출.
잘못된 데이터가 캐시에 쓰인 뒤 read 시 Zod가 거부 → 삭제 → 재시도 루프 (캐시 포이즌 루프).

**근거**
- `src/infrastructure/cache/redis-query-cache.ts:87-92` — `this.cache.set()` 직접 호출
- `src/infrastructure/cache/redis-embedding-cache.ts:81` — `this.cache.set()` 직접 호출
- `src/infrastructure/cache/redis-phrase-cache.ts:77-82` — `this.cache.setValidated()` 사용 (정상)

**긴급도** 🟡 P2
write-time validation으로 poison entry 원천 차단 필요. `setValidated()` 패턴 통일.

---

### BUG-18: `005_watchlist_dedup_constraint.sql` — duplicate 정리 없이 UNIQUE INDEX 추가

**문제**
migration이 `(user_id, entity_id, callback_url)` UNIQUE INDEX를 바로 생성.
기존 중복 행 정리 스텝 없음. 프로덕션에 duplicate 있으면 migration 실패로 서비스 기동 불가.
추가로: rollback 절차 없음, exclusive table lock 다운타임 문서화 없음.

**근거**
- `src/infrastructure/db/migrations/005_watchlist_dedup_constraint.sql` — 전체
- `pg-watchlist-store.ts:92` — `ON CONFLICT (user_id, entity_id, callback_url) DO NOTHING` 이 constraint 의존
- migration 실패 시 `save()` idempotency 보장 깨짐

**긴급도** 🔴 P0
배포 불가. fix: migration 선두에 duplicate 정리 CTE 추가 (가장 최신 `created_at` 유지, 나머지 DELETE).

```sql
-- 예시 선행 스텝
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY user_id, entity_id, callback_url
    ORDER BY created_at DESC
  ) AS rn
  FROM watchlists
)
DELETE FROM watchlists WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
```

---

### BUG-19: `kill-switch-policy.test.ts` — 핵심 필드 및 degradation 조건 미테스트

**문제**
테스트가 `rerankerAvailable`과 `currentExecutionModeHint` 2개 필드만 확인.
`denseRetrievalEnabled`, `learningKillSwitchEnabled` 반환 필드 테스트 없음.
degradation 조건 4개 중 reranker 미설정 케이스 1개만 테스트.

**누락된 케이스**
- `KILL_SWITCH_DENSE_RETRIEVAL=true` → `denseRetrievalEnabled: false`, mode degraded
- `KILL_SWITCH_LEARNING=true` → `learningKillSwitchEnabled: true`, mode degraded
- `RERANKER_SERVICE_URL='   '` (whitespace-only) → `rerankerAvailable: false`
- degradation signal 존재 시 mode hint 변경

**근거**
- `src/config/__tests__/kill-switch-policy.test.ts` — 전체 (신규 파일)
- `src/config/kill-switch-policy.ts:99-108` — 4개 degradation 조건 정의

**긴급도** 🟡 P2
CLAUDE.md Rule 23 위반 (false-positive 테스트 누락). CI에서 regression 탐지 불가.

---

### BUG-20: `route-contracts.ts:163` 매직 넘버 `100`

**문제**
`z.array(z.unknown()).max(100)` — `100`이 named constant 없이 직접 사용.
나머지 39개+ 배열 bound는 모두 named constant 사용.

**근거**
- `src/interface/http/routes/route-contracts.ts:163`
- 동일 파일 내 `AGENT_METRICS_ALERTS_MAX` 등 named constant 패턴 존재

**긴급도** 🟡 P2
`const CLAUDE_TOOLS_LIST_MAX = 100` 추출 후 교체. ESLint `no-magic-numbers` 룰 대상.

---

## Agent Data Audit 픽스 우선순위 요약

| 순서 | 항목 | 예상 작업 | 파일 |
|------|------|----------|------|
| 1 | BUG-18 migration 005 duplicate 정리 | DELETE CTE 선행 스텝 추가 | 005_watchlist_dedup_constraint.sql |
| 2 | BUG-14 lookahead 문자 클래스 오류 | `(?!\p{L})(?!\p{N})` → `(?![\p{L}\p{N}])` | rule-based-constraint-extractor.ts:83 |
| 3 | BUG-15 SOFT_CONSTRAINT_ATTRIBUTES SSoT | shared constants 추출 + planner/result-grouper import | constraint-compiler.ts, planner.ts, result-grouper.ts |
| 4 | BUG-12 feature-parity-hash wiring | promotion gate or training-service에 연결 | feature-parity-hash.ts, ltr-training-service.ts |
| 5 | BUG-13 extractExtendedLTRFeatures 테스트 | default 값 + 10-field coverage 추가 | ltr-feature-extractor.test.ts |
| 6 | BUG-16 deprecated get<T>() 제거 | 호출부 getValidated()로 전환 | redis-cache.ts |
| 7 | BUG-17 write-time 검증 통일 | setValidated() 패턴 적용 | redis-query-cache.ts, redis-embedding-cache.ts |
| 8 | BUG-19 kill-switch 테스트 보강 | 4개 degradation 조건 + whitespace URL | kill-switch-policy.test.ts |
| 9 | BUG-20 매직 넘버 100 | named const 추출 | route-contracts.ts:163 |

*Agent Data Audit 수행: 10-에이전트 병렬, 2026-04-10*

---

## 인덱싱 데이터 감사 — 에이전트 판단 데이터 무결성

> 10-에이전트 병렬 감사 수행: 2026-04-10. Vespa schema, ETL 파이프라인, constraint pipeline, score components, rank profiles 전체 커버.
> **테스트 결과: 317개 파일, 3,965 테스트 모두 통과 (1 skipped).**

---

### IDX-01: `synthetic_queries` — Vespa 스키마 미선언 (사일런트 손실) 🔴 P0

**문제**
ETL(`mapping.ts:308-309`)은 `fields['synthetic_queries']`에 Doc2Query 확장 쿼리를 write.
`vespa-schema.sd`에 해당 필드 선언이 없음 → Vespa가 수신하지만 인덱싱하지 않고 버림.
BM25 매칭 대상에서 Doc2Query 콘텐츠가 완전히 누락. 에러/경고 없음.

**근거**
- `src/infrastructure/vespa/mapping.ts:308-309` — `fields['synthetic_queries'] = [...]`
- `vespa/app/schemas/wine_entity.sd` 전체 — `synthetic_queries` 필드 선언 없음
- `src/domain/retrieval/model/retrieval-document.ts:122` — "stored in dedicated Vespa BM25 field (`synthetic_queries`)" 주석 있으나 스키마에 없음

**긴급도** 🔴 P0
Doc2Query 기능 전체가 사문화됨. 필드 1줄 추가로 즉시 복구 가능.
Fix: `vespa-schema.sd`에 `field synthetic_queries type array<string> { indexing: summary | index }` 추가.

---

### IDX-02: `region` positive 필터 YQL 누락 (BUG-01 재확인) 🔴 P0

**문제**
`buildSparseFilters()` switch 문에 `case 'region':` 없음.
토큰 `region:Bordeaux`는 default 케이스에서 `_in`/`_not_in` suffix 체크 후 **조용히 skip**.
`region_not:` 케이스는 존재 — 부정만 됨.

**근거**
- `src/infrastructure/vespa/mapping.ts` — switch 전체 `case 'region':` 없음 (grep 재확인)
- `case 'region_not':` ≈ line 985 — 부정 케이스만 존재
- Constraint pipeline trace: 추출 ✅ → 컴파일 ✅ → 토큰화 ✅ → YQL 생성 ❌

**긴급도** 🔴 P0
"보르도 와인" 같은 지역 필터링 쿼리 전부 필터 무시. Fix: `case 'region': clauses.push(...yqlString...)` 1줄.

---

### IDX-03: sensory 속성 척도 문서화 오류 (구현은 정상) 🟡 P2

**문제**
`src/domain/ranking/model/ranked-result.ts:139-149` 주석: "1–5 ordinal scale".
실제 ETL(`vivino-to-silver.ts:221-224`): `normalizeScale(score, max=5)` → `score / 5` → **[0,1] float**.
`search-response.schema.ts:89-93` 스키마: 올바르게 [0,1] 선언.
이전 세션에서 schema에 `min(1).max(5)` 추가 시도 → **값이 [0,1]이므로 잘못된 경계** → 수정 필요.

**근거**
- `scripts/etl/vivino-to-silver.ts:221-224` — `Math.max(0, Math.min(1, score / 5))`
- `src/interface/http/schemas/search-response.schema.ts` — `.min(SENSORY_ORDINAL_MIN).max(SENSORY_ORDINAL_MAX)` (이전 세션 추가)
- `src/interface/http/constants.ts` — `SENSORY_ORDINAL_MIN=1, SENSORY_ORDINAL_MAX=5`

**긴급도** 🟡 P2
**스키마 경계가 틀림**: ETL이 [0,1]로 normalize하므로 body=0.6 같은 값이 `min(1)` 검증 실패.
Fix: `SENSORY_ORDINAL_MIN=0, SENSORY_ORDINAL_MAX=1` 또는 상수명 변경 + `.min(0).max(1)`.

---

### IDX-04: grape varieties — 1차 품종만 response에 노출 🟠 P1

**문제**
Vespa에 `grapes: array<string>` (복수 품종) 인덱싱됨.
`search-usecase-map-result-items.ts:180`: `grapes: [r.grapePrimary]` — 1차 품종만 배열로 래핑.
2차 품종(Merlot blend의 Cabernet Franc 등)이 검색 결과에서 숨겨짐.

**근거**
- `src/domain/retrieval/model/hybrid-candidate.ts` — `grapePrimary?: string` (단일)
- `src/application/search/search-usecase-map-result-items.ts:180` — `grapes: [r.grapePrimary]`
- `vespa/app/schemas/wine_entity.sd` — `grapes` array<string> 인덱싱됨

**긴급도** 🟠 P1
사용자에게 노출되는 정보 손실. 블렌드 와인 상세 정보 누락.
Fix: `HybridCandidate`에 `grapes?: readonly string[]` 추가, summary 매핑에 포함.

---

### IDX-05: `acidity` hard/soft 분류 불일치 🟠 P1

**문제**
`rule-based-constraint-extractor.ts`는 "산도 높은" 같은 표현에서 `acidity`를 **hard** 비교 연산자(`>=`, `<=`)로 emit.
`constraint-compiler.ts:25`의 `SOFT_CONSTRAINT_ATTRIBUTES`에 `acidity` 포함 → **soft로 강등**.
결과: rule-based 경로에서 acidity 제약은 hard filter가 아닌 soft ranking boost만 작동.

**근거**
- `src/domain/query/service/constraint-compiler.ts:25` — `SOFT_CONSTRAINT_ATTRIBUTES`에 `acidity`
- `src/domain/query/service/rule-based-constraint-extractor.ts` — hard `>=`/`<=` emit
- LLM/resolver 경로도 동일하게 soft 처리

**긴급도** 🟠 P1
"산도 높은 화이트" 쿼리에서 저산도 와인이 필터링 안 됨. 의도치 않은 결과 혼입.

---

### IDX-06: `preferenceAlignment` 항상 0.5 고정 — dead signal 🟡 P2

**문제**
`signal-computer.ts`의 `preferenceAlignment` 계산이 `PREFERENCE_ALIGNMENT_NEUTRAL = 0.5` 상수 반환.
사용자 선호 데이터(이전 검색, 즐겨찾기 등)를 실제로 반영하지 않음.
LTR 학습 시 이 feature는 분산 0 → 모델이 학습 불가.

**근거**
- `src/domain/ranking/service/signal-computer.ts:573` — `return PREFERENCE_ALIGNMENT_NEUTRAL` (hardcoded)
- `src/domain/ranking/service/signal-computer.ts:69` — `const PREFERENCE_ALIGNMENT_NEUTRAL = 0.5`
- LTR feature extraction: `classMatchScore: 0.5` 항상 고정

**긴급도** 🟡 P2
현재 기능 버그 아니지만 LTR 학습 시 dead feature로 capacity 낭비. 구현 전까지 feature 제거 권장.

---

### IDX-07: `oak_treatment` / `certifications` / `producer_type` — 추출 경로 없음 🟡 P2

**문제**
세 필드 모두 Vespa 스키마 ✅, `buildSparseFilters()` YQL 핸들러 ✅.
그러나 `LLM_ALLOWED_ATTRIBUTES`에 `oak_treatment` 없음 → LLM도 emit 불가.
`certifications`/`producer_type`은 LLM 경로에는 있으나 rule-based extractor에는 없음.
"유기농", "오크 숙성 없는" 쿼리에서 해당 필터 전혀 생성 안 됨.

**근거**
- `src/domain/query/service/llm-constraint-schema.ts:12-31` — `oak_treatment` 미포함
- `src/domain/query/service/rule-based-constraint-extractor.ts` — 세 속성 emit 없음
- `src/infrastructure/vespa/mapping.ts` — YQL 핸들러 존재

**긴급도** 🟡 P2
파이프라인 후반부는 완성, 입력(추출)만 미구현. 반쪽 구현.

---

### IDX-08: Vespa rank profile — `synthetic_queries` BM25 가중치 선언됨 (IDX-01과 연계) 🔴 P0

**문제**
`lexical` rank profile의 `bm25_wine()` 함수(vespa-schema.sd:495-497):
`+ bm25(synthetic_queries) * 0.6`
스키마에 필드 없으면 Vespa가 이 표현식을 무시하거나 에러. IDX-01 fix 전까지 ranking에 기여 없음.

**근거**
- `vespa/app/schemas/wine_entity.sd:495-497` — `bm25(synthetic_queries) * 0.6` 선언됨
- `vespa/app/schemas/wine_entity.sd` — `synthetic_queries` field 선언 없음

**긴급도** IDX-01과 동일. 같은 fix로 해결.

---

### IDX-09: `wine_aware` rank profile — current_year 2024 하드코딩 🟡 P2

**문제**
`wine_aware` profile(vespa-schema.sd:660):
`(2024.0 - attribute(vintage_year)) / 30.0`
연도가 하드코딩되어 매년 Vespa 재배포 없이는 recency 신호 틀어짐.
2026년 현재 이미 2년 오차.

**근거**
- `vespa/app/schemas/wine_entity.sd:660` — `2024.0` 하드코딩
- `wine_aware` profile에서만 사용 (hybrid/prestige_hybrid는 recency 신호 없음)
- `query(current_year)` 파라미터 패턴으로 교체 가능

**긴급도** 🟡 P2
현재 recency 신호 2년 오차. wine_aware profile 사용 시 최신 빈티지가 덜 부스트됨.

---

### IDX-10: BM25 포화 상수 불일치 — TS vs Vespa 🟠 P1

**문제**
TypeScript `ltr-feature-extractor.ts`: `BM25_SATURATION_POINT = 12` (이번 세션 추가).
`sparseRawScore / (sparseRawScore + 12)`로 LTR feature 정규화.

Vespa `bm25_wine()` 함수의 정규화: `bm25_wine / (bm25_wine + 25)` (K=25).

`sparseRawScore`는 이미 Vespa hybrid profile의 **합산 BM25 블렌드** 결과 (0.5×bm25 + 0.5×closeness).
하지만 실제 `hit.relevance`는 rank profile 전체 blend score (bm25_normalized + closeness + popularity).
saturate 대상이 순수 BM25 원값이 아님 → BM25_SATURATION_POINT 의미가 모호.

**근거**
- `src/domain/ranking/service/ltr-feature-extractor.ts` — `BM25_SATURATION_POINT = 12`
- `vespa/app/schemas/wine_entity.sd` — `bm25_wine / (bm25_wine + 25)` (K=25)
- `src/infrastructure/vespa/vespa-search-index.ts` — `score: hit.relevance` (전체 blend)
- Vespa hybrid profile: `0.4×bm25_normalized + 0.3×closeness + 0.1×popularity + bonus`

**긴급도** 🟠 P1
`bm25Score` LTR feature가 실제로는 "hybrid blend score saturated at K=12"를 표현함.
BM25 단독 신호가 아님 → LTR 학습 시 feature 의미 오염. 변수명 및 상수 재검토 필요.

---

### IDX-11: critic_score / drinkingWindow — 초기 coverage 0% (Track C 미실행) 🟠 P1

**문제**
`validate-silver.ts` coverage gate 기준:
- `criticProxy`: 목표 80%, **초기 0%** (Track C Step 1 `generate-critic-proxy.ts` 미실행)
- `drinkingWindow`: **초기 0%** (Track C Step 4 `drinking-window-backfill.ts` 미실행)

두 필드 모두 `prestige_hybrid` rank profile에서 명시적 가중치(critic 0.35, prestige 0.25) 보유.
데이터 없으면 rank expression의 `if(isNan(...), 0, ...)` fallback → 해당 신호 0 기여.

**근거**
- `scripts/etl/validate-silver.ts:40` — `minCriticProxyCoverage: 0.80`
- `scripts/etl/generate-critic-proxy.ts` — 별도 실행 필요
- `scripts/etl/drinking-window-backfill.ts` — 별도 실행 필요
- `vespa/app/schemas/wine_entity.sd:732-739` — prestige_hybrid에서 두 필드 명시 사용

**긴급도** 🟠 P1
프로덕션 prestige_hybrid ranking이 핵심 신호 없이 동작. Track C 스크립트 실행으로 즉시 개선 가능.

---

### IDX-12: producerPrestige coverage ~70%, criticScore coverage ~40% 예상 🟡 P2

**문제**
`producerPrestige`: Vivino `winery_rating / 5`. coverage ~70% (validate-silver quality gate 기준).
`criticScoreNormalized`: Track C 실행 후 ~80% 목표, 현재 ~40% 추정 (코드 주석 근거).
두 필드 모두 absent 시 `if(isNan(...), 0, ...)` → prestige_hybrid에서 0 기여.
absent를 0으로 처리하면 "데이터 없음"과 "실제 낮은 prestige"를 구분 못함.

**근거**
- `src/domain/ranking/service/signal-computer.ts:73-81` — "prestige data coverage ~40%" 주석
- `scripts/etl/validate-silver.ts` — `minProducerPrestigeCoverage = 0.70`
- `vespa/app/schemas/wine_entity.sd` — `if(isNan(attribute(producer_prestige)), 0, ...)` fallback

**긴급도** 🟡 P2
데이터 부재와 낮은 품질 구분 불가. LTR 학습 시 absent-feature 플래그 필요.

---

## 인덱싱 감사 픽스 우선순위

| 순서 | 항목 | 액션 | 파일 | 예상 효과 |
|------|------|------|------|----------|
| 1 | IDX-01+08: synthetic_queries 스키마 | 필드 선언 추가 | `vespa-schema.sd` | Doc2Query BM25 즉시 활성화 |
| 2 | IDX-02: region positive YQL | `case 'region':` 추가 | `mapping.ts` | 지역 필터 복구 |
| 3 | IDX-03: sensory 스키마 경계 수정 | `min(0).max(1)` 로 수정 | `search-response.schema.ts`, `constants.ts` | 응답 검증 오류 방지 |
| 4 | IDX-04: grapes 전체 배열 노출 | `HybridCandidate` + 매핑 수정 | `hybrid-candidate.ts`, `map-result-items.ts` | 블렌드 품종 정보 제공 |
| 5 | IDX-05: acidity soft/hard 분류 | `SOFT_CONSTRAINT_ATTRIBUTES` 검토 | `constraint-compiler.ts` | 산도 필터 정확도 개선 |
| 6 | IDX-10: BM25_SATURATION_POINT 재검토 | 변수명/값 수정 or 제거 | `ltr-feature-extractor.ts` | LTR feature 의미 명확화 |
| 7 | IDX-11: Track C 스크립트 실행 | `generate-critic-proxy.ts` 실행 | - | critic_score coverage 0% → 80% |
| 8 | IDX-09: current_year 하드코딩 | `query(current_year)` 파라미터화 | `vespa-schema.sd` | recency 신호 정확도 |
| 9 | IDX-06: preferenceAlignment dead signal | Feature 비활성화 or 구현 | `signal-computer.ts` | LTR feature 정리 |
| 10 | IDX-07: oak/cert/producer_type 추출 | LLM schema + rule extractor 확장 | `llm-constraint-schema.ts` | 필터 커버리지 확대 |
| 11 | IDX-12: absent-feature 플래그 | ComponentScores 확장 | `signal-computer.ts` | LTR 학습 품질 개선 |

*인덱싱 감사 수행: 10-에이전트 병렬, 2026-04-10*

---

## Wave 2 감사 — 추가 8바퀴 (2026-04-10)

쿼리 정규화, 응답 빌더, 피드백/캘리브레이션, 오케스트레이션, Vespa 쿼리 빌더, 옵저버빌리티, HTTP 컨트랙트 감사.

---

## W2-P0 — 사일런트 데이터 손실

### W2-BUG-01: `learned_sparse` rank profile 주석 처리됨 — YQL 쿼리 reject

**문제**
`vespa-search-index.ts:483`는 `'ranking.profile': 'learned_sparse'`를 하드코딩해서 전송한다.
그런데 `vespa-schema.sd`의 `learned_sparse` rank profile이 주석 처리(commented out)되어 있다.
Vespa는 존재하지 않는 rank profile 요청을 reject하고 default(bm25)로 fallback한다.
SPLADE 채널에 투자한 인프라가 실제로 동작하지 않는다.

**근거**
- `src/infrastructure/vespa/vespa-search-index.ts:483` — `'ranking.profile': 'learned_sparse'` 전송
- `src/infrastructure/vespa/vespa-schema.sd` — `learned_sparse` rank profile 주석 처리
- `src/domain/retrieval/service/candidate-pool.ts:839` — `resolveVespaRankProfile()`에서 `'learned_sparse'` 입력 시 `default: return 'hybrid'` 반환 (case 없음)

**긴급도** 🔴 P0
SPLADE/learned sparse 채널이 실제로 ranking에 기여 안 함. 두 가지 버그 동시 존재: 스키마 주석 + rank profile 선택 오류.

---

## W2-P1 — 운영 리스크

### W2-BUG-02: Vespa 클라이언트 circuit breaker 없음

**문제**
`CohereReranker`, `OpenAI`, `Anthropic` LLM은 모두 circuit breaker가 등록되어 있다.
`VespaClient`에는 circuit breaker가 전혀 없다. retry(2회, 200ms~2s)만 존재.
Vespa 노드 다운 시: 모든 요청이 3회씩 full timeout 대기 → 레이턴시 폭발 → 연쇄 장애.

**근거**
- `src/infrastructure/vespa/vespa-client.ts:257` — circuit breaker property 없음
- `src/infrastructure/vespa/vespa-client.ts:326` — `withRetry()`만 사용
- `src/observability/circuit-breaker-registry.ts` — Vespa 등록 없음
- `src/infrastructure/ai/cohere-reranker.ts:70-84` — 비교: CohereReranker는 등록됨

**긴급도** 🟠 P1
가장 크리티컬한 의존성(Vespa)이 가장 보호받지 못함. BUG-03(HttpCrossEncoderReranker CB 없음)과 같은 패턴, 더 높은 충격.

---

### W2-BUG-03: Redis circuit breaker 없음 + silent skip counter 미사용

**문제**
Redis 연결 에러는 `log.error()`만 기록하고 circuit breaker가 없다.
`silent-skip-counters.ts`에 `'cache_write_failure'`, `'cache_read_failure'`, `'json_parse_failure'` 세 종류가 선언되어 있으나
실제 코드 어디에서도 increment 호출이 없다 — dead declaration.

**근거**
- `src/infrastructure/db/redis-client.ts:20-26` — `client.on('error')` → log only, no CB
- `src/observability/silent-skip-counters.ts:21-28` — 3개 카운터 선언
- `src/infrastructure/cache/redis-query-cache.ts:89-92` — write 실패 시 `log.error()` only, increment 없음
- `src/infrastructure/cache/redis-embedding-cache.ts` — 동일 패턴

**긴급도** 🟠 P1
캐시 실패가 완전히 불투명. 운영 중 Redis 장애 시 아무 메트릭도 없음.

---

### W2-BUG-04: AbortSignal이 Vespa fetch 레벨까지 전달 안 됨

**문제**
AbortSignal은 HTTP → SearchUseCase → CandidatePool까지 전달된다.
그런데 `SearchIndexPort`의 `sparseSearch()`, `denseSearch()`, `searchLearnedSparse()` 메서드 시그니처에 `abortSignal` 파라미터가 없다.
사용자가 HTTP 요청을 취소해도 Vespa 쿼리는 계속 실행된다.

**근거**
- `src/domain/retrieval/port/search-index.port.ts:153, 169, 189` — 파라미터에 abortSignal 없음
- `src/domain/retrieval/service/candidate-pool.ts:346-504` — `input.requestContext?.abortSignal` 있지만 sparseTask/denseTask에 전달 안 함
- `src/interface/http/request-abort-signal.ts` — HTTP 레벨에서 signal 생성 ✓

**긴급도** 🟠 P1
취소된 요청이 Vespa에서 계속 실행됨. 트래픽 스파이크 시 불필요한 Vespa 부하 누적.

---

### W2-BUG-05: request_id가 downstream 서비스로 전파 안 됨

**문제**
Fastify는 `request.requestId`를 생성하고 로그에 기록한다.
Vespa, 임베딩 서비스, reranker HTTP 호출에 `X-Request-Id` 헤더가 전송되지 않는다.
장애 디버깅 시 서비스 간 로그 연결 불가.

**근거**
- `src/interface/http/middleware/request-context.ts:56-86` — requestId 생성 ✓
- `src/infrastructure/vespa/vespa-client.ts:338` — `JSON.stringify(body)` — requestId 없음
- `src/infrastructure/vespa/embedding-service.ts:117-125` — 헤더에 requestId 없음
- `src/infrastructure/vespa/reranker.ts:121` — 동일
- `src/infrastructure/ai/cohere-reranker.ts` — 동일

**긴급도** 🟠 P1
운영 인시던트 시 cross-service 트레이싱 불가. SOTA++ 옵저버빌리티 미달.

---

## W2-P2 — 구조적 갭

### W2-BUG-06: `popularity_native` rank profile 미사용

**문제**
`vespa-schema.sd`에 `popularity_native` rank profile이 선언되어 있다.
`resolveVespaRankProfile()` switch에 이 profile을 선택하는 case가 없다.
트렌딩/인기 모드에서 popularity 신호를 Vespa 레벨에서 활용할 방법이 없다.

**근거**
- `src/infrastructure/vespa/vespa-schema.sd:276-284` — `popularity_native` profile 정의
- `src/domain/retrieval/service/candidate-pool.ts:839-849` — switch에 case 없음

**긴급도** 🟡 P2
기능 버그는 아님. popularity 기반 정렬이 필요한 모드 구현 시 활용 필요.

---

### W2-BUG-07: `wine_aware` rank profile 선언만 있고 미사용

**문제**
Vespa 앱 스키마에 `wine_aware` rank profile이 선언되어 있다 (body/acidity/tannin range boosting).
어떤 retrieval mode에서도 선택되지 않는다.
taste-preference 쿼리("풀바디 높은 타닌")에서 Vespa 레벨 taste boosting 불가.

**긴급도** 🟡 P2
SOTA++ taste-preference retrieval 미활용.

---

### W2-BUG-08: 퀴리 정규화 — fullwidth 문자 미처리 (D-Z, a-z)

**문제**
`unicode-normalize.ts`의 `HOMOGLYPH_MAP`에 fullwidth A, B, C (Ａ→A, Ｂ→B, Ｃ→C) 3개만 있다.
나머지 fullwidth Latin D-Z (U+FF24-FF3A), a-z (U+FF41-FF5A)는 매핑 없음.
NFC normalization은 fullwidth를 변환하지 않는다 (NFKC가 필요).
`"ｃabernetｓauvignon"` 같은 쿼리가 정규화되지 않아 alias 매칭 실패.

**근거**
- `src/domain/shared/utils/unicode-normalize.ts:104-107` — A, B, C 3개만
- `src/domain/query/service/query-normalizer.ts:220` — `normalize('NFC')` 사용, NFKC 아님

**긴급도** 🟡 P2
실제 사용 빈도는 낮지만 발생 시 silent 매칭 실패.

---

### W2-BUG-09: alpha 상수 분산 — 테스트에서 0.1 하드코딩, 프로덕션은 0.3

**문제**
`resolver.ts:84`에 `DEFAULT_ALPHA = 0.3`이 선언되어 있다 (alpha=0.1이 96% abstain 유발로 0.3으로 변경됨).
`decision-engine.test.ts:96, 694`는 `0.1`을 magic number로 하드코딩한다.
alpha 재튜닝 시 테스트가 프로덕션과 달라지는 것을 감지 못함.

**근거**
- `src/domain/resolver/service/resolver.ts:84` — `DEFAULT_ALPHA = 0.3`
- `src/domain/decision/__tests__/decision-engine.test.ts:96` — hardcoded `0.1`
- `src/domain/decision/__tests__/decision-engine.test.ts:694` — hardcoded `0.1`

**긴급도** 🟡 P2
CLAUDE.md Rule 30 위반: 2개 이상 파일에서 사용되는 상수는 shared SSoT에서만 관리.

---

### W2-BUG-10: 피드백 → 캘리브레이션 파이프라인 미연결

**문제**
피드백 수집(`POST /v1/feedback`)과 저장(`FeedbackProcessor`)은 구현되어 있다.
캘리브레이션 학습(`buildCalibrationReport()`)은 오프라인 NDJSON만 입력으로 받는다.
라이브 피드백 → 캘리브레이션 학습을 자동으로 트리거하는 파이프라인이 없다.
캘리브레이션 테이블이 비어 있으면 프로덕션에서 `requireTrainedParams: true` 설정으로 startup error 발생.

**근거**
- `src/interface/http/routes/feedback.route.ts:68` — 피드백 수집 ✓
- `src/domain/calibration/service/calibration-suite.ts:42` — NDJSON만 입력, 라이브 피드백 연결 없음
- `src/config/container-core-builders.ts:56` — `requireTrainedParams: true`
- `src/domain/resolver/service/calibrator.ts:87-90` — empty table → startup error

**긴급도** 🟡 P2
SOTA++ 피드백 루프 미완성. 캘리브레이션 데이터 없이 프로덕션 배포 시 startup 실패.

---

### W2-BUG-11: `z.record()` 무제한 — policy/uncertainty 필드

**문제**
`search-response.schema.ts:434-435`의 `policy: z.record(z.unknown())`와 `uncertainty: z.record(z.unknown())`에 키 개수 제한이 없다.
CLAUDE.md는 모든 무제한 컬렉션에 크기 제한을 요구한다.
같은 파일에 `boundedRecord()` 헬퍼가 line 15에 존재하지만 이 두 필드에 미적용.

**근거**
- `src/interface/http/schemas/search-response.schema.ts:434-435`
- `src/interface/http/schemas/search-shared.schema.ts:15` — `boundedRecord()` 헬퍼 존재

**긴급도** 🟡 P2
CLAUDE.md 스키마 품질 바 위반. 악의적/버그성 응답에서 메모리 소비 가능.

---

### W2-BUG-12: 설명(explanation)이 제약 조건과 ungrounded

**문제**
`synthesiseEvidenceSummary()`는 evidence item의 provenance 문자열만 사용해 설명을 생성한다.
실제 제약 조건(`QueryPlanV1.constraints`)을 받지 않는다.
"soft constraint satisfaction" 같은 generic 텍스트가 나오지 "타닌 선호도 매칭"처럼 구체적 설명이 나오지 않는다.

**근거**
- `src/domain/response/service/human-response-builder-v2.ts:50-85` — `synthesiseEvidenceSummary()`, constraints 파라미터 없음
- `src/domain/ranking/service/evidence-mapper.ts:77` — `provenance: 'Weighted satisfaction of soft and inferred constraints'` 하드코딩

**긴급도** 🟡 P2
사용자 경험에 직접 영향. SOTA++ explainability 미달.

---

## Wave 2 픽스 우선순위 요약

| 순서 | 항목 | 파일 | 긴급도 |
|------|------|------|--------|
| 1 | W2-BUG-01 learned_sparse 스키마 주석 해제 + rank profile case 추가 | `vespa-schema.sd`, `candidate-pool.ts` | P0 |
| 2 | W2-BUG-02 Vespa circuit breaker | `vespa-client.ts` | P1 |
| 3 | W2-BUG-03 Redis CB + silent skip counter 실제 호출 | `redis-client.ts`, `redis-*-cache.ts` | P1 |
| 4 | W2-BUG-04 AbortSignal → SearchIndexPort | `search-index.port.ts`, `candidate-pool.ts` | P1 |
| 5 | W2-BUG-05 request_id downstream 전파 | `vespa-client.ts`, `embedding-service.ts`, `reranker.ts` | P1 |
| 6 | W2-BUG-09 alpha 상수 SSoT | `decision-engine.test.ts` | P2 |
| 7 | W2-BUG-11 z.record() boundedRecord() 적용 | `search-response.schema.ts` | P2 |
| 8 | W2-BUG-10 피드백→캘리브레이션 파이프라인 | 신규 job 추가 | P2 |
| 9 | W2-BUG-08 fullwidth NFKC 정규화 | `unicode-normalize.ts` | P2 |
| 10 | W2-BUG-12 explanation grounding | `human-response-builder-v2.ts` | P2 |
| 11 | W2-BUG-06/07 rank profile 활용 | `candidate-pool.ts` | P2 |

*Wave 2 감사 수행: 6-에이전트 병렬, 2026-04-10*

---

## Deep Scan — 3차 10-에이전트 병렬 감사 결과 (2026-04-10)

Rule 17/18/19/20/21/28/30/31, LLM JSON 파싱, Korean regex, HTTP 에러 핸들링 집중 감사.

---

### BUG-DS01: `agent-orchestrator.ts` — catch 블록 flag 설정 후 control flow 누락 ×3 (Rule 19)

**문제**
agent 실행 루프 내 Rule 19 위반 3건. flag 설정 후 break/return 없어 루프가 corrupted state로 계속 실행됨:

1. **line ~557**: `llmCircuitOpen = true` 설정 후 break 없음 → 다음 iteration에서 LLM 호출 계속
2. **line ~741-744**: timeout 핸들러가 `terminationReason = 'timeout'` 설정 후 break 없음 → policy check로 fall-through
3. **line ~873**: timeout abort 후 break 없음 → policy-block check로 fall-through

**근거**
- `src/application/agent/agent-orchestrator.ts:557,741,873`
- CLAUDE.md Rule 19: "A flag without control flow is a silent bug — the loop continues executing with corrupted state. This was the #3 bug class."
- 이전 bugbash: "policy-blocked queries continued calling tools" 기록과 동일 패턴 재발

**긴급도** 🔴 P0
circuit breaker가 열려도 LLM 호출 지속 → 비용 폭발 + timeout 연쇄 가능.

---

### BUG-DS02: LLM tool input — numeric 필드 string 입력 전량 reject (Schema quality bar)

**문제**
LLM이 `"limit": "10"` 처럼 숫자를 string으로 emit 시 Zod가 전량 reject. `tool-executor.ts`, `agent-tools.ts`, `llm-constraint-schema.ts`의 numeric 필드가 모두 `z.number()` 단독 사용.
`llm-relevance-labeler.ts:72-83`에 올바른 패턴이 이미 존재하지만 미적용.

**위반 위치**
- `src/domain/attribute/model/llm-constraint-schema.ts:46` — `confidence: z.number().finite()`
- `src/interface/claude-tools/tool-executor.ts:39,53,65` — `limit`, `max_price`, `target_year`
- `src/application/agent/agent-tools.ts:71,80,87-89,121,131-133` — `limit`, `max_price_krw`, `vintage_min/max`, `target_year`, `max_price`

**올바른 패턴** (`llm-relevance-labeler.ts:72` 참고):
```typescript
const coerceFiniteNumber = z.union([z.number(), z.string().transform(Number)]).pipe(z.number().finite());
```

**긴급도** 🔴 P0
LLM string numeric emit → tool call validation error → agent 도구 사용 불가 상태 진입.

---

### BUG-DS03: `agent-orchestrator.ts:192-193` — deprecated `step.action` migration fallback 없음 (Rule 31)

**문제**
`recoverLastSearchInput()`에서 deprecated `step.action`을 `step.actionPairs ?? step.action` fallback 없이 직접 접근.
같은 파일 내 `agent-prompt.ts:125-146`에 올바른 패턴(`eslint-disable` + fallback)이 있는데 미적용.

**추가 위반** (eslint-disable + TODO(cleanup) 주석 누락만):
- `src/domain/retrieval/service/sparse-hit-to-candidate.ts:54` — `retrievalFusionScore` deprecated field 설정
- `src/infrastructure/vespa/vespa-similar-retrieval.ts:43` — 동일
- `src/domain/retrieval/service/fusion.ts:193` — 동일

**근거**
- `src/application/agent/agent-orchestrator.ts:192-193`
- CLAUDE.md Rule 31

**긴급도** 🟠 P1
`actionPairs`만 있는 최신 step에서 `recoverLastSearchInput()` 실패 → agent 재시도 시 빈 쿼리.

---

### BUG-DS04: RRF k=60 — `per-class-fusion-config.ts`, `retrieval-profile.ts` SSoT 미사용 (Rule 30)

**문제**
BUG-05(`fusion.ts`)에 더해 추가 위반 2건:
- `src/domain/retrieval/service/per-class-fusion-config.ts:18` — `RRF_K_DEFAULT = 60` 독립 선언
- `src/domain/retrieval/service/retrieval-profile.ts:66,79,92` — magic number `fusionK: 60` 리터럴 4곳

`rrf.ts:9`의 `RRF_DEFAULT_K`를 import 없이 각자 선언. k 튜닝 시 partial update 위험.

**긴급도** 🟠 P1
BUG-05와 묶어서 일괄 수정. `rrf.ts`에서 import 후 `RRF_DEFAULT_K` 사용으로 통일.

---

### BUG-DS05: `SECONDS_PER_MINUTE` / `MINUTES_PER_HOUR` 5개 파일 중복 선언 (Rule 30)

**문제**
시간 단위 상수를 공유 모듈 없이 각 파일이 독립 선언:
- `src/interface/http/retry-after-from-rate-limit-message.ts`
- `src/infrastructure/cache/redis-phrase-cache.ts`
- `src/domain/ranking/service/ranker.ts`
- `src/domain/learning/service/retrain-orchestrator.ts`
- `src/domain/learning/service/feedback-processor.ts`

**긴급도** 🟡 P2
기능 버그 아님. `src/domain/shared/utils/time-units.ts` 추출 후 import 통일.

---

### BUG-DS06: `watchlist-policy.ts:82` — `expiresAt.getTime()` NaN 가드 없음 (Rule 28)

**문제**
`isWatchlistEntryActive()`에서 `entry.expiresAt.getTime() > now.getTime()` 비교 전 `Number.isFinite()` 가드 없음.
HTTP layer에서는 Zod로 검증되지만 JSONB 역직렬화/DB 손상 시 invalid Date가 도달하면 `NaN > number = false` → 유효한 watchlist entry가 만료 처리.

**근거**
- `src/domain/watchlist/service/watchlist-policy.ts:82`
- `src/infrastructure/adapter/pg-entity-repository.ts:39-46` — `parseDateOrFallback()` 올바른 가드 패턴 존재
- CLAUDE.md Rule 28

**긴급도** 🟡 P2
`Number.isFinite(expiresAtMs)` 가드 추가 + fail-safe = expired 처리.

---

### BUG-DS07: `field-normalizer.ts:70` — `Number()` 결과 `isFinite` 가드 없음 (Schema quality bar)

**문제**
`normalizeVolume()`에서 regex `^(\d+)$` 매치 후 `Number(bareNumber[1])` 결과를 `isFinite` 검증 없이 직접 비교.
CLAUDE.md schema quality bar: 외부 입력 `Number()` 결과는 무조건 `Number.isFinite()` 후 사용.

**근거**
- `src/domain/ingestion/service/field-normalizer.ts:70-73`

**긴급도** 🟡 P2
regex가 digit-only 보장하지만 방어적 가드 추가 필요.

---

### BUG-DS08: `pg-alias-repository.ts:104` — `Math.ceil(N/2)` 경계 테스트 없음 (Rule 18)

**문제**
fuzzy alias 매칭 prefix 길이 `Math.ceil(normalized.length / 2)` — ceil vs floor 선택 의도 미문서화, N=1,2,3,4 경계 테스트 없음.

**근거**
- `src/infrastructure/adapter/pg-alias-repository.ts:104`
- `src/domain/alias/__tests__/alias-matcher.test.ts` — N=4만 존재

**긴급도** 🟡 P2
주석으로 `≥50% recall을 위해 ceil 선택` 문서화 + N=1,2,3,4 테스트 추가.

---

### ✅ PASS (이상 없음 — 3차 감사)

- **for...of with break (Rule 17)**: 전체 22개 루프 검토, 모두 correct (limit/dedup/kill-switch 용도)
- **budget guard ordering (Rule 20)**: cache eligibility, promotion gate, assembly quota 모두 expensive op 이전에 guard
- **toLocaleString() (Rule 21)**: src/ 전체 미사용 ✓
- **Math.random() for ID**: jitter backoff 전용으로만 사용, ID 생성은 `crypto.randomUUID()` ✓
- **HTTP RFC-014 envelope**: 모든 error handler 경로 준수, fabricated 200 OK 없음 ✓
- **Korean regex (Rule 8/134)**: 29개 파일 전수 검토, bare syllable 없음, `/u` flag 100% ✓

---

## 3차 Deep Scan 픽스 우선순위 요약

| 순서 | 항목 | 예상 작업 | 파일 |
|------|------|----------|------|
| 1 | BUG-DS01 catch flag → control flow | break/return 추가 ×3 | agent-orchestrator.ts:557,741,873 |
| 2 | BUG-DS02 LLM tool numeric coercion | `z.union([z.number(), z.string()])` 패턴 적용 | tool-executor.ts, agent-tools.ts, llm-constraint-schema.ts |
| 3 | BUG-DS03 deprecated step.action fallback | migration fallback + eslint-disable | agent-orchestrator.ts:192, sparse-hit-to-candidate.ts:54, fusion.ts:193 |
| 4 | BUG-DS04 RRF k SSoT 나머지 | `rrf.ts` import 통일 | per-class-fusion-config.ts, retrieval-profile.ts |
| 5 | BUG-DS05 시간 단위 상수 통합 | shared time-units.ts 추출 | 5개 파일 |
| 6 | BUG-DS06 watchlist expiresAt NaN 가드 | `Number.isFinite()` 추가 | watchlist-policy.ts:82 |
| 7 | BUG-DS07 field-normalizer Number() 가드 | `Number.isFinite()` 추가 | field-normalizer.ts:70 |
| 8 | BUG-DS08 alias prefix ceil 경계 테스트 | N=1,2,3,4 테스트 + 주석 | pg-alias-repository.ts, alias-matcher.test.ts |

*3차 Deep Scan 수행: 10-에이전트 병렬 (3개 rate-limit 재실행 포함), 2026-04-10*

---

## 4차 심층 감사 — 수학/HTTP/Redis/쿼리/Fusion/LLM/CB/DB/관측성/ETL (2026-04-10)

> 10-에이전트 병렬. scoring math, YQL, Redis cache, regex, fusion, LLM, circuit breaker, PostgreSQL, 관측성, ETL 전 영역 커버.

### SCAN4-01: `sparseRank ∈ (0,1)` — 인기도 신호 역전 🔴 P0
**문제** `computePopularity()`: `Math.log(0.5)≈-0.693` → `1/(1-0.693)≈3.26` → clamp 1.0. `Math.log(0.1)≈-2.3` → `1/(1-2.3)≈-0.77` → clamp 0. rank가 작을수록 popularity가 0이 되는 역전 현상.
**근거** `src/domain/ranking/service/signal-computer.ts` `computePopularity()` — 가드가 `=== undefined`만 체크, `< 1` 미체크.
**긴급도** 🔴 P0. Fix: `if (sparseRank === undefined || sparseRank < 1) return POPULARITY_NO_SPARSE_BASELINE;`

### SCAN4-02: OpenAI 임베딩 — circuit breaker 미등록 🔴 P0
**문제** `openai-embedding-service.ts`: timeout 있으나 CB 없음. Cohere(`cohere-reranker.ts:75-84`)와 비대칭.
**근거** `src/infrastructure/ai/openai-embedding-service.ts` — `globalCircuitBreakerRegistry.register()` 없음.
**긴급도** 🔴 P0. Fix: Cohere 패턴 복사.

### SCAN4-03: Vespa 검색 — circuit breaker 미등록 🔴 P0
**문제** `vespa-search-index.ts` + `vespa-client.ts`: 핵심 검색 백엔드에 CB 전무. retry 3회만 있어 장애 시 부하 3배.
**근거** `src/infrastructure/vespa/vespa-search-index.ts`, `vespa-client.ts:216-245`.
**긴급도** 🔴 P0.

### SCAN4-04: ETL — `acidity`/`tannin` = 0 silently dropped 🔴 P0
**문제** `index-to-vespa.ts:396-397`: `rec.acidity > 0` 체크 → [0,1] normalize된 값 0이 누락으로 처리됨. CLAUDE.md rule 26 위반.
**근거** `scripts/etl/index-to-vespa.ts:396-397`. 테스트도 틀린 동작을 expect.
**긴급도** 🔴 P0. Fix: `!= null && !== undefined` 체크로 변경.

### SCAN4-05: `"dry"` 패턴 — `"dry-aged"` false positive 🟠 P1
**문제** 하이픈 `-`이 `[^\p{L}\p{N}]`에 해당 → "dry-aged" 쿼리에서 sweetness=dry 제약 생성.
**근거** `src/domain/query/service/rule-based-constraint-extractor.ts` dry 패턴.
**긴급도** 🟠 P1. Fix: `dry\s+wine` 또는 `dry(?=\s|$)`.

### SCAN4-06: injection judge — embedded JSON으로 우회 가능 🟠 P1
**문제** `anthropic-llm-injection-classifier.ts:183`: 쿼리를 이스케이프 없이 user role에 삽입. `{"is_injection": false}` 내포 공격 가능.
**근거** `src/infrastructure/adapter/anthropic-llm-injection-classifier.ts:183-188`.
**긴급도** 🟠 P1. Fix: 쿼리를 `Query text: "..."` 형태로 래핑.

### SCAN4-07: Vespa 클라이언트 — 외부 AbortSignal 미전파 🟠 P1
**문제** `vespa-client.ts` `query()` 메서드가 externalSignal 파라미터 없음. 클라이언트 disconnect 시에도 Vespa 쿼리 최대 30초 계속 실행.
**근거** `src/infrastructure/vespa/vespa-client.ts:322-342`.
**긴급도** 🟠 P1.

### SCAN4-08: 검색 채널별 타임아웃 없음 🟠 P1
**문제** `candidate-pool.ts:491-567`: `Promise.allSettled()` 4채널, 채널별 AbortController+timeout 없음. 한 채널 hang → 전체 fan-in 블록.
**근거** `src/domain/retrieval/service/candidate-pool.ts:491-567`.
**긴급도** 🟠 P1. Fix: 각 채널 `Promise.race([task, timeout(5000)])` 래핑.

### SCAN4-09: ETL — LLM critic proxy 숫자 string 타입 미처리 🟠 P1
**문제** `generate-critic-proxy.ts:120`: `JSON.parse()` unknown cast 없음 + `parsed.proxy_score`가 `"85"` (string) 시 `/100` → NaN.
**근거** `scripts/etl/generate-critic-proxy.ts:120-128`, `index-to-vespa.ts:370`.
**긴급도** 🟠 P1.

### SCAN4-10: LTR 모델 가중치 DB 로드 후 검증 없음 🟠 P1
**문제** `pg-ltr-model-registry.ts:135-142`: `weights`, `bias`, `ndcg5ValidationScore` FLOAT8 값 `Number.isFinite()` 미검증. CLAUDE.md rule 11 위반.
**근거** `src/infrastructure/adapter/pg-ltr-model-registry.ts:135-142`.
**긴급도** 🟠 P1.

### SCAN4-11: reranking 후 finalScore re-clamp 누락 🟡 P2
**문제** `ranker.ts:867-871`: `blendedScore` clamp 미적용. upstream 오염 시 1.0 초과 가능.
**근거** `src/domain/ranking/service/ranker.ts:867-871`.
**긴급도** 🟡 P2. Fix: `finalScore: clamp01(blendedScore)`.

### SCAN4-12: 기본 가중치 합 0.95 — MAX_SCORE 1.0 unreachable 🟡 P2
**문제** `scoring-weights.ts:76-91` non-penalty 합 = 0.95. 주석 "≈ 1.0" 오기.
**긴급도** 🟡 P2. Fix: 주석 수정 또는 의도 명시.

### SCAN4-13: alias 벌크 insert N+1 쿼리 🟡 P2
**문제** `pg-alias-repository.ts:158-199` 루프 내 개별 INSERT. 1000개 → 1000 쿼리.
**긴급도** 🟡 P2. Fix: multi-value INSERT.

### SCAN4-14: ETL alcohol 파싱 — 유럽식 소수점 쉼표 미처리 🟡 P2
**문제** `parseAlcohol()` regex: `.` 기대, `","` 미처리. 유럽산 데이터 alcoholPct 누락.
**근거** `scripts/etl/vivino-to-silver.ts` `parseAlcohol()`.
**긴급도** 🟡 P2.

### SCAN4-15: `generate-aliases.ts` — `\b` 사용 (CLAUDE.md rule 8) 🟡 P2
**문제** `generate-aliases.ts:174`: `new RegExp(\`\\\\b${vintageYear}\\\\b\`)`. 숫자라 실제 동작하지만 rule 8 패턴 위반.
**긴급도** 🟡 P2.

### SCAN4-16: entity resolver — 1글자 토큰 매칭 가능 🟡 P2
**문제** `entity-resolver.ts:220`: `length === 0` 거부만. 1글자 ("a", "I") 허용.
**긴급도** 🟡 P2. Fix: `key.length < 2` 로 변경.

### SCAN4-17: YQL 생성 — 보안 이슈 없음 ✅
**결론** `yqlEscapeString()`, parameterized query (`@query0`), numeric clamp, field whitelist 모두 정상. SQL/YQL injection 벡터 없음.

### SCAN4-18: Redis 캐시 — 이슈 없음 ✅
**결론** 모든 read가 Zod `getValidatedWithStats()` 사용. TTL 전 경로 설정. embedding vector `min(1)` 검증. JSON.parse → unknown cast 정상. Stampede 위험 낮음(embedding 서비스 내부 배칭).

### SCAN4-19: HTTP 레이어 — 이슈 없음 ✅
**결론** query max 500자, RFC-014 envelope 전 경로 준수, stack trace 미노출, body limit 1MiB. rate-limit 파싱 소소한 이슈(LOW).

### SCAN4-20: 관측성 — 이슈 없음 ✅
**결론** 빈 catch 없음, flag-without-break 없음, 예산 체크 pre-flight 정상, console.log src/ 내 없음, `Math.max(...spread)` 없음, `toLocaleString()` 없음.

## 4차 감사 픽스 우선순위

| 순서 | 항목 | 파일 |
|------|------|------|
| 1 | SCAN4-01 sparseRank < 1 가드 | `signal-computer.ts` |
| 2 | SCAN4-02 임베딩 CB | `openai-embedding-service.ts` |
| 3 | SCAN4-03 Vespa CB | `vespa-client.ts` |
| 4 | SCAN4-04 acidity/tannin 0-drop | `index-to-vespa.ts` |
| 5 | SCAN4-05 dry false positive | `rule-based-constraint-extractor.ts` |
| 6 | SCAN4-06 injection judge 래핑 | `anthropic-llm-injection-classifier.ts` |
| 7 | SCAN4-07/08 Vespa signal + 채널 timeout | `vespa-client.ts`, `candidate-pool.ts` |
| 8 | SCAN4-09 ETL critic proxy 타입 | `generate-critic-proxy.ts` |
| 9 | SCAN4-10 LTR 가중치 검증 | `pg-ltr-model-registry.ts` |
| 10 | SCAN4-11~16 소소한 것들 | various |

*4차 심층 감사 수행: 10-에이전트 병렬, 2026-04-10*

---

## Wave 2 감사 — 2026-04-10 (5차, 10라운드 병렬)

에이전트 파이프라인 + LLM 인프라 + 검색 파이프라인 전 구간 재감사.
실제 코드에서 근거 확인 완료된 항목만 기재. 이전 세션 수정 완료 항목(AG-01~AG-05) 제외.

---

### P1 — 높은 심각도

#### W2-01: `SOFT_CONSTRAINT_ATTRIBUTES` 5개 누락 → 하드 필터 오분류

**문제**
`constraint-compiler.ts`의 `SOFT_CONSTRAINT_ATTRIBUTES` 집합에 LLM이 실제로 추출하는 5개 속성이 빠져 있음.
해당 속성 제약이 하드 필터로 처리되어 검색 결과를 과도하게 좁힘.

```typescript
// src/domain/query/service/constraint-compiler.ts:24-27
const SOFT_CONSTRAINT_ATTRIBUTES = new Set([
  'body', 'sweetness', 'acidity', 'tannin', 'style',
  'price_band', 'occasion', 'critic_score', 'fruit_intensity', 'finish',
]);

// src/domain/attribute/model/llm-constraint-schema.ts:12-31
// LLM_ALLOWED_ATTRIBUTES에는 있으나 SOFT_CONSTRAINT_ATTRIBUTES에 없는 것:
//   'producer_prestige', 'finish_length', 'drinking_window', 'flavor_profile', 'certification'
```

nl-mapper.ts:298-302에서 `flavor_profile` 제약이 실제로 추출됨 (`과일향`, `오크향`, `꽃향`, `스파이시`, `미네랄`).
이 제약들이 hard 필터로 처리되면 인덱스가 `flavor_profile:fruity` 하드 필터로 받아 0 결과를 반환할 수 있음.

**근거**
- `src/domain/query/service/constraint-compiler.ts:24-27`
- `src/domain/attribute/model/llm-constraint-schema.ts:12-31`
- `src/domain/attribute/service/nl-mapper.ts:298-302`

**긴급도: P1** — "과일향 와인", "드링킹 윈도우 5년" 류 쿼리에서 결과 0건 가능.

**수정**
```typescript
const SOFT_CONSTRAINT_ATTRIBUTES = new Set([
  'body', 'sweetness', 'acidity', 'tannin', 'style',
  'price_band', 'occasion', 'critic_score', 'fruit_intensity', 'finish',
  'producer_prestige', 'finish_length', 'drinking_window', 'flavor_profile', 'certification',
]);
```

---

#### W2-02: `anthropic-chat-llm.ts` — cache 토큰 `?? 0`이 NaN을 통과시킴

**문제**
`??`는 null/undefined만 체크하므로 API가 NaN을 반환하면 산술 연산으로 흘러들어감.
`baseInputTokens = (usage?.input_tokens ?? 0) + cacheCreationTokens`에서 `cacheCreationTokens`가 NaN이면 `baseInputTokens = NaN`.
GenAI span의 `inputTokens`가 NaN → 비용 계산 및 관측 파이프라인 오염.

```typescript
// src/infrastructure/ai/anthropic-chat-llm.ts:226-231
const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;       // NaN 통과
const cacheCreationTokens = usage?.cache_creation_input_tokens ?? 0; // NaN 통과
const baseInputTokens = (usage?.input_tokens ?? 0) + cacheCreationTokens; // NaN 전파
```

**근거**
- `src/infrastructure/ai/anthropic-chat-llm.ts:226-231`
- ECMAScript: `NaN ?? 0 === NaN`

**긴급도: P1** — API 이상 시 토큰 계산 전체 오염. 관측성 신뢰도 하락.

**수정**
```typescript
const safeN = (n: number | undefined): number => (Number.isFinite(n) ? (n as number) : 0);
const cacheReadTokens = safeN(usage?.cache_read_input_tokens);
const cacheCreationTokens = safeN(usage?.cache_creation_input_tokens);
const baseInputTokens = safeN(usage?.input_tokens) + cacheCreationTokens;
```

---

#### W2-03: `openai-chat-llm.ts` — `usage.prompt_tokens ?? 0` NaN 통과 (동일 패턴)

**문제**
W2-02와 동일 패턴. OpenAI usage 필드가 NaN이어도 `?? 0`이 통과시킴.

```typescript
// src/infrastructure/ai/openai-chat-llm.ts:217-218
inputTokens: usage.prompt_tokens ?? 0,       // NaN 통과
outputTokens: usage.completion_tokens ?? 0,  // NaN 통과
```

**근거**
- `src/infrastructure/ai/openai-chat-llm.ts:70-74` — `prompt_tokens?: number`
- `src/infrastructure/ai/openai-chat-llm.ts:217-218`

**긴급도: P1** — W2-02와 동일.

**수정**
```typescript
inputTokens: Number.isFinite(usage.prompt_tokens) ? (usage.prompt_tokens as number) : 0,
outputTokens: Number.isFinite(usage.completion_tokens) ? (usage.completion_tokens as number) : 0,
```

---

### P2 — 중간 심각도

#### W2-04: `anthropic-chat-llm.ts:134` — `isAbortError()` 유틸 미사용, DOMException 미처리

**문제**
`cooperative-abort.ts`의 `isAbortError()`는 `Error`와 `DOMException` 두 타입을 모두 처리하지만,
`anthropic-chat-llm.ts`는 수동으로 `err instanceof Error && err.name === 'AbortError'`만 체크함.
Node.js fetch가 `DOMException` 타입 AbortError를 throw하는 경우 재시도 로직이 잘못 동작.

**근거**
- `src/domain/shared/cooperative-abort.ts:8-16` — 완전한 isAbortError
- `src/infrastructure/ai/anthropic-chat-llm.ts:134` — 불완전한 수동 체크

**긴급도: P2** — Node.js 18+ fetch 사용 시 DOMException AbortError 미처리 가능.

**수정**
```typescript
import { isAbortError } from '../../../domain/shared/cooperative-abort.js';
// 수동 체크 → isAbortError(err) 로 교체
```

---

#### W2-05: `llm-circuit-breaker-classifier.ts` — breaker 상태 확인과 실행 사이 TOCTOU

**문제**
`runUnderLlmBreaker()` 내에서 `breaker.state === 'OPEN'` 확인 후 실제 `fn()` 호출 사이에
다른 concurrent 요청이 breaker를 열 수 있음. `breaker.execute()` API의 원자적 처리를 우회함.

**근거**
- `src/infrastructure/ai/llm-circuit-breaker-classifier.ts:128-140`

**긴급도: P2** — 트래픽 피크 시 간헐적으로 OPEN 상태에서 요청이 통과 가능.

---

### P3 — 낮은 심각도

#### W2-06: `lambdamart-ranker.ts:216` — 불필요한 `featureNames[0]` 폴백이 오류를 숨김

**문제**
```typescript
const fname = (featureNames[j] ?? featureNames[0]) as keyof RankingFeatures;
```
`j`는 항상 유효 범위 내이므로 폴백이 불필요. 인덱스 버그 발생 시 오류 대신 잘못된 feature 이름을 사용하게 됨.

**근거** — `src/domain/ranking/service/lambdamart-ranker.ts:216`

**긴급도: P3** — 기능적 버그 아님. 방어 코드가 오류를 숨기는 역설적 패턴.

---

### Wave 2 수정 우선순위 요약

| ID | 파일 | 핵심 문제 | 긴급도 |
|----|------|----------|--------|
| W2-01 | constraint-compiler.ts:24-27 | SOFT_CONSTRAINT_ATTRIBUTES 5개 누락 | **P1** |
| W2-02 | anthropic-chat-llm.ts:226-231 | cache 토큰 NaN 통과 | **P1** |
| W2-03 | openai-chat-llm.ts:217-218 | usage 토큰 NaN 통과 | **P1** |
| W2-04 | anthropic-chat-llm.ts:134 | isAbortError 유틸 미사용 | P2 |
| W2-05 | llm-circuit-breaker-classifier.ts:135 | breaker TOCTOU | P2 |
| W2-06 | lambdamart-ranker.ts:216 | featureNames[0] 폴백 | P3 |

*5차 감사 수행: 10-라운드 병렬, 2026-04-10*

---

## P0/P1 심층 RCA — 6차 10-에이전트 병렬 (2026-04-10)

기존 P0/P1 버그 각각에 대한 코드 트레이스 기반 RCA. 실제 line number, 실패 경로, fix 스펙 포함.

---

### RCA-BUG-DS01: catch flag control flow — 실제 위반 2건 (3건 아님)

**이전 보고 정정**: 실제로는 **2건**.

**위반 1 — line 1052**: synthesis attempt 1 catch에서 `llmCircuitOpen = true` 후 break/return 없음
- flag가 attempt 2 조건(`if (!llmCircuitOpen)`)을 막긴 하나, fallback search (line 1082+)는 계속 실행
- **fix**: line 1052 이후 `return` 추가

**위반 2 — line 1072**: synthesis attempt 2 catch에서 동일 패턴
- **fix**: line 1072 이후 `return` 추가

**정상 패턴 (위반 아님)**: line 566, 747, 880 모두 flag + 즉시 `break` ✓

---

### RCA-BUG-DS02: LLM numeric string — agent 경로는 self-healing, tool-executor는 throw

**실제 실패 경로 재평가**:

agent 경로(`agent-tools.ts`): `safeParse()` → `{success: false}` → error observation string 반환 → LLM이 읽고 수정 후 retry 가능. **crash 없음**.

tool-executor.ts 직접 호출 경로: `.parse()` → ZodError throw → caller가 잡아야 함.

**결론**: P0 → **P1으로 하향**. 하지만 LLM retry 낭비(token + latency) 있으므로 수정 필요. `coerceFiniteNumber` 패턴(`llm-relevance-labeler.ts:72`) 일괄 적용.

---

### RCA-BUG-01: `region` positive filter drop — single-value만 깨짐

**코드 트레이스 완료**:
- `region:Burgundy` (single) → `mapping.ts` switch default → **스킬런트 드롭** ❌
- `region_in:Burgundy|Bordeaux` (multi) → default case line 1027 → OR 절 생성 ✅
- `region_not:Burgundy` (negation) → line 985 case → NOT 절 생성 ✅

**fix 1줄**: `mapping.ts` line 803 이후에 추가:
```typescript
case 'region':
  clauses.push(`region contains ${yqlString(value)}`);
  break;
```

---

### RCA-BUG-02: `synthetic_queries` — 스키마 + rank profile 둘 다 수정 필요

**확인**: `vespa-schema.sd` 44개 필드 전수 감사 — `synthetic_queries` 1개만 누락.

**fix 2단계**:
1. 필드 선언 추가: `field synthetic_queries type array<string> { indexing: summary | index }`
2. `bm25` rank profile에 `+ 0.5 * bm25(synthetic_queries)` 추가 (가중치 튜닝 필요)

스키마만 추가하고 rank profile 미수정 시 인덱싱만 되고 BM25 매칭은 여전히 동작 안 함.

---

### RCA-BUG-03: `HttpCrossEncoderReranker` — self-hosted 환경에서만 발생

**사용 조건**: `COHERE_API_KEY` 없음 + `RERANKER_SERVICE_URL` 설정 시. Cohere 사용 환경은 해당 없음.

**cascade**: endpoint down → 매 요청 30초 대기 → 동시 N요청 → 30N초 latency → connection pool 고갈.

**fix**: `CohereReranker` 패턴 그대로 복사 (failureThreshold=5, recoveryTimeout=60s, halfOpenMaxAttempts=3) + `globalCircuitBreakerRegistry.register()`.

---

### RCA-BUG-04: anchor 임베딩 — 65-75% cache hit rate 손실 + circuit breaker bypass

**정상 경로 (dense, line 366-372)**: `cacheService.getOrEmbedBatch()` → Redis → CB → embedBatch()

**버그 경로 (anchor, line 444-445)**: `embeddingService.embed()` 직접 → Redis 없음, CB 없음

embedding service 장애 시 dense는 graceful degrade, anchor는 exception 전파.

**fix**:
```typescript
const anchorResults = await this.cacheService.getOrEmbedBatch(
  [anchorProfile.semanticSummary], this.embeddingModelId, this.embeddingService,
);
const anchorEmbedding = anchorProfile.embedding ?? anchorResults[0];
if (!anchorEmbedding) throw new Error('anchor embedding failed');
```

---

### RCA-RCA01: entropy abstain — threshold 올려도 안 되는 수학적 이유

**핵심**: heuristic score 분포 [0.2, 0.6] → softmax entropy ≈ **0.9993**. threshold 0.95도 여전히 트리거.

| threshold | 예상 abstain율 |
|-----------|---------------|
| 0.82 (현재) | 83% |
| 0.95 | ~80% |
| 0.99 | ~50% |

**근본 원인**: entropy gate는 LTR score (logit 기반, 넓은 분포) 전제로 설계됨. heuristic weights는 [0,1] clamped linear sum → 항상 tight cluster → 항상 고entropy.

**즉시 fix**: LTR 미사용 시 entropy gate bypass:
```typescript
if (!ltrAvailable) return { abstain: false };
```
**근본 fix**: LTR 모델 학습 (`run-eval-and-train-ltr.ts` 실행).

---

### RCA-RCA04: conformal calibration — alpha 불일치 + identity fallback 메커니즘

**alpha 위치**:
- `src/domain/resolver/service/resolver.ts:84` → `DEFAULT_ALPHA = 0.3`
- `scripts/eval/run-offline-eval.ts:2106` → `CONFORMAL_ALPHA = 0.1`

**identity fallback (DB 비어있을 때)**: `breakpoint_count: 0` → `clamp01(rawScore)` passthrough → conformal gate `score >= 0.7` 요구 → uncalibrated score [0.5, 0.7) 구간 전량 ambiguous → 91.2% avoidable_abstain.

**calibration 생성 스크립트 존재**: `scripts/eval/calibration-report.ts` — eval corpus로 실행하면 DB 채울 수 있음.

**fix 순서**: SSoT 모듈(`conformal-config.ts`) 생성 → alpha 통일 → `calibration-report.ts` 실행 → readiness probe 통과.

---

### RCA-BUG-06: RetrievalPlan dead fields 전수 감사

**필드 5개 감사 결과**:
| 필드 | 소비 여부 |
|------|-----------|
| `hardFilterTokens` | ❌ dead — candidate-pool이 직접 재계산 |
| `planVersion` | ❌ dead — `'retrieval-plan-v1.0'` 아무도 안 읽음 |
| `softBoosts` | ✅ signal-computer.ts:250 |
| `inferredBoosts` | ✅ signal-computer.ts:251 |
| `sensoryPriors` | ✅ extract-sensory-priors.ts:40 |

**fix**: `hardFilterTokens`, `planVersion` 인터페이스에서 삭제. `buildRetrievalPlan()` 에서 관련 계산 제거.

---

### RCA-BUG-09/10: 예산 soft + 속성 추출 누락

**BUG-09**: 의도적 설계 (`rule-based-constraint-extractor.ts:276` 주석 명시). soft 제약은 Vespa YQL WHERE절에 도달 안 함 — ranking boost만. 변경 시 팀 결정 필요.

**BUG-10**: 파이프라인 끝단(스키마, 토큰 생성, YQL 핸들러) 모두 준비됨. 빠진 것: rule-based extractor regex 패턴 ~15줄 + `llm-constraint-schema.ts` 2개 항목. 2-3시간 작업.

---

## P0/P1 RCA 종합 픽스 우선순위

| 순서 | 버그 | 핵심 fix | 예상 효과 |
|------|------|----------|-----------|
| 1 | RCA-01 entropy gate | LTR 없을 때 `return {abstain: false}` | 83% → <20% ambiguous |
| 2 | BUG-01 region filter | `mapping.ts` `case 'region':` 1줄 | region 필터 즉시 복구 |
| 3 | BUG-02 synthetic_queries | 스키마 필드 + rank profile | Doc2Query 활성화 |
| 4 | RCA-04 calibration | alpha SSoT + calibration 데이터 생성 | 91.2% avoidable_abstain 개선 |
| 5 | BUG-03 circuit breaker | HttpCrossEncoderReranker CB 추가 | 30s timeout cascade 차단 |
| 6 | BUG-04 anchor cache | `getOrEmbedBatch()` 래핑 | 65-75% embedding 호출 절감 |
| 7 | BUG-DS01 flag+control flow | line 1052, 1072에 `return` 추가 | corrupted fallback 차단 |
| 8 | BUG-DS02 numeric coercion | `coerceFiniteNumber` 패턴 적용 | LLM retry 낭비 제거 |
| 9 | BUG-06 dead fields | `hardFilterTokens`, `planVersion` 삭제 | 혼란 제거 |
| 10 | BUG-10 extractor | regex 15줄 + LLM attr 2개 추가 | organic/oak/producer 필터 |

*P0/P1 RCA 수행: 10-에이전트 병렬, 2026-04-10*

---

## 5차 심층 RCA 감사 (2026-04-10, 10-에이전트 병렬)

### RCA5-01: Abstain Gate 수학적 불가능성 (P0)

**파일**: `src/domain/query/service/abstain-policy.ts:18`

```typescript
private readonly entropyThreshold = 0.82;  // 문제
```

**RCA**: Shannon entropy H(p) = -Σ p_i log(p_i). top-10 scores가 균등하면 H=1.0, 완전 분리되면 H=0.0.
- DEFAULT_WEIGHTS 합계 = 0.95 (비정상)
- LTR 없는 경우 최대 score spread ≈ 0.15-0.25
- 10개 후보에서 spread=0.20 → 대략 H ≈ 0.87 (항상 0.82 초과)
- **따라서 LTR/reranker 없을 때 abstain은 수학적으로 불가피**

**fix**: LTR 모델 미로드 시 gate 자체를 bypass. 또는 threshold를 0.95로 높임.
```typescript
// LTR not loaded → skip entropy gate
if (!this.ltrModel?.isLoaded()) return { abstain: false };
```

---

### RCA5-02: Route/Mode 불일치 — 혼합 쿼리 (P1)

**파일**: `src/domain/query/service/planner.ts:304-402`

```
determineRoute():   anchor 체크 없음  → route = 'mixed'
determineRetrievalMode(): anchor 체크 있음 → mode = 'attribute_search'
```

**RCA**: "와인 추천해줘 부르고뉴 빨간색" 같은 쿼리:
- Route는 `mixed` (의도: hybrid dense+sparse)
- RetrievalMode는 `attribute_search` (의도: attribute-first)
- attribute_search 모드에서는 dense retrieval weight가 낮아짐
- **결과**: region은 잡히는데 semantic similarity가 억압됨

**fix**: `determineRoute()`와 `determineRetrievalMode()` 앵커 로직 동기화. 공통 helper `hasAnchorEntity(parsed)` 추출.

---

### RCA5-03: `learned_sparse` Rank Profile 데드 코드 (P0)

**파일**: `vespa/app/schemas/wine_entity.sd:701-712`, `src/infrastructure/vespa/vespa-search-index.ts:482`

**RCA**:
1. `wine_entity.sd`에서 `learned_sparse` 프로파일 완전 주석 처리 ("tensor type mismatch" 사유)
2. `vespa-search-index.ts:482`: `'ranking.profile': 'learned_sparse'` 여전히 전송
3. Vespa는 존재하지 않는 rank profile 요청 시 `default` 프로파일로 silent fallback
4. **결과**: learned sparse 결과가 `default` (TF-IDF 기반)로 순위 매겨짐 — LTR feature 전혀 적용 안 됨

```typescript
// vespa-search-index.ts:482
'ranking.profile': 'learned_sparse',  // ← 스키마에 이 프로파일 없음!
```

**fix**: 스키마에 `learned_sparse` 프로파일 복구하거나, 코드에서 `'wine_aware'`로 변경.

---

### RCA5-04: Mode Overlay 불완전 — 6/12 필드만 적용 (P1)

**파일**: `src/domain/ranking/service/ranker.ts:453-461`

**RCA**: `applyModeOverlay()` 함수가 overlay하는 필드:
```
semantic, popularity, attributeAlignment, preferenceAlignment, recency, bm25
```
**누락된 필드**:
```
entityIntegrity, softConstraint, availability, criticScore, multilingualScore, diversity
```

`producer_browse` 모드는 `entityIntegrity`와 `criticScore`를 올려야 하는데 overlay 안 됨.
`multilingual_search` 모드는 `multilingualScore`를 올려야 하는데 overlay 안 됨.

**fix**: `ScoringWeights` 인터페이스의 모든 non-penalty 필드를 overlay 대상에 포함.

---

### RCA5-05: DrinkingWindow 역전 → HTTP 500 (P1)

**파일**: `src/application/search/search-usecase-map-result-items.ts:152-164`

**RCA**:
```typescript
const drinkingWindowBlock = {
  start: result.drinkingWindowStart,  // 예: 2028
  end: result.drinkingWindowEnd,      // 예: 2025 (역전!)
};
// Zod schema: .refine(w => w.start <= w.end) → 실패 → 500
```

Track-C 백필이나 ETL 에러로 `start > end` 데이터 실제 존재 가능.
Zod refine 실패 시 unhandled error → HTTP 500.

**fix**:
```typescript
if (result.drinkingWindowStart != null && result.drinkingWindowEnd != null
    && result.drinkingWindowStart <= result.drinkingWindowEnd) {
  // 블록 생성
}
// 역전 시 드링킹 윈도우 블록 생략 (null 취급)
```

---

### RCA5-06: Agent Tool Timeout — break 누락 (P1)

**파일**: `src/application/agent/agent-orchestrator.ts:872-893`

**RCA**:
```typescript
if (err.message === 'tool_timeout') {
  this.timeoutCount++;
  // ← break 없음! falls through
}
// 다음 줄: observation = "Tool error: " + err.message
// agent는 같은 쿼리로 retry
```

timeout 후 `observation`이 generic error message로 덮어씌워짐.
agent는 "tool_timeout"을 모르므로 같은 tool call 반복 → 무한 timeout 루프 가능.

**fix**:
```typescript
if (err.message === 'tool_timeout') {
  this.timeoutCount++;
  observation = `[TIMEOUT] Tool ${toolName} timed out. Try a different approach.`;
  break;  // ← 반드시 추가
}
```

---

### RCA5-07: 혼합 통화 가격 파싱 오류 (P1)

**파일**: `src/domain/query/service/rule-based-constraint-extractor.ts:~91`

**RCA**:
```typescript
const isKoreanWon = /만원/u.test(q);  // ← 전체 쿼리 검사!
```

쿼리: "50달러 이하 와인인데 5만원도 괜찮아요"
- `isKoreanWon = true` (5만원 포함)
- `$50` 달러를 KRW 환율로 변환: `50 * 1350 ≈ 67,500원`
- 실제 원하는 건 50달러인데 67,500원으로 처리됨

**fix**: regex 매치 결과를 캡처해서 해당 매치 내에서만 통화 판별.

---

### RCA5-08: 빈 쿼리 배열 → 유효하지 않은 YQL (P0)

**파일**: `src/infrastructure/vespa/vespa-search-index.ts:318-321`

**RCA**:
```typescript
const yql = `select * from wine_entity where (${queries.join(' OR ')}) AND availability = true`;
// queries = [] → `where () AND availability = true` → Vespa parse error
```

`queries`가 빈 배열이 되는 경우:
- 모든 sparse token이 불용어로 필터링됨
- constraint extractor가 빈 결과 반환
- 빈 쿼리 YQL → Vespa 400 → retrieval 채널 전체 실패

**fix**:
```typescript
if (queries.length === 0) {
  return { hits: [], totalCount: 0 };  // early return
}
```

---

### RCA5-09: Embedding Circuit Breaker 누락 (P1)

**파일**: `src/infrastructure/ai/openai-embedding-service.ts`

**RCA**: `HttpCrossEncoderReranker`와 `AnthropicLLM`은 `globalCircuitBreakerRegistry.register()` 호출.
`OpenAIEmbeddingService`는 circuit breaker 없음.

embedding 서비스 장애 시:
1. 모든 dense retrieval 요청이 타임아웃까지 대기
2. `withRetry()` 3번 재시도 → 지연 3배 증폭
3. 요청 큐가 쌓이면 전체 서버 OOM 가능

**fix**: `openai-embedding-service.ts` 생성자에 `globalCircuitBreakerRegistry.register('openai_embedding', ...)` 추가.

---

### RCA5-10: Container 어댑터 Config 미전달 (P1)

**파일**: `src/config/container-adapters.ts:148, 195`

**RCA**:
```typescript
// line 148
new HttpEmbeddingService()  // url, model, timeoutMs 기본값 사용

// line 195  
new HttpCrossEncoderReranker()  // url, timeoutMs 기본값 사용
```

`config.embedding.url`이 env에 있어도 서비스에 전달 안 됨.
`config.reranker.url`이 env에 있어도 reranker에 전달 안 됨.
**결과**: 커스텀 엔드포인트 설정이 silently 무시됨.

**fix**: 
```typescript
new HttpEmbeddingService({ url: config.embedding.url, model: config.embedding.model, timeoutMs: config.embedding.timeoutMs })
new HttpCrossEncoderReranker({ url: config.reranker.url, timeoutMs: config.reranker.timeoutMs })
```

---

## 5차 RCA P0/P1 종합 우선순위 (업데이트)

| 순위 | ID | 파일 | 증상 | 심각도 |
|------|----|------|------|--------|
| 1 | RCA5-08 | vespa-search-index.ts:318 | 빈 queries → Vespa parse error → retrieval 전체 실패 | **P0** |
| 2 | RCA5-03 | vespa-search-index.ts:482 | learned_sparse 프로파일 없음 → silent fallback | **P0** |
| 3 | RCA5-01 | abstain-policy.ts:18 | 수학적으로 83% abstain 불가피 | **P0** |
| 4 | RCA5-05 | map-result-items.ts:152 | 드링킹 윈도우 역전 → HTTP 500 | **P1** |
| 5 | RCA5-06 | agent-orchestrator.ts:872 | timeout break 누락 → 무한 retry | **P1** |
| 6 | RCA5-04 | ranker.ts:453 | mode overlay 6/12만 적용 | **P1** |
| 7 | RCA5-02 | planner.ts:304 | route/mode 불일치 | **P1** |
| 8 | RCA5-09 | openai-embedding-service.ts | embedding CB 없음 → cascade 장애 | **P1** |
| 9 | RCA5-07 | constraint-extractor.ts:91 | 혼합 통화 오파싱 | **P1** |
| 10 | RCA5-10 | container-adapters.ts:148 | config 미전달 → env 무시 | **P1** |

*5차 RCA 완료: 10-에이전트 병렬, 2026-04-10*

---

## 6차 SOTA++ 파이프라인 완전성 감사 (2026-04-10, 10-에이전트 병렬)

> SOTA++ 6단계 파이프라인(Query Understanding → Retrieval → RRF → Reranking → Conformal → Feedback)의 구현 공백과 데드 코드 집중 감사. 이전 차수 미기록 항목만 추가.

---

### W6-P0: `stubTrain()` 하드코딩 — LTR 피드백 루프 완전 미작동

**문제**
`retrain-orchestrator.ts`의 `trainModel()` 메서드가 `trainLambdaMARTModel()`을 호출하지 않고 `stubTrain()`을 호출한다. `stubTrain()`은 하드코딩된 NDCG=0.72, MRR=0.61을 반환한다. LTR 모델이 실제로 재학습되지 않음.

```typescript
// src/domain/learning/service/retrain-orchestrator.ts:99-105
function stubTrain(trainSampleCount: number): ModelTrainingMetrics {
  return {
    ndcg_at_10: STUB_NEW_NDCG_AT_10,  // 0.72 하드코딩
    mrr: STUB_NEW_MRR,                 // 0.61 하드코딩
    trainSampleCount,
  };
}
```

추가로 `RetrainOrchestrator`가 프로덕션 DI 컨테이너(`src/config/`)에 단 한 곳도 import되거나 인스턴스화되지 않는다. 피드백이 쌓여도 재학습 스케줄러가 실행될 방법이 없다.

**근거**
- `src/domain/learning/service/retrain-orchestrator.ts:99-105`
- `src/config/` 전체 grep: `RetrainOrchestrator` import 없음
- `src/application/` 전체 grep: 동일

**긴급도** 🔴 P0
SOTA++ Stage 6 (Feedback Loop) 완전 사망. 피드백 데이터가 쌓여도 랭킹 모델이 개선되지 않음. `run-eval-and-train-ltr.ts` 스크립트가 별도 존재하지만 cron/scheduler 미연결.

**수정**
1. `stubTrain()` → `trainLambdaMARTModel()` 호출로 교체
2. `src/config/composition-root.ts`에 `RetrainOrchestrator` 인스턴스 등록
3. cron job 또는 feedback threshold trigger로 `orchestrate()` 호출 연결

---

### W6-P0: `preferenceAlignment` 항상 0.5 — dead signal

**문제**
`signal-computer.ts`에서 `preferenceAlignment` 가중치가 scoring weight 목록에 포함되어 있지만, 항상 `PREFERENCE_ALIGNMENT_NEUTRAL(0.5)` 상수를 반환한다. 실제 유저 선호도(이전 검색 히스토리, feedback 이력)를 반영하는 계산이 없다.

```typescript
// src/domain/ranking/service/signal-computer.ts:573
preferenceAlignment: PREFERENCE_ALIGNMENT_NEUTRAL,  // 항상 0.5, 학습 없음
```

scoring weight에서 `preferenceAlignment`가 차지하는 비중만큼 랭킹 점수가 왜곡된다(모든 와인이 동일하게 0.5). SOTA++ 개인화 단계 미작동.

**근거**
- `src/domain/ranking/service/signal-computer.ts:573`
- `src/domain/ranking/service/scoring-weights.ts` — `preferenceAlignment` weight > 0

**긴급도** 🔴 P0
개인화 신호 완전 미작동. 유저 피드백 → 개인화 → 랭킹 개선 루프 전체 사망.

**수정**
피드백 서비스에서 유저별 선호 벡터 로드 후 candidate document 속성과 코사인 유사도 계산. 또는 단기적으로 `preferenceAlignment` scoring weight를 0으로 설정해 왜곡 제거.

---

### W6-P1: `SELECT * FROM entities` — LIMIT 없음, OOM 위험

**문제**
`pg-entity-repository.ts:218`에서 LIMIT 절 없이 `SELECT * FROM entities` 전체 테이블 스캔. 엔티티가 수만 건 이상이면 Node.js 프로세스 OOM 가능.

```typescript
// src/infrastructure/adapter/pg-entity-repository.ts:218
const entitiesResult = await this.pool.query<EntityRow>('SELECT * FROM entities');
```

**근거**
- `src/infrastructure/adapter/pg-entity-repository.ts:218`
- 해당 메서드가 언제 호출되는지: `admin-route.ts` 또는 ingest path — 운영 중 임의 호출 가능

**긴급도** 🟠 P1
운영 데이터 규모에서 단일 쿼리로 서버 OOM 유발 가능. `LIMIT 10000` 이상 + cursor-based pagination 도입 필요.

**수정**
```typescript
const entitiesResult = await this.pool.query<EntityRow>('SELECT * FROM entities LIMIT $1 OFFSET $2', [limit, offset]);
```

---

### W6-P1: 임베딩 readiness probe — stub 사용 시 'up' 허위 보고

**문제**
`src/config/readiness.ts`의 embedding readiness check가 `config.embedding.url === undefined`이면 warn 로그만 남기고 `'up'`을 반환한다.

```typescript
// src/config/readiness.ts:134-136
if (config.embedding.url === undefined) {
  log.warn('...using stub, reporting up');
  return 'up';
}
```

k8s readiness probe가 통과되어 트래픽이 라우팅되지만 임베딩 서비스가 없으므로 dense retrieval이 전량 실패한다.

**근거**
- `src/config/readiness.ts:134-136`

**긴급도** 🟠 P1
프로덕션 배포 시 EMBEDDING_URL 미설정이면 readiness를 통과하지만 검색이 작동하지 않는다. `'degraded'` 반환 또는 `'down'` 반환으로 변경 필요.

---

### W6-P1: 제약 분류기 split-brain — 소프트/하드 경계 두 곳에서 독립 결정

**문제**
소프트/하드 제약 분류가 두 개의 독립적인 메커니즘에서 이루어진다:

1. **`constraint-compiler.ts:24-30`** — `SOFT_CONSTRAINT_ATTRIBUTES` Set으로 결정
2. **`rule-based-constraint-extractor.ts`** — 내부 로직에서 특정 속성을 직접 `soft[]`에 push

두 메커니즘이 동기화되지 않아 `price_usd`가 extractor에서는 soft로 분류되지만 compiler에서는 hard로 처리된다.

**근거**
- `src/domain/query/service/constraint-compiler.ts:24-30`
- `src/domain/query/service/rule-based-constraint-extractor.ts` — `price_usd` soft push
- 두 파일 간 `SOFT_CONSTRAINT_ATTRIBUTES` 동기화 메커니즘 없음

**긴급도** 🟠 P1
price_usd 제약이 hard YQL 필터로 처리될 경우 가격 범위 밖 와인이 전량 제외됨. SSoT 모듈 추출 필요.

**수정**
`src/domain/query/shared/soft-constraint-attributes.ts` 단일 모듈 생성. extractor와 compiler 모두 import.

---

### W6-P1: IPS position propensity 하드코딩 — Epic-18 클릭 파이프라인 미연결

**문제**
`src/domain/ranking/service/ips-debiaser.ts`의 position propensity가 하드코딩:

```typescript
const POSITION_PROPENSITIES = [1.0, 0.6, 0.4, 0.3, 0.2];  // 추정값
```

실제 클릭 데이터로 fitting된 propensity가 아니다. Epic-18에서 클릭 파이프라인을 구축해야 하지만 해당 파이프라인이 존재하지 않는다. 결과적으로 IPS 디바이어싱이 작동은 하지만 잘못된 propensity로 가중치를 잘못 보정한다.

**근거**
- `src/domain/ranking/service/ips-debiaser.ts` — `POSITION_PROPENSITIES` 상수
- `src/` 전체: Epic-18 클릭 수집 파이프라인 없음

**긴급도** 🟠 P1
잘못된 IPS 가중치는 순위 보정을 오히려 왜곡할 수 있음. 단기적으로: propensity를 config에서 로드 가능하게 변경. 장기적으로: 클릭 데이터 수집 → Platt scaling → propensity 업데이트 파이프라인 구축.

---

### W6-P2: Python ETL `grape_family` split()[0] — CLAUDE.md Rule 27 위반

**문제**
`tools/wine-search-engine/enrich-rules.py:303`에서 `GRAPE_FAMILY_MAP`에 없는 품종의 grape_family를 `grapes[0].split()[0]`로 fallback 처리:

```python
return GRAPE_FAMILY_MAP.get(grapes[0], grapes[0].split()[0])  # fallback: first word
```

- `"Nero d'Avola"` → `"Nero"` (틀림)
- `"Sauvignon Blanc"` → `"Sauvignon"` (틀림)
- `"Pinot Noir"` → `"Pinot"` (틀림)

CLAUDE.md Rule 27: "Use a lookup table for known multi-word terms before falling back to split()[0]."

**근거**
- `tools/wine-search-engine/enrich-rules.py:303`

**긴급도** 🟡 P2
`GRAPE_FAMILY_MAP`에 없는 품종(전체의 30-40% 추정)에 대해 잘못된 grape_family가 색인됨. grape_family 기반 필터링 오분류 발생.

**수정**
`GRAPE_FAMILY_MAP` 확장. 또는 fallback을 `None`으로 변경해 잘못된 분류 대신 미분류 처리.

---

### W6-P2: 드링킹 윈도우 예측 시작 연도 +2 — 풀바디 레드에 너무 이름

**문제**
`src/infrastructure/ml/drinking-window-predictor.ts`의 heuristic이 `vintageYear + 2`를 시작 연도로 예측. Barolo, Brunello, 탄닌 높은 레드는 최소 5-7년 필요.

- Barolo 2015 → 예측: 2017-2027 (실제 적정: 2022-2045)
- 가벼운 Beaujolais → 예측: 2017 (적합)

하나의 +2 offset으로 모든 wine_type을 처리해 풀바디 레드의 마시기 적합 시점을 크게 잘못 예측.

**근거**
- `src/infrastructure/ml/drinking-window-predictor.ts` — `VINTAGE_DRINKING_START_OFFSET = 2`

**긴급도** 🟡 P2
도메인 정확도 문제. wine_type별 offset 분기 필요: `body >= 0.7 → +5`, `body >= 0.5 → +3`, else `+1`.

---

### W6-P2: `feedback_signals`, `threshold_proposals` 인덱스 누락

**문제**
PostgreSQL `feedback_signals` 테이블에 `query_class` 컬럼 인덱스 없음.
`threshold_proposals` 테이블에 `status` 컬럼 인덱스 없음.

`FeedbackProcessor`가 `WHERE query_class = $1` 쿼리를 자주 실행하고, `ConformalCalibrator`가 `WHERE status = 'pending'` 필터를 실행하는데 seq scan 발생.

**근거**
- `src/infrastructure/adapter/pg-feedback-repository.ts` — `query_class` WHERE절
- `src/infrastructure/adapter/pg-calibration-repository.ts` — `status` WHERE절
- 마이그레이션 파일에 해당 인덱스 없음

**긴급도** 🟡 P2
피드백 데이터 누적 시 쿼리 지연 증가. 마이그레이션 추가로 즉시 해결 가능:
```sql
CREATE INDEX CONCURRENTLY idx_feedback_signals_query_class ON feedback_signals(query_class);
CREATE INDEX CONCURRENTLY idx_threshold_proposals_status ON threshold_proposals(status);
```

---

### W6-P3: Health probe HTTP 증폭 — k8s liveness probe 부하

**문제**
`src/config/readiness.ts`의 외부 서비스 probe(Vespa, embedding, reranker)가 실제 HTTP POST 요청을 보낸다. k8s liveness probe가 10초마다 호출 시 3개 서비스 × 6 레플리카 = 분당 108개 불필요한 HTTP 요청 발생.

**근거**
- `src/config/readiness.ts` — Vespa/embedding/reranker probe 구현

**긴급도** 🟡 P3
서비스 수 증가 시 probe 부하 비례 증가. 마지막 성공 시점 캐싱(30초 TTL) 또는 경량 HEAD 요청으로 교체 권장.

---

## 6차 감사 픽스 우선순위 요약

| 순서 | 항목 | 파일 | 긴급도 |
|------|------|------|--------|
| 1 | W6-P0 `stubTrain()` → 실제 LTR + `RetrainOrchestrator` DI 등록 | `retrain-orchestrator.ts`, `composition-root.ts` | P0 |
| 2 | W6-P0 `preferenceAlignment` weight 0으로 설정 (실계산 전까지) | `scoring-weights.ts` | P0 |
| 3 | W6-P1 `SELECT * FROM entities` LIMIT 추가 | `pg-entity-repository.ts:218` | P1 |
| 4 | W6-P1 embedding readiness stub → `'degraded'` 반환 | `readiness.ts:134` | P1 |
| 5 | W6-P1 constraint split-brain SSoT 추출 | `soft-constraint-attributes.ts` 신규 | P1 |
| 6 | W6-P1 IPS propensity config 외부화 | `ips-debiaser.ts` | P1 |
| 7 | W6-P2 `grape_family` GRAPE_FAMILY_MAP 확장 또는 fallback=None | `enrich-rules.py:303` | P2 |
| 8 | W6-P2 드링킹 윈도우 wine_type별 offset 분기 | `drinking-window-predictor.ts` | P2 |
| 9 | W6-P2 DB 인덱스 2개 마이그레이션 추가 | 신규 migration 파일 | P2 |
| 10 | W6-P3 health probe 결과 캐싱 | `readiness.ts` | P3 |

*6차 SOTA++ 파이프라인 완전성 감사: 10-에이전트 병렬, 2026-04-10*

---

## Wave 3 감사 — 2026-04-10 (7차, 10라운드 병렬, RCA 집중)

검색 유즈케이스, Vespa 매핑, LLM 인프라, DB 레이어 RCA 집중 감사.
P0/P1만 기재, P2/P3 제외.

---

### P0 — 즉시 수정 필요

#### W3-01: `pg-entity-repository.ts:334` — 빈 스냅샷에서 `DELETE FROM entities` 전체 삭제 ✅ 수정됨

**문제 (RCA)**
`rollbackToSnapshot()`에서 스냅샷이 비어 있을 때 (`snapshotEntityIds.size === 0`) 아무 WHERE 절 없이 `DELETE FROM entities`를 실행.
빈 스냅샷으로 롤백을 호출하면 **전체 와인 엔티티 DB가 삭제**됨.

두 경로 모두 이 분기 진입 가능:
- 스냅샷이 진짜 빈 경우
- 스냅샷 rows가 모두 Zod 검증 실패하는 경우 (corrupted snapshot)

**근거** — `src/infrastructure/adapter/pg-entity-repository.ts:327-335`

**긴급도: P0** — 단일 API 호출로 전체 데이터 삭제 가능. **수정**: 빈 스냅샷 시 삭제 skip.

---

### P1 — 높은 심각도

#### W3-02: `openai-json.ts:21` — `isNumberArray`에 `Number.isFinite` 없음 ✅ 수정됨

**문제 (RCA)**
`isNumberArray()` 타입 가드가 `typeof x === 'number'`만 체크하고 `Number.isFinite(x)` 누락.
NaN/Infinity가 포함된 임베딩 벡터가 타입 가드를 통과해 Vespa로 전달 가능.
`mapping.ts:67`의 동일 함수명은 `isFinite(x)`를 포함 — 두 구현이 불일치.

**근거** — `src/infrastructure/ai/openai-json.ts:21` / `src/infrastructure/vespa/mapping.ts:67-70`

**긴급도: P1** — API 이상 시 NaN 임베딩이 Vespa에 전달되어 쿼리 결과 오염 가능.

---

#### W3-03: `mapping.ts:396-397` — `body`/`sweetness` 결측값을 `0`으로 기본값 처리 (타입 리팩터 필요)

**문제 (RCA)**
`acidity`, `tannin`, `finishLength`는 optional spread로 결측 시 `undefined` 유지.
`body`와 `sweetness`는 `?? 0`으로 하드코딩 — "데이터 없음"과 "실제 0"을 혼동.
인덱싱된 적 없는 와인이 `body=0`(최저 바디)으로 랭킹 오염.

**근거** — `src/infrastructure/vespa/mapping.ts:396-397` / `src/domain/retrieval/model/retrieval-document.ts:128`

**긴급도: P1** — consumer 타입들이 `body: number` (required)로 선언해 즉시 optional 전환 불가. 광범위한 타입 리팩터 필요.

---

#### W3-04: `search-usecase-hybrid-candidates.ts:23` — anchor sort 타이브레이커 없음 ✅ 수정됨

**문제 (RCA)**
동일 confidence를 가진 anchor가 여러 개일 때 sort가 비결정적.
이 anchor는 `producer_browse` 채널의 seed(생산자명)로 사용됨 → 같은 쿼리가 매번 다른 생산자를 기준으로 검색.
eval 재현 불가, A/B 테스트 결과 불안정.

**근거** — `src/application/search/search-usecase-hybrid-candidates.ts:23`

**긴급도: P1** — surfaceForm으로 tiebreak하여 결정적 anchor 선택 보장.

---

### Wave 3 요약

| ID | 파일 | 핵심 문제 | 긴급도 | 상태 |
|----|------|----------|--------|------|
| W3-01 | pg-entity-repository.ts:334 | 빈 스냅샷 → 전체 entities 삭제 | **P0** | ✅ 수정 |
| W3-02 | openai-json.ts:21 | isNumberArray NaN 통과 | **P1** | ✅ 수정 |
| W3-03 | mapping.ts:396-397 | body/sweetness 결측값 0 처리 | **P1** | 추적 필요 |
| W3-04 | search-usecase-hybrid-candidates.ts:23 | anchor sort 비결정적 | **P1** | ✅ 수정 |

*7차 감사 수행: 10-라운드 병렬, RCA 집중, 2026-04-10*
