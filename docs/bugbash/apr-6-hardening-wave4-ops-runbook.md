# Wave 4 Ops Runbook

`last_verified_at`: 2026-04-07

## Goal

support/oncall이 `authority_trace_ref`, `runtime_correlation_ref`, `execution_mode`, `blocking_eligible`, `degradation_reasons`를 실제 triage rail로 사용할 수 있게 절차를 고정한다.

## Trace Usage

- `runtime_correlation_ref`
  - request-scoped 로그 묶음 찾기
  - support/oncall 1차 추적 시작점
- `authority_trace_ref`
  - deterministic replay/audit/repro 시작점
  - 동일 authority lineage 비교 기준
- `snapshot_id`
  - replay 가능 여부와 snapshot mismatch 판정

## Triage Flow

1. 사용자 영향 확인
   - 결과가 비어 있는지, degrade 허용 가능한지, blocking flow인지 확인
2. request trace 확인
   - `runtime_correlation_ref`로 [search-usecase-post-route-phase.ts](/Users/songmin/wine-search-engine/src/application/search/search-usecase-post-route-phase.ts) emit 로그를 찾는다
3. execution contract 분류
   - `execution_mode`
   - `blocking_eligible`
   - `degradation_reasons`
4. known degraded state 판정
   - known fallback이면 escalation 없이 안내 가능
   - unknown reason이면 authority replay로 진행
5. deterministic replay / audit
   - `authority_trace_ref`와 `snapshot_id`로 replay/audit 검증
6. escalation 여부 결정
   - blocking-eligible degradation, unknown degradation reason, mismatch suspicion이면 escalation

## Known States

### `execution_mode=degraded`

- 확인:
  - `degradation_reasons`
  - `blocking_eligible`
  - specialized fallback 여부
- escalation 불필요:
  - known `producer_browse_fallback`
  - known `region_browse_fallback`
  - known `compare_candidates_fallback`
  - non-blocking eligible path
- escalation 필요:
  - blocking eligible인데 degraded
  - 반복적인 `reranker_unavailable`
  - replay에서 authority mismatch 의심

### `execution_mode=heuristic`

- 확인:
  - heuristic source가 known degraded-only path인지
  - user-visible 답변이 advisory인지
- escalation 필요:
  - heuristic가 blocking flow에 침범
  - expected authoritative route에서 heuristic 증가

### `blocking_eligible=false`

- 의미:
  - advisory/degraded 판단이 release-blocking failure와 동일하지 않다
- 조치:
  - support 응대는 가능하지만 release gate failure로 해석하지 않는다

### authoritative mismatch suspicion

- 조건:
  - `execution_mode=authoritative`인데 결과 일관성이 흔들림
  - `degradation_reasons` 없음
- 조치:
  - `authority_trace_ref`로 replay/audit 우선
  - `snapshot_id` decoder / mismatch 여부 확인

## Log Queries

### Search execution log lookup

- fields:
  - `runtime_correlation_ref`
  - `authority_trace_ref`
  - `execution_mode`
  - `degradation_reasons`
  - `specialized_route_requested`
  - `specialized_route_executed`
  - `fallback_applied`
  - `fallback_reason`

### Audit enrichment expectations

- valid ids:
  - `authority_trace_schema_version`
  - `snapshot_schema_version`
- invalid ids:
  - `invalid_authority_trace_ref_reason`
  - `invalid_snapshot_id_reason`

이 필드들은 [log-search-event.ts](/Users/songmin/wine-search-engine/src/observability/log-search-event.ts)에서 enrichment 된다.

## Sample Investigation Paths

### Case 1 — mixed degraded response

1. 응답의 `runtime_correlation_ref` 확보
2. log에서 `execution_mode=degraded`와 `degradation_reasons` 확인
3. `fallback_reason`이 known mixed fallback taxonomy인지 확인
4. blocking path면 escalation, 아니면 known degraded 안내

### Case 2 — replay complaint

1. 응답의 `authority_trace_ref`, `snapshot_id` 확보
2. replay fixture/audit path에서 decoder 통과 여부 확인
3. invalid id면 contract violation으로 escalation
4. valid id인데 mismatch면 `SNAPSHOT_MISMATCH` 또는 drift 의심으로 escalation

### Case 3 — degraded share spike in release review

1. eval artifact의 `release_report.degraded_query_share` 확인
2. `top_degradation_reasons`와 `specialized_fallback_summary`를 같이 본다
3. baseline 대비 `execution_mode_mix` delta가 증가했는지 확인
4. accuracy stable + degraded share up이면 advisory warning으로 분류

## Escalate When

- `blocking_eligible=true`인데 `execution_mode != authoritative`
- `invalid_authority_trace_ref_reason` 또는 `invalid_snapshot_id_reason` 존재
- `execution_mode=authoritative`인데 replay/audit mismatch suspicion 존재
- top degradation reason이 신규/unknown taxonomy

## Do Not Escalate When

- `blocking_eligible=false`이고 known specialized fallback reason만 존재
- advisory-only eval/report 증가이며 blocking metrics는 안정
- runtime log에서 known temporary degradation taxonomy가 명확히 확인됨

## Related Docs

- [Wave 4 Consumer Inventory](/Users/songmin/wine-search-engine/docs/bugbash/apr-6-hardening-wave4-consumer-inventory.md)
- [Wave 4 Deprecated-Field Migration Guide](/Users/songmin/wine-search-engine/docs/bugbash/apr-6-hardening-wave4-migration-guide.md)
- [RFC-014](/Users/songmin/wine-search-engine/docs/RFC-014.md)
- [RFC-008](/Users/songmin/wine-search-engine/docs/RFC-008.md)

## Eval Lane Notes

- local smoke-safe lane:
  - `npm run eval:offline:smoke:local`
- local full-dataset lane:
  - `npm run eval:offline:with-splits:local`
  - 기본 동작은 fail-closed
  - 이유: in-memory test server fixture corpus는 bronze 500 gold set과 entity universe가 다르다
- real serving / production-near eval:
  - `npm run eval:offline:with-splits`
  - search API target이 실제 serving environment를 가리켜야 한다
