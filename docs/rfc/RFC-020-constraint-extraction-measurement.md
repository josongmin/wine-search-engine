# RFC-020 — Constraint Extraction Measurement Framework

**상태**: Draft
**작성일**: 2026-04-09
**상위·연관 문서**
- `RFC-019` — NL Mapper Elevation to Ontology-Grounded Semantic Constraint Compiler (implementation)
- `RFC-004` — Facet / Attribute Normalization SSOT
- `RFC-009` — Evaluation·Decision Utility
- `RFC-000` — Master Architecture

**충돌 시 RFC-019가 우선한다 (implementation).**

---

## 0. 한 줄 방향

> **RFC-019의 효과를 업계 SOTA 수준으로 계측한다.**

RFC-019가 "무엇을 하는가"라면, RFC-020은 **"그것이 얼마나 잘 되었는가"** 를 측정하는 프레임워크다.
현재 벤치마크는 `fallbackTriggered` / `ruleTableHitCount` 같은 **파이프라인 내부 hit-rate** 만 측정한다. 이 지표들은:

1. **구조적 개선을 점수로 반영하지 못한다** (Overall 85% → 83%로 분산에 묻힘)
2. **업계 SOTA 대비 빈약하다** (Slot F1, Entity Linking Accuracy, Constraint Satisfaction Rate 등 부재)
3. **이름이 오도한다** (`fallbackTriggered`는 "실패"로 읽히지만 실제는 "regex 경로 사용"일 뿐)

본 RFC는 **Amazon/Airbnb/Google/TAC KBP/SemEval/StructEval** 프랙티스를 수용하되, 와인 검색 도메인에 +@ 수준으로 확장한 측정 프레임워크를 정의한다.

---

## 1. Problem Statement

### 1.1 현재 측정의 구조적 결함

**Trace 스키마 (`constraint-extraction-trace.ts`)**
```ts
readonly fallbackTriggered: boolean;   // ← 이름 오도 (실제: regex_extractor_used)
readonly ruleTableHitCount: number;    // ← Tier 1만 측정
readonly llmHitCount: number;          // ← 항상 0 (LLM 비활성)
readonly llmSkippedCount: number;
readonly missedPhrases: readonly string[];
// 신규 (linter 반영): phrasesByTier, semanticConstraintRecall, entityLinkingAccuracy는 optional이고 unused
```

**결함:**

| # | 결함 | 증거 |
|---|------|------|
| 1 | `fallbackTriggered`는 "retrieval 실패율"로 오독된다 | Q&A 로그: "fallback 85% = 85% 검색 실패?" 혼동 발생 |
| 2 | Entity Resolver(Phase 2), Ontology(Phase 3), Compositional(Phase 5) hit이 어디에도 계측되지 않는다 | RFC-019 구현 후 Mean hard 1.15→1.73이지만 trace는 변화 없음 |
| 3 | `inferredConstraintCount`가 없다 | Phase 5 compositional rule firing이 보이지 않음 |
| 4 | Ctx Relevance가 price/vintage만 hard check하고 wine_type/country/region은 무시 | `"프랑스 와인"` 쿼리가 "이탈리아 와인"을 반환해도 Ctx Relevance 감점 없음 |
| 5 | Semantic Constraint Recall (SCR) 미구현 | RFC-019 §8.2.1에 정의됐지만 scorer에 반영 안 됨 |
| 6 | Entity Linking Accuracy (ELA) 미구현 | RFC-019 §8.2.2 정의됐지만 scorer에 반영 안 됨 |
| 7 | LLM Judge의 Slot F1 같은 집중 평가 없음 | StructEval, SemEval pattern 부재 |
| 8 | Constraint Satisfaction Rate (CSR) 미구현 | Airbnb booked listing recall 패턴 부재 |
| 9 | nDCG 또는 UDCG 부재 | 검색 순위 품질을 constraint 단위로 decompose 못 함 |

### 1.2 구조적 개선이 점수에 안 잡히는 이유

v15 → v18 세션에서:
- Mean hard constraints **1.15 → 1.73** (+50%)
- Ctx Relevance **63.9% → 78.1%** (+14.2pp)
- Fallback rate **85.2% → 50.0%** (-35.2pp)

그런데 **Overall은 85.0% → 83.2%** (분산 범위 내). 왜?

Overall = log-space 가중 geo-mean. 개선이 **Answer Quality, Judge, Faithfulness 같은 LLM-dependent 차원에 잘 반영 안 됨** (판단 분산이 큼). 구조적 retrieval 개선은 **전용 metric으로 측정**해야 score에 박힌다.

---

## 2. Background: 업계 SOTA

### 2.1 업계/학계 레퍼런스

| 시스템 / 논문 | 지표 | 핵심 |
|-------------|------|------|
| **Amazon E-commerce** (2024) | Constraint Recall (CER) | NL → structured query 변환률, ground-truth 대비 |
| **Airbnb Location Retrieval** (2024) | Booked Listing Recall | 사용자가 실제 예약한 listing이 retrieval bounds 내에 있는 비율 |
| **SemEval-13 NER** | Entity-Level F1 | 토큰 단위가 아닌 entity span 전체 정확도 |
| **TAC KBP EDL** | Micro-Precision (InKB), EL@1, EL@5 | Entity linking 정확도, rank 고려 |
| **BioBERT / Ontology Matching** | Relaxed Precision/Recall | 부분 매칭 허용 (boundary lenient) |
| **StructEval 2025 EMNLP** | Format/Completeness/Semantic/Constraint | 4-차원 structured output eval |
| **UDCG (arXiv 2510.21440)** | Utility-weighted nDCG | LLM RAG에서 irrelevant doc은 -1 점수 |
| **nSIDCG (SIGIR 2025)** | Normalized Set-level Ideal DCG | 초기 retrieval 평가에 더 적합 |
| **RAGAS v2** | Context Recall / Precision | RAG 맥락 추출 품질 |

### 2.2 주요 통찰

**Single metric fallacy**: 어느 프로덕션 시스템도 단일 지표에 의존하지 않는다. **triad**로 관리한다:

1. **Extraction accuracy** (CER, F1, ELA) — 파이프라인 자체 품질
2. **Downstream impact** (nDCG, UDCG, Precision@1) — retrieval 순위 개선 효과
3. **Evaluation robustness** (LLM judge agreement, confidence calibration) — 측정 자체 신뢰도

RFC-020은 이 triad를 모두 수용한다.

**Entity-level > Token-level**: 프로덕션에서는 **entity span 전체 정확도**가 토큰 단위 accuracy보다 downstream task에 더 correlate 한다. "Cabernet Sauvignon"을 "Cabernet"과 "Sauvignon"으로 분해 매칭하는 건 0%로 처리한다.

**High-recall-first**: 2024-2025 연구는 **recall 우선 → confidence rerank**가 production에서 우세함을 보인다. 이 RFC는 recall 지표를 primary로, precision은 guard rail로 설계.

---

## 3. 측정할 수 있는 데이터 (활용 자산)

### 3.1 이미 있는 것

| 자산 | 위치 | 용도 |
|------|------|------|
| `ConstraintExtractionTrace` | `src/domain/attribute/model/constraint-extraction-trace.ts` | tier breakdown 확장 대상 (이미 선제 필드 있음) |
| `QueryPlanV2.constraints` | `src/domain/query/model/query-plan.ts` | hard/soft/inferred 번들 — 실제 추출 결과 |
| `scoreContextRelevance` | `test/benchmark/agent/scorer.ts:1346` | hard check를 price/vintage 외로 확장할 위치 |
| `ScenarioExpectation` | `test/benchmark/agent/scenario.ts` | `expectedConstraints`, `expectedEntities` 필드 추가 대상 |
| `golden-queries-*.jsonl` | `data/` | 500 annotated queries — ground-truth 소스 |
| `entity-resolver.ts` (RFC-019) | `src/domain/attribute/service/` | ELA 측정 데이터 제공 |
| `retrieval-plan-builder.ts` (RFC-019) | `src/domain/retrieval/service/` | hard/soft/inferred tier 분리 완료 |

### 3.2 새로 만들어야 하는 것

| 자산 | 생성 방법 | 노력 |
|------|---------|------|
| 시나리오 `expectedConstraints` 주석 | 기존 95 시나리오 수동 + rubric 기반 auto-generation | 중 |
| Entity linking ground truth | scenario.query 스캔 + entity-resolver 결과 golden set | 작음 |
| nDCG ground truth (top-k relevance) | golden-queries-silver.jsonl에 이미 `retrieval_labels.relevant` 존재 | 작음 (재활용) |

---

## 4. 제안: 8개 신규/개선 지표 + 4개 인프라 변경

### 4.1 지표 목록 (우선순위 순)

#### **P1. Semantic Constraint Recall (SCR)** — 최우선 KPI

**정의**:
```
SCR = |extracted ∩ expected| / |expected|
```
where `expected` = scenario가 명시한 expected constraints (hard + soft + inferred separately).

**매칭 규칙**:
- `attribute + operator + value` 전체 일치 → count
- `value`가 enum/string이면 case-insensitive, NFKC-normalized 비교
- `value`가 numeric range면 **overlap 허용** (e.g. expected `[30000, 50000]`과 extracted `[20000, 50000]`은 매칭)
- **Bucket별 별도 집계**: `scr_hard`, `scr_soft`, `scr_inferred`

**공식**:
```
scr_hard     = hit(extracted.hard,     expected.hard)     / |expected.hard|
scr_soft     = hit(extracted.soft,     expected.soft)     / |expected.soft|
scr_inferred = hit(extracted.inferred, expected.inferred) / |expected.inferred|

scr_overall = weighted mean with weights (hard: 0.6, soft: 0.2, inferred: 0.2)
```

**Scorer 통합**:
- 시나리오에 `expectedConstraints`가 정의된 경우에만 활성
- 측정값이 `null`이면 geo-mean에서 drop (RFC-020 §4.2 `null` 처리 기존 규칙 따름)
- 초기 weight = 0 (diagnostic only) → validation 후 0.1 부여

**위치**:
- 스키마: `test/benchmark/agent/scenario.ts` — `ScenarioExpectation.expectedConstraints`
- 측정: `test/benchmark/agent/scorer.ts` — 신규 `scoreSemanticConstraintRecall()`

**업계 출처**: Amazon e-commerce NL → constraint 2024 연구

---

#### **P2. Entity Linking Accuracy @ 1 and @ k (ELA@1, ELA@5)**

**정의**:
```
ELA@k = |entities_correctly_linked_within_topk| / |total_entity_mentions|
```

**우리 시스템에서**:
- Entity Resolver (RFC-019 Phase 2)가 각 span에 대해 `ResolvedEntity | null` 반환
- 시나리오에 `expectedEntities: [{surface, canonical, type}, ...]`를 정의
- 각 expected entity에 대해:
  - ELA@1: resolver가 top-1으로 올바른 canonical 반환했나?
  - ELA@5: resolver가 top-5 후보 내에 올바른 canonical 포함했나? (현재 top-1만 반환하므로 동등)

**Scorer 통합**:
- 초기에는 ELA@1만 측정
- precision/recall 분해: `ela_precision = correct / linked`, `ela_recall = correct / expected`

**업계 출처**: TAC KBP EDL (Entity Discovery and Linking), ERD 벤치마크

---

#### **P3. Slot F1 (Entity-Level F1, SemEval-13 방식)**

**정의**:
```
Precision = TP / (TP + FP)
Recall    = TP / (TP + FN)
F1        = 2PR / (P + R)
```

where:
- TP = correctly extracted (attribute + value all match expected)
- FP = extracted but not in expected (spurious)
- FN = expected but not extracted (missed)

**구분**: 
- `slot_f1_strict` — attribute+value+operator 완전 일치
- `slot_f1_relaxed` — attribute match + value overlap ≥ 50% (range) 또는 exact (string)
- `slot_f1_type_only` — attribute match (value는 무시)

**Scorer 통합**:
- 신규 `scoreSlotF1(extracted, expected, mode: 'strict'|'relaxed'|'type')`
- 초기에는 diagnostic only, later weight 0.05

**업계 출처**: SemEval-2013 Task 9.1 NER scheme, MUC-6, ACE 2005

---

#### **P4. Constraint Satisfaction Rate (CSR)**

**정의**:
```
CSR = |results_satisfying_all_extracted_constraints| / |total_results|
```

**용도**: 추출이 정확했다면, retrieval이 그걸 실제로 만족하는 결과를 가져왔냐?

**구현**:
- 각 추출된 hard constraint에 대해, agent의 search observation에서 매칭 확인
- `observation.results.filter(r => matches(r, constraint))` ratio
- `csr_hard` (must all satisfy), `csr_soft` (average satisfaction), `csr_inferred` (weighted)

**특수 규칙**:
- Constraint value가 index에 없으면 (sparse data) → null 반환 (페널티 없음)
- `csr=null` 케이스는 diagnostic 태그 `CSR_UNMEASURABLE`

**업계 출처**: Airbnb "Booked Listing Location Recall" 2024, 포괄적으로는 e-commerce facet hit rate

---

#### **P5. Fallback Path Attribution (현재 `fallbackTriggered` 대체)**

**이름 교정**:

| 기존 | 신규 |
|------|------|
| `fallbackTriggered: boolean` | **DEPRECATED** (유지하되 trace 대체) |
| — | `extractionPath: 'tier1_only' \| 'tier1_plus_resolver' \| 'ontology_expanded' \| 'compositional_fired' \| 'regex_fallback' \| 'unmapped'` |
| — | `tierHitBreakdown: ConstraintExtractionTierBreakdown` (이미 선제 정의됨) |
| — | `unresolvedSpanRatio: number` — parsed spans 중 아무 tier에도 안 잡힌 비율 |

**공식**:
```
extractionPath = most-specific tier that fired
tierHitBreakdown = {
  tier1_default_mapping: 5,
  tier2_entity_resolver: 2,
  tier3_ontology_expansion: 3,
  tier4_compositional_inference: 2,
  tier5_llm_linker: 0,
  tier6_regex_fallback: 0,
  unmapped: 1,
}
unresolvedSpanRatio = unmapped / total_spans
```

**Scorer 통합**:
- Stderr에 tier breakdown 표시 (아래 §4.3)
- 각 tier별 target: Tier1 ≥60%, Tier2 ≥25%, Tier6 ≤20%

---

#### **P6. Constraint-Decomposed nDCG (Downstream Impact)**

**정의**:
```
nDCG@k_per_constraint = DCG@k on results that satisfy constraint C / IDCG@k
```

**핵심 인사이트 (UDCG 논문)**:
LLM agent는 irrelevant doc을 **적극적으로 활용**할 수 있으므로, irrelevant doc은 0점이 아니라 **-1점 (penalty)** 이다:

```
UDCG@k = Σ utility(d_i) / log2(i+1) / IDCG@k
where utility(d_i) = +1 if relevant, -1 if distracting
```

**구현**:
- Retrieval 결과 top-10 중 constraint를 만족하는 문서 위치 기반
- Baseline: 현재 (v18) nDCG@5 측정 후, constraint-conditional nDCG로 decompose

**Scorer 통합**:
- 시나리오의 `retrieval_labels.relevant` (이미 golden queries에 존재) 재활용
- 신규 `scoreConstraintNDCG(results, constraints, relevantIds)`

**업계 출처**: UDCG (arXiv 2510.21440), nSIDCG (SIGIR 2025)

---

#### **P7. LLM Judge Agreement for Constraint Extraction**

**정의**:
```
judge_agreement = |cases where judge & scorer agree| / |total cases|
```

**목적**: 기계 측정 (P1-P6)이 human judgment와 얼마나 agree하는가? 측정 자체의 신뢰도.

**구현**:
- GPT-5.4-mini 또는 Claude를 judge로
- 프롬프트: "이 쿼리의 constraints는 {extracted}인데, ground truth는 {expected}다. 정확도를 0-1로 평가하라"
- 여러 샘플링 (N=3 median) — RFC-020 v4 LLM judge 프레임워크와 정합
- 결과를 P1 SCR과 비교 → correlation coefficient

**Target**: Pearson correlation ≥ 0.85 (human과 LLM judge 둘 다 SCR과 agree)

**업계 출처**: A Survey on LLM-as-a-Judge 2024, Frontiers Big Data 2025

---

#### **P8. Confidence Calibration (Brier Score)**

**정의**:
```
Brier = (1/N) Σ (predicted_confidence - actual_outcome)²
```

where `actual_outcome ∈ {0, 1}` based on whether the extraction was correct.

**목적**: Entity Resolver 및 Compositional inference가 confidence 0.9로 반환한 결과가 실제로 90% 맞는지 calibrate.

**구현**:
- Over 100+ scenarios에서 각 extraction의 `confidence` vs `correct`를 기록
- Brier score 계산
- 값이 낮을수록 well-calibrated (0 = 완벽)

**Target**: Brier < 0.15 (업계 well-calibrated 기준)

**업계 출처**: Platt calibration, Isotonic regression, 2025 LLM calibration 연구

---

### 4.2 지표 가중치 통합 전략

초기에는 **diagnostic only** (weight=0). 충분한 데이터 축적 후 gradual 도입:

| Phase | Weight 분포 | 판단 기준 |
|-------|-----------|---------|
| **v20.0** (이번 세션) | 모든 신규 지표 weight=0 (측정만) | trace + stderr 출력 |
| **v20.1** (다음 주) | SCR weight=0.05, 나머지 0 | SCR이 15+ 시나리오에서 ≥0.7 달성 |
| **v20.2** | SCR=0.08, Slot F1=0.03, ELA=0.03 | 3개 지표가 서로 correlate 검증 |
| **v20.3** | + CSR=0.05, nDCG=0.03 | judge agreement ≥0.85 |

**현재 Judge weight=0.15**를 유지하면서, 신규 지표를 **추가로** 섞는다 (기존 가중치 재조정 없음).

### 4.3 Runner stderr 출력 확장

**현재**:
```
────── dimensions ──────
Exec Eff:     96.4%
Answer Qual:  100.0%
Faithful:     79.3%
Ctx Relev:    63.9%
Judge:        70.0%
```

**신규 (v20)**:
```
────── dimensions ──────
Exec Eff:     96.4%
Answer Qual:  100.0%
Faithful:     79.3%
Ctx Relev:    63.9%
Judge:        70.0%

────── constraint extraction (RFC-019) ──────
Tier 1 (symbolic):      52% hit     [target ≥60%]
Tier 2 (entity_resolver): 18% hit     [target ≥25%]
Tier 3 (ontology_exp):  12% hit     [target ≥10%]
Tier 4 (compositional):  4.1 rules/Q [target ≥3.0]
Tier 5 (LLM linker):     0% hit     [disabled]
Tier 6 (regex fallback): 14% used    [target ≤20%]
Unresolved spans:        8%          [target ≤10%]

────── retrieval impact ──────
SCR hard:    0.72   [target ≥0.85]
SCR soft:    0.68   [target ≥0.70]
SCR inferred: 0.55  [target ≥0.60]
ELA@1:       0.88   [target ≥0.92]
Slot F1 (entity): 0.76  [target ≥0.85]
CSR hard:    0.81   [target ≥0.90]
nDCG@10 (constraint-aware): 0.74  [target ≥0.80]

────── measurement quality ──────
Judge-SCR correlation: 0.83   [target ≥0.85]
Confidence Brier:      0.18   [target ≤0.15]
```

### 4.4 Ctx Relevance hard check 확장 (P9)

**현재** (`scorer.ts:1346-1484`):
```ts
if (exp.priceBandKrw !== undefined) checks.push({ label: 'price_in_range', ... });
if (exp.vintageRange !== undefined) checks.push({ label: 'vintage_in_range', ... });
// wine_type, country, region은 측정 안 됨
```

**제안**: 시나리오의 `expectedConstraints` 또는 `answerMustMatch`에서 추론:
```ts
const structuredHardChecks = [
  { label: 'wine_type_in_results', extract: extractWineTypeFromQuery, match: /red|white|.../iu },
  { label: 'country_in_results',   extract: extractCountryFromQuery,   match: /france|italy|.../iu },
  { label: 'region_in_results',    extract: extractRegionFromQuery,    match: /bordeaux|napa|.../iu },
];
```

각 check는 observation에서 value 등장 여부 검증. 검색이 `country=France` hard constraint를 걸었는데 observation에 "italy"가 등장하면 `country_in_results=false` → Ctx Relevance 하락.

---

## 5. 구현 계획

### 5.1 Phase A: Trace 스키마 + stderr 확장 (이번 세션)

**노력**: 2-3시간

1. `ConstraintExtractionTrace`에 `extractionPath`, `unresolvedSpanRatio` 필드 추가
   - 기존 `phrasesByTier`는 이미 정의됨 — 채우기만 하면 됨
2. Planner에서 tier별 hit 카운트 populate:
   - Tier 1: NLMapper rule hits
   - Tier 2: Entity Resolver hits (PostRFC-019)
   - Tier 3: Ontology expansion (expandWithOntology return count)
   - Tier 4: Compositional inference (applyCompositionalInference added count)
   - Tier 5: LLM (현재 0)
   - Tier 6: regex fallback (extractRuleBasedConstraints called)
3. Runner stderr 확장 (§4.3)
4. 기존 `fallbackTriggered`는 유지하되 deprecated 주석

**Deliverables**:
- `constraint-extraction-trace.ts`에 신규 필드
- `planner.ts`에 tier counting
- `runner.ts`에 §4.3 출력 섹션
- `nl-mapper-coverage.regression.test.ts`에 tier breakdown 회귀

### 5.2 Phase B: 시나리오 `expectedConstraints` 주석 (이번 세션 or 다음)

**노력**: 3-4시간

1. `ScenarioExpectation`에 optional `expectedConstraints` 필드 추가
2. 주요 시나리오 15-20개에 수동 주석 (시나리오 쿼리 + rubric 기반)
3. 나머지 75 시나리오는 다음 phase에서 auto-generation

**Example annotation**:
```ts
{
  id: 4,
  query: '보르도 vs 나파 카베르네',
  expectation: {
    expectedConstraints: {
      hard: [
        { attribute: 'region', value: 'Bordeaux', operator: '=' },
        { attribute: 'region', value: 'Napa Valley', operator: '=' },
        { attribute: 'grape_primary', value: 'Cabernet Sauvignon', operator: '=' },
      ],
      inferred: [
        { attribute: 'country', value: 'France', operator: '=' },   // ontology
        { attribute: 'country', value: 'USA', operator: '=' },      // ontology
      ],
    },
    expectedEntities: [
      { surface: '보르도', canonical: 'Bordeaux', type: 'region' },
      { surface: '나파', canonical: 'Napa Valley', type: 'region' },
      { surface: '카베르네', canonical: 'Cabernet Sauvignon', type: 'grape_primary' },
    ],
  },
}
```

### 5.3 Phase C: Scorer 신규 함수 (P1, P2, P3)

**노력**: 4-5시간

1. `scoreSemanticConstraintRecall()` — P1 SCR
2. `scoreEntityLinkingAccuracy()` — P2 ELA@1
3. `scoreSlotF1()` — P3 Slot F1 (3 modes)
4. 각 함수는 diagnostic weight=0으로 integration
5. Scorer 테스트: 기존 시나리오에 기대값 추가

### 5.4 Phase D: Downstream Impact (P4, P6)

**노력**: 4-5시간

1. `scoreConstraintSatisfactionRate()` — P4 CSR
2. `scoreConstraintAwareNDCG()` — P6 constraint-decomposed nDCG
3. Golden queries의 `retrieval_labels.relevant` 재활용하여 IDCG 계산

### 5.5 Phase E: Measurement Quality (P7, P8)

**노력**: 3-4시간

1. LLM judge agreement 측정기 — `test/benchmark/agent/judge-constraint-agreement.ts`
2. Brier score 계산기 — `test/benchmark/agent/confidence-calibration.ts`
3. Summary report에 각각 reporting

### 5.6 Phase F: Weight Gradual Rollout (다음 세션)

**노력**: 1-2시간 per phase

1. v20.1: SCR weight 0.05
2. v20.2: Slot F1 + ELA 추가
3. v20.3: CSR + nDCG 추가

각 phase는 **전후 벤치마크 비교** 필수 (regression 방지).

---

## 6. Critical Files

| # | File | Change |
|---|------|--------|
| 1 | `src/domain/attribute/model/constraint-extraction-trace.ts` | 신규 필드 (`extractionPath`, `unresolvedSpanRatio`, `tierHitBreakdown` populate) |
| 2 | `src/domain/query/service/planner.ts` | tier별 counter, Phase 6 trace population |
| 3 | `test/benchmark/agent/scenario.ts` | `expectedConstraints`, `expectedEntities` schema |
| 4 | `test/benchmark/agent/scenarios.ts` | 15-20개 수동 annotation |
| 5 | `test/benchmark/agent/scorer.ts` | 신규 scoring 함수 (P1-P8) |
| 6 | `test/benchmark/agent/runner.ts` | stderr §4.3 확장 |
| 7 | `test/benchmark/agent/judge-constraint-agreement.ts` | 신규 (P7) |
| 8 | `test/benchmark/agent/confidence-calibration.ts` | 신규 (P8) |
| 9 | `test/regression/nl-mapper-measurement.regression.test.ts` | 신규 회귀 |

## 7. Reusable Functions

- `resolveEntity()` — `entity-resolver.ts` (ELA 측정에 그대로 사용)
- `buildRetrievalPlan()` — `retrieval-plan-builder.ts` (hard/soft/inferred 분리 제공)
- `scoreContextRelevance()` — `scorer.ts:1346` (P9 확장 대상)
- `normalizeObservations()` — `scorer.ts:86` (NFKC normalize 재사용)
- `tCi95()`, `bootstrapCi95()` — `runner.ts:486,531` (각 지표에 CI 붙임)

## 8. NOT in scope

- **embedding model 변경** (RFC-012, EPIC-6)
- **LLM Linker 활성화** (별도 cost/ops RFC)
- **Vespa schema 변경** (inferred boost 클로저는 Phase 6 v2)
- **시나리오 95개 전체 주석** (Phase B에서 핵심 15-20개만)
- **Weight production rollout** (Phase F 단계적)

## 9. 검증 프로토콜

### 9.1 Unit tests
- Tier breakdown 카운팅 정확성
- SCR formula edge case (empty expected, partial match)
- Slot F1 strict/relaxed/type 모드 구분
- ELA@1 vs ELA@5 (현재 둘 다 top-1이지만 interface 준비)

### 9.2 Regression tests
- `test/regression/nl-mapper-measurement.regression.test.ts`
  - v18 baseline 측정값 고정
  - 각 phase가 이전 지표를 regress 시키지 않는지 검증

### 9.3 End-to-end benchmark
- `npm run bench:agent -- --profile quick` 전후 비교
- **stderr 신규 섹션**이 출력되는지
- **JSON report**에 신규 필드가 포함되는지

### 9.4 업계 벤치마크 준거
- SCR ≥ 0.85 → Amazon e-commerce 프로덕션 수준
- ELA@1 ≥ 0.92 → TAC KBP 벤치마크 수준
- Slot F1 (entity-level strict) ≥ 0.85 → SNIPS/ATIS 수준 (0.97 is fine-tuned SOTA; 0.85는 zero-shot LLM baseline)
- Judge correlation ≥ 0.85 → LLM-as-judge 신뢰 기준

---

## 10. Success Criteria

| 지표 | v18 현재 | v20.0 (이번) | v20.3 (최종) |
|------|---------|-------------|-------------|
| **Tier breakdown 가시화** | 없음 | 전 tier visible | 전 tier visible |
| **SCR hard** | 미측정 | 측정 시작 | ≥0.85 |
| **SCR inferred** | 미측정 | 측정 시작 | ≥0.60 |
| **ELA@1** | 미측정 | 측정 시작 | ≥0.92 |
| **Slot F1** | 미측정 | 측정 시작 | ≥0.85 |
| **CSR hard** | 미측정 | 측정 시작 | ≥0.90 |
| **nDCG constraint-aware** | 미측정 | 측정 시작 | ≥0.80 |
| **Judge correlation** | 미측정 | 측정 시작 | ≥0.85 |
| **Brier score** | 미측정 | 측정 시작 | ≤0.15 |
| **Ctx Relev hard check 범위** | price, vintage | + wine_type, country, region | (full) |
| **Overall benchmark score** | 83.2% | 83±3% (측정만) | ≥88% (weight 적용 후) |

---

## 11. 최종 요약

**RFC-019가 "엔진을 바꿨다"면, RFC-020은 "속도계를 바꾼다".**

현재 속도계(hit rate, fallback boolean)는 **엔진 업그레이드 (RFC-019)의 효과를 분산에 묻히게 한다**. 업계 SOTA 수준의 8개 지표(SCR, ELA, Slot F1, CSR, nDCG, Judge agreement, Brier, tier breakdown)를 도입하여:

1. **RFC-019의 구조적 효과가 점수로 직접 반영된다** (SCR, Slot F1 weight)
2. **어느 tier가 약한지 한눈에 보인다** (tier breakdown stderr)
3. **측정 자체의 신뢰도를 관리한다** (Judge correlation, Brier)
4. **프로덕션 시스템과 어깨를 나란히 한다** (Amazon/Airbnb/TAC KBP 수준)

한 줄 결론:

> **측정하지 않는 개선은 없는 것과 같다. RFC-020은 RFC-019의 효과를 가시화한다.**

---

## 12. 참고

- `RFC-019-nl-mapper-coverage.md` — implementation
- `RFC-004-Attribute-Normalization.md` — upstream SSOT
- `src/domain/attribute/model/constraint-extraction-trace.ts` — 이미 선제 필드 존재
- `test/benchmark/agent/scorer.ts` — 통합 지점
- `test/benchmark/agent/runner.ts` — stderr 확장 지점
- 업계 논문:
  - Amazon E-commerce Conversational Search (arxiv 2601.16492)
  - Airbnb Location Retrieval RL (arxiv 2408.13399)
  - UDCG LLM-aware nDCG (arxiv 2510.21440)
  - StructEval Benchmark (arxiv 2505.20139)
  - Frontiers Big Data 2025 LLM Judge
  - SemEval-2013 Task 9.1 NER
  - TAC KBP EDL (LDC2018T16)
