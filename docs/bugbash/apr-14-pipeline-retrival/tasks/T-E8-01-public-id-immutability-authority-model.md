# T-E8-01 Public ID Immutability Authority Model

## 목표

runtime public id authority를 benchmark/gold linkage와 분리한 immutable model로 봉인한다.

## 현재 근거

- snapshot identity fallback은 identity signature 기반 public id를 만든다: [snapshot-entity-identity.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/snapshot-entity-identity.ts:149>)
- canonical graph sync는 remap/conflict를 구조적으로 강하게 다루지 못한다: [canonical-entity-graph-sync.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/canonical-entity-graph-sync.ts:248>)

## 선행 티켓

- [T-E7-03 immutable-runtime-substrate-pointer-cutover-design](./T-E7-03-immutable-runtime-substrate-pointer-cutover-design.md) 권장

## 정확한 산출물

1. public id authority model 설계 문서
2. 현재 id 생성 경로와 target authority 경로 비교표
3. backward compatibility 규칙

## 구현 범위

1. runtime public id authority 규칙을 문서화한다.
2. gold fixture id와 runtime public id linkage를 별도 책임으로 분리한다.
3. remap conflict 검증 지점과 publish hard gate를 설계한다.

## 수정 대상 파일

- 신규 설계 문서 1개 이상
- 링크 대상:
  - [EPIC-8-identity-public-id-immutability.md](../EPIC-8-identity-public-id-immutability.md)
  - [snapshot-entity-identity.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/snapshot-entity-identity.ts:149>)
  - [canonical-entity-graph-sync.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/canonical-entity-graph-sync.ts:248>)

## 수정 금지 범위

- actual public id migration script 구현
- snapshot graph sync runtime code 수정
- client-facing id rename

## 예상 충돌 파일

- [snapshot-entity-identity.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/snapshot-entity-identity.ts:154>)
- [canonical-entity-graph-sync.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/canonical-entity-graph-sync.ts:140>)
- [EPIC-8-public-id-authority.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-8-public-id-authority.md:1>)

## 착수 전 확인

- current public-id derivation inputs를 표로 먼저 정리한다.
- benchmark fixture id와 runtime public id가 섞이는 지점을 예제로 적는다.

## 구현 단계

1. current public-id creation flow를 표로 요약한다.
2. runtime authority id와 benchmark/gold linkage id를 분리한 모델을 정의한다.
3. conflict cases와 migration workflow를 예제로 고정한다.

## 작업 중단 조건

1. id authority를 설계하려면 substrate pointer 설계가 먼저 필요함
2. current id generation inventory를 코드 근거로 확정할 수 없음

## 롤백 기준

- "나중에 결정" 수준의 추상 문서로 남는 경우
- immutable rule 없이 단순 remap 절차만 적는 경우

## 금지사항

- "나중에 생각" 수준의 추상 문서 금지
- benchmark id를 runtime public id로 재사용하는 설계 금지

## 수용 예시

- 수용:
  - 동일 identity signature는 fixture overlay와 무관하게 같은 runtime public id 유지
- 비수용:
  - gold fixture가 바뀌면 runtime public id도 바뀜

## 테스트

- 설계 티켓이지만, 최소 acceptance examples를 포함해야 한다.
  - same identity, same public id
  - gold overlay on/off invariant
  - remap conflict hard fail

## 검증 명령

- 문서 티켓이므로 코드 테스트 없음
- acceptance examples 3개 이상 필수

## 머지 전 체크리스트

- [ ] authority id와 linkage id가 분리됨
- [ ] remap conflict 예시가 있음
- [ ] publish hard gate 지점이 명시됨

## 완료 조건

- public id immutability contract가 구현 전제로 확정된다.
