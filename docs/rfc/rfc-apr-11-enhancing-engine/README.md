# EPIC 2–8: Engine Enhancement Roadmap

> 작성일: 2026-04-11  
> 상태: 계획 단계  
> 기반 문서: `docs/system-overview/agentic-process.md` (R12 기준)

이 디렉터리는 Wine Search Engine을 SOTA++ 수준으로 끌어올리기 위한 EPIC 2–8 작업계획을 담습니다.
각 EPIC은 독립 파일로 관리합니다.

중요:
이 RFC 묶음은 엔진을 더 결정론적이고 안전하며 감사 가능하게 만드는 계획이다.
하지만 **"개같이 입력해도 특정 와인을 복구하는 exact wine retrieval"의 충분조건은 아니다.**
그 목표를 닫으려면 아래의 `TRACK-A` 보강 계획을 함께 진행해야 한다.

---

## EPIC 의존 관계

```
EPIC-1 (Deterministic Core)  ← 모든 EPIC의 선행 조건 — 측정 불가능한 개선은 개선이 아님
EPIC-2 (Constraint IR)       ← EPIC 3·4·5·6·8의 기반
EPIC-3 (Policy Trace)        ← EPIC-8에 trace 제공
EPIC-4 (Evidence System)     ← EPIC-5, EPIC-8에 재료 제공
EPIC-5 (Score DAG)           ← EPIC-6 abstain 개선 + EPIC-8
EPIC-6 (Abstain/Clarify)     ← EPIC-2 soft-tension 결과 소비
EPIC-7 (Contract Executor)   ← EPIC-4 tool result + EPIC-8
EPIC-8 (Audit Record)        ← 모두 완료 후 조립 레이어
```

**구현 순서:** EPIC-1 → TRACK-A(A2/A3) → EPIC-2 → EPIC-5 → (EPIC-3, EPIC-4) → EPIC-6 → EPIC-8 → EPIC-7  
EPIC-5의 rerank safety envelope는 현재 코드에 invariant 갭이 있으므로 EPIC-2와 **병렬로** 착수합니다.  
단, EPIC-5의 score contract는 raw heuristic ratio가 아니라 **bounded normalized score + rank invariant**를 단일 기준으로 사용합니다.  
TRACK-A는 exact recovery의 실제 병목(`anchor miss → resolver 후보 0개`)을 닫는 작업이므로 EPIC-3/4/7보다 먼저 진행합니다.

---

## 파일 목록

| 파일 | EPIC | 상태 |
|------|------|------|
| [EPIC-1-deterministic-core.md](./EPIC-1-deterministic-core.md) | Deterministic Core 봉인 | 계획 |
| [EPIC-2-constraint-semantics.md](./EPIC-2-constraint-semantics.md) | Constraint Semantics Engine 재정의 | 계획 |
| [EPIC-3-planner-policy-graph.md](./EPIC-3-planner-policy-graph.md) | Planner 분해 및 Policy Graph화 | 계획 |
| [EPIC-4-retrieval-evidence.md](./EPIC-4-retrieval-evidence.md) | Retrieval as Evidence System | 계획 |
| [EPIC-5-score-dag.md](./EPIC-5-score-dag.md) | Ranker Score DAG + Safety Envelope | 계획 |
| [EPIC-6-abstain-clarify.md](./EPIC-6-abstain-clarify.md) | Abstain / Clarify / Fail 정책 재설계 | 계획 |
| [EPIC-7-contract-executor.md](./EPIC-7-contract-executor.md) | Agent Contract Executor 승격 | 계획 |
| [EPIC-8-audit-record.md](./EPIC-8-audit-record.md) | Response를 판정 기록물로 확장 | 계획 |
| [TRACK-A-exact-entity-recovery-roadmap.md](./TRACK-A-exact-entity-recovery-roadmap.md) | 난입력 exact wine recovery 보강 트랙 | 계획 |
| [TASK-DAG.md](./TASK-DAG.md) | 구현 태스크 DAG / 선행관계 / work pack | 계획 |

`TASK-DAG.md`에는 wave별 구현 묶음, exit criteria, 병렬 가능 범위까지 정리되어 있다.

---

## 목표 정렬 보강

현재 EPIC 2–8이 직접 해결하는 것:

- deterministic execution
- policy / evidence / score traceability
- rerank safety
- abstain / clarify correctness
- auditability

별도 보강 트랙이 직접 해결해야 하는 것:

- 한글 음차 / 오타 / 부분명칭 / 빈티지 혼합 입력에서 canonical wine entity 복구
- anchor miss 후 same-request corrective retrieval
- shared entity candidate generation SSOT
- ugly-query benchmark 기반 offline / online evaluation

즉 최종 목표가
`"오퍼스원 18"`, `"샤또마고"`, `"로마네꽁티"` 같은 질의에서도
강하게 동작하는 것이라면,
**EPIC 2–8 + TRACK-A를 함께 닫아야 한다.**

---

## 구현 현실 점검

이번 코드 audit 기준으로, EPIC 2–8 중 상당수는 greenfield가 아니다.

| 영역 | 현재 substrate | RFC에서 실제 해야 하는 일 |
|------|----------------|----------------------------|
| EPIC-3 | `QueryPlanV2`, `ExecutionCompiler` | 새 planner graph가 아니라 `PolicyDecisionRecord` 계측 |
| EPIC-4 | `CandidateProvenance`, `CandidateEnvelope`, `EvidenceAccumulator` | `matchedTerms`, `filterTrace`, `DropLog`, `RrfFusionTrace` 추가 |
| EPIC-5 | `RankedResult.componentScores`, `retrievalProvenance`, `coarsePruneMeta` | normalized score decomposition + rerank safety invariant 추가 |
| EPIC-6 | entropy-only `AbstainPolicy` | typed abstain / structured clarify 실구현 |
| EPIC-7 | `AgentStep`, `actionPairs` | 새 IR 병렬도입이 아니라 `ToolOutcome` typing + postcondition |
| EPIC-8 | 기존 `engine_decision`, `meta`, `decision_snapshot`, fingerprint util/schema | runtime wiring + 세부 trace 증설 |

즉 RFC는 "모두 새로 만든다"가 아니라, **이미 있는 substrate를 단일 SSOT로 삼아 확장한다**는 원칙을 따라야 한다.
