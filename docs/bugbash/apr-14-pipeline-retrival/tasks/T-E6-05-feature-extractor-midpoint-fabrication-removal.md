# T-E6-05 Feature Extractor Midpoint Fabrication Removal

## 목표

predictor/feature extractor 입력에서 missing sensory, prestige, rerank score를 midpoint나 fabricated neutral 값으로 채우는 seam을 제거한다.

## 현재 근거

- EPIC-6은 predictor/feature extractor 입력의 fabricated midpoint 제거를 요구한다: [EPIC-6-ranking-score-contract-closure.md](</Users/songmin/Documents/code-wine/wine-search-engine/docs/bugbash/apr-14-pipeline-retrival/EPIC-6-ranking-score-contract-closure.md:32>)
- `UNCERTAINTY_CONFIDENCE_NEUTRAL` 제거 티켓은 있지만, feature extractor 전체 midpoint fabrication closure는 별도 티켓이 없다.

## 선행 티켓

- [T-E6-01 remove-uncertainty-neutral-masking](./T-E6-01-remove-uncertainty-neutral-masking.md)

## 정확한 산출물

1. feature extractor/predictor midpoint fabrication 제거 코드
2. missing-input degraded contract
3. regression tests

## 구현 범위

1. sensory, prestige, rerank score 등 missing feature 입력을 inventory로 정리한다.
2. midpoint/default fill을 제거한다.
3. missing input은 undefined 또는 explicit degraded reason으로 다룬다.

## 수정 대상 파일

- feature extractor / predictor related files
- ranking tests

## 수정 금지 범위

- feature engineering 자체 재설계
- model retraining
- UI score policy 변경

## 예상 충돌 파일

- [ltr-feature-extractor.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/domain/ranking/service/ltr-feature-extractor.ts:147>)
- predictor-related files
- ranking tests

## 착수 전 확인

```bash
rg -n "0\\.5|midpoint|neutral|prestige|sensory|rerank" src/domain/ranking src/application/search test
```

## 구현 단계

1. missing feature fill inventory를 만든다.
2. fabricated midpoint를 제거한다.
3. degraded/undefined contract를 정한다.
4. regression tests를 추가한다.

## 작업 중단 조건

1. missing feature를 허용할지 fail-closed할지 product policy 결정이 필요함
2. midpoint 제거가 model feature dimension contract를 깨뜨림

## 롤백 기준

- midpoint를 다른 magic number로만 바꾸는 경우
- degraded reason 없이 0/empty로만 바꾸는 경우

## 금지사항

- fabricated midpoint를 다른 neutral default로 대체하지 말 것
- missing feature를 silent success로 남기지 말 것

## 수용 예시

- 수용:
  - prestige missing -> explicit degraded/missing feature handling
- 비수용:
  - prestige missing -> `0.5`

## 테스트

- missing feature input regression tests
- degraded contract tests

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts <ranking-feature-target-tests>
pnpm exec tsc --noEmit --pretty false --incremental false
```

## 머지 전 체크리스트

- [ ] midpoint fabrication 제거
- [ ] missing input contract 존재
- [ ] ranking tests가 missing feature를 실제로 검사

## 완료 조건

- feature extractor/predictor가 fabricated midpoint authority를 쓰지 않는다.
