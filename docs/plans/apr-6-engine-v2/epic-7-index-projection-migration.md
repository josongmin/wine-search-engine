# Epic 7: Index Projection Migration

**성격:** should  
**목표:** `RetrievalDocument` 중심 단일 projection을 v2 retrieval/ranking 요구에 맞게 재설계한다.  
**의존성:** Epic 3, Epic 5, Epic 6

---

## 왜 마지막인가

이 epic은 가장 비싸고, **현재 레포에서 가장 반경이 큰 migration**이다.

- ingestion
- Vespa mapping
- search summaries
- in-memory adapters
- vespa e2e
- seed/test fixtures
- LTR scripts

가 모두 연결되어 있다.  
따라서 query/runtime/ranking/API contract가 먼저 안정화된 뒤에 해야 한다.

이 epic의 성격은 단순 필드 추가가 아니라, **entity-only current engine에서 offer-aware future engine으로 가는 bridge**를 만드는 것이다.

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

Wave 3에서는 projection family를 아래 방향으로 고정한다.

- `RetrievalHitSummary` 계열: search hit summary / rerank passage / public display/evidence에 필요한 summary fields
- retrieval core document 계열: sparse/dense/filter/ranking runtime이 읽는 필드
- embedding / learned sparse payload 계열: vector or sparse tensor payload
- ETL-only assembly shape: upstream source를 projection family로 나누기 전의 staging shape

즉 "새 display projection을 백지에서 만드는 것"이 아니라, 이미 존재하는 [search-index.port.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/port/search-index.port.ts)의 `RetrievalHitSummary` seam을 공식 projection boundary로 승격하는 것이 기본 방향이다.

offer / availability projection은 v2 core에선 bridge 수준으로 정의하고, richer commerce graph는 [appendix-b-sota-gap-and-post-v2-backlog.md](/Users/songmin/wine-search-engine/docs/plans/apr-6-engine-v2/appendix-b-sota-gap-and-post-v2-backlog.md)로 넘긴다.

---

## 레포에서 건드리는 축

- [retrieval-document.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-document.ts)
- [search-index.port.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/port/search-index.port.ts)
- [hybrid-candidate-summary.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/hybrid-candidate-summary.ts)
- [mapping.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/mapping.ts)
- [vespa-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts)
- [vespa-anchor-resolver.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-anchor-resolver.ts)
- [vespa-candidate-attributes.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-candidate-attributes.ts)
- [search-usecase-resolver-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-resolver-candidates.ts)
- [tool-executor.ts](/Users/songmin/wine-search-engine/src/interface/claude-tools/tool-executor.ts)
- [index-to-vespa.ts](/Users/songmin/wine-search-engine/scripts/etl/index-to-vespa.ts)
- [vespa-schema.sd](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-schema.sd)
- [test/integration/helpers/in-memory-adapters.ts](/Users/songmin/wine-search-engine/test/integration/helpers/in-memory-adapters.ts)
- [test/e2e/vespa/helpers/vespa-test-fixtures.ts](/Users/songmin/wine-search-engine/test/e2e/vespa/helpers/vespa-test-fixtures.ts)

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

현재 코드 기준으로는:

- [retrieval-document.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/model/retrieval-document.ts)가 ETL/runtime/test fixture의 과대 SSOT
- [search-index.port.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/port/search-index.port.ts)의 `RetrievalHitSummary`가 summary seam
- [hybrid-candidate-summary.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/hybrid-candidate-summary.ts)가 summary propagation seam

따라서 이 단계는 `RetrievalDocument`를 무조건 더 크게 만드는 게 아니라, summary/full-document/feature payload의 ownership을 문서와 타입으로 분리하는 작업으로 정의한다.

코드 레벨에서 특히 주의할 점은 `getDocument()` full payload를 읽는 소비자가 이미 여러 곳에 있다는 점이다.

- resolver candidate assembly
- mixed-query anchor resolver
- candidate attribute loader
- tool executor의 entity lookup

따라서 `T7.1`은 summary seam만 예쁘게 분리하고 full-document consumers를 방치하는 half-migration으로 닫으면 안 된다.

### Step 2. Vespa schema / summary contract 재설계

summary fields, ranking features, dense/sparse tensors, optional channel fields를 재정렬한다.

### Step 3. ETL / indexing pipeline 정렬

Silver/Enriched source에서 새 projection family로 feeding path를 재구성한다.

### Step 4. Test fixture migration

in-memory adapters, vespa tests, fixtures, seed data를 새 projection에 맞춘다.

### Step 5. Backfill / reindex strategy

새 projection으로 운영 인덱스를 어떻게 재구축할지, dual-write나 full reindex가 필요한지 명시한다.

## 설계 원칙

1. runtime contract가 먼저, index projection은 나중이다.
2. display convenience 때문에 retrieval document가 비대해지지 않게 한다.
3. projection migration은 ETL과 runtime을 동시에 설명하는 문서와 함께 간다.
4. feed / get / summary / ranking feature contract를 따로 생각한다.

---

## LLM Execution Guide

이 epic의 hotspot은 `retrieval-document.ts`, `search-index.port.ts`, `mapping.ts`, `vespa-schema.sd`, `index-to-vespa.ts`, fixture adapters다.  
따라서 projection boundary, Vespa schema ownership, ETL feed contract, fixture migration을 한 PR에 섞지 않는 것이 기본 원칙이다.

### Recommended PR slices

| Task | 닫는 기준 | Must change | Must not change |
|---|---|---|---|
| T7.1 | `RetrievalDocument` 과대 SSOT가 summary/full-document/feature seam 기준으로 분해되고 `RetrievalHitSummary`가 공식 summary boundary가 됨 | retrieval projection model, search index port, summary extraction helper, candidate/full-document consumer adapters, reindex script read model | public V2 route semantics, ranking policy logic beyond input adaptation |
| T7.2 | Vespa schema/mapping/runtime adapter가 projection family ownership을 동일하게 반영 | `vespa-schema.sd`, `mapping.ts`, `vespa-search-index.ts`, Vespa mapping/index tests | ETL source semantics, public response contract |
| T7.3 | ETL/indexing scripts가 projection family별 required/optional field contract를 생산 | `index-to-vespa.ts`, ingest smoke helpers, seed/index scripts, ETL tests | query/runtime execution contract, HTTP route contract |
| T7.4 | in-memory adapters and Vespa fixtures가 production projection vocabulary와 같은 seam을 사용 | in-memory adapters, integration fixtures, Vespa fixture docs/helpers, pipeline tests | production serving behavior |
| T7.5 | reindex/backfill strategy와 operational verification artifact가 문서/스크립트에 고정 | migration docs, reindex scripts, rollout notes | runtime query path |

### Hotspot ownership

- `T7.1` owns projection family names and field ownership. 뒤 task는 새로운 projection 이름을 발명하지 않고 그 vocabulary를 따른다.
- `T7.2` owns Vespa field ownership only. ETL source transformation까지 같이 재설계하지 않고, `mapping.ts` / `vespa-search-index.ts` / summary extraction seam이 같은 ownership을 쓰게 만든다.
- `T7.3`은 ETL/feed path만 다룬다. runtime search adapter를 다시 만지지 않는다.
- `T7.4`는 test/supporting infra only다. production code behavior를 슬쩍 바꾸지 않는다.
- `T7.5`는 operational migration only다. schema/runtime logic을 다시 바꾸지 않는다.

### Required verification by slice

- Boundary/model slices: `npm run typecheck`, `npm run test:ingest:contract`, `npm run test:integration`
- Schema/runtime slices: `npm run test:e2e:vespa:smoke`, `npm run test:ingest:contract`
- ETL/feed slices: `npm run test:ingest:contract`, `npm run test:ingest:indexing`
- Fixture migration slices: `npm run test:all`
- Operational docs/scripts: `npm run test:e2e:vespa:smoke`, `npm run test:ingest:contract`

---

## 완료 기준

- projection boundary가 문서와 타입으로 분명해진다.
- Vespa schema가 v2 retrieval/ranking needs와 직접 연결된다.
- ETL, runtime, tests가 새 projection family에 정렬된다.
- 이후 retrieval/ranking 실험이 projection 비대화 없이 가능해진다.
- entity-only current engine에서 offer-aware future engine으로 넘어갈 bridge가 문서와 타입으로 설명된다.

## 검증 전략

- ingest contract tests
- Vespa mapping roundtrip tests
- in-memory adapter parity tests
- vespa e2e / indexing smoke
- full-suite regression after fixture migration
