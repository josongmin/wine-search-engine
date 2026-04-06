# Epic 2: Query Understanding Upgrade

**성격:** must  
**목표:** 와인 검색 특화 query understanding을 planner/compiler의 first-class capability로 승격한다.  
**의존성:** Epic 1

---

## 왜 필요한가

현재 레포도 normalization, constraint extraction, anchor handling이 있지만, 여전히 retrieval 품질의 상당 부분을 downstream heuristic이 메우는 구조다.  
이 epic은 query를 더 잘 해석해서 retrieval과 ranking이 더 쉬운 문제를 풀게 만드는 작업이다.

---

## 목표 상태

- query normalization이 single-string canonicalization이 아니다.
- multi-view rewrite가 planner 산출물에 포함된다.
- relative / anchor / compare / browse 의도가 first-class query family가 된다.
- domain ontology 정규화가 retrieval 전에 끝난다.

---

## 레포에서 건드리는 축

- [src/domain/query/service/query-normalizer.ts](/Users/songmin/wine-search-engine/src/domain/query/service/query-normalizer.ts)
- [src/domain/query/model/query-views.ts](/Users/songmin/wine-search-engine/src/domain/query/model/query-views.ts)
- [src/domain/query/service/anchor-extractor.ts](/Users/songmin/wine-search-engine/src/domain/query/service/anchor-extractor.ts)
- [src/domain/query/service/planner.ts](/Users/songmin/wine-search-engine/src/domain/query/service/planner.ts)
- [src/domain/query/service/planner-intent-detection.ts](/Users/songmin/wine-search-engine/src/domain/query/service/planner-intent-detection.ts)
- [src/domain/query/service/rule-based-constraint-extractor.ts](/Users/songmin/wine-search-engine/src/domain/query/service/rule-based-constraint-extractor.ts)
- [src/domain/query/service/expansion-builder.ts](/Users/songmin/wine-search-engine/src/domain/query/service/expansion-builder.ts)
- [src/domain/query/service/decomposition-detector.ts](/Users/songmin/wine-search-engine/src/domain/query/service/decomposition-detector.ts)
- [src/domain/query/service/pairing-extractor.ts](/Users/songmin/wine-search-engine/src/domain/query/service/pairing-extractor.ts)
- [src/domain/attribute/service/nl-mapper.ts](/Users/songmin/wine-search-engine/src/domain/attribute/service/nl-mapper.ts)
- [src/domain/attribute/service/attribute-inferrer.ts](/Users/songmin/wine-search-engine/src/domain/attribute/service/attribute-inferrer.ts)
- [src/domain/mixed/service/mixed-solver.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/mixed-solver.ts)
- [src/domain/mixed/service/anchor-profiler.ts](/Users/songmin/wine-search-engine/src/domain/mixed/service/anchor-profiler.ts)
- [src/application/search/search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts)

---

## In Scope

- multi-view normalization
- ontology normalization
- anchor / relative query understanding
- compare / decomposition semantics 정리
- query provenance vocabulary 확정

## Out Of Scope

- retrieval channel implementation 자체
- ranking weight retune
- public API result family redesign

---

## 핵심 작업

### Step 1. Multi-view normalization SSOT

strict, accentless, compact, transliterated, vintage-normalized, reordered token view를 planner/compiler가 공식적으로 생성한다.

### Step 2. Domain ontology normalization

grape, region, style, body, sweetness, pairing, producer prestige, price-relative 표현을 표준 축으로 변환한다.

### Step 3. Anchor / relative query understanding 강화

`X 같은`, `X보다 저렴한`, `X보다 덜 무거운` 같은 표현을 anchor-conditioned structured query로 승격한다.

### Step 4. Multi-intent / compare decomposition 내재화

현재 decomposition과 mixed logic이 분산된 부분을 query understanding contract 안에서 더 일관되게 정리한다.

### Step 5. Query understanding observability

query family, rewrite id, ambiguity class, anchor/relative extraction 결과를 runtime logs와 offline eval slice vocabulary로 맞춘다.

---

## 설계 원칙

1. retrieval이 guess하지 않도록 query를 더 구조화한다.
2. query understanding은 검색 품질 계층이지, API sugar가 아니다.
3. provenance를 잃지 않고 rewrite를 생성해야 한다.
4. security gate 이후 deterministic transform만 수행한다.

---

## 완료 기준

- query view 세트가 planner/compiler SSOT가 된다.
- anchor/relative/compare류가 명시적 query family로 구분된다.
- ontology normalization 결과가 candidate generation과 ranking에 직접 사용된다.
- query understanding 변경이 runtime logs/eval slices로 관측 가능하다.

## 검증 전략

- query normalization unit tests
- planner interpretation contract tests
- noisy entity / mixed / relative query eval slices
- interpret route regression tests
