# Epic 4: Retrieval Channels Upgrade

**성격:** must  
**목표:** BM25+dense 중심 retrieval을 multi-channel retrieval stack으로 확장한다.  
**의존성:** Epic 3  
**교차 의존:** Epic 7 (Index Projection) — learned sparse 도입 시 Vespa schema에 tensor field 추가, feed pipeline 확장, rank profile 수정이 필요하다. 이 최소 schema 변경은 Epic 4에서 선행 수행하고, Epic 7에서는 전체 projection 재설계에 포함시킨다.

---

## 왜 필요한가

지금 스택은 “좋은 1세대 hybrid retrieval”로는 충분히 강하다.  
하지만 2026 수준 retrieval quality로 가려면 채널을 늘리는 것보다, 각 채널의 역할을 명확히 해야 한다.

이 epic은 특히 learned sparse와 anchor/relative retrieval를 first-class channel로 올리는 게 핵심이다.

---

## 우선 채널

1. lexical sparse
2. dense semantic
3. learned sparse
4. anchor similarity
5. relative retrieval
6. browse / compare specialized retrieval

late interaction은 이 epic의 비목표다.

---

## 레포에서 건드리는 축

- [src/infrastructure/vespa](/Users/songmin/wine-search-engine/src/infrastructure/vespa)
- [src/domain/retrieval](/Users/songmin/wine-search-engine/src/domain/retrieval)
- [search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts)
- [vespa-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts)
- [vespa-similar-retrieval.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-similar-retrieval.ts)

---

## In Scope

- learned sparse channel
- anchor similarity 강화
- relative retrieval path
- query family별 channel mix policy

## Out Of Scope

- full late interaction / ColBERT serving
- vision / OCR retrieval
- personalization ranking

---

## 핵심 작업

### Step 1. Learned sparse 도입

Vespa/ETL/feature contract를 확장해 learned sparse retrieval을 추가한다.  
typo, multilingual, long-tail preference query에서 dense만으로 못 잡는 recall을 보완한다.

### Step 2. Anchor similarity 승격

`similar_items` 계열을 보조 경로가 아니라 retrieval family로 재정의한다.

### Step 3. Relative retrieval 도입

`X보다 저렴한`, `X보다 덜 떫은` 같은 쿼리를 구조화해 anchor-conditioned filtering/ranking이 가능하게 한다.

### Step 4. Channel policy 분리

known-item, constrained search, semantic preference, anchor query가 같은 retrieval mix를 쓰지 않게 한다.

### Step 5. Serving / ETL capability alignment

채널 도입에 필요한 Vespa field, feed data, serving query contract를 같이 설계한다.

learned sparse 채널의 경우 구체적으로:

- `vespa-schema.sd`에 learned sparse tensor field 추가
- ETL feed pipeline에 sparse token weight 생성 단계 추가
- rank profile에 learned sparse dot-product scoring 추가
- 이 변경은 Epic 7 전에 수행하되, Epic 7의 전체 projection 재설계와 호환되도록 설계한다

---

## 설계 원칙

1. 채널을 늘리기 전에 후보 계약을 먼저 고정한다.
2. learned sparse는 dense 대체가 아니라 보완 채널이다.
3. anchor retrieval은 query understanding과 결합된 별도 문제다.
4. query class별 channel mix는 offline eval과 함께 관리한다.

### 브레이킹 표면

- Vespa schema field 추가 (learned sparse tensor, anchor feature fields)
- ETL feed contract 확장
- candidate-pool.ts channel dispatch interface
- retrieval-input.ts channel enum/union
- vespa-search-index.ts query building

---

## 완료 기준

- learned sparse가 retrieval channel로 정식 편입된다.
- anchor/relative retrieval가 dedicated execution path를 가진다.
- query family별 channel policy가 명시된다.
- channel 추가가 candidate contract나 ranking contract를 깨지 않는다.

## 검증 전략

- channel-specific integration tests
- Vespa mapping / summary regression tests
- quality slice eval
- anchor/relative query e2e tests
