# PATCH SUMMARY (RFC-016 — 복붙용)

## Add

- **RFC-016:** Deterministic Admission Gate & Failure Semantics (`docs/RFC-016.md`)

## Patch

- **RFC-000:** Admission Gate를 Decision Layer 내부 최종 closure로 명시; §8.7 closed-world invariant; §14.5·부록과 RFC-016 연결
- **RFC-001:** EntityRef sealing (runtime contract)
- **RFC-005:** `QueryPlanV1.admission_context`
- **RFC-006:** exact resolve proposal은 `EntityRef`로 승격 가능해야 하며, 실패 시 downgrade
- **RFC-007:** `DecisionOutput`에 `failure_reason` + `admission_trace_ref`; §4.2 Admission Gate, §6.5 post-gate closure
- **RFC-008:** `EngineDecision`에 `failure_reason` + `admission_trace_ref`, §2.5 failure transparency
- **RFC-009:** §4.7 AdmissionViolation metrics; §13 release gate (AdmissionViolation = 0 등)
- **RFC-014:** 외부 계약에 `failure_reason` / `admission_trace_ref`; replay snapshot 불일치 시 HTTP error contract, `reason` = `SNAPSHOT_MISMATCH`, silent fallback 금지
- **RFC-010–013, RFC-015:** 교차 참조 링크
- **RFC-INDEX:** 파이프라인에 Admission Gate 추가, Canonical Name Registry에 `failure_reason`·`admission_trace_ref`·`EntityRef`·`admission_context` 등록, 점검 빈틈에 admission 위반 패턴 추가

## Core invariant

`resolved`는 아래를 **모두** 만족할 때만 허용된다.

1. Calibrated decision gate 통과  
2. Policy / ambiguity gate 통과  
3. Identity seal 통과 (RFC-016)  
4. Snapshot consistency 통과 (RFC-016)  
5. Evidence sufficiency 통과 (RFC-016)  

그 외는 `ambiguous` 또는 `failed`로 downgrade한다.
