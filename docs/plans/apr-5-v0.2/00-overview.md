# Wine Retrieval OS v0.2 — SOTA++ Gap Close Plan

**날짜:** 2026-04-05
**범위:** v0.1 에픽 완성 후에도 커버 불가/부분 커버인 15개 시나리오 완전 해소
**목표 상태:** 80개 시나리오 중 78개 (97.5%) 완전 커버. 나머지 2개(Watchlist, Critic 라이선스)는 외부 계약 의존.

---

## v0.1 이후 잔여 갭 분류

### ❌ 구조적 불가 → v0.2 대상 (해소 가능한 것)

| 갭 | v0.1 상태 | v0.2 해법 | Epic |
|---|---|---|---|
| Critic score (RP/WS) | 데이터 없음 | **LLM synthetic proxy** — 라이선스 없이 tasting note에서 95점급 시그니처 추론 | 12 |
| Organic/biodynamic | 데이터 없음 | **Wikidata SPARQL + LLM 인증 추출** | 12 |
| Prompt injection | 미설계 | **LLM-as-judge sanitizer + allowlist** | 16 |
| Batch partial failure | API 없음 | **RFC-compliant `/v1/batch-search`** | 16 |

### ❌ 인프라 의존 → v0.2 대상

| 갭 | v0.2 해법 | Epic |
|---|---|---|
| Watchlist alert | Redis pub/sub + webhook delivery | 17 |

### ⚠️ 부분 가능 → v0.2 완전 해소

| 갭 | v0.2 해법 | Epic |
|---|---|---|
| Drinking window | LightGBM regression (grape × region × vintage → drink_from/to) | 15 |
| Conflicting constraints | ConstraintSAT solver — 논리적 모순 선탐지 후 early exit | 13 |
| Generic name abstain | Calibrated entropy threshold — top-K 점수 분산으로 abstain 결정 | 13 |
| Typo + phonetic combined | BK-tree + Soundex 교차 점수 — edit distance × alias recall 통합 | 13 |
| Food pairing | Doc2Pairing at index time + pairing extractor at query time | 12 |
| Multi-entity simultaneous | LLM query decomposition ("A vs B" → 병렬 entity resolve) | 14 |
| Pipeline recall mode override | `retrieval_mode` API 파라미터 + planner override | 14 |
| Agentic pairing chain | Claude tool-use integration — search/refine/combine loop | 17 |
| Hallucination verify | Calibrated confidence refusal + evidence chain validation | 17 |
| Recall mode switching (agentic) | Agent-triggered mode switching via tool schema | 17 |

---

## Phase 구조

### Phase 4 — Data & Query Intelligence

데이터 갭과 쿼리 이해 갭을 동시에 닫는다.

```
Epic 12: Data Enrichment (Critic proxy, Certification, Food pairing)
Epic 13: Query Intelligence (Contradiction, Abstain, Typo+Phonetic)
```

**완료 기준:**
- food_pairing 쿼리 NDCG@10 ≥ 0.55 (현재 측정 불가 → baseline 확보)
- conflicting constraint query → no_match (correct) rate ≥ 0.95
- typo 쿼리 Recall@10 ≥ 0.70 (alias-only 대비 +15% 목표)

### Phase 5 — API Surface Expansion

```
Epic 14: Query Decomposition + API Mode Override
Epic 15: Drinking Window Inference
Epic 16: Security & Batch API
```

**완료 기준:**
- "A vs B" 쿼리 → 두 entity 병렬 resolve 성공률 ≥ 0.85
- `/v1/batch-search` partial failure semantics 명세 완성
- injection attempt → 100% sanitized (edge case test suite 통과)

### Phase 6 — Agentic Layer

```
Epic 17: Agentic & Async Infrastructure
```

**완료 기준:**
- Claude tool-use로 multi-turn wine search 5-step 체인 성공
- watchlist entity 업데이트 → webhook 지연 ≤ 5분
- hallucination verify: confidence < 0.45인 resolved 응답 → LLM refusal rate ≥ 0.90

---

## 의존성 그래프

```
Phase 4:
  v0.1 Epic 1 (10K indexed) ──→ Epic 12 (enrichment on existing docs)
  v0.1 Epic 3 (eval pipeline) ──→ Epic 13 (measure improvement)
  Epic 12 ──→ Epic 13 (food pairing data needed for pairing query eval)

Phase 5:
  v0.1 Epic 2 (golden queries) ──→ Epic 14 (multi-entity labeled data)
  Epic 13 ──→ Epic 14 (abstain policy needed before mode override)
  Phase 4 complete ──→ Epic 15, Epic 16 (독립 병렬 가능)

Phase 6:
  Phase 5 complete ──→ Epic 17 (API surface stable before agentic layer)
```

---

## 파일 구조

```
docs/plans/apr-5-v0.2/
├── 00-overview.md            (이 문서)
├── epic-12-data-enrichment.md
├── epic-13-query-intelligence.md
├── epic-14-decomposition-api.md
├── epic-15-drinking-window.md
├── epic-16-security-batch.md
└── epic-17-agentic-async.md
```
