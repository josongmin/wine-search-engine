# Agent & operator notes

Short, repo-local references for tools and humans. **RFC product behavior** stays in `docs/RFC-*.md`.

| Doc | Purpose |
|-----|---------|
| [`llm-debugging-playbook.md`](./llm-debugging-playbook.md) | **Start here for agents:** log JSON shape, happy-path `step` order, symptom→file table, grep patterns, batch/ALS pitfalls |
| [`debug-mode.md`](./debug-mode.md) | HTTP debug mode (`HTTP_DEBUG_SECRET`, `X-Debug-Key`), pipeline logs, scope/limitations, verification |
| [`pipeline-debug-steps.md`](./pipeline-debug-steps.md) | Index for canonical `step` strings (`PipelineDebugStep` in `src/observability/pipeline-debug-steps.ts`) |
| [`test-lanes.md`](./test-lanes.md) | Which test lanes are default vs heavy, plus the current smart dev-loop and pre-push commands (`check:smart`, `check:staged`, `lint:smart`, `lint:staged`, `git:prepush:smart`, `test:file`, `test:related`) and when to use them |

Operator runbooks (human): [`docs/runbook-curation-materialization.md`](../docs/runbook-curation-materialization.md) — ops publish → snapshot ETL materialization (migration 033, pin semantics).

Referenced from root `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, `.codex/config.toml`, and `.claude/rules/`.
