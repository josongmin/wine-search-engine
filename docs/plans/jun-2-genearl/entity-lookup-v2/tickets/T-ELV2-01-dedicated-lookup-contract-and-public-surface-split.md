# T-ELV2-01 Dedicated Lookup Contract And Public Surface Split

> Historical / audit-only ticket.
> Current public lookup truth moved to `docs/bench/STATUS.md` and
> `tools/feature-catalog/features/retrieval/entity-lookup-v2.yaml`.
> `/v1/lookup/wine` references below describe the migration target at that time,
> not the current route contract.

## 목표

`/v1/lookup/wine`의 primitive-search coupling을 끊고, lookup 전용 public contract `/v2/entity-lookup`를 추가한다.

## 현재 근거

- 현재 lookup는 primitive search body/response family에 묶여 있다.
- exact entity resolution task에 비해 contract가 search-oriented다.

## 정확한 산출물

1. `POST /v2/entity-lookup`
2. dedicated request schema
3. dedicated response schema
4. V1 shadow adapter or deprecation path

## 반드시 건드릴 파일

1. `src/interface/http/routes/primitive-search.route.ts`
2. `src/interface/http/routes/route-contracts.ts`
3. `src/interface/http/schemas/*.ts`
4. `src/application/search/*.ts`

## 구현 범위

1. V2 request/response contract
2. dedicated use-case entry DTO
3. V1 compatibility/deprecation adapter

## 금지사항

1. V2 body가 primitive search request를 재사용하는 것
2. V2 response가 search result list를 흉내 내는 것

## DoD

1. lookup가 search contract에서 분리된다.
2. V2 contract가 entity resolution task에 맞는 최소/명시적 shape를 가진다.
