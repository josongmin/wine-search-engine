# LLM debugging playbook (search pipeline)

Use this when an **automated agent** (Cursor, Codex, Claude, etc.) must **trace a single HTTP request** through the wine search backend without guessing.

**Prerequisites (human or CI):** read [`debug-mode.md`](./debug-mode.md) first — how to enable `HTTP_DEBUG_SECRET` and `X-Debug-Key`.

---

## 1. Confirm debug mode is actually on

| Check | Pass |
|-------|------|
| Response header | `X-Debug-Active: 1` |
| Log lines include | `"debug_request":true` on the request child logger (bindings) |
| Pipeline lines include | `"pipeline_debug":true` |

If `X-Debug-Active` is missing: wrong/missing header, secret not set, or secret shorter than 16 characters (env validation) — see `src/config/env.ts`.

---

## 2. Log record shape (what to grep for)

Every `pipelineDebug` line is a **Pino `debug` log** whose first argument (object) includes at minimum:

```json
{
  "pipeline_debug": true,
  "request_id": "<correlates with X-Request-Id>",
  "step": "<string — use PipelineDebugStep in src/observability/pipeline-debug-steps.ts>",
  "msg": "<human message — second argument to pipelineDebug>"
}
```

Additional fields are **step-specific** (e.g. `effective_route`, `latency_ms`, `http_status`, `decision_status`).

**Filter examples** (run from repo root; adjust for your log sink):

```bash
# All pipeline debug lines
rg '"pipeline_debug":true' your.log

# One request
rg '"request_id":"YOUR_REQUEST_ID"' your.log

# One step family
rg '"step":"http\.embedding\.' your.log
rg '"step":"decision\.engine\.' your.log
```

Do **not** paste real `X-Debug-Key` or `.env` values into issues or chat logs.

---

## 3. Typical `step` order (happy path — search)

Not every request runs every step; use this as a **mental model**, not a strict contract.

1. `search.execute.start` — use case entered  
2. Pre-route: `pre_route.*` or early exit `search.pre_route.early_exit`  
3. `search.route_resolution` — planner route vs effective route  
4. `dispatch.route` → `dispatch.{entity|hybrid|mixed}.complete`  
5. Retrieval: `retrieval.*`, `vespa.query`, `http.embedding.*`, `http.reranker.*` as applicable  
6. `decision.phase.enter` → `decision.engine.request` → `decision.engine.response`  
7. `post_route.enter` (or `post_route.entropy_abstain` if entropy gate fires)  
8. `search.execute.done`

**Resolve-only** (`/v1/resolve` style): `resolve.use_case.start` → … → `resolve.use_case.done` (no ranking steps).

**Interpret-only**: `interpret.planner.done` after planner.

---

## 4. Symptom → what to inspect first

| Symptom | Look at `step` / area | Code / notes |
|--------|------------------------|--------------|
| Empty or wrong results | `decision.engine.response` — `decision_status`, `next_action` | `runRankedRouteDecisionPhase` in `search-usecase-post-route-phase.ts` |
| Clarification / abstain | `post_route.entropy_abstain` | RFC-013 entropy; `top_k` scores in payload context |
| Planner vs API route mismatch | `search.route_resolution` | `effective_route`, `plan_route`, `retrieval_mode_source` |
| Vespa down / slow | `vespa.query` missing; Vespa errors outside pipeline_debug | `src/infrastructure/vespa/vespa-client.ts` |
| Embedding failures | `http.embedding.http_error`, `timeout`, `parse_error` | `HttpEmbeddingService`, `OpenAiEmbeddingService` |
| Reranker failures | `http.reranker.*` | `HttpCrossEncoderReranker` |
| Entity anchor missing in hybrid | `resolver.anchor.missing` | Resolver not configured |
| Batch: only batch line, sparse inner steps | **Expected risk** | Parallel batch may not propagate ALS to every sub-call — see [`debug-mode.md`](./debug-mode.md) “Batch search” |

---

## 5. Common agent mistakes (avoid)

1. **Assuming** every route emits pipeline lines — only **`registerContractRoute`** wraps ALS; e.g. raw OpenAPI JSON route does not.  
2. **Expecting** full `pipeline_debug` inside **parallel batch** sub-requests — best-effort only.  
3. **Treating** `http.*.ok` before a failure — success lines are emitted **after** parse for HTTP clients; if you see `*.parse_error`, there was no successful `*.ok` for that call.  
4. **Logging** the debug secret or full user PII — use `sanitizeQueryForDebug` patterns; never echo env secrets.

---

## 6. Source files (jump targets)

| Concern | File |
|---------|------|
| ALS + helpers | `src/observability/request-pipeline-debug.ts` |
| Step name constants | `src/observability/pipeline-debug-steps.ts` |
| HTTP debug header | `src/interface/http/middleware/http-debug-mode.ts` |
| Route wrap | `src/interface/http/routes/register-contract-route.ts` |
| Server hook order | `src/interface/http/server.ts` |

---

## 7. Related docs

- [`debug-mode.md`](./debug-mode.md) — operator setup, limitations, verification  
- [`pipeline-debug-steps.md`](./pipeline-debug-steps.md) — step catalog index  
- [`README.md`](./README.md) — `.ai/` index  
