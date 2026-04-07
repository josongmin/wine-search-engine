# Appendix E: Risk and Rollback Rules

이 appendix는 높은 목표로 갈수록 같이 커지는 리스크를 정리한다.  
SOTA++ 지향 엔진은 강한 모델을 더 넣는 만큼, 실패 모드와 롤백 원칙을 먼저 가져야 한다.

---

## 1. 기본 원칙

1. exact safety를 깨는 변화는 즉시 롤백 가능해야 한다
2. expensive lane과 reranker는 feature-gated여야 한다
3. 새 score는 기존 relevance를 뒤집기 전에 banded rollout을 거쳐야 한다
4. unsupported explanation은 quality regression으로 취급한다
5. rollback은 model rollback과 policy rollback을 분리한다

---

## 2. 주요 리스크 표

| Area | Risk | Symptom | Guardrail | Rollback |
|---|---|---|---|---|
| hybrid fusion | dense가 exact를 밀어냄 | wrong top-1 exact | exact safety band | dense weight / lane off |
| learned sparse | noisy expansion | weird lexical drift | exact/filter slice gate | lane off |
| late interaction | latency 폭증 | p95/p99 악화 | selective serving only | gate threshold 상향 / lane off |
| CE rerank | semantic overreach | plausible but wrong top results | gated top-K, explanation audit | rerank off or top-K down |
| ontology prior | 규칙 과잉 개입 | stereotyped pairing | prior capped as feature only | prior weight 0 |
| business signals | relevance inversion | stock/popular but irrelevant | relevance banding | business layer off |
| explanation | unsupported claims | “그럴듯한 헛소리” | evidence threshold | explanation suppress |
| calibration | overconfident resolve | refine해야 할 query를 억지 resolve | abstain gate | fallback to clarify |
| session context | leakage / overfit | weird continuation bias | context scope limits | session-aware off |

---

## 3. Rollout stages

새로운 lane, reranker, gate, ontology는 아래 단계로만 승격한다.

1. `offline only`
2. `shadow / replay`
3. `slice-limited serving`
4. `budget-limited production`
5. `full production`

원칙:

- exact_entity와 structured_filter는 마지막에 확대한다
- sensory/pairing/substitute 같은 high-value slice에서 먼저 검증한다

---

## 4. What rolls back independently

### 4.1 Model rollback

대상:

- dense encoder
- learned sparse encoder
- late interaction model
- cross-encoder
- LTR weights

조건:

- quality regression
- latency/cost regression
- multilingual/transliteration regression

### 4.2 Policy rollback

대상:

- lane mix table
- CE gate threshold
- candidate budget
- business weight
- explanation obligation

조건:

- model 자체는 좋은데 serving policy가 잘못된 경우

### 4.3 Data / ontology rollback

대상:

- pairing taxonomy
- descriptor normalization
- alias expansion rules
- catalog priors

조건:

- 특정 slice에서 systematic bias 유발

---

## 5. Safe defaults

고장났을 때 기본 후퇴 경로도 먼저 정해둬야 한다.

- exact query -> lexical-only safe mode
- structured filter -> hard-filter + sparse baseline
- sensory/pairing -> hybrid baseline + explanation suppress
- substitute -> anchor lane off, mixed baseline fallback
- long-NL -> abstain/refine fallback

즉 fail-open보다 **safe backoff**가 우선이다.

---

## 6. Rollback triggers

아래는 자동 또는 준자동 롤백 후보로 본다.

1. exact_entity top-1 wrong-result spike
2. structured_filter hard-constraint violation spike
3. p95 latency budget breach
4. rerank invocation rate surge
5. unsupported explanation spike
6. multilingual/transliteration slice failure spike
7. abstain should-have-fired slice failure increase

---

## 7. 운영 결론

높은 목표로 간다는 건 공격적으로 새로운 모델을 넣는다는 뜻이 아니다.  
**강한 모델을 넣어도 exact safety, latency, explanation faithfulness, abstain quality를 깨지 않게 운영하는 것**이 진짜 SOTA++ 운영 수준이다.
