# Epic 13 — Eval 인프라: Retrieval Ceiling과 Phase B Gate

**Phase:** A (기반) — **Phase B의 필수 전제**
**우선순위:** P1
**의존:** Week 0 W0-3 (`compareScore` deterministic contract)
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `학습 불필요`

---

## 왜 — SOTA++ 구조적 의미

**측정할 수 없으면 개선할 수 없고, retrieval과 ranking을 분리 측정할 수 없으면 잘못 최적화한다.**

이 epic의 목적은 단순히 NDCG를 더 많이 보는 것이 아니다.
Phase B/C의 모든 변경을 아래 세 층으로 분리 측정 가능하게 만드는 것이다.

1. **Retrieval ceiling**: 정답이 top-K 안에 들어왔는가
2. **Ranking quality**: 들어온 후보를 얼마나 잘 올렸는가
3. **Decision quality**: 올린 후보를 얼마나 올바르게 resolve / abstain 했는가

**업계 SOTA:**
- Google: Team Draft / interleaving + query-slice 분석
- Netflix: offline metric과 online A/B correlation 검증
- Airbnb: retrieval recall과 ranking metric을 분리 관리

---

## Task 목록

### T13-1. Scorer 버그 수정

- `PENALTY_TOOL_DUPLICATE` 역전 수정
- silent `''` 반환 제거, diagnostic 보존
- `EPS = 1e-6` 같은 magic constant에 domain justification 부여

### T13-2. Runner 안전성

- `as T` 제거 또는 guard 추가
- `apiKey ?? ''` 제거, early fail
- substring 기반 transient 판정 제거, structured error code 기반으로 교체

### T13-3. Constraint Metrics 정확도

- greedy slot matching의 trade-off 문서화 또는 Hungarian 도입
- CSR attribute-aware 추출로 정정
- vacuous truth 오판 수정

### T13-4. 누락 테스트

`extractVintageYears`, `extractKoreanPrices`, `extractProperNouns`, `evaluatePredicate`에 회귀 테스트 추가.

### T13-5. Dead Code 정리

- `constraint-extraction-evaluator.ts` 제거
- `regionsRelated()` 제거
- unwired eval helper는 연결하거나 삭제

### T13-6. Human-Gated Labeled Dataset 구축

**핵심 gate.** LLM judge-only dataset로는 Phase B를 승인하지 않는다.

**데이터 세트 분리:**
- `gold-human/`: 고정 human-reviewed gold split
- `silver-llm/`: scale-out용 LLM-labeled split
- `calibration/`: threshold/ECE/AURC용 holdout

**최소 기준:**
- human-reviewed judgments >= 500
- total judgments >= 2000
- query class별 coverage 확보
- difficult / ambiguous / zero-result query 의도적으로 포함

### T13-7. Retrieval Ceiling Metrics 추가

**이전 문서에서 빠져 있던 핵심.**

반드시 산출해야 하는 지표:
- `Recall@20`, `Recall@50`, `Recall@100`
- `Oracle NDCG@10`
- `Oracle MRR`
- channel별 marginal gain
- query-class별 retrieval coverage
- zero-result rate

이 지표가 있어야 `Epic-10` 개선이 retrieval win인지 ranking win인지 분리 가능하다.

### T13-8. Ranking / Diversity Metrics 확장

- `NDCG@10`, `NDCG@20`
- `MRR`
- `MAP`
- `α-nDCG`
- intent-weighted slicing
- degradation-aware slicing

### T13-9. Train/Serve Feature Parity 검증

LTR와 calibration은 train-serve skew가 생기면 무의미하다.

**변경:**
- 학습 시 사용한 feature schema snapshot 저장
- 온라인 serving 시 동일 schema hash 기록
- parity mismatch 시 model gate reject

### T13-10. LLM Judge Bias Correction

LLM judge는 보조 라벨러이지 최종 심판이 아니다.

**변경:**
- inter-judge agreement 측정
- position swap test
- 월간 human audit
- human gold split과의 disagreement rate 추적

---

## 완료 조건

- human-reviewed gold split 존재
- total judgments >= 2000, human-reviewed >= 500
- retrieval metrics: `Recall@20/50/100`, `Oracle NDCG@10`, `Oracle MRR`
- ranking metrics: `NDCG@{10,20}`, `MRR`, `MAP`, `α-nDCG`
- LLM judge bias correction 동작
- train/serve feature parity 체크 가능
- scorer bug 0건
- **이 epic 완료가 Phase B 진입의 gate**
