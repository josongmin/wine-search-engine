# ADR-007: Canonical Entity Identity Cutover

## Status: Accepted — in progress

Engine repo as of this ADR revision:

- **Phase 1 (partial):** `009_canonical_entity_graph.sql` plus `scripts/etl/canonical-entity-graph-sync.ts` populate and exact-reconcile `canonical_entities` / links / canonical aliases / canonical ambiguity from the active search snapshot.
- **Phase 2 (partial):** `scripts/etl/build-search-snapshot.ts` resolves snapshot `entityId` via `snapshot-entity-identity.ts` (fixture gold overlay + deterministic `wine-ce-{identitySignature}` fallback — not raw `sourceId`); `source_record_refs` carries Vivino lineage separately.
- **Phase 0 (partial):** `entity-id.ts` brands `CanonicalEntityId` / `SourceRecordId` / `DocumentId`; `scripts/etl/types.ts` now types Silver `sourceId` as `SourceRecordId` and indexable `entityId` as `CanonicalEntityId`; Vivino silver ETL wraps `sourceId` with `createSourceRecordId`; PG/Vespa/HTTP ingress paths that hydrate public ids use `createCanonicalEntityId` (fail-loud on `vivino-`). Full call-site migration across `src/` is not finished.
- **Phase 3 (open):** Runtime `entities.entity_id` canonical reload and full HTTP surface audit remain.

## Context

ADR-005와 ADR-006으로 benchmark runner SSOT와 search snapshot publish contract는
상당 부분 정리됐다.

하지만 최종 live benchmark RCA 결과, exact retrieval의 실제 병목은 benchmark runner나
snapshot readiness가 아니라 **entity identity plane mismatch**였다.

실제로 확인된 상태:

- fixture benchmark truth는 canonical slug ID를 기대한다
  - 예: `opus-one-2018`, `chateau-margaux-2015`, `moet-brut-nv`
- runtime `entities.entity_id`는 source record ID 계열이다
  - 예: `vivino-36f895cf2938f29b`
- `build-search-snapshot.ts`는 `record.sourceId`를 그대로 snapshot `entityId`로 사용한다
- `build-alias-artifact.ts`도 같은 `record.sourceId`를 alias `entityId`로 사용한다
- live benchmark preflight는 fixture canonical ID가 runtime `entities.entity_id`에 실제
  존재하는지 검사하며, 현재 여기서 fail-closed 된다
- 단순 ID mismatch만이 아니라, active runtime corpus가 fixture gold catalog의 핵심
  canonical entity를 충분히 포함하지 않는 경우도 확인됐다

즉 현재 엔진은 세 가지를 같은 것으로 취급하고 있다.

1. source record identity
2. runtime/public entity identity
3. benchmark/eval canonical entity identity

이 세 가지를 하나로 취급하면 exact recovery는 구조적으로 닫히지 않는다.

RFC-000과 RFC-001은 이미 retrieval index를 identity graph의 projection으로 정의하고
있다. 현재 구현은 이 원칙을 ETL/search snapshot/runtime wiring에서 어긴 상태다.

## Decision

엔진은 **canonical entity identity cutover**를 수행한다.

앞으로 identity plane은 아래 세 층으로 분리한다.

1. `source_record_id`
   - source system row identity
   - 예: `vivino-...`
   - lineage / ingestion / provenance 전용

2. `canonical_entity_id`
   - runtime / API / eval / benchmark / Vespa projection의 유일한 entity identity
   - 예: `opus-one-2018`

3. `document_id`
   - indexing / projection / storage 시스템의 내부 문서 식별자
   - 필요할 때만 사용
   - public entity identity를 대체할 수 없음

이 ADR 이후 `entity_id`는 의미상 항상 `canonical_entity_id`다.

`source_record_id`는 절대 runtime/public/eval contract에 직접 노출하지 않는다.

## Why this is the critical path

현재 exact recovery 관련 최근 작업은 다음을 많이 닫았다.

- fixture-native benchmark SSOT
- snapshot build / publish / readiness
- snapshot-bound LTR
- fail-closed runtime substrate verification

하지만 위 substrate가 모두 green이어도 `entity_id` namespace가 맞지 않으면
exact entity recovery benchmark는 영원히 다른 우주를 보게 된다.

따라서 `TRACK-A A1 Canonical Entity Graph / Truth Source`는 late-wave가 아니라
즉시 critical path다.

## Non-negotiable Rules

### 1. `entity_id` means canonical identity

다음 surface에서 `entity_id`는 항상 canonical entity ID여야 한다.

- search / resolve / agent HTTP responses
- resolver candidates / resolve result
- ranked results
- Vespa retrieval documents
- aliases / ambiguity registry runtime tables
- LTR training and activation metadata
- offline eval / replay / benchmark reports

### 2. `source_record_id` never escapes as public truth

`source_record_id`는 허용된다.

- lineage tables
- ETL intermediate artifacts
- ingestion audit logs
- source-link tables

`source_record_id`는 금지된다.

- HTTP response `entity_id`
- benchmark `expected_entity_id`
- runtime `entities.entity_id`
- alias graph primary identity
- ambiguity registry entity refs

`canonical_entities` / `entity_source_links` / `canonical_aliases` / `canonical_ambiguity_registry`는 snapshot-bound exact reconcile 대상이다. stale row가 남으면 publish/readiness가 실패해야 한다.

### 3. fixture gold catalog is a contract oracle, not the production truth source

fixture gold catalog는 production canonical graph를 직접 대체하지 않는다.

하지만 아래는 반드시 만족해야 한다.

- fixture gold catalog와 production canonical graph는 같은 canonical ID namespace를 사용한다
- active search snapshot은 benchmark-required canonical entity를 포함해야 한다
- fixture와 production graph의 drift는 publish 전에 검출되어야 한다

### 4. adapter translation is forbidden

금지:

- benchmark runner가 fixture canonical ID를 `vivino-*`로 런타임 변환
- response adapter가 runtime `vivino-*`를 benchmark slug로 가짜 매핑
- label string matching으로 identity mismatch를 덮기

이런 adapter는 dual truth를 만든다.

## Target Architecture

```mermaid
graph TD
  SR["Source Record Layer"]
  SL["source_record_id"]
  CG["Canonical Entity Graph"]
  CE["canonical_entity_id"]
  SS["Search Snapshot"]
  VP["Vespa / Runtime Projection"]
  API["HTTP / Agent / Eval / Benchmark"]

  SR --> SL
  SL --> CG
  CG --> CE
  CE --> SS
  SS --> VP
  VP --> API
```

핵심 원칙:

- source system은 canonical graph를 입력으로만 제공한다
- canonical graph만이 runtime entity truth를 발급한다
- search snapshot은 canonical graph의 projection이다
- benchmark와 API는 같은 canonical ID vocabulary를 본다

## Required Data Model

### 1. `canonical_entities`

필수 필드:

- `canonical_entity_id`
- `entity_type`
- `canonical_label`
- `identity_signature`
- `producer_ref`
- `region_ref`
- `vintage`
- `attributes`
- `approval_state`
- `source_provenance`
- `last_reviewed_at`

### 2. `entity_source_links`

필수 필드:

- `canonical_entity_id`
- `source_system`
- `source_record_id`
- `link_kind`
- `confidence`
- `approved`
- `linked_at`

### 3. `canonical_aliases`

필수 필드:

- `alias_id`
- `canonical_entity_id`
- `surface_form`
- `normalized_surface`
- `alias_type`
- `scope`
- `approval_state`
- `source`
- `source_trust`

### 4. `canonical_ambiguity_registry`

필수 필드:

- `registry_id`
- `normalized_form`
- `canonical_entity_ids`
- `ambiguity_types`
- `severity`
- `approval_state`

## Breaking Changes

### 1. HTTP contract

breaking:

- `entity_id` in `/v1/search`, `/v1/entity/resolve`, `/v1/agent` related payloads becomes canonical ID
- any client that assumes `entity_id` is a source-row ID will break

required compatibility path:

- if lineage/debug needs the old ID, expose it separately as `source_record_refs`
- do not overload `entity_id`

### 2. Runtime storage contract

breaking:

- `entities.entity_id` becomes canonical ID
- `aliases.entity_id` becomes canonical ID
- `ambiguity_registry.entity_ids` becomes canonical ID array
- `entity_snapshots.entity_id` becomes canonical ID

### 3. ETL contract

breaking:

- `SilverWineRecord.sourceId` is no longer allowed to flow into snapshot/runtime identity fields
- `build-search-snapshot.ts` must read canonical graph projection, not raw silver identity

### 4. Benchmark / eval contract

breaking:

- offline eval, replay, fixture-native benchmarks, LTR labels, and relevance labels must all use canonical ID
- source-linked corpora that still emit `vivino-*` need migration or explicit lineage mapping

## Migration Plan

### Phase 0. Identity Type Split

도입:

- `CanonicalEntityId`
- `SourceRecordId`
- `DocumentId`

규칙:

- branded type를 분리해 상호 대입 금지
- `EntityId`는 deprecate하고 최종적으로 `CanonicalEntityId`로 수렴

acceptance:

- runtime path에서 `SourceRecordId`가 `entity_id` 위치로 들어가면 compile error 또는 test fail

#### Concrete implementation tasks

작업 파일:

- `src/domain/shared/types/entity-id.ts`
- `src/domain/shared/types/index.ts`
- `scripts/etl/types.ts`
- `src/domain/retrieval/model/retrieval-document.ts`
- `src/domain/response/model/result-item.ts`
- `src/domain/resolver/model/resolved-candidate.ts`
- `src/domain/decision/model/decision-output.ts`

작업 내용:

1. `EntityId` 단일 brand를 아래로 분리한다
   - `CanonicalEntityId`
   - `SourceRecordId`
   - `DocumentId`
2. 기존 `createEntityId()` 호출부를 전수 스캔한다
3. runtime/public/eval path는 `CanonicalEntityId`만 허용한다
4. ETL bronze/silver path는 `SourceRecordId`를 유지한다

DB 영향:

- 없음

검증:

- `rg -n "createEntityId\\(|type EntityId|EntityId"`로 호출부 전수 점검
- typecheck에서 `SourceRecordId -> CanonicalEntityId` 대입이 깨져야 정상

### Phase 1. Canonical Graph Foundation

구현:

- `canonical_entities`
- `entity_source_links`
- `canonical_aliases`
- `canonical_ambiguity_registry`

데이터 유입:

- Vivino source records
- existing alias proposals
- curated benchmark gold catalog overlay
- manual review/approval workflow

acceptance:

- benchmark-required canonical entities가 canonical graph에 존재
- source record는 canonical entity로 명시 링크됨

#### Concrete implementation tasks

DB 대상:

- local Postgres: `postgresql://wine:wine_dev@localhost:5432/wine_engine`
- migration 위치:
  - `src/infrastructure/db/migrations/`

추가할 테이블:

1. `canonical_entities`
2. `entity_source_links`
3. `canonical_aliases`
4. `canonical_ambiguity_registry`

추천 migration 파일:

- `009_canonical_entity_graph.sql`

예상 컬럼:

`canonical_entities`
- `canonical_entity_id text primary key`
- `entity_type text not null`
- `canonical_label text not null`
- `identity_signature text not null`
- `producer_ref text null`
- `region_ref text null`
- `vintage integer null`
- `attributes jsonb not null`
- `approval_state text not null`
- `source_provenance jsonb not null`
- `last_reviewed_at timestamptz null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

`entity_source_links`
- `canonical_entity_id text not null`
- `source_system text not null`
- `source_record_id text not null`
- `link_kind text not null`
- `confidence double precision not null`
- `approved boolean not null`
- `linked_at timestamptz not null`
- unique key: `(source_system, source_record_id)`

`canonical_aliases`
- `alias_id text primary key`
- `canonical_entity_id text not null`
- `surface_form text not null`
- `normalized_surface text not null`
- `alias_type text not null`
- `scope text not null`
- `approval_state text not null`
- `source text not null`
- `source_trust double precision not null`

`canonical_ambiguity_registry`
- `registry_id text primary key`
- `normalized_form text not null`
- `canonical_entity_ids jsonb not null`
- `ambiguity_types jsonb not null`
- `severity text not null`
- `approval_state text not null`

작업 파일:

- `src/infrastructure/db/migrations/009_canonical_entity_graph.sql`
- `src/infrastructure/db/migrate.ts` (`runMigrations`), `scripts/migrate-local-docker-pg.ts`, `scripts/migrate-from-env.ts`
- `src/infrastructure/adapter/` 아래 canonical graph adapter 신설
- `scripts/etl/` 아래 canonical graph build/publish 스크립트 신설

입력 소스:

- canonical ETL artifacts
  - `data/silver.ndjson`
  - `data/silver-aliases.ndjson`
  - `data/silver-ko.ndjson`
  - `data/silver-docquery.ndjson`
  - `data/silver-trackc.ndjson`
- external fixture goldens
  - `/Users/songmin/Documents/code-wine/wine-engine-fixture/goldens/canonical-entities.json`
  - `/Users/songmin/Documents/code-wine/wine-engine-fixture/goldens/target-entity-map.json`

핵심 규칙:

1. fixture goldens는 production canonical truth를 직접 덮어쓰지 않는다
2. fixture canonical entity는 production canonical graph에 매핑/검증되는 contract oracle로 사용한다
3. source row 하나가 여러 canonical entity로 분기되면 review-required 상태로 남긴다

검증:

- SQL
  - `select count(*) from canonical_entities;`
  - `select count(*) from entity_source_links;`
  - `select count(*) from canonical_aliases;`
  - `select count(*) from canonical_ambiguity_registry;`
- fixture gold catalog entity가 `canonical_entities.canonical_entity_id`에 존재해야 함

### Phase 2. Search Snapshot Cutover

구현:

- `build-search-snapshot.ts` 입력을 canonical graph projection으로 교체
- snapshot `entities.ndjson`, `aliases.ndjson`, `ambiguity-registry.ndjson` 모두 canonical ID 사용
- Vespa document `entity_id`도 canonical ID 사용

acceptance:

- active snapshot manifest의 `entity_id` namespace가 fixture gold catalog와 동일
- `record.sourceId -> entityId` 경로 제거

#### Concrete implementation tasks

핵심 파일:

- `scripts/etl/build-search-snapshot.ts`
- `scripts/etl/build-alias-artifact.ts`
- `scripts/etl/build-ambiguity-registry.ts`
- `scripts/etl/publish-runtime-substrates.ts`
- `scripts/etl/publish-search-snapshot.ts`
- `scripts/etl/search-snapshot-schema.ts`
- `scripts/etl/index-to-vespa.ts`
- `src/infrastructure/vespa/mapping.ts`
- `src/domain/retrieval/model/retrieval-document.ts`

반드시 제거할 경로:

- `build-search-snapshot.ts`의 `entityId: record.sourceId`
- `build-alias-artifact.ts`의 `const entityId = record.sourceId`

새 입력 모델:

1. `canonical_entities`를 읽어 `entities.ndjson` 생성
2. `canonical_aliases`를 읽어 `aliases.ndjson` 생성
3. `canonical_ambiguity_registry`를 읽어 `ambiguity-registry.ndjson` 생성
4. source lineage는 `metadata` 또는 별도 `source_record_refs` artifact로 분리

Vespa 영향:

- schema: `vespa/app/schemas/wine_entity.sd`
- field `entity_id`는 canonical ID
- source lineage가 필요하면 새 필드 추가:
  - `source_record_refs`
  - 단 `entity_id` 대체 금지

runtime state 영향:

- `~/.wine-search-engine/data/runtime-search-snapshot.json`
- active snapshot manifest 안의 count/hash는 canonical artifact 기준으로 재계산

검증:

- snapshot artifact `entities.ndjson`에서 `entityId`가 `vivino-` prefix면 fail
- `aliases.ndjson` / `ambiguity-registry.ndjson`도 canonical ID 참조만 허용
- `pnpm run etl:publish-search-snapshot` 후 active snapshot manifest의 entity namespace 검사

### Phase 3. Runtime / API / Resolver Rebinding

구현:

- resolver candidates
- resolve result
- ranked results
- response builder
- agent tools
- watchlist / feedback / evaluation interfaces

전부 canonical ID 사용으로 재바인딩

acceptance:

- `/v1/search` / `/v1/entity/resolve` / `/v1/agent` 어디에서도 `vivino-*`가 `entity_id`로 노출되지 않음

#### Concrete implementation tasks

핵심 파일:

- `src/application/search/resolve.usecase.ts`
- `src/application/search/search-usecase-resolver-candidates.ts`
- `src/application/search/search-usecase-ranked-route-resolve.ts`
- `src/domain/resolver/service/resolver.ts`
- `src/domain/ranking/model/ranked-result.ts`
- `src/domain/response/service/response-builder.ts`
- `src/interface/http/schemas/search-response.schema.ts`
- `src/interface/http/routes/search.route.ts`
- `src/interface/http/routes/internal-benchmark.route.ts`
- `src/application/agent/agent-tools.ts`
- `src/application/agent/agent-prompt.ts`

DB 대상:

- `entities`
- `entity_snapshots`
- `aliases`
- `ambiguity_registry`
- `watchlist_entries` 같은 entity foreign key 보유 테이블 전수 점검

작업 순서:

1. runtime DB `entities.entity_id`를 canonical ID로 재적재
2. resolver candidate hydrate가 canonical ID를 들고 오게 수정
3. ranked result / top entity / result item 모두 canonical ID로 전파
4. response builder가 canonical ID만 노출하게 고정
5. agent tools prompt/examples에서 `vivino-*` 예시 제거

주의:

- source lineage가 필요하면 `metadata.source_record_refs` 또는 debug trace로만 노출
- `entity_id` 필드는 canonical 외 금지

검증:

- integration/e2e response fixture에서 `entity_id`에 `vivino-` prefix가 있으면 fail
- `/v1/search`, `/v1/entity/resolve`, `/v1/agent` snapshot responses grep

### Phase 4. Eval / LTR / Benchmark Alignment

구현:

- fixture runner preflight remains strict
- offline eval truth, replay truth, silver labels, triplets, LTR activation all canonical-ID only
- `ltr_model_registry.search_snapshot_id`와 canonical entity namespace consistency 검증

acceptance:

- live benchmark preflight가 더 이상 namespace mismatch로 fail하지 않음
- benchmark report / eval report / replay report가 같은 ID vocabulary를 씀

#### Concrete implementation tasks

핵심 파일:

- `scripts/eval/live-benchmark-preflight.ts`
- `scripts/eval/external-fixture-benchmark.ts`
- `scripts/eval/run-entity-retrieval-fixture-eval.ts`
- `scripts/eval/run-noisy-entity-eval.ts`
- `scripts/eval/run-offline-eval.ts`
- `scripts/eval/build-splits.ts`
- `scripts/ltr/generate-triplets.ts`
- `scripts/ltr/validate-embedding.ts`
- `scripts/eval/run-eval-and-train-ltr.ts`
- `src/infrastructure/adapter/pg-ltr-model-registry.ts`

DB 대상:

- `ltr_model_registry`
- future `canonical_entities` / `entity_source_links`

작업 순서:

1. benchmark preflight는 그대로 strict 유지
2. offline eval truth의 `expected_entity_id`를 canonical ID로 정규화
3. silver labels / triplets / relevance judgments를 canonical ID 기준으로 재생성
4. LTR training metadata가 canonical entity namespace를 기준으로만 평가되게 수정

주의:

- 여기서 preflight 완화 금지
- namespace mismatch를 adapter로 덮지 말 것

검증:

- `run-entity-retrieval-fixture-eval.ts` live preflight 통과
- replay/offline eval outputs에서 `expected_entity_id`, `top_entity_id`, ranked hits가 같은 namespace 사용

### Phase 5. Legacy Purge

제거:

- runtime/public path에서 `vivino-*` identity assumptions
- benchmark adapter translation hacks
- source ID 기반 exact-match tooling

남김:

- lineage/audit/source trace only

#### Concrete implementation tasks

제거 대상:

- runtime/public path의 `vivino-*` 예시
- source ID 기반 benchmark helper
- old ETL comments claiming `sourceId` is runtime entity identity
- agent prompt/examples with `vivino-*`

핵심 파일:

- `src/application/agent/agent-prompt.ts`
- `scripts/etl/vivino-to-silver.ts`
- `scripts/etl/types.ts`
- `docs/adr/006-search-snapshot-publish-architecture.md`
- `docs/rfc/rfc-apr-11-enhancing-engine/TRACK-A-exact-entity-recovery-roadmap.md`
- `docs/rfc/rfc-apr-11-enhancing-engine/TASK-DAG.md`

검증:

- `rg -n "vivino-" src scripts docs test` 결과가 lineage/debug/fixtures 외에는 없어야 함

## Gold Catalog Coverage Contract

이번 사고를 막기 위해 다음 gate를 추가한다.

### 1. publish-time coverage gate

`publish-search-snapshot`는 active snapshot이 fixture gold catalog required entity를 모두
포함하는지 확인해야 한다.

실패 조건:

- gold catalog required canonical entity missing
- canonical label mismatch above approved tolerance
- duplicate canonical entity mapping

#### Concrete implementation tasks

핵심 파일:

- `scripts/etl/publish-search-snapshot.ts`
- `scripts/etl/verify-search-snapshot-readiness.ts`
- 새 파일 권장:
  - `scripts/etl/verify-gold-catalog-coverage.ts`

입력:

- active snapshot manifest
- active runtime tables
- `/Users/songmin/Documents/code-wine/wine-engine-fixture/goldens/canonical-entities.json`
- `/Users/songmin/Documents/code-wine/wine-engine-fixture/goldens/target-entity-map.json`

검사 항목:

1. required canonical IDs exist in `canonical_entities`
2. same IDs exist in active snapshot entity artifact
3. same IDs exist in runtime `entities`
4. canonical label drift report 생성

규칙:

- missing entity 하나라도 있으면 publish fail
- allowlist 없는 fuzzy label tolerance 금지

### 2. namespace seal gate

다음 artifact에 `vivino-*`가 `entity_id`로 남아 있으면 publish 실패:

- `entities.ndjson`
- `aliases.ndjson`
- `ambiguity-registry.ndjson`
- runtime `entities`
- Vespa `entity_id`
- search/resolve response snapshots

#### Concrete implementation tasks

핵심 파일:

- `scripts/etl/verify-search-snapshot-readiness.ts`
- `test/integration/http/`
- `test/e2e/`

검사 방식:

1. snapshot artifact NDJSON scan
2. runtime DB row scan
3. HTTP golden response scan

추천 명령:

- artifact scan:
  - `rg -n '\"entityId\":\\s*\"vivino-' ~/.wine-search-engine/data/search-snapshots`
- runtime SQL:
  - `select count(*) from entities where entity_id like 'vivino-%';`
- response snapshot scan:
  - integration/e2e fixture outputs grep

### 3. benchmark preflight remains fail-closed

runner preflight는 그대로 유지한다.
단, 이 검사는 마지막 방어선이지 첫 검사가 아니다.

## Rules to Prevent Recurrence

### Rule 1. Identity before quality

identity plane이 닫히지 않은 상태에서는:

- retrieval quality uplift
- rerank safety uplift
- audit completeness uplift

를 release-complete로 간주하지 않는다.

### Rule 2. No new release gate may introduce a second entity namespace

새 runner, eval, fixture, replay, or API contract는 canonical ID 외 다른 entity namespace를
release truth로 사용하면 안 된다.

### Rule 3. Snapshot publish must prove benchmark coverage

publish success = runtime readiness + benchmark gold coverage

둘 중 하나라도 빠지면 partial success로 간주한다.

### Rule 4. Type boundary enforcement

다음은 반드시 분리 타입을 써야 한다.

- `CanonicalEntityId`
- `SourceRecordId`
- `DocumentId`

단일 `EntityId` string brand로 모두 처리하는 관행을 끝낸다.

### Rule 5. CI contract scans

CI에 다음 검사를 추가한다.

- runtime artifacts contain only canonical IDs in `entity_id`
- fixture gold catalog IDs all resolve in active snapshot
- response fixtures do not emit source-record IDs
- alias / ambiguity rows do not reference unknown canonical IDs

#### Concrete implementation tasks

CI에 추가할 명령:

1. `pnpm run typecheck`
2. `pnpm run migrate` (로컬 기본: `docker-compose.yml` Postgres — 관리형 DB면 `pnpm run migrate:from-env`)
3. `pnpm run etl:publish-search-snapshot`
4. `npx tsx scripts/etl/verify-search-snapshot-readiness.ts --strict`
5. `npx tsx scripts/etl/verify-gold-catalog-coverage.ts`
6. `npx vitest run --config config/vitest/integration.config.ts`
7. `npx vitest run --config config/vitest/e2e.config.ts`

실패해야 정상인 조건:

- runtime `entity_id`에 source ID가 남아 있음
- fixture required canonical ID가 snapshot에 없음
- response contract에서 `entity_id`가 source ID임
- alias / ambiguity가 unknown canonical entity를 참조함

## File / DB Ownership Map

### Identity graph / migration

- DB migrations:
  - `src/infrastructure/db/migrations/009_canonical_entity_graph.sql`
  - 이후 follow-up migrations under same folder
- DB migrate runners (SQL은 `src/infrastructure/db/migrations/`):
  - `pnpm run migrate` → `scripts/migrate-local-docker-pg.ts` (Compose Postgres)
  - `pnpm run migrate:from-env` → `scripts/migrate-from-env.ts` (`.env` / `DATABASE_URL`)
  - 러너: `src/infrastructure/db/migrate.ts` (`runMigrations`)

### ETL / snapshot

- `scripts/etl/vivino-to-silver.ts`
- `scripts/etl/types.ts`
- `scripts/etl/build-search-snapshot.ts`
- `scripts/etl/build-alias-artifact.ts`
- `scripts/etl/build-ambiguity-registry.ts`
- `scripts/etl/publish-runtime-substrates.ts`
- `scripts/etl/publish-search-snapshot.ts`
- `scripts/etl/verify-search-snapshot-readiness.ts`
- `scripts/etl/verify-gold-catalog-coverage.ts` (new)

### Runtime / projection

- `src/infrastructure/vespa/mapping.ts`
- `scripts/etl/index-to-vespa.ts`
- `vespa/app/schemas/wine_entity.sd`
- `src/domain/retrieval/model/retrieval-document.ts`
- `src/domain/response/service/response-builder.ts`
- `src/interface/http/schemas/search-response.schema.ts`

### Resolver / ranking / API

- `src/application/search/resolve.usecase.ts`
- `src/application/search/search-usecase-resolver-candidates.ts`
- `src/application/search/search-usecase-ranked-route-resolve.ts`
- `src/domain/resolver/service/resolver.ts`
- `src/domain/ranking/model/ranked-result.ts`
- `src/interface/http/routes/search.route.ts`
- `src/interface/http/routes/internal-benchmark.route.ts`
- `src/application/agent/agent-tools.ts`

### Eval / benchmark / LTR

- `scripts/eval/live-benchmark-preflight.ts`
- `scripts/eval/external-fixture-benchmark.ts`
- `scripts/eval/run-entity-retrieval-fixture-eval.ts`
- `scripts/eval/run-noisy-entity-eval.ts`
- `scripts/eval/run-offline-eval.ts`
- `scripts/eval/build-splits.ts`
- `scripts/ltr/generate-triplets.ts`
- `scripts/eval/run-eval-and-train-ltr.ts`
- `src/infrastructure/adapter/pg-ltr-model-registry.ts`

### External truth source

- fixture repo root:
  - `/Users/songmin/Documents/code-wine/wine-engine-fixture`
- required files:
  - `/Users/songmin/Documents/code-wine/wine-engine-fixture/goldens/canonical-entities.json`
  - `/Users/songmin/Documents/code-wine/wine-engine-fixture/goldens/target-entity-map.json`

## Execution Order Summary

1. `Phase 0` type split
2. `Phase 1` canonical graph tables + source links + canonical aliases/ambiguity
3. `Phase 2` snapshot builder cutover
4. `Phase 3` runtime/API/resolver cutover
5. `Phase 4` eval/LTR/benchmark cutover
6. `Phase 5` legacy purge
7. publish-time gold catalog coverage gate mandatory
8. CI namespace seal mandatory

## Consequences

### Positive

- exact retrieval, resolve, benchmark, replay, LTR가 같은 world model 위에서 동작한다
- live benchmark와 smoke benchmark가 다른 namespace 때문에 엇갈리는 일이 줄어든다
- source lineage와 runtime identity가 분리돼 audit/debug가 더 명확해진다

### Negative

- 브레이킹 체인지다
- ETL, runtime DB, Vespa schema, API, eval corpus, LTR까지 전부 영향받는다
- 단기적으로 migration cost가 크다

## Acceptance Criteria

이 ADR이 닫혔다고 보려면 아래가 전부 참이어야 한다.

1. active snapshot `entity_id` namespace == fixture gold catalog namespace
2. runtime `entities.entity_id` is canonical, not source-derived
3. `build-search-snapshot.ts` no longer assigns `entityId = record.sourceId`
4. `/v1/search`, `/v1/entity/resolve`, `/v1/agent` responses expose canonical IDs only
5. live benchmark preflight passes entity compatibility without adapter translation
6. source record lineage remains queryable through explicit source-link surfaces

## Appendix: Cutover runbook (operational)

이 절차는 코드 머지가 끝난 뒤 실제 운영 환경에 ADR-007 컷오버를 적용하기 위한 단계다.
모든 단계는 fail-closed로 설계돼 있어 중간에 실패하면 그 단계에서 멈추고 다음으로 넘어가지 않는다.

### 0. Preconditions

- `FIXTURE_REPO_PATH` (또는 sibling `wine-engine-fixture/`)가 존재하고 다음 두 파일이 있어야 한다:
  - `goldens/canonical-entities.json`
  - `goldens/target-entity-map.json`
- `DATABASE_URL`이 운영 PG를 가리키고 ADR-007 마이그레이션(`009_canonical_entity_graph.sql`)이 적용 가능한 상태여야 한다.
- Vespa endpoint(`config.vespa.url`)가 도달 가능해야 한다.

### 1. Apply migrations

```sh
pnpm run migrate
```

`canonical_entities` / `canonical_aliases` / `canonical_ambiguity_registry` / `canonical_entity_source_links`가
존재해야 다음 단계가 동작한다.

### 2. Build & publish search snapshot

```sh
pnpm run etl:publish-search-snapshot -- --fixture-repo "$FIXTURE_REPO_PATH"
```

이 한 줄이 다음을 모두 수행한다 (각 단계 fail-closed):

1. snapshot artifact build (fixture gold overlay 적용 — `vivino-` 절대 안 들어감)
2. snapshot-bound LTR 준비
3. Vespa 색인 (이전 snapshot의 stale 문서 정리 포함)
4. PG 런타임 substrate publish (entities/aliases/ambiguity_registry)
5. **readiness verify** — 다음을 모두 강제:
   - PG count/hash mismatch
   - canonical graph entity/alias/ambiguity projection mismatch
   - **namespace seal**: `entities`, `canonical_entities`, `aliases`, `ambiguity_registry`, `canonical_ambiguity_registry`, **Vespa documents** 어디에도 `vivino-*` 없음
6. **runtime gold catalog coverage** — fixture `target-entity-map.json`의 non-null target이 모두 활성 snapshot의 `entities` + `canonical_entities`에 존재
7. staged runtime state 파일 promote

여기까지 한 번에 통과하지 못하면 promote가 일어나지 않고 이전 snapshot이 그대로 유지된다.

### 3. Audit (independent verification)

publish가 끝난 뒤 운영 채널에서 한 번 더 직접 확인:

```sh
psql "$DATABASE_URL" -f scripts/ops/t3-runtime-namespace-audit.sql
```

기대 결과 — 다음 다섯 카운트는 모두 0:

- `entities_vivino_prefix`
- `canonical_entities_vivino_prefix`
- `aliases_vivino_prefix`
- `ambiguity_registry_vivino_prefix`
- `canonical_ambiguity_vivino_prefix`

그리고 다음 세 카운트는 0보다 커야 한다:

- `canonical_entities_rows`
- `canonical_aliases_rows`
- `canonical_ambiguity_registry_rows`

### 4. Verify readiness explicitly (out-of-band)

publish가 promote까지 갔지만 외부 검증이 필요할 때:

```sh
npx tsx scripts/etl/verify-search-snapshot-readiness.ts
```

`search_snapshot_readiness=passed`가 출력되면 OK.

### 5. Re-enable live benchmark

```sh
pnpm run eval:entity:fixtures:live
pnpm run eval:noisy
pnpm run eval:search-feature:fixtures:live
```

각 러너의 preflight는 fixture canonical id가 active snapshot에 존재하는지 다시 확인한다.
한 줄이라도 실패하면 cutover가 부분적으로 적용된 것이며, 코드를 되돌리지 말고 readiness/audit으로
원인을 좁혀라.

### Rollback

`publish-search-snapshot`은 verify 실패 시 자동으로 이전 snapshot으로 rollback한다 (Vespa 재색인 + 런타임 substrate 재publish + readiness 재확인). 수동 rollback이 필요한 상황은 보통:

- migration 자체가 깨졌거나
- fixture가 잘못 갱신돼 모든 snapshot이 cutover gate에서 막힐 때

이 두 경우는 fixture를 먼저 고치고 step 2부터 다시 실행한다. 운영 DB를 손으로 건드리지 마라.

### Do NOT

- fixture canonical id를 runtime `vivino-*`에 매핑하는 임시 adapter를 추가하지 마라
- preflight의 entity compatibility 체크를 끄지 마라
- readiness fail-closed 분기를 optional로 낮추지 마라
- legacy namespace를 허용하는 fallback을 추가하지 마라
