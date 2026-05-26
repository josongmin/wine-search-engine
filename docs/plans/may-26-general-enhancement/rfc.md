# May 26 General Enhancement RFC

> 목적: `ROI 무관` 기준으로 검색 품질 ceiling을 만드는 구조 문제를 `데이터 substrate`, `ETL/publish`, `retrieval semantics`로 분해하고, 티켓 단위 실행 보드로 내린다.

---

## 1. 문제 정의

현재 검색 품질의 주 병목은 retrieval 알고리즘 단일 포인트가 아니라 아래 4개 축의 결합이다.

1. ETL contract와 runtime substrate contract가 일치하지 않는다.
2. `silver-trackc` artifact 이름과 실제 completeness truth가 다르다.
3. publish/runtime는 readiness 기준으로는 green일 수 있어도 quality 기준으로는 degraded publish가 가능하다.
4. retriever는 soft intent 일부를 알고도 retrieval-expressive path로 충분히 내리지 못한다.
5. canonical ingestion/retrieval path 안에 heuristic 또는 provenance-mislabelled logic가 남아 있다.

이번 RFC는 위 4개 축을 순서대로 닫는다.

---

## 2. 현재 근거

- live ETL typecheck는 아직 깨져 있다:
  - [scripts/etl/vivino-to-silver.ts](../../../scripts/etl/vivino-to-silver.ts#L1231)
  - [scripts/etl/types.ts](../../../scripts/etl/types.ts#L25)
- `transformRow()`는 `payload?.appellation?.name`을 읽지만 최종 silver에는 버린다:
  - read: [scripts/etl/vivino-to-silver.ts](../../../scripts/etl/vivino-to-silver.ts#L1228-L1233)
  - discard: [scripts/etl/vivino-to-silver.ts](../../../scripts/etl/vivino-to-silver.ts#L1357-L1359)
- silver quality gate는 quality-critical coverage를 강제하지만:
  - [scripts/etl/validate-silver.ts](../../../scripts/etl/validate-silver.ts#L188-L202)
  - 실제 local `data/silver-trackc.ndjson`는 `criticProxy=0%`, `drinkingWindow=0%`, `producerPrestige=0%`, `alcoholPct=34.9%`, `body mean=0.000`로 fail했다.
- Track C orchestrator는 step completeness를 강하게 요구한다:
  - [scripts/etl/run-track-c.ts](../../../scripts/etl/run-track-c.ts#L50-L99)
  - [scripts/etl/run-track-c.ts](../../../scripts/etl/run-track-c.ts#L223-L240)
- snapshot build는 suitability full coverage를 요구한다:
  - [scripts/etl/build-search-snapshot.ts](../../../scripts/etl/build-search-snapshot.ts#L237-L250)
- snapshot build는 benchmark coverage를 carry-forward로 메운다:
  - [scripts/etl/build-search-snapshot.ts](../../../scripts/etl/build-search-snapshot.ts#L260-L345)
- publish는 fail-closed guard가 있으나 degraded publish ack path를 허용한다:
  - partial indexing ack: [scripts/etl/index-to-vespa.ts](../../../scripts/etl/index-to-vespa.ts#L1343-L1367)
  - missing LTR ack: [scripts/etl/publish-search-snapshot.ts](../../../scripts/etl/publish-search-snapshot.ts#L1119-L1132)
- active runtime state는 `allowMissingLtr=true`, `activeLtrModels=0`를 허용한다:
  - schema: [scripts/etl/search-snapshot-schema.ts](../../../scripts/etl/search-snapshot-schema.ts#L85-L120)
- Track C step 2는 `LLM fallback` / `llm_inferred`를 표방하지만 실제 fallback 구현은 regex keyword match다:
  - comment/source taxonomy: [scripts/etl/enrich-certifications.ts](../../../scripts/etl/enrich-certifications.ts#L4-L7)
  - regex fallback + `llm_inferred`: [scripts/etl/enrich-certifications.ts](../../../scripts/etl/enrich-certifications.ts#L98-L123), [scripts/etl/enrich-certifications.ts](../../../scripts/etl/enrich-certifications.ts#L150-L166)
  - `naturalWine`는 bare `natural` token까지 매치한다: [scripts/etl/enrich-certifications.ts](../../../scripts/etl/enrich-certifications.ts#L120-L123)
- Track C canonical orchestrator 안에 heuristic step이 남아 있다:
  - step definition: [scripts/etl/run-track-c.ts](../../../scripts/etl/run-track-c.ts#L8-L13), [scripts/etl/run-track-c.ts](../../../scripts/etl/run-track-c.ts#L80-L85)
  - implementation: [scripts/etl/drinking-window-backfill.ts](../../../scripts/etl/drinking-window-backfill.ts#L6-L12), [scripts/etl/drinking-window-backfill.ts](../../../scripts/etl/drinking-window-backfill.ts#L90-L141)
  - `validate-silver` guidance는 아직 step number도 어긋난다: [scripts/etl/validate-silver.ts](../../../scripts/etl/validate-silver.ts#L198), [scripts/etl/validate-silver.ts](../../../scripts/etl/validate-silver.ts#L384-L389)
- silver ETL에는 retrieval/ranking substrate에 직접 영향을 주는 heuristic merge가 남아 있다:
  - approximate FX conversion: [scripts/etl/vivino-to-silver.ts](../../../scripts/etl/vivino-to-silver.ts#L795-L803)
  - longer-string-wins `searchTextEn` merge: [scripts/etl/vivino-to-silver.ts](../../../scripts/etl/vivino-to-silver.ts#L1404-L1415)
  - certification flags는 index 단계에서 runtime `certifications[]`로 바로 승격된다: [scripts/etl/index-to-vespa.ts](../../../scripts/etl/index-to-vespa.ts#L686-L696), [scripts/etl/index-to-vespa.ts](../../../scripts/etl/index-to-vespa.ts#L933-L934)
- retrieval는 known-but-not-promotable soft intent가 남아 있다:
  - [src/domain/retrieval/service/constraint-validator.ts](../../../src/domain/retrieval/service/constraint-validator.ts#L38-L47)
  - [src/domain/retrieval/service/candidate-pool.ts](../../../src/domain/retrieval/service/candidate-pool.ts#L265-L290)
- analyzer/planner tier SSOT도 아직 깨져 있다:
  - analyzer flatten: [src/application/wine-search/query-analyzer.ts](../../../src/application/wine-search/query-analyzer.ts#L573-L594)
  - router reclassify: [src/application/wine-search/deterministic-router.ts](../../../src/application/wine-search/deterministic-router.ts#L177-L203)
- retrieval policy 일부는 live heuristic priors다:
  - difficulty estimator: [src/domain/retrieval/service/query-difficulty-estimator.ts](../../../src/domain/retrieval/service/query-difficulty-estimator.ts#L1-L12), [src/domain/retrieval/service/candidate-pool.ts](../../../src/domain/retrieval/service/candidate-pool.ts#L220-L253)
  - per-class fusion priors: [src/domain/retrieval/service/per-class-fusion-config.ts](../../../src/domain/retrieval/service/per-class-fusion-config.ts#L1-L12), [src/application/search/search-usecase-post-route-phase.ts](../../../src/application/search/search-usecase-post-route-phase.ts#L591-L610)
  - query-family channel fallback map: [src/domain/retrieval/service/channel-mix-policy.ts](../../../src/domain/retrieval/service/channel-mix-policy.ts#L78-L168), [src/domain/retrieval/service/retrieval-profile.ts](../../../src/domain/retrieval/service/retrieval-profile.ts#L490-L508)
  - resolver best-effort alias inference + partial-resolution bypass: [src/application/search/search-usecase-resolver-candidates.ts](../../../src/application/search/search-usecase-resolver-candidates.ts#L243-L269), [src/application/search/search-usecase-resolver-candidates.ts](../../../src/application/search/search-usecase-resolver-candidates.ts#L503-L542)

---

## 3. 목표

1. bronze -> silver -> track-c -> snapshot -> index -> runtime의 data truth를 코드/artifact/test 셋에서 일치시킨다.
2. degraded publish를 readiness green과 분리해 quality gate에서 막는다.
3. retrieval가 `style`, `price_band`, `drinking_window`, `gift`, `beginner`, `occasion` 같은 intent를 ranking-only로 흘려보내지 않게 만든다.
4. analyzer/planner tier semantics를 단일 SSOT로 고정한다.
5. heuristic / experimental derivation은 canonical substrate에서 분리하거나 provenance를 정직하게 표기한다.

---

## 4. 비범위

- 새로운 외부 데이터 소스 추가
- 대규모 UI/HTTP surface redesign
- bench scorer 자체 리라이트
- LTR model training recipe 전면 교체

---

## 5. 원칙

1. heuristic fallback 추가 금지
2. unknown/corrupt 값을 empty/default/neutral로 위장 금지
3. partial artifact를 full artifact처럼 publish 금지
4. readiness green과 quality green을 혼동 금지
5. fixture/carry-forward는 benchmark continuity 용도로만 쓰고 current corpus completeness 부족 은폐에 쓰지 말 것
6. provenance label은 실제 derivation과 일치해야 한다. regex/keyword match를 `llm_inferred`로 표기하지 말 것
7. heuristic stub는 explicit experimental rail 밖으로 새지 않게 할 것

---

## 6. Wave 순서

### Wave 1

- `T-GE-01` Vivino payload / silver contract / `appellation`
- `T-GE-02` silver / Track C completeness truth
- `T-GE-03` text substrate / region normalization parity

### Wave 2

- `T-GE-06` ingestion heuristic purge / provenance truth

### Wave 3

- `T-GE-04` snapshot publish quality gates / LTR closure

### Wave 4

- `T-GE-05` retrieval semantics / analyzer-planner tier SSOT

### 순서 이유

1. retrieval를 먼저 고쳐도 substrate가 비어 있으면 ceiling이 그대로 남는다.
2. publish gate를 먼저 강화하면 current broken substrate를 live로 더 굳히지 않는다.
3. heuristic / provenance cleanup 없이 publish gate만 세우면 실험값이 canonical substrate로 남는다.
4. retrieval semantics는 data substrate와 provenance가 정리된 뒤에야 eval 값이 의미를 가진다.

---

## 7. 전역 DoD

아래 조건을 모두 만족해야 이번 RFC를 close할 수 있다.

1. `pnpm run typecheck:etl` green
2. `scripts/etl/validate-silver.ts --input <trackc-artifact>` green
3. `trackc` artifact 이름이 실제 completeness truth와 일치
4. runtime snapshot이 `allowMissingLtr=false`이고 `activeLtrModels > 0`
5. degraded publish path는 ops escape hatch로만 남고 기본 flow에서는 quality gate가 막음
6. retrieval soft intent 중 이번 RFC 범위 속성들이 `ranking-only`에 고정되지 않음
7. analyzer/planner tier가 flat reclassification에 의존하지 않음
8. canonical ingestion artifact는 heuristic/experimental field를 provenance 없이 숨기지 않음
9. provenance label이 실제 derivation과 다르지 않음

---

## 8. 전역 검증 명령

```bash
pnpm run typecheck:etl
pnpm vitest run test/unit/etl/vivino-to-silver.test.ts test/unit/etl/validate-silver.test.ts test/unit/etl/build-search-snapshot.test.ts test/unit/etl/index-to-vespa.test.ts test/unit/etl/publish-runtime-substrates.test.ts test/unit/etl/publish-search-snapshot.test.ts test/unit/etl/snapshot-entity-identity.test.ts
pnpm vitest run test/regression/bronze-data-connector.regression.test.ts test/regression/bronze-data-connector-properties.regression.test.ts test/regression/silver-validation.regression.test.ts test/regression/silver-validation-properties.regression.test.ts test/regression/etl-snapshot-record-purity.regression.test.ts test/regression/gold-catalog-coverage-properties.regression.test.ts test/regression/wave4-etl-fail-loud.regression.test.ts
pnpm vitest run test/unit/domain/retrieval/candidate-pool-sparse-filters.test.ts test/unit/domain/retrieval/constraint-to-sparse-filter-tokens.test.ts test/unit/domain/retrieval/candidate-constraint-evidence.test.ts test/unit/domain/retrieval/browse-retriever.test.ts test/unit/domain/retrieval/compare-retriever.test.ts test/unit/application/search/search-tool-retrieval-core.test.ts
pnpm vitest run test/regression/retrieval-plan-builder-properties.regression.test.ts test/regression/retrieval-soft-to-hard-promotion.regression.test.ts test/regression/c1b-soft-attr-retrieval-propagation.regression.test.ts test/regression/comparison-retrieval-properties.regression.test.ts test/regression/retrieval-critic-properties.regression.test.ts test/regression/retrieval-critic-decision.regression.test.ts test/regression/multi-query-retrieval-fanout.regression.test.ts
pnpm exec tsx scripts/etl/validate-silver.ts --input data/silver-trackc.ndjson
pnpm exec tsx scripts/etl/verify-search-snapshot-readiness.ts --runtime-state /Users/songmin/.wine-search-engine/data/runtime-search-snapshot.json --require-pointer-parity
```

---

## 9. 티켓 목록

- [tickets/README.md](./tickets/README.md)
- [T-GE-01 Vivino Payload Appellation And Silver Contract Closure](./tickets/T-GE-01-vivino-payload-appellation-and-silver-contract-closure.md)
- [T-GE-02 Silver Track-C Completeness And Artifact Truth](./tickets/T-GE-02-silver-trackc-completeness-and-artifact-truth.md)
- [T-GE-03 Search Text And Region Normalization Parity](./tickets/T-GE-03-search-text-and-region-normalization-parity.md)
- [T-GE-06 Ingestion Heuristic Purge And Provenance Truth](./tickets/T-GE-06-ingestion-heuristic-purge-and-provenance-truth.md)
- [T-GE-04 Snapshot Publish Quality Gates And LTR Closure](./tickets/T-GE-04-snapshot-publish-quality-gates-and-ltr-closure.md)
- [T-GE-05 Retrieval Constraint Semantics And Tier SSOT](./tickets/T-GE-05-retrieval-constraint-semantics-and-tier-ssot.md)
