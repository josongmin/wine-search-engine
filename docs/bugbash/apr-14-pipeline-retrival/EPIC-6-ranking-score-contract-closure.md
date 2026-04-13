# EPIC-6 Ranking / Score Contract Closure

## 문제 정의

ranking/result projection 쪽에는 깨진 score signal을 정상 ranking처럼 보이게 만드는 masking seam이 남아 있다. 이건 authority leak이자 observability 훼손이다.

## 현재 코드 근거

- rerank normalization 실패 시 original heuristic score로 돌아간다: [ranker.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/ranking/service/ranker.ts:1234>)
- uncertainty penalty NaN은 neutral confidence `0.5`로 위장한다: [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:24>), [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:349>)
- projection 단계에서 missing sensory/derived signal을 neutral midpoint로 채우면 downstream 설명력이 오염된다: [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:202>)
- feature extraction은 missing authority를 fabricated prestige/feature 값으로 바꾸면 안 된다: [signal-computer.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/ranking/service/signal-computer.ts>), [ltr-feature-extractor.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/ranking/service/ltr-feature-extractor.ts>)
- cross-encoder output이 malformed면 partial accept가 아니라 hard failure가 맞다: [cohere-reranker.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/ai/cohere-reranker.ts>)
- result item projection은 provenance-aware scoreComponents를 표면화한다: [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:297>)

## 목표 불변식

1. rerank lane failure는 "reranked result"처럼 보이지 않는다.
2. NaN/broken uncertainty signal은 neutral confidence로 둔갑하지 않는다.
3. `matchType`, `lexical`, `semantic`, `attribute` score components는 provenance-consistent하다.
4. deprecated `retrievalFusionScore` 의미 오염 read-site를 정리한다.
5. projection-time derived signal은 missingness를 보존한다.

## breaking changes

- rerank normalization failure는 explicit degraded contract로 승격
- uncertainty confidence는 missing/broken 시 undefined 또는 degradation reason으로 노출
- result item scoreComponents contract 재정의 가능
- malformed reranker response는 partial score 사용 없이 hard failure로 간주한다.

## 구현 작업 목록

1. rerank normalization failure policy를 결정하고 contract 문서화
2. `UNCERTAINTY_CONFIDENCE_NEUTRAL` 제거
3. result item projection을 entity/hybrid/mixed provenance 기준으로 다시 고정
4. fused retrieval score와 final ranking score의 용어 분리 점검
5. predictor/feature extractor 입력에서 missing sensory, prestige, rerank score를 fabricated midpoint로 채우지 않게 정리한다.
6. malformed cross-encoder output은 batch partial accept 없이 reject contract로 통일한다.

## 테스트 / 게이트

- rerank normalization failure contract test
- NaN uncertainty degraded contract test
- route별 result item projection snapshot
- missing sensory/projection signal preserved-as-absent test
- malformed reranker response hard-fail test

## merge 조건

- broken score signal이 정상 ranking confidence처럼 보이는 경로가 없다.
- derived feature/projection 입력이 fabricated midpoint authority로 승격되지 않는다.
