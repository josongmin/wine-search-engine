# T-E4-03 Entity Route Native Ranked Projection

## 목표

entity route synthetic ranked result를 generic compatibility shim이 아니라 route-native projection contract로 승격한다.

## 현재 근거

- entity route bug의 출발점은 synthetic ranked result가 constraint evidence를 비워 두던 구조였다: [search-usecase-route-dispatch.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-route-dispatch.ts:69>)
- 현재 result item mapping은 공통 mapper를 탄다: [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:214>)

## 선행 티켓

- [T-E4-01 entity-route-batch-hydration-hard-requirement](./T-E4-01-entity-route-batch-hydration-hard-requirement.md)
- [T-E4-02 resolver-per-candidate-structured-trace](./T-E4-02-resolver-per-candidate-structured-trace.md) 권장

## 정확한 산출물

1. entity route 전용 ranked projection 또는 mapper
2. identity/constraint/match provenance 보존 코드
3. entity route projection snapshot 테스트

## 구현 범위

1. entity route 전용 ranked projection mapper를 도입한다.
2. identity evidence, matched/unmet constraints, alias match provenance를 route-native 필드로 정의한다.
3. generic ranked result mapper와의 경계를 정리한다.

## 수정 대상 파일

- [search-usecase-entity-ranked-results.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-entity-ranked-results.ts:1>)
- [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:214>)
- [search-usecase-route-dispatch.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-route-dispatch.ts:23>)
- 테스트: [search-usecase-entity-ranked-results.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/__tests__/search-usecase-entity-ranked-results.test.ts:1>), [search-usecase-map-result-items.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/unit/application/search/search-usecase-map-result-items.test.ts:73>)

## 수정 금지 범위

- hybrid ranked result model 전면 재설계
- response result item wire shape 변경
- resolver decision logic 변경

## 예상 충돌 파일

- [search-usecase-entity-ranked-results.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-entity-ranked-results.ts:1>)
- [search-usecase-route-dispatch.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-route-dispatch.ts:69>)
- [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:214>)

## 착수 전 확인

```bash
rg -n "matchedConstraints|unmetConstraints|matchType|identityEvidence" \
  src/application/search/search-usecase-entity-ranked-results.ts \
  src/application/search/search-usecase-map-result-items.ts
```

## 구현 단계

1. entity route ranked projection의 canonical field list를 먼저 문서화한다.
2. entity-native projection mapper를 추가한다.
3. generic map-result-items는 route-type discriminant를 읽고 entity-native data를 우선 사용하게 바꾼다.
4. matched/unmet constraints와 alias provenance가 결과 아이템까지 유지되는지 회귀를 추가한다.

## 작업 중단 조건

1. response item 공통 contract를 먼저 깨야만 projection 분리가 가능함
2. E6 score projection 티켓과 범위가 뒤엉켜 한 티켓으로 닫기 어려움

## 롤백 기준

- generic mapper에 ad hoc 분기를 더 쌓는 방향으로 후퇴하는 경우
- constraint evidence나 match provenance가 projection에서 유실되는 경우

## 금지사항

- entity route용 필드를 generic hybrid projection에 억지로 끼워 넣지 말 것
- alias provenance를 문자열 한 줄로 축약하지 말 것

## 수용 예시

- 수용:
  - entity route에서 `alias_exact`와 `alias_fuzzy`가 구분됨
- 비수용:
  - entity route도 전부 `hybrid` matchType처럼 보임

## 테스트

- entity route projection snapshot
- entity route + hard constraint evidence pass
- alias_exact / alias_fuzzy / exact matchType projection tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts \
  src/application/search/__tests__/search-usecase-entity-ranked-results.test.ts \
  test/unit/application/search/search-usecase-map-result-items.test.ts \
  test/unit/application/search/search-usecase-post-route-phase.test.ts
```

## 머지 전 체크리스트

- [ ] entity route 결과가 route-native projection을 가짐
- [ ] hard constraint evidence가 결과 item까지 유지됨
- [ ] alias provenance가 exact/fuzzy 구분됨

## 완료 조건

- entity route가 generic shim에 기대지 않고도 stable ranked/result contract를 만든다.
