# Anthropic Messages API response fixtures

Captured / synthesized JSON shapes used by `claude-structured-llm-adapter.test.ts`
and the related regression tests. Each fixture mirrors the public Messages API
spec (https://docs.anthropic.com/en/api/messages, `anthropic-version:
2023-06-01`).

Fields exercised:

| Fixture | `stop_reason` | content blocks | usage fields |
|---|---|---|---|
| `tool-use-single.json` | `tool_use` | 1 `tool_use` | input/output |
| `tool-use-parallel.json` | `tool_use` | 2 `tool_use` (parallel) | input/output |
| `tool-use-truncated.json` | `max_tokens` | 1 truncated `tool_use` | input/output |
| `text-end-turn.json` | `end_turn` | 1 `text` | input/output |
| `refusal.json` | `refusal` | 1 `text` | input/output |
| `cache-hit.json` | `tool_use` | 1 `tool_use` | all 4 fields including cache_read |
| `mixed-content.json` | `tool_use` | `text` + `tool_use` | input/output |

When the API shape changes, add NEW fixtures rather than mutating existing
ones — regression tests pin against the captured shape.
