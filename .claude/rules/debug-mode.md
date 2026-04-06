# HTTP debug mode (pointer)

**Tracing a request (LLM workflow):** read **`.ai/llm-debugging-playbook.md`** first (log shape, step order, symptom table).

**Operator setup:** **`.ai/debug-mode.md`** at the repository root (same folder as `CLAUDE.md`). Covers `HTTP_DEBUG_SECRET`, `X-Debug-Key`, `X-Debug-Active`, and `pipeline_debug` via `src/observability/request-pipeline-debug.ts`.

**Step name constants:** `src/observability/pipeline-debug-steps.ts` (`PipelineDebugStep`). Human index: `.ai/pipeline-debug-steps.md`.
