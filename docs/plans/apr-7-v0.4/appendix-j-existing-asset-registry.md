# Appendix J: Existing Asset Registry

이 문서는 `apr-7-v0.4` 전체에서 가장 실무적인 용도의 레지스트리다.  
목적은 하나다.

> **앞으로 SOTA++ 방향으로 갈 때, 무엇을 재사용하고 무엇을 승격하고 무엇을 얇게 남기고 무엇을 나중에 제거할지 한 번에 보이게 만든다.**

이 문서의 분류는 아래 4개만 쓴다.

- `reuse`
  지금도 runtime/contract asset로 충분히 의미가 있다. 새로 만들지 말고 그대로 재사용.
- `promote`
  이미 자산은 있으나 정책 SSOT 또는 1급 runtime currency로 승격해야 한다.
- `thin_adapter`
  완전 제거보다 얇은 호환 레이어로 줄이는 게 맞다.
- `remove_later`
  당장은 호환성 때문에 남기되, migration 끝나면 정리 대상이다.

---

## 1. Runtime SSOT and Planner

| Asset | Classification | Why |
| --- | --- | --- |
| [execution-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/execution-compiler.ts) | `promote` | compiled execution contract의 중심이지만 아직 runtime currency가 아님 |
| [query-understanding-snapshot.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-understanding-snapshot.ts) | `promote` | canonical query schema의 바탕이 됨 |
| [query-observability-vocab.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-observability-vocab.ts) | `promote` | queryFamily/decomposition/uncertainty를 already-derived taxonomy view로 제공 |
| [planner.ts](/Users/songmin/wine-search-engine/src/domain/query/service/planner.ts) | `reuse` | contradiction/uncertainty/policy/decomposition source가 이미 풍부함 |
| [policy-compiler.ts](/Users/songmin/wine-search-engine/src/domain/query/service/policy-compiler.ts) | `reuse` | query policy compile asset |
| [constraint-sat.ts](/Users/songmin/wine-search-engine/src/domain/query/service/constraint-sat.ts) | `reuse` | contradiction/clarify early gate |
| [query-uncertainty.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-uncertainty.ts) | `reuse` | planner uncertainty/risk contract |
| [query-views.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-views.ts) | `reuse` | multi-view normalization contract for noisy lookup |
| [query-lookup-provenance.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-lookup-provenance.ts) | `reuse` | shared query lookup provenance contract |
| [anchor-candidate.ts](/Users/songmin/wine-search-engine/src/domain/query/model/anchor-candidate.ts) | `reuse` | anchor confidence + lookup provenance seam |
| [rule-based-constraint-extractor.ts](/Users/songmin/wine-search-engine/src/domain/query/service/rule-based-constraint-extractor.ts) | `reuse` | mapping-table miss fallback constraint seam |
| [ambiguity-dictionary.port.ts](/Users/songmin/wine-search-engine/src/domain/query/port/ambiguity-dictionary.port.ts) | `reuse` | known ambiguity lookup contract |
| [planner-v1-adapter.ts](/Users/songmin/wine-search-engine/src/config/planner-v1-adapter.ts) | `remove_later` | V1 currency 호환용 |
| [search-pipeline-deps.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-pipeline-deps.port.ts) | `thin_adapter` | planner/ranker port는 유지하되 V1 shape 의존은 줄여야 함 |

---

## 2. Retrieval and Lane Policy

| Asset | Classification | Why |
| --- | --- | --- |
| [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts) | `reuse` | hybrid/lane assembly core |
| [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts) | `promote` | lane policy table engine로 승격 가치 큼 |
| [channel-mix-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/channel-mix-policy.ts) | `promote` | taxonomy-aware mix policy의 기반 |
| [search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts) | `thin_adapter` | retrieval input wiring을 compiler-driven으로 줄여야 함 |
| [retrieval-input.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-input.ts) | `promote` | planner-to-retrieval runtime input contract |
| [hybrid-candidate.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/hybrid-candidate.ts) | `thin_adapter` | legacy/runtime candidate currency라 migration 경계가 중요함 |
| [retrieval-trace.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-trace.ts) | `reuse` | per-candidate retrieval diagnostic trace |
| [candidate-assembly.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-assembly.ts) | `reuse` | hard-filter/quota/protected-recall assembly seam |
| [hybrid-candidate-summary.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/hybrid-candidate-summary.ts) | `reuse` | retrieval hit summary normalization/merge SSOT |
| [candidate-constraint-evidence.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-constraint-evidence.ts) | `reuse` | candidate-level hard/soft constraint evidence seam |
| [constraint-filter.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/constraint-filter.ts) | `reuse` | post-retrieval hard-filter enforcement seam |
| [constraint-to-sparse-filter-tokens.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/constraint-to-sparse-filter-tokens.ts) | `reuse` | planner constraint -> sparse filter token seam |
| [browse-retriever.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/browse-retriever.ts) | `reuse` | specialized lane asset |
| [compare-retriever.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/compare-retriever.ts) | `reuse` | comparison/substitute lane asset |
| [fusion.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/fusion.ts) | `reuse` | RRF/merge baseline |
| [evidence-accumulator.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/evidence-accumulator.ts) | `reuse` | cross-channel candidate evidence merge seam |
| [relative-filter-policy.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/relative-filter-policy.ts) | `reuse` | anchor-conditioned relative filter policy seam |
| [trace-vocab-aligner.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/trace-vocab-aligner.ts) | `reuse` | runtime/eval vocab SSOT |
| [candidate-envelope.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/candidate-envelope.ts) | `promote` | richer candidate provenance contract로 승격 가치 큼 |

---

## 3. Ranking, Gate, Calibration

| Asset | Classification | Why |
| --- | --- | --- |
| [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts) | `thin_adapter` | LTR/CE/gate/signal 책임이 너무 많음 |
| [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts) | `reuse` | staged ranking outer seam |
| [default-ranking-policy.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/default-ranking-policy.ts) | `reuse` | diversity/truncation policy hook |
| [rerank-gate.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/rerank-gate.ts) | `promote` | multi-signal calibrated gate로 키워야 함 |
| [ranking-input.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-input.ts) | `promote` | retrieval-to-ranking runtime input contract |
| [ranked-result.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranked-result.ts) | `reuse` | finalScore vs calibrated-confidence boundary contract |
| [ltr-feature-extractor.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-feature-extractor.ts) | `reuse` | inference/training feature mapping SSOT |
| [lambdamart-ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/lambdamart-ranker.ts) | `reuse` | learned ranking model scoring seam |
| [ltr-ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-ranker.ts) | `reuse` | production rerank/blend/shift measurement seam |
| [wine-attribute-encoder.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/wine-attribute-encoder.ts) | `reuse` | categorical ranking feature encoder seam |
| [wine-attribute-vocabulary.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/wine-attribute-vocabulary.ts) | `reuse` | feature vocabulary/OOV guardrail contract |
| [funnel-metrics.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/funnel-metrics.ts) | `reuse` | ranking funnel observability |
| [ranking-runtime-signal.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranking-runtime-signal.ts) | `reuse` | degraded/authoritative runtime signal |
| [evidence-mapper.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/evidence-mapper.ts) | `reuse` | ranking evidence surface canonical mapping |
| [calibration-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/calibration-evaluator.ts) | `reuse` | ECE/per-class calibration audit |
| [pg-calibration-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-calibration-store.ts) | `reuse` | calibration persistence seam |
| [calibrator.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/calibrator.ts) | `reuse` | calibrated confidence semantics already present |
| [pipeline-debug-steps.ts](/Users/songmin/wine-search-engine/src/observability/pipeline-debug-steps.ts) | `reuse` | canonical pipeline debug step vocabulary |
| [request-pipeline-debug.ts](/Users/songmin/wine-search-engine/src/observability/request-pipeline-debug.ts) | `reuse` | request-scoped pipeline debug context seam |
| [log-search-event.ts](/Users/songmin/wine-search-engine/src/observability/log-search-event.ts) | `reuse` | authority/snapshot decode-enriched search logging seam |

---

## 4. Decision, Evidence, Abstention

| Asset | Classification | Why |
| --- | --- | --- |
| [decision-engine.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/decision-engine.ts) | `reuse` | decision authority core |
| [decision-input.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-input.ts) | `reuse` | rich evidence semantics |
| [decision-output.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-output.ts) | `reuse` | internal authority contract |
| [evidence-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/evidence-gate.ts) | `reuse` | evidence obligation gate |
| [abstain-policy.ts](/Users/songmin/wine-search-engine/src/domain/query/service/abstain-policy.ts) | `reuse` | low-confidence/admission semantics asset |
| [engine-decision.ts](/Users/songmin/wine-search-engine/src/domain/response/model/engine-decision.ts) | `reuse` | external confidence/trace contract |
| [authority-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/authority-trace.ts) | `reuse` | audit/replay authority id |
| [decision-trace.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/decision-trace.ts) | `reuse` | complete decision diagnostic trace contract |
| [snapshot-store.port.ts](/Users/songmin/wine-search-engine/src/domain/decision/port/snapshot-store.port.ts) | `reuse` | reproducibility snapshot persistence seam |
| [admission-gate.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/admission-gate.ts) | `reuse` | final closure safety and snapshot seal gate |
| [admission-policy.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/admission-policy.ts) | `reuse` | allow/clarify/reject decision policy primitive |
| [id-schema-decoder.ts](/Users/songmin/wine-search-engine/src/domain/decision/service/id-schema-decoder.ts) | `reuse` | authority/snapshot/batch id decode seam |
| [id-schema-version.ts](/Users/songmin/wine-search-engine/src/domain/decision/model/id-schema-version.ts) | `reuse` | stable id schema version constants |
| [decision-snapshot.ts](/Users/songmin/wine-search-engine/src/domain/shared/types/decision-snapshot.ts) | `reuse` | typed reproducibility snapshot contract |
| [hash.ts](/Users/songmin/wine-search-engine/src/domain/shared/utils/hash.ts) | `reuse` | deterministic hash utility for trace/snapshot/batch ids |
| `ranked-route calibrator` | `promote` | 아직 synthetic confidence를 대체할 dedicated module이 필요 |

---

## 5. Response, Explanation, Transparency

| Asset | Classification | Why |
| --- | --- | --- |
| [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts) | `reuse` | no-evidence guard, grouped projection, meta propagation |
| [human-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/human-response-builder-v2.ts) | `promote` | actual human V2 response contract로 승격 후보 |
| [machine-response-builder-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/service/machine-response-builder-v2.ts) | `reuse` | machine response surface already productized |
| [interpret-explain-adapter-v2.ts](/Users/songmin/wine-search-engine/src/application/search/interpret-explain-adapter-v2.ts) | `reuse` | stable explain V2 adapter |
| [result-grouper.ts](/Users/songmin/wine-search-engine/src/domain/response/service/result-grouper.ts) | `reuse` | grouped exploration surface |
| [clarification.ts](/Users/songmin/wine-search-engine/src/domain/response/model/clarification.ts) | `reuse` | disambiguation payload contract |
| [counterfactual.ts](/Users/songmin/wine-search-engine/src/domain/response/model/counterfactual.ts) | `reuse` | transparency/fallback payload contract |
| [search-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/search-response.ts) | `reuse` | SearchResponseV1 SSOT output |
| [result-item-v2.ts](/Users/songmin/wine-search-engine/src/domain/response/model/result-item-v2.ts) | `reuse` | canonical V2 type alias seam |
| [search-v2.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search-v2.route.ts) | `thin_adapter` | V1 projection 중심에서 V2 native contract로 점진 이동 필요 |

---

## 6. Usecase Graph and Composition Root

| Asset | Classification | Why |
| --- | --- | --- |
| [container-core.ts](/Users/songmin/wine-search-engine/src/config/container-core.ts) | `reuse` | core composition root |
| [container-core-builders.ts](/Users/songmin/wine-search-engine/src/config/container-core-builders.ts) | `reuse` | service assembly seam |
| [container-usecases.ts](/Users/songmin/wine-search-engine/src/config/container-usecases.ts) | `reuse` | usecase graph root |
| [container-features.ts](/Users/songmin/wine-search-engine/src/config/container-features.ts) | `reuse` | feature aggregation seam |
| [container.ts](/Users/songmin/wine-search-engine/src/config/container.ts) | `reuse` | top-level container |
| [container-runtime-support.ts](/Users/songmin/wine-search-engine/src/config/container-runtime-support.ts) | `reuse` | sanitizer/cache/LTR/predictor support init |
| [container-adapters.ts](/Users/songmin/wine-search-engine/src/config/container-adapters.ts) | `reuse` | infra adapter + production guard |
| [container-aux-features.ts](/Users/songmin/wine-search-engine/src/config/container-aux-features.ts) | `reuse` | tool/eval feature seam |
| [container-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-contracts.ts) | `reuse` | contract surface composition root |
| [container-search-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-search-contracts.ts) | `reuse` | search contract registration root |
| [container-watchlist-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-watchlist-contracts.ts) | `reuse` | watchlist contract registration root |
| [container-stubs.ts](/Users/songmin/wine-search-engine/src/config/container-stubs.ts) | `reuse` | explicit stub fallback seam |
| [env.ts](/Users/songmin/wine-search-engine/src/config/env.ts) | `reuse` | runtime config/env SSOT |
| [readiness.ts](/Users/songmin/wine-search-engine/src/config/readiness.ts) | `reuse` | readiness probe composition seam |
| [decomposed-search-adapter.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search-adapter.ts) | `reuse` | cycle breaker seam |

---

## 7. Request/Route/Contract Surface

| Asset | Classification | Why |
| --- | --- | --- |
| [search-route-usecases.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-route-usecases.port.ts) | `reuse` | entrypoint contract catalog |
| [search-executor.port.ts](/Users/songmin/wine-search-engine/src/application/search/port/search-executor.port.ts) | `reuse` | execute + executeForEvaluation surface |
| [hybrid-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid-request.dto.ts) | `reuse` | hybrid request contract |
| [interpret-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/interpret-request.dto.ts) | `reuse` | interpret request contract |
| [resolve-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/resolve-request.dto.ts) | `reuse` | resolve request contract |
| [replay-request.dto.ts](/Users/songmin/wine-search-engine/src/application/search/replay-request.dto.ts) | `reuse` | replay request contract |
| [search-request-mappers.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search-request-mappers.ts) | `reuse` | HTTP schema -> app DTO boundary seam |
| [search-request.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-request.schema.ts) | `reuse` | request schema SSOT |
| [search-shared.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-shared.schema.ts) | `reuse` | shared request schema building blocks |
| [search-response.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response.schema.ts) | `reuse` | response schema SSOT |
| [route-deps.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-deps.ts) | `reuse` | HTTP dependency SSOT |
| [route-contracts.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/route-contracts.ts) | `reuse` | declared route contract SSOT |
| [http-route-contract-catalog.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-catalog.ts) | `reuse` | declared manifest |
| [register-contract-route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/register-contract-route.ts) | `reuse` | runtime route registry/manifest |
| [contract-response.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/contract-response.ts) | `reuse` | contract-safe parse/send seam |
| [http-route-contract-openapi.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/http-route-contract-openapi.ts) | `reuse` | OpenAPI bridge |
| [search.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/search.route.ts) | `reuse` | standardized contract-route handler pattern |
| [hybrid.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/hybrid.route.ts) | `reuse` | standardized contract-route handler pattern |
| [interpret.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/interpret.route.ts) | `reuse` | standardized contract-route handler pattern |
| [resolve.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/resolve.route.ts) | `reuse` | standardized contract-route handler pattern |
| [replay.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/replay.route.ts) | `reuse` | standardized contract-route handler pattern |
| [health.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/health.route.ts) | `reuse` | liveness/readiness contract surface |
| [claude-tools.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/claude-tools.route.ts) | `reuse` | machine/tool route surface |
| [tool-schemas.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/tool-schemas.ts) | `reuse` | Claude tool schema contract SSOT |
| [request-id.ts](/Users/songmin/wine-search-engine/src/interface/http/request-id.ts) | `reuse` | request/correlation id normalization seam |
| [request-context.ts](/Users/songmin/wine-search-engine/src/interface/http/middleware/request-context.ts) | `reuse` | request context + latency logging seam |
| [http-debug-mode.ts](/Users/songmin/wine-search-engine/src/interface/http/middleware/http-debug-mode.ts) | `reuse` | per-request debug activation seam |
| [error-handler.ts](/Users/songmin/wine-search-engine/src/interface/http/middleware/error-handler.ts) | `reuse` | global HTTP error routing seam |
| [snake-case-hook.ts](/Users/songmin/wine-search-engine/src/interface/http/middleware/snake-case-hook.ts) | `reuse` | camelCase -> snake_case boundary seam |
| [error-response.ts](/Users/songmin/wine-search-engine/src/interface/http/errors/error-response.ts) | `reuse` | shared error response builder/sender |
| [policy-blocked.ts](/Users/songmin/wine-search-engine/src/interface/http/errors/policy-blocked.ts) | `reuse` | security audit/policy-blocked response seam |
| [retry-after-from-rate-limit-message.ts](/Users/songmin/wine-search-engine/src/interface/http/retry-after-from-rate-limit-message.ts) | `reuse` | rate-limit Retry-After derivation seam |
| [server.ts](/Users/songmin/wine-search-engine/src/interface/http/server.ts) | `reuse` | exposed surface registration SSOT |
| [container-tool-contracts.ts](/Users/songmin/wine-search-engine/src/config/container-tool-contracts.ts) | `reuse` | tool execution contract |

---

## 8. Learning, Replay, Rollout

| Asset | Classification | Why |
| --- | --- | --- |
| [feedback-processor.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/feedback-processor.ts) | `reuse` | feedback ingestion semantics |
| [feedback-store.port.ts](/Users/songmin/wine-search-engine/src/domain/learning/port/feedback-store.port.ts) | `reuse` | feedback persistence contract |
| [proposal-store.port.ts](/Users/songmin/wine-search-engine/src/domain/learning/port/proposal-store.port.ts) | `reuse` | proposal persistence contract |
| [feedback-signal.ts](/Users/songmin/wine-search-engine/src/domain/learning/model/feedback-signal.ts) | `reuse` | learning-loop audit signal contract |
| [alias-proposal.ts](/Users/songmin/wine-search-engine/src/domain/learning/model/alias-proposal.ts) | `reuse` | alias proposal lifecycle contract |
| [drift-signal.ts](/Users/songmin/wine-search-engine/src/domain/learning/model/drift-signal.ts) | `reuse` | drift detector output contract |
| [threshold-optimizer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/threshold-optimizer.ts) | `reuse` | threshold proposal engine |
| [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts) | `reuse` | promotion gate asset |
| [alias-proposer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/alias-proposer.ts) | `reuse` | alias proposal loop |
| [drift-detector.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/drift-detector.ts) | `reuse` | online distribution/model drift monitor seam |
| [feedback-ttl-enforcer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/feedback-ttl-enforcer.ts) | `reuse` | feedback retention/privacy governance seam |
| [pg-feedback-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-feedback-store.ts) | `reuse` | feedback persistence adapter seam |
| [pg-threshold-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-threshold-store.ts) | `reuse` | threshold profile persistence adapter |
| [pg-proposal-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-proposal-store.ts) | `reuse` | proposal persistence |
| [container-learning.ts](/Users/songmin/wine-search-engine/src/config/container-learning.ts) | `reuse` | learning services root |
| [feedback.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/feedback.route.ts) | `reuse` | learning ingest surface |
| [replay.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/replay.usecase.ts) | `reuse` | snapshot/replay determinism gate |
| [pg-gold-set-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-gold-set-store.ts) | `reuse` | eval gold-set persistence |
| [pg-eval-result-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-eval-result-store.ts) | `reuse` | eval result persistence |
| [eval-runner.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/eval-runner.ts) | `reuse` | EvalReport/release gate export core |
| [domain/evaluation/index.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/index.ts) | `reuse` | eval export surface |
| [kill-switch-policy.ts](/Users/songmin/wine-search-engine/src/config/kill-switch-policy.ts) | `reuse` | declarative rollout/degrade seam |
| `rollout governor` | `promote` | existing pieces를 하나로 묶는 상위 governor 필요 |

---

## 9. Specialized and Side-effect Runtime

| Asset | Classification | Why |
| --- | --- | --- |
| [mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts) | `reuse` | mixed/substitute specialized seam |
| [anchor-profiler.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/anchor-profiler.ts) | `reuse` | anchor quality/profile seam |
| [watchlist.service.ts](/Users/songmin/wine-search-engine/src/application/watchlist/watchlist.service.ts) | `reuse` | watchlist service seam |
| [watchlist-policy.ts](/Users/songmin/wine-search-engine/src/domain/watchlist/service/watchlist-policy.ts) | `reuse` | watchlist trigger/event eligibility policy |
| [container-watchlist.ts](/Users/songmin/wine-search-engine/src/config/container-watchlist.ts) | `reuse` | watchlist composition root |
| [watchlist-delivery-runtime.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/watchlist-delivery-runtime.ts) | `reuse` | side-effect runtime loop |
| [webhook-delivery.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/webhook-delivery.ts) | `reuse` | webhook retry/HMAC/timeout delivery seam |
| [redis-watchlist-subscriber.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/redis-watchlist-subscriber.ts) | `reuse` | dedicated pub/sub subscriber seam |
| [redis-watchlist-publisher.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/redis-watchlist-publisher.ts) | `reuse` | lazy Redis publish seam |
| [runtime-handles.ts](/Users/songmin/wine-search-engine/src/config/runtime-handles.ts) | `reuse` | managed runtime lifecycle |

---

## 10. Catalog, Projection, and Data Foundation

| Asset | Classification | Why |
| --- | --- | --- |
| [entity-repository.port.ts](/Users/songmin/wine-search-engine/src/domain/entity/port/entity-repository.port.ts) | `reuse` | entity persistence + snapshot/rollback seam |
| [entity-event.port.ts](/Users/songmin/wine-search-engine/src/domain/entity/port/entity-event.port.ts) | `reuse` | entity change event contract |
| [projection-builder.ts](/Users/songmin/wine-search-engine/src/domain/entity/service/projection-builder.ts) | `reuse` | alias-tier retrieval projection seam |
| [identity-signature.service.ts](/Users/songmin/wine-search-engine/src/domain/entity/service/identity-signature.service.ts) | `reuse` | validated identity signature SSOT |
| [merge.service.ts](/Users/songmin/wine-search-engine/src/domain/entity/service/merge.service.ts) | `reuse` | entity merge governance seam |
| [ontology-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/attribute/service/ontology-normalizer.ts) | `reuse` | authoritative ontology normalization seam |
| [field-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/field-normalizer.ts) | `reuse` | locale-aware canonical field normalization seam |
| [canonicalization-candidate.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/model/canonicalization-candidate.ts) | `reuse` | ingestion canonicalization contract |
| [source-trust-profile.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/model/source-trust-profile.ts) | `reuse` | source reliability/trust calibration contract |
| [structured-extractor.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/structured-extractor.ts) | `reuse` | ingestion-side structured extraction seam |
| [entity-matcher.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/entity-matcher.ts) | `reuse` | structural canonical entity matching seam |
| [lineage-store.port.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/port/lineage-store.port.ts) | `reuse` | ingestion lineage persistence contract |
| [lineage-record.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/model/lineage-record.ts) | `reuse` | typed lineage/audit record contract |
| [abuse-detector.ts](/Users/songmin/wine-search-engine/src/domain/ingestion/service/abuse-detector.ts) | `reuse` | ingestion abuse/spam guardrail seam |
| [retrieval-document.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-document.ts) | `reuse` | hit/feature/full-document retrieval contract |
| [pg-entity-repository.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-entity-repository.ts) | `reuse` | concrete entity repository adapter |
| [watchlist-aware-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/watchlist/watchlist-aware-search-index.ts) | `reuse` | catalog event-aware search index seam |
| [drinking-window-predictor.ts](/Users/songmin/wine-search-engine/src/infrastructure/ml/drinking-window-predictor.ts) | `reuse` | catalog-quality enrichment seam |

---

## 11. Performance, Cache, and Inference Plane

| Asset | Classification | Why |
| --- | --- | --- |
| [cache-service.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-service.ts) | `reuse` | unified query/embedding cache governance seam |
| [cache-eligibility.ts](/Users/songmin/wine-search-engine/src/domain/performance/service/cache-eligibility.ts) | `reuse` | explicit cacheability analyzer |
| [cache-policy.ts](/Users/songmin/wine-search-engine/src/domain/cache/cache-policy.ts) | `reuse` | snapshot/contract/model drift cache guardrail |
| [cache-metrics.ts](/Users/songmin/wine-search-engine/src/infrastructure/observability/cache-metrics.ts) | `reuse` | cache performance observability seam |
| [redis-cache.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/redis-cache.ts) | `reuse` | concrete cache storage adapter seam |
| [embedding-service.port.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/port/embedding-service.port.ts) | `reuse` | provider-independent embedding contract |
| [openai-chat-llm.ts](/Users/songmin/wine-search-engine/src/infrastructure/ai/openai-chat-llm.ts) | `reuse` | chat-LLM adapter seam |
| [openai-json.ts](/Users/songmin/wine-search-engine/src/infrastructure/ai/openai-json.ts) | `reuse` | structured JSON LLM adapter helper |
| [openai-embedding-service.ts](/Users/songmin/wine-search-engine/src/infrastructure/ai/openai-embedding-service.ts) | `reuse` | OpenAI-compatible embedding HTTP adapter |
| [cohere-reranker.ts](/Users/songmin/wine-search-engine/src/infrastructure/ai/cohere-reranker.ts) | `reuse` | reranker HTTP adapter with debug instrumentation |
| [drinking-window-predictor.port.ts](/Users/songmin/wine-search-engine/src/domain/drinking-window/port/drinking-window-predictor.port.ts) | `reuse` | predictor abstraction contract |
| [drinking-window-predictor.ts](/Users/songmin/wine-search-engine/src/infrastructure/ml/drinking-window-predictor.ts) | `reuse` | ONNX/heuristic inference seam |

---

## 12. Resolver, Alias, and Entity Match Plane

| Asset | Classification | Why |
| --- | --- | --- |
| [alias-matcher.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/alias-matcher.ts) | `reuse` | multi-stage exact/noisy alias matcher |
| [alias-repository.port.ts](/Users/songmin/wine-search-engine/src/domain/alias/port/alias-repository.port.ts) | `reuse` | alias persistence contract |
| [char-ngram-index.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/char-ngram-index.ts) | `reuse` | fuzzy alias candidate generation primitive |
| [transliterator.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/transliterator.ts) | `reuse` | multilingual/transliteration alias seam |
| [conflict-resolver.ts](/Users/songmin/wine-search-engine/src/domain/alias/service/conflict-resolver.ts) | `reuse` | alias conflict handling seam |
| [ambiguity-classifier.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/ambiguity-classifier.ts) | `reuse` | structured ambiguity typing seam |
| [learned-matcher.port.ts](/Users/songmin/wine-search-engine/src/domain/resolver/port/learned-matcher.port.ts) | `reuse` | learned matcher ML contract |
| [blocking.port.ts](/Users/songmin/wine-search-engine/src/domain/resolver/port/blocking.port.ts) | `reuse` | resolver blocking recall contract |
| [learned-matcher-features.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/learned-matcher-features.ts) | `reuse` | learned matcher feature-vector seam |
| [candidate-scorer.ts](/Users/songmin/wine-search-engine/src/domain/resolver/service/candidate-scorer.ts) | `reuse` | resolver scoring guardrail with alias caps |
| [pg-blocking-adapter.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-blocking-adapter.ts) | `reuse` | concrete resolver blocking adapter |
| [pg-alias-repository.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-alias-repository.ts) | `reuse` | alias persistence and lookup seam |
| [http-learned-matcher.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/http-learned-matcher.ts) | `reuse` | remote learned matcher adapter seam |

---

## 13. Mixed, Substitute, and Comparison Plane

| Asset | Classification | Why |
| --- | --- | --- |
| [similarity-scorer.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/similarity-scorer.ts) | `reuse` | anchor similarity scoring core |
| [anchor-profiler.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/anchor-profiler.ts) | `reuse` | anchor profile/completeness seam |
| [mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts) | `reuse` | mixed/substitute orchestration seam |
| [constraint-overlay.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/constraint-overlay.ts) | `reuse` | post-similarity constraint seam |
| [decomposed-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search.usecase.ts) | `reuse` | comparison decomposition runtime |
| [search-usecase-mixed-route.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-mixed-route.ts) | `reuse` | mixed route execution bridge |

---

## 14. Evaluation, Release, and Learning Loop

| Asset | Classification | Why |
| --- | --- | --- |
| [eval-runner.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/eval-runner.ts) | `reuse` | full offline eval orchestrator with release gates |
| [slice-evaluator.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/slice-evaluator.ts) | `reuse` | slice regression detection seam |
| [utility-scorer.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/utility-scorer.ts) | `reuse` | asymmetric decision utility scoring seam |
| [selective-predictor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/selective-predictor.ts) | `reuse` | coverage-risk tradeoff audit seam |
| [evidence-auditor.ts](/Users/songmin/wine-search-engine/src/domain/evaluation/service/evidence-auditor.ts) | `reuse` | evidence sufficiency audit seam |
| [search-pipeline-evaluator.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/search-pipeline-evaluator.ts) | `reuse` | runtime-to-eval bridge seam |
| [pg-gold-set-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-gold-set-store.ts) | `reuse` | gold-set persistence seam |
| [pg-eval-result-store.ts](/Users/songmin/wine-search-engine/src/infrastructure/adapter/pg-eval-result-store.ts) | `reuse` | eval-result persistence seam |
| [promotion-gate.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/promotion-gate.ts) | `reuse` | shadow-first promotion and slice-regression gate |
| [threshold-optimizer.ts](/Users/songmin/wine-search-engine/src/domain/learning/service/threshold-optimizer.ts) | `reuse` | threshold proposal generation seam |

---

## 15. Batch, Tooling, and Provenance Surface

| Asset | Classification | Why |
| --- | --- | --- |
| [batch-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/batch-search.usecase.ts) | `reuse` | deterministic batch execution seam |
| [batch-search.route.ts](/Users/songmin/wine-search-engine/src/interface/http/routes/batch-search.route.ts) | `reuse` | batch contract route surface |
| [tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/tool-executor.ts) | `reuse` | type-safe machine/tool surface |
| [adaptive-tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/adaptive-tool-executor.ts) | `reuse` | 1-shot mixed fallback seam |
| [comparison-response.ts](/Users/songmin/wine-search-engine/src/domain/response/model/comparison-response.ts) | `reuse` | comparison transport contract |
| [provenance.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/provenance.ts) | `reuse` | canonical runtime/eval provenance vocabulary |
| [drinking-window.usecase.ts](/Users/songmin/wine-search-engine/src/application/drinking-window/drinking-window.usecase.ts) | `reuse` | application bridge from predictor to response block |

---

## 16. Post-route Execution and Response Assembly

| Asset | Classification | Why |
| --- | --- | --- |
| [search-usecase-execute-builders.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-execute-builders.ts) | `reuse` | alternate response param builders |
| [search-usecase-cache-hit.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-cache-hit.ts) | `reuse` | cache-hit response refresh seam |
| [search-usecase-cache-lookup.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-cache-lookup.ts) | `reuse` | cache read guard seam |
| [search-usecase-cache-context.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-cache-context.ts) | `reuse` | request-to-cache-context seam |
| [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts) | `reuse` | shared post-route decision/response seam |
| [search-usecase-map-result-items.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-map-result-items.ts) | `reuse` | ranked result -> ResultItem mapper |
| [search-usecase-decision-input.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-decision-input.ts) | `reuse` | decision input assembler seam |
| [response-builder.ts](/Users/songmin/wine-search-engine/src/domain/response/service/response-builder.ts) | `reuse` | final response assembly seam |

---

## 17. What This Means Operationally

앞으로 구현 원칙은 아래처럼 고정한다.

1. `reuse`는 새로 만들지 않는다.
2. `promote`는 policy/runtime SSOT로 승격한다.
3. `thin_adapter`는 호환성 유지용으로만 줄인다.
4. `remove_later`는 migration 완료 후 정리한다.

즉 앞으로 질문은 “새 모듈을 만들까?”가 아니라 아래 순서여야 한다.

1. 이미 이 역할을 하는 seam가 있는가
2. 있으면 `reuse / promote / thin_adapter / remove_later` 중 어디인가
3. 없을 때만 새 모듈을 만든다

이 레지스트리는 앞으로 `apr-7-v0.4`의 중복개발 방지 기준 문서로 사용한다.
