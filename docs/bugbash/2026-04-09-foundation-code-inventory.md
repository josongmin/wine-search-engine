# 파운데이션 코드 인벤토리 (2026-04-09 세션)

> 5라운드 리뷰에서 발견된 ~30개의 파운데이션 모듈 추적 문서.
> 프로덕션 코드에 연결되지 않은 모듈은 Phase B/C 통합 전까지 dead code로 남을 위험이 있으므로 명시적으로 추적한다.

---

## 테스트 전용 파운데이션 모듈 (프로덕션 미연결)

### Phase B 파운데이션 — Epic 10: Ranking SOTA

| 모듈 | 목적 | 현재 상태 | 통합 대상 | 통합 시점 | 선행 조건 |
|------|------|-----------|-----------|-----------|-----------|
| `src/domain/ranking/service/ltr-features.ts` | LTR 피처 벡터 추출 (향후 LTR 모델 입력 / 분석) | test-only | `search-usecase-hybrid-ranking-pipeline.ts` | Phase B 시작 | LTR 모델 학습 파이프라인 구축 |
| `src/domain/ranking/service/ltr-feature-logger.ts` | LTR 피처 텔레메트리 로거 | test-only | telemetry pipeline | Phase B 시작 | 없음 |

> **참조**: [docs/bugbash/plan/epic-10-ranking-sota.md](plan/epic-10-ranking-sota.md)
>
> **REMOVED (2026-04-10)**: LightGBM 파운데이션(`lightgbm-model.ts`, `lightgbm-scorer.ts`,
> `lightgbm-model-loader.ts`, `feature-parity-hash.ts`, `feature-parity-checker.ts`)은
> 학습 파이프라인·클릭 로그·gold split·프로덕션 wiring이 하나도 존재하지 않는 상태에서
> premature 하게 추가되었기에 삭제되었다. Retrieval ceiling 측정이 선행되지 않은
> LTR 구축은 ROI 근거가 없다. `model-registry-entry.ts` / `retrain-orchestrator.ts` 는
> 프레임워크 중립 `SerializedModelPayload` 플레이스홀더로 교체되어 registry-기반
> retrain 플로우는 그대로 살려두었다.

### Phase B 파운데이션 — Epic 11: Entity Resolution (Knowledge Graph)

| 모듈 | 목적 | 현재 상태 | 통합 대상 | 통합 시점 | 선행 조건 |
|------|------|-----------|-----------|-----------|-----------|
| `src/domain/knowledge-graph/model/wine-kg.ts` | 와인 도메인 타입 그래프 모델 (노드, 엣지, 타입) | test-only (KG 체인 루트) | `entity-resolver.ts`, ontology expansion | Phase B 시작 | `entity-ontology.json` 시드 데이터 |
| `src/domain/knowledge-graph/service/kg-operations.ts` | BFS 탐색, 경로 검색, 서브그래프 추출 | test-only (wine-kg 소비자) | `entity-resolver.ts` | Phase B 시작 | `wine-kg.ts` 통합 후 |
| `src/domain/knowledge-graph/loader/load-seed-kg.ts` | `entity-ontology.json` → WineKG 로딩 | test-only (wine-kg 소비자) | `container-core.ts` startup | Phase B 시작 | `entity-ontology.json` ETL 완료 |

> **참조**: [docs/bugbash/plan/epic-11-entity-resolution.md](plan/epic-11-entity-resolution.md)

### Phase B 파운데이션 — Epic 16: Learned Fusion & Cascade

| 모듈 | 목적 | 현재 상태 | 통합 대상 | 통합 시점 | 선행 조건 |
|------|------|-----------|-----------|-----------|-----------|
| `src/domain/retrieval/service/per-class-fusion-config.ts` | 쿼리 클래스별 RRF fusion 상수 레지스트리 | test-only | `hybrid.usecase.ts` fusion 단계 | Phase B 중반 | 쿼리 클래스 분류기 안정화 |
| `src/domain/retrieval/service/query-difficulty-estimator.ts` | 쿼리 난이도 사전 추정 (deterministic prior) | test-only | `dynamic-top-k-selector.ts` → `hybrid.usecase.ts` | Phase B 중반 | 없음 (pure function) |
| `src/domain/retrieval/service/dynamic-top-k-selector.ts` | 난이도/레이턴시 기반 채널별 top-K 동적 선택 | test-only (query-difficulty 소비자) | `hybrid.usecase.ts` retrieval 단계 | Phase B 중반 | `query-difficulty-estimator.ts` 통합 후 |

> **참조**: [docs/bugbash/plan/epic-16-learned-fusion-cascade.md](plan/epic-16-learned-fusion-cascade.md)

### Phase B 파운데이션 — Epic 17: Confidence Calibration

| 모듈 | 목적 | 현재 상태 | 통합 대상 | 통합 시점 | 선행 조건 |
|------|------|-----------|-----------|-----------|-----------|
| `src/domain/calibration/service/aurc.ts` | AURC (Area Under Risk-Coverage) — selective prediction 품질 | test-only | `eval-runner.ts`, `calibration-evaluator.ts` | Phase B 후반 | human gold split 데이터 |
| `src/domain/calibration/service/ece.ts` | ECE (Expected Calibration Error) — 확률 보정 품질 | test-only | `eval-runner.ts`, confidence pipeline | Phase B 후반 | 보정 대상 스코어 파이프라인 |
| `src/domain/calibration/service/platt-scaling.ts` | Platt scaling — sigmoid 보정 (raw score → calibrated probability) | test-only | `calibrator.ts` (resolver) 또는 ranking reranker | Phase B 후반 | 보정 학습 데이터셋 |

> **참조**: [docs/bugbash/plan/epic-17-confidence-calibration.md](plan/epic-17-confidence-calibration.md)

### Phase C 파운데이션 — Epic 15: Learned Query Understanding

| 모듈 | 목적 | 현재 상태 | 통합 대상 | 통합 시점 | 선행 조건 |
|------|------|-----------|-----------|-----------|-----------|
| `src/domain/query/service/hyde-prompt-builder.ts` | HyDE (Hypothetical Document Embeddings) 프롬프트 생성 | test-only | `planner.ts` → embedding retrieval 경로 | Phase C 시작 | SPLADE/dense 모델 서빙 인프라 |
| `src/domain/query/service/hedge-retrieval-policy.ts` | 불확실 intent 시 다중 retrieval 경로 헤지 정책 | test-only | `intent-authority.ts` → `planner.ts` | Phase C 시작 | intent classifier 불확실성 출력 |
| `src/domain/query/service/intent-authority.ts` | Rule-based prior + learned model → 최종 intent 결정 오케스트레이션 | test-only (hedge-retrieval 소비자) | `planner.ts` | Phase C 시작 | learned intent model 서빙 |

> **참조**: [docs/bugbash/plan/epic-15-learned-query-understanding.md](plan/epic-15-learned-query-understanding.md)

### Phase C 파운데이션 — Epic 18: Feedback Loop

| 모듈 | 목적 | 현재 상태 | 통합 대상 | 통합 시점 | 선행 조건 |
|------|------|-----------|-----------|-----------|-----------|
| `src/domain/feedback/model/feedback-event.ts` | 암묵적 피드백 이벤트 스키마 (click, dwell, cart 등) | test-only (피드백 체인 루트) | HTTP route (`POST /feedback`) | Phase C 시작 | 클라이언트 이벤트 전송 구현 |
| `src/domain/feedback/port/feedback-collector.port.ts` | 피드백 수집기 포트 인터페이스 | test-only (feedback-event 소비자) | DI container | Phase C 시작 | `feedback-event.ts` 통합 후 |
| `src/infrastructure/adapter/in-memory-feedback-collector.ts` | 개발/테스트용 인메모리 피드백 수집기 | test-only (port 구현체) | `container-stubs.ts` | Phase C 시작 | `feedback-collector.port.ts` 통합 후 |
| `src/domain/feedback/service/position-debias.ts` | IPS 기반 position-debiased relevance 추정 | test-only | `training-data-extractor.ts` → LTR 파이프라인 | Phase C 중반 | 클릭 로그 수집 운영 |
| `src/domain/feedback/service/training-data-extractor.ts` | 피드백 이벤트 → LTR 학습 데이터 변환 | test-only (position-debias 소비자) | offline LTR 학습 잡 | Phase C 중반 | `position-debias.ts` 통합 후 |
| `src/domain/feedback/service/online-quality-monitor.ts` | 롤링 윈도우 기반 온라인 품질 모니터링 (CTR, 저하 감지) | test-only | `auto-rollback-decision.ts` → 운영 파이프라인 | Phase C 후반 | 프로덕션 트래픽 |
| `src/domain/feedback/service/auto-rollback-decision.ts` | 품질 저하 시 자동 롤백 결정 로직 | test-only (online-quality 소비자) | experiment runtime / deploy pipeline | Phase C 후반 | `online-quality-monitor.ts` 통합 후 |
| `src/domain/experiment/service/experiment-assignment.ts` | 결정론적 A/B 실험 할당 (requestId 해시 기반) | test-only | `hybrid.usecase.ts` 또는 middleware | Phase C 시작 | 실험 설정 저장소 |

> **참조**: [docs/bugbash/plan/epic-18-feedback-loop.md](plan/epic-18-feedback-loop.md)

### 측정 인프라 파운데이션 — Epic 13: Eval & Benchmark

| 모듈 | 목적 | 현재 상태 | 통합 대상 | 통합 시점 | 선행 조건 |
|------|------|-----------|-----------|-----------|-----------|
| `src/domain/evaluation/service/judge-bias-correction.ts` | LLM 판정 편향 보정 (lenience, position bias) | test-only | `eval-runner.ts` judge pipeline | Phase A 완료 시 | human gold split 데이터 |
| `src/domain/evaluation/service/position-swap-detector.ts` | Pairwise judge 순서 일관성 검증 | test-only (judge-bias 소비자) | `eval-runner.ts` pairwise judge | Phase A 완료 시 | `judge-bias-correction.ts` 통합 후 |
| `test/benchmark/agent/retrieval-ceiling-metrics.ts` | Retrieval ceiling 진단 (Oracle Recall, retrieval 병목 분석) | bench-only | benchmark harness | Phase A 완료 시 | gold relevance 라벨 |
| `test/benchmark/agent/ranking-metrics.ts` | nDCG, MRR, MAP, alpha-nDCG 랭킹 메트릭 유틸리티 | bench-only | benchmark harness, `retrieval-ceiling-metrics.ts` | Phase A 완료 시 | 없음 (pure function) |

> **참조**: [docs/bugbash/plan/epic-13-eval-benchmark.md](plan/epic-13-eval-benchmark.md)

---

## 프로덕션 연결 완료 모듈

| 모듈 | 소비자 (프로덕션 코드) | 비고 |
|------|----------------------|------|
| `src/observability/stage-timer.ts` | `hybrid.usecase.ts`, `request-execution-context.ts` | 파이프라인 단계별 레이턴시 측정 |
| `src/observability/silent-skip-counters.ts` | `retrieval-channel.ts`, `candidate-pool.ts`, `semantic-embedding-combiner.ts` | silent fallback 카운터 |
| `src/observability/circuit-breaker-registry.ts` | `anthropic-llm-injection-classifier.ts`, `openai-chat-llm.ts`, `anthropic-chat-llm.ts` | LLM 어댑터 서킷 브레이커 |
| `src/domain/shared/utils/stable-comparator.ts` | `trace-vocab-aligner.ts` | 안정 정렬 비교 유틸리티 |
| `src/domain/shared/utils/vintage.ts` | `tool-schemas.ts`, `tool-executor.ts`, `search-response.schema.ts`, `search-response-v2.schema.ts`, `watchlist.schema.ts` | 빈티지 파싱/검증 |

---

## 요약

| 분류 | 모듈 수 |
|------|---------|
| 테스트 전용 파운데이션 | 25 |
| 벤치마크 전용 | 2 |
| 프로덕션 연결 완료 | 5 |
| **합계** | **32** |

### 통합 우선순위 (다음 액션)

| 우선순위 | 시점 | 모듈 그룹 | 다음 단계 |
|----------|------|-----------|-----------|
| **P0** | Phase A 완료 | Epic 13 측정 인프라 (4개) | `eval-runner.ts`에 judge-bias-correction 연결, benchmark harness에 ceiling metrics 연결 |
| **P1** | Phase B 시작 | Epic 10 LTR (3개) + Epic 11 KG (3개) | LTR 모델 학습 파이프라인 구축 후 `ltr-features` 연결, KG 시드 로더를 컨테이너 startup에 등록 |
| **P2** | Phase B 중반 | Epic 16 Fusion (3개) + Epic 17 Calibration (3개) | `hybrid.usecase.ts`에 per-class fusion 및 dynamic top-K 연결 |
| **P3** | Phase C 시작 | Epic 15 Query (3개) + Epic 18 Feedback (8개) + Experiment (1개) | 피드백 HTTP route 추가, intent authority를 planner에 연결 |

### 체인 의존성 맵

아래 모듈은 다른 test-only 모듈만 소비하므로, 체인 전체가 통합될 때까지 개별 통합 의미가 없다:

```
Epic 10: ltr-features, ltr-feature-logger (LightGBM 체인 제거 완료)
Epic 11: wine-kg → kg-operations, wine-kg → load-seed-kg
Epic 13: judge-bias-correction → position-swap-detector
Epic 15: hedge-retrieval-policy → intent-authority
Epic 16: query-difficulty-estimator → dynamic-top-k-selector
Epic 17: (독립적 — 개별 통합 가능)
Epic 18: feedback-event → feedback-collector.port → in-memory-feedback-collector
         position-debias → training-data-extractor
         online-quality-monitor → auto-rollback-decision
```

---

> **유지 규칙**: 파운데이션 모듈이 프로덕션에 연결되면 이 문서의 해당 행을 "프로덕션 연결 완료" 섹션으로 이동한다. 모든 모듈이 이동 완료되면 이 문서를 아카이브한다.
