# EPIC-5 Provenance / Admission / Decision Closure

## 문제 정의

decision layer는 이미 compiled provenance contract를 읽기 시작했지만, 아직 trace surface가 `policy / observed / missing` 중심으로 완전히 정렬되지는 않았다. 결과적으로 failure 이유를 request 하나로 재구성하는 데 여전히 보조 해석이 필요하다.

## 현재 코드 근거

- decision input은 provenance contract를 생성한다: [search-usecase-decision-input.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-decision-input.ts:209>), [search-usecase-decision-input.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-decision-input.ts:246>)
- admission gate는 policy를 provenance contract에서 직접 도출한다: [admission-gate.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/decision/service/admission-gate.ts:27>), [admission-gate.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/decision/service/admission-gate.ts:49>)
- decision engine evidence gate는 provenance contract를 읽고 downgrade 한다: [decision-engine.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/decision/service/decision-engine.ts:527>)
- post-route는 execution trace/admission closure를 response meta로 올린다: [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:1081>)

## 목표 불변식

1. 모든 gate는 compiled provenance contract 하나를 기준으로 판단한다.
2. trace는 `policy / observed / missing`과 `required / satisfied / allSatisfied`를 한 번에 보여준다.
3. constraint가 있는데 evidence가 없으면 언제나 loud downgrade이며 bypass seam이 없다.
4. response/meta/audit/debug는 같은 execution/provenance vocabulary를 쓴다.
5. retrieval / ranking / decision shortfall reason code는 하나의 taxonomy를 공유한다.

## breaking changes

- `DecisionInput`에 남은 legacy admission seam 제거
- evidence/admission/decision reason code vocabulary 정리
- debug surface에 `provenance_trace`를 stable block으로 추가
- `audit_extension`과 public response meta의 역할을 분리해 stable vs debug surface를 고정한다.

## 구현 작업 목록

1. `EvidenceGate`, `AdmissionGate`, `DecisionEngine`의 reason code를 공통 shortfall taxonomy로 통일한다.
2. response meta와 audit extension의 역할 경계를 재정의한다.
3. `execution_trace`와 `provenance_trace`를 explain/debug canonical block으로 표준화한다.
4. entity/hybrid/mixed가 같은 gate semantics를 타도록 stitched regression을 보강한다.
5. retrieval shortfall / ranking degradation / decision downgrade가 `provenance_shortfall:*`, `admission_gate_*`, `decision_gate_*` 식의 계층적 vocabulary를 공유하게 정리한다.

## 테스트 / 게이트

- provenance missing taxonomy snapshot
- entity/hybrid/mixed 공통 gate trace snapshot
- `constraints 있음 + evidence 없음` loud downgrade
- response schema에 `execution_trace / provenance_trace` surface 검증
- audit_extension이 stable public response contract를 다시 정의하지 않음

## merge 조건

- decision failure를 policy-observed-missing 기준으로 재현할 수 있다.
- route별 ad hoc gate semantics가 남아 있지 않다.
- retrieval/ranking/decision이 서로 다른 shortfall code space를 노출하지 않는다.
