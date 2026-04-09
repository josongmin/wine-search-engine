# Bugbash Plan — SOTA++ Aligned Architecture Roadmap (v4)

> **설계 원칙:** 업계/학계 SOTA++ 검색 시스템으로 수렴하기 위한 구조 전환 계획.
> ROI 무관, Breaking change 허용.
> 단, **측정 없는 최적화**, **retrieval ceiling 미측정 상태의 ranking 투자**, **heuristic 회귀**는 금지.

---

## 2026 라벨 기준

문서 안의 기술과 epic은 아래 라벨로 해석한다.

- `STILL_SOTA`: 2026 기준으로도 production / research 양쪽에서 강한 주력 축
- `STRONG_BASELINE`: 2026에도 매우 강한 실전 baseline이지만, 최종 frontier 그 자체는 아님
- `BRIDGE`: 지금 도입 가치가 높지만 장기 종착점이라기보다 중간 단계 / bootstrap 성격
- `LEGACY_RISK`: 유지비가 커지거나 더 나은 대안이 있어 장기 주력으로는 위험

**운영 원칙:**
- `STILL_SOTA`는 장기 투자 대상으로 간주
- `STRONG_BASELINE`은 반드시 먼저 확보
- `BRIDGE`는 exit criterion과 다음 단계가 문서에 있어야 함
- `LEGACY_RISK`는 fallback 또는 migration 대상이어야 함

---

## 모델 학습 필요 라벨

이 문서에서는 "모델 학습"을 아래처럼 나눈다.

- `학습 불필요`: 규칙, 인프라, ETL, 계측, 서빙, 정책만으로 완료 가능
- `경량 피팅 필요`: threshold, calibrator, sweep, propensity, conformal처럼 **작은 fitting**이 필요하지만 대형 모델 학습/파인튜닝은 아님
- `부분 필요`: epic 안에 학습이 필요한 task와 필요 없는 task가 섞여 있음
- `필수 학습 필요`: epic의 핵심 산출물이 모델 학습/파인튜닝 없이는 성립하지 않음

**판정 원칙:**
- 데이터셋 구축만 하는 epic은 `학습 불필요`
- calibration / weight sweep / debias fitting은 `경량 피팅 필요`
- pretrained model을 그대로 붙일 수 있지만 장기적으로 fine-tune이 섞이는 epic은 `부분 필요`
- LTR / intent classifier처럼 핵심 가치가 학습 모델에서 나오는 epic은 `필수 학습 필요`

---

## 핵심 진단

### 실제로 큰 문제

1. **현재 "LambdaMART"는 LambdaMART가 아니다.**
   `lambdamart-ranker.ts`는 8-feature linear RankNet 계열이며 tree ensemble, |ΔNDCG| weighting, boosting이 없다.

2. **Retrieval ceiling이 아직 분리 측정되지 않는다.**
   지금 상태에서는 ranking 문제와 retrieval 문제를 구분해서 볼 수 있는 gate가 약하다.

3. **Calibration claim이 문서보다 구현이 뒤처져 있다.**
   AURC/ECE/threshold profile이 실제 데이터 파이프라인으로 운영되지 않는다.

4. **Query understanding이 ceiling bottleneck이다.**
   intent/route 결정이 regex + branch order에 크게 의존하므로 retrieval/ranking 개선이 상류 오판에 묶인다.

5. **Knowledge coverage가 long-tail에 취약하다.**
   compositional inference와 entity coverage가 catalog 규모에 비해 너무 작다.

### 이미 좋은 자산

1. **Hybrid retrieval skeleton은 좋다.**
   BM25 + dense + anchor + learned sparse 확장 여지가 있다.

2. **Vespa second-phase / rerank infrastructure가 이미 있다.**
   완전 신규 구축이 아니라 업그레이드 경로가 존재한다.

3. **Query normalizer가 강하다.**
   multi-view normalization, accent/phonetic/Korean handling은 유지 자산이다.

4. **Degradation 관측 기반은 일부 이미 있다.**
   과장된 "all silent fallback" 진단보다 실제 gap은 circuit breaker, ranking-aware degradation, error taxonomy다.

---

## SOTA++ 운영 원칙

### 1. Retrieval-first

LTR와 reranker는 **top-K 안에 들어온 후보만** 재정렬할 수 있다.
따라서 Phase B의 모든 ranking 투자는 먼저 아래 지표를 확보한 뒤에만 진행한다.

- `Recall@20/50/100`
- `Oracle NDCG@10`, `Oracle MRR`
- query-class별 retrieval coverage
- channel별 marginal gain

### 2. Human-gated measurement

LLM judge는 보조 수단일 뿐, 최종 gate가 아니다.
Phase B 진입과 calibration 승인은 최소한 아래를 만족해야 한다.

- 고정된 human-reviewed gold split 존재
- LLM-labeled set는 scale-out 보조용
- position swap / inter-judge agreement / human audit로 편향 보정

### 3. Layered ablation

다음은 분리된 rollout 단위를 가져야 한다.

- offline model quality win
- serving migration win
- external reranker win
- product UX win

### 4. Learned authority handoff

learned QU를 도입하면서 regex가 영구적으로 최종 권한을 가지면 ceiling은 안 깨진다.
초기에는 regex를 high-precision prior로 유지하되, 최종 상태는:

- regex = prior / guardrail
- learned model = primary authority
- disagreement = hedge retrieval or abstention

### 5. Closed-loop core first

feedback loop의 핵심은 아래까지다.

- impression/click logging
- debias
- retrain
- A/B
- rollback

추천 에이전트, proactive UX, 멀티모달은 그 다음 제품 확장이다.

---

## 전략 v4

```
Week 0   (cheap wins)        → 병렬화 + deterministic eval + retrieval semantics 고정
Phase A  (measurement gate)  → eval/observability/type-safety/DI/flag 정비
Phase B  (ceiling lift)      → KG + SPLADE/doc2query + real LTR + calibration
Phase C  (authority shift)   → learned QU + adaptive cascade + closed-loop learning
```

### Week 0 — Cheap Wins

heavy epic 전에 즉시 출하 가능한 고효율 작업들이다.

| # | 작업 | 기대 효과 |
|---|------|----------|
| W0-1 | `CandidatePool.generate` 병렬화 | retrieval latency 대폭 절감 |
| W0-2 | `LEARNED_SPARSE_CHANNEL_ENABLED` 제거, 단일 gate화 | SPLADE 실험 가능화 |
| W0-3 | deterministic `compareScore` / stable rank 계약 | eval reproducibility 확보 |
| W0-4 | per-class RRF `k` sweep | zero-ML retrieval 개선 |
| W0-5 | `retrievalFusionScore` 의미 분리 | LTR feature 오염 방지 |

---

## Epic 의존 순서

```
Week 0
  ├─ W0-1 parallelization
  ├─ W0-2 learned sparse gate unification
  ├─ W0-3 deterministic evaluation contract
  ├─ W0-4 retrieval baseline sweep
  └─ W0-5 score semantics split

Phase A
  ├─ Epic-08 운영·보안
  ├─ Epic-01 SSoT
  ├─ Epic-02 플래그·킬스위치
  ├─ Epic-05 비교 의미론
  ├─ Epic-06 타입 안전
  ├─ Epic-07 I/O 병렬화
  ├─ Epic-04 관측성
  ├─ Epic-09 구조·DI
  └─ Epic-13 Eval 인프라 (Phase B gate)

Phase B
  ├─ Epic-11 Wine KG + Entity
  ├─ Epic-16 retrieval-side uplift (SPLADE, Doc2Query baseline, fusion sweep)
  ├─ Epic-10 Real LTR (offline → serve parity → optional reranker)
  ├─ Epic-17 Calibration
  └─ Epic-12 Structured Degradation

Phase C
  ├─ Epic-15 Learned QU authority handoff
  ├─ Epic-16 adaptive cascade / ColBERT / Matryoshka
  └─ Epic-18 Feedback loop core
```

---

## Epic 목록

### Phase A — Measurement Gate

| # | Epic | 핵심 역할 | 2026 라벨 | 학습 필요 |
|---|------|----------|-----------|-----------|
| 08 | [운영·보안](epic-08-ops-security.md) | 실험/학습 인프라 전 attack surface 축소 | `STILL_SOTA` | `학습 불필요` |
| 01 | [SSoT 통합](epic-01-ssot-consolidation.md) | hyperparameter/vocab single point of change | `STILL_SOTA` | `학습 불필요` |
| 02 | [플래그 체계](epic-02-flag-system.md) | query-level feature gate / experiment readiness | `STILL_SOTA` | `학습 불필요` |
| 05 | [비교 의미론](epic-05-comparison-semantics.md) | deterministic eval / stable score contract | `STILL_SOTA` | `학습 불필요` |
| 06 | [타입 안전](epic-06-type-safety.md) | external boundary validation / feature corruption 방지 | `STILL_SOTA` | `학습 불필요` |
| 07 | [I/O 최적화](epic-07-io-optimization.md) | retrieval 병렬화 / latency budget 확보 | `STILL_SOTA` | `학습 불필요` |
| 04 | [관측성](epic-04-observability.md) | latency, drift, feature distribution, degradation 관측 | `STILL_SOTA` | `학습 불필요` |
| 09 | [구조·DI](epic-09-structure-di.md) | handler/signal/model 교체 가능한 composition | `STILL_SOTA` | `학습 불필요` |
| 13 | [Eval 인프라](epic-13-eval-benchmark.md) | human-gated labeled set, recall/oracle metrics, train/serve parity | `STILL_SOTA` | `학습 불필요` |

### Phase B — Ceiling Lift

| # | Epic | 핵심 역할 | 2026 라벨 | 학습 필요 |
|---|------|----------|-----------|-----------|
| 11 | [Wine KG + Entity](epic-11-entity-resolution.md) | catalog-derived long-tail entity coverage | `STILL_SOTA` | `학습 불필요` |
| 16 | [Learned Fusion](epic-16-learned-fusion-cascade.md) | Phase B: SPLADE, Doc2Query, per-class fusion sweep | `STILL_SOTA` + `BRIDGE` 혼합 | `부분 필요` |
| 10 | [Real LTR](epic-10-ranking-sota.md) | offline LambdaMART -> Vespa-native serve parity -> optional reranker | `STRONG_BASELINE` | `필수 학습 필요` |
| 17 | [Calibration](epic-17-confidence-calibration.md) | AURC/ECE/conformal을 실제 gold data로 운영 | `STILL_SOTA` | `경량 피팅 필요` |
| 12 | [Structured Degradation](epic-12-silent-fallback.md) | circuit breaker + degradation-aware ranking/input mask | `STILL_SOTA` | `학습 불필요` |

### Phase C — Authority Shift

| # | Epic | 핵심 역할 | 2026 라벨 | 학습 필요 |
|---|------|----------|-----------|-----------|
| 15 | [Learned Query Understanding](epic-15-learned-query-understanding.md) | learned intent/route authority handoff + hedge retrieval | `STILL_SOTA` + `BRIDGE` 혼합 | `부분 필요` |
| 16 | [Learned Fusion](epic-16-learned-fusion-cascade.md) | adaptive cascade, dynamic top-K, ColBERT, Matryoshka | `STILL_SOTA` | `부분 필요` |
| 18 | [Feedback Loop](epic-18-feedback-loop.md) | click/impression -> debias -> retrain -> A/B -> rollback | `STILL_SOTA` | `경량 피팅 필요` |

### Cleanup / Legacy

| # | Epic | 비고 | 학습 필요 |
|---|------|------|-----------|
| 03 | [점수 척도](epic-03-score-semantics.md) | Phase A/B에서 score semantics 정리용 보조 epic | `학습 불필요` |
| 14 | [Wave 잔여](epic-14-wave-closure.md) | non-blocking debt closure | `학습 불필요` |

---

## 2026 실행 우선순위 밴드

같은 `STILL_SOTA`라도 지금 당장 해야 하는 것과 나중에 해야 하는 것은 다르다.

| 밴드 | 의미 | 해당 항목 |
|------|------|-----------|
| `NOW` | 즉시 착수. 다음 실험의 gate | `Week 0`, `Epic-05`, `Epic-07`, `Epic-13`, `Epic-08` |
| `NEXT` | gate 통과 직후 바로 투자 | `Epic-11`, `Epic-10`, `Epic-17`, `Epic-12` |
| `LATER` | baseline 안정화 후 확장 | `Epic-15`, `Epic-16` Phase C, `Epic-18` |
| `CLEANUP` | 품질/부채 정리 | `Epic-01`, `Epic-02`, `Epic-04`, `Epic-06`, `Epic-09`, `Epic-03`, `Epic-14` |

**읽는 법:**
- `NOW + STILL_SOTA` = 가장 먼저 해야 하는 장기 가치 작업
- `NEXT + STRONG_BASELINE` = 바로 실익이 큰 production baseline
- `LATER + BRIDGE` = 지금 유용하지만 장기 종착점은 아닌 단계 기술

---

## Phase B 진입 Gate

Phase B는 아래 조건을 모두 만족할 때만 시작한다.

1. `Epic-05` 완료: 동일 입력에 대해 stable rank 보장
2. `Epic-07` 완료: retrieval 병렬화 및 latency budget 확보
3. `Epic-13` 완료:
   - human-reviewed gold split 존재
   - `Recall@20/50/100`, `Oracle NDCG@10`, `Oracle MRR` 산출
   - LLM judge bias correction 적용
   - train/serve feature parity 검증 가능

---

## 최대 임팩트 Top 4

### 1. Retrieval Ceiling Measurement (`Epic-13`)

가장 먼저 필요한 것은 "못 찾은 것"과 "찾았는데 못 올린 것"을 분리하는 계측이다.

### 2. Retrieval Cheap Wins (`Week 0`, `Epic-07`, `Epic-16`)

병렬화, RRF sweep, SPLADE, Doc2Query는 비교적 빠르게 recall ceiling을 올릴 수 있다.

### 3. Real LTR (`Epic-10`)

real LambdaMART는 중요하지만 retrieval gate와 ablation discipline이 선행 조건이다.

### 4. Wine KG (`Epic-11`)

long-tail entity coverage, alias expansion, compositional inference를 동시에 올리는 공통 자산이다.

---

## 누락 없이 포함할 SOTA 기술

| 기술 | 역할 | Epic | 2026 라벨 |
|------|------|------|-----------|
| HyDE | query-side semantic gap bridging | `Epic-15` | `BRIDGE` |
| SPLADE | learned sparse retrieval | `Epic-16` | `STILL_SOTA` |
| Doc2Query | lexical recall 확장 | `Epic-16` | `BRIDGE` |
| ColBERT | late-interaction reranking | `Epic-16` | `STILL_SOTA` |
| Matryoshka embeddings | difficulty-aware ANN dimension control | `Epic-16` | `STILL_SOTA` |
| LightGBM LambdaMART | robust LTR baseline / serving baseline | `Epic-10` | `STRONG_BASELINE` |
| SetFit | few-shot intent bootstrap | `Epic-15` | `BRIDGE` |
| α-nDCG | diversity-aware eval | `Epic-13` | `STILL_SOTA` |
| Position-debiased LTR | click log 학습 편향 보정 | `Epic-18` | `STILL_SOTA` |
| LLM judge bias correction | offline labeling 신뢰도 보정 | `Epic-13` | `STILL_SOTA` |

---

## 2026 기준 추가 보완

### 1. `Epic-10`은 "최종 SOTA"가 아니라 "강한 baseline"으로 운영

`LightGBM LambdaMART`는 2026에도 매우 강한 production baseline이지만, 장기 frontier는 `Epic-16`의 late-interaction / adaptive cascade와 함께 봐야 한다.

### 2. `Epic-15`의 bridge 기술은 exit criterion이 있어야 함

`HyDE`, `SetFit`, `query suggestion`은 도입 가치가 높지만 장기 종착점은 아니다.
반드시 아래 중 하나로 넘어가는 조건이 문서에 있어야 한다.

- richer learned router
- stronger multilingual encoder
- joint intent + entity modeling

### 3. `Epic-16`은 retrieval uplift와 frontier stack을 함께 품되 단계 분리 유지

`SPLADE`는 여전히 강하지만, `Doc2Query`는 bridge 성격이 강하다.
문서상 Phase B와 Phase C 경계를 계속 유지해야 한다.
