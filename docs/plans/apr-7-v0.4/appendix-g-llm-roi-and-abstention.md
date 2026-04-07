# Appendix G: LLM ROI, Abstention, and MVP-to-SOTA++ Path

이 appendix는 LLM을 어디에 써야 ROI가 높고, 어디에 쓰면 검색 코어를 망치는지 정리한다.  
핵심 원칙은 아래 한 줄이다.

> LLM은 검색을 대체하는 엔진이 아니라  
> **검색이 deterministic하게 풀지 못하는 부분만 때리는 보조 계층**일 때 ROI가 가장 높다.

---

## 1. 왜 100% 커버는 불가능한가

SOTA++ 시스템도 모든 query를 완벽하게 커버할 수는 없다.  
핵심 이유는 세 가지다.

### 1.1 언어는 열려 있다

사용자는 같은 의도를 무한한 표현으로 말한다.

예:

- `부드러운 와인`
- `목 넘김 좋은 와인`
- `떫지 않은 와인`
- `입문자용`

ontology와 embedding으로도 이 공간을 100% 닫을 수는 없다.

### 1.2 catalog는 불완전하다

실제 상품 데이터는 늘 빈틈이 있다.

- tasting note 없음
- vintage 오기
- region 누락
- review 부족

즉 retrieval/reranking이 좋아도 데이터가 없으면 맞출 수 없다.

### 1.3 intent ambiguity는 본질적이다

예:

- `좋은 와인 추천`

이건:

- 가격 기준인지
- 선물인지 일상음용인지
- 드라이인지 스위트인지

가 전부 비어 있다.

즉 정답이 애초에 하나가 아니다.

---

## 2. 그래서 목표가 바뀐다

SOTA++ 시스템의 목표는:

- `모든 쿼리를 맞춘다`가 아니라
- `틀릴 때도 안전하게 대응한다`

이다.

상위 시스템과 하위 시스템의 차이는 여기서 난다.

- 하위 시스템: 무조건 결과를 낸다
- 상위 시스템: 확신 높으면 결과, 낮으면 보정/질문/탐색 유도

즉 핵심 KPI는 단순 accuracy가 아니라:

`Coverage × Calibration × Safety`

다.

---

## 3. Abstention layer는 선택이 아니라 필수다

반드시 들어가야 한다.

### 3.1 low-confidence detect

confidence가 낮으면 바로 결과를 밀어내지 않는다.

핵심 신호 예:

- retrieval agreement
- rerank margin
- metadata completeness
- feature consistency
- evidence sufficiency

### 3.2 대응 전략

#### A. refinement 유도

- `어떤 스타일 찾으세요?`
- `가격대를 선택해 주세요`

#### B. diversified results

정답 하나 대신 스타일별 후보를 나눠 보여준다.

#### C. explanation-backed results

왜 이 결과를 냈는지 함께 보여줘서 low-confidence 상황을 완화한다.

#### D. fallback strategy

- 인기 상품
- curated collection
- guided exploration

### 3.3 coverage 해석

이 구조를 쓰면 대략:

- exact / filter / 일반 pairing / 일반 substitute는 매우 높게 커버
- long-tail sensory / niche pairing / 희귀 조합은 중간 수준
- 완전 모호 질의 / catalog 밖 개념 / 모순 질의는 구조적으로 어렵다

즉 완전 커버보다 안전한 커버가 중요하다.

---

## 4. LLM이 ROI 높게 먹히는 위치

LLM을 무조건 많이 쓰는 게 아니라,  
`품질 상승 × 영향도 / 비용 × latency × 불확실성`
관점으로 본다.

### 4.1 Query understanding / decomposition

가장 높은 ROI 영역 중 하나다.

예:

`산미 너무 높지 않고 오크 과하지 않으면서 육류랑 맞는 10만원대 레드`

LLM이:

- hard constraints
- soft preferences
- pairing target
- ambiguity / missing slots

를 구조화하면 retrieval 성능에 직접 도움이 된다.

### 4.2 Ontology expansion

매우 ROI 높다.

예:

- `스테이크` -> cabernet / syrah / malbec prior
- `부드러운` -> low tannin / soft mouthfeel / fruit-forward

룰만으로는 한계가 있고, LLM이 semantic expansion에 강하다.

### 4.3 Explanation generation

근거 기반일 때 ROI가 높다.

예:

- `블랙베리 풍미와 탄닌 구조가 스테이크와 잘 어울림`

단, 전제는 explanation이 evidence-grounded여야 한다는 점이다.

### 4.4 Substitute reasoning

매우 ROI 높다.

예:

- `Opus One 비슷한데 더 싼 거`

LLM은:

- anchor의 중요한 속성을 요약
- substitute candidate 간 차이를 설명
- 대체 이유를 자연어로 surface

하는 데 강하다.

### 4.5 Low-confidence interaction

retrieval이 애매할 때:

- 질문 되묻기
- 옵션 제시
- 탐색 경로 유도

에 LLM이 강하다.

즉 잘못된 결과를 확신 있게 내는 것보다 훨씬 낫다.

---

## 5. 반대로 LLM ROI가 낮은 위치

여기엔 쓰면 안 된다.

### 5.1 전체 catalog 검색 대체

- hallucination
- latency
- 비용
- recall 불안정

때문에 검색 코어를 대체하는 건 좋지 않다.

### 5.2 exact query 처리

예:

- `Opus One 2019`

이런 건 BM25/alias/vintage parser가 더 빠르고 정확하다.

### 5.3 strict filtering / deterministic ranking

가격, 재고, hard constraint, policy-compliant ranking은 deterministic core가 맡아야 한다.

### 5.4 high-throughput 영역

- typeahead
- autosuggest
- listing page 기본 검색

은 LLM 위치가 아니다.

---

## 6. 그래서 LLM의 위치는 “앞과 뒤”다

권장 구조:

```text
[Query]
   ↓
LLM (Query Understanding / Decomposition / Ontology Expansion)
   ↓
Retriever + Ranker Core (Deterministic)
   ↓
LLM (Explanation / Clarification / Fallback Interaction)
```

핵심:

- 앞단: 이해
- 중단: deterministic retrieval/ranking core
- 뒷단: 설명 / 상호작용 / 저확신 대응

즉 LLM은 코어가 아니라 **front/back assist layer**다.

---

## 7. MVP에서는 어떻게 보나

### 7.1 MVP에서 raw data + LLM은 “돌아간다”

초반에는:

- semantic understanding
- 간단한 filter 추론
- 상위 후보 정리
- explanation

정도는 LLM이 raw text만 받아도 꽤 그럴듯하게 처리한다.

특히:

- sensory
- pairing
- long 자연어

에서는 MVP 체감이 좋다.

### 7.2 하지만 이 상태로 오래 가면 망한다

이유:

- deterministic하지 않음
- hallucination
- catalog scale 한계
- latency / 비용
- business/policy control 약함

즉 MVP에서는 가능하지만, 그건 “정답 구조”가 아니라 “초기 부트스트랩 구조”다.

### 7.3 추천 MVP 구조

```text
[Query]
   ↓
간단한 retrieval (BM25 or vector)
   ↓
Top 20~50 후보
   ↓
LLM
   - query understanding
   - light rerank / filtering assist
   - explanation
   ↓
결과
```

즉 `LLM-first`가 아니라 `LLM-assisted retrieval MVP`가 sweet spot이다.

---

## 8. MVP에서 맡겨도 되는 것 / 맡기면 안 되는 것

### 맡겨도 되는 것

- query 이해
- filter 추론
- ontology expansion
- explanation
- substitute reasoning
- low-confidence 대응

### 맡기면 안 되는 것

- 전체 catalog 검색
- strict constraint enforcement
- exact entity resolution
- deterministic final ranking
- policy-critical business control

---

## 9. 언제 deterministic core로 전환해야 하나

아래 시점이 오면 구조를 바꿔야 한다.

- 상품 수가 커짐
- 트래픽 증가
- latency 요구 증가
- 이상 추천으로 CS 발생
- 인기상품 / 재고 / 가격 정책 제어 필요
- 검색 결과 일관성 요구 증가

즉 MVP에서 성공하면 오히려 더 빨리 deterministic core로 옮겨야 한다.

---

## 10. 우리 문서 기준 최종 원칙

이 appendix를 기준으로 `apr-7-v0.4`에서 LLM에 대해 최종적으로 고정할 원칙은 아래다.

1. `이해 문제`에는 LLM을 적극 쓴다
2. `검색 문제`는 deterministic retrieval/ranking core로 푼다
3. low-confidence 상황은 abstain/refine/diversify로 다룬다
4. explanation은 free-form 생성보다 evidence-grounded generation을 우선한다
5. MVP에서는 LLM-assisted retrieval가 가능하지만, scale 단계에서는 core를 deterministic하게 옮긴다

---

## 11. 한 줄 결론

LLM은 와인 검색에서 분명 큰 가치를 준다.  
하지만 SOTA++ 구조에서의 역할은:

- 검색 정확도를 직접 책임지는 코어 엔진이 아니라
- query understanding, ontology expansion, explanation, abstention/refinement를 담당하는 **고ROI 보조 계층**

이다.
