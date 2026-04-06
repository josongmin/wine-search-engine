# Epic 7: Index Projection Migration

**성격:** should  
**목표:** `RetrievalDocument` 중심 단일 projection을 v2 retrieval/ranking 요구에 맞게 재설계한다.  
**의존성:** Epic 3, Epic 5, Epic 6

---

## 왜 마지막인가

이 epic은 가장 비싸다.

- ingestion
- Vespa mapping
- search summaries
- in-memory adapters
- vespa e2e
- seed/test fixtures
- LTR scripts

가 모두 연결되어 있다.  
따라서 query/runtime/ranking/API contract가 먼저 안정화된 뒤에 해야 한다.

---

## 목표 상태

현재의 단일 `RetrievalDocument`를 더 명시적인 projection family로 나눈다.

예시:

```text
Canonical entity projection
Offer / availability projection
Evidence / explanation projection
Embedding / retrieval feature projection
```

정확한 분할은 implementation 전에 다시 확정하되, 최소한 “display document”와 “retrieval feature document”를 구분하는 방향이 맞다.

---

## 레포에서 건드리는 축

- [retrieval-document.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-document.ts)
- [search-index.port.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/port/search-index.port.ts)
- [mapping.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/mapping.ts)
- [vespa-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts)
- [index-to-vespa.ts](/Users/songmin/wine-search-engine/scripts/etl/index-to-vespa.ts)
- [vespa-schema.sd](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-schema.sd)

---

## In Scope

- projection family 재정의
- Vespa schema / summary contract migration
- ETL / indexing alignment
- test fixture / seed / in-memory adapter migration

## Out Of Scope

- query contract redesign
- ranking policy redesign
- personalization / multimodal data model

---

## 핵심 작업

### Step 1. Projection boundary 재정의

retrieval에 꼭 필요한 필드와 display/evidence용 필드를 구분한다.

### Step 2. Vespa schema / summary contract 재설계

summary fields, ranking features, dense/sparse tensors, optional channel fields를 재정렬한다.

### Step 3. ETL / indexing pipeline 정렬

Silver/Enriched source에서 새 projection family로 feeding path를 재구성한다.

### Step 4. Test fixture migration

in-memory adapters, vespa tests, fixtures, seed data를 새 projection에 맞춘다.

### Step 5. Backfill / reindex strategy

새 projection으로 운영 인덱스를 어떻게 재구축할지, dual-write나 full reindex가 필요한지 명시한다.

---

## 설계 원칙

1. runtime contract가 먼저, index projection은 나중이다.
2. display convenience 때문에 retrieval document가 비대해지지 않게 한다.
3. projection migration은 ETL과 runtime을 동시에 설명하는 문서와 함께 간다.
4. feed / get / summary / ranking feature contract를 따로 생각한다.

---

## 완료 기준

- projection boundary가 문서와 타입으로 분명해진다.
- Vespa schema가 v2 retrieval/ranking needs와 직접 연결된다.
- ETL, runtime, tests가 새 projection family에 정렬된다.
- 이후 retrieval/ranking 실험이 projection 비대화 없이 가능해진다.

## 검증 전략

- ingest contract tests
- Vespa mapping roundtrip tests
- in-memory adapter parity tests
- vespa e2e / indexing smoke
