# T-EL-06 Curation Write Plane For Proposals Ambiguity And Suppression

## 목표

alias/ambiguity/suppression 운영이 JSONL 편집 + psql 수작업에 묶이지 않도록, runtime-plane writer invariant를 지키는 staging/proposal 기반 write-plane을 만든다.

## 현재 근거

- abbreviation alias는 JSONL review 후 `alias_proposals`에 stage한다: [docs/runbook-abbreviation-aliases.md](../../../../docs/runbook-abbreviation-aliases.md)
- runbook는 ambiguous abbreviation 등록을 `psql` operator-only로 둔다: [docs/runbook-abbreviation-aliases.md](../../../../docs/runbook-abbreviation-aliases.md)
- runtime-plane direct write는 `publish-runtime-substrates.ts`만 허용된다: [test/regression/runtime-plane-insert-authority.regression.test.ts](../../../../test/regression/runtime-plane-insert-authority.regression.test.ts)
- `alias_proposals` table은 이미 존재한다: [src/infrastructure/db/migrations/001_initial_schema.sql](../../../../src/infrastructure/db/migrations/001_initial_schema.sql)

## 선행 티켓

- [T-EL-03](./T-EL-03-alias-substrate-governance-and-hot-entity-coverage.md)
- [T-EL-04](./T-EL-04-operator-debug-api-and-runtime-observability.md)

## 정확한 산출물

1. proposal review / approve / reject surface
2. ambiguity staging plane
3. suppression request plane
4. publisher consumption contract
5. operator web UI or trusted API for write actions

## 반드시 건드릴 파일

1. `scripts/etl/publish-runtime-substrates.ts`
2. `scripts/etl/build-search-snapshot.ts`
3. `src/infrastructure/db/migrations/*.sql`
4. `src/interface/http/routes/route-contracts.ts`
5. `web/src/app/ops/**`

## 가능하면 건드리지 말아야 할 파일 / 레이어

1. `src/infrastructure/adapter/pg-alias-repository.ts`
2. `src/infrastructure/adapter/pg-ambiguity-dictionary.ts`
3. public product routes

## 구현 범위

1. staging table schema
2. review/approve/reject contract
3. ambiguity/suppression publish semantics
4. audit trail and provenance
5. minimal operator UI

## 구현 제외 범위

1. runtime `aliases` / `ambiguity_registry` direct edit
2. free-form SQL console
3. consumer-facing moderation UI

## 구조 규칙

1. write-plane은 runtime-plane이 아니라 staging/proposal/canonical plane이어야 한다.
2. publish가 최종 authority여야 한다.
3. 모든 mutation은 actor, reason, provenance를 남겨야 한다.

## 절대 하지 말아야 할 구현

1. web/API에서 `aliases` table 직접 UPDATE/INSERT
2. suppression을 soft client-side blacklist로만 처리
3. ambiguity를 docs/runbook에만 적고 data plane에 남기지 않는 것

## 실패 패턴

1. UI는 생겼는데 publish가 그 row를 읽지 않는다
2. approved proposal이 next snapshot에서 provenance 없이 사라진다
3. suppression이 runtime plane에만 반영되고 canonical/staging에는 기록이 없다

## 검증 명령

```bash
pnpm run typecheck
pnpm run typecheck:etl
pnpm exec vitest run test/unit/etl/publish-runtime-substrates.test.ts test/unit/etl/publish-search-snapshot.test.ts
pnpm --dir web test
```

## DoD

1. operator가 JSONL/psql 없이 proposal/ambiguity/suppression을 관리할 수 있다.
2. runtime-plane writer invariant는 유지된다.
3. publish lifecycle이 write-plane과 연결된다.
