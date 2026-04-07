# Appendix I: Performance-First SOTA++ Roadmap

이 appendix는 `apr-7-v0.4` 전체 로드맵 중에서도  
**“무엇을 먼저 해야 업계/학계 SOTA++ 방향에 가장 가깝게, 가장 높은 확률로 성능을 올릴 수 있는가”**를 코드 기준으로 다시 정렬한 문서다.

핵심 원칙은 두 가지다.

1. 절대 성능은 문서만으로 “보장”할 수 없다.  
   대신 **학계/업계 근거가 가장 강한 성능 레버**를 먼저 선택하고,  
   existing eval/replay/gate로 **승격 조건을 통과한 것만 배포**하는 방식으로  
   사실상 가장 높은 신뢰도의 성능 라인을 만든다.

2. 이 레포는 greenfield가 아니다.  
   그래서 roadmap은 “최신 기술 이름을 더 붙이는 것”이 아니라  
   **이미 있는 retrieval / ranking / decision / eval 자산을 성능이 나는 순서대로 연결**하는 방식이어야 한다.

이 문서는 [appendix-b-evidence-and-benchmarks.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/appendix-b-evidence-and-benchmarks.md)의 근거와,  
[appendix-a-current-state.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/appendix-a-current-state.md), [appendix-h-implementation-map.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/appendix-h-implementation-map.md)의 코드 스캔 결과를 합쳐서 작성한다.

주의:

- 이 문서는 **performance-first prioritization lens**다.
- 실제 구현 착수 순서와 PR-sized backlog는 [01-epic-task-backlog.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/01-epic-task-backlog.md)를 따른다.
- 두 문서가 충돌하면 `01-epic-task-backlog.md`를 우선한다.

---

## 1. 성능 “보장 라인”의 의미

이 문서에서 말하는 “보장 라인”은 아래 뜻이다.

- 학계/업계에서 가장 근거가 강한 레버를 우선 적용한다
- every wave는 기존 release gate를 통과해야만 승격한다
- replay / snapshot / cache / eval / selective prediction 자산으로 regression을 막는다
- 새 기능보다 `low-regret / high-upside / reusable` path를 선택한다

즉 의미는:

> **무조건 더 좋아진다**를 약속하는 게 아니라,  
> **지금 코드베이스에서 가장 높은 확률로 quality uplift를 낼 수 있는 순서**로 roadmap을 고정한다는 뜻이다.

---

## 2. 코드 기준으로 본 성능 레버 우선순위

현재 코드베이스를 실제 runtime wiring 기준으로 보면,  
성능에 가장 직접적으로 먹히는 레버는 아래 순서다.

### A. Retrieval top-line recall uplift

가장 먼저 올려야 하는 축이다.

이유:

- 와인 검색은 exact/filter를 빼면 recall ceiling이 retrieval lane에서 많이 결정된다
- 레포는 이미 `BM25 + dense + learned sparse + anchor/relative` 자산이 있다
- learned sparse는 문서상 아이디어가 아니라 실제 Vespa path가 이미 연결돼 있다

핵심 재사용 자산:

- [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts)
- [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts)
- [search-index.port.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/port/search-index.port.ts)
- [vespa-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts)
- [vespa-schema.sd](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-schema.sd)
- [query-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/query/service/query-normalizer.ts)
- [ontology-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/attribute/service/ontology-normalizer.ts)

최우선 작업:

1. learned sparse를 semantic/sensory/long-NL 계열에서 default lane로 승격
2. planner expansions와 ontology normalization을 retrieval input으로 실제 반영
3. intent/difficulty 기반 candidate budget table 도입
4. exact-safe path는 유지하고 broad/semantic에만 후보 폭을 넓힘

기대 효과:

- sensory / pairing / long-NL의 candidate recall 상승
- zero-result / low-recall 감소
- CE가 볼 수 있는 top-K 후보 품질 자체가 상승

### B. Ranking precision uplift

두 번째 레버다.

이유:

- 현재 레포는 CE, LTR, decision, eval 자산이 이미 많다
- 그런데 `LTR broad / CE narrow / multi-signal gate`가 아직 분리되지 않아 품질과 비용을 동시에 잃고 있다

핵심 재사용 자산:

- [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)
- [rerank-gate.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/rerank-gate.ts)
- [ltr-training-service.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-training-service.ts)
- [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts)
- [selective-predictor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/selective-predictor.ts)

최우선 작업:

1. LTR을 broad/cheap stage로 분리
2. CE를 narrow/expensive stage로 분리
3. CE gate에 ambiguity, exact confidence, score gap, disagreement, value, latency를 넣기
4. [search-usecase-ranked-route-resolve.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-ranked-route-resolve.ts)의 synthetic confidence를 ranked-route calibrator로 교체

기대 효과:

- top-10 precision 상승
- exact/filter 쿼리의 불필요한 CE 비용 제거
- semantic/pairing/substitute에서 CE ROI 극대화
- confidence와 ranking score의 의미 충돌 축소

### C. Policy SSOT / execution contract

이건 retrieval/ranking처럼 직접 quality를 올리는 레버는 아니지만,  
**지속적으로 성능을 올리기 위한 unlocker**다.

이유:

- 지금 runtime SSOT가 `QueryPlanV1`이라 policy가 분산된다
- taxonomy, lane mix, budget, gate, explanation obligation이 같은 언어로 묶이지 않는다

핵심 재사용 자산:

- [execution-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/execution-compiler.ts)
- [query-understanding-snapshot.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-understanding-snapshot.ts)
- [planner-v1-adapter.ts](/Users/songmin/wine-search-engine/src/config/planner-v1-adapter.ts)
- [container-core.ts](/Users/songmin/wine-search-engine/src/config/container-core.ts)
- [container-usecases.ts](/Users/songmin/wine-search-engine/src/config/container-usecases.ts)
- [search-route-usecases.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-route-usecases.port.ts)
- [decomposed-search-adapter.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search-adapter.ts)
- [constraint-sat.ts](/Users/songmin/wine-search-engine/src/domain/query/service/constraint-sat.ts)
- [policy-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/policy-compiler.ts)
- [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts)

최우선 작업:

1. `QueryPlanV1` 위에 필드 덧대기 중단
2. compiled execution contract를 runtime currency로 승격
3. Q1-Q7 + difficulty/value를 canonical policy input으로 고정
4. retrieval/rerank/abstain/explanation policy를 table-driven으로 전환

기대 효과:

- lane policy와 gate를 지속적으로 튜닝 가능
- slice-aligned eval과 serving policy 정렬
- 중복 branching 감소
- usecase graph/search route dependency 계약을 깨지 않고 migration 가능

### D. Safe exploration / abstention / grouped response

이건 direct retrieval score를 올리기보다  
**coverage × calibration × safety**를 올리는 레버다.

핵심 재사용 자산:

- [result-grouper.ts](/Users/songmin/wine-search-engine/src/domain/response/service/result-grouper.ts)
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)
- [evidence-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/evidence-gate.ts)
- [abstain-policy.ts](/Users/songmin/wine-search-engine/src/domain/query/service/abstain-policy.ts)

최우선 작업:

1. broad exploration은 grouped result surface로 보내기
2. low-confidence semantic query는 abstain/refine/diversify로 보내기
3. explanation obligation을 query-family별로 강제하기

기대 효과:

- 틀린 결과를 자신 있게 내는 비율 감소
- broad query UX 개선
- long-NL/ambiguity query의 안전성 향상

### E. Learning / rollout loop

이건 성능 관점에서는 마지막이 아니라, 앞 wave들과 함께 미리 고려해야 하는 control plane이다.  
다만 실제 execution backlog에서는 dependency order에 맞춰 뒤 에픽으로 배치될 수 있다.

핵심 재사용 자산:

- [feedback-processor.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/feedback-processor.ts)
- [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts)
- [threshold-optimizer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/threshold-optimizer.ts)
- [replay.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/replay.usecase.ts)
- [cache-policy.ts](/Users/songmin/wine-search-engine/src/domain/cache/cache-policy.ts)
- [kill-switch-policy.ts](/Users/songmin/wine-search-engine/src/config/kill-switch-policy.ts)
- [container-runtime-support.ts](/Users/songmin/wine-search-engine/src/config/container-runtime-support.ts)
- [container-adapters.ts](/Users/songmin/wine-search-engine/src/config/container-adapters.ts)
- [container-features.ts](/Users/songmin/wine-search-engine/src/config/container-features.ts)
- [container-eval-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-eval-contracts.ts)
- [container-learning.ts](/Users/songmin/wine-search-engine/src/config/container-learning.ts)
- [register-contract-route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/register-contract-route.ts)
- [http-route-contract-openapi.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-openapi.ts)
- [openapi.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/openapi.route.ts)
- [runtime-handles.ts](/Users/songmin/wine-search-engine/src/config/runtime-handles.ts)
- [search-executor.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-executor.port.ts)
- [container-tool-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-tool-contracts.ts)
- [result-item-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/model/result-item-v2.ts)
- [engine-decision.ts](/Users/songmin/wine-search-engine/src/domain/response/model/engine-decision.ts)
- [authority-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/authority-trace.ts)
- [query-decomposition.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-decomposition.ts)
- [query-observability-vocab.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-observability-vocab.ts)
- [evidence-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/evidence-gate.ts)
- [result-grouper.ts](/Users/songmin/wine-search-engine/src/domain/response/service/result-grouper.ts)
- [calibration-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/calibration-evaluator.ts)
- [pg-calibration-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-calibration-store.ts)
- [decision-input.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-input.ts)
- [decision-output.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-output.ts)
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)
- [alias-proposer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/alias-proposer.ts)
- [pg-proposal-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-proposal-store.ts)
- [blocker.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/blocker.ts)
- [calibrator.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/calibrator.ts)
- [container-stubs.ts](/Users/songmin/wine-search-engine/src/config/container-stubs.ts)
- [query-policy.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-policy.ts)
- [threshold-profile.ts](/Users/songmin/wine-search-engine/src/domain/query/model/threshold-profile.ts)
- [search-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/search-request.dto.ts)
- [clarification.ts](/Users/songmin/wine-search-engine/src/domain/response/model/clarification.ts)
- [counterfactual.ts](/Users/songmin/wine-search-engine/src/domain/response/model/counterfactual.ts)
- [search-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/search-response.ts)
- [query-route.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-route.ts)
- [evidence-mapper.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/evidence-mapper.ts)
- [server.ts](/Users/songmin/wine-search-engine/src/interface/http/server.ts)

최우선 작업:

1. threshold / route / rerank rollout을 하나의 governor로 묶기
2. replay + snapshot + release gate를 production promotion에 직접 연결
3. retrieval/rerank failure mining을 자동 수집하기

기대 효과:

- quality regression 방지
- offline uplift -> serving promotion 연결
- 정책 변경 속도 증가

중요한 점:

- rollout governor는 새 control-plane을 처음부터 다시 짜는 게 아니라 기존 [kill-switch-policy.ts](/Users/songmin/wine-search-engine/src/config/kill-switch-policy.ts), [cache-policy.ts](/Users/songmin/wine-search-engine/src/domain/cache/cache-policy.ts), [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts)를 한 데 묶는 쪽이 low-regret다
- runtime support / adapter / eval exposure도 [container-runtime-support.ts](/Users/songmin/wine-search-engine/src/config/container-runtime-support.ts), [container-adapters.ts](/Users/songmin/wine-search-engine/src/config/container-adapters.ts), [container-features.ts](/Users/songmin/wine-search-engine/src/config/container-features.ts), [container-eval-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-eval-contracts.ts), [server.ts](/Users/songmin/wine-search-engine/src/interface/http/server.ts)의 existing layering을 재사용하는 편이 low-regret다
- learning ingest / route manifest / OpenAPI surface / runtime shutdown도 [container-learning.ts](/Users/songmin/wine-search-engine/src/config/container-learning.ts), [register-contract-route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/register-contract-route.ts), [http-route-contract-openapi.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-openapi.ts), [openapi.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/openapi.route.ts), [runtime-handles.ts](/Users/songmin/wine-search-engine/src/config/runtime-handles.ts)의 existing seam를 재사용하는 편이 low-regret다
- external executor/tool/decision contract도 [search-executor.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-executor.port.ts), [container-tool-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-tool-contracts.ts), [result-item-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/model/result-item-v2.ts), [engine-decision.ts](/Users/songmin/wine-search-engine/src/domain/response/model/engine-decision.ts), [authority-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/authority-trace.ts)의 existing seam를 유지하는 편이 low-regret다
- decomposition/evidence/grouping/calibration도 [query-decomposition.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-decomposition.ts), [query-observability-vocab.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-observability-vocab.ts), [evidence-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/evidence-gate.ts), [result-grouper.ts](/Users/songmin/wine-search-engine/src/domain/response/service/result-grouper.ts), [calibration-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/calibration-evaluator.ts), [pg-calibration-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-calibration-store.ts)의 existing seam를 승격하는 편이 low-regret다
- response/decision/proposal/stub seam도 [decision-input.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-input.ts), [decision-output.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-output.ts), [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts), [alias-proposer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/alias-proposer.ts), [pg-proposal-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-proposal-store.ts), [blocker.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/blocker.ts), [calibrator.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/calibrator.ts), [container-stubs.ts](/Users/songmin/wine-search-engine/src/config/container-stubs.ts)의 existing seam를 재사용하는 편이 low-regret다
- policy/threshold/request-response DTO seam도 [query-policy.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-policy.ts), [threshold-profile.ts](/Users/songmin/wine-search-engine/src/domain/query/model/threshold-profile.ts), [search-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/search-request.dto.ts), [clarification.ts](/Users/songmin/wine-search-engine/src/domain/response/model/clarification.ts), [counterfactual.ts](/Users/songmin/wine-search-engine/src/domain/response/model/counterfactual.ts), [search-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/search-response.ts), [query-route.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-route.ts), [evidence-mapper.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/evidence-mapper.ts)의 existing seam를 정렬하는 편이 low-regret다

---

## 3. 최종 권장 순서: “성능이 나는 라인”

### Track 0. Immediate unlocker

가장 먼저 시작해야 하지만 scope는 작게 가져간다.

- compiled execution contract 승격
- taxonomy + difficulty + value 필드의 최소 SSOT 도입
- 기존 V1 adapter는 compatibility shell로만 유지

이 트랙의 목적은 architecture purity가 아니라,  
**retrieval/ranking 정책을 한 곳에서 제어할 최소 기반**을 만드는 것이다.

중요한 점:

- contradiction-SAT, uncertainty, clarification policy는 새로 만들지 않는다
- 기존 [constraint-sat.ts](/Users/songmin/wine-search-engine/src/domain/query/service/constraint-sat.ts), [policy-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/policy-compiler.ts), [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts)를 canonical policy input의 기존 feature source로 승격하는 것이 맞다
- usecase graph는 [container-usecases.ts](/Users/songmin/wine-search-engine/src/config/container-usecases.ts), [search-route-usecases.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-route-usecases.port.ts), [decomposed-search-adapter.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search-adapter.ts)의 existing seam를 그대로 유지한 채 query currency만 바꾸는 것이 low-regret다

### Track 1. Highest-confidence quality uplift

가장 먼저 실제 품질을 끌어올릴 트랙이다.

- learned sparse promotion
- query expansion / ontology normalization을 retrieval input에 반영
- intent/difficulty candidate budget table
- broad/semantic query recall 확대

이건 학계/업계 근거가 가장 강한 `hybrid + learned sparse` 상한선 축이다.

중요한 점:

- producer/region browse, compare candidate retrieval은 버리지 않는다
- 기존 [browse-retriever.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/browse-retriever.ts), [compare-retriever.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/compare-retriever.ts), [search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts)의 specialized path를 broad/substitute lane policy 아래로 재배치하는 편이 low-regret다

### Track 2. Highest-confidence precision uplift

retrieval uplift 다음 바로 붙여야 한다.

- LTR broad
- CE narrow
- multi-signal CE gate
- ranked-route calibrator

이건 `retrieve -> cheap rerank -> expensive rerank` 표준 구조를  
현재 코드에 실제로 구현하는 단계다.

중요한 점:

- ranking stage/funnel 관측 자산은 새로 만들지 않는다
- 기존 [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts), [funnel-metrics.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/funnel-metrics.ts), [ranking-runtime-signal.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-runtime-signal.ts)을 유지한 채 [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts) 내부 책임만 분리하는 것이 맞다

### Track 3. Safety / coverage uplift

- abstention / refine / diversify
- grouped browse response
- explanation obligation
- uncertainty-aware response policy

이건 “정확도 숫자”보다  
실제 제품에서 SOTA++답게 보이게 만드는 트랙이다.

### Track 4. Continuous improvement loop

- rollout governor
- drift-aware promotion
- replay-backed regression control
- failure mining / hard negatives / distillation loop

이게 닫혀야 진짜 상위 시스템이 된다.

---

## 4. 코드 기준으로 “먼저 하지 말아야 할 것”

성능 ROI 기준으로는 아래를 먼저 하면 안 된다.

### 4.1 generic LLM ranking 확대

현재 구조에서는 low-ROI다.

- deterministic하지 않다
- cost/latency가 크다
- existing decision/confidence semantics를 흐린다

LLM은 query understanding, ontology expansion, explanation, fallback interaction에 두고  
retrieval/ranking core는 deterministic하게 유지하는 게 맞다.

### 4.2 새 response stack을 처음부터 다시 만들기

이미 existing response surface가 꽤 강하다.

- parsedConstraints
- resultType
- provenance slices
- counterfactuals
- fallback transparency

그래서 broad/sensory/substitute UX도 여기서 확장하는 게 low-regret다.

### 4.3 새 cache / replay / rollout 체계 만들기

이미 snapshot-aware cache, replay, authority trace, selective eval이 있다.  
이 위에 search-rollout-governor를 얹는 게 맞다.

### 4.4 product multi-view index를 너무 일찍 파기

장기적으로는 맞는 방향이지만,  
현재는 lane policy / budget / retrieval input wiring이 먼저다.

지금 multi-view는 query side와 provenance side primitive가 이미 있으니  
우선은 **existing retrieval document seam를 확장**하는 쪽이 낫다.

---

## 5. 추천 roadmap: performance wave lens

현재 코드 상태를 기준으로,  
성능 관점에서는 아래처럼 두 층으로 보는 게 맞다.  
이 섹션은 authoritative execution backlog가 아니라, **quality uplift likelihood 기준의 wave lens**다.

### Foundation wave

성능을 위한 최소 unlocker만 한다.

1. compiled execution contract 승격
2. taxonomy/difficulty/value SSOT
3. lane policy table skeleton

### Performance wave 1

가장 확실한 quality uplift.

1. learned sparse promotion
2. expansion/ontology-to-retrieval wiring
3. intent-aware candidate budget

### Performance wave 2

가장 확실한 precision uplift.

1. LTR broad stage
2. CE narrow stage
3. multi-signal CE gate
4. ranked-route calibrator

### Performance wave 3

coverage/safety uplift.

1. broad/grouped response
2. abstain/refine/diversify policy
3. explanation obligation

### Performance wave 4

continuous optimization loop.

1. rollout governor
2. drift-aware promotion
3. hard-negative / distillation / failure replay loop

---

## 6. 이 라인이 “가장 SOTA++답다”는 이유

이 roadmap은 아래 레버를 우선순위로 따른다.

1. `hybrid + learned sparse`  
   first-stage recall ceiling을 올리는 가장 강한 레버

2. `multi-stage rerank`  
   CE는 top-K 정밀 판정기로만 쓰고, cheap stage와 분리

3. `calibration + selective prediction + abstention`  
   coverage × calibration × safety를 같이 올림

4. `policy-driven adaptive execution`  
   같은 query class라도 difficulty/value/latency에 따라 계산 예산을 다르게 씀

5. `closed-loop rollout`  
   성능 개선을 한 번 하고 끝내지 않고 지속적으로 승격/롤백 가능하게 만듦

즉 이건 단순히 “모델을 더 넣는 roadmap”이 아니라,

> **현재 레포의 강한 자산을 기반으로,  
> 가장 근거가 강한 retrieval/rerank/calibration 레버부터 순서대로 태우는 roadmap**

이다.

---

## 7. 한 줄 결론

코드 기준으로 봤을 때,  
성능 관점의 우선 적용 라인은 아래처럼 보는 게 맞다.  
실제 execution order와 dependency는 [01-epic-task-backlog.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/01-epic-task-backlog.md)를 따른다.

1. `compiled execution contract + taxonomy/difficulty SSOT`
2. `learned sparse promotion + retrieval input wiring + budget table`
3. `LTR broad + CE narrow + multi-signal gate + ranked-route calibrator`
4. `abstain/grouped response/explanation obligation`
5. `rollout governor + replay/drift/failure-mining loop`

이 라인이 지금 레포에서  
**가장 낮은 중복개발 리스크로, 가장 높은 확률로 SOTA++ 품질 uplift를 내는 경로**다.
