# Appendix B: SOTA Gap and Post-v2 Backlog

이 appendix는 `apr-6-engine-v2`가 의도적으로 포함하지 않은, 그러나 `ROI 무관 최강 엔진` 관점에서는 중요한 후속 축을 정리한다.  
핵심 원칙은 단순하다.

> v2는 **현재 엔진과 호환되는 strongest-implementable core**다.  
> post-v2 backlog는 **SOTA++를 향한 다음 파동**이다.

---

## 1. 왜 backlog로 분리하나

아래 항목들은 방향상 맞다.

- selective late interaction
- `VISION_LABEL` / OCR / multimodal retrieval
- behavior / personalization
- richer offer / merchant graph
- pairing / co-mention graph

하지만 현재 레포에서 이들을 바로 v2 completion gate에 넣으면:

- query/runtime contract migration
- public API migration
- Vespa / ETL projection migration

과 동시에 새로운 serving/data/eval contract까지 추가로 설계해야 한다.  
즉 “맞는 방향”과 “지금 이 레포에 맞는 구현 순서”는 다르다.

---

## 2. SOTA 정렬표

| 축 | v2 core 포함 여부 | 이유 |
|---|---|---|
| learned sparse | 포함 | 현재 Vespa/ETL/runtime에 가장 현실적인 recall uplift |
| phased ranking / selective rerank | 포함 | 현재 ranker/LTR/reranker scaffold와 잘 맞음 |
| provenance-rich LLM envelope | 포함 | 현재 human+LLM dual-surface와 직접 연결됨 |
| selective late interaction | backlog | token-level artifact/serving contract가 아직 없음 |
| `VISION_LABEL` / OCR retrieval | backlog | image asset pipeline, OCR eval, route surface가 새로 필요 |
| behavior/personalization serving | backlog | user-state contract, leakage-safe eval, policy guard가 필요 |
| richer offer/merchant graph | backlog | 현재 entity-centric projection에서 한 단계 더 큰 graph migration 필요 |
| pairing / co-mention graph | backlog | retrieval/ranking signal로는 유망하지만 source graph와 eval slice가 먼저 필요 |

---

## 3. Post-v2 Backlog

### B1. Selective Late Interaction

**목표**
- very-top precision을 높이기 위한 ColBERT-style token interaction 도입
- query family별 selective activation

**왜 backlog인가**
- 현재 레포에는 token embedding artifact pipeline이 없다
- learned sparse와 provenance contract가 먼저 안정화돼야 실험 비용이 줄어든다

**선행 조건**
- Epic 3 candidate/provenance contract
- Epic 5 ranking stage contract
- Epic 7 projection boundary

### B2. `VISION_LABEL` / OCR / Multimodal Retrieval

**목표**
- bottle / label image로 entity retrieval
- OCR text와 visual label features를 retrieval input으로 사용

**왜 backlog인가**
- 현재 레포는 텍스트 중심 ETL과 Vespa schema에 맞춰져 있다
- image asset store, OCR extraction, multimodal eval set이 없다

**선행 조건**
- Epic 6 machine/human result split
- Epic 7 projection migration

### B3. Behavior / Personalization Serving

**목표**
- user/session-aware ranking
- novelty/diversity/retention-aware rerank

**왜 backlog인가**
- [RFC-010](/Users/songmin/wine-search-engine/docs/RFC-010.md) 기반 feedback ingest는 있지만 serving-side contract가 없다
- user profile/state contract, leakage-safe eval, policy guard가 필요하다

**선행 조건**
- Epic 5 ranking stage contract
- Epic 6 public result contract
- offer/merchant 또는 user-state projection 설계

### B4. Richer Offer / Merchant Graph

**목표**
- canonical entity + offer aggregation + merchant availability ranking
- entity-only current engine에서 commerce-aware future engine으로 확장

**왜 backlog인가**
- 현재 projection은 entity-centric다
- offer/merchant graph는 단순 필드 추가가 아니라 retrieval unit 변경이다

**선행 조건**
- Epic 7 projection family migration

### B5. Pairing / Co-mention Graph

**목표**
- food pairing, occasion, producer/style neighborhood를 graph 신호로 활용
- discovery / recommendation / LLM evidence를 강화

**왜 backlog인가**
- source graph, refresh pipeline, eval slice가 아직 없다
- current v2 core의 ontology/provenance/ranking이 먼저 안정화돼야 품질 해석이 쉬워진다

**선행 조건**
- Epic 2 query understanding
- Epic 5 ranking funnel
- Epic 7 projection boundary

---

## 4. LLM + 휴먼 방향성 정리

v2 core에서 이미 달성하는 것:

- human search response와 machine/LLM response의 계약 분리
- provenance-rich envelope
- citation-ready, evidence-aware retrieval unit

post-v2에서 추가되는 것:

- `VISION_LABEL`로 image-first LLM retrieval
- behavior/personalization으로 user-context-aware assistant retrieval
- richer commerce graph로 “추천 + 구매 맥락 + 증거”가 결합된 LLM retrieval

---

## 5. 완료 조건

이 appendix의 항목들은 **v2 완료 조건이 아니다**.  
대신 아래 역할을 가진다.

- 문서가 `최강 엔진`을 과장 없이 설명하도록 보완
- v2 이후의 연구/제품 backlog를 미리 의사결정 완료 상태로 정리
- 구현자가 “왜 late interaction / multimodal / personalization이 빠졌지?”를 문서만 보고 이해하게 함
