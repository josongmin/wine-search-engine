# Pipeline debug `step` reference

The **source of truth** for allowed `step` string values is TypeScript:

**[`src/domain/observability/pipeline-debug-steps.ts`](../src/domain/observability/pipeline-debug-steps.ts)** — export `PipelineDebugStep` and type `PipelineDebugStepId`.

## Conventions

- Prefer the **domain.area.detail** shape (e.g. `decision.engine.response`, `http.embedding.timeout`).
- New call sites should use **`PipelineDebugStep.*`** constants to avoid typos and to make refactors grep-friendly.
- Legacy code may still use inline string literals; migrate when touching those lines.

## Canonical stage-field-set table (T-E10-02: Shortfall Timeline)

Each pipeline stage emits a consistent set of debug fields. This table documents the
**canonical field set** per stage so that shortfall timelines can be reconstructed from
structured logs. The TS type definition is in `src/domain/observability/pipeline-debug-steps.ts`
(`PipelineStageFieldSet`).

### Stage 1: Search entry

| Step | Fields | Source |
|------|--------|--------|
| `search.execute.start` | `eval_mode`, `query_len`, `query_preview` | `search.usecase.ts` |
| `search.pre_route.early_exit` | `query_type` | `search.usecase.ts` |
| `search.route_resolution` | `query_class`, `effective_route`, `compiled_retrieval_mode`, `planner_suggested_mode`, `retrieval_mode_source` | `search.usecase.ts` |

### Stage 2: Route dispatch

| Step | Fields | Source |
|------|--------|--------|
| `dispatch.route` | `effective_route` | `search-usecase-route-dispatch.ts` |
| `dispatch.entity.complete` | `resolve_status`, `ranked_count` | `search-usecase-route-dispatch.ts` |
| `dispatch.hybrid.complete` | `resolve_status`, `ranked_count` | `search-usecase-route-dispatch.ts` |
| `dispatch.mixed.complete` | `resolve_status`, `ranked_count` | `search-usecase-route-dispatch.ts` |

### Stage 3: Entity route

| Step | Fields | Source |
|------|--------|--------|
| `route.entity.only.start` | `query_class`, `resolver_candidate_count`, `blocker_seed_count` | `search.usecase.ts` |
| `route.entity.only.done` | `resolve_status`, `candidate_count`, `ranked_count`, `corrective_retry`, `outcome_reason_codes` (optional) | `search.usecase.ts` |

### Stage 4: Retrieval (hybrid/mixed)

| Step | Fields | Source |
|------|--------|--------|
| `retrieval.hybrid_candidates.start` | `retrieval_mode`, `query_class` | `search-usecase-hybrid-candidates.ts` |
| `retrieval.producer_browse` | `candidate_count`, `retrieval_provenance_satisfied` (optional), `retrieval_provenance_missing` (optional) | `search-usecase-hybrid-candidates.ts` |
| `retrieval.region_browse` | `candidate_count`, `retrieval_provenance_satisfied` (optional), `retrieval_provenance_missing` (optional) | `search-usecase-hybrid-candidates.ts` |
| `retrieval.compare_candidates` | `candidate_count`, `retrieval_provenance_satisfied` (optional), `retrieval_provenance_missing` (optional) | `search-usecase-hybrid-candidates.ts` |
| `retrieval.candidate_pool.fallback` | _(none)_ | `search-usecase-hybrid-candidates.ts` |
| `retrieval.candidate_pool.assembled` | _(varies by candidate pool implementation)_ | `candidate-pool.ts` |

### Stage 5: Anchor resolution (hybrid path)

| Step | Fields | Source |
|------|--------|--------|
| `resolver.anchor.missing` | `query_class` | `search-usecase-hybrid-ranking-pipeline.ts` |
| `resolver.anchor.start` | `query_class`, `resolver_candidate_count`, `blocker_seed_count` | `search-usecase-hybrid-ranking-pipeline.ts` |
| `resolver.anchor.done` | `resolve_status`, `candidate_count` | `search-usecase-hybrid-ranking-pipeline.ts` |

### Stage 6: Ranking

| Step | Fields | Source |
|------|--------|--------|
| `ranking.hybrid.complete` | `query_class`, `input_candidates`, `ranked_count`, `has_funnel_metrics`, `provenance_satisfied` (optional), `provenance_missing` (optional) | `search-usecase-hybrid-ranking-pipeline.ts` |

### Stage 7: Decision

| Step | Fields | Source |
|------|--------|--------|
| `decision.phase.enter` | `effective_route`, `resolve_status`, `ranked_count` | `search-usecase-post-route-phase.ts` |
| `decision.engine.request` | `query_class` | `search-usecase-post-route-phase.ts` |
| `decision.engine.response` | `decision_status`, `next_action`, `decision_confidence`, `failure_reason` (optional) | `search-usecase-post-route-phase.ts` |

### Stage 8: Post-route

| Step | Fields | Source |
|------|--------|--------|
| `post_route.enter` | `effective_route`, `resolve_status`, `ranked_count` | `search-usecase-post-route-phase.ts` |
| `post_route.entropy_abstain` | `effective_route`, `abstain_reason`, `entropy` (optional), `score_count`, `top_score_source` | `search-usecase-post-route-phase.ts` |
| `post_route.entropy_abstain_bypassed` | `effective_route`, `bypass_reason` | `search-usecase-post-route-phase.ts` |
| `cache.set_skipped` | `reason` | `search-usecase-post-route-phase.ts` |

### Stage 9: Completion

| Step | Fields | Source |
|------|--------|--------|
| `search.execute.done` | `latency_ms`, `ranked_count`, `resolve_status` | `search.usecase.ts` |

### Resolve / interpret (planner phase)

| Step | Fields | Source |
|------|--------|--------|
| `resolve.use_case.start` | `query_class` | `resolve.usecase.ts` |
| `resolve.constraint_sat.contradicted` | `contradiction_reason` | `resolve.usecase.ts` |
| `resolve.use_case.done` | `resolve_status`, `candidate_count` | `resolve.usecase.ts` |
| `interpret.planner.done` | `query_class`, `planner_status` | `interpret-planner.ts` |

### Hybrid execution (use case entry)

| Step | Fields | Source |
|------|--------|--------|
| `hybrid.execute.start` | `query_class`, `retrieval_mode` | `hybrid.usecase.ts` |
| `hybrid.execute.ranked` | `ranked_count`, `latency_ms` | `hybrid.usecase.ts` |

### Batch

| Step | Fields | Source |
|------|--------|--------|
| `batch.search.start` | `batch_size` | `batch-search.usecase.ts` |

### Infrastructure HTTP steps

| Step | Fields | Source |
|------|--------|--------|
| `http.embedding.ok` | `model`, `dimension`, `token_count` (varies) | `openai-embedding-service.ts` |
| `http.embedding.http_error` | `http_status` | `openai-embedding-service.ts` |
| `http.embedding.timeout` | _(abort reason)_ | `openai-embedding-service.ts` |
| `http.embedding.network_error` | `err_name` | `openai-embedding-service.ts` |
| `http.embedding.parse_error` | `err_name` | `openai-embedding-service.ts` |
| `http.reranker.ok` | `model`, `result_count` (varies) | `cohere-reranker.ts` |
| `http.reranker.http_error` | `http_status` | `cohere-reranker.ts` |
| `http.reranker.timeout` | _(abort reason)_ | `cohere-reranker.ts` |
| `http.reranker.network_error` | `err_name` | `cohere-reranker.ts` |
| `http.reranker.parse_error` | `err_name` | `cohere-reranker.ts` |
| `vespa.query` | `query_type`, `latency_ms` (varies) | `vespa-client.ts` |

### Pre-route special paths

| Step | Fields | Source |
|------|--------|--------|
| `pre_route.decomposed_comparison` | `decomposition_strategy`, `timed_out` (optional) | `search-usecase-pre-route-phase.ts` |
| `pre_route.constraint_contradiction` | _(contradiction details)_ | `search-usecase-pre-route-phase.ts` |
| `pre_route.cache_hit` | _(cache key info)_ | `search-usecase-pre-route-phase.ts` |
| `pre_route.continue` | _(none)_ | `search-usecase-pre-route-phase.ts` |

## Shortfall timeline reconstruction

To reconstruct a stage-by-stage shortfall timeline from structured logs:

1. Filter for `pipeline_debug: true` and the target `request_id`.
2. Sort by log timestamp.
3. Map each `step` to its stage (1-9 above).
4. For each stage, check that all canonical fields are present.
5. Missing stages indicate where the pipeline exited early or degraded.

**Example shortfall**: if `retrieval.hybrid_candidates.start` is present but
`ranking.hybrid.complete` is absent, retrieval succeeded but ranking failed
or was skipped -- investigate the gap between stages 4 and 6.

## Corrective-retry, retrieval-critic & bundle-selector steps

Promoted from inline string literals to `PipelineDebugStep` constants during the SSoT codemod. Field sets vary by callsite; treat the `.ts` source as authoritative.

| Step | Fields | Source |
|------|--------|--------|
| `search.execute.stage_timings` | _(per-stage `latency_ms` map)_ | `search.usecase.ts` |
| `route.entity.corrective_retry.start` | _(varies)_ | `search.usecase.ts` |
| `route.entity.corrective_retry.candidates` | _(varies)_ | `search.usecase.ts` |
| `retrieval.critic.decision` | _(varies)_ | `search-usecase-graph-executor.ts` |
| `retrieval.critic.budget_exhausted` | _(varies)_ | `search-usecase-graph-executor.ts` |
| `retrieval.critic.rewriter_declined` | _(varies)_ | `search-usecase-graph-executor.ts` |
| `retrieval.critic.retries_exhausted` | _(varies)_ | `search-usecase-graph-executor.ts` |
| `retrieval.bundle_selector.engage` | _(varies)_ | `search-usecase-graph-executor.ts` |
| `retrieval.bundle_selector.subquery_fail_closed` | _(varies)_ | `search-usecase-graph-executor.ts` |
| `retrieval.bundle_selector.fail_closed` | _(varies)_ | `search-usecase-graph-executor.ts` |
| `retrieval.bundle_selector.budget_violation` | _(varies)_ | `search-usecase-graph-executor.ts` |

## Why this file exists

Human-readable index next to the TS module: operators can skim categories; agents should still treat the **`.ts` file** as authoritative when they differ.

## Related

- [debug-mode.md](./debug-mode.md) — how to turn on HTTP debug mode and interpret logs.
- [llm-debugging-playbook.md](./llm-debugging-playbook.md) — symptom-to-step lookup for agents.
