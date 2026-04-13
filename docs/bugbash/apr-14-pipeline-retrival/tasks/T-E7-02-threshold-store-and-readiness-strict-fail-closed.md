# T-E7-02 Threshold Store And Readiness Strict Fail-Closed

## 목표

threshold/default row fallback과 non-prod light readiness probe를 strict fail-closed로 재정렬한다.

## 현재 근거

- threshold default row invalid/no-row 시 in-memory default fallback: [pg-threshold-store.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/pg-threshold-store.ts:72>)
- non-prod는 light probe path가 남아 있다: [readiness.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/config/readiness.ts:162>)
- strict hash verify는 별도 path에만 있다: [search-snapshot-readiness.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/health/search-snapshot-readiness.ts:564>), [search-snapshot-readiness.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/health/search-snapshot-readiness.ts:606>)

## 선행 티켓

- [T-E7-01 jsonb-and-entity-row-loud-failure](./T-E7-01-jsonb-and-entity-row-loud-failure.md) 권장

## 정확한 산출물

1. prod threshold store fail-closed 코드
2. non-prod strict readiness 기본화 또는 명시 정책 코드
3. missing default threshold/readiness mismatch 테스트

## 구현 범위

1. prod threshold store에서 no-default-row / invalid-shape fallback 제거
2. non-prod readiness도 strict runtime snapshot/hash 검증을 기본으로 사용
3. missing dependency 상태를 `up`으로 오인할 수 있는 light probe를 제거하거나 explicit dev-only seam으로 격리

## 수정 대상 파일

- [pg-threshold-store.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/pg-threshold-store.ts:72>)
- [readiness.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/config/readiness.ts:162>)
- [search-snapshot-readiness.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/health/search-snapshot-readiness.ts:564>)
- 테스트: [readiness.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/config/__tests__/readiness.test.ts:66>), [search-snapshot-runtime-readiness.test.ts](</Users/songmin/Documents/code-wine/wine-search-engine/test/unit/config/search-snapshot-runtime-readiness.test.ts:165>)

## 수정 금지 범위

- threshold tuning 값 변경
- embedding dependency 정책 변경
- publish script 전면 재설계

## 예상 충돌 파일

- [pg-threshold-store.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/adapter/pg-threshold-store.ts:72>)
- [readiness.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/config/readiness.ts:162>)
- [search-snapshot-readiness.ts](</Users/songmin/Documents/code-wine/wine-search-engine/src/infrastructure/health/search-snapshot-readiness.ts:564>)

## 착수 전 확인

```bash
rg -n "DEFAULT_THRESHOLD_PROFILE|strictHashes|probeSearchSnapshotRuntimeState" \
  src/infrastructure/adapter src/config src/infrastructure/health test
```

## 구현 단계

1. threshold store fallback을 hard failure semantics로 바꾼다.
2. decision engine tests 중 threshold fallback을 가정한 케이스를 정리한다.
3. readiness strictHashes policy를 env별이 아니라 contract별로 재정의한다.
4. non-prod light probe가 필요하면 explicit `dev_light_probe` seam으로 이름과 scope를 제한한다.

## 작업 중단 조건

1. non-prod strict화가 개발자 로컬 생산성을 심각하게 깨서 별도 opt-in 정책이 필요함
2. threshold fallback 제거가 E1 publish gate와 동시에 조정돼야만 함

## 롤백 기준

- prod 경로에 in-memory default fallback을 남겨두는 경우
- strict readiness 대신 warning log만 강화하는 경우

## 금지사항

- prod path에 in-memory DEFAULT fallback 재도입 금지
- strict hash mismatch를 warning으로 낮추지 말 것

## 수용 예시

- 수용:
  - default threshold row 없음 -> readiness/down 또는 startup failure
- 비수용:
  - default threshold row 없음 -> 조용히 memory default 사용

## 테스트

- invalid default threshold row failure
- no default threshold row failure
- non-prod strict readiness mismatch failure

## 검증 명령

```bash
pnpm exec vitest run --config config/vitest/dev.config.ts \
  src/config/__tests__/readiness.test.ts \
  test/unit/config/search-snapshot-runtime-readiness.test.ts \
  src/domain/decision/__tests__/decision-engine.test.ts
```

## 머지 전 체크리스트

- [ ] threshold fallback 제거
- [ ] non-prod strict readiness 기본화
- [ ] dev-only seam이 남으면 explicit 이름과 문서가 있음

## 완료 조건

- threshold/readiness가 default/light success로 drift를 숨기지 않는다.
