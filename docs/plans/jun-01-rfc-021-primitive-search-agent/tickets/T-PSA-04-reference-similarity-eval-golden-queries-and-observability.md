# T-PSA-04 Reference-Similarity Eval, Golden Queries, And Observability

## 목표

`lookup_wine -> similar_to_entity` 경로와 public/agent seam이 실제로 좋아졌는지 측정할 수 있는 regression corpus, benchmark rail, observability를 추가한다.

## 현재 근거

- `"오푸스원 비슷한 와인"` 같은 live regression이 기존 rail에서 조기 탐지되지 못했다.
- current observability vocabulary는 `similar_items`를 recommendation bucket으로 뭉개는 지점이 있다: [src/domain/query/model/query-observability-vocab.ts](../../../../src/domain/query/model/query-observability-vocab.ts#L112-L133)
- evidence/frame builder는 tool provenance를 읽을 수 있지만 reference-similarity 계약은 아직 없다: [src/domain/evaluation/service/build-evidence-records-from-frames.ts](../../../../src/domain/evaluation/service/build-evidence-records-from-frames.ts#L1-L120)

## 선행 티켓

- [T-PSA-01](./T-PSA-01-deterministic-reference-similarity-primitive.md)
- [T-PSA-02](./T-PSA-02-agent-primitive-composition-cutover.md)
- [T-PSA-03](./T-PSA-03-public-search-path-authority-and-planner-scope-reduction.md)

## 정확한 산출물

1. reference-similarity regression corpus
   - Korean
   - English
   - exact anchor
   - anchor + price/style residual
2. benchmark scenarios / golden queries
3. trace fields:
   - source anchor entity_id
   - primitive invocation chain
   - similarity profile / policy identifier
   - same-entity exclusion reason
4. operator smoke checklist
5. fail-closed regression rail

## 예상 수정 파일

```text
data/golden-queries-gate.jsonl
data/golden-queries-val.jsonl
test/benchmark/agent/scenarios.ts
test/benchmark/agent/scenarios.coverage.ts

src/application/search/post-route-phase-audit-extension.ts
src/domain/query/model/query-observability-vocab.ts
src/domain/evaluation/service/build-evidence-records-from-frames.ts

test/regression/reference-similarity-agent.test.ts
test/regression/reference-similarity-public-search.test.ts
docs/runbook-reference-similarity-smoke.md
```

## 반드시 건드릴 파일

1. `data/golden-queries-gate.jsonl`
2. `data/golden-queries-val.jsonl`
3. `src/application/search/post-route-phase-audit-extension.ts`
4. `src/domain/query/model/query-observability-vocab.ts`
5. `test/regression/reference-similarity-agent.test.ts`

## 가능하면 건드리지 말아야 할 파일 / 레이어

1. `src/domain/retrieval/**`
2. `src/domain/ranking/**`
3. `src/interface/http/routes/**`
4. `src/application/wine-search/**`
5. `src/domain/query/service/planner*.ts`

이 티켓은 eval/trace 티켓이지, retrieval/planner/public route behavior 자체를 재설계하는 티켓이 아니다.

## 구현 범위

1. golden query / scenario 추가
2. trace vocabulary / audit extension 보강
3. regression tests 추가
4. smoke runbook 추가

## 구현 제외 범위

1. retrieval algorithm 개선
2. public route/tool taxonomy 변경
3. broad benchmark framework rewrite

## 구조 규칙

1. regression corpus는 query-family intent를 직접 드러내야 한다.
2. similarity 품질 평가는 top-1 exact hit 하나로 환원하지 않는다.
3. observability는 primitive chain을 숨기지 않는다.
4. owner-local proof rail과 live smoke는 분리해 기록한다.

## 절대 하지 말아야 할 구현

1. failing query를 corpus에서 빼서 green으로 만드는 것
2. operator smoke 문서에만 남기고 automated regression rail을 안 추가하는 것
3. trace를 human summary 한 줄로만 남겨서 machine-checkable provenance를 없애는 것
4. similarity regression을 exact lookup regression으로 대체하는 것

## 실패 패턴

1. golden queries는 추가됐는데 benchmark scenarios와 이름/의도가 맞지 않는 경우
2. trace field는 늘었는데 tool/evidence builder가 그 필드를 소비하지 않는 경우
3. smoke runbook은 있는데 regression rail이 없어 다시 live에서만 터지는 경우

## 구현 순서

1. golden/scenario 추가
2. trace vocab / audit extension 추가
3. regression tests 추가
4. smoke runbook 정리

## 금지사항

1. `"opus one"` 같은 exact lookup 케이스만 넣고 similarity regression이라고 부르는 것 금지
2. same-entity leakage를 allowed behavior로 방치하는 것 금지
3. trace에서 primitive chain을 human summary 한 줄로만 남기는 것 금지

## 검증 명령

```bash
pnpm run typecheck
pnpm exec vitest run test/regression/reference-similarity-agent.test.ts test/regression/reference-similarity-public-search.test.ts
pnpm run test:unit:file -- test/benchmark/agent/scenarios.coverage.ts
```

## 리뷰어 체크포인트

1. Korean/English reference-similarity 케이스가 모두 있는지
2. anchor loss / same-entity leakage 회귀가 실제로 검출되는지
3. retrieval/planner behavior를 몰래 수정하지 않았는지
4. operator용 smoke와 automated rail이 둘 다 있는지

## DoD

1. Korean/English reference-similarity regression set이 생긴다.
2. primitive invocation chain과 anchor provenance가 trace에 남는다.
3. same-entity leakage / anchor loss 회귀가 rail에서 걸린다.
4. operator가 반복 실행할 smoke checklist가 문서화된다.
