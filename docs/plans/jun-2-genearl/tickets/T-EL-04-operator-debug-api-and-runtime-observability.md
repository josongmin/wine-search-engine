# T-EL-04 Operator Debug API And Runtime Observability

## 목표

operator가 `lookup query -> alias hits -> blocker -> candidates -> scores -> final decision`을 public product API와 분리된 trusted surface로 직접 볼 수 있게 한다.

## 현재 근거

- internal resolve route는 있으나 operator-grade audit contract는 아니다: [src/interface/http/routes/resolve.route.ts](../../../../src/interface/http/routes/resolve.route.ts)
- public response schema에는 debug trace가 일부 있지만 explicit ops contract는 없다: [src/interface/http/schemas/search-response.schema.ts](../../../../src/interface/http/schemas/search-response.schema.ts)
- readiness는 snapshot/alias 관련 일부 정보만 표면화한다: [src/config/readiness.ts](../../../../src/config/readiness.ts)
- `wine-search-lab`는 agent/debug 성격의 UI 예시를 이미 가진다: [web/src/app/wine-search-lab/page.tsx](../../../../web/src/app/wine-search-lab/page.tsx)

## 선행 티켓

- [T-EL-01](./T-EL-01-lookup-admission-gate-and-query-family-authority.md)
- [T-EL-02](./T-EL-02-resolver-abstain-and-short-noisy-fail-close.md)
- [T-EL-03](./T-EL-03-alias-substrate-governance-and-hot-entity-coverage.md)

## 정확한 산출물

1. trusted read-only ops routes:
   - `POST /internal/ops/entity-lookup/debug`
   - `GET /internal/ops/alias-audit`
   - `GET /internal/ops/snapshot-alias-health`
2. explicit contract/schema
3. debug-key / trusted-plane auth
4. runtime observability payload with reason codes

## 반드시 건드릴 파일

1. `src/interface/http/routes/route-contracts.ts`
2. `src/interface/http/routes/route-deps.ts`
3. `src/interface/http/schemas/search-response.schema.ts`
4. `src/config/readiness.ts`
5. `src/interface/http/server.ts`

## 가능하면 건드리지 말아야 할 파일 / 레이어

1. `src/interface/http/routes/primitive-search.route.ts`
2. `src/application/wine-search/**`
3. `web/**`

## 구현 범위

1. read-only operator contracts
2. lookup debug view-model adapter
3. alias audit payload
4. snapshot alias health payload
5. auth and redaction rules

## 구현 제외 범위

1. web UI
2. write-plane mutation
3. ranking logic rewrite

## 구조 규칙

1. operator API는 public product contract와 분리한다.
2. read-only surface는 runtime-plane writer invariant를 깨지 않는다.
3. ops payload는 raw internal shape dump가 아니라 stable view-model contract여야 한다.

## 절대 하지 말아야 할 구현

1. public `/v1/lookup/wine`에 debug-only payload를 얹는 것
2. debug endpoint가 publish/mutate side effect를 가지는 것
3. ops surface auth를 생략하는 것

## 실패 패턴

1. trace는 많은데 operator가 alias/source/top2 margin을 읽기 어렵다
2. read-only라고 해놓고 hidden mutation이 있다
3. route contract가 없어 FE와 drift한다

## 검증 명령

```bash
pnpm run typecheck
pnpm run test:integration:file -- test/integration/http/routes/primitive-search.route.test.ts
pnpm exec vitest run src/config/__tests__/readiness*.test.ts
```

## DoD

1. operator가 trusted surface 하나로 lookup decision spine을 볼 수 있다.
2. alias audit와 snapshot alias health가 API contract로 고정된다.
3. public product surface와 ops surface가 분리된다.
