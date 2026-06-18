# Agent Benchmark Annotation Guide (SOTA++)

> Schema and corpus authoring remain current. Historical note: the live agent
> runner that consumes these annotations is absent in this checkout, so this is
> a data-contract doc, not proof of a runnable live bench lane. See
> `docs/bench/STATUS.md`.

This guide describes how to annotate a scenario with ground truth, what each
field means, and the conventions seed annotations follow.

## TL;DR

```bash
# Print the scenario block + an empty annotation template
tsx scripts/eval/annotate-scenario.ts <scenarioId> --print

# Author from a file
tsx scripts/eval/annotate-scenario.ts <scenarioId> --from path/to/annotation.json

# Author interactively (stdin → EOF)
tsx scripts/eval/annotate-scenario.ts <scenarioId>

# List existing annotations
tsx scripts/eval/annotate-scenario.ts --list
```

Annotations live under `test/benchmark/agent/annotations/<scenarioId>.json`.
The historical live runner loaded them at startup; missing files imply a
judge-only path once a runner is restored.

## Schema

Defined in `test/benchmark/agent/annotation-schema.ts` and validated with Zod
on save (`parseScenarioAnnotation`). Every field is optional — presence
enables deterministic scoring for that dimension.

| Field | Purpose | Drives |
| --- | --- | --- |
| `expectedConstraints.hard/soft/inferred` | RFC-020 SCR ground truth | SCR + Slot F1 (overrides inline) |
| `expectedEntities` | RFC-020 ELA ground truth (surface → canonical) | ELA@1 |
| `expectedRetrievalIds` | Canonical entity ids that MUST appear in tool observations | contextRecall diagnostic |
| `expectedClaims.mustMention` | Substrings that MUST appear in the final answer | answerQuality (`answerContains` merge) |
| `expectedClaims.mustNotMention` | Substrings that MUST NOT appear | answerQuality + `critical` diagnostic |
| `expectedSteps.{min, max}` | Inclusive step-count band | stepEfficiency diagnostic |
| `expectedTerminationReason` | Required termination class | terminationCorrectness diagnostic |
| `expectedRubric` | Free-form bullets the judge must verify (fallback when no inline rubric) | judge |
| `notes`, `annotatedBy`, `annotatedAt` | Audit fields | none |

## Annotation rubric

Two seed conventions to keep judge prompts comparable:

1. **Each rubric line is one verifiable claim.** Avoid "feels good" criteria.
   Good: "Recommendation is a white wine". Bad: "Answer is helpful".
2. **Honesty before completeness.** For future-vintage / unavailable-data
   scenarios, the rubric MUST gate on the agent saying it doesn't know.
   `mustNotMention` is the place to encode the forbidden affirmations.

## Constraint tier semantics (matches scorer / runner)

- `hard` → must appear in extracted bundle for SCR-hard credit. Use for facts
  the query states explicitly (region, grape, vintage, type).
- `soft` → optional but matched if extracted. Use for ontology expansion
  (Bordeaux → country=France, body proxy, critic-score floor).
- `inferred` → compositional inference only (e.g. Cabernet+France implies
  Cabernet/Merlot grape family). Goes through `scrInferredGraph` if a graph
  ships.

## When to update an annotation

- Real-world data changes (a wine's vintage release ships → drop the
  `mustNotMention "released"`).
- Scenario rewording — the canonical/surface forms may shift.
- A bug-class reveal: e.g. `expectedClaims.mustNotMention` should add a new
  forbidden hallucination after the agent gets caught fabricating it once.

Update `annotatedAt` on every meaningful change so reviewers can spot stale
annotations.

## Seed coverage (May 2026)

20+ annotations cover:

- `single_shot`: 1, 2, 3, 4, 5
- `multi_step`: 6, 7, 8, 9
- `nested_condition`: 25, 26, 27, 29
- `comparison_nested`: 30, 31, 32, 33, 34
- `wine_name_lookup`: 117, 121, 122, 123, 124

This satisfies the `MIN_ANNOTATION_SAMPLES = 10` threshold for stable SCR /
ELA / Slot-F1 aggregates (see `benchmark-insight-generator.ts`).
