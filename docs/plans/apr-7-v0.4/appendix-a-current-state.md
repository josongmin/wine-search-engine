# Appendix A: Current Engine State and Integration Gaps

이 문서는 2026-04-07 기준 현재 레포를 실제 코드 경로 중심으로 스캔한 결과를 요약한다.  
핵심 질문은 세 가지다.

1. 어디까지 구현되어 있는가
2. 무엇이 부족한가
3. 무엇이 “있지만 분산되어 있고 통합되지 않았는가”

결론부터 말하면:

> 현재 엔진은 `hybrid + gated rerank + intent-aware fragments`까지는 이미 구현돼 있다.  
> 하지만 `taxonomy / routing / retrieval lanes / gate / ranking funnel / explanation / eval`이 하나의 공식 policy contract로 묶여 있지 않다.

---

## 1. 이미 강하게 구현된 것

### 1.1 Hybrid retrieval core

현재 검색 엔진의 1차 retrieval는 이미 hybrid 구조다.

- sparse BM25
- learned sparse retrieval path
- dense semantic
- anchor / relative structural channels
- RRF fusion

핵심 파일:

- [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts)
- [candidate-assembly.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-assembly.ts)
- [evidence-accumulator.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/evidence-accumulator.ts)
- [fusion.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/fusion.ts)
- [hybrid-candidate-summary.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/hybrid-candidate-summary.ts)
- [retrieval-channel.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-channel.ts)
- [vespa-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts)
- [search-index.port.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/port/search-index.port.ts)
- [vespa-schema.sd](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-schema.sd)
- [cascade-router.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/cascade-router.ts)

평가:

- `hybrid 1차`라는 큰 줄기는 이미 맞다
- sparse / dense / anchor를 lane 비슷하게 다루는 기초도 있다
- learned sparse도 아이디어 수준이 아니라 `SearchIndexPort.searchLearnedSparse -> CandidatePool -> Vespa rank profile / tensor field`까지 이어지는 end-to-end seam이 이미 있다
- [evidence-accumulator.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/evidence-accumulator.ts)는 duplicate entity 후보를 cross-channel evidence로 병합해 provenance를 downstream에 보존한다
- [candidate-assembly.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-assembly.ts)는 hard filter, protected recall, quota/max-total을 가진 structured assembly layer라서 lane policy table이 얹힐 자리가 이미 있다
- [hybrid-candidate-summary.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/hybrid-candidate-summary.ts)는 retrieval hit summary normalization/merge를 공통화해서 rerank/response에서 같은 candidate metadata contract를 재사용하게 만든다

### 1.2 Cross-encoder rerank

2차 precision rerank도 이미 있다.

- top-K cross-encoder rerank
- query class별 blend weight
- HTTP reranker adapter

핵심 파일:

- [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)
- [rerank-gate.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/rerank-gate.ts)
- [rerank-blend.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/rerank-blend.ts)
- [reranker.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/reranker.ts)

평가:

- `CE는 2차 top-K`라는 기본 패턴은 구현됨
- exact 쪽에서 CE를 약하게, semantic 쪽에서 강하게 쓰려는 방향도 일부 있음

### 1.3 Mixed / anchor / pairing 흔적

도메인 특화 query를 위한 축도 이미 부분 구현돼 있다.

- mixed route + anchor profile
- similar retrieval
- relative query extractor
- pairing extractor

핵심 파일:

- [mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts)
- [anchor-profiler.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/anchor-profiler.ts)
- [relative-query-extractor.ts](/Users/songmin/wine-search-engine/src/domain/query/service/relative-query-extractor.ts)
- [pairing-extractor.ts](/Users/songmin/wine-search-engine/src/domain/query/service/pairing-extractor.ts)

평가:

- substitute / pairing / mixed-intent로 가는 방향성은 이미 존재
- 다만 실행 정책의 중심부로 완전히 승격되지는 않음

### 1.3.1 Resolver ML seam도 이미 있다

entity resolution 쪽 learned matcher seam도 이미 꽤 있다.

- raw candidate scorer
- learned matcher port
- learned matcher feature vector
- HTTP adapter
- resolver-side blend path

핵심 파일:

- [candidate-scorer.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/candidate-scorer.ts)
- [learned-matcher.port.ts](/Users/songmin/wine-search-engine/src/domain/resolver/port/learned-matcher.port.ts)
- [learned-matcher-features.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/learned-matcher-features.ts)
- [resolver.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/resolver.ts)
- [http-learned-matcher.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/http-learned-matcher.ts)

평가:

- exact/noisy entity lookup을 위한 ML blend seam은 이미 있다
- 따라서 entity resolution ML을 새로 설계할 때도 resolver 바깥에 별도 실험 파이프라인을 만드는 것보다 existing resolver seam를 확장하는 편이 맞다

### 1.4 Eval / observability / contract safety

이 레포의 큰 강점이다.

- planner / route / pipeline trace
- offline eval
- noisy entity eval
- HTTP contract tests
- replay / snapshot / debug path

핵심 파일:

- [eval-runner.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/eval-runner.ts)
- [slice-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/slice-evaluator.ts)
- [search-pipeline-evaluator.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/search-pipeline-evaluator.ts)
- [pipeline-debug-steps.ts](/Users/songmin/wine-search-engine/src/observability/pipeline-debug-steps.ts)

평가:

- 구조를 갈아엎더라도 검증 장치가 있는 편
- 그래서 SOTA++ 방향 리팩터링을 실제로 시도할 수 있는 상태

### 1.4.1 Control plane / runtime degrade / executor seam도 이미 있다

성능 로드맵을 깔 때도 완전 greenfield control plane은 아니다.

- declarative kill-switch policy
- ranker runtime signal 기반 degraded/authoritative 판정
- batch executor / search executor 포트
- hybrid 전용 엔트리포인트의 shared pipeline reuse

핵심 파일:

- [kill-switch-policy.ts](/Users/songmin/wine-search-engine/src/config/kill-switch-policy.ts)
- [search-executor.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-executor.port.ts)
- [batch-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/batch-search.usecase.ts)
- [hybrid.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid.usecase.ts)

평가:

- [kill-switch-policy.ts](/Users/songmin/wine-search-engine/src/config/kill-switch-policy.ts)는 learning / injection judge / drinking-window fallback에 대한 declarative SSOT를 이미 둔다
- 같은 파일의 cache runtime state builder는 ranker runtime signal과 kill switch를 합쳐 authoritative/degraded 힌트를 만든다
- [search-executor.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-executor.port.ts)는 main search, batch search, evaluation runner가 공유하는 executor seam이다
- [batch-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/batch-search.usecase.ts)는 병렬/fail-fast batch orchestration을 이미 갖고 있고, [hybrid.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid.usecase.ts)는 pre/post-route phase를 재사용하는 별도 public entrypoint다

즉 rollout / degrade / executor control-plane도 이미 부분 productized 돼 있다.  
남은 갭은 이것을 retrieval/rerank rollout governor와 taxonomy-aligned promotion policy로 통합하지 못한 점이다.

### 1.4.2 Shared orchestration / evaluation seam도 이미 있다

search, hybrid, eval path도 생각보다 공통화가 많이 돼 있다.

- shared pre-route / post-route phase
- route dispatch helper
- evaluation-only provenance/funnel export
- composition root builder

핵심 파일:

- [search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/search.usecase.ts)
- [hybrid.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid.usecase.ts)
- [search-usecase-route-dispatch.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-route-dispatch.ts)
- [search-usecase-pre-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts)
- [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts)
- [search-executor.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-executor.port.ts)
- [container-core-builders.ts](/Users/songmin/wine-search-engine/src/config/container-core-builders.ts)
- [container-core.ts](/Users/songmin/wine-search-engine/src/config/container-core.ts)

평가:

- [search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/search.usecase.ts)와 [hybrid.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid.usecase.ts)는 같은 pre/post-route phase와 ranking helper를 재사용한다
- [search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/search.usecase.ts)의 `executeForEvaluation()`는 retrieval provenance slice와 funnel metric을 이미 포트 레벨로 노출한다
- [container-core-builders.ts](/Users/songmin/wine-search-engine/src/config/container-core-builders.ts)는 planner/resolver/retrieval/ranking/decision/response 조립의 실제 composition root 역할을 한다
- [container-core.ts](/Users/songmin/wine-search-engine/src/config/container-core.ts)는 V1 adapter, ranking pipeline, mixed solver, cache runtime state provider까지 한 곳에서 묶는다

즉 search/hybrid/eval wiring도 완전 분산된 상태가 아니다.  
남은 갭은 compiled execution contract migration을 이 shared seam 위에서 해야 하는데, 잘못하면 entrypoint별로 중복 구현할 위험이 있다는 점이다.

### 1.4.3 Query entry security / adversarial guard

LLM/agent-friendly 검색 구조로 갈 때 중요한 public query safety 자산도 이미 있다.

- query sanitizer
- LLM injection judge
- shared query-entry security gate
- alias adversarial guard

핵심 파일:

- [query-entry-security.ts](/Users/songmin/wine-search-engine/src/application/search/query-entry-security.ts)
- [query-sanitizer.ts](/Users/songmin/wine-search-engine/src/domain/security/service/query-sanitizer.ts)
- [llm-injection-judge.ts](/Users/songmin/wine-search-engine/src/domain/security/service/llm-injection-judge.ts)
- [adversarial-guard.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/adversarial-guard.ts)

평가:

- public query entry는 이미 Layer 1 static sanitizer + Layer 2 LLM judge 구조를 갖고 있다
- alias/domain 쪽도 homoglyph / velocity / source trust gate를 별도로 둔다
- 따라서 LLM-assisted query decomposition이나 ontology expansion을 넣을 때도 safety layer를 새로 만들기보다 existing public-entry/security spine 위에 얹는 편이 맞다

### 1.4.4 HTTP contract catalog / agent fallback seam도 이미 있다

API contract와 agent fallback도 생각보다 productized 돼 있다.

- declared HTTP route contract catalog
- V1/V2 schema matrix
- machine V2는 `/v1/claude-tools` seam로 유지
- empty-result시 mixed fallback executor

핵심 파일:

- [http-route-contract-catalog.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-catalog.ts)
- [route-contracts.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-contracts.ts)
- [search-response-v2.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response-v2.schema.ts)
- [adaptive-tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/adaptive-tool-executor.ts)

평가:

- [http-route-contract-catalog.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-catalog.ts)는 실제 선언된 route/contract manifest를 제공한다
- [route-contracts.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-contracts.ts)는 V1/V2, human/machine route의 capability/version policy를 이미 문서화한다
- [search-response-v2.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response-v2.schema.ts)는 V2 human/machine/interpret matrix를 schema 수준에서 고정한다
- [adaptive-tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/adaptive-tool-executor.ts)는 empty result 시 `mixed` 1-shot fallback을 이미 제공한다

즉 HTTP/API/agent surface도 새로 큰 판을 깔 필요는 없다.  
남은 갭은 taxonomy-aligned response policy와 machine/human channel 정렬이지, contract catalog 자체의 부재는 아니다.

### 1.4.5 Route resolution / mixed degradation / eval provenance seam도 이미 있다

serving control과 eval export도 생각보다 더 제품화돼 있다.

- planner route + api override를 합치는 route resolution helper
- mixed route degradation taxonomy
- ranked result -> eval provenance export
- default ranking policy hook

핵심 파일:

- [search-usecase-route-resolution.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-route-resolution.ts)
- [mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts)
- [search-usecase-eval-provenance.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-eval-provenance.ts)
- [default-ranking-policy.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/default-ranking-policy.ts)

평가:

- [search-usecase-route-resolution.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-route-resolution.ts)는 planner suggested route, retrieval mode, API override mode를 합쳐 effective route를 만드는 explicit seam를 이미 제공한다
- [mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts)는 mixed route의 fallback reason, route degradation, funnel metrics를 structured result로 내보낸다
- [search-usecase-eval-provenance.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-eval-provenance.ts)는 ranked result provenance를 eval slice vocabulary로 정렬하고 unknown channel drift도 로그로 노출한다
- [default-ranking-policy.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/default-ranking-policy.ts)는 producer diversity / max-results truncation을 stage-aware ranking pipeline의 policy hook으로 이미 제공한다

즉 route control, mixed fallback semantics, eval provenance export, ranking policy hook도 모두 greenfield가 아니다.  
남은 갭은 이것들을 taxonomy-aligned execution policy와 rollout governor 아래에서 함께 튜닝하지 못하고 있다는 점이다.

### 1.4.6 Aux feature wiring / typed design note도 이미 있다

보조 기능도 무질서하게 흩어진 게 아니라 container와 typed note 형태로 어느 정도 정리돼 있다.

- adaptive tool executor container wiring
- eval runner container wiring
- cache integration typed design note
- trace vocabulary aligner

핵심 파일:

- [container-aux-features.ts](/Users/songmin/wine-search-engine/src/config/container-aux-features.ts)
- [search-usecase-cache-integration.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-cache-integration.ts)
- [trace-vocab-aligner.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/trace-vocab-aligner.ts)

평가:

- [container-aux-features.ts](/Users/songmin/wine-search-engine/src/config/container-aux-features.ts)는 adaptive tool executor와 eval runner를 composition root에서 묶는 실제 wiring을 제공한다
- [search-usecase-cache-integration.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-cache-integration.ts)는 런타임 모듈이 아니라 **typed design note**다. 즉 여기에 적힌 캐시 통합은 참고 자산으로 봐야 하고, 이미 돌아가는 런타임 코드로 오해하면 안 된다
- [trace-vocab-aligner.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/trace-vocab-aligner.ts)는 runtime candidate/ranked provenance를 canonical eval vocabulary로 맞추는 핵심 변환 seam를 이미 제공한다

즉 auxiliary/eval/cache 쪽도 완전 산발적이지 않다.  
남은 갭은 design-note 자산과 실제 runtime 자산을 문서/구현에서 더 명확히 분리하고, rollout/eval loop 안에서 trace vocab alignment를 더 일관되게 쓰는 일이다.

### 1.4.7 Usecase container / route-port / shared security observer seam도 이미 있다

application/search와 HTTP route wiring 사이도 생각보다 잘 정리돼 있다.

- typed usecase port catalog
- decomposed-search cycle breaker adapter
- shared query security gate factory
- singleton security metrics collector
- route dependency contract

핵심 파일:

- [container-usecases.ts](/Users/songmin/wine-search-engine/src/config/container-usecases.ts)
- [search-route-usecases.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-route-usecases.port.ts)
- [decomposed-search-adapter.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search-adapter.ts)
- [search-usecase-security-gate.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-security-gate.ts)
- [query-entry-security-metrics.ts](/Users/songmin/wine-search-engine/src/infrastructure/observability/query-entry-security-metrics.ts)
- [route-deps.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-deps.ts)

평가:

- [container-usecases.ts](/Users/songmin/wine-search-engine/src/config/container-usecases.ts)는 `search / replay / interpret / resolve / hybrid / decomposed / batch` usecase graph를 실제로 조립하는 중심이다
- [search-route-usecases.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-route-usecases.port.ts)는 replay/interpret/resolve/hybrid/decomposed entrypoint의 typed contract catalog 역할을 한다
- [decomposed-search-adapter.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search-adapter.ts)는 search <-> decomposed search 간 circular dependency를 끊는 실제 runtime seam라서, 추후 route refactor 때도 유지 가치가 높다
- [search-usecase-security-gate.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-security-gate.ts)는 public query security를 usecase별로 중복 구현하지 않게 묶는 shared factory다
- [query-entry-security-metrics.ts](/Users/songmin/wine-search-engine/src/infrastructure/observability/query-entry-security-metrics.ts)는 Layer1/Layer2 block, judge error, fail-open/fail-closed를 singleton collector로 집계한다
- [route-deps.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-deps.ts)는 HTTP surface가 실제로 기대하는 usecase/feature dependency의 typed SSOT다

즉 usecase graph, route port, security observer도 이미 greenfield가 아니다.  
남은 갭은 이 seam 위에 compiled execution contract와 taxonomy-aligned serving policy를 올리지 못한 점이다.

### 1.4.8 Runtime support / infrastructure adapter / top-level container seam도 이미 있다

runtime support와 external adapter 조립도 생각보다 더 성숙해 있다.

- runtime support builder
- infra adapter builder with production guard
- thin eval contract
- feature container split
- top-level container aggregator

핵심 파일:

- [container-runtime-support.ts](/Users/songmin/wine-search-engine/src/config/container-runtime-support.ts)
- [container-adapters.ts](/Users/songmin/wine-search-engine/src/config/container-adapters.ts)
- [container-eval-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-eval-contracts.ts)
- [container-features.ts](/Users/songmin/wine-search-engine/src/config/container-features.ts)
- [container.ts](/Users/songmin/wine-search-engine/src/config/container.ts)

평가:

- [container-runtime-support.ts](/Users/songmin/wine-search-engine/src/config/container-runtime-support.ts)는 query sanitizer, injection judge cache, query/embedding cache, LTR registry, drinking-window predictor를 한 곳에서 초기화한다
- [container-adapters.ts](/Users/songmin/wine-search-engine/src/config/container-adapters.ts)는 Vespa/OpenAI/Redis/Postgres-backed adapter와 stub fallback, production guard를 이미 명시적으로 분리한다
- [container-eval-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-eval-contracts.ts)는 eval runner를 deliberately thin contract로 두고 있다. 즉 eval infra를 별도 큰 계층으로 다시 만드는 것보다 이 contract를 유지하는 편이 낫다
- [container-features.ts](/Users/songmin/wine-search-engine/src/config/container-features.ts)는 usecase graph 위에 adaptive tool executor와 eval runner를 feature layer로 얹는다
- [container.ts](/Users/songmin/wine-search-engine/src/config/container.ts)는 core/features/watchlist/learning을 합치는 top-level composition root다

즉 runtime support, adapter wiring, top-level feature aggregation도 이미 존재한다.  
남은 갭은 이 계층 위에 rollout governor, lane policy table, compiled execution contract migration을 일관되게 태우는 일이지, 새 container stack을 만드는 일이 아니다.

### 1.4.9 Watchlist / HTTP server / exposed surface seam도 이미 있다

watchlist와 HTTP 노출 면도 생각보다 훨씬 제품화돼 있다.

- subject-scoped watchlist route
- watchlist container/runtime
- server-level route registration and eval startup

핵심 파일:

- [watchlist.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/watchlist.route.ts)
- [container-watchlist.ts](/Users/songmin/wine-search-engine/src/config/container-watchlist.ts)
- [watchlist.service.ts](/Users/songmin/wine-search-engine/src/application/watchlist/watchlist.service.ts)
- [server.ts](/Users/songmin/wine-search-engine/src/interface/http/server.ts)

평가:

- [watchlist.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/watchlist.route.ts)는 subject-scoped auth, contract response, delivery log surface까지 이미 구현한다
- [container-watchlist.ts](/Users/songmin/wine-search-engine/src/config/container-watchlist.ts)는 storage/runtime/subscriber/webhook delivery를 묶는 실제 composition seam다
- [watchlist.service.ts](/Users/songmin/wine-search-engine/src/application/watchlist/watchlist.service.ts)는 단순 CRUD가 아니라 delivery log append, ownership guard까지 이미 제공한다
- [server.ts](/Users/songmin/wine-search-engine/src/interface/http/server.ts)는 search/batch/replay/interpret/resolve/hybrid/V2/claude-tools/watchlist/feedback/openapi를 한 곳에서 등록하고, eval-at-startup까지 top-level에서 제어한다

즉 exposed surface도 거의 다 있다.  
남은 갭은 watchlist/value/inventory loop를 ranking policy와 더 깊게 연결하는 일이지, surface를 새로 여는 일이 아니다.

### 1.4.10 Learning ingest / route-contract manifest / OpenAPI bridge / runtime lifecycle seam도 이미 있다

운영/노출 자산도 생각보다 더 깊게 깔려 있다.

- feedback ingest route
- watchlist delivery runtime
- registered-route manifest
- declared-contract -> OpenAPI bridge
- managed runtime lifecycle

핵심 파일:

- [container-learning.ts](/Users/songmin/wine-search-engine/src/config/container-learning.ts)
- [feedback.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/feedback.route.ts)
- [watchlist-delivery-runtime.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/watchlist-delivery-runtime.ts)
- [register-contract-route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/register-contract-route.ts)
- [http-route-contract-openapi.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-openapi.ts)
- [openapi.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/openapi.route.ts)
- [eval-initializer.ts](/Users/songmin/wine-search-engine/src/infrastructure/eval/eval-initializer.ts)
- [runtime-handles.ts](/Users/songmin/wine-search-engine/src/config/runtime-handles.ts)

평가:

- [container-learning.ts](/Users/songmin/wine-search-engine/src/config/container-learning.ts)는 feedback/proposal/alias-proposal/TTL enforcement를 이미 container layer에서 묶는다
- [feedback.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/feedback.route.ts)는 단순 로그 endpoint가 아니라 runtime snapshot을 포함한 typed learning ingest surface다
- [watchlist-delivery-runtime.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/watchlist-delivery-runtime.ts)는 subscriber -> policy check -> webhook delivery -> delivery log append까지 닫힌 runtime loop를 제공한다
- [register-contract-route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/register-contract-route.ts)는 declared route를 runtime registry/manifest로 유지한다
- [http-route-contract-openapi.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-openapi.ts), [openapi.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/openapi.route.ts)는 declared contract catalog를 OpenAPI surface로 bridge한다
- [eval-initializer.ts](/Users/songmin/wine-search-engine/src/infrastructure/eval/eval-initializer.ts)는 eval runner thin contract 위에서 startup/on-demand evaluation을 이미 지원한다
- [runtime-handles.ts](/Users/songmin/wine-search-engine/src/config/runtime-handles.ts)는 PG/Redis/telemetry까지 포함한 managed runtime lifecycle을 제공한다

즉 learning ingest, route manifest, OpenAPI bridge, runtime lifecycle도 greenfield가 아니다.  
남은 갭은 이것들을 rollout governor와 policy promotion loop 아래 더 일관되게 연결하는 일이지, 별도 infra plane을 새로 까는 일이 아니다.

### 1.4.11 External contract / tool seam / decision transparency도 이미 있다

외부 소비자와 연결되는 typed contract도 이미 꽤 단단하다.

- search executor contract with eval export
- tool executor contract with fallback semantics
- canonical V2 response type alias
- interpret explain V2 adapter
- authority trace / external decision record

핵심 파일:

- [search-executor.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-executor.port.ts)
- [container-tool-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-tool-contracts.ts)
- [result-item-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/model/result-item-v2.ts)
- [machine-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/machine-response-builder-v2.ts)
- [interpret-explain-adapter-v2.ts](/Users/songmin/wine-search-engine/src/application/search/interpret-explain-adapter-v2.ts)
- [engine-decision.ts](/Users/songmin/wine-search-engine/src/domain/response/model/engine-decision.ts)
- [authority-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/authority-trace.ts)

평가:

- [search-executor.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-executor.port.ts)는 normal execute와 executeForEvaluation을 함께 담는 외부 executor contract다
- [container-tool-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-tool-contracts.ts)는 machine/human/comparison/drinking-window block까지 포함하는 tool surface SSOT다
- [result-item-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/model/result-item-v2.ts)는 HTTP schema를 domain/application에서 재사용하는 canonical type alias seam를 제공한다
- [machine-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/machine-response-builder-v2.ts)는 `/v1/claude-tools`용 structured provenance/evidence envelope를 이미 productized 한다
- [interpret-explain-adapter-v2.ts](/Users/songmin/wine-search-engine/src/application/search/interpret-explain-adapter-v2.ts)는 planner observability를 stable interpret contract로 변환한다
- [engine-decision.ts](/Users/songmin/wine-search-engine/src/domain/response/model/engine-decision.ts), [authority-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/authority-trace.ts)는 calibrated confidence / authority trace / admission trace를 외부 노출 contract로 이미 분리한다

즉 external contract, tool surface, decision transparency도 이미 greenfield가 아니다.  
남은 갭은 V1/V2/taxonomy-aligned response policy를 이 계약들 위에서 더 일관되게 정렬하는 일이다.

### 1.4.12 Decomposition / evidence obligation / grouped exploration / calibration seam도 이미 있다

SOTA++에서 중요하게 보는 `difficulty / abstention / grouped exploration / calibration` 바닥 자산도 이미 있다.

- decomposition hint model
- evidence obligation gate
- grouped browse response
- calibration evaluator + calibration persistence
- counterfactual / specialized route transparency

핵심 파일:

- [query-decomposition.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-decomposition.ts)
- [evidence-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/evidence-gate.ts)
- [result-grouper.ts](/Users/songmin/wine-search-engine/src/domain/response/service/result-grouper.ts)
- [query-observability-vocab.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-observability-vocab.ts)
- [calibration-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/calibration-evaluator.ts)
- [pg-calibration-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-calibration-store.ts)
- [search-usecase-counterfactuals.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-counterfactuals.ts)
- [specialized-route-observability.ts](/Users/songmin/wine-search-engine/src/application/search/specialized-route-observability.ts)

평가:

- [query-decomposition.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-decomposition.ts)는 comparison/multi_intent/anchor_relative/pairing decomposition hint를 이미 typed model로 고정한다
- [evidence-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/evidence-gate.ts)는 resolved decision의 identity/constraint/anchor evidence obligation을 이미 강제한다
- [result-grouper.ts](/Users/songmin/wine-search-engine/src/domain/response/service/result-grouper.ts)는 producer/region/style/wine grouped response surface를 실제 response layer에서 제공한다
- [query-observability-vocab.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-observability-vocab.ts)는 decompositionStrategy, uncertainty, queryFamily를 observability slice로 이미 정리한다
- [calibration-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/calibration-evaluator.ts), [pg-calibration-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-calibration-store.ts)는 ECE/per-class calibration과 persistence seam를 이미 제공한다
- [search-usecase-counterfactuals.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-counterfactuals.ts), [specialized-route-observability.ts](/Users/songmin/wine-search-engine/src/application/search/specialized-route-observability.ts)는 rejected alternative/fallback transparency를 이미 구조화한다

즉 decomposition, evidence obligation, grouped exploration, calibration도 greenfield가 아니다.  
남은 갭은 이것들을 `difficulty estimator + abstention policy + calibration-aware confidence semantics` 아래에서 한 정책으로 묶지 못한 점이다.

### 1.4.13 Response assembly / internal decision semantics / learning proposal loop / stub fallback seam도 이미 있다

내부 의미론과 fallback path도 생각보다 더 구조화돼 있다.

- rich decision input evidence semantics
- internal decision output authority contract
- response builder with evidence enforcement and grouped-result projection
- alias/threshold proposal loop
- explicit stub fallback seam

핵심 파일:

- [decision-input.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-input.ts)
- [decision-output.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-output.ts)
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)
- [alias-proposer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/alias-proposer.ts)
- [pg-proposal-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-proposal-store.ts)
- [blocker.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/blocker.ts)
- [calibrator.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/calibrator.ts)
- [container-stubs.ts](/Users/songmin/wine-search-engine/src/config/container-stubs.ts)

평가:

- [decision-input.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-input.ts)는 identity/constraint/anchor evidence를 coarse boolean이 아니라 rich summary로 이미 표현한다
- [decision-output.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-output.ts)는 calibrated decision confidence, evidence item, decision trace, admission trace를 internal authority contract로 고정한다
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)는 no-evidence guard, grouped-result projection, response hash, executionMode/degradation propagation, retrievalProvenanceSlices/meta projection까지 이미 담당한다
- [alias-proposer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/alias-proposer.ts), [pg-proposal-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-proposal-store.ts)는 alias proposal과 threshold proposal을 이미 learning loop의 persisted asset으로 다룬다
- [blocker.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/blocker.ts), [calibrator.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/calibrator.ts)는 recall-first blocking과 calibrated confidence semantics를 이미 운영 개념으로 갖고 있다
- [container-stubs.ts](/Users/songmin/wine-search-engine/src/config/container-stubs.ts)는 embedding/calibration/ambiguity/alias/threshold fallback을 explicit stub seam로 둔다

즉 response assembly, internal decision semantics, proposal loop, stub fallback도 greenfield가 아니다.  
남은 갭은 이것들을 canonical query schema와 lane/gate policy 아래에서 더 일관되게 재사용하는 일이다.

### 1.4.14 Query policy / threshold / request-response DTO seam도 이미 있다

planner policy와 외부 request/response envelope도 이미 꽤 단단하다.

- query policy directive
- threshold profile and dynamic gap threshold
- search request DTO with session/budget/mode override
- clarification / counterfactual / response meta envelope
- search response SSOT
- compact query route enum
- ranking evidence mapping

핵심 파일:

- [query-policy.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-policy.ts)
- [threshold-profile.ts](/Users/songmin/wine-search-engine/src/domain/query/model/threshold-profile.ts)
- [search-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/search-request.dto.ts)
- [clarification.ts](/Users/songmin/wine-search-engine/src/domain/response/model/clarification.ts)
- [counterfactual.ts](/Users/songmin/wine-search-engine/src/domain/response/model/counterfactual.ts)
- [search-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/search-response.ts)
- [query-route.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-route.ts)
- [evidence-mapper.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/evidence-mapper.ts)

평가:

- [query-policy.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-policy.ts)는 exact/approximate/clarify/fallback mode를 이미 typed directive로 고정한다
- [threshold-profile.ts](/Users/songmin/wine-search-engine/src/domain/query/model/threshold-profile.ts)는 per-query-class threshold와 dynamic gap threshold logic을 이미 운영 자산으로 둔다
- [search-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/search-request.dto.ts)는 session/budget/options/retrieval override를 application request contract로 이미 정의한다
- [clarification.ts](/Users/songmin/wine-search-engine/src/domain/response/model/clarification.ts), [counterfactual.ts](/Users/songmin/wine-search-engine/src/domain/response/model/counterfactual.ts)는 disambiguation/fallback/transparency payload를 이미 분리한다
- [search-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/search-response.ts)는 `SearchResponseV1`을 여전히 SSOT output으로 고정한다
- [query-route.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-route.ts)는 route enum을 compact하게 유지한다
- [evidence-mapper.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/evidence-mapper.ts)는 component score -> evidence item mapping을 이미 canonical하게 수행한다

즉 policy/threshold/request-response DTO도 greenfield가 아니다.  
남은 갭은 이 계약들을 canonical taxonomy/difficulty/value SSOT와 더 강하게 정렬하는 일이다.

### 1.4.15 API boundary mapper / contract-response / readiness / watchlist trigger policy seam도 이미 있다

HTTP boundary의 세부 seam도 생각보다 더 제품화돼 있다.

- HTTP schema -> app request mapper
- contract-safe response sender
- health/readiness route contract
- watchlist trigger policy and event matcher

핵심 파일:

- [search-request-mappers.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search-request-mappers.ts)
- [contract-response.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/contract-response.ts)
- [health.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/health.route.ts)
- [watchlist-policy.ts](/Users/songmin/wine-search-engine/src/domain/watchlist/service/watchlist-policy.ts)

평가:

- [search-request-mappers.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search-request-mappers.ts)는 HTTP schema와 application DTO를 분리하는 explicit boundary seam다
- [contract-response.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/contract-response.ts)는 Zod-based response validation, snake_case projection, contract-aware body parse/send를 중앙집중으로 다룬다
- [health.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/health.route.ts)는 liveness/readiness를 declared contract route로 이미 노출한다
- [watchlist-policy.ts](/Users/songmin/wine-search-engine/src/domain/watchlist/service/watchlist-policy.ts)는 trigger response projection, typed event match, delivery eligibility policy를 이미 도메인 정책으로 분리한다

즉 API boundary mapper, contract-safe response, readiness, watchlist trigger policy도 greenfield가 아니다.  
남은 갭은 이 boundary seam를 canonical policy rollout과 운영 문서에 더 직접 연결하는 일이지, 새 adapter layer를 만드는 일이 아니다.

### 1.4.16 Request DTO family / schema layer / eval storage seam도 이미 있다

request family와 schema/eval storage도 이미 분리돼 있다.

- search/hybrid/interpret/resolve/replay DTO family
- shared Zod schema layer
- eval gold-set store
- eval result store
- EvalReport export contract

핵심 파일:

- [hybrid-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid-request.dto.ts)
- [interpret-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/interpret-request.dto.ts)
- [resolve-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/resolve-request.dto.ts)
- [replay-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/replay-request.dto.ts)
- [search-request.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-request.schema.ts)
- [search-shared.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-shared.schema.ts)
- [search-response.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response.schema.ts)
- [pg-gold-set-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-gold-set-store.ts)
- [pg-eval-result-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-eval-result-store.ts)
- [eval-runner.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/eval-runner.ts)
- [domain/evaluation/index.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/index.ts)

평가:

- [hybrid-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid-request.dto.ts), [interpret-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/interpret-request.dto.ts), [resolve-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/resolve-request.dto.ts), [replay-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/replay-request.dto.ts)는 application-layer request contract family를 이미 분리한다
- [search-request.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-request.schema.ts), [search-shared.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-shared.schema.ts)는 request-side schema SSOT다
- [search-response.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response.schema.ts)는 response-side contract를 매우 풍부하게 이미 표현한다
- [pg-gold-set-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-gold-set-store.ts), [pg-eval-result-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-eval-result-store.ts)는 eval dataset/result persistence seam를 이미 제공한다
- [eval-runner.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/eval-runner.ts), [domain/evaluation/index.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/index.ts)는 EvalReport/ReleaseGate export contract를 이미 정리한다

즉 request DTO family, schema layer, eval storage도 greenfield가 아니다.  
남은 갭은 canonical taxonomy와 lane/gate policy가 이 family와 eval contract에 더 직접 반영되도록 정렬하는 일이다.

### 1.4.17 HTTP middleware / request-id / ops error seam도 이미 있다

운영 측면의 HTTP seam도 생각보다 더 잘 정리돼 있다.

- request id normalization and propagation
- request context + latency log hook
- debug-mode request hook
- global error handler
- snake_case serialization boundary
- structured error response helpers
- policy-blocked security audit response
- Retry-After parser

핵심 파일:

- [request-context.ts](/Users/songmin/wine-search-engine/src/interface/http/middleware/request-context.ts)
- [request-id.ts](/Users/songmin/wine-search-engine/src/interface/http/request-id.ts)
- [http-debug-mode.ts](/Users/songmin/wine-search-engine/src/interface/http/middleware/http-debug-mode.ts)
- [error-handler.ts](/Users/songmin/wine-search-engine/src/interface/http/middleware/error-handler.ts)
- [snake-case-hook.ts](/Users/songmin/wine-search-engine/src/interface/http/middleware/snake-case-hook.ts)
- [error-response.ts](/Users/songmin/wine-search-engine/src/interface/http/errors/error-response.ts)
- [policy-blocked.ts](/Users/songmin/wine-search-engine/src/interface/http/errors/policy-blocked.ts)
- [retry-after-from-rate-limit-message.ts](/Users/songmin/wine-search-engine/src/interface/http/retry-after-from-rate-limit-message.ts)

평가:

- [request-id.ts](/Users/songmin/wine-search-engine/src/interface/http/request-id.ts)는 inbound request/correlation id validation과 generation을 이미 중앙집중으로 다룬다
- [request-context.ts](/Users/songmin/wine-search-engine/src/interface/http/middleware/request-context.ts)는 requestId/startTime/debugRequest를 typed request extension과 log hook로 이미 고정한다
- [http-debug-mode.ts](/Users/songmin/wine-search-engine/src/interface/http/middleware/http-debug-mode.ts)는 per-request debug mode를 constant-time secret 비교로 이미 제공한다
- [error-handler.ts](/Users/songmin/wine-search-engine/src/interface/http/middleware/error-handler.ts)는 DomainError/Zod/rate-limit/timeout/policy-blocked/unknown error path를 중앙집중으로 처리한다
- [snake-case-hook.ts](/Users/songmin/wine-search-engine/src/interface/http/middleware/snake-case-hook.ts)는 외부 API field naming boundary를 이미 한 곳에서 책임진다
- [error-response.ts](/Users/songmin/wine-search-engine/src/interface/http/errors/error-response.ts), [policy-blocked.ts](/Users/songmin/wine-search-engine/src/interface/http/errors/policy-blocked.ts)는 RFC-014 style error contract와 security audit response를 이미 제공한다
- [retry-after-from-rate-limit-message.ts](/Users/songmin/wine-search-engine/src/interface/http/retry-after-from-rate-limit-message.ts)는 rate-limit message -> Retry-After derivation seam를 별도로 둔다

즉 middleware/request-id/error surface도 greenfield가 아니다.  
남은 갭은 이 운영 seam를 rollout/governor/observability 문서와 더 직접 정렬하는 일이지, 새 ops wrapper를 만드는 일이 아니다.

### 1.4.18 Route handler pattern / watchlist async delivery seam도 이미 있다

route handler 조립 패턴과 watchlist 비동기 delivery spine도 이미 생각보다 강하게 구현돼 있다.

- contract-route registration pattern
- contract body parse -> DTO mapper -> usecase -> contract response send
- async watchlist webhook delivery with retry/HMAC/timeout
- Redis pub/sub publisher-subscriber runtime

핵심 파일:

- [search.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search.route.ts)
- [hybrid.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/hybrid.route.ts)
- [interpret.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/interpret.route.ts)
- [resolve.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/resolve.route.ts)
- [replay.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/replay.route.ts)
- [webhook-delivery.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/webhook-delivery.ts)
- [redis-watchlist-subscriber.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/redis-watchlist-subscriber.ts)
- [redis-watchlist-publisher.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/redis-watchlist-publisher.ts)

평가:

- [search.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search.route.ts), [hybrid.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/hybrid.route.ts), [interpret.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/interpret.route.ts), [resolve.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/resolve.route.ts), [replay.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/replay.route.ts)는 모두 `registerContractRoute -> parseContractBody -> DTO mapper -> usecase -> sendRouteContractResponse` 패턴으로 정렬돼 있다
- 즉 main search / hybrid / interpret / resolve / replay는 route별 greenfield handler가 아니라, 이미 표준화된 contract-route handler seam 위에 올라가 있다
- [webhook-delivery.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/webhook-delivery.ts)는 retry schedule, HMAC-SHA256 signature, timeout, observer hook까지 포함한 production-grade webhook delivery seam다
- [redis-watchlist-subscriber.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/redis-watchlist-subscriber.ts)는 dedicated pub/sub connection, internal error isolation, safe async handler dispatch를 이미 제공한다
- [redis-watchlist-publisher.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/redis-watchlist-publisher.ts)는 lazy Redis client seam를 통해 async publish 경계를 이미 분리한다

즉 route handler pattern과 watchlist async delivery도 greenfield가 아니다.  
남은 갭은 canonical taxonomy/policy rollout과 이 seam들을 더 직접 연결하는 일이지, 새 route layer나 새 async delivery runtime를 다시 만드는 일이 아니다.

### 1.4.19 Debug / trace / snapshot admission seam도 이미 있다

운영 디버깅과 재현성 seam도 이미 생각보다 깊게 구현돼 있다.

- canonical pipeline debug step vocabulary
- per-request debug context + structured trace log
- full decision trace contract
- snapshot persistence port
- admission gate with snapshot/policy/planner seal checks
- authority/snapshot id decode-enriched search log

핵심 파일:

- [pipeline-debug-steps.ts](/Users/songmin/wine-search-engine/src/observability/pipeline-debug-steps.ts)
- [request-pipeline-debug.ts](/Users/songmin/wine-search-engine/src/observability/request-pipeline-debug.ts)
- [decision-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-trace.ts)
- [snapshot-store.port.ts](/Users/songmin/wine-search-engine/src/domain/decision/port/snapshot-store.port.ts)
- [admission-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/admission-gate.ts)
- [log-search-event.ts](/Users/songmin/wine-search-engine/src/observability/log-search-event.ts)

평가:

- [pipeline-debug-steps.ts](/Users/songmin/wine-search-engine/src/observability/pipeline-debug-steps.ts)는 search / retrieval / ranking / decision / infra HTTP까지 canonical step string vocabulary를 이미 고정한다
- [request-pipeline-debug.ts](/Users/songmin/wine-search-engine/src/observability/request-pipeline-debug.ts)는 AsyncLocalStorage 기반 request-scoped debug context, safe query truncation, structured pipeline trace emission을 이미 제공한다
- [decision-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-trace.ts)는 decision status, signals, thresholds, versions, rulesApplied, finalReason까지 포함한 complete diagnostic trace contract를 이미 가진다
- [snapshot-store.port.ts](/Users/songmin/wine-search-engine/src/domain/decision/port/snapshot-store.port.ts)는 reproducibility 분석을 위한 snapshot persistence seam를 명시적으로 분리한다
- [admission-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/admission-gate.ts)는 identity/evidence/constraint/anchor/confidence/snapshot seal까지 final closure로 검사하는 운영-grade admission gate다
- [log-search-event.ts](/Users/songmin/wine-search-engine/src/observability/log-search-event.ts)는 authority trace ref와 snapshot id를 decode해 schema/version drift를 로그 이벤트에 직접 주입한다

즉 debug/trace/snapshot admission도 greenfield가 아니다.  
남은 갭은 이 진단/재현 seam를 canonical taxonomy/difficulty/risk policy와 더 직접 연결하는 일이지, 새 debug plane이나 새 trace model을 다시 만드는 일이 아니다.

### 1.4.20 Provenance / id schema / deterministic reproducibility helper seam도 이미 있다

trace/debug를 떠받치는 provenance와 deterministic helper도 이미 상당수 구현돼 있다.

- multi-view normalized query contract
- query lookup provenance contract
- candidate-level provenance envelope
- authority/snapshot/batch id schema decoder + version constants
- deterministic hash utility
- decision snapshot typed contract
- anchor lookup provenance contract

핵심 파일:

- [query-views.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-views.ts)
- [query-lookup-provenance.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-lookup-provenance.ts)
- [candidate-envelope.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/candidate-envelope.ts)
- [id-schema-decoder.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/id-schema-decoder.ts)
- [id-schema-version.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/id-schema-version.ts)
- [decision-snapshot.ts](/Users/songmin/wine-search-engine/src/domain/shared/types/decision-snapshot.ts)
- [anchor-candidate.ts](/Users/songmin/wine-search-engine/src/domain/query/model/anchor-candidate.ts)
- [hash.ts](/Users/songmin/wine-search-engine/src/domain/shared/utils/hash.ts)

평가:

- [query-views.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-views.ts)는 strict -> transliterated -> phoneticCompact까지 ordered multi-view normalization contract를 이미 가진다
- [query-lookup-provenance.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-lookup-provenance.ts)는 normalized query views와 anchor lookup variants/strategies를 shared provenance shape로 고정한다
- [candidate-envelope.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/candidate-envelope.ts)는 channel score evidence, queryViewMatches, protected inclusion reason, fusion profile까지 candidate-level provenance envelope를 이미 제공한다
- [id-schema-decoder.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/id-schema-decoder.ts), [id-schema-version.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/id-schema-version.ts)는 authority trace ref, batch id, snapshot id v1/v2 decode와 schema versioning을 이미 explicit하게 관리한다
- [decision-snapshot.ts](/Users/songmin/wine-search-engine/src/domain/shared/types/decision-snapshot.ts)는 model/index/policy/planner/feature flag/response contract 버전을 가진 reproducibility snapshot contract다
- [anchor-candidate.ts](/Users/songmin/wine-search-engine/src/domain/query/model/anchor-candidate.ts)는 anchor confidence와 lookup provenance를 분리해 planner confidence와 calibrated decision confidence를 혼동하지 않게 해준다
- [hash.ts](/Users/songmin/wine-search-engine/src/domain/shared/utils/hash.ts)는 authority trace, snapshot id, batch id, response hash까지 deterministic hash utility를 이미 제공한다

즉 provenance/id schema/deterministic helper도 greenfield가 아니다.  
남은 갭은 이 자산들을 runtime SSOT와 lane policy table 아래에서 더 일관되게 소비하게 만드는 일이지, 새 provenance contract나 새 reproducibility helper를 다시 만드는 일이 아니다.

### 1.5 Catalog master data / ontology / projection boundary

catalog와 retrieval document의 바닥 자산도 생각보다 깊다.

- authoritative ontology normalizer
- structured extraction + parsing confidence
- retrieval projection builder
- hit projection / feature projection boundary
- wine catalog master-data fields

핵심 파일:

- [ontology-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/attribute/service/ontology-normalizer.ts)
- [structured-extractor.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/structured-extractor.ts)
- [projection-builder.ts](/Users/songmin/wine-search-engine/src/domain/entity/service/projection-builder.ts)
- [retrieval-document.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-document.ts)
- [search-index.port.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/port/search-index.port.ts)

평가:

- `pairing / occasion / body / acidity / tannin / sweetness / producer prestige / classification / certifications / soil / flavorProfiles`까지 retrieval document contract에 이미 들어가 있다
- ontology normalizer도 단순 TODO가 아니라 `grape / region / style / body / sweetness / acidity / tannin / pairing / occasion / price_band / producer_prestige / certification` 축을 authoritative service로 잡아둔 상태다
- 즉 catalog master-data layer를 새로 그릴 필요는 없고, existing projection/ontology seam를 승격하는 쪽이 맞다

### 1.5.0 Entity repository / alias-tier projection / retrieval hit-feature split seam도 이미 있다

catalog foundation도 단순 entity CRUD 수준을 넘어서 snapshot/alias-tier/projection split까지 갖고 있다.

- entity repository with snapshot and rollback
- alias set quality tiering
- retrieval projection input contract
- hit projection / feature projection / full retrieval document split

핵심 파일:

- [entity-repository.port.ts](/Users/songmin/wine-search-engine/src/domain/entity/port/entity-repository.port.ts)
- [projection-builder.ts](/Users/songmin/wine-search-engine/src/domain/entity/service/projection-builder.ts)
- [retrieval-document.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-document.ts)

평가:

- [entity-repository.port.ts](/Users/songmin/wine-search-engine/src/domain/entity/port/entity-repository.port.ts)는 `find/save/update/delete`뿐 아니라 named snapshot과 rollback contract까지 이미 가진다
- [projection-builder.ts](/Users/songmin/wine-search-engine/src/domain/entity/service/projection-builder.ts)는 `identitySafeAliases`와 `noisyRecallAliases`를 구분한 alias-tier projection seam를 이미 제공한다
- [projection-builder.ts](/Users/songmin/wine-search-engine/src/domain/entity/service/projection-builder.ts)는 searchable text와 structured facets를 domain-side retrieval projection input으로 이미 평탄화한다
- [retrieval-document.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-document.ts)는 `RetrievalHitProjection`, `RetrievalFeatureProjection`, full `RetrievalDocument`를 명시적으로 나눠서 hit/feature/document boundary를 already-typed contract로 유지한다

즉 entity repository, alias-tier projection, retrieval hit/feature split도 greenfield가 아니다.  
남은 갭은 이 catalog foundation을 runtime SSOT/lane policy와 더 직접 연결하는 일이지, 새 master-data repository나 새 projection schema를 다시 만드는 일이 아니다.

### 1.5.1 Result grouping / browse-set surface도 이미 있다

broader exploration UX를 위한 response grouping 자산도 이미 있다.

- producer_set
- region_set
- style_set
- wine_set

핵심 파일:

- [result-grouper.ts](/Users/songmin/wine-search-engine/src/domain/response/service/result-grouper.ts)
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)
- [search-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/search-response.ts)

평가:

- broad/browse UX가 완전히 프론트 책임으로 남아 있는 건 아니다
- planner의 `targetEntityType`과 response layer의 `resultType` 연결 seam가 이미 있다
- 따라서 Q6 broad exploration을 강화할 때도 response grouping surface를 새로 만드는 게 아니라 existing grouped-result contract를 확장하는 쪽이 맞다

### 1.6 Replay / snapshot / cache / determinism governance

governance와 replay 쪽도 이미 바닥이 강하다.

- fail-closed replay
- deterministic response hash
- snapshot version contract
- snapshot-aware cache bypass
- embedding cache + session-scoped cache key

핵심 파일:

- [replay.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/replay.usecase.ts)
- [search-usecase-decision-snapshot.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-decision-snapshot.ts)
- [snapshot-version-contract.ts](/Users/songmin/wine-search-engine/src/application/search/snapshot-version-contract.ts)
- [cache-service.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-service.ts)
- [cache-eligibility.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-eligibility.ts)
- [cache-policy.ts](/Users/songmin/wine-search-engine/src/domain/cache/cache-policy.ts)

평가:

- replay는 이미 `snapshot mismatch`, `missing snapshot`, `determinism violation`을 fail-closed로 다루고 있다
- cache도 단순 TTL cache가 아니라 `snapshot drift / contract drift / model version drift / degraded execution mode`까지 차단하는 governance spine이다
- embedding cache와 session-scoped cache key까지 있어, retrieval OS 확장 시 성능/재현성 자산을 새로 깔 필요가 없다

### 1.6.1 Authority / audit / selective prediction 자산도 이미 있다

decision governance와 selective answering 쪽 자산도 이미 productized 돼 있다.

- authority trace ref
- admission authority trace ref
- engine decision authority surface
- selective risk / AURC / E-AURC evaluator

핵심 파일:

- [authority-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/authority-trace.ts)
- [engine-decision.ts](/Users/songmin/wine-search-engine/src/domain/response/model/engine-decision.ts)
- [selective-predictor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/selective-predictor.ts)
- [slice-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/slice-evaluator.ts)

평가:

- authority trace는 replay/audit/cache correlation용 deterministic id 체계를 이미 갖고 있다
- selective prediction도 단순 ECE만 있는 게 아니라 risk-coverage, AURC, E-AURC까지 계산한다
- 따라서 abstention/calibration 고도화는 evaluator/trace backbone 없이 새로 시작하는 작업이 아니다

### 1.6.2 Performance / inference / model-serving seam도 이미 있다

성능과 모델 추론 seam도 생각보다 productized 돼 있다.

- query/embedding cache governance with circuit breaker
- cache observability collector
- embedding service port + OpenAI-compatible HTTP adapter
- reranker HTTP adapter with debug-step instrumentation
- drinking-window predictor port + ONNX/heuristic implementation

핵심 파일:

- [cache-service.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-service.ts)
- [cache-eligibility.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-eligibility.ts)
- [cache-metrics.ts](/Users/songmin/wine-search-engine/src/infrastructure/observability/cache-metrics.ts)
- [embedding-service.port.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/port/embedding-service.port.ts)
- [openai-embedding-service.ts](/Users/songmin/wine-search-engine/src/infrastructure/ai/openai-embedding-service.ts)
- [cohere-reranker.ts](/Users/songmin/wine-search-engine/src/infrastructure/ai/cohere-reranker.ts)
- [drinking-window-predictor.port.ts](/Users/songmin/wine-search-engine/src/domain/drinking-window/port/drinking-window-predictor.port.ts)
- [drinking-window-predictor.ts](/Users/songmin/wine-search-engine/src/infrastructure/ml/drinking-window-predictor.ts)

평가:

- [cache-service.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-service.ts)는 query cache, embedding cache, snapshot/version drift validation, circuit breaker를 단일 service로 이미 묶는다
- [cache-eligibility.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-eligibility.ts)는 retrieval mode와 secondary intent를 바탕으로 cacheability를 따지는 explicit analyzer다
- [cache-metrics.ts](/Users/songmin/wine-search-engine/src/infrastructure/observability/cache-metrics.ts)는 query/embedding cache hit rate, latency, circuit breaker 상태를 production 관측 자산으로 이미 제공한다
- [embedding-service.port.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/port/embedding-service.port.ts)는 provider-independent dense embedding contract를 이미 분리한다
- [openai-embedding-service.ts](/Users/songmin/wine-search-engine/src/infrastructure/ai/openai-embedding-service.ts)는 timeout/network/http/parse error까지 `PipelineDebugStep`로 계측하는 OpenAI-compatible embedding HTTP adapter다
- [cohere-reranker.ts](/Users/songmin/wine-search-engine/src/infrastructure/ai/cohere-reranker.ts)는 reranker HTTP adapter와 debug-step instrumentation을 이미 production path로 제공한다
- [drinking-window-predictor.port.ts](/Users/songmin/wine-search-engine/src/domain/drinking-window/port/drinking-window-predictor.port.ts), [drinking-window-predictor.ts](/Users/songmin/wine-search-engine/src/infrastructure/ml/drinking-window-predictor.ts)는 ONNX model loading과 heuristic fallback을 모두 고려한 predictor seam를 이미 가진다

즉 performance/inference/model-serving도 greenfield가 아니다.  
남은 갭은 expensive retriever/reranker rollout, late interaction, domain-tuned model 승격을 이 existing port/cache/governance/debug seam 위에 얹는 일이지, 새 inference plane이나 새 cache plane을 다시 만드는 일이 아니다.

### 1.6.3 Alias / ambiguity / learned matcher seam도 이미 있다

entity resolution과 noisy lookup 바닥도 생각보다 훨씬 깊다.

- multi-stage alias matcher
- ambiguity classifier
- learned matcher port and feature vector
- alias repository / PG adapter
- candidate scorer with alias-type caps

핵심 파일:

- [alias-matcher.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/alias-matcher.ts)
- [ambiguity-classifier.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/ambiguity-classifier.ts)
- [learned-matcher.port.ts](/Users/songmin/wine-search-engine/src/domain/resolver/port/learned-matcher.port.ts)
- [learned-matcher-features.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/learned-matcher-features.ts)
- [pg-alias-repository.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-alias-repository.ts)
- [http-learned-matcher.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/http-learned-matcher.ts)
- [candidate-scorer.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/candidate-scorer.ts)

평가:

- [alias-matcher.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/alias-matcher.ts)는 exact -> normalized -> char_ngram -> fuzzy -> phonetic 순서의 multi-strategy alias matcher를 이미 제공한다
- [alias-matcher.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/alias-matcher.ts)는 alias type weight와 confidence prior를 weighted score에 이미 반영한다
- [ambiguity-classifier.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/ambiguity-classifier.ts)는 wine_vs_producer, wine_vs_region, multi_vintage, alias_collision, producer_family_collision, underspecified_short_form를 structured ambiguity type으로 이미 분리한다
- [learned-matcher.port.ts](/Users/songmin/wine-search-engine/src/domain/resolver/port/learned-matcher.port.ts)는 learned matcher output, noisy-lookup context, per-candidate feature map까지 포함한 ML seam를 already-typed contract로 가진다
- [learned-matcher-features.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/learned-matcher-features.ts)는 char n-gram overlap, token coverage, vintage consistency, script compatibility를 feature vector로 이미 계산한다
- [pg-alias-repository.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-alias-repository.ts)는 alias persistence/find/suppress/bulk save seam를 이미 제공한다
- [http-learned-matcher.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/http-learned-matcher.ts)는 learned matcher remote adapter seam를 이미 가진다
- [candidate-scorer.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/candidate-scorer.ts)는 catalog_noise_alias/observed_query_alias cap까지 포함한 resolver scoring guardrail을 이미 갖고 있다

즉 alias/ambiguity/learned matcher도 greenfield가 아니다.  
남은 갭은 이 resolver 자산을 canonical taxonomy/difficulty/risk policy와 더 직접 연결하는 일이지, 새 entity lookup stack이나 새 noisy matcher stack을 다시 만드는 일이 아니다.

### 1.6.4 Mixed / substitute / anchor-conditioned search seam도 이미 있다

anchor 기반 대체 추천과 비교 검색도 이미 꽤 productized 돼 있다.

- anchor profile builder
- similarity scorer
- mixed solver orchestration
- constraint overlay on top of anchor similarity
- decomposed comparison use case
- mixed route execution adapter

핵심 파일:

- [similarity-scorer.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/similarity-scorer.ts)
- [anchor-profiler.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/anchor-profiler.ts)
- [mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts)
- [constraint-overlay.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/constraint-overlay.ts)
- [decomposed-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search.usecase.ts)
- [search-usecase-mixed-route.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-mixed-route.ts)

평가:

- [similarity-scorer.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/similarity-scorer.ts)는 region adjacency, grape overlap, style/body/sweetness proximity, embedding similarity를 결합한 anchor similarity scorer를 이미 가진다
- [anchor-profiler.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/anchor-profiler.ts)는 anchor completeness를 반영한 anchor confidence와 profile shape를 이미 계산한다
- [mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts)는 anchor resolve -> profile -> similar retrieval -> rank -> constraint overlay -> preservation rate -> route degradation까지 mixed flow를 end-to-end로 이미 오케스트레이션한다
- [mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts)는 `similar_items` 모드에서 seed exclusion, producer diversity, fallback reason, route degradation semantics도 이미 가진다
- [constraint-overlay.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/constraint-overlay.ts)는 anchor-similarity 결과 위에 hard/soft constraints를 덧씌우는 dedicated seam다
- [decomposed-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search.usecase.ts)는 comparison intent를 parallel sub-query execution으로 이미 제품화한다
- [search-usecase-mixed-route.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-mixed-route.ts)는 mixed query result를 search route execution contract로 bridge하는 runtime seam다

즉 mixed/substitute/anchor-conditioned search도 greenfield가 아니다.  
남은 갭은 이 specialized flow를 canonical taxonomy/difficulty/value gate와 더 직접 연결하는 일이지, 새 substitute engine이나 새 compare engine을 다시 만드는 일이 아니다.

### 1.6.5 Evaluation / release gate / shadow promotion seam도 이미 있다

offline eval과 learning-loop promotion도 생각보다 더 운영형에 가깝다.

- eval runner with release gates
- per-slice metrics and flagged-slice regression detection
- selective prediction / calibration / evidence audit in eval loop
- gold-set / eval-result persistence
- shadow-first threshold promotion gate
- threshold grid-search optimizer

핵심 파일:

- [eval-runner.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/eval-runner.ts)
- [slice-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/slice-evaluator.ts)
- [search-pipeline-evaluator.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/search-pipeline-evaluator.ts)
- [pg-gold-set-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-gold-set-store.ts)
- [pg-eval-result-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-eval-result-store.ts)
- [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts)
- [threshold-optimizer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/threshold-optimizer.ts)

평가:

- [eval-runner.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/eval-runner.ts)는 release gate threshold, slice metrics, flagged slice, evidence audit, calibration, admission violation까지 포함한 full eval orchestrator다
- [slice-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/slice-evaluator.ts)는 queryClass + sliceTags 기준 slice evaluation과 utility/wrong-resolve/ECE regression flag를 이미 계산한다
- [search-pipeline-evaluator.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/search-pipeline-evaluator.ts)는 actual search use case를 eval output contract로 변환하는 bridge seam를 이미 제공한다
- [pg-gold-set-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-gold-set-store.ts), [pg-eval-result-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-eval-result-store.ts)는 eval dataset/result persistence seam를 이미 제공한다
- [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts)는 alias proposal adversarial guard, threshold proposal minimum utility/eval count, slice regression, shadow testing requirement까지 이미 가진다
- [threshold-optimizer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/threshold-optimizer.ts)는 held-out eval 결과 위에서 threshold grid search proposal을 이미 만든다

즉 evaluation/release/shadow promotion도 greenfield가 아니다.  
남은 갭은 lane policy, rerank gate, ranked-route calibrator, taxonomy uplift를 이 existing eval/promotion seam와 더 직접 연결하는 일이지, 새 offline eval stack이나 새 promotion loop를 다시 만드는 일이 아니다.

### 1.6.6 Batch / tool / comparison / provenance response seam도 이미 있다

운영 보조 경로와 machine/tool surface도 이미 꽤 제품화돼 있다.

- batch search use case with deterministic batch id and fail-fast/partial modes
- tool executor and adaptive fallback
- comparison response contract
- canonical retrieval provenance slice contract

핵심 파일:

- [batch-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/batch-search.usecase.ts)
- [batch-search.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/batch-search.route.ts)
- [tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/tool-executor.ts)
- [adaptive-tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/adaptive-tool-executor.ts)
- [comparison-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/comparison-response.ts)
- [provenance.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/provenance.ts)
- [drinking-window.usecase.ts](/Users/songmin/wine-search-engine/src/application/drinking-window/drinking-window.usecase.ts)
- [search-usecase-cache-hit.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-cache-hit.ts)
- [search-usecase-cache-lookup.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-cache-lookup.ts)
- [search-usecase-cache-context.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-cache-context.ts)

평가:

- [batch-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/batch-search.usecase.ts)는 deterministic batch id, fail_fast/partial execution, timeout, per-item request id propagation을 이미 가진다
- [batch-search.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/batch-search.route.ts)는 batch search를 declared contract route로 이미 surface에 연결한다
- [batch-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/batch-search.usecase.ts)는 batch start debug step과 id schema decode까지 포함해 batch execution seam를 already-runtime contract로 운영한다
- [tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/tool-executor.ts)는 search_wines / food pairing / drinking window / compare_wines를 type-safe tool surface로 이미 제공한다
- [adaptive-tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/adaptive-tool-executor.ts)는 empty result 시 `mixed` 1-shot fallback과 fallback transparency를 이미 가진다
- [comparison-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/comparison-response.ts)는 decomposed comparison query의 transport contract를 이미 typed response로 고정한다
- [provenance.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/provenance.ts)는 runtime retrieval traces, offline eval slices, ranking labels를 잇는 canonical provenance vocabulary와 `EvalProvenanceSlice` contract를 이미 제공한다
- [drinking-window.usecase.ts](/Users/songmin/wine-search-engine/src/application/drinking-window/drinking-window.usecase.ts)는 predictor contract를 application-level `DrinkingWindowBlock` surface로 bridge하는 seam다
- [search-usecase-cache-hit.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-cache-hit.ts), [search-usecase-cache-lookup.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-cache-lookup.ts), [search-usecase-cache-context.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-cache-context.ts)는 cache hit refresh, cache read guard, request->cache context 축을 이미 작은 seam들로 분리한다

즉 batch/tool/comparison/provenance response도 greenfield가 아니다.  
남은 갭은 이 운영 surface를 canonical taxonomy/difficulty/risk policy와 더 직접 정렬하는 일이지, 새 batch stack이나 새 tool response plane을 다시 만드는 일이 아니다.

### 1.6.7 Post-route execution / decision input / response assembly seam도 이미 있다

검색 결과가 최종 응답으로 조립되는 post-route seam도 이미 꽤 정교하다.

- contradiction/entropy-abstain response param builders
- ranked-route decision phase
- decision input assembler
- ranked result -> result item mapper
- counterfactual and provenance surface propagation
- response builder integration with cache/logging

핵심 파일:

- [search-usecase-execute-builders.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-execute-builders.ts)
- [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts)
- [search-usecase-map-result-items.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-map-result-items.ts)
- [search-usecase-decision-input.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-decision-input.ts)
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)

평가:

- [search-usecase-execute-builders.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-execute-builders.ts)는 hard-constraint contradiction, entropy abstain 같은 early/alternate response path를 typed response param builder로 이미 분리한다
- [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts)는 ranked route 이후 `decision input -> decision engine -> result mapping -> response builder -> log/cache`를 공통 post-route seam로 이미 묶는다
- [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts)는 route degradation merge, specialized route observability, retrievalProvenanceSlices, counterfactuals, structured log emission을 한 경로에서 already-runtime contract로 운영한다
- [search-usecase-map-result-items.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-map-result-items.ts)는 ranked result를 ResultItem으로 조립하면서 drinking window prediction/cache fill/soft-fail까지 이미 처리한다
- [search-usecase-decision-input.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-decision-input.ts)는 ranking signals, identity/constraint/anchor evidence, honesty contract를 DecisionInput으로 이미 구조화한다
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)는 engineDecision, clarification, counterfactuals, grouped result, provenance/meta propagation의 최종 조립 seam다

즉 post-route execution/decision input/response assembly도 greenfield가 아니다.  
남은 갭은 이 seam를 canonical taxonomy/execution contract와 더 직접 정렬하는 일이지, 새 result assembly stack이나 새 post-processing engine을 다시 만드는 일이 아니다.

### 1.6.8 Scan closure 기준: 큰 결론을 바꿀 새 축은 거의 더 안 나온다

지금까지 전수 스캔 기준으로, 새로 발견되는 자산은 주로 `이미 있는 seam의 세부 보강` 수준이다.

- route contract and handler pattern
- debug/trace/snapshot reproducibility
- provenance/id schema/helper
- cache/inference/model-serving
- alias/ambiguity/learned matcher
- mixed/substitute/comparison
- eval/release/promotion
- batch/tool/provenance response
- post-route response assembly

따라서 앞으로는:

1. 새 발견이 나와도 전체 결론을 뒤집지 않는다
2. [appendix-j-existing-asset-registry.md](/Users/songmin/wine-search-engine/docs/plans/apr-7-v0.4/appendix-j-existing-asset-registry.md)에만 `reuse/promote/thin_adapter/remove_later`로 흡수한다
3. 구현 우선순위는 계속 아래 4개에 고정한다

- runtime SSOT 전환
- lane policy table
- multi-signal calibrated gate
- taxonomy-aligned serving/eval/response policy

즉 이 시점부터는 `asset discovery`보다 `execution/migration`으로 넘어가는 게 맞다.

### 1.7 Quality-enriched catalog/runtime seam

검색 품질을 올릴 때 바로 재사용 가능한 quality seam도 있다.

- drinking-window predictor + model/evidence semantics
- result-level blocking eligibility
- availability / critic / prestige aware retrieval metadata
- watchlist/event publisher for availability/price/critic changes

핵심 파일:

- [drinking-window-predictor.ts](/Users/songmin/wine-search-engine/src/infrastructure/ml/drinking-window-predictor.ts)
- [drinking-window-confidence.ts](/Users/songmin/wine-search-engine/src/application/search/drinking-window-confidence.ts)
- [search-usecase-map-result-items.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-map-result-items.ts)
- [watchlist-aware-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/watchlist-aware-search-index.ts)
- [watchlist-policy.ts](/Users/songmin/wine-search-engine/src/domain/watchlist/service/watchlist-policy.ts)

평가:

- drinking-window는 실험 메모 수준이 아니라 predictor, evidence level, blocking eligibility, response block까지 이미 연결돼 있다
- watchlist/search-index seam은 availability/price/critic 변경을 event로 발행할 수 있어서 future inventory/value loop의 foundation이 된다
- ranking runtime의 availability signal은 아직 placeholder 성격이 있지만, catalog/infrastructure 쪽 quality event spine는 이미 존재한다

---

## 2. 가장 큰 구조 문제: 축이 너무 많고 SSOT가 없다

현재 query 이해 / 실행 정책 축은 하나가 아니다.

- `QueryIntent`
- `QueryClass`
- `QueryFamily`
- `RetrievalMode`
- `QueryRoute`

핵심 파일:

- [query-intent.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-intent.ts)
- [query-class.ts](/Users/songmin/wine-search-engine/src/domain/shared/types/query-class.ts)
- [query-observability-vocab.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-observability-vocab.ts)
- [retrieval-mode.ts](/Users/songmin/wine-search-engine/src/domain/query/model/retrieval-mode.ts)
- [query-route.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-route.ts)

문제는 단순히 라벨이 많다는 게 아니다.

- intent는 planner가 씀
- class는 scoring/rerank가 많이 참조함
- family는 observability와 일부 retrieval policy에 씀
- retrieval mode는 실행 정책의 핵심처럼 보이지만 taxonomic source of truth는 아님

즉 현재는 **taxonomy가 여러 조각으로 분산돼 있고, 각 조각이 다른 계층에서 제각각 권위를 가진다.**

이 상태의 부작용:

- broad / long-NL / substitute 같은 query를 1급 정책 대상으로 다루기 어렵다
- CE gate, fusion, explanation, eval slice가 같은 언어를 쓰지 못한다

---

## 3. Query understanding은 있지만 Q1~Q7 contract는 아니다

Planner는 꽤 많은 걸 한다.

- normalization
- anchor extraction
- intent detection
- route 결정
- retrieval mode 결정
- query class 결정
- constraints / uncertainty / policy / target entity type 계산

핵심 파일:

- [planner.ts](/Users/songmin/wine-search-engine/src/domain/query/service/planner.ts)
- [planner-intent-detection.ts](/Users/songmin/wine-search-engine/src/domain/query/service/planner-intent-detection.ts)
- [policy-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/policy-compiler.ts)
- [query-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/query/service/query-normalizer.ts)

하지만 SOTA++ taxonomy 관점에서는 아직 부족하다.

### 3.1 broad / long-NL이 독립 시민이 아니다

- `broad_exploration` 같은 intent가 없다
- 긴 자연어는 대부분 `semantic_discovery`나 `mixed_query`에 흡수된다

즉 `Q6 broad`, `Q7 long-NL` 전용 정책이 없다.

### 3.2 side-intent contract가 약하다

`secondaryIntents`는 있으나, 실질적으로는 다중 anchor가 있을 때 뒤쪽 anchor를 `entity_exact/entity_fuzzy`로만 붙이는 수준이다.

즉 설계상 중요한:

- dominant intent
- side-intent
- side-signal fusion

이 공식 계약으로 승격돼 있지 않다.

### 3.3 relative/substitute intent가 planner SSOT로 올라오지 않는다

`RelativeQueryExtractor`와 `AnchorExtractor.extractWithRelative()`는 존재한다.  
하지만 실제 planner는 `extract()`를 사용한다.

핵심 파일:

- [anchor-extractor.ts](/Users/songmin/wine-search-engine/src/domain/query/service/anchor-extractor.ts)
- [planner.ts](/Users/songmin/wine-search-engine/src/domain/query/service/planner.ts):116

즉 relative operator가 실행 정책의 핵심 입력으로 올라오지 못한다.

### 3.4 contradiction / uncertainty / policy primitive는 이미 runtime-integrated다

문서만 보면 difficulty, abstention, clarification policy가 거의 미래 작업처럼 보일 수 있는데, 실제 런타임에는 이 축의 primitive가 이미 들어가 있다.

핵심 파일:

- [constraint-sat.ts](/Users/songmin/wine-search-engine/src/domain/query/service/constraint-sat.ts)
- [planner.ts](/Users/songmin/wine-search-engine/src/domain/query/service/planner.ts)
- [policy-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/policy-compiler.ts)
- [planner-v1-adapter.ts](/Users/songmin/wine-search-engine/src/config/planner-v1-adapter.ts)
- [search-usecase-pre-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts)
- [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts)

평가:

- [search-usecase-pre-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts)는 retrieval 전에 [constraint-sat.ts](/Users/songmin/wine-search-engine/src/domain/query/service/constraint-sat.ts)로 hard constraint contradiction을 fail-fast 처리한다
- [planner.ts](/Users/songmin/wine-search-engine/src/domain/query/service/planner.ts)는 `parserConfidence / anchorConfidence / constraintConfidence / ambiguitySeverity / decisionEffect`까지 포함한 uncertainty를 실제로 계산한다
- [planner-v1-adapter.ts](/Users/songmin/wine-search-engine/src/config/planner-v1-adapter.ts)는 [policy-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/policy-compiler.ts)를 통해 `requireClarification / allowApproximate / fallbackMode`를 V1 plan으로 끌어내린다
- [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts)는 `requireClarification`, `uncertainty.decisionEffect`, `ambiguitySummary.decisionEffect`를 보고 clarify/fail을 선행 short-circuit 한다

즉 SOTA++에서 말하는 `difficulty / abstention / safe fallback`이 완전 greenfield인 것은 아니다.  
남은 갭은 이 primitive들이 아직 `Q1~Q7 taxonomy + lane policy table + CE gate + ranked-route calibrator`와 하나의 표준 feature contract로 정렬되지 않았다는 점이다.

---

## 4. Execution contract는 설계돼 있지만 메인 경로의 중심이 아니다

이 레포에는 꽤 좋은 방향의 타입이 이미 있다.

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

문제:

- production path는 아직 `PlannerV1Adapter`가 V2 planner를 V1 plan으로 접어서 씀
- `ExecutionCompiler`는 테스트/모델 관점에서는 준비돼 있지만 메인 검색 경로의 currency가 아니다

핵심 파일:

- [planner-v1-adapter.ts](/Users/songmin/wine-search-engine/src/config/planner-v1-adapter.ts)
- [container-core.ts](/Users/songmin/wine-search-engine/src/config/container-core.ts)

즉 현재는 **좋은 계약이 있으나 실제 orchestration의 SSOT는 아직 옛 V1 runtime shape**다.

---

## 5. Retrieval lane은 “존재”하지만 “정식 lane architecture”는 아니다

현재 레포에는 lane에 가까운 자산이 많다.

- `sparse_bm25`
- `learned_sparse`
- `dense_semantic`
- `anchor_similarity`
- `relative_filter`
- `browse_producer`
- `browse_region`
- `compare_anchor`

핵심 파일:

- [retrieval-channel.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-channel.ts)
- [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts)
- [channel-mix-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/channel-mix-policy.ts)

하지만 아직 부족한 점:

### 5.1 queryFamily policy가 retrievalMode에 자주 가려진다

`RetrievalProfileService.getProfile()`는 queryFamily를 받지만, `retrievalMode`가 주어지면 사실상 mode 기반 선택이 우선한다.

핵심 파일:

- [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts):216

결과:

- observability family가 retrieval policy SSOT가 아니다
- intent별 lane strategy가 문서적/정책적 중심이 되지 못한다

### 5.2 profile weight가 fusion weight는 아니다

profile에는 `sparseWeight`, `denseWeight`, `anchorWeight`가 있지만 실제 fusion은 RRF다.

핵심 파일:

- [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts)
- [fusion.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/fusion.ts)

즉 “lane별 정책 표”는 아직 없다.

### 5.3 query expansion이 retrieval input으로 충분히 들어가지 않는다

retrieval input builder는 거의 항상:

- lexicalQueries = `[normalizedQuery]`
- semanticQueries = `[rawQuery]`

로 간다.

핵심 파일:

- [search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts):79

다만 완전히 없는 것은 아니다.

핵심 파일:

- [expansion-builder.ts](/Users/songmin/wine-search-engine/src/domain/query/service/expansion-builder.ts)
- [planner.ts](/Users/songmin/wine-search-engine/src/domain/query/service/planner.ts)
- [cache-service.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-service.ts)

평가:

- planner는 이미 intent별 lexical/semantic expansion bundle을 만든다
- cache key도 `plan.expansions.lexical + plan.expansions.semantic`을 포함해 query meaning drift를 어느 정도 반영한다
- 즉 expansion asset은 이미 runtime에 존재하지만, retrieval path가 이를 충분히 소비하지 못한다

즉 planner가 만든 lexical/semantic expansions가 retrieval lane 설계의 핵심 신호로 **충분히** 내려가지 못한다는 것이 정확한 표현이다.

### 5.4 multi-view / provenance primitive는 이미 있다

문서 관점에서는 `product-centered multi-view retrieval`이 아직 목표 상태에 가깝다.  
하지만 완전히 빈 상태는 아니다.

핵심 파일:

- [query-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/query/service/query-normalizer.ts)
- [candidate-envelope.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/candidate-envelope.ts)
- [evidence-accumulator.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/evidence-accumulator.ts)
- [retrieval-document.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-document.ts)
- [projection-builder.ts](/Users/songmin/wine-search-engine/src/domain/entity/service/projection-builder.ts)

평가:

- query side에는 `strict / accentless / transliterated / phonetic / vintage canonicalized` multi-view가 이미 있다
- retrieval provenance는 `queryViewMatches`, `channelScores`, `protectedInclusionReason`, `matchedFilterConstraints`까지 이미 구조화돼 있다
- document side도 `hit projection`과 `feature projection` boundary가 분리돼 있어, future product-view expansion의 seam가 있다
- 즉 없는 것은 `item-level multi-view selection policy`지, multi-view primitive 자체가 아니다

### 5.5 specialized browse/compare retrieval은 이미 runtime-integrated다

문서만 읽으면 browse/compare가 아직 실험적처럼 보일 수 있는데, 실제로는 generic candidate pool 앞단에 붙은 first-class runtime 경로다.

핵심 파일:

- [browse-retriever.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/browse-retriever.ts)
- [compare-retriever.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/compare-retriever.ts)
- [search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts)
- [search-usecase-hybrid-ranking-pipeline.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-ranking-pipeline.ts)
- [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts)
- [specialized-route-observability.ts](/Users/songmin/wine-search-engine/src/application/search/specialized-route-observability.ts)

평가:

- `producer_browse`, `region_browse`, `compare_candidates`는 [search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts)에서 generic candidate pool보다 먼저 시도된다
- specialized path가 비거나 anchor resolution이 실패하면 generic hybrid로 degrade되며, 그 사실이 `specializedRouteRequested / specializedRouteExecuted / fallbackApplied / fallbackReason`으로 구조화된다
- 이 observability는 [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts)를 통해 최종 response/meta/logging까지 전달된다

즉 browse/compare specialized lane은 존재만 하는 것이 아니라 **이미 runtime-integrated retrieval fallback path**다.  
남은 갭은 이것을 `broad_exploration / similar_substitute / difficulty-aware budget policy`와 같은 상위 taxonomy/policy table 아래에서 통합 운영하지 못하고 있다는 점이다.

---

## 6. Candidate budget도 여러 곳에 흩어져 있다

budget 관련 축이 세 군데 이상 존재한다.

1. request-level `queryBudget`
2. `ExecutionCompiler.DEFAULT_BUDGETS`
3. `RetrievalProfile`의 `sparseTopN/denseTopN/finalTopK`

핵심 파일:

- [query-budget.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-budget.ts)
- [execution-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/execution-compiler.ts)
- [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts)

문제:

- request budget는 planner context까지는 가지만 downstream에서 일관되게 강제되지 않는다
- `rerankLimit`는 계약상 있으나 ranking path의 top-K와 직접 연결돼 있지 않다
- intent별 candidate budget table이 공식적으로 없다

즉 budget도 **존재는 하지만 통합 policy는 아니다.**

### 6.1 session context / query budget carry-through seam도 이미 있다

문서만 보면 session과 budget이 거의 future work처럼 보일 수 있는데, 실제로는 request -> planner -> plan -> cache/replay 경로에 이미 실려 다닌다.

핵심 파일:

- [search-usecase-planner-context.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-planner-context.ts)
- [planner.ts](/Users/songmin/wine-search-engine/src/domain/query/service/planner.ts)
- [query-budget.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-budget.ts)
- [cache-service.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-service.ts)
- [replay.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/replay.usecase.ts)

평가:

- request의 `sessionContext`, `queryBudget`는 planner context로 변환돼 실제 plan에 실린다
- cache key와 replay request도 session/budget을 carry한다
- 즉 session/budget transport seam 자체는 이미 있다

다만 caveat도 분명하다.

- [reformulation-detector.ts](/Users/songmin/wine-search-engine/src/domain/query/service/reformulation-detector.ts)는 아직 planner/search runtime에 실제로 연결돼 있지 않다
- query budget도 execution policy의 공식 SSOT라기보다 carry-through field에 가깝다

즉 이 축은 **미구현이라기보다 transport는 되어 있고 policy화가 덜 된 상태**다.

---

## 7. CE gate는 분명히 존재하지만, 아직 얇다

현재 rerank gate 입력은 대체로 아래다.

- candidate count
- query class
- effective route
- has anchor
- force flag

핵심 파일:

- [rerank-gate.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/rerank-gate.ts)

좋은 점:

- short entity는 많이 스킵한다
- semantic_preference는 CE를 켠다
- anchor/comparison은 CE를 켠다

부족한 점:

- ambiguity score 없음
- exact confidence 없음
- score gap 없음
- sparse/dense disagreement 없음
- latency pressure 없음
- value weight 없음
- broad first-entry OFF 정책 없음

추가로 route/mode 축도 약간 어긋나 있다.

- gate는 `effectiveRoute === 'exact_lookup'`를 보지만
- ranker가 넘기는 건 `queryPlan.route`

핵심 파일:

- [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts):479

즉 SOTA++ 관점에서 가장 먼저 손대야 할 곳 중 하나가 CE gate다.

---

## 8. Ranking funnel은 풍부하지만 R1/R2 역할이 분리돼 있지 않다

현재 ranking stack에는 이미 많은 요소가 있다.

- signal compute
- score aggregate
- mode weights
- channel-aware weights
- CE rerank
- learned LTR

핵심 파일:

- [signal-computer.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/signal-computer.ts)
- [score-aggregator.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/score-aggregator.ts)
- [mode-weights.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/mode-weights.ts)
- [scoring-weights.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/scoring-weights.ts)
- [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts)

하지만 설계상 가장 큰 갭은 이거다.

### 8.1 LTR과 CE가 같은 gate 아래 있다

현재는 rerank gate를 통과해야 CE뿐 아니라 learned LTR도 사실상 켜진다.

핵심 파일:

- [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts):469

즉:

- `LTR broad / cheap`
- `CE narrow / expensive`

라는 끝판 구조가 아직 아니다.

### 8.2 CE 뒤에 LTR이 final score를 덮는다

현재 흐름에서는 CE가 먼저 reorder/blend하고, 그 뒤 learned LTR이 다시 final score를 덮는다.

즉 CE가 precision judge라기보다 중간 단계가 되어버릴 수 있다.

### 8.3 mode weights도 일부만 실제로 먹는다

`ModeWeightProfile`에는 lexical/entity/diversity/geographic/producer/recency 축이 있지만, ranker가 실제로 overlay하는 건 일부다.

핵심 파일:

- [mode-weights.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/mode-weights.ts)
- [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts):324

즉 “정책 선언”과 “실제 사용” 사이에 간극이 있다.

### 8.4 preference / availability가 placeholder 성격이 강하다

- `preferenceAlignment`는 현재 0.5 neutral default
- `availability`는 ranking candidate에서 1.0 default

핵심 파일:

- [signal-computer.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/signal-computer.ts):435
- [signal-computer.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/signal-computer.ts):280

즉 sensory/pairing/business axis는 정의 대비 실제 신호가 아직 약하다.

### 8.5 stage-aware funnel은 이미 runtime path에 연결돼 있다

stage-aware ranking contract도 문서상의 미래 구조만은 아니다.

핵심 파일:

- [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts)
- [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)
- [search-usecase-hybrid-ranking-pipeline.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-ranking-pipeline.ts)
- [container-core-builders.ts](/Users/songmin/wine-search-engine/src/config/container-core-builders.ts)
- [funnel-metrics.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/funnel-metrics.ts)
- [ranking-runtime-signal.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-runtime-signal.ts)

평가:

- [container-core-builders.ts](/Users/songmin/wine-search-engine/src/config/container-core-builders.ts)는 실제 runtime에서 [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts)을 구성한다
- [search-usecase-hybrid-ranking-pipeline.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-ranking-pipeline.ts)는 ranking 후 `funnelMetrics`, runtime degradation signal을 실제 route execution 결과로 소비한다
- [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts)은 `coarse_prune / primary_rank / precision_rerank / policy_apply` trace와 metric을 이미 만든다

즉 stage-aware funnel은 offline-only scaffolding이 아니라 **실제 serving path에 연결된 observability contract**다.  
남은 갭은 stage boundary 안의 책임이 여전히 [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)에 많이 뭉쳐 있고, stage별 cost/latency/promotion policy와 완전히 연결돼 있지 않다는 점이다.

---

## 9. Explanation과 API는 존재하지만 query-type별 계약은 약하다

### 9.1 Explanation은 generic evidence summary 중심

현재는 evidence가 있고, human summary도 있다.

핵심 파일:

- [evidence-mapper.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/evidence-mapper.ts)
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)
- [human-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/human-response-builder-v2.ts)

하지만 아직:

- sensory template
- pairing template
- substitute template
- exact/filter template

같은 intent별 explanation contract가 없다.

다만 response surface 자체는 생각보다 강하다.

- parsed constraints extern
- counterfactual rejects
- retrieval provenance slices
- specialized route requested/executed
- fallback applied / fallback reason

핵심 파일:

- [search-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/search-response.ts)
- [counterfactual.ts](/Users/songmin/wine-search-engine/src/domain/response/model/counterfactual.ts)
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)
- [search-usecase-counterfactuals.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-counterfactuals.ts)
- [specialized-route-observability.ts](/Users/songmin/wine-search-engine/src/application/search/specialized-route-observability.ts)

즉 설명/투명성 surface를 새로 만드는 게 아니라, existing response contract를 intent-aware obligation으로 강화하는 쪽이 맞다.

### 9.3 LLM/agent surface를 위한 parsed contract도 이미 있다

`SearchResponseV1`는 이미 machine-consumable envelope를 일부 제공한다.

- `parsedConstraints`
- `resultType`
- `retrievalMode`
- `counterfactuals`
- `specialized route/fallback meta`

즉 MVP나 agent usecase에서 LLM이 raw text만 읽게 둘 필요가 없고, existing structured envelope를 더 적극적으로 쓰는 방향이 가능하다.

### 9.2 `/v2/search`도 사실상 V1 projection이다

V2 route는 존재하지만, 독립적인 new result contract를 full-stack으로 태우기보다 기존 V1 응답을 projection한다.

핵심 파일:

- [search-v2.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search-v2.route.ts)

즉 UX / explanation / machine surface도 아직 최종 형태로 통합되지 않았다.

### 9.4 V2 human / machine / explain seam도 이미 channel별로 productized다

response V2도 한 덩어리로 없는 것이 아니라, human과 machine이 다른 channel에서 이미 살아 있다.

핵심 파일:

- [search-v2.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search-v2.route.ts)
- [machine-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/machine-response-builder-v2.ts)
- [tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/tool-executor.ts)
- [interpret.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/interpret.usecase.ts)

평가:

- `/v2/search`와 `/v2/search/hybrid`는 이미 human V2 projection을 제공한다
- machine V2는 없는 게 아니라 `/v1/claude-tools` seam에서 [tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/tool-executor.ts)를 통해 실제 제공된다
- [interpret.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/interpret.usecase.ts)는 planner 결과를 V2 explain contract로 뽑는 별도 seam도 갖고 있다

즉 V2 response는 완전 greenfield가 아니라 **human / machine / explain이 channel별로 부분 productized**된 상태다.  
남은 갭은 이 셋을 같은 taxonomy/policy/explanation obligation 아래에서 일관되게 정렬하지 못한 점이다.

---

## 10. Eval은 강하지만 taxonomy-aligned는 아니다

현재 eval stack은 꽤 좋다.

- offline runner
- slice evaluator
- evidence auditor
- calibration evaluator

핵심 파일:

- [eval-runner.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/eval-runner.ts)
- [slice-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/slice-evaluator.ts)
- [calibration-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/calibration-evaluator.ts)
- [evidence-auditor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/evidence-auditor.ts)

하지만 갭:

- Q1~Q7 taxonomy 기준 slice가 아니다
- `queryClass`와 `sliceTags` 중심이다
- constraint metric과 evidence type 이름 사이에 mismatch 여지가 있다

예:

- evaluator는 `constraint_pass`를 찾는데
- evidence mapper는 `hard_constraint_pass`를 낸다

즉 eval도 강하지만, 최종 목표 taxonomy와 완전히 정렬된 건 아니다.

보강 포인트:

- evidence faithfulness는 이미 `sufficiency / comprehensiveness / completenessRate` audit가 있다
- calibration도 per-query-class ECE까지 준비돼 있다
- selective prediction도 `risk-coverage / AURC / E-AURC`가 준비돼 있다
- 따라서 이 영역은 greenfield가 아니라 taxonomy remap과 serving-loop 연결 문제에 가깝다

---

## 11. 현재 엔진을 한 줄로 평가하면

현재 엔진은 이미:

- hybrid retrieval 엔진이다
- gated rerank 엔진이다
- intent-aware fragments를 갖고 있다
- mixed / compare / pairing / eval까지 건드린 실전형 코드베이스다

하지만 아직:

- 공식 taxonomy가 없고
- route / mode / class / family가 병렬 권위를 가지며
- retrieval lanes가 정책 테이블로 통합되지 않았고
- R1/LTR, R2/CE 역할 분리가 약하고
- explanation / eval / business guardrail이 query taxonomy 위에서 정렬되지 않았다

즉 **“부품은 강한데 운영 계약이 흩어져 있는 상태”**다.

---

## 12. 바로 다음 단계의 정리 포인트

이 상태에서 우선순위는 명확하다.

1. `taxonomy SSOT`
Q1~Q7 또는 동급 taxonomy를 공식 계약으로 올린다.

2. `execution contract 승격`
`QueryUnderstandingSnapshot + EngineExecutionContract`를 메인 runtime currency로 만든다.

3. `lane policy table`
intent별 lane mix / budget / fusion / rerank depth를 표로 고정한다.

4. `multi-signal CE gate`
ambiguity, exact confidence, gap, disagreement, latency, value를 넣는다.

5. `R1 / R2 분리`
LTR broad, CE narrow를 독립 정책으로 만든다.

6. `explanation / eval 정렬`
taxonomy별 explanation 의무와 eval slice를 고정한다.

이 여섯 개가 정리되면, 그 다음부터 learned sparse, late interaction, domain-tuned reranker를 얹는 것이 훨씬 쉬워진다.

---

## 13. SOTA++ 대비 아직 문서에 더 박아둬야 할 보완 포인트

위에서 적은 갭 외에도, 현재 레포와 향후 목표를 같이 놓고 보면 아래 항목들은 별도로 의식적으로 챙겨야 한다.

### 13.1 Catalog quality gating이 약하다

SOTA++ retrieval/ranking은 catalog 품질 편차에 매우 민감하다.  
현재 레포는 metadata richness, critic/prestige, popularity는 일부 반영하지만, 아래처럼 “문서 품질이 낮을 때 어떻게 안전하게 후퇴할지”가 독립 정책으로 정리돼 있지 않다.

- metadata completeness prior
- tasting note coverage prior
- alias confidence prior
- noisy field down-weight
- explanation suppression when evidence is weak

추가로 바닥 인프라는 일부 있다.

- [anchor-profiler.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/anchor-profiler.ts)는 completeness 기반으로 anchor confidence를 깎는다
- [evidence-auditor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/evidence-auditor.ts)는 offline evidence completeness/sufficiency를 본다

즉 현재는 좋은 문서를 더 잘 올리는 쪽은 일부 있으나, **나쁜 문서를 얼마나 강하게 방어적으로 다룰지**를 serving-time policy로 고정한 상태는 아니다.

### 13.2 Session / context-aware continuation이 거의 없다

현 구조는 query 단위 판단이 강하고, 직전 클릭/PDP/장바구니/세션 흐름을 retrieval/ranking에 적극 반영하는 구조는 약하다.

SOTA++ 실무 기준에서는 broad query조차 세션에 따라 달라진다.

- `보르도 와인`이 첫 질의인지
- 직전에 `Opus One` PDP를 본 뒤인지
- `선물용` 필터를 이미 만졌는지

다만 완전한 0은 아니다.

- [session-context.ts](/Users/songmin/wine-search-engine/src/domain/query/model/session-context.ts)로 세션 컨텍스트가 planner까지 들어간다
- [reformulation-detector.ts](/Users/songmin/wine-search-engine/src/domain/query/service/reformulation-detector.ts)로 query continuation primitive도 있다

즉 **session primitive는 이미 있지만**, 이를 retrieval lane / gate / explanation / personalization policy까지 올린 상태는 아니다.

### 13.3 Offer / inventory / merchant-aware ranking이 약하다

현재는 availability가 retrieval 단계에서는 강하게 필터되고, ranking 쪽 availability score는 placeholder 성격이 강하다.  
하지만 실제 commerce-grade 검색은 다음을 더 세분화해 다룬다.

- in stock vs low stock
- 배송 ETA / 오늘출발
- merchant trust / fulfillment quality
- 같은 wine의 offer aggregation

다만 완전한 부재는 아니다.

- [vespa-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts)는 retrieval 단계에서 `availability = true`를 baseline filter로 건다
- [watchlist-aware-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/watchlist-aware-search-index.ts)는 stock change 이벤트까지 다룬다

즉 현재는 entity-centric 검색과 availability baseline은 이미 있으나, **offer/merchant-aware commerce ranking**까지는 아직 아니다.

### 13.4 Hard negative mining과 teacher-student loop가 운영 구조로 붙어 있지 않다

eval, LTR, reranker 스캐폴드는 있다.  
또한 feedback ingest와 aggregation 바닥 인프라도 이미 있다.

- [feedback.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/feedback.route.ts)
- [feedback-processor.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/feedback-processor.ts)
- [alias-proposer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/alias-proposer.ts)
- [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts)

하지만 아래 루프가 search serving/ranking policy와 연결된 운영 프로세스로 고정돼 있지는 않다.

- 실패 케이스 수집
- hard negative mining
- CE teacher score 생성
- retriever/LTR distillation
- regression gate 업데이트

즉 학습 자산은 일부 있으나, **feedback -> search policy/ranking 개선**으로 닫히는 폐루프는 아직 약하다.

### 13.5 Query decomposition / planner-agent 계층이 약하다

long-NL composed query에 대해 현재는 semantic_discovery/mixed_query에 많이 흡수된다.  
하지만 SOTA++ 방향에서는 아래가 더 필요하다.

- hard/soft constraint ledger
- conflicting constraint repair
- decomposition with provenance
- retriever disagreement-aware refinement

여기도 0은 아니다.

- [decomposition-detector.ts](/Users/songmin/wine-search-engine/src/domain/query/service/decomposition-detector.ts)로 비교형 decomposition hint를 만든다
- [search-usecase-pre-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts)는 valid comparison decomposition이면 [decomposed-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search.usecase.ts)로 조기 분기한다
- constraint contradiction도 [search-usecase-pre-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts)에서 early exit를 갖는다

즉 **비교형 decomposition과 contradiction exit는 이미 productized**되어 있다.  
부족한 것은 long-NL 전반에 대한 hard/soft ledger, provenance-rich decomposition, repair/refinement loop다.

### 13.6 Diversity / coverage control이 부분적이다

현재는 일부 producer diversity나 protected recall은 있다.  
하지만 exploration/sensory/recommendation에서 필요한 아래 축은 아직 약하다.

- varietal diversity
- region diversity
- price-band coverage
- catalog-tier fairness
- same-producer clustering suppression

partial primitive는 이미 있다.

- [browse-diversity.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/browse-diversity.ts)는 producer/region browse에서 diversity selection을 한다
- [protected-recall-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/protected-recall-policy.ts)는 known item / exact alias / hard-constraint-compatible candidate를 보호한다

즉 broad / sensory query 전반의 **general diversity framework**는 아직 아니지만, browse-specific diversity와 protected recall은 이미 구현돼 있다.

### 13.7 Explanation faithfulness를 별도 gate로 쓰지 않는다

현재는 evidence와 human summary가 있지만, 아래와 같은 운영 규칙은 아직 약하다.

- explanation required query families
- evidence minimum threshold
- low-evidence recommendation suppression
- explanation/eval faithfulness audit

여기도 partial primitive는 이미 있다.

- [evidence-auditor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/evidence-auditor.ts)는 offline faithfulness/completeness를 계산한다

즉 설명은 존재하지만, **설명이 충분히 근거 기반인지 검사해서 serving 결과를 제어하는 계약**은 아직 약하다.

### 13.8 Multilingual / transliteration robustness는 exact 쪽이 강하고 semantic 쪽은 더 키울 여지가 있다

현재 normalization과 alias는 꽤 강하다.  
하지만 SOTA++ 기준으로는 아래가 더 필요하다.

- multilingual dense retrieval eval slices
- Korean/English mixed semantic paraphrase set
- transliteration noise hard negatives
- code-switch long-NL benchmark

즉 exact resolution robustness는 좋은 편이지만, **다국어 semantic robustness**는 아직 공식 목표/평가축으로 더 강화해야 한다.

### 13.9 Query multi-view는 일부 있고, product multi-view retrieval은 아직 아니다

문서에서 말한 `product-centered multi-view retrieval`을 볼 때 주의할 점이 있다.

- [query-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/query/service/query-normalizer.ts)는 exact/noisy entity lookup을 위한 query-side multi-view normalization을 이미 제공한다
- strict / accentless / punctuation stripped / transliterated / phonetic / reordered variants를 만든다

즉 `multi-view`라는 발상 자체가 전혀 없는 건 아니다.  
하지만 이건 **query view multi-view**이고, SOTA++에서 말하는:

- title view
- tasting note view
- review aggregation view
- pairing view
- gift/occasion view
- substitute neighborhood view

같은 **product-centered multi-view retrieval**과는 다른 단계다.

### 13.10 Calibration / abstention / admission safety spine은 이미 꽤 강하다

문서만 읽으면 confidence / abstention / safety가 거의 미래 작업처럼 보일 수 있는데, 실제 코드는 이 축이 생각보다 깊다.

- [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts)는 calibrated confidence `C`, calibrated gap, uncertainty effect를 binding decision의 핵심으로 쓴다
- [threshold-profile.ts](/Users/songmin/wine-search-engine/src/domain/query/model/threshold-profile.ts)는 query-class별 dynamic gap threshold를 이미 갖고 있다
- [abstain-policy.ts](/Users/songmin/wine-search-engine/src/domain/query/service/abstain-policy.ts)는 entropy-based abstain을 제공한다
- [admission-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/admission-gate.ts)와 [confidence-refusal.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/confidence-refusal.ts)는 low-confidence resolved decision을 거절할 수 있다
- [calibration-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/calibration-evaluator.ts)는 offline calibration 품질도 본다

즉 **confidence / abstention / safety spine 자체는 이미 강하다.**  
SOTA++ 대비 남은 갭은 이 축이 retrieval lane policy, CE gate, explanation suppression, low-confidence UX와 아직 하나의 운영 계약으로 통합되지 않았다는 점이다.

추가 caveat도 있다.

- [search-usecase-ranked-route-resolve.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-ranked-route-resolve.ts)는 hybrid/mixed ranked route에서 `top1 finalScore`를 synthetic `decisionConfidenceC`처럼 사용한다

즉 safety spine은 구조적으로 강하지만, **ranked-route confidence semantics는 아직 완전한 calibrated risk model이라고 보기 어렵다.**

### 13.11 Ingestion / canonicalization quality baseline은 이미 있다

문서만 보면 catalog quality가 전적으로 future work처럼 보일 수 있는데, ingestion 쪽 바닥 방어는 이미 있다.

- [noise-stripper.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/noise-stripper.ts)는 marketplace title noise와 promotional text를 제거한다
- [contamination-detector.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/contamination-detector.ts)는 contamination score를 계산해 ingestion candidate를 flag할 수 있다
- [field-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/field-normalizer.ts)는 locale-aware text/volume/year canonicalization을 담당해 ingestion baseline의 SSOT 역할을 한다
- [entity-matcher.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/entity-matcher.ts)는 embedding-only merge를 금지하고 structural signal cascade로 canonical entity match를 수행한다
- [abuse-detector.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/abuse-detector.ts)는 ingestion input abuse/spam 신호를 별도 guardrail로 잡아낸다

즉 serving-time catalog quality gating은 약하지만, **ingestion/canonicalization baseline**은 이미 존재한다.

### 13.12 Ranking funnel / degradation observability도 이미 있다

ranking 운영을 위한 observability 자산도 생각보다 깊다.

- [ranking-stage.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-stage.ts)는 coarse_prune / primary_rank / precision_rerank / policy_apply의 stage contract를 갖고 있다
- [funnel-metrics.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/funnel-metrics.ts)는 prune pass-rate, rerank top-K change, rank1-rank2 gap, producer diversity 같은 funnel metric을 만든다
- [ranking-runtime-signal.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-runtime-signal.ts)는 degraded/heuristic/advisory execution mode를 표현한다
- [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts)는 route degradation을 response/meta/logging으로 합친다

즉 **운영 관측 spine은 이미 있다.**  
SOTA++ 대비 남은 갭은 이 observability를 promotion gate, latency policy, expensive model budget policy와 직접 연결하지 않았다는 점이다.

### 13.13 LTR는 inference scaffold를 넘어 training/registry까지 있다

LTR도 단순 inference placeholder 수준만은 아니다.

- [ltr-training-service.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-training-service.ts)는 eval 결과를 training example로 바꾸고 per-query-class 모델을 학습한다
- [ltr-feature-extractor.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-feature-extractor.ts)는 inference/training이 같은 feature mapping을 쓰게 해 train-serve skew를 구조적으로 막는다
- [lambdamart-ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/lambdamart-ranker.ts)는 learned ranker scoring seam를 별도 모듈로 이미 분리한다
- [pg-ltr-model-registry.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-ltr-model-registry.ts)는 versioning과 rollback까지 포함한 model registry를 제공한다

즉 **LTR asset은 이미 꽤 깊다.**  
다만 serving에서의 역할 분리가 아직 약하고, query taxonomy/promotion gate와 정렬된 운영 정책까지는 아니다.

### 13.14 Alias / ambiguity baseline도 이미 깊다

exact-safe retrieval과 ambiguity handling도 완전 greenfield는 아니다.

- [alias-matcher.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/alias-matcher.ts)는 exact -> normalized -> char-ngram -> fuzzy -> phonetic의 multi-stage alias match를 이미 제공한다
- [pg-ambiguity-dictionary.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-ambiguity-dictionary.ts)는 known ambiguous surface form registry를 제공한다
- [ambiguity-classifier.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/ambiguity-classifier.ts)는 wine-vs-producer, wine-vs-region, multi-vintage, alias collision 같은 구조적 ambiguity를 분류한다

즉 exact-safe / known-ambiguous / alias-collision 축은 **기초 인프라가 이미 있다.**  
SOTA++ 대비 남은 갭은 이 신호들이 canonical difficulty model, CE gate, explanation/clarify UX와 아직 하나의 정책으로 묶이지 않았다는 점이다.

### 13.15 Clarification / explain response surface도 이미 있다

low-confidence UX와 explainability를 위한 response surface도 일부 완성돼 있다.

- [result-item.ts](/Users/songmin/wine-search-engine/src/domain/response/model/result-item.ts)는 per-result `match`, `constraints`, `uncertainty`, `evidenceItems`, `matchReasons`를 이미 담는다
- [clarification.ts](/Users/songmin/wine-search-engine/src/domain/response/model/clarification.ts)는 disambiguation/missing-info용 clarification payload를 정의한다
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)는 `clarification`, `parsedConstraints`, `meta`, `abstainReason` surface를 이미 조립한다
- [interpret-explain-adapter-v2.ts](/Users/songmin/wine-search-engine/src/application/search/interpret-explain-adapter-v2.ts)는 planner observability를 V2 explain contract로 변환한다

즉 abstain/refine/explain UX를 위한 **API surface 자체는 이미 있다.**  
부족한 것은 query-family별 explanation obligation, evidence threshold, low-confidence interaction policy를 이 surface에 체계적으로 연결하는 일이다.

### 13.16 Threshold / shadow / promotion persistence도 이미 있다

learning loop의 proposal/promotion 계층도 생각보다 더 많이 구현돼 있다.

- [threshold-optimizer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/threshold-optimizer.ts)는 held-out eval 결과 위에서 threshold grid search를 수행하고 proposal을 만든다
- [threshold-proposal.ts](/Users/songmin/wine-search-engine/src/domain/learning/model/threshold-proposal.ts)는 pending -> shadow_testing -> approved/rejected lifecycle을 명시한다
- [pg-proposal-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-proposal-store.ts)는 alias/threshold proposal persistence를 이미 제공한다
- [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts)는 threshold proposal에 대해 shadow testing과 slice regression gate를 이미 요구한다
- [drift-detector.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/drift-detector.ts)는 confidence/resolve-rate/latency 분포 이동을 online drift signal로 감시한다
- [feedback-ttl-enforcer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/feedback-ttl-enforcer.ts)는 feedback retention/privacy TTL policy를 domain service로 이미 갖고 있다

즉 threshold tuning / shadow-first promotion은 **개념만 있는 상태가 아니라 persistence까지 포함한 자산**이 있다.  
부족한 것은 이 proposal pipeline을 retrieval/ranking rollout policy와 end-to-end로 연결하는 일이다.

### 13.16.1 Eval utility / selective prediction seam도 이미 있다

eval은 단순 hit-rate 리포트보다 더 domain-specific한 loss model을 이미 쓴다.

- [utility-scorer.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/utility-scorer.ts)는 wrong resolve를 safe abstain보다 더 크게 벌점 주는 asymmetric utility를 이미 고정한다
- [selective-predictor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/selective-predictor.ts)는 coverage-risk tradeoff를 audit하는 dedicated seam다
- [evidence-auditor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/evidence-auditor.ts)는 evidence sufficiency 위반을 별도 축으로 감사한다

즉 eval loop도 accuracy만 보는 것이 아니라 **utility / abstention / evidence obligation**까지 이미 평가 축으로 가진다.  
남은 갭은 이 지표들을 lane policy, rerank gate, ranked-route calibrator promotion과 더 직접 연결하는 일이다.

### 13.17 Counterfactual / route observability transparency도 이미 있다

설명 가능성과 운영 transparency를 위한 부가 surface도 이미 있다.

- [search-usecase-counterfactuals.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-counterfactuals.ts)는 resolver alternates와 ranked tail을 counterfactual reject로 만든다
- [specialized-route-observability.ts](/Users/songmin/wine-search-engine/src/application/search/specialized-route-observability.ts)는 specialized route requested/executed/fallbackApplied를 구조화한다
- [search-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/search-response.ts)는 `counterfactuals`, `clarification`, `retrievalMode`, `resultType`, `parsedConstraints`를 이미 외부 contract에 포함한다

즉 transparency용 응답 자산도 이미 있고, future work는 이를 query-family별 UX 정책과 정렬하는 일이다.

### 13.18 Calibration / threshold persistence 포트도 이미 있다

calibration과 threshold는 메모리 상수만 있는 게 아니다.

- [calibration-store.port.ts](/Users/songmin/wine-search-engine/src/domain/resolver/port/calibration-store.port.ts)는 query-class별 calibration parameter persistence를 위한 포트를 정의한다
- [threshold-store.port.ts](/Users/songmin/wine-search-engine/src/domain/query/port/threshold-store.port.ts)는 threshold profile persistence를 위한 포트를 정의한다

즉 calibrated decision을 위한 **persistence seam**도 이미 있다.  
SOTA++ 대비 남은 갭은 retrieval/ranked-route calibration까지 같은 governance 모델로 묶지 못했다는 점이다.

### 13.19 Cache / drift guard도 이미 운영 수준으로 존재한다

runtime drift와 cache 안정성도 생각보다 잘 깔려 있다.

- [cache-policy.ts](/Users/songmin/wine-search-engine/src/domain/cache/cache-policy.ts)는 snapshot drift, contract version drift, model version drift, runtime degraded 상태에서 cache bypass를 강제한다

즉 model/version drift에 대한 운영 guardrail도 이미 있다.  
부족한 것은 expensive retrieval/rerank rollout, lane policy rollout, ranked-route calibrator rollout까지 같은 drift-aware gate로 확장하는 일이다.

### 13.20 Resolver-side blocker / calibrator / conformal spine도 이미 있다

resolver core도 단순한 string matcher 수준을 넘는다.

- [blocker.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/blocker.ts)는 blocking recall stage를 별도 seam으로 둔다
- [resolver.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/resolver.ts)는 block -> score -> calibrate -> ambiguity classify -> decision boundary -> conformal set 계산까지 수행한다
- [calibrator.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/calibrator.ts)는 query-class별 calibration parameter를 불러와 calibrated score를 만든다
- [pg-calibration-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-calibration-store.ts)는 calibration parameter persistence 구현체다
- [evidence-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/evidence-gate.ts)는 evidence obligation downgrade를 수행한다

즉 resolver side도 **blocking / calibration / ambiguity / conformal** spine이 이미 있다.  
SOTA++ 대비 남은 갭은 retrieval-ranked path와 resolver path의 risk semantics를 하나의 confidence contract로 통합하지 못했다는 점이다.

### 13.21 Snapshot / version governance도 이미 깊다

재현성과 rollout safety를 위한 snapshot/version 자산도 이미 강하다.

- [pg-snapshot-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-snapshot-store.ts)는 deterministic snapshot id와 persisted decision snapshot을 제공한다
- [search-usecase-decision-snapshot.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-decision-snapshot.ts)는 runtime/plan 기반 decision snapshot builder와 comparable snapshot logic을 제공한다
- [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts)는 response hash와 decision snapshot을 응답 메타에 붙인다

즉 versioned reproducibility와 replay/snapshot governance도 **새로 만들 영역이 아니라 existing spine 재사용 영역**이다.  
앞으로 필요한 것은 lane policy, ranked-route calibrator, expensive reranker rollout도 이 snapshot/version governance 안으로 넣는 일이다.

### 13.22 마지막 omission sweep에서도 새 greenfield 축보다 기존 seam가 더 확인됐다

마지막으로 누락만 털어봐도 결론은 더 강화됐다.

- [query-uncertainty.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-uncertainty.ts), [rule-based-constraint-extractor.ts](/Users/songmin/wine-search-engine/src/domain/query/service/rule-based-constraint-extractor.ts)는 planner uncertainty와 mapping-table miss fallback constraint path를 이미 별도 contract로 가진다
- [retrieval-input.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-input.ts), [candidate-constraint-evidence.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-constraint-evidence.ts), [relative-filter-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/relative-filter-policy.ts)는 planner-to-retrieval input, candidate-level constraint evidence, anchor-conditioned filter policy를 이미 구분한다
- [ranked-result.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranked-result.ts), [ranking-input.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-input.ts), [ltr-ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-ranker.ts)는 `finalScore != calibrated confidence` 경계와 retrieval-to-ranking contract, production LTR rerank/blend seam를 이미 고정한다
- [source-trust-profile.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/model/source-trust-profile.ts), [identity-signature.service.ts](/Users/songmin/wine-search-engine/src/domain/entity/service/identity-signature.service.ts), [pg-entity-repository.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-entity-repository.ts)는 source trust, validated identity signature, concrete entity repository까지 catalog foundation을 더 깊게 뒷받침한다
- [feedback-store.port.ts](/Users/songmin/wine-search-engine/src/domain/learning/port/feedback-store.port.ts), [pg-feedback-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-feedback-store.ts), [proposal-store.port.ts](/Users/songmin/wine-search-engine/src/domain/learning/port/proposal-store.port.ts), [pg-threshold-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-threshold-store.ts)는 feedback/proposal/threshold persistence seam를 이미 productized 해둔다
- [alias-repository.port.ts](/Users/songmin/wine-search-engine/src/domain/alias/port/alias-repository.port.ts), [transliterator.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/transliterator.ts), [blocking.port.ts](/Users/songmin/wine-search-engine/src/domain/resolver/port/blocking.port.ts), [pg-blocking-adapter.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-blocking-adapter.ts)는 alias storage, multilingual transliteration, blocking recall contract/adapter까지 exact/noisy match plane를 더 완성한다

즉 마지막까지 더 털어봐도 남는 메시지는 같다.  
중심 과제는 **새 stack 추가**가 아니라, 이미 있는 input/output/persistence/policy seam를 runtime SSOT와 lane policy table 아래로 정렬하는 일이다.

---

## 14. 우리 상황에서 추가로 꼭 넣어야 할 보완 축

현재 레포 상황을 고려하면, 아래는 “좋으면 좋은 것”이 아니라 실제로 빠지면 나중에 다시 크게 돌아오게 될 보완점이다.

### 14.1 Policy table을 코드보다 먼저 문서화해야 한다

현재는 분산된 if문과 profile, gate, weights가 섞여 있다.  
새 작업을 시작하기 전에 최소한 아래 표는 문서 SSOT로 먼저 고정해야 한다.

- query taxonomy -> lane mix
- query taxonomy -> candidate budget
- query taxonomy -> CE/LTR gate
- query taxonomy -> explanation obligation
- query taxonomy -> eval slice

이 표가 먼저 없으면 구현이 또 분산된다.

### 14.2 “derived views”와 “source contracts”를 구분해야 한다

현재는 intent/class/family/mode가 같이 source of truth처럼 쓰인다.  
앞으로는 반드시 아래처럼 나눠야 한다.

- source contract: canonical query schema
- derived view: observability family
- derived view: routing mode
- derived view: scoring class

이걸 구분하지 않으면 다음 모델/feature 추가 때 또 drift가 생긴다.

### 14.3 ranking signal vocabulary를 고정해야 한다

지금도 componentScores/evidence/eval signal 이름이 부분적으로 어긋난다.  
앞으로는 아래 vocabulary를 먼저 고정하는 게 좋다.

- retrieval score family
- constraint score family
- rerank score family
- business score family
- quality score family
- explanation evidence family

이 vocabulary가 없으면 LTR, CE, response, eval이 계속 따로 논다.

### 14.4 “도입할 것”보다 “언제 안 쓸 것”을 같이 정의해야 한다

SOTA++ 시스템에서 중요한 건 좋은 모델을 넣는 것만이 아니다.

- late interaction을 언제 안 켤지
- CE를 언제 끌지
- explanation을 언제 생략할지
- recommendation을 언제 abstain할지

즉 fail-open보다 **safe backoff 정책**을 먼저 정의해야 한다.

### 14.5 migration-safe 구조를 의도적으로 만들어야 한다

현재 레포는 테스트와 계약이 강한 만큼, 오히려 migration-safe 설계가 중요하다.

권장 원칙:

- public API는 마지막에 바꾼다
- internal execution contract를 먼저 고정한다
- lane / gate / ranking은 adapter seam 뒤에서 교체 가능하게 만든다
- eval slice를 먼저 만들고 feature를 붙인다

---

## 15. 추가 한 줄 결론

현재 엔진의 주된 갭은 여전히 `공식 taxonomy + 다신호 routing/gating + lane/funnel 통합`이 맞다.  
다만 SOTA++ 대비 진짜로 오래 가는 엔진을 만들려면, 여기에 더해 아래를 같이 챙겨야 한다.

- catalog quality gating
- session/context continuation
- commerce-grade offer/inventory awareness
- hard-negative/teacher-student learning loop
- decomposition and constraint repair
- diversity/coverage control
- explanation faithfulness gate
- multilingual semantic robustness

이 항목들까지 문서에 남겨둬야, 이후 작업이 retrieval 모델 교체에만 매몰되지 않고 실제 상한선 구조로 간다.
