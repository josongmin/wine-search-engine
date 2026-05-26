# T-GE-04 Snapshot Publish Quality Gates And LTR Closure

## 목표

readiness green과 quality green을 분리하고, degraded publish escape hatch를 기본 publish path의 품질 기준으로 승격시키지 못하게 막는다.

## 현재 근거

- snapshot build는 suitability full coverage를 강제한다: [scripts/etl/build-search-snapshot.ts](../../../../scripts/etl/build-search-snapshot.ts#L237-L250)
- carry-forward benchmark coverage가 존재한다: [scripts/etl/build-search-snapshot.ts](../../../../scripts/etl/build-search-snapshot.ts#L260-L345)
- partial indexing publish ack가 있다: [scripts/etl/index-to-vespa.ts](../../../../scripts/etl/index-to-vespa.ts#L1343-L1367)
- missing LTR publish ack가 있다: [scripts/etl/publish-search-snapshot.ts](../../../../scripts/etl/publish-search-snapshot.ts#L1119-L1132)
- runtime state schema는 `allowMissingLtr`와 `activeLtrModels`를 가진다: [scripts/etl/search-snapshot-schema.ts](../../../../scripts/etl/search-snapshot-schema.ts#L85-L120)
- 현재 active runtime state는 `allowMissingLtr=true`, `activeLtrModels=0`였다.

## 선행 티켓

- [T-GE-02](./T-GE-02-silver-trackc-completeness-and-artifact-truth.md)
- [T-GE-03](./T-GE-03-search-text-and-region-normalization-parity.md)
- [T-GE-06](./T-GE-06-ingestion-heuristic-purge-and-provenance-truth.md)

## 정확한 산출물

1. readiness vs quality 상태 분리
2. runtime quality gate 또는 publish-time hard gate
3. LTR missing 상태에 대한 explicit degraded contract
4. carry-forward visibility 강화

## 구현 범위

1. `allowMissingLtr=true`를 readiness pass와 별도 `quality degraded`로 표면화한다.
2. 기본 publish flow에서 `activeLtrModels=0`를 허용하지 않도록 강화하거나, quality gate를 별도 추가한다.
3. carry-forward benchmark records count를 manifest/state에 노출해 current corpus completeness 부족 은폐를 막는다.
4. partial indexing / missing LTR ack는 dev/ops escape hatch로만 남긴다.

## 수정 대상 파일

- [scripts/etl/publish-search-snapshot.ts](../../../../scripts/etl/publish-search-snapshot.ts)
- [scripts/etl/search-snapshot-schema.ts](../../../../scripts/etl/search-snapshot-schema.ts)
- [scripts/etl/build-search-snapshot.ts](../../../../scripts/etl/build-search-snapshot.ts)
- [scripts/etl/verify-search-snapshot-readiness.ts](../../../../scripts/etl/verify-search-snapshot-readiness.ts)
- [test/unit/etl/publish-search-snapshot.test.ts](../../../../test/unit/etl/publish-search-snapshot.test.ts)
- [test/unit/etl/verify-search-snapshot-readiness.test.ts](../../../../test/unit/etl/verify-search-snapshot-readiness.test.ts)

## 수정 금지 범위

- Vespa feed document schema 전면 변경
- retrieval ranking feature engineering
- fixture repo contents 변경

## 예상 충돌 파일

- [scripts/etl/publish-runtime-substrates.ts](../../../../scripts/etl/publish-runtime-substrates.ts#L500-L620)
- [src/infrastructure/health/search-snapshot-readiness.ts](../../../../src/infrastructure/health/search-snapshot-readiness.ts)

## 착수 전 확인

```bash
rg -n "allowMissingLtr|activeLtrModels|carryForward|quality|readiness|ETL_PUBLISH_LTR_BYPASS_ACK|ETL_INDEX_PARTIAL_FAILURE_ACK" scripts/etl src/infrastructure/health
cat /Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json
```

## 구현 단계

1. readiness와 quality의 의미를 먼저 분리한다.
2. runtime state/manifest에 quality-relevant counts를 추가한다.
3. missing LTR 상태를 quality gate에서 explicit fail 또는 degraded로 분리한다.
4. carry-forward가 사용된 경우 current vs carried counts를 노출한다.
5. publish/readiness tests를 갱신한다.

## 작업 중단 조건

1. current deploy workflow가 readiness만을 hard dependency로 사용해 quality status 추가가 별도 rollout을 요구함
2. LTR store bootstrap policy가 product/ops 결정 없이는 고정 불가

## 롤백 기준

- readiness pass만 유지되고 quality degraded가 여전히 숨겨짐
- `allowMissingLtr=true` 상태를 운영 정상으로 계속 취급

## 금지사항

- missing LTR를 warning string 하나로만 표면화하지 말 것
- carry-forward 사용량을 숨긴 채 quality green을 선언하지 말 것

## 수용 예시

- 수용:
  - readiness는 pass여도 quality status는 degraded/fail로 분리된다
- 비수용:
  - `allowMissingLtr=true` 상태가 그대로 normal publish success로 남는다

## 테스트

- publish missing-LTR quality gate test
- runtime state quality status test
- carry-forward visibility test

## 검증 명령

```bash
pnpm vitest run test/unit/etl/publish-search-snapshot.test.ts test/unit/etl/verify-search-snapshot-readiness.test.ts test/unit/etl/build-search-snapshot.test.ts
pnpm exec tsx scripts/etl/verify-search-snapshot-readiness.ts --runtime-state /Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json --require-pointer-parity
```

## 머지 전 체크리스트

- [x] readiness와 quality가 문서/코드/테스트에서 분리됨
- [x] missing LTR 상태가 explicit quality degraded/fail
- [x] carry-forward usage visibility가 추가됨

## DoD

1. `allowMissingLtr=true`, `activeLtrModels=0` 상태는 더 이상 품질 green이 아니다.
2. carry-forward benchmark continuity와 current corpus completeness가 분리 관측된다.
3. degraded publish escape hatch는 default publish success와 혼동되지 않는다.

## 완료 조건

- publish/runtime가 readiness safe일 뿐 아니라 quality safe인지 별도로 판단 가능하다.
