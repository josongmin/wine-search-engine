# Epic 18 — Feedback Loop Core: Log → Debias → Retrain → A/B → Rollback

**Phase:** C (SOTA++ 도약)
**우선순위:** P1 — 시스템 진화의 핵심
**의존:** Epic-10 (LambdaMART), Epic-17 (Calibration), Epic-04 (관측성)
**2026 라벨:** `STILL_SOTA`
**학습 필요:** `경량 피팅 필요`

---

## 왜 — SOTA++ Gap

현재 시스템은 **열린 루프(open-loop)** — 사용자 행동 데이터가 모델로 돌아가지 않음.
- Click-through 데이터 수집 없음
- LambdaMART가 offline 학습 후 hot-reload 가능하지만 trigger 없음
- A/B 실험 인프라 없음
- Ranking quality 저하 감지 없음

**업계 SOTA:**
- Google: Continuous online learning, real-time feature updates
- Amazon: Click model → position-debiased relevance → LTR retrain (daily)
- Airbnb: Session-based search ranking with real-time personalization
- LinkedIn: Per-session GBDT reranking with impression features

**학계 SOTA:**
- Position-Debiased Learning (Joachims et al., 2017) — click data → unbiased relevance
- Counterfactual LTR (Swaminathan & Joachims, 2015) — IPS-weighted learning from logs
- Contextual Bandits (Li et al., 2010) — LinUCB for explore/exploit
- Neural Bandit (Riquelme et al., 2018) — Thompson sampling with neural networks

---

## Task 목록

### T18-1. Implicit Feedback Collection

**현재:** 없음

**변경:**
- Click event: `(query, queryPlan, result_list, clicked_entity_id, position, dwell_time_ms)`
- Non-click event: `(query, result_list, impressions, no_click)`
- Add-to-cart / purchase (장기)
- 저장: `pg_search_feedback` 테이블 + `search-feedback.schema.ts`
- 수집 엔드포인트: `POST /v1/feedback/implicit`

---

### T18-2. Position-Debiased Relevance Labels

**현재:** eval은 LLM judge 기반 (offline)

**변경:**
- Click position bias 보정: `P(click | relevant, position) = P(examine | position) × P(click | relevant)`
- IPS (Inverse Propensity Scoring) 가중치
- Examination model: position → examination probability (로그 데이터에서 학습)

---

### T18-3. LTR Retrain Pipeline (Automated)

**현재:** `scripts/eval/run-eval-and-train-ltr.ts` 수동 실행

**변경:**
- Daily batch job: feedback 데이터 → LTR training examples → LambdaMART retrain
- Model validation: NDCG@10 on held-out set >= baseline (or reject)
- Model registry: `ltr_model_registry` 에 자동 저장
- Hot-reload: 앱 재시작 없이 모델 교체 (이미 `container-runtime-support.ts`에서 지원)

**파이프라인:**
```
pg_search_feedback → position-debias → training examples
                  → LambdaMART train → validation → model registry
                  → hot-reload → production serving
```

---

### T18-4. A/B Experiment Infrastructure

**현재:** 없음

**변경:**
- `ExperimentAssignment` — query-level randomization (user_id hash % bucket)
- `experiment_id`, `variant` 필드를 response meta에 추가
- Metric segmentation: per-experiment NDCG, CTR, conversion
- `ExperimentConfigPort` → config 관리 (JSON 또는 DB)

---

### T18-5. Online Quality Monitoring

**현재:** offline eval만

**변경:**
- Real-time CTR tracking per query class
- Zero-result rate monitoring
- Ranking quality degradation alert: CTR drop > 10% → alert
- Automatic rollback: quality gate 실패 시 이전 모델로 자동 복원

---

### T18-6. Session Context (Personalization 기반, 선택)

**현재:** `preferenceAlignment = 0.5` 하드코딩

**변경:**
- Phase 1: Session-level context (이전 검색 → 현재 검색 연결)
  - "barolo" 검색 후 "similar wines" → Barolo context 유지
- Phase 2: User preference embedding
  - Click/purchase history → user taste vector
  - `preferenceAlignment` = cosine(user_vector, candidate_vector)
- Phase 3: Contextual bandit for explore/exploit balance

---

### T18-7. Out of Scope 명시

다음은 가치가 크더라도 **이 epic의 완료 조건에 포함하지 않는다.**

- proactive recommendation
- watchlist notification productization
- multimodal pairing assistant
- cellar management
- agent OS / recommendation platform

이 항목들은 **feedback loop core가 안정화된 이후 별도 product epic**으로 분리한다.

---

## 완료 조건

- Click data 수집 + position debias 동작
- LTR 자동 retrain pipeline (daily)
- A/B 실험 인프라 동작
- CTR / zero-result / rollback monitoring 동작
- automatic rollback 가능
- session context는 있으면 가산점이지만 gate는 아님
