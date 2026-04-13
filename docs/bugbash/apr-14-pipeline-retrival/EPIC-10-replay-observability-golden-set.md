# EPIC-10 Replay / Observability / Golden Set

## 문제 정의

trace vocabulary를 정리해도, 실제 운영 query를 replay하고 regression을 조기에 잡는 harness가 약하면 drift는 다시 숨어든다. 지금은 unit/regression은 강하지만, entity/hybrid/mixed 대표 쿼리의 debug snapshot과 shortfall timeline을 고정하는 live replay/golden discipline이 부족하다.

## 현재 코드 근거

- replay fixture runner는 response의 execution/degradation metadata를 읽지만, canonical provenance block 전체를 golden으로 고정하진 않는다: [run-search-fixture.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/replay-fixtures/search/run-search-fixture.ts:402>)
- e2e golden set은 존재하지만 representative entity/hybrid/mixed query의 provenance/decision closure를 전부 고정하진 않는다: [golden-set.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/e2e/golden-set.test.ts:53>)
- post-route는 execution facts를 로그로 올리지만 retrieval -> ranking -> decision shortfall timeline이 1급 구조로 닫혀 있진 않다: [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:1226>)

## 목표 불변식

1. representative query golden set은 entity/hybrid/mixed/comparison 핵심 시나리오를 커버한다.
2. replay harness는 `execution_trace`, `provenance_trace`, degradation/shortfall timeline을 stable snapshot으로 비교한다.
3. 단일 request log만으로 retrieval -> ranking -> decision 실패 경로를 재구성할 수 있다.
4. release gate는 품질 숫자뿐 아니라 contract drift도 함께 막는다.

## breaking changes

- replay/golden fixtures는 result payload만이 아니라 canonical trace block도 비교한다.
- structured log vocabulary는 shortfall timeline을 1급 필드로 포함한다.
- 대표 query 세트는 운영 contract 변경 시 함께 갱신해야 하는 릴리스 자산이 된다.

## 구현 작업 목록

1. `Kalaris Merlot`, `Opus One`, `Barolo`, comparison, mixed hard query 등 대표 시나리오를 포함한 replay golden set을 정의한다.
2. replay runner가 `execution_trace`, `provenance_trace`, degradation reason distribution까지 snapshot 비교하도록 확장한다.
3. post-route structured log에 retrieval shortfall, ranking degradation, decision downgrade를 한 request timeline으로 남긴다.
4. release/eval gate에 contract drift 검사와 golden trace parity를 추가한다.
5. debug-mode 플레이북과 운영 문서에 replay triage 절차를 연결한다.

## 테스트 / 게이트

- representative query golden trace snapshot
- replay fixture provenance/execution parity test
- structured log shortfall timeline schema test
- release gate contract-drift regression test

## merge 조건

- 운영 대표 쿼리를 replay했을 때 trace/decision drift를 payload-level이 아니라 contract-level로 탐지할 수 있다.
- retrieval -> ranking -> decision shortfall timeline이 request 하나에서 재구성 가능하다.
