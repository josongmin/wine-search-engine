# T-E10-01 Representative Replay Corpus And Golden Trace

## 목표

representative query corpus를 replay fixture/golden set에 올리고, execution/provenance trace까지 snapshot으로 고정한다.

## 현재 근거

- replay runner는 존재한다: [run-search-fixture.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/replay-fixtures/search/run-search-fixture.ts:402>)
- e2e golden set도 존재한다: [golden-set.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/e2e/golden-set.test.ts:53>)
- 하지만 canonical trace snapshot까지는 안 묶는다: [EPIC-10-replay-observability-golden-set.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-10-replay-observability-golden-set.md:1>)

## 선행 티켓

- [T-E5-01 stable-provenance-trace-domain-contract](./T-E5-01-stable-provenance-trace-domain-contract.md)
- [T-E5-02 unified-provenance-shortfall-taxonomy](./T-E5-02-unified-provenance-shortfall-taxonomy.md)

## 정확한 산출물

1. 대표 query corpus 목록
2. execution/provenance trace snapshot fixture
3. result drift와 trace drift 분리 assertion 테스트

## 구현 범위

1. representative queries를 아래 축으로 추가한다.
   - exact entity
   - ambiguous short form
   - hard constraint hybrid
   - specialized browse
   - mixed similarity
   - comparison
2. replay fixture output에 `execution_trace`와 `provenance_trace` snapshot을 포함한다.
3. trace drift와 result drift를 분리해 assert 한다.

## 수정 대상 파일

- [run-search-fixture.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/replay-fixtures/search/run-search-fixture.ts:402>)
- [golden-set.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/e2e/golden-set.test.ts:38>)
- [test/replay-fixtures/search](</Users/songmin/Documents/code-wine/wine-search-engine/test/replay-fixtures/search>)

## 수정 금지 범위

- runtime search logic 변경
- replay harness 전면 재설계
- trace taxonomy 설계 변경

## 예상 충돌 파일

- [run-search-fixture.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/replay-fixtures/search/run-search-fixture.ts:402>)
- [golden-set.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/e2e/golden-set.test.ts:38>)
- [test/replay-fixtures/search](</Users/songmin/Documents/code-wine/wine-search-engine/test/replay-fixtures/search>)

## 착수 전 확인

```bash
find test/replay-fixtures/search -maxdepth 1 -type f | sort
```

## 구현 단계

1. representative corpus 목록을 먼저 확정한다.
2. fixture JSON과 expected trace schema를 같이 확장한다.
3. golden-set은 result assertions와 trace assertions를 분리한다.

## 작업 중단 조건

1. canonical trace schema가 E5에서 아직 고정되지 않음
2. representative corpus 선정이 제품/데이터 팀 정책 결정을 요구함

## 롤백 기준

- top1 entity만 검증하고 trace는 opaque blob snapshot으로 남기는 경우
- entity/hybrid/mixed/comparison 중 일부가 corpus에서 빠지는 경우

## 금지사항

- trace 전체를 opaque snapshot 한 덩어리로만 비교하지 말 것
- representative corpus에 exact-only query만 넣지 말 것

## 수용 예시

- 수용:
  - `Kalaris Merlot`는 exact entity + provenance trace를 검사
  - `Barolo`는 hybrid constraint shortfall trace를 검사
- 비수용:
  - top1 entity만 맞으면 trace는 아무거나 통과

## 테스트

- replay fixture snapshots
- e2e golden trace snapshots
- representative corpus coverage report

## 검증 명령

```bash
pnpm run test:e2e:replay:fixtures:self-contained
pnpm run test:e2e:contract
pnpm exec vitest run --config config/vitest/dev.config.ts test/e2e/golden-set.test.ts
```

## 머지 전 체크리스트

- [ ] representative corpus가 entity/hybrid/mixed/comparison을 모두 포함
- [ ] result drift와 trace drift assertion이 분리됨
- [ ] fixture docs 또는 readme에 corpus 목적이 적힘

## 완료 조건

- 대표 쿼리 drift를 결과 payload뿐 아니라 trace contract로 잡을 수 있다.
