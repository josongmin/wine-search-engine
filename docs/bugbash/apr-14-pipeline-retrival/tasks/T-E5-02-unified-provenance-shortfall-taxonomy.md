# T-E5-02 Unified Provenance Shortfall Taxonomy

## 목표

retrieval / admission / evidence / decision reason code를 하나의 shortfall taxonomy로 통일한다.

## 현재 근거

- decision engine evidence gate는 reason을 downgrade string으로 쓴다: [decision-engine.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/decision/service/decision-engine.ts:541>)
- admission gate는 별도 failure reason 체계를 가진다: [admission-gate.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/decision/service/admission-gate.ts:19>)
- hybrid retrieval/ranking 쪽 degradation도 별도 reason vocabulary를 가진다: [search-usecase-hybrid-candidates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts:90>)

## 선행 티켓

- [T-E5-01 stable-provenance-trace-domain-contract](./T-E5-01-stable-provenance-trace-domain-contract.md)

## 정확한 산출물

1. shortfall reason code vocabulary 표
2. retrieval/ranking/decision 공통 reason code 구현
3. taxonomy regression 테스트

## 구현 범위

1. 공통 taxonomy를 아래 레벨로 정리한다.
   - `provenance_shortfall:*`
   - `evidence_gate:*`
   - `admission_gate:*`
   - `ranking_degradation:*`
2. 기존 free-form reason string을 canonical code + optional detail로 재정렬한다.
3. logs, audit, response meta, replay fixtures가 같은 code space를 쓰게 한다.

## 수정 대상 파일

- [decision-engine.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/decision/service/decision-engine.ts:527>)
- [admission-gate.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/decision/service/admission-gate.ts:19>)
- [search-usecase-hybrid-candidates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts:90>)
- [search-usecase-hybrid-ranking-pipeline.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-ranking-pipeline.ts:195>)
- replay fixtures and tests under [test/replay-fixtures/search](</Users/songmin/Documents/code-wine/wine-search-engine/test/replay-fixtures/search>)

## 수정 금지 범위

- route vocabulary rename
- unrelated degrade reason 정리
- HTTP status code 정책 변경

## 예상 충돌 파일

- [search-usecase-hybrid-candidates.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-candidates.ts:90>)
- [search-usecase-hybrid-ranking-pipeline.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-hybrid-ranking-pipeline.ts:264>)
- [decision-engine.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/decision/service/decision-engine.ts:527>)

## 착수 전 확인

```bash
rg -n "provenance_shortfall|EVIDENCE_GATE|admission|degradationReasons|reasonCodes" \
  src test
```

먼저 해야 할 일:
- 기존 reason code 목록을 표로 뽑아 문서에 정리

## 구현 단계

1. existing reason strings를 전수 수집한다.
2. canonical enum/code list를 먼저 만든다.
3. decision/admission/retrieval/ranking에서 기존 strings를 canonical code로 바꾼다.
4. detail text가 필요하면 `code + detail` 구조로 분리한다.

## 작업 중단 조건

1. 기존 reason code가 외부 analytics/consumer에 직접 노출돼 migration plan이 필요함
2. 하나의 taxonomy로 묶으려면 ranking/decision domain 경계를 다시 설계해야 함

## 롤백 기준

- 통일 taxonomy 대신 alias layer만 덧씌워 reason code 중복이 계속 남는 경우
- 세 단계 중 한 곳이라도 새 vocabulary를 안 쓰는 상태로 머지하게 되는 경우

## 금지사항

- 기존 reason string 위에 alias string을 추가만 하는 방식 금지
- stage마다 다른 prefix naming을 유지하지 말 것

## 수용 예시

- 수용:
  - retrieval miss: `provenance_shortfall:constraint_evidence`
  - decision downgrade: `evidence_gate:constraint_evidence_missing`
- 비수용:
  - 같은 상태가 response에는 `no_match`, audit에는 `constraint gap`, log에는 `missing attrs`

## 테스트

- taxonomy enum tests
- route별 downgrade snapshot tests
- replay fixture reason parity tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts \
  src/domain/decision/__tests__/decision-engine.test.ts \
  test/unit/application/search/search-usecase-hybrid-ranking-pipeline.test.ts \
  test/unit/application/search/search-usecase-post-route-phase.test.ts \
  test/unit/replay-fixtures/run-search-replay.test.ts
```

## 머지 전 체크리스트

- [ ] canonical taxonomy 표가 문서에 존재
- [ ] replay fixtures와 logs가 같은 code space 사용
- [ ] old free-form reason strings를 제거하거나 deprecated mapping 명시

## 완료 조건

- request 한 건에서 같은 shortfall이 surface마다 다른 이름으로 보이지 않는다.
