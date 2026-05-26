# T-GE-05 Retrieval Constraint Semantics And Tier SSOT

## 목표

retrieval가 `known-but-not-retrieval-expressive`인 soft intent를 줄이고, analyzer/planner tier semantics를 flat reclassification이 아니라 단일 SSOT로 고정한다.

## 현재 근거

- validator는 known-but-not-promotable soft constraint를 따로 surface한다: [src/domain/retrieval/service/constraint-validator.ts](../../../../src/domain/retrieval/service/constraint-validator.ts#L38-L47)
- candidate pool은 soft promotion을 일부만 수행한다: [src/domain/retrieval/service/candidate-pool.ts](../../../../src/domain/retrieval/service/candidate-pool.ts#L265-L313)
- `search-usecase-hybrid-retrieval-input`는 `gift_suitability`, `beginner_suitability`, `drinking_window` retrieval phrase expansion이 비어 있다: [src/application/search/search-usecase-hybrid-retrieval-input.ts](../../../../src/application/search/search-usecase-hybrid-retrieval-input.ts#L164-L170)
- analyzer는 bundle을 flat list로 펴고: [src/application/wine-search/query-analyzer.ts](../../../../src/application/wine-search/query-analyzer.ts#L573-L594)
- router는 attribute set으로 다시 soft/hard를 분류한다: [src/application/wine-search/deterministic-router.ts](../../../../src/application/wine-search/deterministic-router.ts#L177-L203)
- difficulty estimator는 explicit heuristic priors를 live path에서 계산한다: [src/domain/retrieval/service/query-difficulty-estimator.ts](../../../../src/domain/retrieval/service/query-difficulty-estimator.ts#L1-L12), [src/domain/retrieval/service/candidate-pool.ts](../../../../src/domain/retrieval/service/candidate-pool.ts#L220-L253)
- per-class fusion은 deterministic prior weights를 live path에서 사용한다: [src/domain/retrieval/service/per-class-fusion-config.ts](../../../../src/domain/retrieval/service/per-class-fusion-config.ts#L1-L12), [src/application/search/search-usecase-post-route-phase.ts](../../../../src/application/search/search-usecase-post-route-phase.ts#L591-L610)
- query-family channel mix도 static fallback map이다: [src/domain/retrieval/service/channel-mix-policy.ts](../../../../src/domain/retrieval/service/channel-mix-policy.ts#L78-L168), [src/domain/retrieval/service/retrieval-profile.ts](../../../../src/domain/retrieval/service/retrieval-profile.ts#L490-L508)
- resolver는 여전히 best-effort alias inference와 env-gated partial-resolution bypass를 가진다: [src/application/search/search-usecase-resolver-candidates.ts](../../../../src/application/search/search-usecase-resolver-candidates.ts#L243-L269), [src/application/search/search-usecase-resolver-candidates.ts](../../../../src/application/search/search-usecase-resolver-candidates.ts#L503-L542)

## 선행 티켓

- [T-GE-04](./T-GE-04-snapshot-publish-quality-gates-and-ltr-closure.md)
- [T-GE-06](./T-GE-06-ingestion-heuristic-purge-and-provenance-truth.md)

## 정확한 산출물

1. constraint tier SSOT 설계와 구현
2. soft intent attribute별 retrieval strategy 표
3. live heuristic retrieval policy inventory와 disposition
4. retrieval-expressive path 추가 또는 명시적 omission contract
5. regression/eval coverage

## 구현 범위

1. analyzer/planner contract를 `hard/soft/inferred` preservation 방향으로 고친다.
2. `style`, `price_band`, `drinking_window`, `gift`, `beginner`, `occasion` 각 속성의 retrieval strategy를 정한다.
3. `ranking-only`로 남길 속성은 validator/log/eval에서 explicit omission contract로 남긴다.
4. `query-difficulty-estimator`, `per-class-fusion-config`, `channel-mix-policy`의 heuristic prior는 `default live policy`, `experiment-only`, `remove` 중 하나로 분류한다.
5. `inferAliasType` best-effort fallback과 `WINE_SEARCH_ALLOW_PARTIAL_RESOLUTION=1` bypass는 authority contract 관점에서 정리한다.
6. `typed retrieval branch`, `promotion`, `lexical/semantic expansion` 중 어떤 path를 쓰는지 속성별로 고정한다.

## 수정 대상 파일

- [src/application/wine-search/query-analyzer.ts](../../../../src/application/wine-search/query-analyzer.ts)
- [src/application/wine-search/wine-search-schemas.ts](../../../../src/application/wine-search/wine-search-schemas.ts)
- [src/application/wine-search/deterministic-router.ts](../../../../src/application/wine-search/deterministic-router.ts)
- [src/application/search/search-usecase-hybrid-retrieval-input.ts](../../../../src/application/search/search-usecase-hybrid-retrieval-input.ts)
- [src/application/search/search-usecase-post-route-phase.ts](../../../../src/application/search/search-usecase-post-route-phase.ts)
- [src/application/search/search-usecase-resolver-candidates.ts](../../../../src/application/search/search-usecase-resolver-candidates.ts)
- [src/domain/retrieval/service/constraint-validator.ts](../../../../src/domain/retrieval/service/constraint-validator.ts)
- [src/domain/retrieval/service/constraint-to-sparse-filter-tokens.ts](../../../../src/domain/retrieval/service/constraint-to-sparse-filter-tokens.ts)
- [src/domain/retrieval/service/candidate-pool.ts](../../../../src/domain/retrieval/service/candidate-pool.ts)
- [src/domain/retrieval/service/query-difficulty-estimator.ts](../../../../src/domain/retrieval/service/query-difficulty-estimator.ts)
- [src/domain/retrieval/service/per-class-fusion-config.ts](../../../../src/domain/retrieval/service/per-class-fusion-config.ts)
- [src/domain/retrieval/service/channel-mix-policy.ts](../../../../src/domain/retrieval/service/channel-mix-policy.ts)
- [src/domain/retrieval/service/retrieval-profile.ts](../../../../src/domain/retrieval/service/retrieval-profile.ts)

## 수정 금지 범위

- agent orchestration product copy 변경
- unrelated search tool surface redesign
- benchmark scorer rubric 변경

## 예상 충돌 파일

- [src/application/search/search-tool-retrieval-core.ts](../../../../src/application/search/search-tool-retrieval-core.ts)
- [src/application/search/search-usecase-pre-route-phase.ts](../../../../src/application/search/search-usecase-pre-route-phase.ts)
- [src/domain/shared/constants/constraint-attributes.ts](../../../../src/domain/shared/constants/constraint-attributes.ts)

## 착수 전 확인

```bash
rg -n "normalizedConstraints|hard|soft|inferred|soft_tier_not_promotable|drinking_window|gift_suitability|beginner_suitability|style|price_band|occasion" src/application src/domain/retrieval
pnpm vitest run test/regression/retrieval-soft-to-hard-promotion.regression.test.ts test/regression/c1b-soft-attr-retrieval-propagation.regression.test.ts test/regression/retrieval-plan-builder-properties.regression.test.ts
```

## 구현 단계

1. 현재 attribute별 retrieval strategy 표를 먼저 만든다.
2. analyzer contract에서 tier flatten seam을 제거한다.
3. router와 retrieval input builder가 tier SSOT를 직접 소비하게 바꾼다.
4. heuristic prior surfaces를 inventory로 고정하고, live default에 남길 것과 실험 rail로 내릴 것을 분리한다.
5. `inferAliasType` / partial-resolution bypass를 authority contract 기준으로 fail-closed 또는 explicit degraded contract로 정리한다.
6. 속성별로 `promotion`, `typed branch`, `expansion`, `ranking-only` 중 하나를 명시하고 테스트를 추가한다.
7. regression/eval rail로 close한다.

## 작업 중단 조건

1. analyzer contract 변경이 mini-loop/tool schema까지 연쇄되어 별도 migration PR이 필요함
2. 일부 속성은 현재 index substrate가 없어 retrieval-expressive path를 구현할 데이터 기반이 없음

## 롤백 기준

- flat `normalizedConstraints`는 유지된 채 attribute-name 재분류만 늘어남
- new attribute support를 넣었지만 validator/eval/trace가 따라오지 않음

## 금지사항

- soft intent를 다시 hard filter로 재승격하는 임시 해결 금지
- analyzer/planner mismatch를 ordering/priority comment로만 덮는 것 금지
- index substrate 없는 속성에 fabricated midpoint/default value 주입 금지

## 수용 예시

- 수용:
  - 속성별 retrieval strategy가 코드와 테스트에서 한 의미만 가진다
- 비수용:
  - analyzer는 flat, router는 재분류, validator는 별도 예외 처리로 계속 분리된 상태

## 테스트

- tier-preserving analyzer/router contract tests
- soft intent retrieval strategy regression tests
- validator dropped/unrecognized parity tests

## 검증 명령

```bash
pnpm vitest run src/application/wine-search/__tests__/query-analyzer.test.ts src/application/wine-search/__tests__/deterministic-router.test.ts test/regression/retrieval-soft-to-hard-promotion.regression.test.ts test/regression/c1b-soft-attr-retrieval-propagation.regression.test.ts test/regression/retrieval-plan-builder-properties.regression.test.ts test/regression/retrieval-critic-properties.regression.test.ts
```

## 머지 전 체크리스트

- [x] analyzer/planner tier SSOT가 단일화됨
- [x] 속성별 retrieval strategy가 문서/코드/테스트에서 일치
- [x] `soft_tier_not_promotable`가 intentional omission인지 gap인지 구분 가능
- [x] heuristic prior / fallback surface의 live-vs-experimental disposition이 명시됨

## DoD

1. analyzer/planner tier semantics가 flat reclassification에 의존하지 않는다.
2. 이번 범위 속성들의 retrieval strategy가 명시적이고 테스트된다.
3. live heuristic policy surfaces와 degraded bypass가 explicit contract를 가진다.
4. retrieval quality gap이 validator/eval/trace에서 관측 가능하다.

## 완료 조건

- retrieval semantics가 attribute-name 재분류 임시 방편이 아니라 tier SSOT와 속성 전략 표로 닫힌다.
