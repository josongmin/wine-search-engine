# Epic 5: Ranking Funnel Redesign

**성격:** must  
**목표:** 현재 ranker/rerank/LTR scaffold를 stage-based ranking funnel로 재구성한다.  
**의존성:** Epic 3, Epic 4

---

## 왜 필요한가

현재 [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)는 이미 상당히 잘 짜여 있다.  
하지만 앞으로 provenance-rich candidate, learned sparse, relative retrieval를 넣으면 “한 ranker가 다 아는” 방식은 오래 못 간다.

이 epic은 ranking을 더 똑똑하게 만드는 동시에, 더 분해 가능한 구조로 바꾸는 작업이다.

---

## 목표 상태

```text
Stage A: coarse pruning
Stage B: channel-aware primary rank
Stage C: selective precision rerank
Stage D: final policy rank
```

---

## 레포에서 건드리는 축

- [ranker.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ranker.ts)
- [signal-computer.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/signal-computer.ts)
- [score-aggregator.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/score-aggregator.ts)
- [ltr-feature-extractor.ts](/Users/songmin/wine-search-engine/src/domain/ranking/service/ltr-feature-extractor.ts)
- [search-usecase-ltr-rerank.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-ltr-rerank.ts)

---

## In Scope

- stage-based ranking contract
- provenance-aware features
- selective rerank policy
- relevance vs policy separation
- stage-aware eval reporting

## Out Of Scope

- user personalization
- full API redesign
- index projection rewrite

---

## 핵심 작업

### Step 1. Ranking stage contract 정의

각 단계의 입력/출력을 타입과 메트릭으로 분리한다.

### Step 2. Provenance-aware features 확장

channel id, matched query view, anchor-conditioned signals, relative signals를 ranking features로 공식 편입한다.

### Step 3. Selective rerank 정책화

모든 쿼리에 똑같이 cross-encoder/LTR를 태우지 않고, query family별 precision stage를 차등 적용한다.

### Step 4. Final policy rank 분리

relevance score와 product policy를 한 단계에서 섞지 않고, 마지막 stage에서 명시적으로 다룬다.

### Step 5. Stage metrics / explainability

각 stage에서 어떤 후보가 탈락하고 어떤 signal이 승격에 기여했는지 분석 가능한 메트릭을 남긴다.

---

## 설계 원칙

1. ranking은 retrieval의 실수를 감추는 블랙박스가 아니다.
2. stage는 각각 독립적으로 측정 가능해야 한다.
3. policy와 relevance는 구분한다.
4. LTR는 provenance 없는 feature 위에서 학습하지 않는다.

---

## 완료 기준

- ranking stage별 입력/출력이 명시된다.
- channel/provenance feature가 ranking SSOT에 포함된다.
- rerank 비용이 query-dependent policy로 제어된다.
- offline eval이 stage-aware 분석을 제공한다.

## 검증 전략

- ranker unit tests
- stage transition tests
- LTR feature contract tests
- quality/nightly eval slice
