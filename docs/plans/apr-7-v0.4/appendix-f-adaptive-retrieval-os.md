# Appendix F: Adaptive Retrieval OS Direction

이 appendix는 `apr-7-v0.4`의 기본 SOTA++ 설계를 한 단계 더 밀어붙인 상한선 방향을 정리한다.  
핵심 아이디어는 아래 한 줄이다.

> 더 SOTA++로 가려면,  
> “검색기 하나를 더 좋게”가 아니라  
> **“쿼리별로 다른 계산 예산과 다른 표현 공간을 쓰는 적응형 retrieval OS”**
> 로 가야 한다.

---

## 1. 3표현 체계: dense 1개로 끝내지 않는다

더 상위권 retrieval은 최소 아래 세 표현을 같이 본다.

1. `lexical sparse`
exact name, winery, vintage, region, SKU-like entity에 강하다

2. `learned sparse`
단순 BM25보다 term importance와 expansion을 더 잘 잡는다

3. `late interaction / multi-vector`
감성형, 긴 자연어, 미묘한 의미 차이에 강하다

권장 해석:

- `BM25 only`는 구식
- `BM25 + dense`는 실무 상급
- `BM25 + learned sparse + late interaction`은 더 상위

와인 검색에서는 특히 아래 질의에서 late interaction 가치가 커진다.

- `부드럽고 우아한데 산미는 높지 않은 레드`
- `선물용으로 클래식하고 초보자도 접근 가능한 프랑스 와인`

즉 “semantic 검색을 넣었다”에서 멈추면 상한선이 아니다.

---

## 2. rerank는 1단이 아니라 3단 cascade가 맞다

상위 시스템의 랭킹은 보통 아래 구조로 수렴한다.

### Stage A. 대량 후보 생성

- BM25
- learned sparse
- dense / ANN
- facet prefilter

### Stage B. 중간 정밀화

- lightweight LTR
- lightweight late interaction
- query-type-aware fusion

### Stage C. 최종 판정

- cross-encoder
- top 10~30만

한 줄 요약:

- 1차는 recall
- 2차는 정리
- 3차는 판결

---

## 3. query taxonomy 위에 difficulty estimation을 얹어야 한다

상한선 서비스는 query type만 보지 않는다.

아래를 같이 본다.

- exact인데도 오탈자/음역/혼종언어가 심한가
- sensory인데 top results가 이미 잘 분리되는가
- sparse와 dense 상위 결과가 서로 충돌하는가
- metadata가 빈약한가

따라서 최종 경로는:

`IntentRoute × Difficulty × Value × LatencyBudget`

로 본다.

즉 같은 pairing query라도:

- 쉬우면 cheap path
- 어렵고 가치 높으면 expensive path

가 맞다.

---

## 4. document retrieval이 아니라 product-centered multi-view retrieval로 간다

와인 검색은 일반 문서 검색과 다르다.  
실제 검색 대상은 “문서”가 아니라 “상품의 여러 표현(view)”이다.

한 상품의 retrieval view 예시:

- canonical product title
- winery / region / vintage metadata
- tasting note view
- review aggregation view
- food pairing view
- gift / occasion suitability view
- similar-item neighborhood view

즉 구조는:

`query -> product view selection -> multi-view retrieval -> item-level merge`

가 맞다.

---

## 5. score fusion이 아니라 policy-driven ranking으로 간다

상위 시스템은 점수 합산만 하지 않는다.

더 맞는 구조는:

```text
FinalRank =
Relevance
+ ConstraintFit
+ CatalogQuality
+ Availability
+ BusinessPrior
- UncertaintyPenalty
```

핵심은 마지막이다.

uncertainty penalty 예시:

- sparse/dense/late-interaction 간 충돌
- metadata 불완전
- tasting note coverage 빈약
- vintage confidence 낮음
- substitute explanation 약함

즉 점수가 높다고 바로 올리는 게 아니라, 자신감이 낮은 결과를 내리거나 refine UX로 보내는 구조가 상한선이다.

---

## 6. personalization은 협업필터링보다 taste state modeling이 맞다

와인처럼 취향 편차가 큰 카테고리는 개인화를 더 세분화해야 한다.

### Persistent taste profile

- 산도 선호
- 바디 선호
- 탄닌 허용도
- 오크 허용도
- 가격 민감도
- 선물 vs 실사용 비중

### Session taste state

- 오늘은 스테이크용인지
- 선물 찾는지
- 초보자 동행인지
- 예산이 평소보다 낮은지

최종 랭킹은:

`Global relevance × User taste fit × Session intent fit`

으로 보는 게 맞다.

---

## 7. explanation은 사후 문구가 아니라 rank feature surface여야 한다

약한 시스템은 검색 후 LLM이 이유를 꾸며낸다.  
상한선 시스템은 explanation이 ranking evidence에서 직접 나온다.

예:

- pairing_match = 0.91
- acidity_fit = high
- oak_penalty = low
- gift_suitability = premium_classic
- anchor_similarity = 0.84

UI surface 예:

- `스테이크 페어링 점수가 높음`
- `과일향/오크/탄닌 프로필이 요청과 일치`
- `Opus One 대비 보르도 블렌드 스타일 유사, 가격은 낮음`

즉 explanation은 생성문이 아니라 retrieval/ranking evidence의 surface다.

---

## 8. offline tuning에서 끝내지 않고 online learning loop를 닫아야 한다

진짜 상위 시스템은 relevance 팀의 수동 조정만으로 운영하지 않는다.

닫아야 할 루프:

- query type별 CTR / add-to-cart / purchase
- reformulation rate
- zero-result / low-confidence rate
- reranker on/off uplift
- explanation 노출 후 전환 변화
- substitution acceptance rate

그리고 이를 바탕으로:

- fusion weight 조정
- gate threshold 조정
- CE 적용 범위 조정
- ontology / descriptor 확장
- catalog quality repair

를 자동 또는 반자동으로 반복한다.

즉 SOTA++는 모델 하나가 아니라 `retrieval system + policy layer + eval loop` 전체가 닫혀 있어야 한다.

---

## 9. 최종 상위 구조

```text
[Query]
  ↓
Intent + Difficulty + Value Estimator
  ↓
Multi-route Candidate Generation
  ├ lexical sparse
  ├ learned sparse
  ├ dense ANN
  ├ late interaction shortlist
  ├ structured facet
  └ ontology / substitute / multi-view lanes
  ↓
Intent-aware Fusion
  ↓
LTR / mid-stage rerank
  ↓
Cross-encoder gate
  ├ OFF -> return
  └ ON  -> top-N cross-encoder rerank
  ↓
Policy layer
  ├ uncertainty penalty
  ├ availability / quality constraints
  ├ personalization / taste state
  └ abstain / refine UX
  ↓
Result + Evidence-backed Explanation
```

---

## 10. 우리 문서에 실제로 반영할 것

이 appendix를 기준으로 `apr-7-v0.4`에서 실제로 강화해야 할 부분은 아래다.

1. `multi-lane retrieval`을 `3표현 체계 + multi-view retrieval`로 더 구체화
2. `R1 lightweight LTR`을 `mid-stage rerank`까지 포함하는 계층으로 재정의
3. taxonomy만이 아니라 `difficulty estimation`을 gate/budget policy에 포함
4. policy layer에서 `uncertainty penalty`를 1급 축으로 승격
5. personalization을 `taste state modeling` 방향으로 명시
6. explanation을 `rank feature surface`로 더 강하게 고정
7. online learning loop를 roadmap의 상위 wave에 명시

---

## 11. 한 줄 결론

`hybrid + rerank`만으로도 실무 상급은 된다.  
하지만 더 SOTA++로 가려면  
**`adaptive retrieval OS`**
즉
`Intent + Difficulty + Value + Budget`에 따라  
다른 표현 공간, 다른 계산 예산, 다른 판정 깊이를 쓰는 구조로 가야 한다.
