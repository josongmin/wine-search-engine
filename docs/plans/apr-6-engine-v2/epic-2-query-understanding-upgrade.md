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

### Public surface rule

이 epic은 query 해석 내부를 강화하는 단계다.  
public HTTP request/response contract는 Epic 6 전까지 adapter-compatible하게 유지한다.

---

## 레포에서 건드리는 축

- [src/application/search](/Users/songmin/wine-search-engine/src/application/search)
- [src/domain/query](/Users/songmin/wine-search-engine/src/domain/query)
- [src/domain/mixed](/Users/songmin/wine-search-engine/src/domain/mixed)
- [search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts)

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

현재 [search-usecase-pre-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts)에는 planner 이전의 decomposition shortcut이 있다.  
Wave 1 종료 시점엔 이 경로가 별도 의미 체계를 갖는 것이 아니라, query understanding 결과를 소비하는 compatibility adapter가 되어야 한다.

### Step 5. Query understanding observability

query family, rewrite id, ambiguity class, anchor/relative extraction 결과를 runtime logs와 offline eval slice vocabulary로 맞춘다.

이 단계는 기존 [search-log-schema.ts](/Users/songmin/wine-search-engine/src/observability/search-log-schema.ts)를 무작정 확장하는 것으로 끝내지 않는다.  
현재 search log는 execution meta 중심이라 query understanding payload와 retrieval provenance payload를 분리해 설계하는 것이 맞다.

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
- query understanding log schema / payload tests
