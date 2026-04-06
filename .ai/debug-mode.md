# HTTP debug mode & pipeline debug logging

Use this when you need **verbose request-scoped logs** for the search/resolve/interpret/batch pipeline without changing code.

**LLM / agent autonomous debugging:** start from **[`llm-debugging-playbook.md`](./llm-debugging-playbook.md)** (log shape, typical `step` order, symptom → where to look, grep examples).

## Enable on the server

1. Set environment variable **`HTTP_DEBUG_SECRET`** to a non-empty string (**at least 16 characters** — validated in `src/config/env.ts`).
2. Restart the API process so config reloads.
3. If the secret is unset or empty, header-based debug is **fully disabled** (no `X-Debug-Key` check runs).

Do **not** commit real secrets; use local `.env` or your secret manager.

## Per-request activation (clients)

Send the same value as the secret in the request header:

```http
X-Debug-Key: <your HTTP_DEBUG_SECRET value>
```

**Response when debug is active:** header `X-Debug-Active: 1`.

Comparison uses a **constant-time** equality check (`timingSafeEqual`); avoid logging the header value.

## What changes when debug is on

Implemented in `src/interface/http/middleware/http-debug-mode.ts`:

| Effect | Detail |
|--------|--------|
| `request.debugRequest` | `true` |
| Request logger | Child logger at level **`debug`**, binding `debug_request: true` |
| Contract routes | Handlers run inside `runWithRequestPipelineDebug` (`src/interface/http/routes/register-contract-route.ts`) so downstream code can call `pipelineDebug()` / `pipelineTrace()` with **AsyncLocalStorage** context |

**Hook order:** `registerHttpDebugMode` runs **before** `registerRequestContext` so `request_start` uses the per-request log level when debug is active (`src/interface/http/server.ts`).

## Pipeline debug log lines (structured)

Helpers live in `src/observability/request-pipeline-debug.ts`.

| Helper | Role |
|--------|------|
| **`pipelineDebug(payload, msg)`** | Emits only when `debugRequest === true` and ALS is set. Writes to the **Fastify request logger** at `debug` with `pipeline_debug: true`, `request_id`, plus `payload`. |
| **`pipelineTrace(step, msg, extra?)`** | Thin wrapper: sets `step` on the payload (same emission rules). |
| **`sanitizeQueryForDebug(raw)`** | Truncates/normalizes query text (avoid huge blobs in logs). |

**Canonical `step` strings:** `PipelineDebugStep` in **`src/observability/pipeline-debug-steps.ts`** — use these for new instrumentation; see also [pipeline-debug-steps.md](./pipeline-debug-steps.md).

**Finding logs:** filter JSON logs for `pipeline_debug: true` and/or `step` (e.g. `decision.engine.response`, `http.embedding.ok`, `http.reranker.http_error`).

### HTTP client outcomes (embedding / reranker)

When a search request runs with debug mode, infrastructure HTTP adapters may emit:

| `step` (examples) | Meaning |
|-------------------|---------|
| `http.embedding.ok` / `http.reranker.ok` | 2xx and body parsed successfully |
| `*.http_error` | Non-2xx (includes `http_status`, no response body in log) |
| `*.timeout` | Request aborted due to timeout |
| `*.network_error` | Fetch threw (non-abort) before response |
| `*.parse_error` | HTTP OK but JSON/shape parse failed |

Success lines are emitted **after** successful parse, so you do not get a false `*.ok` before a parse failure.

## Scope & limitations

### In scope (ALS + request logger)

Routes registered with **`registerContractRoute`** (search, hybrid, interpret, resolve, batch, feedback, health, watchlist, replay, claude-tools, etc.) run the handler inside `runWithRequestPipelineDebug`, so the async continuation chain from that handler can emit `pipelineDebug`.

### Out of scope (no pipeline ALS)

| Case | Detail |
|------|--------|
| **Non-contract routes** | e.g. **`GET /openapi.json`** (`openapi.route.ts`) — not wrapped; `pipelineDebug` is a no-op (no store). |
| **Code outside the handler chain** | Background jobs, CLI, or unit tests without `runWithRequestPipelineDebug`. |
| **Batch search — parallel sub-requests** | The batch orchestrator may log `batch.search.start` when the **HTTP** request has debug mode. Each **concurrent** `SearchUseCase.execute` inside `Promise.all` may **not** reliably inherit the same ALS context as the parent in all Node scheduling cases. Treat per-item `pipelineDebug` lines inside parallel batch items as **best-effort**, not guaranteed. |

## Security notes

- Treat `HTTP_DEBUG_SECRET` like a password: rotate if leaked, restrict who can set `X-Debug-Key`.
- Debug mode increases log volume and may include operational metadata (routes, counts, timings, model ids). Do not enable globally in production without guardrails.

## Verification

- **Integration:** `test/integration/http/server.test.ts` — `X-Debug-Key` / `X-Debug-Active` behavior.
- **Unit:** `src/observability/__tests__/request-pipeline-debug.test.ts` — ALS, `pipelineDebug` / `pipelineTrace` emission shape, no-op when debug off or no ALS.

## Code references

| Area | File |
|------|------|
| Env & validation | `src/config/env.ts` (`HTTP_DEBUG_SECRET`) |
| Middleware | `src/interface/http/middleware/http-debug-mode.ts` |
| ALS & helpers | `src/observability/request-pipeline-debug.ts` |
| Step constants | `src/observability/pipeline-debug-steps.ts` |
| Route wrapping | `src/interface/http/routes/register-contract-route.ts` |
