# Epic 3: Evaluation Pipeline

**Phase:** 1 (IR Core)
**RFC:** RFC-017 §4 Epic 3 + RFC-009
**의존성:** Epic 1 (indexed data), Epic 2 (golden queries)
**블록하는 Epic:** 4, 7, 11

---

## 목표

NDCG@10, MRR@10, Recall@100, Decision Utility, AURC 자동 측정.
시나리오별 분리 metric. Statistical significance testing.

## 이미 존재하는 것

| 컴포넌트 | 상태 |
|---|---|
| `test/unit/evaluation/utility-scorer.test.ts` | ✅ Decision Utility unit test |
| `test/unit/evaluation/selective-predictor.test.ts` | ✅ Abstention set validation |
| `test/e2e/golden-set.test.ts` | ✅ 35-wine E2E (smoke) |
| `test/e2e/vespa/search-quality.test.ts` | ✅ Semantic, ranking, filter |

## 작업 항목

### 3.1 Core Metrics Library

**파일:** `scripts/eval/metrics.ts`

```
NDCG@K (graded relevance)
MRR@K
Recall@K
Decision Utility (RFC-009 §5.1):
  +1.0 correct_resolve, +0.4 safe_abstain, -1.5 wrong_resolve, -0.3 avoidable_abstain
WrongTop1 rate
Safe abstain rate
Avoidable abstain rate
AURC (Area Under Risk-Coverage Curve)
E-AURC (Excess AURC)
ECE (Expected Calibration Error)
```

### 3.2 Significance Testing

**파일:** `scripts/eval/significance.ts`

- Paired bootstrap test (B=10000)
- 95% confidence interval
- Bonferroni correction (threshold = 0.05 / metric 수)
- p < 0.05 미만이어야 "개선"으로 인정

### 3.3 시나리오별 분리 Metric

```
entity_resolve (A, B, H):
  wrong_top1_rate, mrr_at_10, resolve_precision

ranking_quality (C, D):
  ndcg_at_10, constraint_satisfaction_rate

set_retrieval (E, F, G):
  recall_at_10, intra_set_diversity, set_coverage

no_match:
  abstain_precision, false_resolve_rate
```

### 3.4 Retrieval Component 분리

- sparse only vs dense only vs hybrid (RRF)
- Blocker recall ≥ 0.99 (RFC-006 §3.3)

### 3.5 Split Integrity Validation (Epic 2 연동)

Eval 실행 전 반드시 leakage check:
- `verify-splits.ts` 호출 → violation 있으면 eval 중단
- gate tier가 train/val과 entity_id, alias_cluster_id 겹치는지 검사
- CI에서 자동 실행

### 3.6 Offline Eval Runner

**파일:** `scripts/eval/run-offline-eval.ts`

- `data/golden-queries-{bronze,silver,gate}.jsonl` 입력
- `EvalResult` 출력 (JSON)
- dataset_tier별 실행
- release gate는 gate tier만

### 3.6 Release Gate

```
gate tier only. LLM-only annotation 금지.

차단 조건:
  wrong_top1_rate                > 0.02
  decision_utility               < baseline - 0.05
  ndcg_at_10                     < baseline - 0.03
  recall_at_100                  < 0.90
  aurc                          > baseline + 0.01
  entity_resolve.wrong_top1_rate > 0.03
  set_retrieval.recall_at_10     < 0.60
  no_match.false_resolve_rate    > 0.05
```

## Deliverables

- [ ] `scripts/eval/metrics.ts`
- [ ] `scripts/eval/significance.ts`
- [ ] `scripts/eval/run-offline-eval.ts`
- [ ] Baseline 결과 commit (`data/eval-baselines/`)

## 완료 기준

- [ ] NDCG@10, MRR@10, Recall@100 baseline 수치 확보
- [ ] Decision Utility baseline 확보
- [ ] wrong_top1_rate 측정 가능
- [ ] 시나리오별 slice metric 출력 확인
- [ ] significance test 작동 확인
