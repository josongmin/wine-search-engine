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

selective late interaction은 방향상 중요하지만, v2 core에선 다루지 않고 [appendix-b-sota-gap-and-post-v2-backlog.md](/Users/songmin/wine-search-engine/docs/plans/apr-6-engine-v2/appendix-b-sota-gap-and-post-v2-backlog.md)에 별도 backlog로 둔다.

---

## 레포에서 건드리는 축

- [src/infrastructure/vespa](/Users/songmin/wine-search-engine/src/infrastructure/vespa)
- [src/domain/retrieval](/Users/songmin/wine-search-engine/src/domain/retrieval)
- [search-usecase-hybrid-candidates.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts)
- [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts)
- [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts)
- [cascade-router.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/cascade-router.ts)
- [compare-retriever.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/compare-retriever.ts)
- [vespa-search-index.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-search-index.ts)
- [vespa-similar-retrieval.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-similar-retrieval.ts)

---

## In Scope

- learned sparse channel
- anchor similarity 강화
- relative retrieval path
- query family별 channel mix policy

### Public surface rule

이 epic은 retrieval channel 내부를 바꾸는 단계다.  
public HTTP route contract는 Epic 6 전까지 adapter-compatible하게 유지한다.

## Out Of Scope

- full late interaction / ColBERT serving
- vision / OCR retrieval
- personalization ranking

---

## 핵심 작업

### Step 1. Learned sparse artifact / spec pipeline

현재 레포에는 learned sparse artifact 생성기나 weight serialization contract가 없다.  
따라서 먼저 모델 선택, sparse weight format, ETL interface, offline validation 기준을 고정한다.

이 단계는 docs/stub/eval entry 정리 티켓이다.  
`candidate-pool.ts`, `vespa-search-index.ts`, `search-index.port.ts` 같은 runtime query path를 여기서 먼저 건드리면 `T4.3`와 경계가 무너진다.

### Step 2. Learned sparse schema / feed plumbing

Vespa/ETL/feature contract를 확장해 learned sparse retrieval을 추가한다.  
typo, multilingual, long-tail preference query에서 dense만으로 못 잡는 recall을 보완한다.

### Step 3. Learned sparse runtime channel

runtime retrieval에 learned sparse channel을 연결한다.

### Step 4. Anchor similarity 승격

`similar_items` 계열을 보조 경로가 아니라 retrieval family로 재정의한다.

현재 코드 기준으로 main hybrid anchor-neighborhood path는 [candidate-pool.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/candidate-pool.ts) 안에 있고, [vespa-similar-retrieval.ts](/Users/songmin/wine-search-engine/src/infrastructure/vespa/vespa-similar-retrieval.ts)는 mixed solver seam이다.  
따라서 `T4.4`는 adapter 하나만 고치는 작업이 아니라, 두 경로의 `candidateSources` / profile naming / trace semantics를 같은 vocabulary로 맞추는 작업으로 정의한다.

### Step 5. Relative retrieval 도입

`X보다 저렴한`, `X보다 덜 떫은` 같은 쿼리를 구조화해 anchor-conditioned filtering/ranking이 가능하게 한다.

### Step 6. Channel policy 분리

known-item, constrained search, semantic preference, anchor query가 같은 retrieval mix를 쓰지 않게 한다.

현재 repo에서는 이 policy가 사실상 [retrieval-profile.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/retrieval-profile.ts)와 [cascade-router.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/cascade-router.ts)에 나뉘어 있다.  
따라서 `T4.6`은 profile 숫자만 바꾸는 티켓이 아니라, query family -> phase -> trace vocabulary가 두 파일에서 같은 의미를 갖도록 고정하는 티켓으로 본다.

### Step 7. Serving / ETL capability alignment

채널 도입에 필요한 Vespa field, feed data, serving query contract를 같이 설계한다.

learned sparse 채널의 경우 구체적으로:

- `vespa-schema.sd`에 learned sparse tensor field 추가
- ETL feed pipeline에 sparse token weight 생성 단계 추가
- rank profile에 learned sparse dot-product scoring 추가
- 이 변경은 Epic 7 전에 수행하되, Epic 7의 전체 projection 재설계와 호환되도록 설계한다

---

## LLM Execution Guide

이 epic은 `candidate-pool.ts`, `retrieval-profile.ts`, `vespa-search-index.ts`, `retrieval-trace.ts`에 write hotspot이 몰려 있다.  
따라서 병렬화는 "channel contract", "schema/feed", "runtime wiring", "policy"를 분리한 뒤 같은 hotspot을 동시에 건드리지 않는 방식으로만 허용한다.

### Recommended PR slices

| Task | 닫는 기준 | Must change | Must not change |
|---|---|---|---|
| T4.1 | retrieval input이 channel-aware shape를 갖고 specialized route handoff와 candidate-pool 내부 channel dispatch가 분리됨 | `retrieval-input.ts`, `retrieval-trace.ts`, `search-index.port.ts`, `retrieval-profile.ts`, `cascade-router.ts`, hybrid candidate dispatch contract | Vespa schema, ranking weights, public HTTP contract |
| T4.1a | learned sparse artifact format, serialization key, offline validation 기준이 문서와 ETL stub에서 같은 이름을 사용 | Epic 4 spec 문서, ETL stub, offline eval script entry | runtime retrieval path, candidate scoring |
| T4.2 | schema/feed가 learned sparse field를 실제로 전달하고 Vespa smoke lane에서 깨지지 않음 | `vespa-schema.sd`, `mapping.ts`, `index-to-vespa.ts`, mapping/index adapter tests | candidate-pool policy, ranking logic |
| T4.3 | learned sparse query가 runtime candidate generation에 연결되고 trace에서 channel source가 보임 | `search-index.port.ts`, `vespa-search-index.ts`, `fusion.ts`, `candidate-pool.ts`, `retrieval-profile.ts`, `retrieval-trace.ts`, port implementation parity | channel policy retune, rerank logic |
| T4.4 | anchor similarity가 dedicated retrieval channel로 trace되고 generic dense fallback과 구분됨 | `fusion.ts`, `candidate-pool.ts`, `vespa-similar-retrieval.ts`, `retrieval-profile.ts`, `retrieval-trace.ts` | relative retrieval semantics, ranking stage contract |
| T4.5 | relative query path가 anchor-conditioned candidate shaping을 가지며 compare/generic hybrid fallback과 구분됨 | `compare-retriever.ts`, constraint evidence/filter helpers, `candidate-pool.ts`, `retrieval-profile.ts`, `search-usecase-hybrid-candidates.ts` | public query mode 추가, Vespa schema 재설계 |
| T4.6 | query family별 channel mix가 profile/policy/trace vocabulary로 고정되고 eval slice에서 검증 가능 | `retrieval-profile.ts`, `cascade-router.ts`, `candidate-pool.ts`, `retrieval-trace.ts`, eval runner/script vocabulary | ranker scoring, public response explain format |

### Hotspot ownership

- `T4.1` owns retrieval contract naming. 이후 task는 channel 이름을 새로 발명하지 않고 그 vocabulary를 그대로 재사용한다.
- `T4.1a`는 docs/stub only다. runtime query adapter나 candidate trace를 미리 바꾸지 않는다.
- `T4.2` owns schema/feed only. runtime dispatch를 미리 넣으려 하지 않는다.
- `T4.3` owns learned sparse runtime hookup. current code에서 `candidateSources` 기본 라벨은 `fusion.ts`가 만든다. learned sparse를 기존 `sparse` 라벨로 우겨넣지 말고, 여기서 anchor/relative policy까지 같이 넣지 않는다.
- `T4.4` owns anchor channel semantics. current code에서 main anchor path는 `candidate-pool.ts`, mixed seam은 `vespa-similar-retrieval.ts`이므로 둘 중 하나만 고치고 끝내지 않는다. `T4.5`와 같은 PR에서 합치지 않는다.
- `T4.5`는 새 파일을 억지로 만드는 것보다 현재 [compare-retriever.ts](/Users/songmin/wine-search-engine/src/domain/retrieval/service/compare-retriever.ts)와 candidate evidence/filter seam 위에서 상대 비교 path를 정리하는 쪽을 우선한다. specialized compare short-circuit를 generic candidate pool보다 뒤로 보내지 않는다.
- `T4.6`는 retrieval mix policy만 고정한다. profile 숫자와 cascade phase를 따로 놀게 두지 말고, specialized browse/compare route switch나 ranking weight 조정으로 품질 문제를 덮지 않는다.

### Required verification by slice

- Contract-only slices: `npm run typecheck`, `npm run test:integration:search-pipeline`
- Schema/feed slices: `npm run test:ingest:contract`, `npm run test:e2e:vespa:smoke`
- Runtime channel slices: `npm run test:integration:search-pipeline`, `npm run test:quality`
- Policy/eval slices: `npm run test:quality`, `npm run eval:noisy:validate`

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
