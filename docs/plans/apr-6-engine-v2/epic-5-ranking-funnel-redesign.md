# Epic 5: Ranking Funnel Redesign

**성격:** must  
**목표:** 현재 ranker/rerank/LTR scaffold를 stage-based ranking funnel로 재구성한다.  
**의존성:** Epic 3, Epic 4

---

## 왜 필요한가

현재 [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)는 이미 상당히 잘 짜여 있다.  
하지만 앞으로 provenance-rich candidate, learned sparse, relative retrieval를 넣으면 “한 ranker가 다 아는” 방식은 오래 못 간다.

이 epic은 ranking을 더 똑똑하게 만드는 동시에, 더 분해 가능한 구조로 바꾸는 작업이다.

---

## 목표 상태

```text
Stage A: coarse pruning
Stage B: channel-aware primary rank
Stage C: selective precision rerank
Stage D: policy insertion point / contract separation
```

---

## 레포에서 건드리는 축

- [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)
- [signal-computer.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/signal-computer.ts)
- [score-aggregator.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/score-aggregator.ts)
- [ltr-feature-extractor.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-feature-extractor.ts)
- [lambdamart-ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/lambdamart-ranker.ts)
- [search-usecase-ltr-rerank.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-ltr-rerank.ts)
- [search-usecase-hybrid-ranking-pipeline.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-ranking-pipeline.ts)
- [ranked-result.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranked-result.ts)

---

## In Scope

- stage-based ranking contract
- provenance-aware features
- selective rerank policy
- relevance vs policy separation
- stage-aware eval reporting

### Public surface rule

이 epic은 ranking 내부 contract를 재정의하는 단계다.  
public HTTP response migration은 Epic 6에서만 공식 도입한다.

## Out Of Scope

- user personalization
- full API redesign
- index projection rewrite

---

## 핵심 작업

### Step 1. Ranking stage contract 정의

각 단계의 입력/출력을 타입과 메트릭으로 분리한다.

### Step 2. Provenance-aware features 확장

channel id, matched query view, anchor-conditioned signals, relative signals를 ranking features로 공식 편입한다.

현재 코드 기준으로는 provenance-aware signal이 [signal-computer.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/signal-computer.ts) 계산 로직, [ranked-result.ts](/Users/songmin/wine-search-engine/src/domain/ranking/model/ranked-result.ts)의 `ComponentScores`, [ltr-feature-extractor.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-feature-extractor.ts)의 `LTRScoreComponents`, [lambdamart-ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/lambdamart-ranker.ts)의 `RankingFeatures`로 나뉘어 있다.  
따라서 `T5.3`은 signal 하나 추가하는 티켓이 아니라, 이 네 계약 중 어디가 SSOT인지 명시하고 train/serve skew 없이 같이 움직이게 하는 티켓으로 정의한다.

### Step 3. Selective rerank 정책화

모든 쿼리에 똑같이 cross-encoder/LTR를 태우지 않고, query family별 precision stage를 차등 적용한다.

현재 코드에는 [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts) 내부 rerank seam과 [search-usecase-ltr-rerank.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-ltr-rerank.ts) post-rank LTR seam이 둘 다 있다.  
따라서 `T5.4`는 "rerank를 하나 더 추가"하는 작업이 아니라, 이중 rerank 구조의 ownership을 정리하고 stage SSOT를 하나로 만드는 작업으로 정의한다.

### Step 4. Policy hook separation

current entity-only engine에서 relevance score와 downstream policy insertion point를 분리한다.  
이 단계의 목표는 full product-policy stage가 아니라, **policy를 꽂을 수 있는 contract boundary**를 만드는 것이다.

### Step 5. Offer-aware policy rank after projection boundary

offer / availability / promotion-aware policy rank는 [epic-7-index-projection-migration.md](/Users/songmin/wine-search-engine/docs/plans/apr-6-engine-v2/epic-7-index-projection-migration.md)에서 projection boundary가 정의된 뒤에 연결한다.

### Step 6. Stage metrics / explainability

각 stage에서 어떤 후보가 탈락하고 어떤 signal이 승격에 기여했는지 분석 가능한 메트릭을 남긴다.

### Step 7. Offline counterfactual eval 연동

stage-based ranking 변경 효과를 offline counterfactual evaluation으로 측정한다.  
online A/B interleaving은 v2 scope 밖이지만, offline eval에서 stage 단위 영향 분석은 이 epic에서 수행한다.

---

## LLM Execution Guide

이 epic은 `ranker.ts`, `score-aggregator.ts`, `ltr-feature-extractor.ts`가 핵심 hotspot이다.  
따라서 "stage contract", "coarse pruning", "primary rank features", "rerank policy", "policy seam", "observability/eval"을 한 PR에 섞지 않는 것이 기본 원칙이다.

### Recommended PR slices

| Task | 닫는 기준 | Must change | Must not change |
|---|---|---|---|
| T5.1 | ranking stage type이 생기고 pipeline이 coarse/primary/rerank/policy seam을 코드상 표현 | new `ranking-stage.ts`, `ranking-input.ts`, `ranker.ts`, `ranking-stage-pipeline.ts`, `search-usecase-hybrid-ranking-pipeline.ts`, ranked result contract | scoring retune, eval script 개편, public response |
| T5.2 | coarse pruning이 명시적 stage가 되고 탈락 이유가 ranker 내부에서 구분 가능 | `ranker.ts`, `score-aggregator.ts`, ranked result metadata, unit tests | rerank gating, channel feature vocabulary |
| T5.3 | channel id, query view, anchor/relative provenance가 primary ranking signal로 편입 | `ranked-result.ts`, `signal-computer.ts`, `score-aggregator.ts`, `ltr-feature-extractor.ts`, `lambdamart-ranker.ts`, signal tests | rerank threshold policy, offer-aware policy |
| T5.4 | selective rerank가 query family별로 제어되고 search pipeline에서 독립된 precision stage로 호출 | `search-usecase-ltr-rerank.ts`, `search-usecase-hybrid-ranking-pipeline.ts`, `ranker.ts`, `ltr-feature-extractor.ts`, `ltr-ranker.ts`, reranker port | coarse pruning semantics, policy hook contract |
| T5.5a | relevance score와 policy insertion point가 별도 seam으로 노출 | `ranker.ts`, `ranking-stage-pipeline.ts`, `ranking-policy.port.ts`, ranked result contract, hybrid ranking pipeline glue | offer/projection policy, public V2 explain |
| T5.6 | stage별 drop/promote reason과 explain metrics가 logs/eval result에서 보임 | `ranker.ts`, search log schema, eval result schema | retrieval channel mix, ranking score formula |
| T5.7 | counterfactual eval이 stage-aware delta를 계산하고 baseline 비교가 가능 | eval runner/store/services, offline eval scripts, metrics/significance helpers | online serving behavior, HTTP response contract |

### Hotspot ownership

- `T5.1` owns ranking stage vocabulary. 뒤 task는 새 stage 이름을 임의로 늘리지 않고 이 vocabulary를 따라야 한다.
- `T5.1`은 [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts)까지 포함해 닫아야 한다. model/type만 만들고 실제 pipeline trace owner를 안 바꾸면 "문서상 stage"만 생기고 runtime seam은 여전히 불명확하다.
- `T5.2`는 prune semantics만 다룬다. feature 확장이나 rerank dispatch를 같이 넣지 않는다.
- `T5.3`은 primary rank feature SSOT만 다룬다. provenance-aware feature를 ad-hoc metadata로 숨기지 말고 `ComponentScores` / `LTRScoreComponents` / `RankingFeatures` 중 어디까지 올릴지 명시적으로 고정한다. rerank on/off 정책은 `T5.4`로 넘긴다.
- `T5.4`는 precision stage dispatch만 다룬다. current code의 `ranker.ts` inline rerank와 `search-usecase-ltr-rerank.ts` post-rank rerank 중 어느 쪽이 stage SSOT인지 이 티켓에서 정리하고, rerank 이후 `finalScore` / `rank`를 누가 최종적으로 mutate하는지도 하나로 고정한다. chosen owner 바깥에서 [search-usecase-hybrid-ranking-pipeline.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-ranking-pipeline.ts)가 결과 순서를 다시 바꾸면 미완료다. offer-aware policy나 projection dependency를 앞당기지 않는다.
- `T5.5a`는 policy seam만 만든다. 실제 policy rank는 `T5.5b`와 Epic 7 이후 follow-on이다. [ranking-policy.port.ts](/Users/songmin/wine-search-engine/src/domain/ranking/port/ranking-policy.port.ts)와 [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts)가 owner이며, `ranker.ts` 안에 business policy를 다시 숨기지 않는다.
- `T5.6`과 `T5.7`은 scoring behavior를 바꾸지 않는다. 관측 vocabulary와 evaluation capability를 붙이는 작업으로 제한한다.

### Mechanical execution rules

- `T5.1` 이후 stage trace owner는 [ranking-stage-pipeline.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranking-stage-pipeline.ts)로 본다. 이후 티켓이 stage-level observability를 추가할 때 `ranker.ts` 내부 private state만 늘리고 pipeline trace를 안 맞추면 실패다.
- `T5.4`는 rerank implementation을 둘 다 살려둘 수는 있어도, 최종 `finalScore` / `rank` mutation owner는 정확히 하나로 줄여야 한다. 다른 쪽은 no-op wrapper 또는 feature provider로만 남겨야 한다.
- `T5.5a`는 policy seam을 만든 뒤에도 relevance baseline order를 재현할 수 있어야 한다. policy 미주입 상태에서 output order가 달라지면 실패다.

### Required verification by slice

- Contract/stage slices: `npm run typecheck`, `npm run test:unit`
- Ranking behavior slices: `npm run test:unit`, `npm run test:quality`
- Rerank dispatch slices: `npm run test:integration:search-pipeline`, `npm run test:quality`
- Observability/eval slices: `npm run test:quality`, `npm run eval:offline:with-splits`

---

### 브레이킹 표면

- ranker.ts stage interface 전면 변경
- signal-computer.ts feature contract 확장
- score-aggregator.ts aggregation 분기
- ltr-feature-extractor.ts feature set 변경
- search-usecase-ltr-rerank.ts rerank dispatch 로직

---

## 설계 원칙

1. ranking은 retrieval의 실수를 감추는 블랙박스가 아니다.
2. stage는 각각 독립적으로 측정 가능해야 한다.
3. policy와 relevance는 구분한다.
4. LTR는 provenance 없는 feature 위에서 학습하지 않는다.

---

## 완료 기준

- ranking stage별 입력/출력이 명시된다.
- channel/provenance feature가 ranking SSOT에 포함된다.
- rerank 비용이 query-dependent policy로 제어된다.
- offline eval이 stage-aware 분석을 제공한다.
- offline counterfactual eval이 stage 단위 영향 분석을 제공한다.
- current entity-only engine 기준 policy insertion point가 분리된다.

## 검증 전략

- ranker unit tests
- stage transition tests
- LTR feature contract tests
- offline counterfactual eval pipeline 실행
- quality/nightly eval slice
