# EPIC-1 ETL / Publish Fail-Closed

## 문제 정의

현재 ETL/publish/backfill 파이프라인은 일부 검증 불가 상태를 warning 또는 partial success로 남기고 artifact를 계속 전진시킬 수 있다. 여기에 더해 artifact handoff graph와 rollback/publish exactness가 느슨하면, "성공"이 실제 최신 corpus 승격이나 exact restore를 뜻하지 않게 된다. 이건 ingestion 쪽의 `fail-closed`, `artifact-exact`, `no-partial-publish` 원칙 위반이다.

## 현재 코드 근거

- silver coverage gate는 기본 blocker이지만 partial opt-in path가 있다: [validate-silver.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/validate-silver.ts:30>), [validate-silver.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/validate-silver.ts:149>)
- ETL 단계 기본 입력/출력과 handoff artifact가 stage별로 흩어지면 stale 산출물을 다음 단계가 재사용할 수 있다: [index-to-vespa.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/index-to-vespa.ts:37>)
- `run-track-c`는 coverage가 일부만 차도 전체 green으로 끝날 수 있다: [run-track-c.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/run-track-c.ts:123>)
- doc query 생성은 실패 레코드를 원본 유지로 남긴 채 최종 artifact를 쓸 수 있다: [generate-doc-queries.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/generate-doc-queries.ts:263>), [generate-doc-queries.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/generate-doc-queries.ts:452>)
- runtime gold coverage verify는 publish 막판에 수행된다: [publish-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-search-snapshot.ts:493>)
- fixture repo root를 못 찾는 상태가 publish 성공으로 흘렀던 RCA가 있었다. 이 축은 fixture repo가 없으면 검증 자체를 못 한다는 점이 핵심이다: [publish-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-search-snapshot.ts:505>)
- `--skip-index`가 runtime substrate 승격까지 허용하면 cutover hole이 생긴다: [publish-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-search-snapshot.ts:401>), [publish-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-search-snapshot.ts:418>)
- rollback이 raw silver 재인덱싱이면 exact restore가 아니다: [publish-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-search-snapshot.ts:220>), [publish-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-search-snapshot.ts:234>)
- exact replay artifact를 snapshot에 같이 저장해야 rollback/reindex가 코드 의미 변화와 분리된다: [build-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/build-search-snapshot.ts:135>)
- standalone substrate publish도 staged promote가 아니면 partial runtime cutover를 만든다: [publish-runtime-substrates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-runtime-substrates.ts:393>), [publish-runtime-substrates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-runtime-substrates.ts:418>)
- drinking-window backfill은 feature 부족 record를 실패 카운트만 올리고 output에 남긴다: [drinking-window-backfill.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/drinking-window-backfill.ts:186>), [drinking-window-backfill.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/drinking-window-backfill.ts:196>)
- Korean alias generator는 output shape/collision normalization drift가 있으면 batch 전체가 partial-success처럼 흘러갈 수 있다: [generate-korean-aliases.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/generate-korean-aliases.ts:61>), [generate-korean-aliases.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/generate-korean-aliases.ts:164>)

## 목표 불변식

1. 기본 CLI 경로는 "coverage 부족"을 warning이 아니라 blocker로 취급한다.
2. publish는 runtime gold coverage를 검증할 수 없으면 절대 성공하지 않는다.
3. backfill은 partial-success artifact를 쓰지 않는다.
4. heuristic stub은 explicit opt-in 없이는 실행되지 않는다.
5. artifact handoff graph는 하나의 SSOT를 가지며, stale stage artifact를 다음 단계가 소비하지 않는다.
6. rollback/reindex는 exact promoted feed artifact만 재생한다.
7. substrate/runtime cutover는 document plane 없이 단독 승격되지 않는다.
8. authoritative writer/provenance가 없는 attribute plane은 empty/fabricated write로 승격하지 않는다.

## breaking changes

- `validate-silver` 기본 실행은 partial coverage를 허용하지 않는다.
- `publish-search-snapshot`은 fixture repo 부재/불능을 hard failure로 간주한다.
- `drinking-window-backfill`은 실패 record가 1건이라도 있으면 non-zero exit와 no-write가 기본이다.
- stage 간 기본 artifact graph는 SSOT 모듈 기준으로만 이동한다.
- `publish-search-snapshot --skip-index`는 verify-only 또는 hard fail이며 runtime publish를 동반하지 않는다.
- rollback은 raw silver 재처리가 아니라 exact prepared feed replay로 고정된다.
- unsupported data-plane field는 empty array/default scalar write가 아니라 omit가 기본이다.

## 구현 작업 목록

1. `validateSilverRecords()`의 gate 결과를 배포용 기본 경로에서 전부 blocker로 승격한다.
2. `publish-search-snapshot` 시작부에서 fixture repo availability를 publish precondition으로 올리고, missing이면 즉시 중단한다.
3. `drinking-window-backfill`은 `assertDrinkingWindowBackfillComplete()`를 write 이전 hard gate로 유지하고, partial artifact 생성 경로를 없앤다.
4. publish/backfill CLI 문구도 "warning"이 아니라 "refused" semantics로 정리한다.
5. ETL artifact graph를 stage SSOT로 통일하고, `etl:full`이 stale intermediate file을 재소비하지 않게 한다.
6. Track C, Doc2Query, alias generation의 partial-success path를 전부 hard gate로 올린다.
7. snapshot build 시 exact `vespa-feed.ndjson`를 artifact로 저장하고, rollback/reindex는 이 artifact만 재생하게 고정한다.
8. `--skip-index` 및 substrate-only promote seam을 금지하거나 verify-only 모드로 축소한다.
9. occasion / soilType / producerType / sensory 등 data-plane 필드는 authoritative writer/provenance 없으면 omit contract로 정리한다.

## 테스트 / 게이트

- alcoholPct / producerPrestige / criticProxy / drinkingWindow coverage 각각 shortfall 시 기본 실패
- stale intermediate artifact 존재 상태에서도 `etl:full`이 최신 output만 승격
- Track C / Doc2Query / alias batch partial failure 시 non-zero + no-promote
- fixture repo root 미존재 상태에서 publish 실패
- `--skip-index` 경로에서 runtime substrate publish 차단
- exact feed artifact 없는 이전 snapshot rollback/publish 차단
- backfill 실패 record 존재 시 output file 미작성 + non-zero
- heuristic opt-in env 없을 때 backfill 실패
- unsupported field가 empty/default write가 아니라 omit로 유지됨

## merge 조건

- ETL artifact가 더 이상 "검증 불가" 상태에서 success exit하지 않는다.
- publish 경로에 advisory-only validation이 남아 있지 않다.
- build/publish/rollback이 동일 exact artifact contract를 사용한다.
- data-plane이 없는 attribute를 fabricated 값으로 승격하는 ETL seam이 남아 있지 않다.
