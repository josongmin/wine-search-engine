# Agent instructions

- **Shared context**: [`CLAUDE.md`](./CLAUDE.md) (architecture, commands, quality bar).
- **Debug / trace a request (LLMs):** [`.ai/llm-debugging-playbook.md`](./.ai/llm-debugging-playbook.md) first, then [`.ai/debug-mode.md`](./.ai/debug-mode.md); steps: [`src/observability/pipeline-debug-steps.ts`](./src/observability/pipeline-debug-steps.ts).
- **Cursor**: [`.cursor/rules/wine-search-engine.mdc`](./.cursor/rules/wine-search-engine.mdc) (always-on project rules).
- **Codex**: [`.codex/config.toml`](./.codex/config.toml) (CLI/IDE defaults; trust the repo for project config to apply).
- **Claude Code**: [`CLAUDE.md`](./CLAUDE.md) + [`.claude/settings.json`](./.claude/settings.json); use `CLAUDE.local.md` for private preferences (gitignored).
- **Index of `.ai/` docs**: [`.ai/README.md`](./.ai/README.md).
