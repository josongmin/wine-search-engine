# T-E1-01 ETL Stage SSOT And Partial-Success Hard Gates

## 목표

ETL/publish 파이프라인에서 stage SSOT를 고정하고, Track C / Doc2Query / alias generation의 partial-success path를 hard gate로 올린다.

## 현재 근거

- ETL epic은 stale intermediate 재소비 금지와 partial-success hard gate를 요구한다: [EPIC-1-etl-publish-fail-closed.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-1-etl-publish-fail-closed.md:43>)
- `validate-silver`, fixture repo, drinking-window partial write는 이미 많이 닫혔지만 stage graph SSOT와 downstream partial-success closure는 별도 티켓이 없다.

## 선행 티켓

- 없음. 독립 착수 가능

## 정확한 산출물

1. ETL stage artifact graph를 단일 SSOT로 고정하는 코드 또는 문서화된 contract
2. Track C / Doc2Query / alias generation partial-success hard gate 코드
3. stale intermediate 재소비 금지 테스트

## 구현 범위

1. `etl:full`과 관련 stage runner가 stale intermediate를 정상 입력으로 재사용하지 못하게 한다.
2. Track C, Doc2Query, alias generation에서 partial-success를 success exit로 숨기는 경로를 막는다.
3. CLI/exit semantics를 `warning`이 아니라 `refused` 기준으로 통일한다.

## 수정 대상 파일

- ETL orchestration scripts under [scripts/etl](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl>)
- Track C / Doc2Query / alias generation 관련 gates
- ETL pipeline tests

## 수정 금지 범위

- snapshot publish substrate redesign
- public id authority 설계
- data-plane field schema 자체 확장

## 예상 충돌 파일

- [validate-silver.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/validate-silver.ts:36>)
- [build-search-snapshot.ts](</Users/songmin/Documents/code-wine/wine-search-engine/scripts/etl/build-search-snapshot.ts:175>)
- ETL full pipeline entry scripts

## 착수 전 확인

```bash
rg -n "warning|partial|allow-partial|success exit|stale|alias|doc2query|track" scripts/etl
```

## 구현 단계

1. current ETL stage graph를 표로 먼저 정리한다.
2. stage별 success/failure 기준을 코드에서 찾아 문서와 대조한다.
3. partial-success path를 success exit 대신 hard fail로 바꾼다.
4. stale intermediate를 재소비하는 seam이 있으면 artifact freshness gate를 추가한다.

## 작업 중단 조건

1. stage SSOT를 고정하려면 immutable substrate 설계가 먼저 필요함
2. partial-success path가 외부 의존성 availability policy와 얽혀 별도 정책 결정이 필요함

## 롤백 기준

- partial-success path를 warning log만 강화하는 수준으로 남기는 경우
- stale intermediate를 여전히 자동 재사용하는 경우

## 금지사항

- ETL 실패를 advisory warning으로 낮추지 말 것
- partial artifact를 success artifact처럼 남기지 말 것

## 수용 예시

- 수용:
  - alias generation 일부 실패 -> ETL refused
- 비수용:
  - alias generation 일부 실패 -> warning만 남기고 다음 단계 진행

## 테스트

- stale intermediate rejection test
- Track C / Doc2Query / alias partial-success failure tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts <etl-target-tests>
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] stage SSOT가 문서와 코드에서 동일함
- [ ] partial-success success exit가 제거됨
- [ ] ETL refused semantics가 테스트로 고정됨

## 완료 조건

- ETL stage graph가 stale intermediate와 partial-success를 정상 success로 취급하지 않는다.
