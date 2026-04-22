# Replay fixtures — search corpus

## Purpose

Representative query corpus for replay and golden-set testing. Each fixture captures a request and its expected response shape so that regressions in routing, execution mode, or degradation behavior are caught at PR time.

## Coverage axes

| Axis | Description |
|------|-------------|
| Entity (exact/fuzzy) | Queries that resolve to a single known wine entity |
| Hybrid (constraint) | Queries with structured constraints (price, region, grape) |
| Mixed (similarity) | Queries combining entity references with similarity search |
| Comparison | Multi-wine comparison queries ("X vs Y") |
| Error/degradation | Timeout, fallback, and degraded-mode scenarios |

## Fixture structure

Each fixture JSON contains:

- **`request`** — the HTTP request body sent to the endpoint
- **`assertions`** / **`expected`** — fields checked for drift

### Drift classification

- **Result drift** — changes in user-visible output: `execution_mode`, `degradation_reasons`, `result_type`, `error_code`
- **Trace drift** — changes in internal pipeline behavior: `authority_trace_ref`, `runtime_correlation_ref`

## Fixture index

| File | Route type |
|------|------------|
| `exact-entity.json` | Entity (exact) |
| `exact-entity-replay.json` | Entity (replay) |
| `noisy-entity.json` | Entity (fuzzy/noisy) |
| `transliteration-ko-en.json` | Entity (Korean transliteration) |
| `ambiguous-vintage.json` | Entity (ambiguous) |
| `deterministic-drinking-window.json` | Hybrid (constraint) |
| `deterministic-drinking-window-full-runtime.json` | Hybrid (constraint, full runtime) |
| `comparison-two-wines.json` | Comparison |
| `learned-matcher-timeout.json` | Error/degradation (timeout) |
| `reranker-timeout.json` | Error/degradation (timeout) |
