# T-EL-01 Lookup Admission Gate And Query-Family Authority

## 목표

`/v1/lookup/wine`가 모든 free-text를 entity resolver에 밀어 넣지 않도록, `entity query vs concept/facet/discovery query`를 front-door에서 구분하는 admission gate를 추가한다.

## 현재 근거

- lookup route는 path authority로 바로 `lookup_wine` primitive를 강제한다: [src/interface/http/routes/primitive-search.route.ts](../../../../src/interface/http/routes/primitive-search.route.ts#L126-L156)
- mapper도 `retrieval_mode='entity'`를 박는다: [src/interface/http/routes/search-request-mappers.ts](../../../../src/interface/http/routes/search-request-mappers.ts#L63-L84)
- pre-route phase는 planner를 우회한다: [src/application/search/search-usecase-pre-route-phase.ts](../../../../src/application/search/search-usecase-pre-route-phase.ts#L633-L667)
- live에서 `까쇼`가 single wine entity로 over-resolve된다.

## 선행 티켓

- 없음

## 정확한 산출물

1. lookup admission classifier/policy seam
2. admission outcome contract:
   - `allow_entity_lookup`
   - `reject_as_concept_query`
   - `reject_as_comparison_query`
   - `reject_as_under-specified`
3. `/v1/lookup/wine` fail-close 또는 explicit redirect hint
4. hot concept lexicon / entity-only criteria 테스트

## 반드시 건드릴 파일

1. `src/interface/http/routes/primitive-search.route.ts`
2. `src/application/search/search-usecase-pre-route-phase.ts`
3. `src/interface/http/schemas/search-response.schema.ts`
4. `test/integration/http/routes/primitive-search.route.test.ts`

## 가능하면 건드리지 말아야 할 파일 / 레이어

1. `src/application/wine-search/**`
2. `src/domain/mixed/**`
3. `scripts/etl/**`

## 구현 범위

1. admission policy service 추가
2. concept/facet shorthand reject/redirect contract
3. lookup route error payload/decision reason 정리
4. regression fixture 추가

## 구현 제외 범위

1. resolver score threshold 조정
2. alias substrate backfill
3. operator web UI

## 구조 규칙

1. lookup 여부는 route path가 아니라 query class까지 함께 봐야 한다.
2. concept query는 resolve를 시도한 뒤 후처리로 지우지 않는다.
3. comparison query reject semantics와 admission reject semantics를 구분한다.

## 절대 하지 말아야 할 구현

1. `까쇼`류를 resolver 실행 후 top score가 낮으면 reject하는 식으로 처리
2. public `lookup` response에 discovery results를 끼워 넣는 것
3. agent/private tool path와 public route semantics를 섞는 것

## 실패 패턴

1. HTTP는 reject하지만 internal primitive path는 여전히 free-text entity resolve를 허용
2. concept lexicon만 추가하고 under-specified short query는 계속 resolve 시도
3. response meta에 reject reason이 남지 않음

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:integration:file -- test/integration/http/routes/primitive-search.route.test.ts
pnpm exec vitest run src/application/search/__tests__/search-usecase-pre-route-phase.test.ts
```

## DoD

1. concept/facet shorthand가 `/v1/lookup/wine`에서 resolve되지 않는다.
2. admission reject reason이 contract에 남는다.
3. lookup core로 태워도 되는 query class가 명시적으로 고정된다.
