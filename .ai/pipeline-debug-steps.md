# Pipeline debug `step` reference

The **source of truth** for allowed `step` string values is TypeScript:

**[`src/observability/pipeline-debug-steps.ts`](../src/observability/pipeline-debug-steps.ts)** — export `PipelineDebugStep` and type `PipelineDebugStepId`.

## Conventions

- Prefer **`domain.area.detail`** (e.g. `decision.engine.response`, `http.embedding.timeout`).
- New call sites should use **`PipelineDebugStep.*`** constants to avoid typos and to make refactors grep-friendly.
- Legacy code may still use inline string literals; migrate when touching those lines.

## Why this file exists

Human-readable index next to the TS module: operators can skim categories; agents should still treat the **`.ts` file** as authoritative when they differ.

## Related

- [debug-mode.md](./debug-mode.md) — how to turn on HTTP debug mode and interpret logs.
