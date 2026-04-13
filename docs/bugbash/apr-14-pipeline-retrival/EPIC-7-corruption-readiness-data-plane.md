# EPIC-7 Corruption / Readiness / Data Plane

## 문제 정의

runtime read path와 readiness/data-plane은 아직 malformed/corrupt/drift 상태를 `{}`, `[]`, sentinel, in-memory default, light probe success 같은 방식으로 위장하는 seam이 남아 있다. 이건 운영상 가장 위험한 종류의 조용한 실패다.

## 현재 코드 근거

- decision snapshot JSONB는 sentinel snapshot으로 대체된다: [jsonb-schemas.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/jsonb-schemas.ts:63>)
- evidence_items / relations / attributes는 empty fallback을 반환한다: [jsonb-schemas.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/jsonb-schemas.ts:98>), [jsonb-schemas.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/jsonb-schemas.ts:167>), [jsonb-schemas.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/jsonb-schemas.ts:213>)
- invalid `entity_type`는 `wine`으로 coercion 된다: [pg-entity-repository.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/pg-entity-repository.ts:88>)
- default threshold row가 없거나 invalid면 in-memory default로 내려간다: [pg-threshold-store.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/pg-threshold-store.ts:72>)
- Vespa read-model mapping이 malformed optional field를 empty/default value처럼 복원하면 schema corruption이 runtime 결과로 섞인다: [mapping.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/vespa/mapping.ts:75>), [mapping.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/vespa/mapping.ts:365>)
- dense retrieval / external dependency readiness가 `skipped`여도 green이면 required substrate 손실이 숨겨진다: [container-adapters.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/config/container-adapters.ts:141>), [readiness.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/config/readiness.ts:192>)
- non-prod readiness는 light probe path가 남아 있다: [readiness.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/config/readiness.ts:162>), [search-snapshot-readiness.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/health/search-snapshot-readiness.ts:564>), [search-snapshot-readiness.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/health/search-snapshot-readiness.ts:606>)

## 목표 불변식

1. corrupted JSONB는 empty normal value로 위장하지 않는다.
2. invalid row shape/type drift는 row-level loud failure로 surface 된다.
3. threshold / snapshot / readiness drift는 prod와 non-prod 모두 조기 검출한다.
4. 장기적으로 runtime substrate는 immutable snapshot plane + pointer promote 구조로 수렴한다.
5. required runtime dependency loss는 `skipped`나 light probe green으로 위장되지 않는다.
6. Vespa read-model corruption은 empty/default projection이 아니라 loud failure다.

## breaking changes

- JSONB parser는 tagged corruption result 또는 hard failure를 반환
- invalid entity row는 coercion 없이 reject
- prod threshold store는 no-default-row / invalid-shape에서 hard fail
- non-prod readiness도 strict hash/runtime snapshot 검증을 기본 사용
- Vespa optional field parser는 malformed payload를 empty/default 값으로 복원하지 않는다.
- required dependency readiness는 `skipped`가 아니라 `down` 또는 hard failure semantics를 쓴다.

## 구현 작업 목록

1. corrupted JSONB parser를 typed failure result로 올린다.
2. `pg-entity-repository` coercion 제거
3. `pg-threshold-store` fallback 제거
4. readiness strict mode를 환경별로 다르게 두지 않고 공통화
5. Vespa mapping/from-summary 복원 로직에서 malformed optional field를 loud failure로 올린다.
6. required dependency readiness는 `skipped-green`을 금지하고 strict dependency policy를 공통화한다.
7. 장기 후속으로 immutable snapshot plane 설계 문서를 추가한다.
8. public id immutability는 별도 `EPIC-8`로 분리해 authority contract로 다룬다.

## 테스트 / 게이트

- corrupted row loud failure
- missing default threshold row loud failure
- invalid entity_type loud failure
- non-prod strict readiness mismatch failure
- malformed Vespa optional field loud failure
- required dependency unavailable 시 readiness green 금지

## merge 조건

- runtime corrupted/drift 상태가 더 이상 empty/default/ok로 위장되지 않는다.
- runtime dependency 손실과 read-model corruption이 더 이상 readiness green이나 정상 projection으로 둔갑하지 않는다.
