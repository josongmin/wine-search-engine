# Wine Retrieval OS v0.1 — Master Plan

**날짜:** 2026-04-05
**범위:** RFC-017 IR core + Retrieval Mode + Entity Surface + LLM Envelope
**목표 상태:** 사람 + LLM이 안전하게 쓰는 evidence-bearing wine retrieval substrate

---

## 현재 코드 상태 (RFC 대비)

### 이미 구현된 것 — 다시 만들지 않음

| 컴포넌트 | 파일 | 비고 |
|---|---|---|
| Entity types (5종) | `src/domain/entity/model/entity-type.ts` | wine/vintage/producer/region/grape |
| Query intents (8종) | `src/domain/query/model/query-intent.ts` | entity_exact~mixed_query |
| Query routes (3종) | `src/domain/query/model/query-route.ts` | entity/hybrid/mixed |
| Query classes (7종) | `src/domain/shared/types/query-class.ts` | short_entity~comparison_query |
| Mixed query solver | `src/domain/mixed/service/mixed-solver.ts` | anchor profiling + similar retrieval 완전 구현 |
| Anchor profiler | `src/domain/mixed/service/anchor-profiler.ts` | region/grapes/body/sweetness/embedding 추출 |
| SearchResponseV1 | `src/domain/response/model/search-response.ts` | EngineDecision + ResultItem + Evidence 구조체 |
| EvidenceItem | type/source/contribution/strength/provenance | 모든 result에 필수 |
| Admission Gate (RFC-016) | `src/domain/decision/service/admission-gate.ts` | 3-layer closure check |
| FailureReason enum | 9개 machine-readable codes | |
| DecisionSnapshot (RFC-015) | replay + version tracking | |
| Constraint bundle | hard/soft/inferred 분리 | planner에서 추출 |

### 비목표 (RFC-017 §1.2 — scope 가드레일)

| 하지 않음 | 담당 |
|---|---|
| Entity SSOT core 정의 변경 | RFC-001·002 |
| Decision 경계 수식 변경 | RFC-000 §8.4 |
| 실시간 behavioral signal로 canonical 덮어쓰기 | RFC-010 §2.1 금지 |
| Vespa schema 구조 변경 | 별도 RFC |
| 새 query_class 추가 | RFC-005 |

### 구현 필요 — 이 plan의 대상

| 갭 | Phase | Epic |
|---|---|---|
| Vivino 10K → Vespa ETL | Phase 1 | Epic 1 |
| Golden query set 500개 | Phase 1 | Epic 2 |
| Eval pipeline (NDCG/MRR/AURC/Decision Utility) | Phase 1 | Epic 3 |
| LambdaMART LTR | Phase 1 | Epic 4 |
| Cross-encoder reranker (실 구현) | Phase 1 | Epic 5 |
| Embedding fine-tune + distillation | Phase 1 | Epic 6 |
| `retrieval_mode` first-class 추가 (browse/compare/similar) | Phase 2 | Epic 7 |
| Producer/Region Vespa 인덱스 surface | Phase 2 | Epic 8 |
| LLM envelope 확장 (parsed_constraints, match_reasons, violated) | Phase 3 | Epic 9 |
| Compare/Browse set retrieval mode 구현 | Phase 3 | Epic 10 |
| Eval 확장 (retrieval_mode별 slice) | Phase 3 | Epic 11 |

---

### 범위 밖 (RFC-017 §9)

| 주제 | 비고 |
|---|---|
| BGE-M3 sparse weights | Epic 1 §1.7 Phase 2 경로. Recall 병목 확인 후. |
| BGE-M3 ColBERT multi-vector | Phase 3 경로. Vespa MaxSim. |
| Embedding dim 768 전환 | Phase 1 eval 후 128 vs 768 A/B |
| Diversity reranking (MMR) | set retrieval에서 동일 producer 쏠림 방지 |
| User preference learning | RFC-010 확장 |
| Adversarial alias 방어 | RFC-003 §8.2.2 |
| Real-time behavioral signals | RFC-010 §2.3 |
| Online A/B framework | shadow scoring, gradual rollout |

---

## Quality Goals (RFC-017 §7 — baseline 수립 후 revision)

| 지표 | 초기 목표 | 방법 |
|---|---|---|
| Recall@100 (hybrid) | ≥ 0.90 | Epic 1 + 3 |
| Blocker Recall | ≥ 0.99 | RFC-006 §3.3 |
| NDCG@10 (LTR 이전) | baseline 측정 | Epic 3 |
| NDCG@10 (LTR 이후) | baseline + 0.05 이상 | Epic 4 |
| WrongTop1 rate | ≤ 0.02 | 모든 Epic |
| Reranker Δ NDCG@5 | ≥ +0.03 | Epic 5 |
| Decision Utility | baseline + 0.05 | Epic 3 + 4 |

---

## Phase 구조

### Phase 1 — IR Core (RFC-017)

데이터 없이는 아무것도 측정 못 한다. 먼저 닫는다.

```
Epic 1: ETL Pipeline (Bronze → Silver → Vespa)
Epic 2: Golden Query Set (500 queries, 8 scenarios)
Epic 3: Eval Pipeline (metrics + gate + significance)
Epic 4: LTR (LambdaMART)
Epic 5: Cross-Encoder Reranker
Epic 6: Embedding Fine-tune & Distillation
```

**완료 기준:**
- 10K 인덱싱 완료
- Recall@100, NDCG@10, Decision Utility baseline 확보
- LTR vs 수동 weight A/B 결과
- wrong_top1_rate ≤ 0.02

### Phase 2 — Retrieval Mode & Entity Surface

```
Epic 7: RetrievalMode contract (기존 route 3개 → 10개 mode)
Epic 8: Entity Index Surface (Producer/Region first-class)
```

**완료 기준:**
- "안티노리" → producer browse mode 동작
- "마고" → entity type disambiguation 동작
- golden query set에 retrieval_mode tag 완료

### Phase 3 — LLM Envelope & Set Retrieval

```
Epic 9: LLM Retrieval Envelope (response 확장)
Epic 10: Compare/Browse set retrieval 구현
Epic 11: Eval 확장 (mode별 slice)
```

**완료 기준:**
- LLM이 result_type, match_reasons, violated_constraints 수신 가능
- browse/compare query에서 set_coverage ≥ 0.60
- retrieval_mode별 metric dashboard 운영

---

## 의존성 그래프

```
Phase 1:
  Epic 1 ──→ Epic 2 (query는 병렬, label은 인덱스 필요)
  Epic 1 ──→ Epic 3 (indexed data 필요)
  Epic 2 ──��� Epic 3 (golden queries 필요)
  Epic 1+2+3 ──→ Epic 4 (features + labels + eval)
  Epic 1 ──→ Epic 5 (search_text_en 필요)
  Epic 2+5 ──→ Epic 6 (golden pairs + cross-encoder scores)

Phase 2:
  Phase 1 Epic 3 ──→ Epic 7 (baseline eval 필요)
  Epic 7 ──→ Epic 8 (mode contract 먼저)

Phase 3:
  Epic 7+8 ──→ Epic 9 (mode + entity surface 정의 후 envelope)
  Epic 7+8 ──→ Epic 10 (browse/compare mode 정의 후 구현)
  Epic 9+10 ──→ Epic 11 (새 mode eval)
```

---

## 파일 구조

```
docs/plans/apr-5-v0.1/
├── 00-overview.md          (이 문서)
├── epic-1-etl-pipeline.md
├── epic-2-golden-query-set.md
├── epic-3-eval-pipeline.md
├── epic-4-ltr.md
├── epic-5-cross-encoder.md
├── epic-6-embedding-finetune.md
├── epic-7-retrieval-modes.md
├── epic-8-entity-index-surface.md
├── epic-9-llm-envelope.md
├── epic-10-similar-compare-browse.md
└── epic-11-eval-extension.md
```
