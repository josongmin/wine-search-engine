# T-GE-03 Search Text And Region Normalization Parity

## 목표

retrieval text substrate와 structured region/country/appellation substrate가 서로 다른 normalization contract를 쓰는 상태를 닫는다.

## 현재 근거

- `cleanRegion()`은 raw bronze region path를 정리한다: [scripts/etl/vivino-to-silver.ts](../../../../scripts/etl/vivino-to-silver.ts#L753-L793)
- 하지만 `buildSearchText()`는 raw `row.region`과 `row.country`를 그대로 붙인다: [scripts/etl/vivino-to-silver.ts](../../../../scripts/etl/vivino-to-silver.ts#L867-L910)
- index 단계에서는 다시 `normalizeRegion()`으로 structured field를 보정한다: [scripts/etl/index-to-vespa.ts](../../../../scripts/etl/index-to-vespa.ts#L845-L855)
- 실제 dry-run sample에서도 duplicated location text가 보였다.

## 선행 티켓

- [T-GE-01](./T-GE-01-vivino-payload-appellation-and-silver-contract-closure.md)

## 정확한 산출물

1. `searchTextEn` region/country/appellation assembly contract
2. structured normalization과 text normalization parity 수정
3. 중복 location text regression test

## 구현 범위

1. `buildSearchText()`가 raw bronze path 대신 normalized structured substrate를 사용하게 한다.
2. country/region/appellation text 조합에서 duplication을 제거한다.
3. structured field와 text field가 서로 다른 geography truth를 보지 않게 한다.

## 수정 대상 파일

- [scripts/etl/vivino-to-silver.ts](../../../../scripts/etl/vivino-to-silver.ts)
- [scripts/etl/index-to-vespa.ts](../../../../scripts/etl/index-to-vespa.ts)
- 필요 시 [scripts/etl/region-normalizer.ts](../../../../scripts/etl/region-normalizer.ts)
- [test/unit/etl/vivino-to-silver.test.ts](../../../../test/unit/etl/vivino-to-silver.test.ts)
- [test/unit/etl/index-to-vespa.test.ts](../../../../test/unit/etl/index-to-vespa.test.ts)

## 수정 금지 범위

- semantic summary recipe 전면 개편
- alias generation 정책 변경
- retrieval ranking logic 변경

## 예상 충돌 파일

- [scripts/etl/index-to-vespa.ts](../../../../scripts/etl/index-to-vespa.ts#L859-L940)
- [scripts/etl/build-search-snapshot.ts](../../../../scripts/etl/build-search-snapshot.ts#L624-L650)

## 착수 전 확인

```bash
rg -n "buildSearchText|cleanRegion|normalizeRegion|searchTextEn|regionHierarchy|appellation" scripts/etl
pnpm exec tsx scripts/etl/index-to-vespa.ts --input data/silver-trackc.ndjson --dry-run --limit 1
```

## 구현 단계

1. geography truth source를 하나 정한다.
2. `buildSearchText()`가 raw path를 직접 읽는 경로를 제거한다.
3. index 단계의 geography fallback과 text assembly가 같은 normalized source를 쓰게 한다.
4. duplicated location sample을 regression으로 고정한다.

## 작업 중단 조건

1. geography normalization을 silver 단계로 끌어올리려면 broader schema migration이 필요함
2. search text recipe 변경이 doc2query cache/fingerprint와 얽혀 별도 티켓이 필요함

## 롤백 기준

- structured fields만 고치고 `searchTextEn`는 raw duplication을 그대로 유지
- index stage에서만 보정하고 silver substrate는 여전히 오염된 상태

## 금지사항

- duplicated geography text를 post-hoc regex strip으로만 숨기지 말 것
- structured truth와 text truth가 다른 상태를 intentional이라고 포장하지 말 것

## 수용 예시

- 수용:
  - 동일 샘플에서 structured geography와 search text geography가 같은 truth를 반영한다
- 비수용:
  - structured field는 normalized인데 `searchTextEn`는 여전히 raw duplicated path를 가진다

## 테스트

- duplicated geography regression test
- dry-run sample parity test

## 검증 명령

```bash
pnpm vitest run test/unit/etl/vivino-to-silver.test.ts test/unit/etl/index-to-vespa.test.ts
pnpm exec tsx scripts/etl/index-to-vespa.ts --input data/silver-trackc.ndjson --dry-run --limit 1
```

## 머지 전 체크리스트

- [ ] `searchTextEn` geography duplication regression 추가
- [ ] structured/text geography truth가 동일
- [ ] raw bronze path direct assembly 제거 또는 명시적 SSOT화

## DoD

1. retrieval text substrate가 structured geography substrate와 같은 normalization contract를 쓴다.
2. duplicated location text가 regression으로 재발하지 않는다.
3. silver와 index 단계가 서로 다른 geography truth를 쓰지 않는다.

## 완료 조건

- `searchTextEn`와 structured geography fields가 같은 source-of-truth를 공유한다.
