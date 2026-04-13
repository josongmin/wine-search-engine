# T-E6-01 Remove Uncertainty Neutral Masking

## 목표

`uncertaintyPenalty`가 NaN/invalid일 때 `0.5` neutral confidence로 위장하는 경로를 제거한다.

## 현재 근거

- neutral constant가 남아 있다: [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:24>)
- 실제 fallback도 그 상수를 쓴다: [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:349>)

## 선행 티켓

- 없음. 독립 착수 가능

## 정확한 산출물

1. NaN uncertainty를 neutral 0.5로 위장하지 않는 코드
2. degraded/undefined contract를 검증하는 테스트
3. 관련 response field 기대값 문서화

## 구현 범위

1. `UNCERTAINTY_CONFIDENCE_NEUTRAL` 제거
2. uncertainty signal invalid 시 아래 중 하나로 통일
   - `uncertainty.uncertaintyConfidence` omitted
   - `approximationUsed=true` + degradation reason
3. consumer schema와 UI가 missing uncertainty를 처리할 수 있게 정리

## 수정 대상 파일

- [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:24>)
- [search-response.schema.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/interface/http/schemas/search-response.schema.ts:1>)
- 테스트: [search-usecase-map-result-items.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/unit/application/search/search-usecase-map-result-items.test.ts:129>)

## 수정 금지 범위

- ranking formula 재튜닝
- uncertainty source 계산식 변경
- response envelope 변경

## 예상 충돌 파일

- [search-usecase-map-result-items.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/application/search/search-usecase-map-result-items.ts:24>)
- [response-builder.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/service/response-builder.ts:124>)
- [engine-decision.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/response/model/engine-decision.ts:14>)

## 착수 전 확인

```bash
rg -n "UNCERTAINTY_CONFIDENCE_NEUTRAL|uncertaintyConfidence" \
  src/application/search src/interface/http/schemas test
```

## 구현 단계

1. uncertainty field contract를 먼저 결정한다.
2. `0.5` midpoint constant를 제거한다.
3. omitted/degraded branch를 schema와 UI consumer까지 같이 반영한다.

## 작업 중단 조건

1. undefined/degraded contract를 내리려면 E6-03 score projection 정리가 먼저 필요함
2. consumer가 neutral 0.5에 강하게 의존해 별도 migration이 선행돼야 함

## 롤백 기준

- NaN masking 대신 다른 neutral default를 넣는 경우
- degraded reason 없이 값만 비워 놓는 경우

## 금지사항

- `0`, `0.5`, `1` 같은 대체 midpoint를 다시 넣지 말 것
- broken upstream score를 "정보 없음"과 "중립"으로 혼동하지 말 것

## 수용 예시

- 수용:
  - invalid uncertainty -> field omitted
  - invalid uncertainty -> degradation reason present
- 비수용:
  - invalid uncertainty -> `0.5`

## 테스트

- NaN uncertainty result item snapshot
- schema compatibility test
- no accidental `0.5` leak test

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts \
  test/unit/application/search/search-usecase-map-result-items.test.ts \
  src/interface/http/schemas/__tests__/search-response-v1.schema.test.ts
```

## 머지 전 체크리스트

- [ ] `0.5` midpoint 상수 제거
- [ ] schema와 consumer가 missing uncertainty 허용
- [ ] snapshots에 neutral fallback 잔재 없음

## 완료 조건

- invalid uncertainty signal이 neutral confidence로 내려가지 않는다.
