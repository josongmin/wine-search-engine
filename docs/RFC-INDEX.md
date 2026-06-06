# Wine Intelligence Engine — RFC 목차·의존성

마스터 SSOT는 **`RFC-000: Wine Intelligence Engine Master Architecture.md`** 이다. 다른 RFC는 영역별 확장이며, **정의가 충돌하면 RFC-000을 따른다.**

## 권장 읽기 순서

1. **RFC-000** — 한 줄 정의, 2-track, Planner/Policy, SignalSet, Decision §8.4, Evidence §9, Eval §10, §14 플라이휠  
2. **RFC-001** — Entity identity graph (logical graph / projection)  
3. **RFC-002** — Ingestion·canonicalization (raw → SSOT)  
4. **RFC-003** — Typed·scoped alias (core vs overlay)  
5. **RFC-004** — Attribute·constraint 정규화 (NL → 수치)  
6. **RFC-005** — Query planner·Policy compiler (`QueryPlanV1`, `query_class` = Q)  
7. **RFC-006** — Entity resolver (calibrated C, Δ, A; abstention)  
8. **RFC-007** — Decision layer (최종 authority; RFC-000 §8과 정합)  
9. **RFC-016** — Admission Gate & failure semantics (`FailureReason` SSOT, `EntityRef` sealing)  
10. **RFC-008** — Response·`EvidenceItem` (API·LLM 공통 출력 SSOT)  
11. **RFC-009** — Evaluation·Decision Utility (§10.7)  
12. **RFC-010** — Data flywheel (RFC-000 §14 확장)  
13. **RFC-011** — Mixed query solver (anchor + constraint + signal)  
14. **RFC-012** — Hybrid retrieval (sparse+dense+fusion)  
15. **RFC-013** — Ranking signals (SignalSet; authority 아님)  
16. **RFC-014** — Search API·external contract (RFC-008 매핑)
17. **RFC-015** — Determinism, Replay, operational controls (스냅샷·임계 버전·증거 게이트·kill switch)
18. **RFC-017** — IR Quality Flywheel: Vivino ETL·Golden Query Set·LTR·Cross-Encoder (RFC-002·009·010·012·013 실행 계획)
19. **RFC-019** — NL Mapper Elevation to Ontology-Grounded Semantic Constraint Compiler
20. **RFC-020** — Constraint Extraction Measurement Framework
21. **RFC-021** — Primitive Search Surface and Agent-Orchestrated Query Composition
22. **RFC-022** — LLM-Structured Query Analysis with Deterministic Tool Dispatch

## 문서 목록 (파일명)

| ID | 파일 | 한 줄 |
|----|------|--------|
| 000 | `RFC-000: Wine Intelligence Engine Master Architecture.md` | 전체 아키텍처·Decision·Evidence·Eval SSOT |
| 001 | `RFC-001: Entity Identity Graph SSOT.md` | Identity graph·merge·projection |
| 002 | `RFC-002.md` | Catalog ingestion·lineage |
| 003 | `RFC-003.md` | Alias system |
| 004 | `RFC-004.md` | Facet/attribute normalization |
| 005 | `RFC-005.md` | Query planner & policy |
| 006 | `RFC-006.md` | Entity resolver |
| 007 | `RFC-007.md` | Decision layer |
| 008 | `RFC-008.md` | Response & evidence |
| 009 | `RFC-009.md` | Evaluation |
| 010 | `RFC-010.md` | Learning loop / data flywheel |
| 011 | `RFC-011.md` | Mixed query solver |
| 012 | `RFC-012.md` | Hybrid retrieval |
| 013 | `RFC-013.md` | Ranking signals |
| 014 | `RFC-014.md` | Search API contract |
| 015 | `RFC-015.md` | Determinism, Replay, kill switch, drift |
| 016 | `RFC-016.md` | Admission Gate, `FailureReason`, identity·snapshot·evidence closure |
| 017 | `RFC-017.md` | IR Quality Flywheel: Vivino ETL·Golden Query Set·LTR·Cross-Encoder |
| 019 | `docs/rfc/RFC-019-nl-mapper-coverage.md` | Rule table를 ontology-grounded constraint compiler로 승격 |
| 020 | `docs/rfc/RFC-020-constraint-extraction-measurement.md` | Constraint extraction 측정 프레임워크 |
| 021 | `docs/rfc/RFC-021-primitive-search-and-agent-orchestration.md` | Public search primitive화 + agent orchestration 경계 |
| 022 | `docs/rfc/RFC-022-llm-structured-query-analysis.md` | Analyze 단계 LLM-structured 승격(typed analysis) + deterministic tool dispatch 유지 + bounded FSM recovery loop + Failure Explanation Layer + multi-turn session state |

## 개념·용어 정렬 (논리 연결)

| 개념 | 정의 위치 | 비고 |
|------|-----------|------|
| **EntityId** | RFC-001 | 모든 entity 참조의 불변 ID |
| **EntityRef** | RFC-001 §1.5, RFC-016 | `entity_id` + `identity_signature` + `snapshot_ref` — 런타임 확정 참조 |
| **FailureReason** | RFC-016 | `resolved` 금지·downgrade 사유 SSOT enum |
| **QueryPlanV1** | RFC-000 §4.1, RFC-005 | `query_class`(Q), `policy`, `constraints`, `admission_context` |
| **ConstraintBundle** | RFC-005 | hard / soft / inferred — **SSOT 이름** |
| **ConstraintSet** | RFC-011 등 | ConstraintBundle과 **동일 역할**로 쓰인 별칭; 구현 시 Bundle으로 통일 권장 |
| **SignalSet** | RFC-000 §6 | Ranking이 **생산**하는 신호; 최종 확정 권한 없음 |
| **C, Δ, A, Q** | RFC-000 §8.4, RFC-006·007 | 캘리브레이션된 confidence, 갭, ambiguity, query class |
| **decision_status** | RFC-000 §8.2, RFC-007·008·014 | `resolved` \| `ambiguous` \| `failed` — **"fallback" status 금지** |
| **next_action** | RFC-000 §8.2, RFC-007·008·014 | `return_result` \| `clarify` \| `hybrid_search` \| `fail` — 라우팅·정책 매핑 |
| **decision_confidence_c** / **decision_confidence** | RFC-006, RFC-007·008 | calibrated **decision** 신호; IR·retrieval fusion과 혼동 금지 |
| **retrieval_fusion_score** | RFC-012, RFC-013 | retrieval 단계 혼합 trace; 최종 ranking score와 동일시 금지 |
| **mapping_confidence** | RFC-004 | NL→attribute 매핑 신뢰도; decision `C`와 별개 |
| **EvidenceItem** | RFC-000 §9, RFC-008 | `contribution`+`strength`+`provenance`; % 단정 비권장 |
| **Decision Utility** | RFC-000 §10.7, RFC-009 | 릴리즈·학습의 상한선 지표 |
| **DecisionSnapshot** | RFC-015, RFC-007·008 | 모델·인덱스·정책·임계 프로파일 버전 — 재현·Replay |
| **ThresholdProfileV1** | RFC-005 §7.4 | query class별 `resolve_tau` / `gap_tau` SSOT |

## Canonical Name Registry (구현 시 강제)

RFC 간 동일 개념에 대해 미묘하게 다른 이름이 사용될 수 있다. **코드 구현 시 아래 canonical name만 사용**하고, deprecated alias는 lint rule로 차단을 권장한다.

| Canonical Name | Deprecated Aliases (사용 금지) | 정의 위치 | 비고 |
|----------------|-------------------------------|-----------|------|
| `decision_confidence` | `calibrated_confidence`, `top1_score`, `confidence` (단독) | RFC-007, RFC-008 | Decision 레벨의 calibrated C |
| `decision_confidence_c` | `calibrated_confidence_c` | RFC-006 | Resolver 출력의 calibrated C — `decision_confidence`와 동일 의미, Resolver context에서 사용 |
| `ConstraintBundle` | `ConstraintSet`, `constraints` (타입 없이) | RFC-005 §5.1 | hard/soft/inferred 구조. RFC-011 등에서 `ConstraintSet`으로 쓰인 것은 동의어이나 구현은 `ConstraintBundle`로 통일 |
| `decision_status` | `status` (단독), `resolve_status`, `engine_status` | RFC-000 §8.2, RFC-007 | `resolved` \| `ambiguous` \| `failed` 셋만 |
| `next_action` | `recommended_action`, `fallback_action` | RFC-000 §8.2, RFC-007 | `return_result` \| `clarify` \| `hybrid_search` \| `fail` |
| `evidence_items` | `evidence` (단독), `evidence_list`, `reasons` | RFC-008, RFC-014 | EvidenceItem[] — 외부 API에서도 이 이름만 |
| `retrieval_fusion_score` | `fusion_score`, `hybrid_score`, `retrieval_score` | RFC-012 | retrieval 단계 혼합 trace — `decision_confidence`와 혼동 금지 |
| `mapping_confidence` | `parse_confidence`, `extraction_confidence` | RFC-004 | NL→attribute 매핑 신뢰도 — decision `C`와 별개 |
| `parsing_confidence` | `extraction_score` | RFC-002 §6.2 | ingestion 파싱 신뢰도 — 런타임 calibrated C와 동일 스케일 아님 |
| `EntityId` | `entity_id` (소문자 타입명), `wine_id`, `item_id` | RFC-001 | 모든 entity 참조의 불변 ID 타입 |
| `threshold_profile_id` | `profile_id`, `threshold_id` | RFC-005 §7.4 | ThresholdProfileV1 참조 키 |
| `decision_snapshot` | `snapshot`, `version_info` | RFC-015 | DecisionSnapshot 구조체 |
| `confidence_prior` | `alias_prior`, `prior_score` | RFC-003 | alias의 사전 가중치 — calibrated C와 혼동 금지 |
| `failure_reason` | `reason` (단독), `error_reason`, `failure_code` | RFC-016 | `FailureReason` enum 값 (직렬화는 string) — 자유 텍스트 금지 |
| `admission_trace_ref` | `admission_ref`, `gate_trace` | RFC-016, RFC-007·008 | Admission Gate 감사·replay 연결 키 |
| `EntityRef` | — | RFC-001 §1.5, RFC-016 | `entity_id` + `identity_signature` + `snapshot_ref` — resolved 경계의 sealed 참조 |
| `admission_context` | `gate_context`, `seal_requirements` | RFC-005, RFC-016 | Planner가 표면화하는 identity·evidence 필수 조건 |

**Lint 규칙 권장:**

- 코드에서 위 deprecated alias가 변수명·필드명·주석에 사용되면 **warning** 또는 **error**
- API response JSON key는 **canonical name만 허용** (RFC-014)
- 내부 로그·trace에서도 canonical name 사용 — 디버깅 시 이름 혼동 방지

## 파이프라인 요약 (끊김 방지)

```
Query API (RFC-014)
  → Planner + Policy (RFC-005)
  → Track A: Resolver (RFC-006) / Track B: Hybrid retrieval (RFC-012)
  → Signals + Ranking (RFC-011, RFC-013)
  → Decision (RFC-000 §8, RFC-007)
    → Admission Gate (RFC-016) — resolved 최종 closure
  → Response + Evidence (RFC-008, RFC-014)
```

**운영·재현:** RFC-015 (스냅샷·Replay·kill switch) ↔ RFC-009·010·**RFC-016**(admission invariant).

**데이터 경로:** ingestion (RFC-002) → entity·alias SSOT (RFC-001,003) → projection (RFC-001,012) → 플라이휠 (RFC-010, RFC-000 §14).

**평가:** RFC-009 + RFC-000 §10 — IR 보조지표만으로 Decision 품질을 대체하지 않는다.

## 점검 시 흔한 빈틈

- **Ranking·retrieval score = 최종 답**으로 쓰는 설계 → RFC-000 §6·§8 위반  
- **ConstraintSet vs ConstraintBundle** 혼용 → 구현체에서는 **하나로 통일**  
- **calibrated C**와 raw score·`parsing_confidence` 혼동 → 문서별로 이미 구분됨; 코드에서도 분리  
- **LLM 출력 = authority** → RFC-000 전반 위반; explanation만  
- **`decision_confidence` vs `retrieval_fusion_score` vs `mapping_confidence` vs `confidence_prior`** 혼용 → 위 Canonical Name Registry로 분리
- **Temporal eval split** 없이 random split으로 릴리즈 판단 → RFC-009 §10.6 위반
- **Gold set IAA(inter-annotator agreement)** 미측정 → RFC-009 §10.5 추가 필요
- **Blocking recall** 미추적으로 resolver 이전에 정답 탈락 → RFC-006 §3.3
- **Adversarial alias injection** 방어 없음 → RFC-003 §8.2.2
- **AURC / Risk-Coverage curve** 없이 threshold를 accuracy만으로 튜닝 → RFC-009 §5.3 위반
- **`resolved` 경로에 Admission Gate 검사 없음** → RFC-016·RFC-000 §8.7 위반 (identity seal·snapshot·evidence 중 하나라도 누락)
- **`failure_reason` 없이 downgrade/fail** → RFC-016 §6, RFC-008 §2.5 위반 — 디버깅·학습·replay 품질 저하
- **`EntityRef` 없이 `resolved` 노출** → RFC-001 §1.5, RFC-016 §3 위반 — projection 문자열로 identity 대체

이 인덱스는 네비게이션용이다. 수치·수식의 단일 출처는 항상 **RFC-000**이다.

---

## v0.2 실행 계획 (docs/plans/apr-5-v0.2/)

| 파일 | 내용 | Phase |
|------|------|-------|
| `00-overview.md` | 15개 갭 → 6개 Epic 매핑, 의존성 그래프 | — |
| `epic-12-data-enrichment.md` | Critic proxy (LLM), Organic/Wikidata, Food pairing | 4 |
| `epic-13-query-intelligence.md` | ConstraintSAT, Entropy abstain, BK-tree+Soundex | 4 |
| `epic-14-decomposition-api.md` | LLM query decomp ("A vs B"), `retrieval_mode` override | 5 |
| `epic-15-drinking-window.md` | LightGBM drink_from/drink_to regression + ONNX serving | 5 |
| `epic-16-security-batch.md` | Prompt injection (LLM-as-judge), `/v1/batch-search` 207 | 5 |
| `epic-17-agentic-async.md` | Claude tool-use, Redis watchlist webhook, confidence refusal | 6 |
