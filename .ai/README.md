# Agent & operator notes

Short, repo-local references for tools and humans. **RFC product behavior** stays in `docs/RFC-*.md`.

| Doc | Purpose |
|-----|---------|
| [`llm-debugging-playbook.md`](./llm-debugging-playbook.md) | **Start here for agents:** log JSON shape, happy-path `step` order, symptom→file table, grep patterns, batch/ALS pitfalls |
| [`debug-mode.md`](./debug-mode.md) | HTTP debug mode (`HTTP_DEBUG_SECRET`, `X-Debug-Key`), pipeline logs, scope/limitations, verification |
| [`pipeline-debug-steps.md`](./pipeline-debug-steps.md) | Index for canonical `step` strings (`PipelineDebugStep` in `src/observability/pipeline-debug-steps.ts`) |
| [`test-lanes.md`](./test-lanes.md) | Which test lanes are default vs heavy, when to run them, and which expensive tests should stay out of normal loops |

Referenced from root `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/`, `.codex/config.toml`, and `.claude/rules/`.
