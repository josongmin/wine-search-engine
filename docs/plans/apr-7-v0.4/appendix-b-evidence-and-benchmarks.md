# Appendix B: Evidence and Benchmarks for the SOTA++ Direction

이 appendix는 `apr-7-v0.4`에서 제안한 방향이 단순한 취향이나 추상론이 아니라,  
업계 공식 문서와 학계 대표 결과들에 어떻게 기대고 있는지를 요약한다.

핵심 질문은 두 가지다.

1. 왜 `hybrid + rerank + multi-lane`이 합리적인가
2. 왜 taxonomy / routing / gate가 “부수적인 운영 디테일”이 아니라 상한선 구조의 핵심인가

---

## 1. Hybrid first-stage retrieval는 업계에서 이미 기본 패턴이다

### 1.1 OpenSearch

OpenSearch는 hybrid search를 공식 기능으로 제공하고, normalization processor와 rank fusion을 아키텍처 일부로 문서화한다.

- hybrid는 lexical과 vector/semantic 결과를 결합하는 패턴으로 설명된다
- normalization은 score scale mismatch를 줄이기 위한 필수 계층으로 다뤄진다
- rank fusion도 공식 블로그/문서에서 권장 패턴으로 다룬다

근거:

- [OpenSearch hybrid search docs](https://docs.opensearch.org/3.2/vector-search/ai-search/hybrid-search/index/)
- [OpenSearch normalization processor](https://docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/)
- [OpenSearch rank normalization blog](https://opensearch.org/blog/How-does-the-rank-normalization-work-in-hybrid-search/)

의미:

- hybrid는 “새로운 실험 옵션”이 아니라 이미 search platform 레벨의 표준 기능이다
- lane score를 합칠 때 normalization과 fusion policy가 필수라는 점이 공식적으로 뒷받침된다

### 1.2 Elastic

Elastic도 hybrid search를 lexical + semantic 결합으로 설명하고, RRF를 권장한다.

근거:

- [Elastic hybrid search docs](https://www.elastic.co/docs/solutions/search/hybrid-search/)

의미:

- OpenSearch와 Elastic이 모두 hybrid를 기본 패턴으로 문서화한다는 건, 실무적으로 sparse 단독이나 dense 단독보다 hybrid가 더 넓은 query set에서 robust하다는 뜻이다

---

## 2. Cross-encoder는 “기본 검색기”가 아니라 2차 precision reranker다

Sentence Transformers 공식 문서는 retrieve-and-rerank 구조를 대표 패턴으로 설명한다.

- bi-encoder는 빠른 1차 retrieval에 적합
- cross-encoder는 query-document pair를 직접 판정해 더 정확하지만 느림
- 따라서 top-K reranking에 붙이는 것이 권장 구조

근거:

- [Sentence Transformers retrieve & rerank](https://www.sbert.net/examples/applications/retrieve_rerank/README.html)
- [Cross-encoder usage](https://sbert.net/docs/cross_encoder/usage/usage.html)
- [Cross-encoder training overview](https://www.sbert.net/docs/cross_encoder/training_overview.html)

의미:

- `CE를 모든 query에 기본으로 적용`하는 건 공식 권장 구조와 다르다
- exact/typeahead/filter/browse에는 ROI가 낮고, semantic/ambiguous/long-NL/high-value query에서 이득이 커지는 구조가 합리적이다

---

## 3. 학계 상한선은 dense-only가 아니라 learned sparse와 late interaction까지 간다

### 3.1 BEIR

BEIR는 heterogeneous zero-shot IR benchmark로 자주 인용되는 대표 축이다.

근거:

- [BEIR paper](https://arxiv.org/abs/2104.08663)

의미:

- BM25는 여전히 매우 강한 robust baseline이다
- dense retrieval은 강하지만, 모든 도메인에서 단독으로 BM25를 안정적으로 압도한다고 보기 어렵다
- reranking / stronger interaction 모델이 상위 precision에서 중요하다

즉 BEIR는 `BM25를 버리고 dense-only`로 가는 논리를 지지하지 않는다.

### 3.2 SPLADE

SPLADE 계열은 learned sparse retrieval의 대표다.

근거:

- [SPLADE paper](https://arxiv.org/abs/2107.05720)

의미:

- lexical match의 강점을 neural 방식으로 확장하면서 first-stage retrieval 품질을 끌어올릴 수 있다
- exactness와 semantic expansion 사이의 다리를 제공한다

즉 `BM25 + learned sparse`는 매우 합리적인 중간 상한선이다.

### 3.3 ColBERTv2

late interaction retrieval의 대표 축이다.

근거:

- [ColBERTv2](https://aclanthology.org/2022.naacl-main.272/)

의미:

- single-vector dense보다 더 정교한 token-level interaction으로 high-precision retrieval 상한을 높인다
- 비용이 더 크기 때문에 selective activation이 필요하다

즉 SOTA++ 상한선을 논할 때 late interaction은 backlog가 아니라 “도입 시점을 조절할 대상”이다.

### 3.4 BGE-M3 / M3-Embedding

dense, sparse, multi-vector를 한 계열에서 다루는 최근 강한 실전형 축이다.

근거:

- [M3-Embedding paper](https://aclanthology.org/2024.findings-acl.137/)
- [BGE-M3 model card](https://huggingface.co/BAAI/bge-m3)

의미:

- modern retrieval은 `single dense encoder` 하나로 끝나지 않는다
- dense / sparse / multi-vector를 함께 고려하는 multi-lane 설계가 더 현재적이다
- multilingual retrieval까지 고려하면 와인 검색처럼 한영혼합/전사 문제가 있는 도메인과 잘 맞는다

---

## 4. staged ranking은 industry platform 수준에서 이미 표준 구조다

Vespa는 phased ranking을 공식 구조로 둔다.

- first-phase: 싸고 넓은 랭킹
- second/global-phase: 더 비싼 모델로 상위 N 정리
- rerank-count / phased ranking으로 비용을 통제

근거:

- [Vespa phased ranking](https://docs.vespa.ai/en/phased-ranking.html)

의미:

- `R0 assembly -> R1 cheap ranking -> R2 expensive rerank`는 임의 설계가 아니라 플랫폼 레벨의 표준 설계와 맞닿아 있다
- 따라서 `LTR broad, CE narrow`는 정당한 목표다

---

## 5. reasoning-intensive query는 그냥 좋은 retriever 하나로 해결되지 않는다

최근 benchmark들은 reasoning-intensive retrieval에서 기존 retrieval 모델의 약점을 드러낸다.

근거:

- [BRIGHT benchmark](https://arxiv.org/abs/2407.12883)

의미:

- 복잡한 long-NL, 다제약, composed query는 retrieval만으로 끝나지 않는다
- query decomposition, route-aware gating, abstention, explanation이 중요해진다

와인 검색에서 이는 다음과 직결된다.

- `오크가 과하지 않고 산미가 너무 높지 않으면서 미디엄 바디 이상`
- `부모님 선물용으로 클래식한데 초보자도 마시기 쉬운 프랑스 와인`

이런 질의는 단순 semantic search보다 **query understanding + all-lane retrieve + gated rerank + explanation**이 맞다.

---

## 6. 그래서 왜 “가장 중요한 셋”이 hybrid, rerank, multi-lane인가

근거를 종합하면:

1. `Hybrid retrieval`
OpenSearch/Elastic 문서 레벨에서 이미 표준 패턴이다.

2. `Precision rerank`
Sentence Transformers와 Vespa 관점에서 top-K 정밀 판정 계층이 표준이다.

3. `Multi-lane retrieval upgrade`
SPLADE, ColBERTv2, BGE-M3가 보여주듯 상한선은 dense-only가 아니라 sparse/learned sparse/multi-vector로 올라간다.

즉 상한선 성능을 가장 많이 올리는 셋은:

- hybrid first-stage retrieval
- staged precision rerank
- multi-lane retrieval upgrade

이다.

---

## 7. taxonomy / routing / gate가 왜 같이 중요하냐

논문이 hybrid, rerank, late interaction을 보여준다고 해서 제품에서 자동으로 이득이 나지 않는다.

실제 서비스에서는 다음이 필요하다.

- 어떤 query에 어떤 lane을 태울지
- 어떤 query에 expensive rerank를 켤지
- 언제 abstain할지
- 어떤 explanation을 의무화할지

즉 taxonomy / routing / gate는 “보조 설계”가 아니라,  
위 세 모델 축의 효과를 실제 서비스 품질로 바꾸는 운영 계층이다.

이 때문에 `apr-7-v0.4`는 모델 선택 문서가 아니라 policy architecture 문서로도 함께 서 있다.

---

## 8. 실무적으로 가장 방어적인 해석

공신력 있는 자료를 종합하면 가장 방어적인 결론은 이렇다.

- sparse를 버리면 안 된다
- dense만으로 끝나지 않는다
- expensive reranker는 top-K에만 써야 한다
- 상한선 precision은 late interaction / learned sparse / CE가 끌어올린다
- 복잡한 composed query는 query-aware routing과 gating이 필요하다

즉 `hybrid + multi-lane + gated rerank`는 과한 설계가 아니라,  
현재 기준으로 가장 정석적이고 상한선 지향적인 설계다.
