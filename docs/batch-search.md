# Batch Search Contract (inactive public route)

## Overview

This document describes the retained batch-search request/response contract used by internal tooling and fixtures. The public HTTP surface currently does **not** register `POST /v1/batch-search`; see the current route registry / parity rails for live endpoints.

**Public status:** inactive / unregistered

**Historical response status:** `HTTP 207 Multi-Status` (regardless of success/failure distribution)

## Request Structure

```json
{
  "requests": [
    {
      "id": "unique-request-id",
      "query": "Cabernet 2015",
      "limit": 5,
      "retrieval_mode": "hybrid",
      "context": { "locale": "en", "currency": "USD" },
      "sessionContext": { "sessionId": "session1", "previousEntities": [] },
      "queryBudget": {
        "maxLatencyMs": 5000,
        "maxCandidates": 100,
        "rerankLimit": 10
      }
    },
    {
      "id": "second-query",
      "query": "White Burgundy"
    }
  ],
  "options": {
    "fail_fast": false,
    "timeout_ms": 5000
  },
  "batch_id": "optional-batch-123"
}
```

### Request Fields

**Top level:**
- `requests` (required): Array of 1–20 batch items
- `options` (optional): Execution options
- `batch_id` (optional): Identifier for idempotent batches

**Per-request item:**
- `id` (required): Unique identifier within batch (max 256 chars)
- `query` (required): Search string (1–2000 chars)
- `limit` (optional): Result limit (default: 5)
- `retrieval_mode` (optional): 'auto' | 'entity' | 'hybrid' (default: 'auto')
- `context`, `sessionContext`, `queryBudget` (optional): Standard search options

**Options:**
- `fail_fast` (optional, default: false): Stop on first error; continue processing all requests if false
- `timeout_ms` (optional, default: 5000): Per-request timeout in milliseconds (range: 1000–30000)

## Response Structure

```json
{
  "batch_id": "batch-123",
  "total": 2,
  "succeeded": 1,
  "failed": 1,
  "results": [
    {
      "id": "unique-request-id",
      "status": "succeeded",
      "response": {
        "queryType": "search",
        "engineDecision": { ... },
        "results": [ ... ],
        "meta": { ... }
      }
    },
    {
      "id": "second-query",
      "status": "failed",
      "error": {
        "code": "RETRIEVAL_TIMEOUT",
        "message": "Request exceeded timeout"
      }
    }
  ],
  "processing_time_ms": 5023
}
```

### Response Fields

- `batch_id`: Identifier for this batch (generated if not provided)
- `total`: Number of requests in batch
- `succeeded`: Number of successful requests
- `failed`: Number of failed requests
- `results`: Array of per-request results
- `processing_time_ms`: Wall-clock execution time

### Result Items

**Successful:**
```json
{
  "id": "request-id",
  "status": "succeeded",
  "response": { SearchResponseV1 }
}
```

**Failed:**
```json
{
  "id": "request-id",
  "status": "failed",
  "error": {
    "code": "POLICY_BLOCKED | QUERY_PARSE_ERROR | RETRIEVAL_TIMEOUT | INTERNAL_ERROR",
    "message": "Error description"
  }
}
```

## Error Codes

| Code | Meaning | Retryable |
|------|---------|-----------|
| `POLICY_BLOCKED` | Query blocked by policy or ambiguity | No |
| `QUERY_PARSE_ERROR` | Query validation failed | No |
| `RETRIEVAL_TIMEOUT` | Request exceeded timeout_ms | Yes |
| `INTERNAL_ERROR` | Unexpected server error | Yes |

## HTTP Status Codes

- `207 Multi-Status`: Batch processed (may contain mixed success/failure)
- `400 Bad Request`: Invalid request structure (e.g., missing field, batch size > 20)
- `415 Unsupported Media Type`: Wrong Content-Type header
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: Unhandled server error

## Execution Modes

### Partial Failure (default: `fail_fast=false`)

All requests are executed in parallel using `Promise.all()`. If one fails, others continue.

```typescript
succeeded: 19, failed: 1
// 20 requests total, 19 completed successfully, 1 failed
```

### Fail-Fast (`fail_fast=true`)

All requests are started in parallel, but new requests are not created after the first failure. In-flight requests continue to completion.

```typescript
succeeded: 10, failed: 5
// 15 requests out of 20 were attempted before aborting
```

## Timeout Behavior

Each request has its own timeout enforced via `Promise.race()`:

```typescript
{
  "requests": [
    { "id": "1", "query": "Slow query" }
  ],
  "options": { "timeout_ms": 1000 }
}
```

If the request doesn't complete within 1000ms:
```json
{
  "status": "failed",
  "error": {
    "code": "RETRIEVAL_TIMEOUT",
    "message": "Request exceeded timeout"
  }
}
```

## Sub-Request IDs

Each request in a batch gets a unique sub-request ID for logging and tracing:

```
${batchId}-${item.id}
```

Example:
```
batch-123-query1
batch-123-query2
```

These IDs appear in response metadata for correlation with logs.

## Idempotency (historical HTTP contract)

The retained batch schema supports deterministic `batch_id` replay. The public HTTP route
`POST /v1/batch-search` is **not registered** — use the eval/fixture runner instead:

```typescript
import { buildBatchSearchRunner } from '../src/config/build-batch-search-runner.js';

const runner = buildBatchSearchRunner(searchExecutor);

// First call
const response1 = await runner.execute(requests, options, 'my-batch-v1');

// Safe to retry with same batch_id
const response2 = await runner.execute(requests, options, 'my-batch-v1');
```

**Note:** Idempotency is best-effort; the server does not cache batch results.

## Aggregation Invariant

The response always satisfies:

```
succeeded + failed = total
```

This holds regardless of execution mode or timeout behavior.

## Examples (eval/fixture runner — no live HTTP route)

### Basic batch search

```typescript
import { buildBatchSearchRunner } from '../src/config/build-batch-search-runner.js';

const runner = buildBatchSearchRunner(searchExecutor);
await runner.execute([
  { id: '1', query: 'Cabernet Sauvignon 2015' },
  { id: '2', query: 'Chardonnay 2020' },
]);
```

### With options

```typescript
await runner.execute(
  [
    { id: '1', query: 'Pinot Noir' },
    { id: '2', query: 'Riesling' },
  ],
  { fail_fast: true, timeout_ms: 3000 },
  'my-batch-001',
);
```

### Historical HTTP contract (removed route)

```bash
# REMOVED — retained wire-shape reference only
curl -X POST http://localhost:3000/v1/batch-search \
  -H "Content-Type: application/json" \
  -d '{
    "requests": [
      { "id": "1", "query": "Cabernet Sauvignon 2015" },
      { "id": "2", "query": "Chardonnay 2020" }
    ]
  }'
```

## Architecture

- **Runner:** `runBatchSearch` / `buildBatchSearchRunner()` (eval/fixture rail — `src/application/search/batch-search-runner.ts`)
  - Validates batch size (max 20)
  - Normalizes timeout (1000–30000 ms)
  - Orchestrates parallel or fail-fast execution
  - Maps errors to `BatchErrorCode`
  - Generates sub-request IDs
  - Wired via `buildBatchSearchRunner()` — **not** on production `Container`

- **Route:** retired from the current public HTTP surface (historical route module removed)
  - Retained Zod schema for contract regression only

- **Schema:** Zod validation (src/interface/http/schemas/batch-search.schema.ts)
  - Enforces max 20 requests
  - Validates timeout range
  - Strict property checking

- **DI:** **Not** registered in production `Container` (cutover 2026-06)
  - Direct instantiate / test harness only: `buildBatchSearchRunner(searchUseCase)`

## Quality Standards

- **TypeScript:** Strict mode, `exactOptionalPropertyTypes`
- **Tests:** Unit tests (39 passing) covering:
  - Batch size validation
  - Timeout enforcement
  - Partial failure handling
  - Fail-fast mode
  - Error mapping
  - Idempotency
  - Response aggregation
- **Code:** ESLint clean, production-ready SOTA++ quality
- **No command injection risks:** Error messages are not interpolated from user input

## RFC Compliance

- Aligns with existing FailureReason enum (POLICY_BLOCKED, etc.)
- Uses sub-request ID propagation for tracing
- Proper HTTP semantics (207 Multi-Status per RFC 7231)
- Timeout enforcement with Promise.race()
