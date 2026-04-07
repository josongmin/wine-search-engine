# Wave 4 Consumer Inventory

`last_verified_at`: 2026-04-07

## Repo Internal

| consumer_name | location | surface | reads_decision_trace_ref | reads_authority_trace_ref | reads_runtime_correlation_ref | reads_execution_mode | reads_blocking_eligible | reads_degradation_reasons | migration_status | owner | notes |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| Search API e2e contract | `test/e2e/search-api.test.ts` | http | yes | yes | yes | yes | yes | yes | partial | engine | Phase A co-exposure still asserted. |
| Edge-case HTTP contract | `test/e2e/edge-cases.test.ts` | http | yes | no | no | no | no | no | not_started | engine | Still checks deprecated `decision_trace_ref` directly. |
| Search response Zod schema | `src/interface/http/schemas/search-response.schema.ts` | http | yes | yes | yes | yes | yes | yes | partial | engine | Deprecated `decision_trace_ref` retained in schema. |
| Replay fixture HTTP subset | `test/e2e/search-replay-fixtures.test.ts` | eval | no | yes | yes | yes | no | yes | partial | engine | Self-contained lane asserts `authority_trace_ref` / `runtime_correlation_ref` presence through fixture helper; runtime-required lane lives in a dedicated suite. |
| Replay fixture loader | `test/replay-fixtures/search/run-search-fixture.ts` | eval | no | no | no | yes | no | yes | complete | engine | Wave 4 fixture v2 contract. |
| Search pipeline log emission | `src/application/search/search-usecase-post-route-phase.ts` | ops | no | yes | yes | yes | no | yes | complete | engine | Structured log emit path uses new honesty fields. |
| Search log schema | `src/observability/search-log-schema.ts` | ops | no | yes | yes | yes | yes | yes | partial | engine | Includes `runtime_correlation_ref`, `blocking_eligible`, and specialized fallback SSOT fields. |
| Eval pipeline output | `src/infrastructure/adapter/search-pipeline-evaluator.ts` | eval | no | no | no | yes | yes | yes | partial | engine | Consumes `executionMode`, `blockingEligible`, and `degradationReasons`; trace refs are still not surfaced here. |
| Resolve route contract | `src/application/search/resolve-response.dto.ts` | internal | yes | no | no | no | no | no | not_started | engine | Separate resolve contract still emits only deprecated field. |

## Known External / Downstream

| consumer_name | location | surface | reads_decision_trace_ref | reads_authority_trace_ref | reads_runtime_correlation_ref | reads_execution_mode | reads_blocking_eligible | reads_degradation_reasons | migration_status | owner | notes |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|---|
| RFC-014 example payloads | `docs/RFC-014.md` | docs | yes | yes | yes | yes | yes | yes | partial | docs | Examples still show deprecated and new fields together. |
| RFC-008 compatibility notes | `docs/RFC-008.md` | docs | yes | yes | no | no | no | no | partial | docs | Migration lifecycle documented, removal not complete. |
| Wave 3 hardening doc | `docs/bugbash/apr-6-hardening-wave3.md` | docs | yes | yes | yes | yes | yes | yes | retired | docs | Historical archive/reference only; excluded from active deprecated-field removal gate. |

## Evidence Commands

- `rg -n "decision_trace_ref|authority_trace_ref|runtime_correlation_ref|execution_mode|blocking_eligible|degradation_reasons" src test docs -g '*.*'`
- `rg -n "search replay fixtures|run-search-fixture" test -g '*.*'`
