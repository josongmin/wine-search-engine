# Agent instructions

- **Language (coding agents)**: Chat with the developer in **Korean** by default; keep code/identifiers aligned with repo conventions (see [`.cursor/rules/wine-search-engine.mdc`](./.cursor/rules/wine-search-engine.mdc)).
- **Heuristics policy**: Do **not** introduce heuristic shortcuts, heuristic fallbacks, or rule-of-thumb approximations unless the user explicitly approves them first. If heuristics seem necessary, stop and ask before proceeding.
- **Execution baseline**: Unless the user explicitly asks for a cheaper/faster trade-off, treat the baseline as pursuing the strongest known **SOTA++** direction regardless of ROI.
- **Shared context**: [`CLAUDE.md`](./CLAUDE.md) (architecture, commands, quality bar).
- **Debug / trace a request (LLMs):** [`.ai/llm-debugging-playbook.md`](./.ai/llm-debugging-playbook.md) first, then [`.ai/debug-mode.md`](./.ai/debug-mode.md); steps: [`src/observability/pipeline-debug-steps.ts`](./src/observability/pipeline-debug-steps.ts).
- **Cursor**: [`.cursor/rules/wine-search-engine.mdc`](./.cursor/rules/wine-search-engine.mdc) (always-on project rules).
- **Codex**: [`.codex/config.toml`](./.codex/config.toml) (CLI/IDE defaults; trust the repo for project config to apply).
- **Claude Code**: [`CLAUDE.md`](./CLAUDE.md) + [`.claude/settings.json`](./.claude/settings.json); use `CLAUDE.local.md` for private preferences (gitignored).
- **Index of `.ai/` docs**: [`.ai/README.md`](./.ai/README.md).
