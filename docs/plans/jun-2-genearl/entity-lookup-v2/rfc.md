# Entity Lookup V2 RFC

> 목적: ROI 무관, breaking change 허용 전제로 wine entity lookup를 `generic search wrapper`가 아니라 `전용 entity resolution system`으로 재구축한다.
>
> Historical / audit-only document.
> Current authority truth moved to `docs/bench/STATUS.md` and
> `tools/feature-catalog/features/retrieval/entity-lookup-v2.yaml`.
> `/v1/lookup/wine` references below preserve pre-cutover design context only.

---

## 1. 문제 정의

현재 `/v1/lookup/wine`는 lookup 전용 스택의 뼈대는 있지만, 여전히 `public primitive search`의 연장선에 있다.

이 구조의 한계:

1. endpoint 진입만으로 entity lane 강제가 된다.
2. concept/facet query와 entity query 경계가 front-door에서 충분히 분리되지 않는다.
3. alias substrate completeness가 lookup 품질의 직접 ceiling인데, 운영/검증 plane이 얇다.
4. candidate generation이 lookup 전용 runtime보다는 search-adjacent substrate에 기대고 있다.
5. resolver fail-close가 short noisy typo class에서 충분히 보수적이지 않다.
6. operator가 entity decision spine을 한 번에 보는 trusted plane이 없다.

lookup를 정말 강하게 만들려면 `public search primitive`를 정교화하는 수준이 아니라, 아래를 별도 스택으로 가져야 한다.

- dedicated contract
- dedicated runtime artifact/index
- dedicated admission/classification
- dedicated candidate retrieval
- dedicated reranker/calibrator
- dedicated curation plane
- dedicated hotset/shadow gate

---

## 2. 목표

1. wine entity lookup를 generic search와 분리된 `lookup V2` runtime으로 승격한다.
2. exact / typo / transliteration / abbreviation / family alias / ambiguity를 explicit model과 substrate로 다룬다.
3. concept query는 resolve 시도 전 gate에서 reject 또는 discovery redirect한다.
4. wrong-positive보다 `ambiguous`/`failed`를 우선하는 calibrated abstain을 기본값으로 둔다.
5. alias/ambiguity/suppression 운영을 staging + publish 기반 write plane으로 관리한다.
6. public cutover 전 shadow compare와 hotset eval로 V1을 능가하는지를 증명한다.

---

## 3. 비목표

- generic product search ranking 자체를 이 RFC에서 재설계
- agent orchestration 개선
- Vespa 전면 교체
- 현재 public `/v1/search/*` retrieval stack 재작성

---

## 4. V2 원칙

1. lookup는 search가 아니다. 전용 contract를 가진 entity resolution task다.
2. public lookup request/response는 primitive search schema를 재사용하지 않는다.
3. entity resolver의 1차 KPI는 recall이 아니라 `precision with calibrated abstain`이다.
4. hot entity는 curated alias와 family graph를 허용한다. provenance와 approval state는 필수다.
5. runtime-plane direct write는 금지한다. staging -> publish -> runtime만 허용한다.
6. operator tooling은 public product surface와 분리된 trusted plane으로 제공한다.
7. cutover는 shadow + hotset + live smoke 없이 하지 않는다.

---

## 5. Target Architecture

### 5.1 Public contract

신규 surface:

- `POST /v2/entity-lookup`

입력:

- `query`
- `locale?`
- `max_candidates?`
- `mode?` only for trusted/internal diagnostics, not public ranking override

출력:

- `status`: `resolved | ambiguous | failed | redirect_discovery`
- `decision_reason`
- `normalized_query_views`
- `candidates[]`
- `top_candidate`
- `clarification_options[]`
- `evidence_summary`

기존 `/v1/lookup/wine`는 transition 동안 shadow adapter로만 유지하고, authority는 `V2`가 가진다.

### 5.2 Runtime pipeline

`query -> admission classifier -> normalized views -> multi-channel retrieval -> candidate union -> learned rerank -> calibrated abstain/clarify -> response`

### 5.3 Data/runtime artifacts

lookup 전용 artifact:

- canonical entity table
- alias registry
- transliteration registry
- abbreviation registry
- family graph
- ambiguity graph
- concept/facet lexicon
- hotset coverage report

이 artifact는 generic search snapshot과 분리되거나, 최소한 별도 manifest/version을 가져야 한다.

### 5.4 Candidate retrieval channels

반드시 독립 채널로 유지:

1. exact normalized alias
2. compact/whitespace-fold exact
3. transliteration exact
4. jamo/phonetic exact or near-exact
5. trigram / edit-distance fuzzy alias
6. family/producer-label graph recall
7. char-aware dense or late-interaction retrieval for long-tail misspellings

candidate recall은 다채널 union이고, final resolve authority는 reranker + calibrator다.

### 5.5 Resolver decision layer

candidate별 feature:

- exact alias evidence
- normalized alias evidence
- script/language consistency
- edit-distance
- phonetic consistency
- family graph proximity
- popularity prior
- vintage agreement
- region/style contradiction
- ambiguity-cluster membership

최종 decision은:

- learned scorer/reranker
- calibrated confidence
- top1-top2 margin
- class-aware abstain thresholds

로 결정한다.

---

## 6. 왜 새 스택이어야 하나

현재 구조는 뼈대는 좋지만, 아래가 계속 얽힌다.

1. primitive search 계약
2. public search 응답 계약
3. search-time debug traces
4. alias ETL/publish lifecycle
5. resolver fail-close policy

breaking change 허용이면 V2를 새 stack으로 만드는 편이 낫다.

- contract가 단순해진다
- entity task에 맞는 runtime artifact를 설계할 수 있다
- operator tooling도 lookup-only semantics에 맞춰진다
- V1/V2 shadow compare가 쉬워진다

---

## 7. Wave

### Wave 1

- `T-ELV2-01` dedicated lookup contract and public surface split
- `T-ELV2-02` admission, normalization, concept gate
- `T-ELV2-03` alias registry v2 and curation substrate

### Wave 2

- `T-ELV2-04` multi-channel candidate retrieval runtime
- `T-ELV2-05` learned reranker, calibrator, abstain
- `T-ELV2-06` family graph and ambiguity graph

### Wave 3

- `T-ELV2-07` trusted operator plane and curation write plane

### Wave 4

- `T-ELV2-08` hotset eval, shadow compare, cutover, legacy purge

---

## 8. 전역 DoD

1. `opu one`류 short noisy typo가 wrong-positive 대신 `ambiguous/failed`로 닫힌다.
2. `dom perignon` / `돔페리뇽`류 hot entity hole이 coverage report와 curation flow에서 관리된다.
3. `까쇼`류 concept query가 entity resolve를 시도하지 않는다.
4. candidate retrieval가 exact/transliteration/fuzzy/family/dense 다채널 union을 가진다.
5. final resolve는 learned scorer + calibrated abstain contract를 가진다.
6. operator가 query 하나로 admission/candidates/scores/decision을 trusted plane에서 본다.
7. V2가 V1 대비 hotset precision/abstain/recall gate를 충족한 뒤에만 cutover한다.

---

## 9. 검증 축

1. owner-local unit/integration
2. noisy entity hotset eval
3. shadow compare report
4. operator smoke
5. live canary replay

---

## 10. 티켓 목록

- [tickets/README.md](./tickets/README.md)
- [T-ELV2-01 Dedicated Lookup Contract And Public Surface Split](./tickets/T-ELV2-01-dedicated-lookup-contract-and-public-surface-split.md)
- [T-ELV2-02 Admission Normalization And Concept Gate](./tickets/T-ELV2-02-admission-normalization-and-concept-gate.md)
- [T-ELV2-03 Alias Registry V2 And Curation Substrate](./tickets/T-ELV2-03-alias-registry-v2-and-curation-substrate.md)
- [T-ELV2-04 Multi-Channel Candidate Retrieval Runtime](./tickets/T-ELV2-04-multi-channel-candidate-retrieval-runtime.md)
- [T-ELV2-05 Learned Reranker Calibrator And Abstain](./tickets/T-ELV2-05-learned-reranker-calibrator-and-abstain.md)
- [T-ELV2-06 Family Graph And Ambiguity Graph](./tickets/T-ELV2-06-family-graph-and-ambiguity-graph.md)
- [T-ELV2-07 Trusted Operator Plane And Curation Write Plane](./tickets/T-ELV2-07-trusted-operator-plane-and-curation-write-plane.md)
- [T-ELV2-08 Hotset Eval Shadow Compare Cutover And Legacy Purge](./tickets/T-ELV2-08-hotset-eval-shadow-compare-cutover-and-legacy-purge.md)
