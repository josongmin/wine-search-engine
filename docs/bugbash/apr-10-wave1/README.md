# Bugbash Apr-10 Wave 1 — 작업 인덱스

**감사 기간**: 2026-04-10  
**감사 방법**: 10-에이전트 병렬 × 6라운드 (총 ~60 agent-run)  
**발견 버그**: P0 17건 / P1 44건 / P2 28건 / P3 4건

---

## 원본 감사 파일

| 파일 | 내용 |
|------|------|
| [wave1-raw.md](wave1-raw.md) | 전체 감사 로그 (RCA 포함, ~1600줄) |
| [agent-pipeline-audit.md](agent-pipeline-audit.md) | agent request→response 구간 집중 감사 |
| [pending-calibration-inventory.md](pending-calibration-inventory.md) | 데이터 기반 calibration 대기 항목 목록 |

---

## Epic 구조

patch-on-patch 없이 구조적으로 해결하기 위해 5개 epic으로 묶었다.
각 epic은 독립적으로 진행 가능하나 **E2 → E3 → E1** 순서가 효과 최대화에 유리.

| Epic | 제목 | P0 | P1 | 핵심 지표 |
|------|------|----|----|-----------|
| [E1](epics/E1-retrieval-correctness.md) | Retrieval Correctness | 3 | 4 | recall@20, region/Doc2Query 정상화 |
| [E2](epics/E2-score-decision-pipeline.md) | Score & Decision Pipeline | 3 | 5 | NDCG 0.105→0.75+, ambiguous 83%→<20% |
| [E3](epics/E3-resilience-circuit-breakers.md) | Resilience & Circuit Breakers | 0 | 6 | Vespa/reranker down 시 <100ms fast-fail |
| [E4](epics/E4-agent-pipeline-integrity.md) | Agent Pipeline Integrity | 2 | 10 | grounding 오염 제거, tool retry 제거 |
| [E5](epics/E5-data-hygiene-ssot.md) | Data Hygiene & SSoT | 1 | 1 | migration 안전, 상수 drift 제거 |

---

## 즉시 실행 가능한 P0 (코드 1-5줄, 30분 이내)

순서대로 실행하면 가장 빠른 효과:

```
1. E2: LTR 없을 때 entropy gate bypass          → ambiguous 83% → <20%
2. E1: mapping.ts에 case 'region': 1줄 추가     → region 필터 즉시 복구
3. E1: sparseRank 역전 수정                     → popularity 신호 정상화
4. E5: migration 005에 duplicate 정리 CTE 추가  → 배포 블로커 제거
5. E5: ETL acidity/tannin=0 falsy 처리 수정    → sensory attribute 인덱싱 복구
6. E4: criticScore NaN 가드 4곳               → grounding 오염 차단
7. E4: agent-orchestrator:1052,1072에 return  → CB open 시 정상 종료
```

---

## 전체 버그 ID 매핑

### 🔴 P0
| ID | Epic | 제목 |
|----|------|------|
| RCA-01 | E2 | entropy abstain gate 수학적 불가능 |
| RCA-02 | E2 | NDCG@10 0.105 (-73%) |
| BUG-01 | E1 | region positive filter drop |
| BUG-02 | E1 | synthetic_queries 스키마 누락 |
| W2-BUG-01 | E1 | learned_sparse rank profile 사망 |
| RCA5-08 | E1 | 빈 쿼리 배열 → invalid YQL |
| AG-01 | E4 | criticScore NaN → JSON null grounding 오염 |
| BUG-DS01 | E4 | catch flag control flow 누락 |
| BUG-18 | E5 | migration 005 duplicate 미정리 |
| RCA-03 | E3 | 17% failed (Vespa 미연결 등) |
| RCA5-01 | E2 | (RCA-01 동일) |
| RCA5-03 | E1 | (W2-BUG-01 동일) |
| SCAN4-01 | E1 | sparseRank ∈ (0,1) → popularity 신호 역전 |
| SCAN4-04 | E5 | ETL acidity/tannin=0 → falsy 처리로 Vespa 인덱싱 누락 |
| W3-01 | E5 | `rollbackToSnapshot()` 빈 스냅샷 → 전체 entities 삭제 ✅ 수정됨 |

### 🟠 P1 (주요)
| ID | Epic | 제목 |
|----|------|------|
| RCA-04 | E2 | conformal calibration alpha 불일치 |
| BUG-03 | E3 | HttpCrossEncoderReranker CB 없음 |
| BUG-04 | E3 | anchor 임베딩 cache bypass |
| BUG-DS02 | E4 | LLM numeric string reject |
| BUG-DS03 | E4 | deprecated step.action fallback 없음 |
| BUG-12 | E2 | feature-parity-hash wiring 없음 |
| BUG-13 | E2 | extractExtendedLTRFeatures 테스트 없음 |
| BUG-14 | E1 | lookahead 문자 클래스 오류 |
| BUG-15 | E5 | SOFT_CONSTRAINT_ATTRIBUTES 3곳 중복 |
| BUG-DS04 | E5 | RRF k SSoT 위반 |
| W2-BUG-02 | E3 | Vespa CB 없음 |
| W2-BUG-03 | E3 | Redis CB 없음 |
| W2-BUG-04 | E3 | AbortSignal propagation 끊김 |
| W2-BUG-05 | E3 | request_id downstream 미전파 |
| W2-BUG-09 | E2 | alpha 상수 SSoT 위반 |
| W2-BUG-10 | E2 | feedback→calibration 파이프라인 미연결 |
| SCAN4-10 | E2 | LTR weights DB 로드 후 Zod 검증 없음 |
| SCAN4-08 | E3 | 채널별 검색 timeout 미설정 |
| SCAN4-06 | E4 | injection judge 임베디드 JSON bypass |
| W2-02 | E4 | anthropic-chat-llm cache token NaN |
| W2-03 | E4 | openai-chat-llm prompt_tokens NaN 가드 없음 |
| IDX-04 | E1 | grape varieties 응답 필드 누락 |
| IDX-05 | E1 | acidity hard/soft 분류 불일치 |
| IDX-06 | E5 | preferenceAlignment 항상 0.5 |
| IDX-09 | E1 | wine_aware rank profile 2024 하드코딩 |
| IDX-10 | E1 | BM25 saturation 상수 불일치 |
| IDX-11 | E1 | critic_score 0% coverage |
| IDX-12 | E1 | producerPrestige coverage 낮음 |
| SCAN4-05 | E1 | "dry" false positive |
| SCAN4-09 | E5 | ETL critic score numeric string |
| SCAN4-11 | E2 | finalScore re-clamp 누락 |
| SCAN4-12 | E2 | default weights 합산 0.95 |
| SCAN4-13 | E5 | alias bulk insert N+1 |
| SCAN4-14 | E5 | 유럽식 소수점 comma 파싱 |
| SCAN4-15 | E5 | generate-aliases.ts `\b` 사용 |
| SCAN4-16 | E5 | 1자 토큰 alias 광범위 매칭 |
| W2-04 | E4 | isAbortError 미사용 |
| W2-05 | E4 | circuit breaker TOCTOU |
| IDX-03 | E1 | sensory 속성 척도 주석 오류 |
| IDX-07 | E1 | oak_treatment LLM_ALLOWED_ATTRIBUTES 미등록 |
| IDX-08 | E1 | synthetic_queries BM25 선언 vs 스키마 미선언 (P0, BUG-02와 연계) |
| W2-01 | E1 | SOFT_CONSTRAINT_ATTRIBUTES 5개 누락 하드 오분류 |
| RCA-03 | E3 | 17% 요청 실패 — Vespa/embedding 미연결 복합 |
| RCA-06 | E2 | eval 코퍼스 파일 경로 불일치 |
| RCA-07 | E3 | ONNX 없음 → readiness down (heuristic 동작 중) |
| SCAN4-02 | E3 | OpenAI embedding CB 미등록 (P0) |
| SCAN4-03 | E3 | Vespa CB 미등록 (P0) |
| SCAN4-07 | E3 | vespa-client AbortSignal 미전파 |
| W2-06 | E2 | lambdamart-ranker featureNames[0] 폴백 오류 숨김 |
| W6-P0 | E5 | stubTrain() 하드코딩 — LTR 재학습 미작동 (P0) |
| W6-P1-1 | E5 | SELECT * FROM entities LIMIT 없음 |
| W6-P1-2 | E5 | embedding readiness stub 'up' 허위 보고 |
| W6-P1-3 | E5 | 소프트/하드 제약 분류 split-brain |
| W6-P1-4 | E5 | IPS propensity 하드코딩 |
| W6-P2-1 | E5 | Python ETL grape_family split()[0] |
| W6-P2-2 | E5 | 드링킹 윈도우 vintageYear+2 |
| W6-P2-3 | E5 | feedback_signals/threshold_proposals 인덱스 누락 |
| W6-P3 | E5 | health probe HTTP 증폭 |

---

## 에픽 간 의존성 (실행 순서)

아래 의존성을 지키지 않으면 fix가 불완전하거나 무효화됨:

```
E5-P2-1 (SOFT_CONSTRAINT_ATTRIBUTES SSoT)
  └─ 선행 필요: E1-P3-3 (acidity 분류 통일)
               E5-P4b 전체 (split-brain 해소)

E5-P4b-7 (stubTrain() 제거 → 실제 LTR)
  └─ 선행 필요: E2-P3-5 (LTR 학습 실행)

E2-P2-1 (calibration-report.ts 실행)
  └─ 선행 필요: E2-P3-5d (eval corpus 경로 통일, RCA-06)
               calibration store breakpoint_count > 0 게이트

E1-P2-1 (synthetic_queries 스키마 추가)
  └─ 선행 필요: E2-P3-2 (rerank_score LTR feature — Doc2Query 인덱싱 완료 후)

E3-P3-1 (AbortSignal end-to-end)
  └─ 선행 필요: SCAN4-07 fix (vespa-client.query() signal 파라미터 추가)

E4-P1-2 (catch flag return)
  └─ 선행 필요: buildCircuitOpenFallback() 함수 존재 확인 (E4-P3c-4)
```

**권장 실행 순서**: E5-P1/P2 → E1-P1 → E2-P1 → E3-P1/P2 → E4-P1 → E5-P3/P4 → E2-P2/P3 → E1-P2/P3 → E4-P2/P3

---

## 진행 상태

| Epic | 상태 | 담당 |
|------|------|------|
| E1 | 🔲 대기 | — |
| E2 | 🔲 대기 | — |
| E3 | 🔲 대기 | — |
| E4 | 🔲 대기 | — |
| E5 | 🔲 대기 | — |

*마지막 업데이트: 2026-04-10 (최종 감사 완료 — DoD 갭 보강, 에픽 간 의존성 문서화, orphan W6-P3 추가)*
