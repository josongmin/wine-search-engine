# Jun 2 General Tickets — Entity Lookup And Ops Tooling

> 목적: [../rfc.md](../rfc.md)를 lookup hardening + 운영 도구 구현 티켓으로 분해한다.

## 필수 읽기

1. [../rfc.md](../rfc.md)
2. [../../../rfc/RFC-021-primitive-search-and-agent-orchestration.md](../../../rfc/RFC-021-primitive-search-and-agent-orchestration.md)
3. [../../../runbook-abbreviation-aliases.md](../../../runbook-abbreviation-aliases.md)
4. [../../../../AGENTS.md](../../../../AGENTS.md)
5. [../../../../CLAUDE.md](../../../../CLAUDE.md)

## 상태 표

| Ticket | 주제 | 상태 | 선행 | 핵심 출력 |
|---|---|---|---|---|
| `T-EL-01` | lookup admission gate | planned | 없음 | entity vs discovery front-door authority |
| `T-EL-02` | resolver abstain / short-noisy fail-close | planned | `T-EL-01` | wrong-positive suppression |
| `T-EL-03` | alias substrate governance / hot-entity coverage | planned | 없음 | curated alias governance + coverage audit |
| `T-EL-04` | operator debug API / runtime observability | planned | `T-EL-01`, `T-EL-02`, `T-EL-03` | trusted read-only ops surfaces |
| `T-EL-05` | ops web console | planned | `T-EL-04` | read-only lookup/alias debug UI |
| `T-EL-06` | curation write plane | planned | `T-EL-03`, `T-EL-04` | proposal/ambiguity/suppression staging UI/API |
| `T-EL-07` | proof rails / operator smoke | planned | `T-EL-01`, `T-EL-02`, `T-EL-03`, `T-EL-04`, `T-EL-05`, `T-EL-06` | hotset gate + smoke + closeout matrix |

## Wave

### Wave 1

- [T-EL-01](./T-EL-01-lookup-admission-gate-and-query-family-authority.md)
- [T-EL-02](./T-EL-02-resolver-abstain-and-short-noisy-fail-close.md)
- [T-EL-03](./T-EL-03-alias-substrate-governance-and-hot-entity-coverage.md)

### Wave 2

- [T-EL-04](./T-EL-04-operator-debug-api-and-runtime-observability.md)

### Wave 3

- [T-EL-05](./T-EL-05-ops-web-console-for-lookup-and-alias-debug.md)
- [T-EL-06](./T-EL-06-curation-write-plane-for-proposals-ambiguity-and-suppression.md)

### Wave 4

- [T-EL-07](./T-EL-07-proof-rails-hotset-eval-and-operator-smoke.md)

## 병렬성 규칙

1. `T-EL-01` 없이는 lookup front-door semantics가 고정되지 않는다.
2. `T-EL-02`는 `T-EL-01` 이후에만 의미가 있다. admission 없이 threshold만 조이면 concept query가 계속 wrong lane으로 들어간다.
3. `T-EL-03`은 `T-EL-01`과 병렬 가능하지만, hotset corpus는 `T-EL-02`의 fail-close semantics를 반영해야 한다.
4. `T-EL-04`는 read-plane contract이므로 lookup core/alias governance가 고정된 뒤에만 한다.
5. `T-EL-05`는 `T-EL-04`의 trusted API 없이는 시작하지 않는다.
6. `T-EL-06`은 runtime-plane direct write 금지 invariant를 지키기 위해 `T-EL-03`과 `T-EL-04` 이후만 허용한다.
7. `T-EL-07`은 마지막 closeout 전용이다.

## 공통 금지사항

1. lookup wrong-positive를 heuristic post-filter로만 덮는 것 금지
2. public product API에 operator debug payload를 노출하는 것 금지
3. `publish-runtime-substrates.ts` 외 코드가 runtime `aliases` / `ambiguity_registry`를 직접 수정하는 것 금지
4. alias hole을 prompt hack이나 search fallback으로 덮는 것 금지
5. `까쇼`류 concept query를 lookup precision failure로만 다루고 lane contract 문제를 무시하는 것 금지

## 공통 owning seam 규칙

1. lookup core 티켓은 `src/application/search/**`, `src/domain/resolver/**`, `src/domain/query/**` 안에서 닫아야 한다.
2. alias governance 티켓은 `scripts/etl/**`, `src/domain/alias/**`, `src/infrastructure/adapter/pg-alias-*`, `src/infrastructure/health/**` 안에서 닫아야 한다.
3. ops read-plane 티켓은 `src/interface/http/routes/**`, `src/interface/http/schemas/**`, `src/config/**` 안에서 닫아야 한다.
4. ops web 티켓은 `web/src/app/**`, `web/src/features/**`, `web/src/shared/api/**` 안에서 닫아야 한다.
5. write-plane 티켓은 staging/proposal/canonical plane만 만져야 하며 runtime-plane direct writer invariant를 깨면 안 된다.

## 공통 건드리지 말아야 할 것

1. unrelated deploy/runtime infra
   - `scripts/deploy/**`
2. unrelated agent orchestration core
   - `src/application/wine-search/**`
   - `src/interface/http/routes/wine-search*.ts`
3. unrelated public search ranking experiments
   - `src/domain/mixed/**`
   - `src/domain/ranking/**`
4. unrelated web marketing/search UX pages
   - `web/src/app/search/**`
   - `web/src/app/explore/**`

## 작업자용 최소 보고 포맷

1. owner-local green
2. live/infra-backed 미실행 rail
3. intentionally untouched layer
4. remaining compatibility residue

## 티켓 목록

- [T-EL-01 Lookup Admission Gate And Query-Family Authority](./T-EL-01-lookup-admission-gate-and-query-family-authority.md)
- [T-EL-02 Resolver Abstain And Short-Noisy Fail-Close](./T-EL-02-resolver-abstain-and-short-noisy-fail-close.md)
- [T-EL-03 Alias Substrate Governance And Hot-Entity Coverage](./T-EL-03-alias-substrate-governance-and-hot-entity-coverage.md)
- [T-EL-04 Operator Debug API And Runtime Observability](./T-EL-04-operator-debug-api-and-runtime-observability.md)
- [T-EL-05 Ops Web Console For Lookup And Alias Debug](./T-EL-05-ops-web-console-for-lookup-and-alias-debug.md)
- [T-EL-06 Curation Write Plane For Proposals Ambiguity And Suppression](./T-EL-06-curation-write-plane-for-proposals-ambiguity-and-suppression.md)
- [T-EL-07 Proof Rails Hotset Eval And Operator Smoke](./T-EL-07-proof-rails-hotset-eval-and-operator-smoke.md)
