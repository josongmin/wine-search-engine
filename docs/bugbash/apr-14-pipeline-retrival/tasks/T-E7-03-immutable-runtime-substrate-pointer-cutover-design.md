# T-E7-03 Immutable Runtime Substrate Pointer Cutover Design

## 목표

runtime substrate를 immutable snapshot plane + pointer cutover 구조로 재설계하는 후속 설계를 고정한다.

## 현재 근거

- publish는 staged promote를 하지만 substrate plane 자체는 완전 immutable로 봉인돼 있지 않다: [publish-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-search-snapshot.ts:470>)
- readiness는 current runtime state 파일과 live DB를 비교한다: [search-snapshot-readiness.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/health/search-snapshot-readiness.ts:564>)

## 선행 티켓

- [T-E7-02 threshold-store-and-readiness-strict-fail-closed](./T-E7-02-threshold-store-and-readiness-strict-fail-closed.md) 권장

## 정확한 산출물

1. immutable substrate + pointer cutover 설계 문서
2. current runtime substrate와 target model 비교표
3. migration phase plan

## 구현 범위

1. immutable runtime substrate model ADR 또는 bugbash design doc 작성
2. pointer promote / rollback / garbage collection / stale delete 책임 분리
3. runtime state exactness와 public id exactness를 함께 검증하는 cutover contract 정의

## 수정 대상 파일

- 신규 설계 문서 1개 이상
- 필요 시 링크 업데이트:
  - [EPIC-7-corruption-readiness-data-plane.md](../EPIC-7-corruption-readiness-data-plane.md)
  - [EPIC-8-identity-public-id-immutability.md](../EPIC-8-identity-public-id-immutability.md)

## 수정 금지 범위

- 실제 cutover 구현
- ETL pipeline 코드 대량 수정
- public id authority model 구현

## 예상 충돌 파일

- [publish-runtime-substrates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-runtime-substrates.ts:1>)
- [publish-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-search-snapshot.ts:470>)
- [EPIC-7-corruption-readiness-data-plane.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-7-corruption-readiness-data-plane.md:1>)

## 착수 전 확인

- 현재 publish path 다이어그램을 먼저 그린다.
- runtime state file, DB substrates, Vespa delete/publish order를 표로 적는다.

## 구현 단계

1. 현행 publish/cutover 흐름을 다이어그램으로 고정한다.
2. immutable plane / pointer / rollback / GC 책임을 분리한다.
3. migration 단계와 backwards-compat boundary를 문서로 확정한다.

## 작업 중단 조건

1. 문서 티켓인데 실제 구현이 섞이기 시작함
2. current substrate inventory를 코드 근거로 확정할 수 없음

## 롤백 기준

- pointer promote 없는 "좋으면 promote" 수준의 서술형 문서로 남는 경우
- failure mode/rollback path가 없는 설계 문서가 되는 경우

## 금지사항

- 구현 없이 vague roadmap만 남기지 말 것
- pointer cutover와 public-id authority를 한 문단으로 뭉개지 말 것

## 수용 예시

- 수용:
  - "immutable plane", "active pointer", "rollback pointer", "GC owner"가 분리된 설계
- 비수용:
  - "snapshot을 잘 관리한다" 수준의 모호한 문서

## 테스트

- 문서 티켓이다. 구현 전 acceptance spec과 migration plan이 필요하다.

## 검증 명령

- 문서 티켓이므로 별도 코드 테스트는 없음
- 단, 기존 EPIC 문서 링크와 상호 참조가 모두 살아 있어야 함

## 머지 전 체크리스트

- [ ] cutover 단계가 순서도/표로 존재
- [ ] rollback 책임자와 garbage collection 책임이 분리됨
- [ ] public-id authority와의 경계가 명시됨

## 완료 조건

- 다음 구현자가 cutover storage redesign을 결정 없이 바로 착수할 수 있다.
