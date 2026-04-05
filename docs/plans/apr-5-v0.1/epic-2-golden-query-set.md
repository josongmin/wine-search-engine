# Epic 2: Golden Query Set Construction

**Phase:** 1 (IR Core)
**RFC:** RFC-017 §4 Epic 2
**의존성:** Epic 1 (인덱싱된 데이터 필요 for label validation)
**블록하는 Epic:** 3, 4, 6, 11

---

## 목표

500개 graded-relevance query set 구축.
8개 시나리오 전체 커버. Bronze/Silver/Gate 3-tier.

## 이미 존재하는 것

| 컴포넌트 | 상태 |
|---|---|
| `test/e2e/golden-set.test.ts` | ✅ 35개 smoke test (참고용) |
| Query classes 7종 | ✅ 코드에 정의 |
| Query intents 8종 | ✅ 코드에 정의 |

## 8개 시나리오 (RFC-017 §2.1)

| 시나리오 | query_class | 수 | primary metric |
|---|---|---|---|
| A. 정확 엔티티 | `exact_entity` | 75 | WrongTop1, MRR@10 |
| B. 짧은/모호한 별칭 | `ambiguous_short_form` | 60 | WrongTop1, abstain correctness |
| C. 속성/취향 기반 | `semantic_preference` | 75 | NDCG@10 |
| D. 제약 기반 | `pure_constraint` | 60 | NDCG@10, constraint satisfaction |
| E. 탐색/추천형 | `exploration` | 50 | Recall@10, diversity |
| F. 비교/유사품 | `similar_compare` | 50 | set quality, anchor preservation |
| G. 카탈로그 browse | `catalog_browse` | 50 | Recall@10, set coverage |
| H. OOV/오타/불완전 | `noisy_recall` | 40 | MRR@10, recall |
| — no match | `no_match` | 40 | abstain precision |

언어: EN 60% / KO 30% / Mixed 10%

## 작업 항목

### 2.1 LLM 기반 쿼리 생성 (Bronze)

**파일:** `scripts/eval/generate-golden-queries.ts`

- entity당 5개 query 생성 (8개 시나리오에 맞춰 분배)
- 시나리오 F/G는 별도 프롬프트 필요:
  - F: "이 와인과 비슷하지만 다른 와인을 찾는 쿼리를 만들어라"
  - G: "이 생산자/지역의 대표 와인들을 찾는 쿼리를 만들어라"

### 2.2 Graded Relevance Labeling

- grade 3: entity_id + vintage 정확
- grade 2: 동일 producer/wine line, vintage 다름
- grade 1: 동일 producer/region, 다른 wine
- grade 0: irrelevant

**시나리오별 grade 해석 차이:**
- F (similar): seed entity = grade 0 (자기 자신은 "유사품"이 아님), 유사 와인 = grade 3
- G (browse): 해당 producer/region 대표 wine = grade 3, 마이너 = grade 2

### 2.3 Hard Negative Mining

**파일:** `scripts/eval/mine-hard-negatives.ts`

- Same-producer confusables
- Same-vintage different-chateau
- Alias collision
- Entity type confusion: "마고" → wine vs appellation

### 2.4 3-Tier 분리

| tier | 파일 | 용도 | release gate |
|---|---|---|---|
| Bronze | `data/golden-queries-bronze.jsonl` | bootstrapping, mining | 불가 |
| Silver | `data/golden-queries-silver.jsonl` | training, model selection | 불가 |
| Gate | `data/golden-queries-gate.jsonl` | baseline, regression | 가능 |

- Gate tier: human-validated only, train/val과 query family 겹침 금지
- Gate human review: ~2주 캘린더 시간 (코드와 독립)

### 2.5 Dataset Leakage Prevention Contract (P0)

LLM이 같은 템플릿으로 생성한 query들이 train/val/gate에 걸쳐 있으면 LTR 평가가 무의미.
같은 entity에서 파���된 query 변형이 split을 가로지르면 과적합.

**4개 split key (모두 JSONL에 포함 필수):**

| key | 정�� | 예시 |
|---|---|---|
| `entity_id` | 원천 entity | `opus-one-2018` |
| `query_template_id` | LLM 프롬프트 템플릿 | `exact_entity_v1`, `semantic_pref_v1` |
| `generation_run_id` | LLM 배치 실행 ID | `run-2026-04-05-001` |
| `alias_cluster_id` | alias prefix 클���스터 | `leoville-*` (3개 chateau 공유) |

**5개 blocking rule:**

```
1. 같은 entity_id에서 파생된 query는 모두 같은 split
2. 같은 query_template_id + entity_id 조합은 모두 같은 split
3. 같은 alias_cluster_id 소속 query는 모두 같은 split
4. 같은 generation_run_id는 가급적 같은 split (LLM 배치 bias 방지)
5. Gate tier는 Bronze/Silver train/val cutoff 이후 시점만 허용
```

**검증 스크립트:** `scripts/eval/verify-splits.ts`

```typescript
function verifySplitIntegrity(
  train: GoldenQuery[], val: GoldenQuery[], gate: GoldenQuery[]
): { valid: boolean; violations: string[] } {
  // 1. entity_id cross-split 검사
  // 2. alias_cluster_id cross-split 검사
  // 3. gate에 train/val entity 없는지 검사
  // 4. temporal ordering: gate.created_at > max(train.created_at)
}
```

### 2.6 JSONL Schema (Full)

```jsonl
{
  "qid": "q0001",
  "query": "opus one 2018",
  "query_class": "exact_entity",
  "scenario": "A",
  "language": "en",

  "retrieval_labels": {
    "relevant": [
      { "entity_id": "opus-one-2018", "grade": 3 },
      { "entity_id": "opus-one-2019", "grade": 2 }
    ]
  },

  "decision_labels": {
    "expected_decision_status": "resolved",
    "expected_entity_id": "opus-one-2018",
    "ambiguity_expected": false,
    "requires_abstain": false
  },

  "leakage_keys": {
    "entity_id": "opus-one-2018",
    "query_template_id": "exact_entity_v1",
    "generation_run_id": "run-2026-04-05-001",
    "alias_cluster_id": "opus-one"
  },

  "annotation_tier": "bronze",
  "annotated_by": ["llm-claude-haiku", "rule:grade_v1"],
  "release_gate_eligible": false,
  "created_at": "2026-04-05T00:00:00Z"
}
```

**Retrieval labels vs Decision labels 분리 이유:**
- Retrieval 성공 (grade 3이 top-10에 있음) ≠ Decision 성공 (resolver가 올바르게 resolve/abstain)
- LTR은 retrieval_labels로 학습, Decision Utility는 decision_labels로 측정

## Deliverables

- [ ] `scripts/eval/generate-golden-queries.ts`
- [ ] `scripts/eval/mine-hard-negatives.ts`
- [ ] `scripts/eval/build-splits.ts` (leakage-safe split assignment)
- [ ] `scripts/eval/verify-splits.ts` (split integrity validation)
- [ ] `data/golden-queries-bronze.jsonl` (500, full JSONL schema with leakage keys)
- [ ] `data/golden-queries-silver.jsonl` (subset, human-reviewed)
- [ ] `data/golden-queries-gate.jsonl` (holdout, human-validated)
- [ ] `data/hard-negatives.jsonl`

## Temporal Split Rules (RFC-017 §6.4)

- Random split 금지. 수집 시점 기준 상대 분할.
- Same query family / paraphrase cluster / seed entity generated variant가 split을 가로지르지 않게 차단
- Gate holdout은 항상 train/val cutoff 이후 시점 수집분만
- `verify-splits.ts`가 CI에서 자동 실행되어 violation 감지

## 완료 기준

- [ ] 500 queries across 8 scenarios
- [ ] EN/KO/Mixed 비율 맞춤
- [ ] Gate tier ≥ 50 queries, human-validated
- [ ] 시나리오 F/G 각 ≥ 50 queries with set-level grade
- [ ] `verify-splits.ts` 통과 (leakage violation = 0)
- [ ] 모든 query에 leakage_keys 4개 필드 채워짐
