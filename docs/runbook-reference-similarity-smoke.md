# Runbook — Reference-Similarity Smoke Checklist (RFC-021)

Operator-facing, repeatable smoke for the deterministic reference-similarity
primitive (`similar_to_entity`) and its agent composition
(`lookup_wine` → `similar_to_entity`). This complements — it does **not**
replace — the automated rails:

- `test/regression/reference-similarity-agent.test.ts`
- `test/regression/reference-similarity-public-search.test.ts`
- `src/application/search/__tests__/reference-similarity-execution.test.ts`
- `src/application/search/__tests__/similar-to-entity-primitive-plan.test.ts`

> Owner-local automated rails are CI-gated. This checklist is for **live**
> verification against a populated Vespa + PG snapshot, where the automated
> rails deliberately do not run (no infra in unit lanes).

## 0. Pre-flight

- [ ] Vespa reachable (see `memory/infra_vespa_cloud` — EC2 SG IP allowlist).
- [ ] PG snapshot aligned with the Vespa snapshot (entity ids resolvable).
- [ ] Backend up on `:3000`.

## 1. Agent chain — Korean reference similarity

Query: `오푸스원 비슷한 와인 추천해줘`

- [ ] Step trace shows **`lookup_wine`** FIRST (resolves "오푸스원" → entity_id).
- [ ] Step trace shows **`similar_to_entity`** SECOND, invoked with the
      `entity_id` from step 1 — **not** a free-text name.
- [ ] The anchor wine (Opus One) is **absent** from the similarity results
      (same-entity exclusion).
- [ ] No `mixed` / `similar_items` / `search_wines` tool name appears in the
      tool trace — only the primitive taxonomy.

## 2. Agent chain — English reference similarity

Query: `recommend wines similar to Sassicaia`

- [ ] Same `lookup_wine` → `similar_to_entity` chain.
- [ ] Anchor (Sassicaia) excluded from results.

## 3. Agent chain — anchor + residual constraint

Query: `오푸스원이랑 비슷한데 5만원 이하로`

- [ ] `similar_to_entity` is called with the resolved `entity_id` **and** a
      `max_price_krw` residual.
- [ ] Results respect the price ceiling AND stay in the anchor neighborhood.

## 4. Anchor-loss negative check

- [ ] If the model tries `similar_to_entity({ query: "오푸스원" })` (a name, no
      `entity_id`), the dispatch returns an **invalid input** observation and
      the search use case is **not** invoked. (The model should then fall back
      to `lookup_wine` first.)

## 5. Public search lane authority (non-agentic)

`POST /v1/search/hybrid` with body `{ "query": "오푸스원 같은 와인" }`

- [ ] Response query-family telemetry stays **`reference_similarity`** when the
      planner sees anchored-similarity semantics, even though the public path
      stays non-agentic.
- [ ] The execution route is `hybrid` (path authority), not `mixed`.
- [ ] The execution contract does **not** silently become the agent primitive
      chain (`lookup_wine` → `similar_to_entity`). `queryFamily` here is
      observability semantics, not proof of agent composition.

## 6. Observability spot-check

- [ ] In the structured search log, a `similar_to_entity` execution reports
      `query_observability.queryFamily = "reference_similarity"` (its own
      bucket — NOT folded into `recommendation`).
- [ ] The plan's `policyReasonCodes` include `SIMILAR_TO_ENTITY_PATH_AUTHORITY`.

## Reporting

Record results split into:

1. **owner-local green** — which automated rails were run (CI / local).
2. **live smoke** — which of §1–§6 passed against the live snapshot.
3. **residue / follow-ups** — anything observed but out of scope.
