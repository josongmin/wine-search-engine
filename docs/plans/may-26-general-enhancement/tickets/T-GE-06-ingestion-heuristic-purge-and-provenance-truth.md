# T-GE-06 Ingestion Heuristic Purge And Provenance Truth

## 목표

canonical ingestion / Track C path에서 heuristic 또는 provenance-mislabelled enrichment가 그대로 silver/index/runtime substrate로 승격되는 상태를 닫는다.

## 현재 근거

- certification enrichment는 `LLM fallback` / `llm_inferred`를 표방하지만 실제 fallback 구현은 regex keyword match다:
  - taxonomy/comment: [scripts/etl/enrich-certifications.ts](../../../../scripts/etl/enrich-certifications.ts#L4-L7), [scripts/etl/enrich-certifications.ts](../../../../scripts/etl/enrich-certifications.ts#L20-L21)
  - actual fallback: [scripts/etl/enrich-certifications.ts](../../../../scripts/etl/enrich-certifications.ts#L98-L123), [scripts/etl/enrich-certifications.ts](../../../../scripts/etl/enrich-certifications.ts#L150-L166)
- `naturalWine` matcher는 bare `natural` token까지 매치한다: [scripts/etl/enrich-certifications.ts](../../../../scripts/etl/enrich-certifications.ts#L120-L123)
- Track C orchestrator는 canonical step list에 heuristic drinking-window backfill을 포함하고 `requiredCoverage: 1`을 건다: [scripts/etl/run-track-c.ts](../../../../scripts/etl/run-track-c.ts#L8-L13), [scripts/etl/run-track-c.ts](../../../../scripts/etl/run-track-c.ts#L80-L85)
- actual drinking-window implementation도 explicit heuristic stub이다: [scripts/etl/drinking-window-backfill.ts](../../../../scripts/etl/drinking-window-backfill.ts#L6-L12), [scripts/etl/drinking-window-backfill.ts](../../../../scripts/etl/drinking-window-backfill.ts#L90-L141)
- `validate-silver` guidance는 아직 drinking-window를 `Track C step 4`로 안내한다: [scripts/etl/validate-silver.ts](../../../../scripts/etl/validate-silver.ts#L198), [scripts/etl/validate-silver.ts](../../../../scripts/etl/validate-silver.ts#L384-L389)
- silver ETL은 approximate FX를 canonical `priceUsd`로 만든다: [scripts/etl/vivino-to-silver.ts](../../../../scripts/etl/vivino-to-silver.ts#L795-L803)
- silver dedup merge는 longer-string-wins로 `searchTextEn`를 선택한다: [scripts/etl/vivino-to-silver.ts](../../../../scripts/etl/vivino-to-silver.ts#L1404-L1415)
- certification flags는 index 단계에서 runtime `certifications[]`로 바로 승격된다: [scripts/etl/index-to-vespa.ts](../../../../scripts/etl/index-to-vespa.ts#L686-L696), [scripts/etl/index-to-vespa.ts](../../../../scripts/etl/index-to-vespa.ts#L933-L934)

## 선행 티켓

- [T-GE-02](./T-GE-02-silver-trackc-completeness-and-artifact-truth.md)
- [T-GE-03](./T-GE-03-search-text-and-region-normalization-parity.md)

## 정확한 산출물

1. enrichment provenance taxonomy 정리
2. heuristic ingestion step의 canonical-vs-experimental 경계
3. approximate / length-based merge 제거 또는 explicit provenance contract
4. operator guidance / validation message parity
5. unit/regression coverage

## 구현 범위

1. regex/keyword 기반 certification inference를 계속 쓸 거면 provenance를 `llm_inferred`가 아닌 실제 derivation 이름으로 바꾼다.
2. bare `natural` token처럼 false-positive 위험이 큰 matcher를 제거하거나 ontology-backed exact surface로 축소한다.
3. drinking-window heuristic stub는 canonical Track C required step에서 분리하거나 real model contract로 교체한다.
4. approximate FX conversion이 canonical ranking/retrieval substrate를 직접 만들면 provenance를 표면화하거나 canonical field에서 제외한다.
5. `searchTextEn`는 length heuristic이 아니라 field-level authority/provenance 규칙으로 merge한다.
6. validation/operator guidance의 step numbering과 실제 orchestrator를 일치시킨다.

## 수정 대상 파일

- [scripts/etl/enrich-certifications.ts](../../../../scripts/etl/enrich-certifications.ts)
- [scripts/etl/run-track-c-step2.ts](../../../../scripts/etl/run-track-c-step2.ts)
- [scripts/etl/run-track-c.ts](../../../../scripts/etl/run-track-c.ts)
- [scripts/etl/drinking-window-backfill.ts](../../../../scripts/etl/drinking-window-backfill.ts)
- [scripts/etl/validate-silver.ts](../../../../scripts/etl/validate-silver.ts)
- [scripts/etl/vivino-to-silver.ts](../../../../scripts/etl/vivino-to-silver.ts)
- [scripts/etl/index-to-vespa.ts](../../../../scripts/etl/index-to-vespa.ts)
- 관련 unit/regression tests

## 수정 금지 범위

- benchmark scorer rubric 변경
- retrieval planner semantics 변경
- unrelated LTR release workflow 변경

## 예상 충돌 파일

- [scripts/etl/build-search-snapshot.ts](../../../../scripts/etl/build-search-snapshot.ts)
- [scripts/etl/artifact-contract.ts](../../../../scripts/etl/artifact-contract.ts)
- [scripts/etl/types.ts](../../../../scripts/etl/types.ts)

## 착수 전 확인

```bash
rg -n "llm_inferred|naturalWine|drinking-window-backfill|requiredCoverage|approximate FX|searchTextEn.length|Track C step 4|Track C step 5" scripts/etl
pnpm run typecheck:etl
```

## 구현 단계

1. heuristic / provenance-mislabelled fields를 inventory로 고정한다.
2. canonical artifact에 남겨도 되는 derivation과 experimental rail로 내려야 하는 derivation을 분리한다.
3. certification provenance taxonomy와 natural matcher를 먼저 정리한다.
4. drinking-window step를 canonical required coverage에서 분리하거나 real contract로 교체한다.
5. approximate FX / longer-string merge를 authority-based contract로 바꾼다.
6. validate/build/operator guidance 문구를 actual pipeline과 맞춘다.
7. unit/regression/typecheck로 close한다.

## 작업 중단 조건

1. priceUsd canonicality를 유지하려면 product/benchmark 쪽에서 approximate price 허용 정책이 먼저 필요함
2. drinking-window를 canonical path에 유지하려면 real model artifact / serving contract가 먼저 필요함

## 롤백 기준

- provenance label만 바꾸고 canonical substrate behavior는 그대로 heuristic 의존
- experimental step이 여전히 canonical Track C required coverage를 차지
- `searchTextEn`/`priceUsd`가 계속 heuristic merge인데 provenance는 숨겨진 상태

## 금지사항

- regex/keyword match를 `llm_inferred`로 계속 표기하지 말 것
- heuristic stub를 `requiredCoverage: 1` canonical step으로 유지하지 말 것
- approximate field를 exact-like canonical signal처럼 소비하게 두지 말 것
- length-based text merge를 “데이터가 더 풍부하다”는 설명만으로 정당화하지 말 것

## 수용 예시

- 수용:
  - experimental derivation은 explicit provenance 또는 separate rail을 가진다
- 비수용:
  - regex inference가 그대로 `llm_inferred`이고 canonical index field까지 올라간다

## 테스트

- certification provenance taxonomy test
- naturalWine false-positive regression test
- Track C step taxonomy / validation guidance parity test
- `searchTextEn` merge authority test
- ETL typecheck rail

## 검증 명령

```bash
pnpm run typecheck:etl
pnpm vitest run test/unit/etl/vivino-to-silver.test.ts test/unit/etl/validate-silver.test.ts test/unit/etl/run-track-c.test.ts test/unit/etl/index-to-vespa.test.ts
```

## 머지 전 체크리스트

- [x] provenance label이 실제 derivation과 일치
- [x] heuristic step이 canonical required coverage를 점유하지 않음
- [x] approximate / length-based merge가 explicit contract를 가짐
- [x] validation guidance와 actual step numbering이 일치

## DoD

1. canonical ingestion artifact는 heuristic/experimental derivation을 provenance 없이 숨기지 않는다.
2. regex/keyword inference는 더 이상 `llm_inferred`로 표기되지 않는다.
3. drinking-window heuristic stub는 canonical required Track C path에서 분리되거나 대체된다.
4. `priceUsd` / `searchTextEn` merge policy가 authority-based contract를 가진다.

## 완료 조건

- silver -> Track C -> index runtime으로 넘어가는 canonical substrate가 provenance와 derivation 의미를 숨기지 않는다.
