# Bug bash - remaining action items only

`src/application/search` 관련 감사 문서를 현재 코드 기준으로 정리했다. 이미 해결된 parity/refactor/test 보강 항목은 제거했고, 아래에는 **아직 해결해야 하는 이슈만** 남겼다.

**최종 갱신**: 2026-04-06

---

## 범위

- `src/application/search/**/*.ts`
- `src/config/container-usecases.ts`
- 현재 워크스페이스 기준 재검증

---

## P0 - 보안/운영 wiring

### 1. Interpret / Resolve에 Layer 2 injection judge가 아직 컨테이너에서 안 꽂힘

- **현재 상태**:
  - [interpret.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/interpret.usecase.ts)는 `injectionJudge`를 받을 수 있고 `createSearchQuerySecurityGate`를 사용한다.
  - [resolve.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/resolve.usecase.ts)도 동일하다.
  - 하지만 [container-usecases.ts](/Users/songmin/wine-search-engine/src/config/container-usecases.ts)는 `InterpretUseCase`, `ResolveUseCase` 생성 시 `injectionJudge`를 넘기지 않는다.
- **남은 일**:
  - `InterpretUseCase` / `ResolveUseCase` DI를 메인 검색과 정렬할지 결정
  - 필요하면 `judgeFailureMode`까지 deps/interface에 같이 연결

### 2. `queryEntrySecurityObserver`가 여전히 기본 컨테이너에 연결되지 않음

- **현재 상태**:
  - [search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/search.usecase.ts), [hybrid.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid.usecase.ts)는 `queryEntrySecurityObserver`를 받을 수 있다.
  - 하지만 [container-usecases.ts](/Users/songmin/wine-search-engine/src/config/container-usecases.ts)는 어떤 use case에도 observer를 주입하지 않는다.
- **남은 일**:
  - 운영에서 security metrics / observer hook를 쓸 계획이면 컨테이너 wiring 추가
  - 안 쓸 거면 dead optional dependency인지 문서화하거나 정리

---

## P1 - 동작/재현성 parity

### 3. Replay snapshot source가 메인 검색 snapshot source와 아직 다름

- **현재 상태**:
  - [search-usecase-decision-snapshot.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-decision-snapshot.ts)는 `plan.policyRuleVersion`, `plan.thresholdProfileId`, `plan.plannerVersion`을 snapshot에 넣는다.
  - [replay.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/replay.usecase.ts)는 `buildCurrentSnapshot()`에서 `policy_rule_version`, `threshold_profile_id`, `planner_version`을 상수 문자열로 넣는다.
- **리스크**:
  - 저장 응답 snapshot과 replay 현재 snapshot이 서로 다른 source of truth를 써서 `SNAPSHOT_MISMATCH`가 과검출될 수 있다.
- **남은 일**:
  - replay도 plan 기반 snapshot source를 재사용하거나
  - replay 비교 규칙을 의도적으로 다르게 둘 거면 RFC/문서에 명시

### 4. Hybrid 전용 API의 비교 분해 적용 여부가 아직 미정

- **현재 상태**:
  - [hybrid.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/hybrid.usecase.ts)는 shared pre/post-route helper를 재사용한다.
  - 다만 메인 검색과 달리 `decomposedSearch`를 연결하지 않아 compare-style decomposition은 아직 타지 않는다.
- **남은 일**:
  - `/v1/hybrid`도 메인 검색과 같은 비교 분해를 지원할지 결정
  - 지원할 거면 wiring 추가
  - 의도적 차이면 OpenAPI/문서에 명확히 남기기

### 5. Decomposed 비교 검색이 서브쿼리에 부모 컨텍스트를 아직 전달하지 않음

- **현재 상태**:
  - [decomposed-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search.usecase.ts)는 서브 요청을 거의 `{ query, options }` 수준으로만 만든다.
  - 부모 `SearchRequest`의 `context`, `sessionContext`, `queryBudget`는 서브 검색으로 내려가지 않는다.
- **리스크**:
  - locale/session/budget에 민감한 planner/ranking/cache가 있으면 비교 응답 품질이 메인 검색과 어긋날 수 있다.
- **남은 일**:
  - 부모 컨텍스트를 서브쿼리에 전달하도록 API/구현 확장 검토

### 6. Resolve 경로는 아직 Constraint SAT 조기 종료 parity가 없음

- **현재 상태**:
  - 메인 검색은 pre-route에서 `ConstraintSAT`를 검사하고 모순이면 즉시 종료한다.
  - [resolve.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/resolve.usecase.ts)는 planner 후 바로 resolver로 간다.
- **남은 일**:
  - resolve API도 검색과 같은 모순 제약 fail-fast를 넣을지 결정
  - 의도적으로 다르게 둘 거면 계약 차이를 문서화

---

## P2 - 구현 정리

### 7. 비정상 분기 두 곳이 아직 `DomainError`가 아니라 plain `Error`

- **위치**:
  - [replay.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/replay.usecase.ts)
  - [decomposed-search.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/decomposed-search.usecase.ts)
- **남은 일**:
  - HTTP mapping / logging 일관성이 필요하면 domain-level error로 승격

### 8. `search-usecase-execute-builders.ts`의 `policy` 이중 캐스트가 아직 남아 있음

- **현재 상태**:
  - [search-usecase-execute-builders.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-execute-builders.ts)에서 `plan.policy as unknown as Readonly<Record<string, unknown>>`를 사용한다.
- **남은 일**:
  - decision trace input 타입을 정식화하거나 캐스트를 제거

### 9. Replay snapshot 비교의 `feature_flags`는 아직 shallow compare

- **현재 상태**:
  - [replay.usecase.ts](/Users/songmin/wine-search-engine/src/application/search/replay.usecase.ts)의 `recordsMatch()`는 얕은 키/값 비교다.
- **남은 일**:
  - `feature_flags`가 중첩 구조를 가질 가능성이 있으면 deep compare 또는 schema 제한 필요

---

## 제외한 항목

아래는 이번 문서에서 제거했다.

- Hybrid/Search ranked-route parity 관련 해결된 리팩터
- retrieval summary transport SSOT 관련 해결된 항목
- decision evidence semantics 보강 후 해소된 항목
- 최근 추가된 직접 회귀 테스트로 커버된 "테스트가 너무 얇다" 계열의 포괄적 지적
- 단순 참고/문서성 이슈만 있고 현재 액션 가치가 낮은 항목

---

## 권장 처리 순서

1. `container-usecases.ts` 보안 wiring 정리
2. replay snapshot source 정합성 해결
3. decomposed / hybrid compare parity 결정
4. resolve fail-fast 정책 정리
5. plain `Error` / cast / shallow-compare 같은 구현 디테일 정리
