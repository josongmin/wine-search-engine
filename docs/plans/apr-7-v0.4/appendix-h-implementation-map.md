# Appendix H: Code-Level Implementation Map

이 appendix는 `apr-7-v0.4`를 실제 코드 변경 순서로 내린 문서다.  
핵심 질문은 아래다.

1. 지금 런타임의 실제 currency는 무엇인가
2. 어디가 유지할 seam이고 어디가 교체 지점인가
3. 어떤 파일부터 어떤 순서로 바꿔야 blast radius를 통제할 수 있는가

이번 정리는 추상 설계가 아니라, 실제 코드 스캔을 바탕으로 작성한다.

---

## 1. 지금 런타임의 실제 중심은 어디인가

### 1.1 메인 orchestrator

현재 메인 검색 흐름의 허브는 [search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/search.usecase.ts)다.

흐름:

```text
SearchUseCase
 -> pre-route
 -> route resolution
 -> entity / hybrid / mixed dispatch
 -> post-route
 -> decision / response / cache
```

즉 현재 기준으로는 `application/search`가 여전히 runtime backbone이다.

추가로 planner migration blast radius를 키우는 보조 허브도 있다.

- [interpret.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/interpret.usecase.ts)
- [hybrid.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid.usecase.ts)
- [batch-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/batch-search.usecase.ts)
- [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts)
- [search-usecase-decision-input.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-decision-input.ts)

의미:

- planner currency를 바꾸면 search execution만이 아니라
- debug / explain / decision admission / post-route assembly뿐 아니라 hybrid/batch entrypoint도 함께 영향을 받는다

### 1.2 planner output의 실제 currency

현재 실제 downstream currency는 `QueryPlanV1`이다.

- `QueryPlanV1`는 `src`에서 46개 파일에 등장한다
- `plan.route / plan.retrievalMode / plan.queryClass / plan.constraints / plan.policy / plan.uncertainty / plan.anchors` 직접 참조가 `129`건이다

핵심 파일:

- [query-plan.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-plan.ts)
- [search-pipeline-deps.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-pipeline-deps.port.ts)

의미:

- 지금 구조에서 query contract 변경은 planner만 바꾸는 작업이 아니다
- runtime-wide IR migration이다

### 1.3 V2/compiled contract의 실제 상태

좋은 방향의 계약은 이미 있다.

- `QueryPlanV2`
- `QueryUnderstandingSnapshot`
- `EngineExecutionContract`
- `CompiledWineQuery`
- `ExecutionCompiler`

핵심 파일:

- [query-plan.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-plan.ts)
- [query-understanding-snapshot.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-understanding-snapshot.ts)
- [engine-execution-contract.ts](/Users/songmin/wine-search-engine/src/domain/query/model/engine-execution-contract.ts)
- [compiled-wine-query.ts](/Users/songmin/wine-search-engine/src/domain/query/model/compiled-wine-query.ts)
- [execution-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/execution-compiler.ts)

하지만 production runtime의 중심은 아니다.

- [container-core.ts](/Users/songmin/wine-search-engine/src/config/container-core.ts)에서 planner는 아직 [planner-v1-adapter.ts](/Users/songmin/wine-search-engine/src/config/planner-v1-adapter.ts)로 감싸진다
- `QueryPlannerPort`도 여전히 `Promise<QueryPlanV1>`를 반환한다

즉 이 migration의 제1 목표는 **좋은 타입을 더 만드는 것**이 아니라  
**runtime currency를 `QueryPlanV1`에서 compiled execution contract로 옮기는 것**이다.

---

## 2. 유지해야 할 seam과 교체해야 할 seam

### 2.1 유지해야 할 seam

아래는 구조상 잘 나뉘어 있어서 최대한 유지하는 편이 좋다.

#### A. search route orchestration seam

- [search-usecase-route-dispatch.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-route-dispatch.ts)
- `entity / hybrid / mixed` dispatch 구조
- [search-usecase-pre-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts)
- [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts)

유지 이유:

- 큰 실행 분기점이 이미 분리돼 있다
- [search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/search.usecase.ts)와 [hybrid.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid.usecase.ts)가 이 shared seam를 함께 쓰고 있다
- 새 contract를 넣더라도 dispatch seam 자체는 유용하다

#### B. retrieval service seam

- [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts)
- [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts)
- [channel-mix-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/channel-mix-policy.ts)

유지 이유:

- lane/policy 구조로 승격시키기 좋은 seam이 이미 있다
- 완전 폐기보다 policy table 중심으로 재편하는 게 낫다

#### C. ranking pipeline seam

- [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts)
- [default-ranking-policy.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/default-ranking-policy.ts)

유지 이유:

- stage contract의 외곽은 이미 있다
- 내부의 `Ranker` 책임만 더 잘 쪼개면 된다
- diversity/truncation 같은 default policy hook도 이미 분리돼 있다

#### D. mixed solver seam

- [mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts)

유지 이유:

- anchor/substitute 쿼리를 일반 hybrid와 분리할 수 있는 좋은 책임 경계다

#### E. composition root / contract catalog seam

- [container-core-builders.ts](/Users/songmin/wine-search-engine/src/config/container-core-builders.ts)
- [container-core.ts](/Users/songmin/wine-search-engine/src/config/container-core.ts)
- [http-route-contract-catalog.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-catalog.ts)
- [route-contracts.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-contracts.ts)

유지 이유:

- 실제 wiring과 API contract versioning의 중심이 이미 한 곳에 있다
- runtime migration 시 조립 순서를 바꾸더라도 composition root와 contract catalog를 새로 만들 필요가 없다

#### F. route resolution / eval provenance seam

- [search-usecase-route-resolution.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-route-resolution.ts)
- [search-usecase-eval-provenance.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-eval-provenance.ts)

유지 이유:

- effective route 계산과 eval provenance export가 이미 shared seam로 분리돼 있다
- compiled contract migration 이후에도 이 계층은 adapter/thin layer로 유지하는 편이 낫다

#### G. aux feature / trace alignment seam

- [container-aux-features.ts](/Users/songmin/wine-search-engine/src/config/container-aux-features.ts)
- [trace-vocab-aligner.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/trace-vocab-aligner.ts)

유지 이유:

- tool fallback, eval runner, trace vocab alignment의 조립점이 이미 있다
- rollout/eval loop를 넓힐 때 이 seam를 재사용하는 편이 낫다

#### H. usecase container / route-port / security observer seam

- [container-usecases.ts](/Users/songmin/wine-search-engine/src/config/container-usecases.ts)
- [search-route-usecases.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-route-usecases.port.ts)
- [decomposed-search-adapter.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search-adapter.ts)
- [search-usecase-security-gate.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-security-gate.ts)
- [query-entry-security-metrics.ts](/Users/songmin/wine-search-engine/src/infrastructure/observability/query-entry-security-metrics.ts)
- [route-deps.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-deps.ts)

유지 이유:

- usecase graph와 HTTP dependency contract가 이미 typed seam로 나뉘어 있다
- decomposed-search adapter는 circular dependency break를 맡는 runtime seam라서 없애기보다 유지하는 편이 낫다
- shared security gate factory와 metrics collector를 그대로 써야 public query security가 entrypoint별로 중복되지 않는다

#### I. runtime support / adapter / top-level container seam

- [container-runtime-support.ts](/Users/songmin/wine-search-engine/src/config/container-runtime-support.ts)
- [container-adapters.ts](/Users/songmin/wine-search-engine/src/config/container-adapters.ts)
- [container-eval-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-eval-contracts.ts)
- [container-features.ts](/Users/songmin/wine-search-engine/src/config/container-features.ts)
- [container.ts](/Users/songmin/wine-search-engine/src/config/container.ts)

유지 이유:

- runtime support 초기화, infra adapter wiring, feature aggregation, top-level container가 이미 분리돼 있다
- production guard / stub fallback / thin eval contract를 버리면 중복개발과 startup regression 리스크가 커진다

#### J. watchlist / HTTP surface seam

- [container-watchlist.ts](/Users/songmin/wine-search-engine/src/config/container-watchlist.ts)
- [watchlist.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/watchlist.route.ts)
- [server.ts](/Users/songmin/wine-search-engine/src/interface/http/server.ts)

유지 이유:

- watchlist service/runtime/surface가 이미 productized 돼 있다
- server route registration은 실제 exposed surface SSOT라서, 새 policy rollout도 이 seam을 기준으로 걸어야 한다

#### K. learning ingest / contract manifest / lifecycle seam

- [container-learning.ts](/Users/songmin/wine-search-engine/src/config/container-learning.ts)
- [feedback.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/feedback.route.ts)
- [watchlist-delivery-runtime.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/watchlist-delivery-runtime.ts)
- [register-contract-route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/register-contract-route.ts)
- [http-route-contract-openapi.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-openapi.ts)
- [openapi.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/openapi.route.ts)
- [runtime-handles.ts](/Users/songmin/wine-search-engine/src/config/runtime-handles.ts)

유지 이유:

- feedback/proposal ingestion, route manifest, OpenAPI bridge, runtime shutdown lifecycle이 이미 있다
- rollout/eval/learning을 넓히더라도 새 infra plane을 다시 만들기보다 이 seam를 재사용하는 편이 low-regret다

#### L. external contract / tool / decision transparency seam

- [search-executor.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-executor.port.ts)
- [container-tool-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-tool-contracts.ts)
- [result-item-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/model/result-item-v2.ts)
- [machine-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/machine-response-builder-v2.ts)
- [interpret-explain-adapter-v2.ts](/Users/songmin/wine-search-engine/src/application/search/interpret-explain-adapter-v2.ts)
- [engine-decision.ts](/Users/songmin/wine-search-engine/src/domain/response/model/engine-decision.ts)
- [authority-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/authority-trace.ts)

유지 이유:

- external executor/tool contract와 V2 response alias, decision transparency contract가 이미 있다
- query currency migration이나 response refactor를 하더라도 이 external seam를 깨지 않는 것이 low-regret다

#### M. decomposition / evidence / grouped exploration / calibration seam

- [query-decomposition.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-decomposition.ts)
- [evidence-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/evidence-gate.ts)
- [result-grouper.ts](/Users/songmin/wine-search-engine/src/domain/response/service/result-grouper.ts)
- [query-observability-vocab.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-observability-vocab.ts)
- [calibration-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/calibration-evaluator.ts)
- [pg-calibration-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-calibration-store.ts)
- [search-usecase-counterfactuals.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-counterfactuals.ts)
- [specialized-route-observability.ts](/Users/songmin/wine-search-engine/src/application/search/specialized-route-observability.ts)

유지 이유:

- decomposition hint, evidence obligation, grouped response, calibration persistence, fallback transparency가 이미 있다
- difficulty/abstention/calibration-aware serving을 도입하더라도 이 seam를 승격하는 편이 low-regret다

#### N. response assembly / decision semantics / proposal loop / stub seam

- [decision-input.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-input.ts)
- [decision-output.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-output.ts)
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)
- [alias-proposer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/alias-proposer.ts)
- [pg-proposal-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-proposal-store.ts)
- [blocker.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/blocker.ts)
- [calibrator.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/calibrator.ts)
- [container-stubs.ts](/Users/songmin/wine-search-engine/src/config/container-stubs.ts)

유지 이유:

- response assembly, internal decision authority contract, proposal persistence, stub fallback이 이미 명시적 seam로 있다
- ranking/response/difficulty/confidence refactor를 하더라도 이 seam를 재사용하는 편이 low-regret다

#### O. query policy / threshold / request-response DTO seam

- [query-policy.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-policy.ts)
- [threshold-profile.ts](/Users/songmin/wine-search-engine/src/domain/query/model/threshold-profile.ts)
- [search-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/search-request.dto.ts)
- [clarification.ts](/Users/songmin/wine-search-engine/src/domain/response/model/clarification.ts)
- [counterfactual.ts](/Users/songmin/wine-search-engine/src/domain/response/model/counterfactual.ts)
- [search-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/search-response.ts)
- [query-route.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-route.ts)
- [evidence-mapper.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/evidence-mapper.ts)

유지 이유:

- query policy, threshold, request/response envelope, evidence mapping이 이미 typed contract로 있다
- canonical taxonomy/difficulty SSOT를 도입하더라도 이 DTO seam를 덮어쓰기보다 정렬하는 편이 low-regret다

### 2.2 교체해야 할 seam

#### A. planner port currency

- [search-pipeline-deps.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-pipeline-deps.port.ts)
- [planner-v1-adapter.ts](/Users/songmin/wine-search-engine/src/config/planner-v1-adapter.ts)

교체 이유:

- runtime 전체가 여전히 V1 shape을 소비한다
- 이 상태로는 taxonomy / budget / gate / compiled contract를 제대로 통합하기 어렵다

#### B. route resolution logic

- [search-usecase-route-resolution.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-route-resolution.ts)

교체 이유:

- route resolution이 planner/compiled execution contract의 SSOT가 아니라 별도 로직으로 존재한다
- `ExecutionCompiler`와 역할이 겹친다
- 다만 완전 삭제보다 thin adapter로 축소하는 쪽이 low-regret다

#### C. retrieval input builder

- [search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts)

교체 이유:

- lexical/semantic expansions를 충분히 반영하지 않는다
- query understanding 결과가 retrieval lanes로 충분히 내려가지 않는다

#### D. monolithic ranker responsibilities

- [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)

교체 이유:

- signal compute
- aggregation
- CE gate
- CE rerank
- LTR rerank

이 너무 한 곳에 모여 있다

#### E. V1-centric response mapping

- [search-usecase-map-result-items.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-map-result-items.ts)
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)
- [search-v2.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search-v2.route.ts)

교체 이유:

- V2 builder가 있어도 실제 search route는 V1 projection 중심이다
- explanation contract를 query-family별로 강화하기 어렵다

---

## 3. 현재 코드 기준 “유지 / 접기 / 승격” 분류

### 3.1 유지

- [search-usecase-route-dispatch.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-route-dispatch.ts)
- [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts)
- [mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts)
- [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts)
- [query-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/query/service/query-normalizer.ts)

### 3.2 승격

- [execution-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/execution-compiler.ts)
  현재 테스트/타입 중심 -> runtime SSOT로 승격

- [query-understanding-snapshot.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-understanding-snapshot.ts)
  현재 좋은 이해 계약 -> canonical query schema의 기반

- [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts)
  현재 profile chooser -> lane policy table engine으로 승격

- [human-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/human-response-builder-v2.ts)
  현재 보조 builder -> 실제 search response contract 후보로 승격

### 3.3 접거나 통합

- [planner-v1-adapter.ts](/Users/songmin/wine-search-engine/src/config/planner-v1-adapter.ts)
  최종적으로 제거 대상

- [search-usecase-ltr-rerank.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-ltr-rerank.ts)
  현재 코드 경로상 미사용에 가깝다. `Ranker` 내부 LTR와 중복되므로 하나로 통합하는 게 맞다

- [search-usecase-route-resolution.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-route-resolution.ts)
  `ExecutionCompiler` 중심으로 재편 시 축소 또는 제거 대상

- [search-usecase-map-result-items.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-map-result-items.ts)
  V1 호환 레이어로 축소 대상

### 3.4 구현 직전 duplicate-prevention 태그

`apr-7-v0.4`의 원래 목적이 quality uplift이면서도 중복개발을 막는 것이라면, 구현 항목은 아래 태그로 먼저 판단해야 한다.

- 이 태그는 [appendix-j-existing-asset-registry.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/appendix-j-existing-asset-registry.md)의 분류와 맞춘다.
- 즉 구현자는 먼저 `appendix-j`에서 분류를 확인하고, 여기서는 wave별 적용 지침만 본다.

- `reuse`
  새 모듈을 열지 말고 existing seam를 그대로 재사용한다
- `promote`
  자산은 이미 있으므로 runtime SSOT / policy table / 1급 contract로 승격한다
- `thin_adapter`
  기존 경계를 migration layer로만 얇게 유지하고 점점 줄인다
- `remove_later`
  당장은 남기되 migration이 끝나면 정리 대상이다
- `new_small_module`
  진짜 갭이라 새 모듈은 필요하지만, feature source / storage / observability / contract는 existing seam를 그대로 소비해야 한다

구현 전 체크 순서는 아래로 고정한다.

1. appendix-j에서 동일 역할 asset이 있는지 본다
2. 있으면 `reuse / promote / thin_adapter / remove_later` 중 하나로 처리한다
3. 없을 때만 `new_small_module`을 허용한다
4. `new_small_module`이어도 storage / contract / eval / observability는 existing seam를 재사용한다

#### Wave 1. Query contract migration

| Planned area | Tag | Rule |
| --- | --- | --- |
| runtime query contract migration | `promote` | [query-understanding-snapshot.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-understanding-snapshot.ts), [engine-execution-contract.ts](/Users/songmin/wine-search-engine/src/domain/query/model/engine-execution-contract.ts), [compiled-wine-query.ts](/Users/songmin/wine-search-engine/src/domain/query/model/compiled-wine-query.ts), [execution-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/execution-compiler.ts)를 runtime currency로 승격하고, planner stack을 새로 만들지 않는다 |
| planner port migration | `thin_adapter` | [search-pipeline-deps.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-pipeline-deps.port.ts), [planner-v1-adapter.ts](/Users/songmin/wine-search-engine/src/config/planner-v1-adapter.ts)를 migration boundary로만 유지한다 |
| query difficulty / ambiguity | `promote` | [query-uncertainty.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-uncertainty.ts), [policy-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/policy-compiler.ts), [ambiguity-classifier.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/ambiguity-classifier.ts), [pg-ambiguity-dictionary.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-ambiguity-dictionary.ts)를 feature source로 승격한다 |
| contradiction / fallback constraint handling | `reuse` | [constraint-sat.ts](/Users/songmin/wine-search-engine/src/domain/query/service/constraint-sat.ts), [rule-based-constraint-extractor.ts](/Users/songmin/wine-search-engine/src/domain/query/service/rule-based-constraint-extractor.ts)를 재사용하고 새 preflight validator를 만들지 않는다 |

#### Wave 2. Retrieval policy refactor

| Planned area | Tag | Rule |
| --- | --- | --- |
| lane policy table | `promote` | [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts), [channel-mix-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/channel-mix-policy.ts)를 table-driven engine으로 승격한다 |
| retrieval input migration | `promote` | [retrieval-input.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-input.ts), [search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts)를 compiled query 소비 seam로 바꾸고 second retrieval DTO stack은 만들지 않는다 |
| candidate assembly / protected recall / evidence | `reuse` | [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts), [candidate-assembly.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-assembly.ts), [evidence-accumulator.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/evidence-accumulator.ts), [candidate-constraint-evidence.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-constraint-evidence.ts), [protected-recall-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/protected-recall-policy.ts)를 재사용한다 |
| browse / compare / substitute specialized path | `promote` | [browse-retriever.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/browse-retriever.ts), [compare-retriever.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/compare-retriever.ts), [mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts), [relative-filter-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/relative-filter-policy.ts)를 lane policy 아래로 승격하고 별도 engine을 다시 만들지 않는다 |
| learned sparse / Vespa path | `reuse` | [search-index.port.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/port/search-index.port.ts), [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts), [vespa-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts), [vespa-schema.sd](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-schema.sd)의 existing path를 승격만 한다 |

#### Wave 3. Ranking funnel split

| Planned area | Tag | Rule |
| --- | --- | --- |
| ranking funnel split | `promote` | [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts), [ranking-stage.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-stage.ts), [funnel-metrics.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/funnel-metrics.ts)를 유지한 채 내부 책임만 분리한다 |
| monolithic ranker | `thin_adapter` | [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)는 compatibility shell로 줄이고 signal/CE/LTR/gate를 점진 분리한다 |
| LTR path | `reuse` | [ltr-feature-extractor.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-feature-extractor.ts), [lambdamart-ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/lambdamart-ranker.ts), [ltr-ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-ranker.ts), [ltr-training-service.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-training-service.ts)의 existing seam를 통합 재사용한다 |
| CE / rerank gate | `promote` | [rerank-gate.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/rerank-gate.ts), [rerank-blend.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/rerank-blend.ts)를 multi-signal calibrated gate로 승격한다 |
| ranked-route confidence | `new_small_module` | 새 calibrator는 가능하지만 [ranked-result.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranked-result.ts), [calibration-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/calibration-evaluator.ts), [utility-scorer.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/utility-scorer.ts), [funnel-metrics.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/funnel-metrics.ts)를 feature/eval source로 그대로 써야 한다 |

#### Wave 4. Response and explanation contract

| Planned area | Tag | Rule |
| --- | --- | --- |
| V2 human/machine response 연결 | `promote` | [human-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/human-response-builder-v2.ts), [machine-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/machine-response-builder-v2.ts)를 실제 runtime contract로 승격한다 |
| V1-centric mapping | `thin_adapter` | [search-usecase-map-result-items.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-map-result-items.ts), [search-v2.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search-v2.route.ts)는 호환용 얇은 레이어로 축소한다 |
| explanation / transparency surface | `reuse` | [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts), [clarification.ts](/Users/songmin/wine-search-engine/src/domain/response/model/clarification.ts), [counterfactual.ts](/Users/songmin/wine-search-engine/src/domain/response/model/counterfactual.ts), [interpret-explain-adapter-v2.ts](/Users/songmin/wine-search-engine/src/application/search/interpret-explain-adapter-v2.ts)를 재사용한다 |
| tool / contract surface | `reuse` | [http-route-contract-catalog.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-catalog.ts), [route-contracts.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-contracts.ts), [claude-tools.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/claude-tools.route.ts), [tool-schemas.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/tool-schemas.ts)를 source of truth로 유지한다 |

#### Wave 5. Eval and learning loop alignment

| Planned area | Tag | Rule |
| --- | --- | --- |
| offline eval stack | `reuse` | [eval-runner.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/eval-runner.ts), [slice-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/slice-evaluator.ts), [search-pipeline-evaluator.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/search-pipeline-evaluator.ts), [evidence-auditor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/evidence-auditor.ts), [selective-predictor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/selective-predictor.ts)를 그대로 재사용한다 |
| promotion / threshold / rollout | `promote` | [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts), [threshold-optimizer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/threshold-optimizer.ts), [pg-proposal-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-proposal-store.ts), [pg-threshold-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-threshold-store.ts)를 coordinator 아래로 승격한다 |
| learning persistence | `reuse` | [feedback-store.port.ts](/Users/songmin/wine-search-engine/src/domain/learning/port/feedback-store.port.ts), [proposal-store.port.ts](/Users/songmin/wine-search-engine/src/domain/learning/port/proposal-store.port.ts), [pg-feedback-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-feedback-store.ts)는 이미 있다 |

#### Wave 6. Session state and quality policy

| Planned area | Tag | Rule |
| --- | --- | --- |
| session continuation / reformulation policy | `promote` | [session-context.ts](/Users/songmin/wine-search-engine/src/domain/query/model/session-context.ts), [reformulation-detector.ts](/Users/songmin/wine-search-engine/src/domain/query/service/reformulation-detector.ts)를 serving policy input으로 승격하고 별도 session stack은 만들지 않는다 |
| quality-aware ranking / explanation gate | `promote` | [signal-computer.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/signal-computer.ts), [rerank-gate.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/rerank-gate.ts), [evidence-auditor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/evidence-auditor.ts)를 quality gate 입력으로 승격한다 |
| substitute / decomposition / grouped fallback | `reuse` | [decomposed-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search.usecase.ts), [search-usecase-pre-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts), [result-grouper.ts](/Users/songmin/wine-search-engine/src/domain/response/service/result-grouper.ts)를 그대로 재사용한다 |
| evidence / transparency / side-effect runtime | `reuse` | [search-usecase-counterfactuals.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-counterfactuals.ts), [specialized-route-observability.ts](/Users/songmin/wine-search-engine/src/application/search/specialized-route-observability.ts), [container-watchlist.ts](/Users/songmin/wine-search-engine/src/config/container-watchlist.ts), [watchlist-delivery-runtime.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/watchlist-delivery-runtime.ts), [runtime-handles.ts](/Users/songmin/wine-search-engine/src/config/runtime-handles.ts)를 그대로 재사용한다 |

---

## 4. implementation sequence: 파일 단위 우선순위

### Wave 1. Query contract migration

#### 목표

- `QueryPlanV1` 중심 실행을 끝낸다
- canonical query schema + execution contract를 runtime SSOT로 만든다

#### 먼저 바꿀 파일

1. [search-pipeline-deps.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-pipeline-deps.port.ts)
2. [container-core.ts](/Users/songmin/wine-search-engine/src/config/container-core.ts)
3. [planner-v1-adapter.ts](/Users/songmin/wine-search-engine/src/config/planner-v1-adapter.ts)
4. [execution-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/execution-compiler.ts)
5. [search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/search.usecase.ts)
6. [interpret.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/interpret.usecase.ts)

#### 결과

- planner는 understanding을 반환
- compiler가 execution contract를 붙인다
- usecase는 compiled query를 소비한다
- [search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/search.usecase.ts)와 [hybrid.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid.usecase.ts)의 shared pre/post-route seam 위에서 먼저 바꾸고, entrypoint별 fork를 만들지 않는다
- [constraint-sat.ts](/Users/songmin/wine-search-engine/src/domain/query/service/constraint-sat.ts), [planner.ts](/Users/songmin/wine-search-engine/src/domain/query/service/planner.ts), [policy-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/policy-compiler.ts), [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts)의 existing contradiction/uncertainty/policy spine을 그대로 재사용하고, taxonomy/difficulty SSOT의 feature source로 승격한다
- [search-usecase-planner-context.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-planner-context.ts), [query-budget.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-budget.ts)의 existing session/budget carry-through seam를 재사용하고, 새 session/budget DTO stack은 만들지 않는다
- [alias-matcher.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/alias-matcher.ts), [pg-ambiguity-dictionary.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-ambiguity-dictionary.ts), [ambiguity-classifier.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/ambiguity-classifier.ts)의 existing exact/ambiguity spine은 그대로 재사용한다
- [blocker.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/blocker.ts), [calibrator.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/calibrator.ts), [pg-calibration-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-calibration-store.ts)의 existing resolver spine도 그대로 재사용한다
- resolver-side ML seam는 [candidate-scorer.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/candidate-scorer.ts), [learned-matcher.port.ts](/Users/songmin/wine-search-engine/src/domain/resolver/port/learned-matcher.port.ts), [learned-matcher-features.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/learned-matcher-features.ts), [http-learned-matcher.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/http-learned-matcher.ts)를 재사용한다
- public query entry safety는 [query-entry-security.ts](/Users/songmin/wine-search-engine/src/application/search/query-entry-security.ts), [query-sanitizer.ts](/Users/songmin/wine-search-engine/src/domain/security/service/query-sanitizer.ts), [llm-injection-judge.ts](/Users/songmin/wine-search-engine/src/domain/security/service/llm-injection-judge.ts)의 existing spine를 재사용한다
- [search-usecase-security-gate.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-security-gate.ts), [query-entry-security-metrics.ts](/Users/songmin/wine-search-engine/src/infrastructure/observability/query-entry-security-metrics.ts)의 shared factory/collector seam를 그대로 유지해 search/interpret/resolve/hybrid가 각자 security wiring을 복제하지 않게 한다
- [container-usecases.ts](/Users/songmin/wine-search-engine/src/config/container-usecases.ts), [search-route-usecases.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-route-usecases.port.ts), [decomposed-search-adapter.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search-adapter.ts)의 usecase graph seam을 유지해 planner currency migration이 entrypoint graph를 다시 꼬이게 만들지 않게 한다
- [container-runtime-support.ts](/Users/songmin/wine-search-engine/src/config/container-runtime-support.ts), [container-adapters.ts](/Users/songmin/wine-search-engine/src/config/container-adapters.ts), [container-features.ts](/Users/songmin/wine-search-engine/src/config/container-features.ts), [container.ts](/Users/songmin/wine-search-engine/src/config/container.ts)의 existing container layering을 그대로 재사용하고, 별도 parallel container stack은 만들지 않는다
- [search-executor.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-executor.port.ts), [container-tool-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-tool-contracts.ts), [result-item-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/model/result-item-v2.ts), [engine-decision.ts](/Users/songmin/wine-search-engine/src/domain/response/model/engine-decision.ts)의 external contract seam를 유지해 response/eval/tool surface가 migration 중 흔들리지 않게 한다
- [query-decomposition.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-decomposition.ts), [query-observability-vocab.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-observability-vocab.ts)의 existing decomposition/observability seam를 difficulty/taxonomy SSOT의 입력으로 승격하고, decomposition DTO를 새로 만들지 않는다
- [decision-input.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-input.ts), [decision-output.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-output.ts), [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)의 existing decision/response seam를 유지해 confidence/evidence semantics를 새 레이어에서 다시 정의하지 않게 한다
- [container-stubs.ts](/Users/songmin/wine-search-engine/src/config/container-stubs.ts)의 explicit fallback seam를 유지해 non-production/local runtime path를 새 stub layer로 다시 만들지 않는다
- [query-policy.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-policy.ts), [threshold-profile.ts](/Users/songmin/wine-search-engine/src/domain/query/model/threshold-profile.ts), [query-route.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-route.ts)의 policy/threshold/route contract를 유지해 planner compiler가 같은 개념을 새 타입으로 중복 선언하지 않게 한다
- [search-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/search-request.dto.ts), [search-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/search-response.ts), [clarification.ts](/Users/songmin/wine-search-engine/src/domain/response/model/clarification.ts), [counterfactual.ts](/Users/songmin/wine-search-engine/src/domain/response/model/counterfactual.ts)의 request/response seam를 유지해 HTTP/app/domain 경계를 또 다시 쪼개지 않게 한다

### Wave 2. Retrieval policy refactor

#### 목표

- query taxonomy/difficulty/value 기반 lane policy table 도입
- retrieval input이 query understanding을 제대로 소비하게 만든다

#### 먼저 바꿀 파일

1. [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts)
2. [channel-mix-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/channel-mix-policy.ts)
3. [search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts)
4. [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts)
5. [retrieval-input.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-input.ts)

#### 결과

- expansions, difficulty, lane budgets가 retrieval에 실제 반영된다
- queryFamily는 observability용이 아니라 derived view로 정리된다
- [expansion-builder.ts](/Users/songmin/wine-search-engine/src/domain/query/service/expansion-builder.ts)의 existing lexical/semantic expansion asset을 재사용하고, retrieval input wiring에서 under-consumed된 부분만 풀어준다
- exact/noisy entity lookup 쪽은 [query-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/query/service/query-normalizer.ts)의 query-side multi-view 자산을 재사용한다
- learned sparse는 greenfield가 아니라 [search-index.port.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/port/search-index.port.ts), [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts), [vespa-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts), [vespa-schema.sd](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-schema.sd)의 existing path를 승격한다
- ontology/facet canonicalization은 [ontology-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/attribute/service/ontology-normalizer.ts), [structured-extractor.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/structured-extractor.ts), [projection-builder.ts](/Users/songmin/wine-search-engine/src/domain/entity/service/projection-builder.ts)를 재사용한다
- retrieval document는 [retrieval-document.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-document.ts)의 hit/feature projection boundary를 유지하면서 multi-view / view-family로 확장한다
- product-centered multi-view retrieval은 별도 item/view index 전략으로 확장한다
- availability/price/critic event seam는 [watchlist-aware-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/watchlist-aware-search-index.ts), [watchlist-policy.ts](/Users/songmin/wine-search-engine/src/domain/watchlist/service/watchlist-policy.ts)를 재사용한다
- [browse-retriever.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/browse-retriever.ts), [compare-retriever.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/compare-retriever.ts), [search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts)의 existing specialized retrieval path를 버리지 않고, broad/substitute lane policy table 아래로 통합 승격한다

### Wave 3. Ranking funnel split

#### 목표

- `R1 broad/cheap`
- `R2 narrow/expensive`

를 코드 구조로 분리한다

#### 먼저 바꿀 파일

1. [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)
2. [rerank-gate.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/rerank-gate.ts)
3. [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts)
4. [signal-computer.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/signal-computer.ts)
5. [ltr-feature-extractor.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-feature-extractor.ts)
6. [search-usecase-ltr-rerank.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-ltr-rerank.ts)

#### 결과

- LTR broad application
- CE gated narrow application
- uncertainty / difficulty / value-aware gate
- [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts), [abstain-policy.ts](/Users/songmin/wine-search-engine/src/domain/query/service/abstain-policy.ts), [admission-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/admission-gate.ts)의 existing safety spine 위에 retrieval/rerank policy를 연결한다
- [search-usecase-ranked-route-resolve.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-ranked-route-resolve.ts)의 synthetic ranked-route confidence를 대체할 ranked-route calibrator를 도입한다
- quality-enriched result policy는 [drinking-window-predictor.ts](/Users/songmin/wine-search-engine/src/infrastructure/ml/drinking-window-predictor.ts), [drinking-window-confidence.ts](/Users/songmin/wine-search-engine/src/application/search/drinking-window-confidence.ts), [search-usecase-map-result-items.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-map-result-items.ts)의 existing model/evidence/blocking seam를 재사용한다
- [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts), [funnel-metrics.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/funnel-metrics.ts), [ranking-runtime-signal.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-runtime-signal.ts)의 existing stage/funnel observability contract를 유지한 채, 내부 책임만 [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)에서 분리한다
- [default-ranking-policy.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/default-ranking-policy.ts)의 existing producer-diversity/truncation hook를 새 policy engine의 초기 구현 기반으로 재사용한다

### Wave 4. Response and explanation contract

#### 목표

- query-family별 explanation obligation 도입
- human/machine result contract를 실제 search route에 연결

#### 먼저 바꿀 파일

1. [human-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/human-response-builder-v2.ts)
2. [machine-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/machine-response-builder-v2.ts)
3. [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)
4. [search-v2.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search-v2.route.ts)
5. [search-usecase-map-result-items.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-map-result-items.ts)

#### 결과

- V1 projection 중심 구조에서 벗어난다
- explanation이 evidence contract 위에서 작동한다
- [result-item.ts](/Users/songmin/wine-search-engine/src/domain/response/model/result-item.ts), [clarification.ts](/Users/songmin/wine-search-engine/src/domain/response/model/clarification.ts), [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts), [interpret-explain-adapter-v2.ts](/Users/songmin/wine-search-engine/src/application/search/interpret-explain-adapter-v2.ts)의 existing response surface를 승격한다
- [search-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/search-response.ts), [counterfactual.ts](/Users/songmin/wine-search-engine/src/domain/response/model/counterfactual.ts), [specialized-route-observability.ts](/Users/songmin/wine-search-engine/src/application/search/specialized-route-observability.ts)의 parsedConstraints / retrieval provenance / fallback transparency contract를 그대로 재사용한다
- [search-v2.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search-v2.route.ts), [machine-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/machine-response-builder-v2.ts), [tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/tool-executor.ts)의 existing human/machine/explain V2 seam를 버리지 않고 정렬한다
- [http-route-contract-catalog.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-catalog.ts), [route-contracts.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-contracts.ts), [search-response-v2.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response-v2.schema.ts)의 existing contract catalog를 source of truth로 유지한다
- broad exploration response는 [result-grouper.ts](/Users/songmin/wine-search-engine/src/domain/response/service/result-grouper.ts)의 existing producer_set / region_set / style_set / wine_set surface를 재사용하고, front에서만 다시 group semantics를 만들지 않는다
- browse/compare specialized path transparency는 [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts)와 [specialized-route-observability.ts](/Users/songmin/wine-search-engine/src/application/search/specialized-route-observability.ts)의 existing runtime wiring을 그대로 활용한다

### Wave 5. Eval and learning loop alignment

#### 목표

- taxonomy-aligned eval
- evidence vocabulary alignment
- hard negative / replay / uplift tracking 루프 정리

#### 먼저 바꿀 파일

1. [slice-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/slice-evaluator.ts)
2. [eval-runner.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/eval-runner.ts)
3. [search-pipeline-evaluator.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/search-pipeline-evaluator.ts)
4. [evidence-mapper.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/evidence-mapper.ts)

#### 결과

- explanation / eval / ranking signal vocabulary가 정렬된다
- 기존 [feedback.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/feedback.route.ts), [feedback-processor.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/feedback-processor.ts), [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts)를 재사용해 offline-only 평가가 아니라 serving 개선 루프로 연결한다
- [kill-switch-policy.ts](/Users/songmin/wine-search-engine/src/config/kill-switch-policy.ts)의 existing degrade/authoritative policy seam를 rollout governor 입력으로 재사용하고, 새 kill-switch 체계는 만들지 않는다
- browse 계열 diversity는 [browse-diversity.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/browse-diversity.ts), protected recall은 [protected-recall-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/protected-recall-policy.ts)를 기반으로 일반화한다
- [ranking-stage.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-stage.ts), [funnel-metrics.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/funnel-metrics.ts), [ranking-runtime-signal.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-runtime-signal.ts)의 existing observability contract를 promotion gate와 연결한다
- [threshold-optimizer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/threshold-optimizer.ts), [threshold-proposal.ts](/Users/songmin/wine-search-engine/src/domain/learning/model/threshold-proposal.ts), [pg-proposal-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-proposal-store.ts)의 existing shadow/promotion asset을 그대로 재사용한다
- [pg-snapshot-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-snapshot-store.ts), [search-usecase-decision-snapshot.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-decision-snapshot.ts), [cache-policy.ts](/Users/songmin/wine-search-engine/src/domain/cache/cache-policy.ts)의 existing snapshot/version governance를 rollout gate와 연결한다
- [replay.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/replay.usecase.ts), [snapshot-version-contract.ts](/Users/songmin/wine-search-engine/src/application/search/snapshot-version-contract.ts), [cache-service.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-service.ts), [cache-eligibility.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-eligibility.ts)의 existing replay/cache determinism spine도 serving rollout과 연결한다
- selective answering governance는 [selective-predictor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/selective-predictor.ts), authority/audit governance는 [authority-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/authority-trace.ts), [engine-decision.ts](/Users/songmin/wine-search-engine/src/domain/response/model/engine-decision.ts)를 재사용한다
- [search-executor.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-executor.port.ts), [batch-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/batch-search.usecase.ts), [hybrid.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid.usecase.ts)의 multi-entry executor seam를 유지해 rollout이 main search만 깨지지 않도록 한다
- [search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/search.usecase.ts)의 `executeForEvaluation()` seam를 재사용해 별도 evaluation-only search stack을 만들지 않는다
- [search-usecase-eval-provenance.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-eval-provenance.ts)의 existing vocab-align/export seam를 그대로 재사용해 eval channel drift를 줄인다
- [trace-vocab-aligner.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/trace-vocab-aligner.ts)를 canonical vocab SSOT로 두고, runtime/eval vocabulary를 별도로 다시 정의하지 않는다
- [search-usecase-cache-integration.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-cache-integration.ts)는 참고용 typed note로만 취급하고, 실제 캐시 통합은 existing cache runtime path 위에서 진행한다
- [container-eval-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-eval-contracts.ts)의 thin contract를 유지하고, eval runner exposure는 [container-features.ts](/Users/songmin/wine-search-engine/src/config/container-features.ts), [route-deps.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-deps.ts), [server.ts](/Users/songmin/wine-search-engine/src/interface/http/server.ts)의 기존 노출 path를 그대로 사용한다
- [container-learning.ts](/Users/songmin/wine-search-engine/src/config/container-learning.ts), [feedback.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/feedback.route.ts), [register-contract-route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/register-contract-route.ts), [http-route-contract-openapi.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-openapi.ts), [openapi.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/openapi.route.ts)의 existing ingest/manifest/openapi seam를 그대로 유지해 learning/eval surface를 이중화하지 않는다
- [search-executor.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-executor.port.ts)의 executeForEvaluation contract를 유지하고, [container-tool-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-tool-contracts.ts)와 [result-item-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/model/result-item-v2.ts)의 external type seam도 그대로 재사용한다
- calibration persistence는 [pg-calibration-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-calibration-store.ts), calibration audit은 [calibration-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/calibration-evaluator.ts)의 existing seam를 그대로 재사용한다
- alias/threshold proposal loop는 [alias-proposer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/alias-proposer.ts), [pg-proposal-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-proposal-store.ts)의 existing seam를 그대로 재사용하고, learning governor와만 연결한다

### Wave 6. Session state and quality policy

#### 목표

- session continuation primitive를 serving policy로 승격한다
- catalog/evidence quality를 ranking/explanation gate에 연결한다

#### 먼저 바꿀 파일

1. [session-context.ts](/Users/songmin/wine-search-engine/src/domain/query/model/session-context.ts)
2. [reformulation-detector.ts](/Users/songmin/wine-search-engine/src/domain/query/service/reformulation-detector.ts)
3. [signal-computer.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/signal-computer.ts)
4. [rerank-gate.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/rerank-gate.ts)
5. [human-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/human-response-builder-v2.ts)
6. [evidence-auditor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/evidence-auditor.ts)
7. [anchor-profiler.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/anchor-profiler.ts)

#### 결과

- session continuation이 query understanding에만 머물지 않고 ranking/policy로 내려간다
- low-metadata / low-evidence 결과를 serving-time에 제어할 수 있다
- explanation suppression / abstention / diversified fallback 규칙을 코드 계약으로 고정한다
- comparison decomposition은 [decomposed-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search.usecase.ts)와 [search-usecase-pre-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts)의 existing branch를 유지하고, long-NL decomposition/repair만 별도 확장한다
- ingestion quality는 [noise-stripper.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/noise-stripper.ts), [contamination-detector.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/contamination-detector.ts)의 existing asset을 quality policy 입력으로 승격한다
- transparency layer는 [search-usecase-counterfactuals.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-counterfactuals.ts), [specialized-route-observability.ts](/Users/songmin/wine-search-engine/src/application/search/specialized-route-observability.ts), [cache-policy.ts](/Users/songmin/wine-search-engine/src/domain/cache/cache-policy.ts)의 existing asset을 그대로 재사용한다
- evidence quality는 [evidence-auditor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/evidence-auditor.ts), calibration quality는 [calibration-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/calibration-evaluator.ts)의 existing audit asset을 serving guard 기준으로 연결한다
- watchlist/inventory side-effect surface는 [container-watchlist.ts](/Users/songmin/wine-search-engine/src/config/container-watchlist.ts), [watchlist.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/watchlist.route.ts), [watchlist.service.ts](/Users/songmin/wine-search-engine/src/application/watchlist/watchlist.service.ts)의 existing seam를 그대로 재사용하고, ranking/value loop와의 연결만 추가한다
- [watchlist-delivery-runtime.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/watchlist-delivery-runtime.ts), [runtime-handles.ts](/Users/songmin/wine-search-engine/src/config/runtime-handles.ts)의 existing delivery/lifecycle seam를 그대로 재사용해 side-effect runtime과 shutdown contract를 새로 만들지 않는다
- decision transparency는 [engine-decision.ts](/Users/songmin/wine-search-engine/src/domain/response/model/engine-decision.ts), [authority-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/authority-trace.ts)의 existing contract를 그대로 재사용하고, calibrated confidence semantics만 더 정교화한다
- grouped exploration은 [result-grouper.ts](/Users/songmin/wine-search-engine/src/domain/response/service/result-grouper.ts)의 existing seam를 그대로 재사용하고, difficulty/abstention policy에만 연결한다
- evidence obligation은 [evidence-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/evidence-gate.ts)의 existing contract를 그대로 재사용하고, query-family별 explanation obligation만 더 붙인다
- response assembly는 [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)의 no-evidence guard / grouped projection / degradation propagation / provenance meta seam를 그대로 재사용하고, V1/V2 bridge만 점진적으로 옮긴다
- ranking evidence surface는 [evidence-mapper.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/evidence-mapper.ts)의 existing mapping을 그대로 재사용하고, signal vocabulary만 policy table과 정렬한다

---

## 5. 최소 신규 모듈 후보

주의: 아래 항목은 “바로 새 파일을 만들라”는 뜻이 아니다.  
우선순위는 항상 아래 순서다.

1. existing asset을 `promote`할 수 있는지 본다
2. existing seam를 `thin_adapter`로 정리할 수 있는지 본다
3. 그래도 안 될 때만 **작은 coordinator / policy module**을 새로 만든다

즉 아래 후보는 모두 `new_small_module` 관점의 **최소 신규 후보**다.  
구현 전에 반드시 [appendix-j-existing-asset-registry.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/appendix-j-existing-asset-registry.md)의 `reuse / promote / thin_adapter / remove_later` 분류를 먼저 확인한다.

### 5.1 canonical query schema

추천 위치:

- `src/domain/query/model/canonical-query.ts`

역할:

- dominant intent
- side intents
- hard/soft constraints
- anchor / relative ops
- difficulty / value / exact confidence

우선 원칙:

- 먼저 [query-understanding-snapshot.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-understanding-snapshot.ts), [compiled-wine-query.ts](/Users/songmin/wine-search-engine/src/domain/query/model/compiled-wine-query.ts)를 `promote`하는 쪽을 우선 검토한다
- 정말 필요한 경우에만 별도 canonical schema 파일을 만든다

### 5.2 execution policy compiler

추천 위치:

- `src/domain/query/service/query-execution-policy.ts`

역할:

- lane mix
- candidate budget
- rerank budget
- explanation obligation
- abstention mode

우선 원칙:

- 먼저 [execution-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/execution-compiler.ts), [policy-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/policy-compiler.ts), [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts), [channel-mix-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/channel-mix-policy.ts)의 정렬/승격으로 해결할 수 있는지 본다

### 5.3 difficulty estimator

추천 위치:

- `src/domain/query/service/query-difficulty-estimator.ts`

역할:

- ambiguity
- exact confidence
- disagreement
- metadata risk
- existing [query-uncertainty.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-uncertainty.ts)와 [policy-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/policy-compiler.ts)를 대체하는 것이 아니라 상위 feature source로 정리해 재사용한다
- existing [alias-matcher.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/alias-matcher.ts), [pg-ambiguity-dictionary.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-ambiguity-dictionary.ts), [ambiguity-classifier.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/ambiguity-classifier.ts)의 exact/ambiguity 신호를 그대로 feature source로 흡수한다

### 5.4 lane registry

추천 위치:

- `src/domain/retrieval/model/lane-registry.ts`
- `src/domain/retrieval/service/lane-policy.ts`

역할:

- lane capability
- cost class
- budget defaults
- feature exports

우선 원칙:

- 새 retrieval engine registry를 만드는 것이 아니라 [retrieval-input.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-input.ts), [candidate-envelope.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/candidate-envelope.ts), [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts)를 policy registry로 승격하는 쪽을 먼저 본다

### 5.5 explanation policy

추천 위치:

- `src/domain/response/service/explanation-policy.ts`

역할:

- query-family별 explanation requirement
- evidence minimum threshold
- fallback/suppress policy

### 5.6 learning loop coordinator

추천 위치:

- `src/domain/learning/service/search-learning-loop.ts`

역할:

- feedback aggregation 결과를 search promotion gate와 연결
- hard-negative mining job 입력 생성
- teacher-student distillation candidate 집계
- offline uplift와 serving promotion rule 연결

기존 [feedback-processor.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/feedback-processor.ts), [alias-proposer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/alias-proposer.ts), [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts)를 재사용하는 쪽이 맞다.

### 5.7 calibration and abstention coordinator

추천 위치:

- `src/domain/decision/service/query-risk-policy.ts`

역할:

- query difficulty / retrieval disagreement / metadata risk / calibrated confidence를 한 정책으로 묶는다
- existing [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts), [abstain-policy.ts](/Users/songmin/wine-search-engine/src/domain/query/service/abstain-policy.ts), [confidence-refusal.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/confidence-refusal.ts)를 조합해 route-specific abstain/clarify/resolve semantics를 정리한다
- existing [resolver.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/resolver.ts), [calibrator.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/calibrator.ts), [evidence-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/evidence-gate.ts)의 resolver-side confidence/evidence semantics와도 정렬한다

### 5.8 ranked-route calibrator

추천 위치:

- `src/domain/decision/service/ranked-route-calibrator.ts`

우선 원칙:

- 이 항목은 비교적 진짜 신규에 가깝지만, [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts)를 복제하면 안 된다
- [ranked-result.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranked-result.ts), [funnel-metrics.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/funnel-metrics.ts), [calibration-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/calibration-evaluator.ts), [utility-scorer.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/utility-scorer.ts)의 existing seam를 그대로 feature/eval source로 쓴다

역할:

- hybrid/mixed ranked route의 `finalScore -> decisionConfidenceC` synthetic mapping을 대체한다
- funnel metric, rerank margin, retriever disagreement, metadata risk를 결합해 ranked-route confidence semantics를 명시적으로 보정한다
- [search-usecase-ranked-route-resolve.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-ranked-route-resolve.ts)의 synthetic confidence path를 축소한다

### 5.9 rollout governance coordinator

추천 위치:

- `src/domain/learning/service/search-rollout-governor.ts`

역할:

- threshold/alias proposal, expensive reranker rollout, lane policy rollout을 하나의 승격 규칙으로 묶는다
- existing [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts), [threshold-optimizer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/threshold-optimizer.ts), [cache-policy.ts](/Users/songmin/wine-search-engine/src/domain/cache/cache-policy.ts), [ranking-runtime-signal.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-runtime-signal.ts)를 조합해 drift-aware rollout contract를 만든다
- existing [pg-snapshot-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-snapshot-store.ts)와 [search-usecase-decision-snapshot.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-decision-snapshot.ts)를 재사용해 snapshot-aware rollout guard를 만든다

### 5.10 중복개발 방지 체크맵

이 표는 `apr-7-v0.4` 구현자가 새 파일을 만들기 전에 확인해야 하는 build-vs-reuse map이다.
태그 의미는 위 `3.4 구현 직전 duplicate-prevention 태그`와 동일하게 유지한다.
여기서의 태그는 “이 영역을 최종적으로 어떻게 처리할 것인가”를 뜻한다.  
즉 파일명 후보가 적혀 있어도, 태그가 `promote`면 **새 파일 생성보다 existing asset 승격이 우선**이다.

| Planned area | Tag | Do this | Do not do this |
| --- | --- | --- | --- |
| canonical query schema | `promote` | [query-understanding-snapshot.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-understanding-snapshot.ts), [compiled-wine-query.ts](/Users/songmin/wine-search-engine/src/domain/query/model/compiled-wine-query.ts), [engine-execution-contract.ts](/Users/songmin/wine-search-engine/src/domain/query/model/engine-execution-contract.ts)를 runtime source contract로 승격한다 | 같은 개념을 `canonical-query.ts`에 새로 전부 재정의하지 않는다 |
| execution policy compiler | `promote` | [execution-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/execution-compiler.ts), [policy-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/policy-compiler.ts), [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts), [channel-mix-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/channel-mix-policy.ts)를 하나의 policy path로 정렬한다 | `query-execution-policy.ts`에 별도 planner/route compiler를 새로 만든다 |
| difficulty estimator | `new_small_module` | [query-uncertainty.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-uncertainty.ts), [ambiguity-classifier.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/ambiguity-classifier.ts), [alias-matcher.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/alias-matcher.ts), [candidate-scorer.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/candidate-scorer.ts)의 신호를 모으는 작은 estimator로 둔다 | 별도 ambiguity/exact matcher stack을 만든다 |
| lane registry / lane policy | `promote` | [retrieval-input.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-input.ts), [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts), [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts), [channel-mix-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/channel-mix-policy.ts), [candidate-envelope.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/candidate-envelope.ts)를 lane table currency로 승격한다 | `candidate-pool` 옆에 새 retrieval engine을 만든다 |
| candidate assembly / constraint evidence | `reuse` | [candidate-assembly.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-assembly.ts), [candidate-constraint-evidence.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-constraint-evidence.ts), [constraint-filter.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/constraint-filter.ts), [relative-filter-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/relative-filter-policy.ts)를 policy table에 연결한다 | hard filter / protected recall / relative filter를 route별로 다시 구현한다 |
| ranking funnel split | `promote` | [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts), [ranking-input.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-input.ts), [ranked-result.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranked-result.ts), [rerank-gate.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/rerank-gate.ts), [ltr-ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-ranker.ts)를 stage별로 정렬한다 | [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)에 새 CE/LTR/late-interaction 책임을 계속 넣는다 |
| explanation policy | `new_small_module` | [evidence-mapper.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/evidence-mapper.ts), [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts), [human-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/human-response-builder-v2.ts), [machine-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/machine-response-builder-v2.ts), [interpret-explain-adapter-v2.ts](/Users/songmin/wine-search-engine/src/application/search/interpret-explain-adapter-v2.ts)를 evidence obligation table에 연결하는 작은 policy module만 추가한다 | 새 response/explanation builder stack을 만든다 |
| learning loop coordinator | `new_small_module` | [feedback-processor.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/feedback-processor.ts), [feedback-store.port.ts](/Users/songmin/wine-search-engine/src/domain/learning/port/feedback-store.port.ts), [pg-feedback-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-feedback-store.ts), [alias-proposer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/alias-proposer.ts), [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts)를 연결하는 coordinator만 추가한다 | feedback/proposal/eval persistence를 다시 만든다 |
| calibration and abstention coordinator | `new_small_module` | [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts), [evidence-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/evidence-gate.ts), [admission-policy.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/admission-policy.ts), [confidence-refusal.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/confidence-refusal.ts), [calibrator.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/calibrator.ts)를 route-risk policy로 정렬한다 | resolver-side confidence와 ranked-route confidence를 별도 decision layer로 갈라 만든다 |
| ranked-route calibrator | `new_small_module` | [search-usecase-ranked-route-resolve.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-ranked-route-resolve.ts)의 synthetic `finalScore -> confidence` path를 대체하는 작은 calibrator를 추가한다 | [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts)를 복제하거나 response confidence contract를 새로 만든다 |
| rollout governance coordinator | `new_small_module` | [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts), [threshold-optimizer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/threshold-optimizer.ts), [pg-threshold-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-threshold-store.ts), [cache-policy.ts](/Users/songmin/wine-search-engine/src/domain/cache/cache-policy.ts), [ranking-runtime-signal.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-runtime-signal.ts), [search-usecase-decision-snapshot.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-decision-snapshot.ts)를 한 promotion rule로 묶는 작은 coordinator만 추가한다 | 새 rollout/kill-switch/snapshot 체계를 만든다 |
| catalog / alias / resolver foundation | `reuse` | [entity-repository.port.ts](/Users/songmin/wine-search-engine/src/domain/entity/port/entity-repository.port.ts), [pg-entity-repository.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-entity-repository.ts), [identity-signature.service.ts](/Users/songmin/wine-search-engine/src/domain/entity/service/identity-signature.service.ts), [source-trust-profile.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/model/source-trust-profile.ts), [alias-repository.port.ts](/Users/songmin/wine-search-engine/src/domain/alias/port/alias-repository.port.ts), [transliterator.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/transliterator.ts), [blocking.port.ts](/Users/songmin/wine-search-engine/src/domain/resolver/port/blocking.port.ts)를 재사용한다 | master-data repository, alias matcher, blocking recall stack을 새로 만든다 |
| contract / composition / tool surface | `reuse` | [container-core.ts](/Users/songmin/wine-search-engine/src/config/container-core.ts), [container-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-contracts.ts), [container-search-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-search-contracts.ts), [http-route-contract-catalog.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-catalog.ts), [claude-tools.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/claude-tools.route.ts), [tool-schemas.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/tool-schemas.ts)를 유지한다 | parallel container, parallel route manifest, parallel tool schema registry를 만든다 |

---

## 6. 구현할 때 꼭 피해야 할 것

1. `QueryPlanV1` 위에 필드를 더 덧대는 방식
이건 migration을 더 늦춘다.

2. `Ranker` 안에 새 모델을 계속 추가하는 방식
CE, LTR, late interaction이 계속 한 파일에 쌓인다.

3. query taxonomy를 observability label로만 두는 방식
runtime policy SSOT가 따로 생겨 또 분산된다.

4. response contract를 마지막까지 V1 projection으로 두는 방식
explanation/evidence 설계가 계속 왜곡된다.

---

## 7. 코드 기준 최종 판단

이번 재스캔 기준으로 보면:

- 현재 레포는 “아키텍처가 없는 상태”는 아니다
- 오히려 seam은 꽤 많고, 구조 자산도 좋다

하지만 동시에:

- runtime currency가 아직 `QueryPlanV1`
- retrieval policy가 `profile + family + mode + dispatch`로 분산
- ranking이 `Ranker`에 과응집
- V2 response가 실제 메인 search path에 안 붙어 있음

즉 구현 관점의 핵심은  
**새 시스템을 하나 더 만드는 것보다, 기존 seam을 올바른 source of truth 위에 다시 정렬하는 것**이다.

---

## 8. 한 줄 결론

코드레벨에서 가장 먼저 해야 할 일은:

1. `QueryPlanV1` 세계를 끝내고 compiled execution contract를 runtime SSOT로 올리는 것
2. retrieval을 lane policy table 기반으로 재정렬하는 것
3. ranking에서 LTR/CE/uncertainty/policy를 단계별로 분리하는 것

이 세 개다.
