# EPIC-8 Identity / Public ID Immutability

## 문제 정의

현재 snapshot/canonical graph/gold overlay 축에는 "동일 identity가 언제나 동일 public id를 가진다"는 authority contract가 완전히 봉인돼 있지 않다. 이 상태에서는 publish/rollback exactness를 올려도 public id drift가 남고, benchmark linkage나 gold overlay가 runtime authority를 덮어쓰는 구조적 충돌이 생긴다.

## 현재 코드 근거

- snapshot identity fallback은 identity signature 기반 public id를 만든다: [snapshot-entity-identity.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/snapshot-entity-identity.ts:149>), [snapshot-entity-identity.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/snapshot-entity-identity.ts:176>)
- canonical graph는 `identity_signature` unique 제약을 가진다: [009_canonical_entity_graph.sql](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/sql/009_canonical_entity_graph.sql:25>)
- sync는 `canonical_entity_id` 기준 upsert가 중심이라 identity-signature-level remap을 구조적으로 잘 다루지 못한다: [canonical-entity-graph-sync.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/canonical-entity-graph-sync.ts:248>)
- snapshot publish/rollback은 artifact exactness를 올려도 "어떤 public id가 authority인가"는 별도 contract가 필요하다: [publish-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-search-snapshot.ts:220>)

## 목표 불변식

1. 동일 identity signature는 snapshot/gold overlay 여부와 무관하게 동일 public id를 가진다.
2. runtime public id와 benchmark/gold fixture linkage는 다른 책임을 가진다.
3. canonical graph sync는 remap/conflict를 silent upsert로 삼키지 않는다.
4. publish/rollback은 document exactness뿐 아니라 public id exactness도 유지한다.

## breaking changes

- gold overlay는 runtime public id를 바꾸지 않고 linkage/metadata만 제공한다.
- canonical graph sync는 identity signature 충돌 시 hard fail 또는 explicit migration을 요구한다.
- snapshot build는 public id authority와 benchmark linkage를 분리해 저장한다.

## 구현 작업 목록

1. runtime public id를 immutable identity authority 규칙으로 재정의하고, gold fixture id는 별도 linkage 필드로 내린다.
2. snapshot build / canonical graph sync / publish verification이 동일 public-id authority 규칙을 읽도록 SSOT를 만든다.
3. 동일 identity signature에 서로 다른 public id가 생기면 publish 전 hard fail하는 검증을 추가한다.
4. explicit remap이 필요한 경우 migration-safe workflow와 audit surface를 정의한다.
5. runtime/public contract 문서에서 "public id는 benchmark fixture와 독립"이라는 원칙을 명시한다.

## 테스트 / 게이트

- gold overlay on/off가 runtime public id를 바꾸지 않음
- 동일 identity signature에 서로 다른 public id 시 hard fail
- rollback/publish 후 public id set이 exact restore됨
- canonical graph sync remap conflict audit record 생성

## merge 조건

- 이후 snapshot/gold overlay가 runtime public id authority를 재배정하지 않는다.
- canonical graph와 publish path에서 identity drift가 silent success로 남지 않는다.
