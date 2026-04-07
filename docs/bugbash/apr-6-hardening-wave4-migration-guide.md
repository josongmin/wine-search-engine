# Wave 4 Deprecated-Field Migration Guide

`last_verified_at`: 2026-04-07

## Goal

`decision_trace_ref`를 즉시 지우는 것이 아니라, `authority_trace_ref` / `runtime_correlation_ref` / `execution_mode` / `blocking_eligible` / `degradation_reasons`를 소비 기준 SSOT로 승격하고 제거 조건을 문서로 고정한다.

이 문서는 [Wave 4 Consumer Inventory](/Users/songmin/wine-search-engine/docs/bugbash/apr-6-hardening-wave4-consumer-inventory.md)를 실행 체크리스트로 사용한다.

## Field Roles

- `decision_trace_ref`
  deprecated 호환 필드. Phase A/B 동안만 유지한다.
- `authority_trace_ref`
  결정론적 authority trace. replay, audit, cache, regression triage의 기준 식별자다.
- `runtime_correlation_ref`
  비결정론적 runtime correlation id. request-scoped logging, support, oncall 추적용이다.
- `execution_mode`
  `authoritative | degraded | heuristic | advisory` honesty contract.
- `blocking_eligible`
  gate/blocking 해석 분리용 구조적 플래그.
- `degradation_reasons`
  fallback/degradation taxonomy의 structured surface.

## Lifecycle

### Phase A — Co-exposure

- Producer behavior:
  - `decision_trace_ref`와 `authority_trace_ref`를 함께 노출한다.
  - `runtime_correlation_ref`, `execution_mode`, `blocking_eligible`, `degradation_reasons`를 구조적으로 포함한다.
- Consumer required action:
  - 새 consumer는 `decision_trace_ref`를 신규 의존성으로 추가하지 않는다.
  - 기존 consumer는 `authority_trace_ref`와 `runtime_correlation_ref`를 분리 사용하도록 전환을 시작한다.
- Compatibility expectation:
  - `decision_trace_ref`는 여전히 존재하지만 canonical trace 의미는 `authority_trace_ref`가 가진다.
- Removal gate:
  - inventory에서 `reads_decision_trace_ref = yes` row가 `partial` 이상으로 이동해야 한다.

### Phase B — Deprecated read freeze

- Producer behavior:
  - `decision_trace_ref`는 optional/deprecated로만 유지한다.
  - docs/examples/tests는 `authority_trace_ref`를 주 기준으로 서술한다.
- Consumer required action:
  - `decision_trace_ref` 읽기를 fallback path로만 제한한다.
  - replay/audit/support 절차는 `authority_trace_ref` + `runtime_correlation_ref` 기준으로 운영한다.
- Compatibility expectation:
  - old field는 읽을 수 있으나, semantic authority는 더 이상 제공하지 않는다.
- Removal gate:
  - repo-internal consumer에서 `reads_decision_trace_ref = yes`가 schema-compat surface를 제외하고 0이 되어야 한다.

### Phase C — Removal

- Producer behavior:
  - `decision_trace_ref` 제거.
- Consumer required action:
  - old field 의존 consumer는 제거 전에 모두 `complete` 상태여야 한다.
- Compatibility expectation:
  - breaking change. major contract bump와 함께만 가능하다.
- Removal gate:
  - inventory의 deprecated consumer row가 모두 `complete` 또는 explicit `retired`.
  - RFC-008 / RFC-014 / examples / e2e contract가 모두 removal lifecycle과 일치.

## Consumer Checklist

### HTTP / Contract Consumers

- [search-api.test.ts](/Users/songmin/wine-search-engine/test/e2e/search-api.test.ts)
  - Phase A co-exposure assertion 유지 가능
  - 새 assertion은 `authority_trace_ref`, `runtime_correlation_ref`, `execution_mode`, `blocking_eligible`, `degradation_reasons` 기준으로 확장
- [edge-cases.test.ts](/Users/songmin/wine-search-engine/test/e2e/edge-cases.test.ts)
  - `decision_trace_ref` 단독 assertion 제거 필요
- [search-response.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response.schema.ts)
  - deprecated description 유지
  - removal은 Phase C에서만

### Replay / Eval / Ops Consumers

- [run-search-fixture.ts](/Users/songmin/wine-search-engine/test/replay-fixtures/search/run-search-fixture.ts)
  - `authority_trace_ref` / `snapshot_id` decoder 기준 유지
- [search-log-schema.ts](/Users/songmin/wine-search-engine/src/observability/search-log-schema.ts)
  - `authority_trace_ref`, `runtime_correlation_ref`, `execution_mode`, `degradation_reasons`를 canonical ops surface로 사용
- [run-offline-eval.ts](/Users/songmin/wine-search-engine/scripts/eval/run-offline-eval.ts)
  - execution-mode / blocking-eligible / degradation histogram을 SSOT로 사용

## Example Payload Guidance

### Replay / Audit lookup

1. `authority_trace_ref`로 deterministic execution lineage를 찾는다.
2. `snapshot_id`로 replay/audit schema version과 runtime snapshot을 비교한다.
3. `runtime_correlation_ref`로 request log fan-out을 추적한다.

### Support / Oncall lookup

1. `runtime_correlation_ref`로 request-scoped log를 찾는다.
2. `execution_mode`와 `degradation_reasons`로 known degraded state 여부를 먼저 판정한다.
3. authority replay가 필요하면 `authority_trace_ref`로 replay fixture / audit trail을 조회한다.

## Current Status Summary

- `partial`
  - [search-api.test.ts](/Users/songmin/wine-search-engine/test/e2e/search-api.test.ts)
  - [search-response.schema.ts](/Users/songmin/wine-search-engine/src/interface/http/schemas/search-response.schema.ts)
  - [docs/RFC-014.md](/Users/songmin/wine-search-engine/docs/RFC-014.md)
  - [docs/RFC-008.md](/Users/songmin/wine-search-engine/docs/RFC-008.md)
- `not_started`
  - [edge-cases.test.ts](/Users/songmin/wine-search-engine/test/e2e/edge-cases.test.ts)
  - [resolve-response.dto.ts](/Users/songmin/wine-search-engine/src/application/search/resolve-response.dto.ts)

## Operational Note

Wave 4 local eval lanes는 deprecated-field migration 상태와 직접 연결되지는 않지만, support/oncall 재현 절차와는 연결된다.

- fixture-compatible local repro:
  - `npm run eval:offline:smoke:local`
- real serving target repro:
  - `npm run eval:offline:with-splits`

## Retired Historical Consumers

아래 consumer는 active deprecated-field removal gate에서 제외된다. `migration_status = retired`로 inventory에 고정.

- [apr-6-hardening-wave3.md](/Users/songmin/wine-search-engine/docs/bugbash/apr-6-hardening-wave3.md)
  — historical archive/reference consumer; deprecated co-exposure 서술이 남아 있지만 active removal gate에서는 제외.

이 목록은 inventory의 deprecated consumer row가 모두 `complete` 또는 explicit `retired` 상태임을 확인한 이후 closed 상태로 유지한다.

## Decision Rule

`decision_trace_ref` 제거 여부는 “필드가 optional인지”가 아니라 아래를 모두 만족하는지로 판단한다.

- inventory row 기준 deprecated consumer가 `complete`
- replay/audit/support 절차가 `authority_trace_ref` / `runtime_correlation_ref` 기준으로 문서화 완료
- RFC-008 / RFC-014 example payload와 e2e contract가 Phase C lifecycle과 일치
