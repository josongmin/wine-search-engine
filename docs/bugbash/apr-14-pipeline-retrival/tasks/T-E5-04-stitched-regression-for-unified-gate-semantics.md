# T-E5-04 Stitched Regression For Unified Gate Semantics

## 목표

entity/hybrid/mixed가 같은 admission/evidence/decision gate semantics를 타는지 stitched regression으로 고정한다.

## 현재 근거

- EPIC-5는 route별 ad hoc gate semantics 제거와 stitched regression 보강을 요구한다: [EPIC-5-provenance-admission-decision-closure.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-5-provenance-admission-decision-closure.md:32>)
- 현재 tasks는 trace/schema/taxonomy는 있지만 route-cross stitched regression 전용 티켓은 없다.

## 선행 티켓

- [T-E5-01 stable-provenance-trace-domain-contract](./T-E5-01-stable-provenance-trace-domain-contract.md)
- [T-E5-02 unified-provenance-shortfall-taxonomy](./T-E5-02-unified-provenance-shortfall-taxonomy.md)

## 정확한 산출물

1. entity/hybrid/mixed stitched regression tests
2. 동일 gate semantics를 보장하는 assertion matrix
3. route-specific exception inventory

## 구현 범위

1. 동일 입력 obligation에 대해 route별 gate 결과를 비교하는 regression을 만든다.
2. route-specific 예외가 있으면 explicit inventory로 남긴다.
3. ad hoc gate semantics가 있으면 제거하거나 test에서 fail하게 만든다.

## 수정 대상 파일

- decision/search usecase integration tests
- [search-usecase-post-route-phase.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/unit/application/search/search-usecase-post-route-phase.test.ts:991>)
- entity/hybrid/mixed execution tests

## 수정 금지 범위

- core gate policy 재설계
- route algorithm 변경
- response wire contract 변경

## 예상 충돌 파일

- post-route tests
- decision engine tests
- mixed/entity/hybrid route tests

## 착수 전 확인

```bash
rg -n "entity|hybrid|mixed|EvidenceGate|AdmissionGate|DecisionEngine" test src/application/search src/domain/decision
```

## 구현 단계

1. route별 동일 obligation 케이스를 선정한다.
2. assertion matrix를 먼저 정의한다.
3. stitched regression 테스트를 추가한다.
4. 예외가 있으면 explicit inventory로 기록한다.

## 작업 중단 조건

1. route별 semantics 차이가 실제 제품 요구인지 버그인지 구분이 안 됨
2. 공통 taxonomy가 아직 안정화되지 않아 테스트가 계속 흔들림

## 롤백 기준

- route별 테스트를 따로 두고 동일 semantics 비교가 없는 경우
- exception이 implicit behavior로 남는 경우

## 금지사항

- route별 ad hoc expected 값을 그대로 고정해 차이를 정당화하지 말 것
- stitched regression 없이 단일 route 테스트만 추가하지 말 것

## 수용 예시

- 수용:
  - 같은 constraint evidence shortfall이면 entity/hybrid/mixed 모두 같은 gate reason code
- 비수용:
  - route마다 다른 reason code space

## 테스트

- entity/hybrid/mixed stitched regression
- route-specific exception inventory snapshot

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts <decision-and-route-target-tests>
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] stitched regression 존재
- [ ] route-specific exception inventory 존재
- [ ] ad hoc gate semantics 제거 또는 문서화 완료

## 완료 조건

- route별 gate semantics 차이가 silent behavior drift로 남지 않는다.
