# T-E6-02 Rerank Normalization Failure Contract

## 목표

rerank normalization failure가 "정상 reranked output"처럼 보이지 않도록 contract를 재정의한다.

## 현재 근거

- normalization 실패 시 original score로 돌아간다: [ranker.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/ranking/service/ranker.ts:1234>)

## 선행 티켓

- [T-E5-02 unified-provenance-shortfall-taxonomy](./T-E5-02-unified-provenance-shortfall-taxonomy.md) 권장

## 정확한 산출물

1. rerank normalization failure 시 contract 동작 정의
2. failure/degradation 테스트
3. reranked처럼 위장되지 않음을 보이는 assertions

## 구현 범위

1. 아래 정책 중 하나를 명시적으로 선택해 구현한다.
   - rerank lane skipped, base ranking authoritative
   - rerank lane failure -> degraded executionMode
2. 결과 payload, ranking metadata, audit trace에서 rerank 미적용/실패를 분명히 표면화한다.
3. "reranked처럼 보이는 output"을 금지한다.

## 수정 대상 파일

- [ranker.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/ranking/service/ranker.ts:1230>)
- [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:150>)
- [audit-extension.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/audit/model/audit-extension.ts:61>)
- 테스트: rerank-related tests under [search-usecase-post-route-phase.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/unit/application/search/search-usecase-post-route-phase.test.ts:1147>)

## 수정 금지 범위

- cross-encoder provider 교체
- ranking weight 재튜닝
- unrelated LTR feature 변경

## 예상 충돌 파일

- [ranker.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/ranking/service/ranker.ts:1234>)
- [cohere-reranker.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/reranking/cohere-reranker.ts:49>)
- rerank 관련 unit tests

## 착수 전 확인

```bash
rg -n "RERANK_SCORE_NORMALIZATION_FAILED_REASON|normalizeRerankScore|rerank_decision_trace" \
  src test
```

## 구현 단계

1. 정책을 문서에 먼저 못 박는다. 기본 권장: `base ranking authoritative + rerank skipped explicit`.
2. ranker metadata에 rerank normalization failure state를 명시한다.
3. audit/response surface가 이를 숨기지 않도록 연결한다.

## 작업 중단 조건

1. fail-closed와 explicit degraded ranking 사이 정책 결정을 이 티켓 범위에서 내릴 수 없음
2. rerank lane이 optional이 아니라 required authority라는 제품 정책 변경이 필요함

## 롤백 기준

- normalization 실패 시 다시 heuristic finalScore로 조용히 되돌아가는 경우
- degraded reason은 남기지만 UI/response가 여전히 reranked 결과처럼 보이는 경우

## 금지사항

- normalization failure 후 결과를 그냥 "reranked"로 표기하지 말 것
- midpoint fabrication 금지

## 수용 예시

- 수용:
  - rerank normalization failure -> `rerank skipped` + degraded metadata
- 비수용:
  - final ranking은 사실 base score인데 UI/audit에는 rerank applied로 보임

## 테스트

- rerank malformed/collapsed batch contract tests
- ranking metadata snapshot
- audit trace rerank decision tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts \
  test/unit/application/search/search-usecase-post-route-phase.test.ts \
  src/domain/retrieval/service/__tests__/foundation-wire-up.smoke.test.ts
```

## 머지 전 체크리스트

- [ ] rerank failure 정책이 문서로 고정됨
- [ ] metadata와 audit trace가 같은 정책을 반영
- [ ] "reranked처럼 보이는 output" 없음

## 완료 조건

- rerank failure가 heuristic fallback처럼 숨어 있지 않다.
