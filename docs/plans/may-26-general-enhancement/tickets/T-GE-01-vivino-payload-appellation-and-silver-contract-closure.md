# T-GE-01 Vivino Payload Appellation And Silver Contract Closure

## 목표

`VivinoPayload` 타입, `transformRow()` 로직, `SilverWineRecord` 산출물 사이의 `appellation` 계약을 단일 SSOT로 고정한다.

## 현재 근거

- `transformRow()`는 `payload?.appellation?.name`을 읽는다: [scripts/etl/vivino-to-silver.ts](../../../../scripts/etl/vivino-to-silver.ts#L1228-L1233)
- `VivinoPayload` 타입에는 `appellation`이 없다: [scripts/etl/types.ts](../../../../scripts/etl/types.ts#L25-L175)
- 최종 silver 산출물은 `appellation: null`로 버린다: [scripts/etl/vivino-to-silver.ts](../../../../scripts/etl/vivino-to-silver.ts#L1357-L1359)
- live `pnpm run typecheck:etl`가 이 seam에서 죽는다.

## 선행 티켓

- 없음

## 정확한 산출물

1. `VivinoPayload.appellation` 타입 정의
2. `appellation` silver contract 정책 확정
3. `transformRow()`와 `SilverWineRecord`가 같은 정책을 사용하도록 수정
4. 관련 unit/regression 테스트

## 구현 범위

1. `appellation`을 source에서 읽는다면 타입과 silver output도 동일 정책으로 맞춘다.
2. `appellation`을 저장하지 않을 거면 read path 자체를 제거하고 comment로 unsupported 이유를 명시한다.
3. `appellation`이 grape inference/search text/region normalization과 어떤 관계를 가지는지 정리한다.

## 수정 대상 파일

- [scripts/etl/types.ts](../../../../scripts/etl/types.ts)
- [scripts/etl/vivino-to-silver.ts](../../../../scripts/etl/vivino-to-silver.ts)
- [test/unit/etl/vivino-to-silver.test.ts](../../../../test/unit/etl/vivino-to-silver.test.ts)
- 필요 시 [test/regression/c2-downstream-appellation-retrieval.regression.test.ts](../../../../test/regression/c2-downstream-appellation-retrieval.regression.test.ts)

## 수정 금지 범위

- snapshot entity id authority 변경
- retrieval planner / router 로직 변경
- publish/runtime substrate schema 변경

## 예상 충돌 파일

- [scripts/etl/index-to-vespa.ts](../../../../scripts/etl/index-to-vespa.ts#L854-L866)
- [scripts/etl/build-search-snapshot.ts](../../../../scripts/etl/build-search-snapshot.ts#L647-L650)

## 착수 전 확인

```bash
rg -n "appellation" scripts/etl/types.ts scripts/etl/vivino-to-silver.ts scripts/etl/index-to-vespa.ts scripts/etl/build-search-snapshot.ts test/unit/etl/vivino-to-silver.test.ts test/regression/c2-downstream-appellation-retrieval.regression.test.ts
pnpm run typecheck:etl
```

## 구현 단계

1. `VivinoPayload` real field shape를 코드와 fixture에서 확인한다.
2. `appellation` 정책을 `persist` 또는 `drop` 중 하나로 결정한다.
3. `transformRow()` read path와 final silver output을 동일 정책으로 맞춘다.
4. `index-to-vespa`와 `build-search-snapshot` 소비 계약을 다시 맞춘다.
5. typecheck와 unit test로 close한다.

## 작업 중단 조건

1. real bronze payload에서 `appellation` shape가 지역별로 여러 형태로 섞여 있어 schema 분기가 먼저 필요함
2. `appellation` persist를 하려면 region normalization ADR 수준 변경이 필요함

## 롤백 기준

- 타입만 추가하고 최종 silver output은 여전히 `null`로 버리는 상태
- `typecheck:etl`는 녹지만 source/silver contract가 여전히 이중 의미를 가짐

## 금지사항

- `as any`로 payload access 우회 금지
- `appellation`을 `''` empty string으로 합성 금지
- unsupported라면 코드에서 읽고 테스트만 끼워 맞추는 반쪽 수정 금지

## 수용 예시

- 수용:
  - payload에 `appellation`이 있으면 타입/transform/output/consumer가 같은 정책을 사용한다
- 비수용:
  - payload access는 남아 있는데 silver output은 계속 `null` 고정이다

## 테스트

- `VivinoPayload.appellation` shape parsing test
- `transformRow()` appellation persist/drop contract test
- typecheck rail

## 검증 명령

```bash
pnpm run typecheck:etl
pnpm vitest run test/unit/etl/vivino-to-silver.test.ts
```

## 머지 전 체크리스트

- [ ] `typecheck:etl` green
- [x] `appellation` 정책이 type/transform/output/consumer에서 동일
- [x] `as any` 우회 없음

## DoD

1. `VivinoPayload.appellation` seam 때문에 ETL 타입체크가 죽지 않는다.
2. `appellation`은 `read but discard` 상태가 아니다.
3. downstream ETL consumer가 같은 contract를 사용한다.

## 완료 조건

- `appellation` contract가 source -> silver -> index/snapshot 전 구간에서 한 의미만 가진다.
