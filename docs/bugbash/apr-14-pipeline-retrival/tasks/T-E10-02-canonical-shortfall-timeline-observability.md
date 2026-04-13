# T-E10-02 Canonical Shortfall Timeline Observability

## 목표

retrieval -> ranking -> decision의 shortfall timeline을 request 하나의 structured log와 debug trace에서 재구성 가능하게 만든다.

## 현재 근거

- post-route는 execution trace를 audit extension으로 올린다: [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:137>)
- search/usecase 내부에는 still fallback-derived pieces와 fragmented trace가 있다: [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:374>)

## 선행 티켓

- [T-E5-02 unified-provenance-shortfall-taxonomy](./T-E5-02-unified-provenance-shortfall-taxonomy.md)
- [T-E10-01 representative-replay-corpus-and-golden-trace](./T-E10-01-representative-replay-corpus-and-golden-trace.md) 권장

## 정확한 산출물

1. shortfall timeline observability shape
2. retrieval -> ranking -> decision stage timeline 코드
3. timeline snapshot/contract tests

## 구현 범위

1. structured log schema에 stage별 shortfall block을 추가한다.
   - retrieval shortfall
   - ranking degradation
   - decision downgrade
2. debug-mode 플레이북과 step vocabulary에 canonical shortfall timeline을 연결한다.
3. replay/golden harness가 timeline parity를 체크하도록 확장한다.

## 수정 대상 파일

- [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:137>)
- [request-pipeline-debug.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/observability/request-pipeline-debug.ts:1>)
- [pipeline-debug-steps.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/observability/pipeline-debug-steps.ts:1>)
- replay/golden tests under [test/replay-fixtures/search](</Users/songmin/Documents/code-wine/wine-search-engine/test/replay-fixtures/search>)

## 수정 금지 범위

- core decision policy 변경
- query observability event schema 전면 재설계
- log backend 교체

## 예상 충돌 파일

- [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:1081>)
- [search-usecase-hybrid-ranking-pipeline.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-ranking-pipeline.ts:264>)
- observability tests / replay fixtures

## 착수 전 확인

```bash
rg -n "pipelineDebug|execution_trace|degradation|shortfall|rulesApplied" \
  src/application/search src/observability test/replay-fixtures
```

## 구현 단계

1. canonical timeline field set을 먼저 정의한다.
2. retrieval, ranking, decision 각 단계에서 same vocabulary로 emit한다.
3. debug-mode 문서와 replay harness를 같이 갱신한다.

## 작업 중단 조건

1. timeline contract를 만들려면 E5 provenance trace와 E10-01 corpus가 먼저 고정돼야 함
2. stage timeline이 기존 query observability event와 충돌해 별도 migration plan이 필요함

## 롤백 기준

- stage timeline 대신 flat log field만 조금 추가하는 경우
- shortfall source를 stage별로 분리하지 못하고 하나의 summary string으로 남기는 경우

## 금지사항

- stage마다 필드명이 다른 shortfall block을 만들지 말 것
- debug log만 바꾸고 replay harness는 그대로 두지 말 것

## 수용 예시

- 수용:
  - retrieval stage: `missing=['constraint_evidence']`
  - ranking stage: `degradation=['rerank_skipped']`
  - decision stage: `downgrade='evidence_gate:constraint_evidence_missing'`
- 비수용:
  - 각 stage가 서로 다른 키 이름과 reason 체계를 씀

## 테스트

- structured log schema tests
- request debug trace timeline snapshot
- replay shortfall timeline parity tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts \
  test/unit/application/search/search-usecase-post-route-phase.test.ts \
  test/unit/replay-fixtures/run-search-replay.test.ts \
  src/observability/__tests__/request-pipeline-debug.test.ts
```

## 머지 전 체크리스트

- [ ] stage별 canonical field set 표 존재
- [ ] replay harness가 timeline parity를 검증
- [ ] debug-mode 문서가 새 timeline을 설명

## 완료 조건

- request 하나만으로 어떤 stage에서 왜 downgrade/fail 됐는지 재구성 가능하다.
