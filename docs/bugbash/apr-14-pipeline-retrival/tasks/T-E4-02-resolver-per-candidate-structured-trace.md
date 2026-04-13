# T-E4-02 Resolver Per-Candidate Structured Trace

## 목표

resolver 내부 score/calibration/boundary를 per-candidate structured trace로 노출해, exact route 실패를 request 하나로 재현 가능하게 만든다.

## 현재 근거

- scoring/calibration/boundary는 존재한다: [resolver.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/resolver/service/resolver.ts:233>), [resolver.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/resolver/service/resolver.ts:279>)
- singleton bypass와 boundary 상태는 내부에만 있다: [resolver.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/resolver/service/resolver.ts:291>)

## 선행 티켓

- [T-E4-01 entity-route-batch-hydration-hard-requirement](./T-E4-01-entity-route-batch-hydration-hard-requirement.md) 권장

## 정확한 산출물

1. resolver per-candidate structured trace 타입
2. request debug/audit surface에 trace를 싣는 코드
3. exact/singleton/drop 케이스 snapshot 테스트

## 구현 범위

1. resolver trace payload에 아래 필드를 추가한다.
   - `entity_id`
   - `raw_score`
   - `calibrated_score`
   - `decision_threshold`
   - `lookup_strategy_adjustments`
   - `ambiguity_detected`
   - `drop_reason`
2. request debug mode와 audit/debug surface 중 어디까지 노출할지 경계를 고정한다.
3. singleton exact path와 low-confidence singleton path를 구분 가능하게 만든다.

## 수정 대상 파일

- [resolver.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/resolver/service/resolver.ts:233>)
- [resolve-result.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/resolver/model/resolve-result.ts:1>)
- 필요 시: [decision-trace.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/resolver/model/decision-trace.ts:1>)
- 테스트: [resolver-singleton-routing.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/resolver/__tests__/resolver-singleton-routing.test.ts:1>)

## 수정 금지 범위

- resolver scoring formula 변경
- ambiguity threshold 재튜닝
- decision engine taxonomy 확장

## 예상 충돌 파일

- [resolver.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/resolver/service/resolver.ts:233>)
- [audit-extension.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/audit/model/audit-extension.ts:61>)
- [search-usecase-post-route-phase.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts:137>)

## 착수 전 확인

```bash
rg -n "decisionTrace|buildTrace|singletonBypass|applyDecisionBoundary" src/domain/resolver/service/resolver.ts
```

## 구현 단계

1. existing resolver trace shape를 먼저 정리한다.
2. candidate-level trace sub-structure를 추가한다.
3. trace field names를 snake_case 또는 기존 trace naming과 일치시킨다.
4. debug/audit 노출 범위를 결정하고 과도한 payload를 피하되 핵심 gate 정보는 빠지지 않게 한다.

## 작업 중단 조건

1. trace surface를 추가하려면 E5 stable provenance trace schema가 먼저 필요함
2. trace payload가 과도하게 커져 별도 exposure policy가 필요함

## 롤백 기준

- trace 추가 때문에 resolver 계산식 자체가 변하는 경우
- structured field 대신 free-form log string으로 후퇴하는 경우

## 금지사항

- free-form string log만 추가하고 structured trace는 안 넣는 방식 금지
- candidate score를 재계산해서 trace에 넣지 말 것. 실제 사용값만 기록할 것

## 수용 예시

- 수용:
  - 각 candidate에 `raw_score`, `calibrated_score`, `drop_reason`이 기록됨
- 비수용:
  - 최종 winner만 trace에 남고 나머지는 안 보임

## 테스트

- resolver trace snapshot test
- singleton bypass resolved trace
- low-confidence singleton non-bypass trace

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts \
  src/domain/resolver/__tests__/resolver-singleton-routing.test.ts \
  src/domain/resolver/__tests__/resolver-sort-tiebreaker.test.ts \
  src/domain/decision/__tests__/decision-engine.test.ts
```

## 머지 전 체크리스트

- [ ] trace로 singleton exact path를 재현 가능
- [ ] trace 필드명이 기존 vocabulary와 충돌하지 않음
- [ ] score 재계산이 아니라 실제 사용값 기록

## 완료 조건

- `Kalaris Merlot`류 exact query를 request trace만으로 재현할 수 있다.
