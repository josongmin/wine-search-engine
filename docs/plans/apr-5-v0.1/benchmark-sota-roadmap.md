# Benchmark SOTA++ Roadmap

> V3 baseline: **75.7%** (106 scenarios, real container, judge disabled)
> Date: 2026-04-08
> Self-audit: critical review applied — scorer inflation, statistical validity, eval-before-optimize

---

## Critical Self-Diagnosis

V1(60.3%) → V3(75.7%)의 +15.4pt 중 **실제 시스템 개선은 ~8-10pt**, 나머지는 scorer 완화(EPS 0.05, fallback 0.25)에 의한 인플레이션. 이를 인정하고 평가 시스템부터 고친다.

### 현 벤치마크의 근본적 문제

| 문제 | 심각도 | 상세 |
|------|--------|------|
| **통계적 무의미** | Critical | tier당 n=2~7. 95% CI ±15pt. relative_reference n=2로는 아무 결론 불가 |
| **substring 기반 answerQuality** | Critical | 동의어/다른 표현 사용하면 0점. 실제 정답인데 키워드가 달라서 실패 |
| **Retrieval과 Agent 미분리** | High | answerQuality 떨어질 때 검색 실패인지 LLM 실패인지 구분 불가 |
| **contextPrecision 오명명** | High | 실제로는 keyword overlap 기반 context recall. 진짜 precision 아님 |
| **EPS=0.05 인플레이션** | High | 0점 차원이 0.03→0.20으로 6배 부풀림. failure case가 masking됨 |
| **Human baseline 없음** | High | rubric 작성자 1명. 정답 자체가 맞는지 검증 안 됨 |
| **Online/Offline gap 미측정** | Medium | 벤치마크 90% 달성해도 실제 유저 만족도와 상관관계 불명 |
| **\b 사용 위반** | Low | scorer.ts:910 extractProperNouns에 \b 사용 — CLAUDE.md rule 8 위반 |

---

## Phase 0: Eval Foundation (평가부터 고친다)

> Goodhart's Law: "When a measure becomes a target, it ceases to be a good measure."
> Agent를 고치기 전에 측정 도구부터 교정한다.

### 0-A: 시나리오 확충 (n=30+/tier)

**목표**: 모든 tier에 30+ 시나리오. 총 540+ active scenarios.

| 작업 | 상세 |
|------|------|
| 기존 18 tier × 30 시나리오 | tier당 23~28개 추가 필요 (현재 2~16개) |
| 시나리오 생성 방법 | (1) LLM으로 seed → human review, (2) 실제 유저 쿼리 로그에서 샘플링, (3) adversarial red-teaming |
| 새로운 tier 추가 | `retrieval_miss` (정답 존재하지만 검색 실패), `ranking_quality` (정답이 5위에 있음), `legitimate_idk` (정당한 "모르겠다") |
| 기존 rubric 검증 | 기존 106개 시나리오의 answerMustMatch/answerExcludes를 2인 이상 cross-review |

### 0-B: Retrieval 평가 분리

**목표**: Agent 성능과 Retrieval 성능을 독립 측정.

| 메트릭 | 구현 |
|--------|------|
| **Recall@K** (K=1,3,5,10) | 시나리오에 `goldenEntityIds` 필드 추가. 검색 결과의 entity_id와 비교 |
| **MRR** (Mean Reciprocal Rank) | 첫 번째 관련 결과의 위치 |
| **NDCG@5** | graded relevance (3=exact match, 2=same producer, 1=same region/grape) |
| Retrieval-only runner | agent loop 없이 search_wines만 호출하는 별도 벤치마크 모드 |

### 0-C: Scorer 교정

| 변경 | 근거 |
|------|------|
| **EPS를 1e-6으로 복원** | 0.05는 인플레이션. 대신 critical failure 이외의 0점을 0.05 floor로 clamp하는 별도 로직 |
| **answerQuality를 LLM-as-judge 기반으로 전환** | substring match는 보조 시그널로 격하. judge dimension을 primary answer evaluation으로 승격 |
| **contextPrecision을 context_relevance + context_recall로 분리** | RAGAS v2 정렬. relevance는 LLM-judge, recall은 goldenEntityIds 기반 |
| **answer_relevancy dimension 추가** | "답변이 질문에 대한 답인가" — 현재 완전히 빠져 있음 |
| **\b 위반 수정** | scorer.ts:910 extractProperNouns의 \b → Unicode-aware boundary |
| **Per-tier weight를 제거하거나 최소화** | 동일 weight로 tier 간 점수 비교 가능하게. tier-specific은 별도 리포트 |

### 0-D: Human Baseline

| 작업 | 상세 |
|------|------|
| 50개 stratified sample 선정 | 18 tier에서 비례 추출 |
| 2-3인 human evaluation | 각 답변을 1-5 Likert scale로 평가 (relevance, correctness, completeness) |
| Inter-annotator agreement | Cohen's Kappa 또는 Krippendorff's alpha 측정 |
| Human score vs benchmark score 상관관계 | Spearman's ρ > 0.7 목표 |

---

## Phase 1: Retrieval Quality (Agent 무관하게 검색만 개선)

### 1-A: Structured Attribute Filtering

| 작업 | 상세 |
|------|------|
| Query constraint extraction | LLM interpreter가 price, grape, region, vintage, style을 구조화 추출 |
| Vespa YQL filter injection | `price_band_krw < 30000 AND grape_primary != 'Cabernet Sauvignon'` |
| Negation as first-class filter | `NOT` 연산자를 Vespa 쿼리에 직접 반영 |

### 1-B: Retrieval Mode Routing

| 작업 | 상세 |
|------|------|
| Constraint-heavy → attribute filter first, then semantic re-rank | nested_condition, negation tier |
| Semantic-heavy → hybrid (현재 기본) | mood_atmosphere, gift_refined tier |
| Entity lookup → exact match first | single_shot specific SKU |

### 1-C: Embedding Quality

| 작업 | 상세 |
|------|------|
| text-embedding-3-large 평가 | 1024d large vs small A/B on retrieval metrics |
| Query-document asymmetric embedding | 쿼리에 instruction prefix 추가 ("Find wines matching: ...") |
| Hybrid BM25+dense weight 튜닝 | 현재 고정 blend → query class별 동적 weight |

---

## Phase 2: Agent Capability (측정 도구 교정 후)

### 2-A: Answer Generation Robustness

| 작업 | 상세 |
|------|------|
| EMPTY_ANSWER safety net | observation 있으면 반드시 답변 합성. fallback 경로를 "수집된 정보 기반 합성"으로 변경 |
| Structured output (JSON mode) | gpt-4o-mini의 response_format: json_object 강제 → parsing failure 제거 |
| Empty query guard | orchestrator entry에서 빈 쿼리 즉시 응답 반환 |

### 2-B: Negation Pipeline

| 작업 | 상세 |
|------|------|
| Agent-level exclusion | search 결과에서 제외 대상 필터링 후 observation 반환 |
| Answer self-check | 최종 답변에서 제외 키워드 탐지 → 위반 시 해당 와인 제거 |
| 검색 파이프라인 연동 | Phase 1-A의 Vespa NOT filter와 agent tool 연결 |

### 2-C: Multi-Constraint Decomposition

| 작업 | 상세 |
|------|------|
| Constraint priority ranking | 3+ 조건 시 (1) hard filter (price, vintage) (2) soft preference (style, mood) 분리 |
| Iterative refinement | 첫 검색 → constraint satisfaction check → 미충족 조건 강화해서 재검색 |
| Tool budget 동적 할당 | constraint 수에 비례하여 maxSteps 자동 설정 |

### 2-D: Model & Prompt

| 작업 | 상세 |
|------|------|
| gpt-4o 업그레이드 | 복잡 추론 tier에서 큰 차이 예상. cost는 10x이지만 quality 우선 |
| Few-shot examples | negation + nested condition 처리 예시 2-3개 |
| Prompt token 압축 | 현재 ~1800 → 1200 token. observation truncation 강화 |

---

## Phase 3: Production Readiness

### 3-A: CI/CD Integration

| 작업 | 상세 |
|------|------|
| Regression baseline | `results/baseline.json` 을 golden으로. `--fail-if-worse-than 0.03` |
| Per-PR benchmark | lightweight 50-scenario subset으로 PR마다 실행 |
| Nightly full run | 540+ 시나리오 full suite nightly |

### 3-B: Online Metrics Bridge

| 작업 | 상세 |
|------|------|
| User satisfaction proxy | 검색 후 클릭, 상세 조회, 구매 전환 |
| Offline-online correlation | 벤치마크 점수 vs 유저 만족도 Spearman's ρ 추적 |
| A/B test framework | 모델/프롬프트 변경 시 offline benchmark + online A/B 병행 |

### 3-C: Multi-turn Unlock

| 작업 | 상세 |
|------|------|
| Session history 구현 | agent에 conversation_history 파라미터 |
| Phase 2 시나리오 활성화 | 9개 skip 시나리오 unlock |
| 추가 멀티턴 시나리오 30개 | 컨텍스트 전환, 이전 답변 참조, 선호도 학습 |

---

## 측정 목표 (교정된 스코어 기준)

| Milestone | Overall | Retrieval Recall@5 | Human Correlation |
|-----------|---------|-------------------|-------------------|
| 현재 (교정 전) | 75.7%* | 미측정 | 미측정 |
| Phase 0 완료 | ~65%** | baseline 측정 | ρ > 0.5 |
| Phase 1 완료 | ~72% | > 0.70 | ρ > 0.6 |
| Phase 2 완료 | ~82% | > 0.80 | ρ > 0.7 |
| Phase 3 완료 | ~85% | > 0.85 | ρ > 0.8 |

\* EPS 인플레이션 포함  
\** EPS 교정 + 시나리오 확충으로 일시적 하락 예상 — 이것이 정직한 측정

---

## 핵심 원칙

1. **Eval first, optimize second.** 측정이 틀리면 개선도 틀리다.
2. **Retrieval과 Agent를 분리 측정.** 검색이 망하면 LLM이 아무리 잘해도 답이 없다.
3. **Human baseline이 ground truth.** 자동 메트릭은 human correlation으로 검증.
4. **Score inflation은 기술 부채.** EPS, partial credit, weight 조작으로 숫자만 올리지 않는다.
5. **Statistical validity > high score.** n=4로 95%보다 n=30으로 75%가 더 의미 있다.
