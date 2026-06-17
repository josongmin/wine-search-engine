# Known Issues — In-Memory E2E Failures (Cutover Triage)

> **Status: superseded (2026-06-10).** This snapshot predates the V2-only HTTP cutover
> that removed `POST /v1/search/interpret`, `POST /v1/search`, and legacy entity routes.
> Do **not** use this table as a live blocker list — re-run `pnpm run test:e2e:fast` and
> triage against the current route catalog in
> [`http-route-contract-catalog.ts`](../src/interface/http/routes/http-route-contract-catalog.ts).

Historical snapshot (`config/vitest/e2e.config.ts` lane at cutover triage): **14 failed / 514 passed (528)**.

**Headline finding (historical):** none of the 14 failures were in the `/v1/wine-search`
Plan-then-Execute cutover path. Failures clustered on legacy `/v1/agent`, `/v1/search`, and
**removed** `/v1/search/interpret` — governed by parallel calibration/alias work, not the
wine-search orchestrator.

## Why this doc is archived

| Removed surface | Current replacement |
|-----------------|---------------------|
| `POST /v1/search/interpret` | Eval-only `interpret-query-runner.ts` (no HTTP) |
| `POST /v1/search` | `POST /v1/search/hybrid\|semantic\|lexical` primitives |
| `POST /v1/entity/resolve` | `POST /v2/entity-lookup` |

Rows #1, #4, #5, #8, #9 in the original table referenced `/v1/search/interpret` and are
**obsolete** after route removal.

## Current verification

```bash
pnpm run test:e2e:fast
pnpm run test:regression -- test/regression/lookup-wine-authority-surface.regression.test.ts
```

## Historical triage table (append-only record)

| # | Test | Surface | Category | Root-cause hypothesis | Severity | Owner |
|---|------|---------|----------|-----------------------|----------|-------|
| 1 | V1 routes — `/v1/search/interpret` still returns V1 interpret shape | interpret | (c) pre-existing/parallel | Route **removed** — row obsolete | n/a | — |
| 2 | `/v1/agent` Tier 1 — direct answer (out of domain) | legacy agent | (c) calibration | AURC threshold shift | low | calibration |
| 3 | `/v1/agent` Tier 3 — max steps enforcement | legacy agent | (c) test-design | ScriptedChatLlm synthesis gap | low | legacy agent |
| 4–5, 8–9 | `/v1/search/interpret` shape/alias tests | interpret | (c) parallel | Route **removed** — rows obsolete | n/a | — |
| 6–14 | resolver/alias/search envelope | mixed | (c) parallel | Re-baseline against current catalog | med | search/calibration |

Category legend (historical):

- **(a) our-change** — Count: 0.
- **(b) user-WIP** — Count: 0.
- **(c) pre-existing / parallel-commit** — Count: 14 (interpret rows now moot).

## Cutover gating recommendation (historical)

These 14 failures did **not** block the `/v1/wine-search` cutover path. Post-cutover,
re-measure e2e against live surfaces only.
