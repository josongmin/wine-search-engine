# Epic 16 — Learned Fusion + Retrieval Uplift + Adaptive Cascade

**Phase:** B/C (단계적)
**우선순위:** P1
**의존:** Week 0 W0-4 (RRF sweep), Epic-13 (retrieval ceiling metrics), Epic-10 (LTR / rerank integration)
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `부분 필요`

---

## 왜 — SOTA++ Gap

RRF k=60 고정, 모든 프로필 동일. Cascade routing이 하드코딩 decision tree.
v2 plan이 누락한 핵심 기술: ColBERT, Matryoshka embeddings, Doc2Query, Condorcet fusion.

---

## Task 목록

### T16-1. SPLADE 채널 활성화 — Phase B

**현재:** 코드 있지만 flag=false. **주의:** SPLADE model/endpoint 자체가 미구축. Flag flip만으로 안 됨.

**변경:**
- SPLADE model serving 구축 (또는 hosted API)
- Lexical family collapsing 이미 구현 → 활성화만

---

### T16-2. Per-Query-Class Fusion (W0-4 심화) — Phase B

Week 0의 RRF k grid search를 기반으로:
- Query class별 최적 k + sparse/dense/anchor weight
- 장기: `FusionWeightPredictor` — query features → optimal params

---

### T16-3. Doc2Query / Document Expansion — Phase B

**왜:** lexical field에 query 용어가 없어서 BM25가 miss하는 경우를 줄인다.

**구현:**
- index-time synthetic query 생성
- `doc2query_text` field에 저장
- BM25 recall uplift는 `Recall@K`와 channel marginal gain으로 측정

---

### T16-4. Adaptive Cascade Routing — Phase C

**현재:** hard/medium/easy 3-tier 하드코딩

**변경:**
- `QueryDifficultyEstimator` — query features → cascade depth
- Easy: sparse only (~50ms). Hard: all channels + reranker (~500ms).
- Per-stage latency tracking (Epic-04 T04-4)과 연동

---

### T16-5. Dynamic Top-K — Phase C

query difficulty × latency budget → optimal K per channel.

---

### T16-6. ColBERT / Late-Interaction Reranking — Phase C

**이전 plan에서 완전 누락.**

**학계:** Khattab & Zaharia 2020, ColBERTv2 (Santhanam et al. 2022)

**왜:** Cross-encoder 품질 + bi-encoder 속도. Cohere Rerank 대비:
- Self-hosted 가능 (비용 $0)
- Wine domain fine-tune 가능
- Latency ~50ms for 50 docs (cross-encoder ~300ms)

**구현:**
- `ColBERTRerankAdapter` (ONNX, Node.js inference)
- Pre-computed token embeddings indexed in Vespa (ColBERT MaxSim)
- **또는:** Vespa의 native `colbert-embedder` 활용 (Vespa 8.x)

**위치:** Cohere Rerank의 대안 또는 보완 (cheaper, self-hosted)

---

### T16-7. Matryoshka Embeddings — Phase C

**이전 plan에서 완전 누락.**

**학계:** Kusupati et al. 2022 "Matryoshka Representation Learning"

**왜:** 현재 BGE-M3 1024차원 → ANN 비용 높음. Matryoshka는 단일 모델에서 multiple dimension (256, 512, 1024) 사용 가능.

**구현:**
- Easy query → 256차원 ANN (빠르지만 충분)
- Hard query → 1024차원 ANN (느리지만 정밀)
- Adaptive cascade (T16-4)와 연동

---

### T16-8. Condorcet Fusion 대안 검토

**학계:** Montague & Aslam 2002 "Condorcet Fusion"

RRF는 rank-only, score magnitude 무시. Condorcet는 pairwise comparison 기반.
Score distribution이 retriever마다 다를 때 (BM25 vs cosine) Condorcet가 RRF보다 나을 수 있음.

**구현:** Offline A/B — RRF vs Condorcet on eval set → 승자 채택.

---

## 완료 조건

- Phase B:
  - SPLADE 활성 + eval 측정
  - per-class fusion sweep 결과 존재
  - Doc2Query recall uplift 측정 가능
- Phase C:
  - adaptive cascade와 dynamic top-K 동작
  - ColBERT 또는 동급 late-interaction reranker 실험 가능
  - Matryoshka 기반 difficulty-aware ANN dimension control 가능
