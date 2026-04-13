# T-E1-02 Skip-Index Seam And ETL Data-Plane Omit Contract

## 목표

`--skip-index`/substrate-only promote seam을 verify-only 수준으로 축소하고, authoritative writer/provenance 없는 data-plane 필드를 fabricated 값 대신 omit contract로 고정한다.

## 현재 근거

- ETL epic은 `--skip-index` seam 축소와 data-plane field omit contract를 요구한다: [EPIC-1-etl-publish-fail-closed.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-1-etl-publish-fail-closed.md:50>)
- `vespa-feed.ndjson` exact artifact 저장은 이미 구현됐지만, seam 축소와 unsupported field contract를 묶은 티켓은 없다.

## 선행 티켓

- [T-E1-01 etl-stage-ssot-and-partial-success-hard-gates](./T-E1-01-etl-stage-ssot-and-partial-success-hard-gates.md) 권장

## 정확한 산출물

1. `--skip-index`/substrate-only promote seam policy 정리 및 코드 반영
2. unsupported data-plane field omit contract
3. exact artifact replay path 테스트

## 구현 범위

1. `--skip-index`는 verify-only seam이 아니면 금지한다.
2. substrate-only promote seam이 남으면 explicit 이름과 scope를 갖는 verify path로만 격리한다.
3. occasion / soilType / producerType / sensory 등 authoritative writer가 없는 필드는 fabricated 값 대신 omit 한다.

## 수정 대상 파일

- [publish-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-search-snapshot.ts:431>)
- [build-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/build-search-snapshot.ts:175>)
- 관련 ETL field writers/mappers

## 수정 금지 범위

- retrieval runtime contract 변경
- client response schema 변경
- public id authority 설계

## 예상 충돌 파일

- [publish-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/publish-search-snapshot.ts:431>)
- [types.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/types.ts:1>)
- [index-to-vespa.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/index-to-vespa.ts:1>)

## 착수 전 확인

```bash
rg -n "skip-index|substrate|soilType|producerType|occasion|sensory" scripts/etl
```

## 구현 단계

1. skip-index/substrate-only seams를 먼저 전수 조사한다.
2. verify-only로 남길 seam과 제거할 seam을 구분한다.
3. unsupported field writer를 찾아 fabricated 값 대신 omit contract로 바꾼다.
4. exact artifact replay path가 변하지 않았는지 테스트로 고정한다.

## 작업 중단 조건

1. unsupported field가 실제 writer를 이미 갖고 있는데 문서만 stale함
2. skip-index seam을 축소하려면 deploy/publish 운영 절차 변경이 선행돼야 함

## 롤백 기준

- unsupported field에 placeholder/default 값이 남는 경우
- skip-index가 여전히 실질 promote path로 남는 경우

## 금지사항

- unsupported field를 `unknown` 문자열이나 midpoint 값으로 채우지 말 것
- verify-only seam을 normal publish path처럼 보이게 두지 말 것

## 수용 예시

- 수용:
  - `soilType` writer 없음 -> field omitted
- 비수용:
  - `soilType` writer 없음 -> empty array나 `"unknown"` 저장

## 테스트

- skip-index verify-only gate test
- unsupported field omit contract tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts <etl-target-tests>
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] skip-index가 normal promote seam이 아님
- [ ] unsupported field fabricated 값 제거
- [ ] exact artifact replay contract 유지

## 완료 조건

- ETL/publish는 unsupported data-plane field를 fabricated 값으로 승격하지 않는다.
