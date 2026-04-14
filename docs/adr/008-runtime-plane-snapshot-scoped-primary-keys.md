# ADR-008: Runtime Plane Snapshot-Scoped Primary Keys & Append-Only Restoration

## Status: Proposed — bugbash 2026-04-14 retrieval/indexing audit (rev 2 with review fixes)

### Revision history

- **rev 1** (2026-04-14): 초안. Schema + publisher + delete sites + `/ready` readiness
  확장.
- **rev 2** (2026-04-14, review fixes): review 피드백 3 건 반영.
  - **P1**: PgEntityRepository write-path 가 delete 2 개가 아니라 `save`/`update`/
    `delete`/`rollbackToSnapshot`/`createSnapshot` 5 개 전체. §5 확장 + Axis 3 §2 에
    deprecation (R1) vs rewrite (R2) 두 옵션 + Phase 3 재작성.
  - **P1**: Feature flag 단독 rollback 은 Phase 1 DDL 이후 불가능. Rollback plan 을
    Phase 별 4 단계 (레벨 0–4) 로 재구성 + 역방향 DDL migration 파일 명시.
  - **P2**: `/ready` 의 `stale_snapshot_row_count` 노출은 readiness 모듈이 아니라 HTTP
    contract 변경. Axis 3 §4 + Phase 4b 로 승격 (schema + handler + contract tests +
    OpenAPI regeneration + consumer audit).

## TL;DR

Runtime plane 테이블(`entities`, `aliases`, `ambiguity_registry`)은 [migration 010](../../src/infrastructure/db/migrations/010_active_search_snapshot_pointer.sql)의 **append-only 계약**을 어기고 있다. 주석은
"Rollback: set pointer back to previous snapshot_id. Actual data remains in place because
publish is append/upsert only (no destructive rewrites)" 라고 선언하지만, 실제 publisher는
`ON CONFLICT (entity_id) DO UPDATE SET search_snapshot_id = EXCLUDED.search_snapshot_id, ...`
로 **이전 스냅샷 row 를 즉시 덮어쓴다**. 결과: pointer 기반 rollback 이 구조적으로 깨져 있고,
publisher 가 두 번 돌면 두 스냅샷이 동일한 `entity_id` 에 대해 silent conflict 로 서로 덮어쓴다.
Canonical plane([migration 012](../../src/infrastructure/db/migrations/012_canonical_projection_snapshot_plane.sql),
[013](../../src/infrastructure/db/migrations/013_canonical_entity_snapshot_plane.sql))은 이미
composite PK `(search_snapshot_id, …)` 로 이 문제를 풀어놨다. Runtime plane 도 같은 패턴으로
migration 하고 publisher 를 `DO NOTHING` 또는 `(search_snapshot_id, id)` 기반 upsert 로
바꿔야 한다.

## Context

### 1. 의도된 계약 (migration 010)

`active_search_snapshot` 포인터는 1행 원자 포인터다. Publish flow 는:

1. 새 `search_snapshot_id` 아래 `entities`/`aliases`/`ambiguity_registry`/`ltr_model_registry`
   에 rows 를 **append**한다.
2. 최종 단계에서 포인터만 promote. 이전 스냅샷 rows 는 **그대로 남는다**.
3. Reader 는 포인터에서 active `search_snapshot_id` 를 읽고, 모든 쿼리에 `WHERE
   search_snapshot_id = $active` 필터를 건다.
4. Rollback = 포인터를 `previous_snapshot_id` 로 reset. 이전 스냅샷 rows 가 그대로 살아
   있으므로 즉시 green.
5. 구 스냅샷 rows 는 별도 GC 단계(`reap-snapshots` 운영 스크립트)가 "pointer flip 이 green
   인 grace period 후" 삭제한다.

[migration 010 주석](../../src/infrastructure/db/migrations/010_active_search_snapshot_pointer.sql#L6-L10)
그대로 인용:

> Publish flow stages data under a snapshot_id, then updates this 1-row pointer as the
> final step. Readers resolve the active snapshot_id via this pointer and filter tables
> (entities, aliases, ambiguity_registry, canonical_entities via entity_source_links) by
> that id.
>
> Rollback: set pointer back to previous snapshot_id. Actual data remains in place because
> publish is append/upsert only (no destructive rewrites).

### 2. 실제 구현 (publish-runtime-substrates.ts)

PK 는 여전히 migration 001 의 전역 스칼라다.

- `entities.entity_id` PRIMARY KEY
- `aliases.alias_id` PRIMARY KEY
- `ambiguity_registry.registry_id` PRIMARY KEY

Publisher 는 [publish-runtime-substrates.ts:367-385](../../scripts/etl/publish-runtime-substrates.ts#L367-L385):

```sql
INSERT INTO entities (entity_id, search_snapshot_id, ...)
SELECT ...
ON CONFLICT (entity_id) DO UPDATE SET
  search_snapshot_id = EXCLUDED.search_snapshot_id,
  entity_type        = EXCLUDED.entity_type,
  canonical_label    = EXCLUDED.canonical_label,
  identity_signature = EXCLUDED.identity_signature,
  relations          = EXCLUDED.relations,
  attributes         = EXCLUDED.attributes,
  metadata           = EXCLUDED.metadata,
  updated_at         = NOW()
```

`aliases` 는 [line 408-434](../../scripts/etl/publish-runtime-substrates.ts#L408-L434) 에서
`ON CONFLICT (alias_id) DO NOTHING`. `ambiguity_registry` 는
[line 436-460](../../scripts/etl/publish-runtime-substrates.ts#L436-L460) 에서
`ON CONFLICT (registry_id) DO NOTHING`.

세 테이블 모두 "snapshot A 와 B 의 같은 id" 를 **한 row 자리** 에 밀어넣는다. 그 결과:

| 테이블 | 충돌 동작 | 결과 |
|--------|-----------|------|
| `entities` | `DO UPDATE SET search_snapshot_id = B, …` | **A row 가 사라진다**. A 포인터로 rollback 시 `WHERE search_snapshot_id = A` 는 해당 entity 를 못 찾음. |
| `aliases` | `DO NOTHING` | **B row 가 사라진다**. B 포인터를 promote 해도 해당 alias 는 blocker 에게 안 보임. |
| `ambiguity_registry` | `DO NOTHING` | **B row 가 사라진다**. B 포인터 하에서 해당 normalized_form 에 대한 ambiguity 인식 실패. |

### 3. Reader 경로 검증

모든 production reader 는 `WHERE search_snapshot_id = $active` 필터를 건다. 즉 read path 는 이미
snapshot-scoped 로 설계되어 있고, PK 만 뒷받침해주면 append-only 가 자연스럽게 성립한다:

- [pg-blocking-adapter.ts:49-96](../../src/infrastructure/adapter/pg-blocking-adapter.ts#L49-L96) — `AND search_snapshot_id = $5` (3 CTE 전부)
- [pg-alias-repository.ts:68-115](../../src/infrastructure/adapter/pg-alias-repository.ts#L68-L115) — 모든 쿼리 snapshot-filtered
- [pg-alias-matcher.ts:284-382](../../src/infrastructure/adapter/pg-alias-matcher.ts#L284-L382) — 양쪽 variant 모두 필터
- [pg-entity-repository.ts:122-144](../../src/infrastructure/adapter/pg-entity-repository.ts#L122-L144) — 모든 lookup snapshot-filtered
- [pg-ambiguity-dictionary.ts:14-31](../../src/infrastructure/adapter/pg-ambiguity-dictionary.ts#L14-L31) — `AND search_snapshot_id = $2`
- [search-snapshot-readiness.ts:411-662](../../src/infrastructure/health/search-snapshot-readiness.ts#L411-L662) — readiness 검증 전부 filtered

### 4. Pre-filter leaks (2 군데)

Filter 누락은 두 곳에 집중되어 있다:

1. [container-core-builders.ts:80-82](../../src/config/container-core-builders.ts#L80-L82)
   ```ts
   const { rows } = await pool.query<{ surface_form: string }>(
     'SELECT DISTINCT surface_form FROM aliases WHERE is_suppressed = FALSE LIMIT 100000',
   );
   ```
   Learning warmup 용 surface form 수집. 모든 스냅샷의 alias 를 섞어서 읽는다. 구
   스냅샷 의 surface form 이 현재 active snapshot 의 learning context 에 침투한다.

2. [container-learning.ts:31-35](../../src/config/container-learning.ts#L31-L35)
   ```ts
   const result = await pool.query(
     `SELECT 1 FROM aliases
      WHERE surface_form = $1 AND is_suppressed = FALSE
      LIMIT 1`,
     [surfaceForm],
   );
   ```
   Learning adapter 가 "알려진 surface form 인가" 를 검증할 때 snapshot 필터 없음. 구
   스냅샷에서 제거된 alias 가 아직 테이블에 남아있으면 true.

### 5. Write-path hazards (PgEntityRepository 전면)

Delete 뿐 아니라 `PgEntityRepository` 의 **모든 mutating 메소드** 가 단일-column `entity_id`
전제로 짜여 있다. Composite PK migration 이후 이들은 각기 다른 방식으로 깨진다:

- [pg-entity-repository.ts:149-195 `save()`](../../src/infrastructure/adapter/pg-entity-repository.ts#L149-L195) —
  `INSERT INTO entities (entity_id, entity_type, canonical_label, identity_signature, ...) VALUES ($1..$9)
  ON CONFLICT (entity_id) DO UPDATE SET ...`. INSERT column list 에 `search_snapshot_id` 자체가
  없다. Composite PK 마이그레이션 후에는 (a) `search_snapshot_id NOT NULL` 제약 위반으로
  즉시 fail, 그리고 (b) `ON CONFLICT (entity_id)` 는 composite PK 와 맞지 않아 SQL 자체가
  invalid. API 가 "어느 스냅샷에 쓰는가" 를 결정할 방법조차 없는 stateless 호출이다.
- [pg-entity-repository.ts:197-225 `update()`](../../src/infrastructure/adapter/pg-entity-repository.ts#L197-L225) —
  `UPDATE entities SET ... WHERE entity_id = $1`. Composite PK 하에서 이 쿼리는
  **해당 entity_id 를 가진 모든 snapshot row 를 한꺼번에 업데이트한다**. 과거 스냅샷의 정적
  데이터가 현재 publish 와 함께 오염된다 — rollback 의미 자체가 무너진다.
- [pg-entity-repository.ts:227-235 `delete()`](../../src/infrastructure/adapter/pg-entity-repository.ts#L227-L235) —
  `DELETE FROM entities WHERE entity_id = $1`. Composite PK 하에서 **모든 snapshot 의 해당
  entity row 를 삭제**. Runtime API 용이라면 snapshot 파라미터가 추가되어야 한다.
- [pg-entity-repository.ts:295-345 `rollbackToSnapshot()`](../../src/infrastructure/adapter/pg-entity-repository.ts#L295-L345) —
  `entity_snapshots` 에서 JSONB payload 를 읽어 `INSERT ... ON CONFLICT (entity_id) DO UPDATE`
  로 복원. `save()` 와 같은 이유로 SQL 이 invalid 해지고, 설사 동작하더라도 "어느 스냅샷
  ID 로 복원해야 하는지" 를 INSERT column list 가 표현하지 못한다. 현재 설계는 "active
  snapshot 을 덮어써서 복원" 이라 migration 010 의 "포인터 flip 으로 rollback" 계약과 이미
  호환되지 않는다.
- [pg-entity-repository.ts:340-372 `createSnapshot()` 내부 purge DELETE](../../src/infrastructure/adapter/pg-entity-repository.ts#L340-L372) —
  `DELETE FROM entities WHERE entity_id NOT IN (...)`. "unguarded DELETE" 에 대한 코멘트
  가드는 있지만 snapshot scope 는 없다. 현재 계약상 "이 set 에 없는 entity 는 모든
  스냅샷에서 지운다" 로 읽히며, composite PK 후에는 이것이 **다른 스냅샷 의 live row 를 대량
  삭제**하는 결과가 된다.

**현재 runtime wiring 상태**: `src/infrastructure/index.ts:7` 에서 `PgEntityRepository` 가
barrel export 되지만, `new PgEntityRepository(...)` 호출은 어떤 composition root 에서도
발견되지 않는다 (2026-04-14 기준 grep 검증). 즉 위 5 개 mutating 메소드는 현재 live
production 경로가 아니며, wiring 만 기준으로는 **dead code** 이다. 그러나 public 모듈
surface 로 남아 있으므로 외부 호출자가 언젠가 붙을 수 있고, 이 ADR 의 schema 변경은
그 가능성 자체를 봉쇄해야 한다.

### 6. 선례 (canonical plane 은 이미 풀었다)

Canonical plane 3 테이블은 migration 012/013 에서 이미 composite PK 로 migrated 되어
있다. [migration 012:54-62](../../src/infrastructure/db/migrations/012_canonical_projection_snapshot_plane.sql#L54-L62):

```sql
ALTER TABLE canonical_aliases
  ADD CONSTRAINT canonical_aliases_snapshot_pkey
  PRIMARY KEY (search_snapshot_id, alias_id);
```

그리고 [:114-119](../../src/infrastructure/db/migrations/012_canonical_projection_snapshot_plane.sql#L114-L119):

```sql
ALTER TABLE canonical_ambiguity_registry
  ADD CONSTRAINT canonical_ambiguity_registry_snapshot_pkey
  PRIMARY KEY (search_snapshot_id, registry_id);
```

[Migration 013](../../src/infrastructure/db/migrations/013_canonical_entity_snapshot_plane.sql#L65):
`PRIMARY KEY (search_snapshot_id, canonical_entity_id)`.

즉 "snapshot-scoped composite PK" 는 이미 검증된 패턴이고, runtime plane 만 뒤처졌다.

## Decision

Runtime plane 을 canonical plane 과 동일한 snapshot-scoped composite PK 모델로 migration
한다. 세 축이 동시에 움직여야 consistent 하다:

### Axis 1 — Schema (migration 016)

1. **`entities`**
   - DROP `entities_pkey` on `(entity_id)`.
   - ADD `entities_snapshot_pkey` on `(search_snapshot_id, entity_id)`.
   - DROP `uq_entities_identity_signature` (unique on `identity_signature`
     globally — migration 011).
   - ADD `uq_entities_snapshot_identity_signature` on `(search_snapshot_id,
     identity_signature)` partial, `WHERE length(identity_signature) > 0`.
   - 이 변경으로 동일 `identity_signature` 가 여러 스냅샷에 공존 가능. 이는
     ADR-007 과 모순되지 않는다 — `identity_signature` 의 "runtime immutability"
     는 _한 snapshot 내_ 의 invariant 이다. Snapshot 간 re-publish 는 새로운
     immutable row 를 append 하는 것이지, 기존 row 를 remap 하는 것이 아니다.
   - `entity_snapshots.entity_id REFERENCES entities(entity_id)` FK 제거.
     `entity_snapshots` 는 이미 `snapshot_id` 단일 PK 의 독립 archive 이므로
     FK 가 없어도 의미론적으로 안전하다.

2. **`aliases`**
   - DROP `aliases_pkey` on `(alias_id)`.
   - ADD `aliases_snapshot_pkey` on `(search_snapshot_id, alias_id)`.

3. **`ambiguity_registry`**
   - DROP `ambiguity_registry_pkey` on `(registry_id)`.
   - DROP `idx_ambiguity_normalized` (UNIQUE on `normalized_form`).
   - ADD `ambiguity_registry_snapshot_pkey` on `(search_snapshot_id, registry_id)`.
   - ADD `idx_ambiguity_snapshot_normalized` UNIQUE on `(search_snapshot_id,
     normalized_form)`.

4. **Backfill guard**
   - Migration 은 `NULL search_snapshot_id` row 가 남아있으면 `RAISE EXCEPTION`.
     `canonical_ambiguity_registry` 가 migration 012 에서 같은 패턴으로 처리한 것과
     동일([012:80-91](../../src/infrastructure/db/migrations/012_canonical_projection_snapshot_plane.sql#L80-L91)).
   - 만약 legacy row 가 있다면 `__unbound__` sentinel 로 backfill 하거나, 운영자가
     수동으로 제거해야 한다.

### Axis 2 — Publisher (`publish-runtime-substrates.ts`)

1. `entities` upsert: `ON CONFLICT (search_snapshot_id, entity_id) DO NOTHING`.
   - 같은 스냅샷을 재실행해도 idempotent.
   - 다른 스냅샷의 동일 `entity_id` 는 충돌하지 않고 append.
2. `aliases`: `ON CONFLICT (search_snapshot_id, alias_id) DO NOTHING`.
3. `ambiguity_registry`: `ON CONFLICT (search_snapshot_id, registry_id) DO NOTHING`.
4. `assertSnapshotNotAlreadyPublished()` 는 그대로 유지 — "같은 스냅샷 ID 재실행 금지"
   는 DB-level idempotency 와는 별도 invariant.

### Axis 3 — Reader/writer site audit

다음 site 를 동시에 수정한다:

1. **Pre-filter leaks 수정 (HIGH)**
   - `container-core-builders.ts:80-82`: learning warmup 쿼리에
     `WHERE search_snapshot_id = $1` 추가. active snapshot ID 를 `resolveActiveSnapshot(pool)`
     로 조회해 바인드.
   - `container-learning.ts:31-35`: 같은 방식으로 snapshot 필터 추가.
   - 두 site 모두 "snapshot pointer 부재" 를 "learning 비활성화" 로 안전하게 degrade.
     bootstrap-only 경로이므로 fail-open 이 아니라 _feature-disabled_ 가 맞다.

2. **PgEntityRepository 전면 재설계 또는 deprecation (HIGH)** — §5 참조

   `delete()` + `createSnapshot()` purge 두 site 만으로는 부족하다. 같은 class 의
   `save()` / `update()` / `rollbackToSnapshot()` 역시 단일-column key 전제이며, Axis 1
   schema 변경 이후 현재 코드 그대로면 SQL parse error 또는 silent cross-snapshot
   corruption 으로 직행한다. 이 ADR 은 둘 중 하나를 **반드시** 선택하고 이행한다:

   - **Option R1 (권장) — Repository mutating surface 전면 deprecation**:
     - `EntityRepository` 포트 (`src/domain/entity/port/entity-repository.port.ts`) 에서
       `save` / `update` / `delete` / `rollbackToSnapshot` / `createSnapshot` 을
       **제거**. Runtime 쓰기 경로는 오직 ETL publisher (`publish-runtime-substrates.ts`)
       와 rollback 운영 도구 (pointer promote) 만 존재해야 한다. Read-only 메소드
       (`findById`, `findByIdentitySignature`, `findByType`, iterator) 만 남긴다.
     - `PgEntityRepository` 구현은 read-only subset 만 남기고, mutating 메소드는
       파일에서 삭제 (barrel re-export 는 read-only facade 만 노출).
     - 위 메소드를 사용하는 호출자가 없음을 `git grep` 과 `npm ls` 수준에서 확인하는
       `test/regression/pg-entity-repository-readonly-surface.regression.test.ts` 추가.
       이 테스트는 AST-level 로 `src/**/*.ts` 에서 `PgEntityRepository#save|update|delete|
       rollbackToSnapshot|createSnapshot` 호출이 0 임을 단언한다.
     - **근거**: 2026-04-14 grep 검증 결과 어떤 composition root 도 이 class 를
       construct 하지 않음. §5 의 dead-code 진단을 그대로 반영하고, runtime 쓰기
       경로를 single authority (publisher) 로 정규화.

   - **Option R2 (보류) — 5 개 메소드를 snapshot-aware 로 rewrite**:
     - `save(entity, snapshotId)`, `update(entity, snapshotId)`, `delete(id, snapshotId)`,
       `rollbackToSnapshot(snapshotId)` 시그니처 변경. 포트 업데이트 → 구현 업데이트
       → 호출자 업데이트. 현재 호출자 수 = 0 이므로 "호출자 업데이트" 는 null 작업.
     - `createSnapshot()` 는 두 단계로 분해: (a) 새 스냅샷 INSERT, (b) GC 는
       `reap-snapshots.ts` 로 분리. 같은 함수 안에서 "INSERT + 다른 스냅샷 DELETE"
       를 섞지 않는다.
     - `save()` 의 INSERT column list 에 `search_snapshot_id` 추가. `ON CONFLICT
       (search_snapshot_id, entity_id) DO NOTHING` 으로 변경.
     - `update()` 는 `WHERE entity_id = $1 AND search_snapshot_id = $2` 로 scope.
     - `rollbackToSnapshot()` 는 의미론적으로 무엇을 하는지 재정의 필요 — 포인터
       promote 와 중복되는가? 기존 의도가 "entity 단위 rollback" 이라면 포인터 모델과
       충돌. 이 경우 Option R1 의 deprecation 이 사실상 유일한 정합이다.

   Phase 3 에 들어가기 전까지 둘 중 하나를 선택해 PR description 에 기록한다. 선택
   안 된 채로 schema migration 이 먼저 merge 되는 것을 금지 — Axis 1 과 Axis 3-R1/R2
   는 같은 release train 에 포함되어야 한다 (roll-forward 안전성 조건).

3. **GC 경로 신설 (MEDIUM)**
   - Operator runbook `reap-snapshots`:
     `DELETE FROM entities WHERE search_snapshot_id NOT IN (active, previous)`.
     같은 패턴을 aliases/ambiguity_registry 에 대해서도 제공.
   - Grace period 는 기본 24 h. `ops/reap-snapshots.ts` 새 스크립트 를 통해서만
     실행, publish path 에서는 금지.

4. **Readiness 검증 확장 → HTTP contract 변경 (MEDIUM, 과소평가됨)**

   `stale_snapshot_row_count` 를 `/ready` 응답에 노출하는 것은 readiness 모듈 내부
   수정이 아니라 **HTTP wire contract 변경** 이다. 현재
   [ReadyResponseSchema](../../src/interface/http/routes/route-contracts.ts#L112-L127)
   는 `.strict()` 이고, 각 check record 도 `{status, required, reason?, error_class?}`
   로 `.strict()`. 새 numeric 필드를 담으려면 4 개 site 가 동시에 움직여야 한다:

   1. **Schema (`route-contracts.ts`)** — top-level 에 `stale_snapshot_row_count:
      z.number().int().nonnegative().optional()` 추가, 또는 (권장) `snapshot_health`
      라는 nested object 를 신설해 `{ stale_row_count, active_snapshot_id,
      previous_snapshot_id, reap_lag_seconds }` 를 한 덩어리로 담는다. nested 편이
      future-proof 하고 필드 추가마다 top-level surface 가 커지지 않는다.
   2. **Handler (`health.route.ts`)** — readiness 모듈에서 count 를 받아 응답 조립
      경로에 주입. 필드 누락 시 contract violation 이 되므로 always-present 또는
      explicit `.optional()` 둘 중 하나를 결정.
   3. **Domain module** — [search-snapshot-readiness.ts:411-435](../../src/infrastructure/health/search-snapshot-readiness.ts#L411-L435)
      에 "cross-snapshot row count" 패리티 체크 추가. `WHERE search_snapshot_id NOT
      IN (active, previous)` 의 row 수를 entities/aliases/ambiguity_registry 세
      테이블 합산으로 반환.
   4. **테스트 + 계약 patrol**:
      - `src/interface/http/routes/__tests__/ready-route.contract.test.ts` 에 새 필드
        직렬화 확인 추가.
      - `test/e2e/v2-routes.contract.test.ts` 의 `/ready` golden fixture 업데이트.
      - `docs/http-contract-surface.md` 와 OpenAPI 생성 경로 (`scripts/verify-http-contracts.ts`)
        재생성. `pnpm run verify:http-contracts` 가 pre-push 에서 빨강이 될 수
        있으므로 동일 PR 에서 회귀 테스트 + OpenAPI 재생성까지 포함.
      - consumer 측 (`web/`) 에 `/ready` 응답을 타입으로 소비하는 코드가 있는지 grep.
        있으면 그 타입 정의 동기화 필수.

   본 변경은 operator observability 개선이므로 backwards-compatible 한 optional 필드
   추가가 원칙. Breaking change 는 금지 — `.strict()` 아래에서 optional 필드는 기존
   consumer 가 무시하면 된다.

## Migration Plan

### Phase 0 — Pre-flight (이 ADR 문서만 merge, 코드 변경 없음)

- `docs/adr/008-runtime-plane-snapshot-scoped-primary-keys.md` (이 파일) merge.
- 현재 production 의 3 테이블에 동일 `entity_id`/`alias_id`/`registry_id` 가 다수 스냅샷에
  걸쳐 존재하는지 `SELECT entity_id, COUNT(DISTINCT search_snapshot_id) FROM entities
  GROUP BY entity_id HAVING COUNT(DISTINCT search_snapshot_id) > 1` 로 확인.
  현재 `DO UPDATE` 가 덮어쓰는 구조라 이 쿼리는 0 row 를 반환할 확률이 높다
  (append-only 가 애초에 동작하지 않았으므로). 만약 0 이면 migration 은 no-op 에 가까운
  schema 변경이 된다.

### Phase 1 — Schema migration (`016_runtime_plane_snapshot_pk.sql`)

- [migration 012](../../src/infrastructure/db/migrations/012_canonical_projection_snapshot_plane.sql)
  와 동일한 DO $$ 블록 패턴으로 re-runnable.
- NULL `search_snapshot_id` guard `RAISE EXCEPTION`.
- `entities_snapshot_pkey` / `aliases_snapshot_pkey` / `ambiguity_registry_snapshot_pkey`
  ADD CONSTRAINT.
- `uq_entities_snapshot_identity_signature` 신규 partial index.
- `idx_ambiguity_snapshot_normalized` 신규 UNIQUE.
- **FK drop**: `entity_snapshots.entity_id` FK 를 떼는 한 줄.
- Migration 테스트: [db-migrate.test.ts](../../src/__tests__/db-migrate.test.ts) 에 16 번까지
  재실행 경로 추가.

### Phase 2 — Publisher 변경

- `publish-runtime-substrates.ts` 의 3 개 INSERT 를 composite PK conflict target 으로 교체.
- 기존 publish integration smoke (`bootstrap-smoke.sh`, `run-ingest-indexing-smoke.ts`) 에
  **두 번 연속 publish** 케이스 추가. 두 번째 publish 가 첫 번째를 **건드리지 않음** 을
  assertion. 구체적 검증:
  1. `SELECT COUNT(*) FROM entities WHERE search_snapshot_id = $first` 는 변하지 않음.
  2. `SELECT COUNT(*) FROM entities WHERE search_snapshot_id = $second` 는 expected 와 일치.
- 회귀: `test/regression/runtime-plane-append-only.regression.test.ts` 신규.

### Phase 3 — Reader/Write-path 전면 수정

**사전 조건**: Phase 3 는 Axis 3 §2 의 Option R1 또는 R2 가 PR 제목/description 에
기록된 상태에서만 시작. 이 결정이 없으면 Phase 3 는 merge 금지.

**3a. Pre-filter leak 2 개 (HIGH)**
- `container-core-builders.ts:80-82` → `WHERE search_snapshot_id = $1`
- `container-learning.ts:31-35` → 동일 패턴
- 회귀: `container-core-builders-snapshot-filter.test.ts`,
  `container-learning-snapshot-filter.test.ts`

**3b. `PgEntityRepository` 쓰기 경로 (HIGH)** — 사전 선택에 따라 분기

- **Option R1 (deprecation 경로)**:
  - `src/domain/entity/port/entity-repository.port.ts` 에서 `save|update|delete|
    rollbackToSnapshot|createSnapshot` 제거.
  - `src/infrastructure/adapter/pg-entity-repository.ts` 에서 동일 5 개 메소드 제거.
  - `src/infrastructure/index.ts:7` 의 barrel export 는 read-only facade (`findById`,
    `findByIdentitySignature`, `findByType`, iterator) 만 유지.
  - 회귀: `test/regression/pg-entity-repository-readonly-surface.regression.test.ts` —
    `src/**/*.ts` 전반을 grep 하여 `.save(`, `.update(`, `.delete(`, `.rollbackToSnapshot(`,
    `.createSnapshot(` 호출이 0 임을 단언.
  - 타입 체크: `tsc --noEmit` 이 제거 대상 메소드에 대한 남은 참조를 전부 찾아내므로
    추가 audit 불필요.

- **Option R2 (rewrite 경로)**:
  - 포트 시그니처 변경: `save(entity, snapshotId)`, `update(entity, snapshotId)`,
    `delete(id, snapshotId)`, `rollbackToSnapshot(snapshotId)`, `createSnapshot()` 는
    INSERT 전용으로 의미 축소 (GC 는 `reap-snapshots.ts` 로 이전).
  - `save()` INSERT column list 에 `search_snapshot_id` 추가.
  - 모든 3 개 ON CONFLICT 구문을 composite target `(search_snapshot_id, entity_id)` 로
    교체.
  - `update()` 의 WHERE 에 `AND search_snapshot_id = $N` 추가.
  - `delete()` 의 WHERE 에 `AND search_snapshot_id = $2` 추가.
  - 회귀:
    - `pg-entity-repository-save-snapshot-scoped.test.ts`
    - `pg-entity-repository-update-snapshot-scoped.test.ts`
    - `pg-entity-repository-delete-snapshot-scoped.test.ts`
    - `pg-entity-repository-rollback-semantics.test.ts` — "rollback 은 포인터 promote
      를 호출하고 row mutation 은 하지 않는다" invariant 또는 기존 의미를 재명시한 버전.

**3c. `createSnapshot()` 내부 purge 제거 (HIGH)**
두 option 모두에서, `createSnapshot()` 의 `DELETE FROM entities WHERE entity_id NOT IN
(...)` 블록은 제거 또는 `reap-snapshots.ts` 로 이관. Publish/createSnapshot path 에서
cross-snapshot DELETE 는 금지.

회귀: `pg-entity-repository-create-snapshot-no-cross-delete.test.ts` — "createSnapshot
실행 후 다른 snapshot_id 의 row 가 변하지 않음" 을 assertion.

### Phase 4 — GC 도구 + `/ready` HTTP contract 확장

- **GC 도구**: `scripts/ops/reap-snapshots.ts` 신규. `active` 와 `previous` 를 제외한
  snapshot ID 의 row 를 batch delete. `--dry-run` 기본. `--force` flag 명시 시에만
  실제 DELETE. 3 테이블 동시 처리.
- `docs/runbook-etl-operator-acks.md` 에 reap-snapshots 사용 가이드 추가. 특히 Phase
  1 rollback 시 선결 조건으로 reaper 실행 필요함을 강조.
- **`/ready` 응답 contract 변경**: Axis 3 §4 에서 상술. 이 작업은 단순 readiness
  모듈 확장이 아니라 **HTTP wire contract 변경**이며 별도 sub-phase (4b) 로 분리한다:
  - **4b-1** `route-contracts.ts` ReadyResponseSchema 에 optional `snapshot_health`
    nested object 추가. Nested 형태를 선호하는 이유는 미래 필드 (e.g. reap_lag,
    last_publish_ts) 를 top-level 오염 없이 수용하기 위함.
  - **4b-2** `health.route.ts` handler 가 readiness 모듈에서 받은 값을 조립.
  - **4b-3** `search-snapshot-readiness.ts` 에 cross-snapshot row count 수집 로직
    추가.
  - **4b-4** 계약/회귀 테스트:
    - `src/interface/http/routes/__tests__/ready-route.contract.test.ts`
    - `test/e2e/v2-routes.contract.test.ts` 의 `/ready` golden fixture
    - OpenAPI 재생성 (`pnpm run verify:http-contracts` 가 green)
  - **4b-5** consumer audit: `web/` 및 외부 SDK 타입 정의 grep. Optional 이라 break
    하지 않지만 dashboard 가 새 필드를 렌더하려면 UI 쪽 업데이트가 필요.
  - **결정 체크**: Option R1 (deprecation) 경로를 선택한 경우에도 4b 는 독립적으로
    merge 가능. Option R2 와 독립.

### Phase 5 — Follow-up cleanup

- ADR-007 의 `identity_signature` immutability 규칙 재확인 — 이제 "snapshot 내 immutable,
  snapshot 간 re-append" 로 문서 보강.
- `entity_snapshots` 테이블의 존재 의의 재평가. Composite PK entities 가 이미 rollback
  artifacts 를 보유하므로 `entity_snapshots` 는 중복일 수 있음. 별도 ADR 후속.

## Alternatives Considered

### Alt A — 현재 구조 유지 + assertNoCrossSnapshotEntityCollision

Publish 전에 `SELECT entity_id FROM entities WHERE entity_id = ANY($1) AND search_snapshot_id
!= $newSnapshot` 으로 충돌을 감지하고 fail-loud.

**문제**: 대부분의 `entity_id` 는 canonical 이라 snapshot 간 동일하다. 정상 publish 도
거의 항상 fail. 사실상 "새 스냅샷 publish 금지" 와 동치. 기각.

### Alt B — `entities` 를 "active view" 로 재정의 (latest-wins)

"`entities` 는 항상 active snapshot 의 rows 만 보관한다. publish 는 TRUNCATE + INSERT."

**문제**:
1. Migration 010 주석에 정면으로 반한다 ("publish is append/upsert only, no destructive
   rewrites").
2. Rollback 은 이전 snapshot 의 row 가 사라진 상태이므로 불가능. `entity_snapshots`
   archive 를 replay 해야 하는데, 이건 publish cost 와 rollback cost 를 모두 크게 올린다.
3. 동시 publish 창 문제: TRUNCATE 시점에 read 요청이 오면 빈 결과.
4. Canonical plane 이 이미 composite PK 로 풀어놓은 방향과 역행.

기각.

### Alt C — 논리적 "append-only" view, 물리적으로는 현재 유지

`entities` 에 `CREATE VIEW entities_snapshot AS SELECT ... WHERE search_snapshot_id = ...`
만들어서 reader 만 view 를 쓰게 한다. 물리 테이블은 그대로.

**문제**: Rollback 은 여전히 불가능 (구 row 가 `DO UPDATE` 로 날아간 상태). 표면만 가리는
해결책. 기각.

### Alt D (선택됨) — Composite PK + append-only publisher + snapshot-scoped delete + GC 도구

Migration 010 계약을 코드-level 로 회복. Canonical plane 과 pattern 일치. Read path 는
이미 호환. Publish 와 delete 만 수정하면 됨. **가장 작은 구조 변경으로 계약 복원.**

## Risks & Rollback

### Risk 1 — Migration 중 row 수 폭증

Composite PK 가 생기면 append-only 가 실제로 동작하기 시작하므로 publish 마다 테이블이
자란다. 운영 시 disk pressure.

**Mitigation**: Phase 4 의 `reap-snapshots` 가 active+previous 외 스냅샷을 청소. Grace
period 24 h 기본. readiness 에 row count 노출.

### Risk 2 — `identity_signature` 중복

Migration 011 의 global unique index 를 drop 하면 snapshot 간 동일 signature 가 공존한다.
이론적으로 read path 는 snapshot-scoped 이므로 영향 없음. 그러나 코드가 `SELECT ... FROM
entities WHERE identity_signature = $1` 를 snapshot filter 없이 한다면 깨진다.

**Mitigation**: Phase 3 의 site audit 에서 `WHERE identity_signature` 전체 grep. 현재
확인된 read site 는 모두 snapshot filter 동반 ([pg-entity-repository.ts:132-134](../../src/infrastructure/adapter/pg-entity-repository.ts#L132-L134)).

### Risk 3 — `entity_snapshots` FK drop 후 orphan

현재 FK 는 "entity_snapshots.entity_id 는 entities 에 존재해야 함" 만 보장. Composite
migration 후에는 `(entity_id, search_snapshot_id)` 조합이 필요한데 FK 로는 표현하기 번거로움.

**Mitigation**: FK 를 drop 하고 application-level assert 로 교체. 또는 `entity_snapshots` 를
deprecate 하고 후속 ADR 로 다룸 (Phase 5).

### Rollback plan

**핵심 주의**: Phase 1 이 merge 된 시점부터 구 publisher SQL (`ON CONFLICT (entity_id)`)
은 **conflict target 이 존재하지 않아 invalid** 하다. Feature flag 단독으로는 구 동작을
복원할 수 없다 — flag off 는 최소한 Phase 1 DDL rollback 과 **쌍으로** 실행되어야 한다.
아래 계획은 이 결합을 명시한다.

**레벨 0 — Phase 0 (ADR-only merge)**
- Git revert 로 충분. DB 영향 없음.

**레벨 1 — Phase 1 (schema migration) 후 rollback**
- 절차: 운영자가 역방향 DDL migration 을 실행한다. 예시:
  ```sql
  -- 017_runtime_plane_snapshot_pk_rollback.sql
  ALTER TABLE entities DROP CONSTRAINT entities_snapshot_pkey;
  ALTER TABLE entities ADD CONSTRAINT entities_pkey PRIMARY KEY (entity_id);
  DROP INDEX IF EXISTS uq_entities_snapshot_identity_signature;
  CREATE UNIQUE INDEX uq_entities_identity_signature
    ON entities(identity_signature) WHERE length(identity_signature) > 0;
  -- aliases / ambiguity_registry 대해서도 동일 패턴 복원
  -- entity_snapshots FK 복원
  ```
- **선결 조건**: `(search_snapshot_id NOT IN (active, previous))` 인 row 가 0 이어야
  한다. Phase 4 reaper 가 이미 stale rows 를 정리한 상태가 아니면 PK 복원 시 duplicate
  에러가 난다. 운영자는 DDL 실행 전 `reap-snapshots.ts --force` 로 먼저 정리.
- **추가 정리**: 복원 후에도 cross-snapshot duplicate entity_id (active 와 previous
  양쪽에 같은 entity_id 가 append 된 경우) 가 남아있으면 `entities_pkey` 제약 위반.
  이 케이스는 "previous snapshot row 를 DELETE 후 active 만 남긴다" 로 수동 정리. ADR
  rollback runbook 에 SQL 을 명시:
  ```sql
  DELETE FROM entities a
    USING entities b
    WHERE a.entity_id = b.entity_id
      AND a.search_snapshot_id = (SELECT previous_snapshot_id FROM active_search_snapshot)
      AND b.search_snapshot_id = (SELECT active_snapshot_id FROM active_search_snapshot);
  ```
- **Rollback 의 의미 상실**: 이 시점 이후 포인터 rollback 은 동작하지 않는다. 운영자는
  이 손실을 명시적으로 승인해야 한다 (`--accept-rollback-loss-of-snapshot-history`
  같은 문구를 runbook 에 박아둔다).

**레벨 2 — Phase 2 (publisher 변경) 후 rollback**
- Publisher 변경 자체는 feature flag `RUNTIME_PLANE_APPEND_ONLY_PUBLISH` 로 gate. 단,
  flag off 는 Phase 1 DDL rollback 이 먼저 실행된 뒤에만 유효하다 (위 §레벨 1 절차와
  동일).
- Publisher 만 revert 하는 가벼운 대안: 새 PR 로 "publisher 를 composite conflict
  target 으로 유지하되 behavior 를 예전 의미론과 동등하게 emulate" — 예를 들어
  publisher 가 (a) 이전 스냅샷 row 를 지우고 (b) 새 스냅샷 row 를 INSERT. 이는 쓰기
  path 에서 append-only 를 스스로 부정하는 것이므로 **영구 운영 상태로 두면 안 되고**,
  단기 bridge 로만 허용.
- Flag off 는 원칙적으로 reversible 한 긴급 escape hatch 가 아니라, "Phase 1/2 를 같이
  되돌리는 운영 프로시저" 의 일부다. 문서상 'emergency flag flip' 과 구분해 표기.

**레벨 3 — Phase 3 (쓰기 경로 재설계) 후 rollback**
- Option R1 (deprecation) 선택 시: 포트/구현에서 제거한 mutating 메소드를 되살리는
  건 git revert 로 가능. 단 새 호출자가 생겼으면 해당 호출자도 같이 revert.
- Option R2 (rewrite) 선택 시: 개별 메소드 rewrite 는 회귀 테스트로 보호되므로 문제
  발견 시 method-level git revert.
- **불변**: Phase 3 단독 rollback 은 Phase 1/2 와 상관없이 수행 가능. Phase 3 는
  schema/publisher 가 이미 composite PK 세계에 맞춰진 상태에서 호출 시그니처만 정리하는
  단계이므로 구조를 거꾸로 되돌리지 않는다.

**레벨 4 — Phase 4/5 (GC 도구, follow-up) 후 rollback**
- 도구 revert + runbook revert. DB 영향 없음 (reaper 는 항상 `--dry-run` 기본, 파괴적
  실행은 운영자가 명시 flag 로만 수행).

## Related Work (audit 에서 같이 나온 이슈, 이 ADR 의 scope 밖)

### RW-1 — Cache hit `execution_mode` staleness (retrieval audit D2)

[search-usecase-cache-hit.ts:11-24](../../src/application/search/search-usecase-cache-hit.ts#L11-L24)
의 `mergeCachedSearchResponseMeta()` 는 `requestId` 와 `queryTimeMs` 만 갱신하고
`execution_mode` / `degradation_reasons` 는 캐시된 시점의 값을 그대로 쓴다. 과거 authoritative
응답을 현재 인프라가 degraded 일 때 그대로 반환 → 와이어 거짓말.

**이 ADR scope 밖** — 캐싱 정책/TTL 결정이 필요하며 runtime plane 과 직교. 후속 ADR-009
후보.

선택지:
- A) Cache 에 `cached_at` timestamp 를 붙이고 client 가 해석.
- B) Cache hit 시 `meta.source: 'cache'` 마커 강제 추가.
- C) 짧은 TTL (≤ 60 s) 로 staleness 창 제한.
- D) Degradation snapshot 을 cache key 에 포함 (인프라 상태가 바뀌면 key 가 invalidated).

현재 선호: D + B 결합. 별도 ADR.

### RW-2 — Vespa schema validation → route degradation (retrieval audit R4)

Bugbash 2026-04-14 1st wave 의 `candidate-pool.getLastDegradationSignals()` + `search-usecase-hybrid-candidates.retrievalSignalsToReasons()` 로 **부분 해결**됐다. 단
Vespa client 가 schema validation throw 를 하면 `catch (sparseErr)` 에서 `sparseResult`
degradation 으로 변환되어 `getLastDegradationSignals()` 에 담긴다. 따라서 HTTP
`meta.degradation_reasons` 까지 전파된다.

남은 갭: schema validation 실패가 **entire result set** 대신 **per-hit** 으로 일어나면
detection 이 불가능. 이건 별도 retrieval-layer ADR.

### RW-3 — Blocker adapter "snapshot missing" vs "aliases missing" 구별

Bugbash 2026-04-14 1st wave 에서 4 개 silent-skip kind
(`blocker_disabled_snapshot_pointer_missing`, `blocker_disabled_aliases_table_missing`,
`blocker_snapshot_resolve_failure`, `blocker_alias_query_failure`) 로 구별 완료.
Dashboard/alert 정책은 ops 가 정의.

## Open Questions

1. **`entity_snapshots` 의 존재 의의**: Composite PK `entities` 가 이미 per-snapshot row
   history 를 갖게 되면, `entity_snapshots` 의 `snapshot_data` JSONB 중복 저장은 필요
   없어질 수 있다. Phase 5 에서 re-evaluate.
2. **Cross-snapshot identity proof**: `canonical_entities` + `entity_source_links` 가
   이미 identity graph 를 snapshot-independent 하게 보유한다. Runtime `entities` 와의
   역할 분담을 ADR-007 후속 부록으로 명시.
3. **`ltr_model_registry` 동일 패턴**: Migration 006 에서 snapshot-bound 이지만 PK 구조는
   재확인 필요. 같은 composite PK pattern 으로 aligned 되어야.
4. **GC grace period**: 24 h 가 안전한가? Rollback 이 필요한 max 지연이 기준. SRE 와
   상의.
5. **동시 publish 금지**: 현재는 `assertSnapshotNotAlreadyPublished` 로 "같은 스냅샷 ID"
   만 막는다. 두 publisher 가 "다른" ID 로 동시에 실행되는 것은 막혀 있지 않다. Composite
   PK 하에서 이론적으로 둘 다 성공해 두 스냅샷이 공존할 수 있지만, 포인터는 하나라
   마지막 promote 가 승리. 이게 안전한지, advisory lock 이 필요한지 별도 검토.

## Acceptance Criteria

이 ADR 이 implemented 됐다고 말하려면:

**Schema & publisher**
- [ ] Migration 016 merged + `db-migrate.test.ts` green
- [ ] Runtime plane 3 테이블 모두 `(search_snapshot_id, id)` composite PK
- [ ] `uq_entities_snapshot_identity_signature` partial UNIQUE 존재
- [ ] `idx_ambiguity_snapshot_normalized` UNIQUE 존재
- [ ] `entity_snapshots.entity_id` FK drop
- [ ] `publish-runtime-substrates.ts` 3 INSERT 가 composite conflict target 사용
- [ ] `test/regression/runtime-plane-append-only.regression.test.ts` — **같은 publisher
      두 번 실행 후 첫 번째 snapshot 의 row 가 전부 남아있음** assertion

**Write-path (PgEntityRepository — Option R1 또는 R2 택일)**
- [ ] Option 선택이 PR description 에 명시됨
- [ ] **Option R1 경우**: 포트/구현에서 `save|update|delete|rollbackToSnapshot|createSnapshot`
      제거됨 + `pg-entity-repository-readonly-surface.regression.test.ts` 가 호출자 0 을 단언
- [ ] **Option R2 경우**: 5 개 메소드 모두 `snapshotId` 파라미터 수용 + 각 site 회귀 테스트
      (save/update/delete/rollback/createSnapshot) green
- [ ] `createSnapshot()` 내부의 cross-snapshot DELETE 블록 제거됨
- [ ] `pg-entity-repository-create-snapshot-no-cross-delete.test.ts` green

**Read-path (pre-filter leaks)**
- [ ] `container-core-builders.ts` pre-filter 수정 + `container-core-builders-snapshot-filter.test.ts` green
- [ ] `container-learning.ts` pre-filter 수정 + `container-learning-snapshot-filter.test.ts` green
- [ ] `WHERE identity_signature` grep 결과 모든 site 가 snapshot filter 동반

**GC**
- [ ] `scripts/ops/reap-snapshots.ts` + `--dry-run` 기본 + `--force` 필수 flag
- [ ] `docs/runbook-etl-operator-acks.md` 에 reap-snapshots 가이드 + Phase 1 rollback
      선결 조건 명시

**`/ready` HTTP contract (Axis 3 §4 / Phase 4b)**
- [ ] `ReadyResponseSchema` 에 optional `snapshot_health` nested object 추가
- [ ] `health.route.ts` handler 가 필드 조립
- [ ] `ready-route.contract.test.ts` 업데이트
- [ ] `test/e2e/v2-routes.contract.test.ts` `/ready` golden fixture 업데이트
- [ ] `pnpm run verify:http-contracts` green (pre-push 에서 빨강 안 남)
- [ ] `docs/http-contract-surface.md` 재생성
- [ ] `web/` 및 외부 consumer 타입 정의 audit 결과 기록

**End-to-end smoke**
- [ ] `bootstrap-smoke.sh` 에 "publish × 2 회 → rollback → 원본 복원" 시나리오 추가
- [ ] `pnpm run git:prepush` green

**Rollback runbook**
- [ ] `017_runtime_plane_snapshot_pk_rollback.sql` DDL rollback 파일 존재 (실행은 운영
      판단, 파일은 코드베이스에 포함)
- [ ] Runbook 에 "feature flag 단독 rollback 은 불가능하며 DDL 과 쌍으로 실행해야 함"
      명시

## 참고 문서

- [ADR-006: Search snapshot publish architecture](006-search-snapshot-publish-architecture.md)
- [ADR-007: Canonical entity identity cutover](007-canonical-entity-identity-cutover.md)
- [Migration 010: active_search_snapshot pointer](../../src/infrastructure/db/migrations/010_active_search_snapshot_pointer.sql)
- [Migration 011: identity authority constraints](../../src/infrastructure/db/migrations/011_identity_authority_constraints.sql)
- [Migration 012: canonical projection snapshot plane](../../src/infrastructure/db/migrations/012_canonical_projection_snapshot_plane.sql)
- [Migration 013: canonical entity snapshot plane](../../src/infrastructure/db/migrations/013_canonical_entity_snapshot_plane.sql)
- [docs/runbook-etl-operator-acks.md](../runbook-etl-operator-acks.md)
