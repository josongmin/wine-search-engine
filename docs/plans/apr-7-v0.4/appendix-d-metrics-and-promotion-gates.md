# Appendix D: Metrics and Promotion Gates

이 appendix는 `apr-7-v0.4`를 100점 문서에 가깝게 만들기 위한 정량 기준을 정의한다.  
핵심은 단순하다.

> SOTA++ 지향 엔진은 “좋아 보이는 구조”가 아니라  
> `측정 가능한 목표`, `승격 가능한 기준`, `회귀를 막는 게이트`
> 를 가져야 한다.

---

## 1. 최상위 목표

정량 목표는 네 축으로 본다.

1. `Relevance`
2. `Calibration / Selective prediction`
3. `Latency / Cost`
4. `Explanation / User trust`

평균 점수만 좋다고 승격하지 않는다.  
반드시 taxonomy slice와 운영 비용을 같이 본다.

---

## 2. Query taxonomy별 핵심 KPI

| Slice | Primary KPI | Secondary KPI | Notes |
|---|---|---|---|
| exact_entity | Success@1, MRR@10 | zero-bad-top1 rate | top-1 precision 절대 우선 |
| structured_filter | hard-constraint satisfaction | NDCG@10 | 필터 위반률 거의 0이어야 함 |
| sensory_taste | NDCG@10, pairwise win-rate | explanation helpfulness | human judgment 중요 |
| pairing_occasion | NDCG@10, pairwise win-rate | explanation faithfulness | 궁합 이유까지 같이 봐야 함 |
| similar_substitute | anchor-preservation rate | price/value substitution quality | 비슷함과 대체성이 둘 다 필요 |
| broad_exploration | refinement CTR | coverage/diversity | 정답 하나보다 탐색 품질 |
| long_nl_composed | task success rate | abstain precision, clarification usefulness | 억지 resolve보다 안전한 refine |

---

## 3. Offline relevance target bands

절대 수치는 데이터셋과 라벨 품질에 따라 달라지므로, 여기서는 운영 가능한 승격 밴드를 정의한다.

### 3.1 Retrieval layer

- hybrid baseline 대비 candidate recall uplift가 있어야 한다
- high-value slices에서 recall@100 또는 recall@200이 유의미하게 올라야 한다
- exact_entity에서 recall 향상 때문에 precision이 깨지면 승격 금지

권장 승격 밴드:

- `sensory/pairing/substitute/long-NL`: baseline 대비 `+5%` 이상 relative uplift
- `exact/filter`: recall보다 precision 보호 우선

### 3.2 Ranking layer

권장 승격 밴드:

- target slice NDCG@10 또는 win-rate가 baseline 대비 `+3%` 이상 relative uplift
- critical slice에서 `-1%` 이상 regression 발생 시 승격 금지

### 3.3 Exact safety band

exact_entity는 별도 규칙을 둔다.

- Success@1 regression 허용치: `0`
- zero-bad-top1 regression 허용치: `0`

즉 semantic lane이나 CE를 넣더라도 exact safety를 깨면 승격하지 않는다.

---

## 4. Calibration and abstention goals

SOTA++ 검색은 “많이 맞추는 것”만큼 “모를 때 멈추는 것”이 중요하다.

핵심 KPI:

- ECE
- selective risk
- abstain precision
- clarification recovery rate

권장 승격 밴드:

- ECE: baseline 대비 개선
- abstain precision: `0.8+` 목표
- clarification recovery rate: abstain 후 refine에서 성공률이 baseline direct resolve보다 높아야 함

특히 `long_nl_composed`, `pairing_occasion`, `sensory_taste`는 confidence calibration을 별도 slice로 본다.

---

## 5. Explanation quality goals

설명은 존재 여부가 아니라 품질로 본다.

핵심 KPI:

- evidence coverage
- explanation faithfulness
- explanation helpfulness
- unsupported-claim rate

권장 승격 규칙:

- explanation-required slices에서 evidence coverage가 기준 이하이면 승격 금지
- unsupported-claim rate가 baseline보다 나빠지면 승격 금지

설명 필수 slice:

- sensory_taste
- pairing_occasion
- similar_substitute
- long_nl_composed

---

## 6. Latency and cost gates

아무리 품질이 좋아도 serving cost를 깨면 승격하지 않는다.

핵심 KPI:

- p50 latency
- p95 latency
- p99 latency
- average candidate count
- rerank invocation rate
- cost per query

권장 운영 원칙:

- exact_entity, broad_exploration은 low-cost path 유지
- CE / late interaction은 gated selective serving
- rerank invocation rate는 slice별로 따로 본다

승격 규칙 예시:

- p95 latency가 production budget을 초과하면 승격 금지
- rerank invocation rate가 예산 대비 과도하면 gate 재설계 없이 승격 금지

---

## 7. Promotion gates by change type

### 7.1 New retriever lane

필수 조건:

- target slices recall uplift
- exact safety non-regression
- cost/latency gate 통과
- provenance / explanation compatibility 확인

### 7.2 New reranker

필수 조건:

- target slices NDCG / win-rate uplift
- explanation-required slices non-regression
- p95 latency gate 통과
- fallback path 존재

### 7.3 New gate policy

필수 조건:

- rerank invocation efficiency 개선
- target slice quality 유지 또는 개선
- low-value queries cost 감소

### 7.4 New ontology / explanation policy

필수 조건:

- explanation faithfulness 개선
- unsupported-claim rate 비악화
- target slice CTR 또는 human helpfulness 개선

---

## 8. Regression blocking rules

아래 중 하나라도 발생하면 승격 금지다.

1. exact_entity Success@1 regression
2. structured_filter hard-constraint 위반률 상승
3. long-NL / sensory / pairing에서 unsupported explanation 증가
4. p95 latency budget 초과
5. calibration 악화와 함께 forced resolve 증가
6. multilingual/transliteration slice 악화

즉 평균 점수 상승만으로는 충분하지 않다.

---

## 9. Recommended evaluation stack

### 9.1 Offline

- taxonomy slice eval
- hard negative replay
- multilingual/transliteration replay
- metadata-poor slice
- long-tail inventory slice

### 9.2 Human judgment

- sensory pairwise preference
- pairing quality judgment
- substitute usefulness judgment
- explanation helpfulness / faithfulness judgment

### 9.3 Pre-production

- replay determinism
- latency soak
- rerank invocation audit
- degradation reason audit

---

## 10. 한 줄 결론

SOTA++ 지향 엔진의 승격 기준은  
`평균 relevance 상승`이 아니라  
`taxonomy slice uplift + exact safety + calibration + explanation faithfulness + latency/cost gate`
를 동시에 만족하는 것이다.
