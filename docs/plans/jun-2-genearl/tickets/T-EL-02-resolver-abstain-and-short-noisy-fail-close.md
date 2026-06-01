# T-EL-02 Resolver Abstain And Short-Noisy Fail-Close

## 목표

short noisy typo / transliteration / low-evidence query에서 wrong-positive를 내지 않도록 resolver decision boundary를 class-aware fail-close 방향으로 강화한다.

## 현재 근거

- resolver는 scoring -> calibrate -> ambiguity -> decision boundary 순서다: [src/domain/resolver/service/resolver.ts](../../../../src/domain/resolver/service/resolver.ts)
- scorer는 alias/canonical/phonetic/edit-distance cap을 이미 가진다: [src/domain/resolver/service/candidate-scorer.ts](../../../../src/domain/resolver/service/candidate-scorer.ts)
- lookup strategy에도 short-form noisy cap이 있다: [src/domain/resolver/service/resolver-lookup-strategy.ts](../../../../src/domain/resolver/service/resolver-lookup-strategy.ts)
- live에서 `opu one`이 `Alma Fria`로 wrong-positive resolve된다.

## 선행 티켓

- [T-EL-01](./T-EL-01-lookup-admission-gate-and-query-family-authority.md)

## 정확한 산출물

1. query-class-aware abstain policy
2. top1/top2 margin + evidence floor + noisy support cap의 명시적 contract
3. wrong-positive regression fixtures
4. resolver provenance/decision reason 강화

## 반드시 건드릴 파일

1. `src/domain/resolver/service/resolver.ts`
2. `src/domain/resolver/service/candidate-scorer.ts`
3. `src/domain/resolver/service/resolver-lookup-strategy.ts`
4. `src/application/search/search.usecase.ts`
5. `test/regression/noisy-runtime-execution-contract.regression.test.ts`

## 가능하면 건드리지 말아야 할 파일 / 레이어

1. `src/interface/http/routes/**`
2. `web/**`
3. `scripts/etl/**`

## 구현 범위

1. noisy latin / korean typo / transliteration / abbreviation class별 decision floor
2. wrong-positive보다 `ambiguous/failed`를 우선하는 policy
3. provenance trace reason-code 정리
4. targeted unit/regression tests

## 구현 제외 범위

1. alias source data 추가
2. operator tooling
3. agent routing

## 구조 규칙

1. fail-close는 resolver decision seam에서 닫아야 한다.
2. `search_hybrid` fallback으로 wrong-positive를 덮지 않는다.
3. class-aware policy는 scorer cap과 decision boundary를 함께 가져야 한다.

## 절대 하지 말아야 할 구현

1. 특정 hot query 문자열 하드코딩
2. public response에서 top hit를 숨기는 방식의 pseudo-fail-close
3. candidate pool을 줄여서 우연히 abstain시키는 방식

## 실패 패턴

1. `opu one`은 막혔지만 같은 class의 `dom perignom` 류는 계속 wrong-positive
2. abstain가 늘면서 exact lookup recall까지 같이 무너짐
3. trace에 왜 abstain했는지 근거가 없음

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:verification:noisy
pnpm exec vitest run src/domain/resolver/service/__tests__/*.test.ts
```

## DoD

1. short noisy wrong-positive class가 regression hotset에서 fail-close로 전환된다.
2. exact/high-evidence lookup recall은 유지된다.
3. resolver decision trace가 operator가 읽을 수 있는 reason code를 남긴다.
