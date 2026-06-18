# T-E2-01 Remove Residual Compiled Fallback Reads

## 목표

post-route와 hybrid ranking에서 남아 있는 `compiled?.execution... ?? plan...` fallback read를 제거한다. production runtime은 compiled가 없으면 실행되지 않도록 한다.

## 현재 근거

- post-route snapshot/build helper는 아직 fallback read를 한다: [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:374>)
- hybrid ranking route facts도 fallback read를 한다: [search-usecase-hybrid-ranking-pipeline.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-ranking-pipeline.ts:120>)
- pre-route는 이미 production compiled-first를 강제한다: [search-usecase-pre-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-pre-route-phase.ts:163>)

## 선행 티켓

- 없음. Wave 1 시작 티켓이다.

## 정확한 산출물

1. production hot path에서 `compiled?.execution.* ?? plan.*` 패턴이 제거된 코드
2. tests/fixtures 전용 explicit seam 또는 helper 분리
3. fallback 제거를 검증하는 단위 테스트
4. 문서와 실제 grep 결과가 일치함을 보여주는 머지 근거

## 구현 범위

1. `search-usecase-post-route-phase.ts`의 execution fact derivation에서 compiled optional access를 제거한다.
2. `search-usecase-hybrid-ranking-pipeline.ts`의 execution contract builder를 `compiled required`로 바꾼다.
3. production call graph에서 nullable compiled를 허용하는 helper signature를 축소한다.
4. fixture/test seam은 별도 builder 또는 explicit opt-in seam으로 분리한다.

## 수정 대상 파일

- [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:360>)
- [search-usecase-hybrid-ranking-pipeline.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-ranking-pipeline.ts:112>)
- 필요 시: [search.usecase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search.usecase.ts:416>)
- 필요 시: [search.usecase.ts hybrid route](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search.usecase.ts>)
- 테스트: [search-usecase-post-route-phase.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/unit/application/search/search-usecase-post-route-phase.test.ts:734>), [search-usecase-hybrid-ranking-pipeline.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/unit/application/search/search-usecase-hybrid-ranking-pipeline.test.ts:98>)

## 수정 금지 범위

- `plan` 타입 전체 제거
- response wire contract 변경
- unrelated route semantics 변경

## 예상 충돌 파일

- [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:360>)
- [search-usecase-hybrid-ranking-pipeline.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-ranking-pipeline.ts:112>)
- [search.usecase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search.usecase.ts:416>)

## 착수 전 확인

```bash
rg -n "compiled\\?\\.execution\\..*\\?\\? plan\\." src/application/search
```

기대값:
- `search-usecase-post-route-phase.ts`
- `search-usecase-hybrid-ranking-pipeline.ts`

이외의 hot path가 나오면 그 파일도 같이 닫고 티켓 문서에 추가한다.

## 구현 단계

1. `compiled?.execution.effectiveRetrievalMode ?? plan.retrievalMode` 패턴을 제거할 지점을 전부 grep으로 다시 확인한다.
2. post-route helper 입력 타입을 `compiled required` 또는 `executionFacts required`로 바꾼다.
3. hybrid ranking의 route-fact builder를 compiled required로 바꾼다.
4. production call sites는 전부 compiled를 넘기게 맞추고, tests/fixtures만 explicit seam으로 분리한다.
5. fallback 제거로 깨지는 테스트는 `compiled`를 명시 주입하는 방식으로 고친다.

## 작업 중단 조건

1. production call site 중 compiled를 절대로 만들 수 없는 경로가 새로 발견됨
2. 티켓을 닫으려면 response schema를 바꿔야 함
3. fallback 제거가 아니라 planner/execution 설계 자체를 다시 짜야 하는 수준의 결합이 발견됨

## 롤백 기준

- fallback 제거 뒤 검색 hot path 테스트가 광범위하게 붕괴하고, 원인이 단순 call site 누락이 아니라 contract 재설계로 번질 때
- tests/fixtures seam 분리가 아니라 production helper 내부 재-fallback으로 되돌리게 될 때

## 비범위

- `compileFromLegacyPlan()` test seam 삭제 자체는 다음 티켓이 아니라 본 티켓에서 production-path만 닫는다.

## 금지사항

- `plan.retrievalMode`를 다시 execution fallback source로 쓰지 말 것
- production code에 `compiled === undefined` 분기를 새로 만들지 말 것
- 단순 `!compiled ? fail open : ...` 같은 중간 fallback 금지

## 수용 예시

- 수용:
  - production search에서 `compiled`가 없으면 즉시 실패
  - execution route/mode는 `compiled.execution`에서만 읽음
- 비수용:
  - `compiled`가 없으면 `plan.retrievalMode`를 대신 읽음
  - fixture seam을 production helper 내부에 숨겨둠

## 테스트

- production path에서 compiled 부재 시 즉시 실패
- post-route execution contract snapshot에서 fallback-derived mode/route가 사라짐
- hybrid ranking pipeline execution facts가 compiled-only source 사용

## 검증 명령

```bash
pnpm exec tsc --noEmit --pretty false --incremental false
pnpm exec vitest run --config config/vitest/dev.config.ts \
  test/unit/application/search/search-usecase-post-route-phase.test.ts \
  test/unit/application/search/search-usecase-hybrid-ranking-pipeline.test.ts
```

## 머지 전 체크리스트

- [ ] hot path에서 `compiled?.execution.* ?? plan.*`가 사라졌다
- [ ] tests/fixtures seam은 explicit 이름으로 분리됐다
- [ ] post-route와 ranking이 같은 execution source를 본다

## 완료 조건

- production runtime source code에 `compiled?.execution.* ?? plan.*` 패턴이 search hot path에서 남아 있지 않다.
