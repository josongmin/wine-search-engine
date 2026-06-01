# RFC-021 Primitive Search Agent — Closeout

Deterministic `similar_to_entity` reference-similarity primitive + agent
composition cutover + public lane authority + eval/observability + banned-surface
guard. Reported per the README's "작업자용 최소 보고 포맷" (owner-local green /
미실행 rail / 의도적으로 안 건드린 레이어 / 남은 compatibility residue).

## 1. Owner-local green

| Ticket | Owner-local rails (all PASS) |
|---|---|
| T-PSA-01 | `reference-similarity-execution.test.ts` (32), `similar-to-entity-primitive-plan.test.ts` (14), pre-route dispatch case; `src/application/search/__tests__` 210/210; typecheck + lint clean |
| T-PSA-02 | `wine-agent-loop-tool-bundle.test.ts`, `wine-agent-loop.test.ts` (chain + free-text-reject), `search-use-case-adapter.test.ts`, `tool-result-cache.regression`, wire-contract snapshot, injection-boundary; wine-search/agent/config 438/438 + integration 21/21 |
| T-PSA-03 | `planner-routing-lane-lock.test.ts`, `planner-v2.test.ts` (lockDiscoveryLane), `search-usecase-planner-context-lane-lock.test.ts`; retrieval/query svc sweeps green |
| T-PSA-04 | `reference-similarity-agent.test.ts`, `reference-similarity-public-search.test.ts`, observability vocab + retrieval-profile sweeps (345 + 44) |
| T-PSA-05 | `banned-surface-guard.regression.test.ts` (7) |

Cross-cutting: `pnpm run typecheck` green after every ticket.

## 2. Design spine (one decision threads all five tickets)

`mixed-solver.ts` forbids forking a parallel similarity runtime ("extend this
solver, do NOT fork"). So `similar_to_entity` is an **independent contract/plan
seam** (entity_id authority, own plan builder, own `SIMILAR_TO_ENTITY_PATH_AUTHORITY`
reason code) that **reuses the locked mixed/anchor-similarity solver** for
execution. Same-entity exclusion + producer diversity + anchor provenance are
already enforced in that solver's core when `retrievalMode='similar_items'`.

## 3. 미실행 rail (require live infra — not run in this session)

- Vespa-backed e2e (`test:e2e:vespa`, `test:quality:vespa`) — need a populated
  Vespa + aligned PG snapshot. The §1 rails are infra-free by design.
- Live agent benchmark (`test/benchmark/agent`) — needs an LLM provider +
  Vespa. Scenario #7 was re-aligned to the `lookup_wine → similar_to_entity`
  chain but not executed live.
- Operator live smoke — see `docs/runbook-reference-similarity-smoke.md`.
- One PRE-EXISTING ambient failure unrelated to this work:
  `planner-constraint-fallback-observability.test.ts` (err-serialization) —
  confirmed failing on a clean tree (changes stashed).

## 4. 의도적으로 안 건드린 레이어

- `src/domain/mixed/**` core algorithm — reused, not rewritten (REUSE-family lock).
- `src/domain/retrieval/service/candidate-pool.ts`, `src/domain/ranking/**` —
  exclusion/dedup already live there; no behavior rewrite.
- Vespa schema / ETL / deploy infra — untouched.
- `data/golden-queries-*.jsonl` — NOT modified (strict release-gate schema +
  only meaningful against live Vespa). Reference-similarity corpus is carried by
  the §1 regression rails + benchmark scenario #7 instead. **Follow-up.**
- `src/domain/evaluation/service/build-evidence-records-from-frames.ts` — the
  always-on `query_observability.queryFamily` de-conflation (new
  `reference_similarity` family) already makes the primitive chain
  machine-checkable; a dedicated evidence-record contract is a **follow-up**.

## 5. 남은 compatibility residue (allowlisted — see banned-surface-allowlist.md)

- Internal: `similar_items` retrieval mode, mixed solver, `mixed_anchor` profile,
  `CompareWinesAttemptInputSchema` (unreachable — not in `KNOWN_AGENT_TOOL_NAMES`).
- Tests: `compare_wines` unsupported-branch guard in `wine-agent-loop.test.ts`.
- Docs: historical `docs/rfc/**` + `docs/adr/**` (preserved as record);
  `docs/system-overview/*` stale `search_wines` mentions flagged for a future
  system-overview refresh (non-blocking).

The banned-surface rail enforces the PRODUCT/TOOL surface is clean; the raw
`rg 'search_wines|compare_wines|mixed|similar_items'` will still match the
allowlisted internal/doc residue above by design.
