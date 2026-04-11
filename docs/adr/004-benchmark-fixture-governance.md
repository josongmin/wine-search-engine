# ADR-004: Central Benchmark Fixture Governance

## Status: Accepted

## Context

The project now needs a single source of truth for benchmark fixtures across multiple evaluation modes:

- exact-entity recovery for noisy Korean queries
- hybrid search quality and ambiguity handling
- agentic tool-use / multi-step answer quality
- retrieval / ranking regression gates
- performance and load-test fixture inputs

Historically, test fixtures were scattered across:

- in-repo TypeScript test fixtures
- e2e test seeds
- benchmark JSON outputs
- ad-hoc docs and bugbash notes

This created four problems:

1. **No single truth source** for benchmark definitions
2. **Search quality and agentic quality mixed together** without explicit contracts
3. **Fixture drift** between test code, docs, and benchmark runners
4. **No stable governance model** for adding Korean noisy-query cases, ambiguity cases, or performance workloads

We also need benchmark cases that reflect real Korean user behavior:

- transliteration variants (`오푸스원`, `오퍼스원`, `샤또마고`)
- spacing collapse (`모엣샹동`, `로마네꽁티`)
- vintage shortforms (`오퍼스원 18`, `마고 15`)
- mixed-script queries (`오푸스원 2018 Napa Valley`)
- ambiguous short forms (`마고`, `모엣`, `DRC`)
- agentic tasks that require correct tool invocation rather than pure retrieval

## Decision

All benchmark fixtures and evaluation contracts will be managed in a dedicated external repository:

- **Fixture repository root**: `/Users/songmin/Documents/code-wine/wine-engine-fixture`

The fixture repository is the **truth source** for benchmark definitions.
The `wine-search-engine` repository is a **runner / consumer** of those fixtures.

### 1. Scope split

The external fixture repository MUST manage all benchmark fixtures for:

- search relevance
- exact-entity recovery
- ambiguity / clarify safety
- agentic tool-use and answer quality
- retrieval / ranking regression
- latency / throughput / load scenarios

The engine repository MUST NOT define competing benchmark truth sets except for:

- tiny local unit-test fixtures needed for isolated code tests
- temporary development fixtures not used as release gates

### 2. Fixture repository responsibilities

The fixture repository owns:

- benchmark case definitions
- suite definitions
- expected engine behavior contracts
- evaluation metadata and gates
- benchmark changelog / version history
- surface-form catalogs for Korean noisy queries

The fixture repository does **not** own:

- benchmark runner logic
- model inference code
- production ranking code
- application-specific test harness implementation

### 3. Contract-first benchmark model

Every benchmark case MUST define:

- query or task input
- category / suite
- expected target(s) or expected behavior
- allowed engine outcomes
- evaluation tags
- provenance metadata

Benchmarks are not "example inputs"; they are **evaluation contracts**.

### 4. Taxonomy separation

Fixtures MUST be split into distinct benchmark families. At minimum:

- `exact_entity_recovery`
- `ambiguous_shortform`
- `mixed_script_entity`
- `noisy_attribute_recovery`
- `search_feature_behavior`
- `agentic_tool_use`
- `agentic_answer_quality`
- `performance_latency`
- `performance_load`

This separation is mandatory so that:

- exact-entity failures are not hidden inside recommendation-style tasks
- agentic answer failures are not confused with search retrieval failures
- performance fixtures can evolve independently of semantic quality fixtures

### 5. External repo layout

The fixture repository MUST use a contract-oriented layout:

```text
wine-engine-fixture/
  README.md
  schema/
    benchmark-case.schema.json
    benchmark-suite.schema.json
  suites/
    exact-entity-ko/
      suite.json
      cases/
    ambiguous-shortform/
      suite.json
      cases/
    mixed-script-entity/
      suite.json
      cases/
    noisy-attribute/
      suite.json
      cases/
    agentic-tool-use/
      suite.json
      cases/
    agentic-answer-quality/
      suite.json
      cases/
    performance-latency/
      suite.json
      cases/
    performance-load/
      suite.json
      cases/
  catalogs/
    alias-surface-ko.json
    grape-surface-ko.json
    producer-surface-ko.json
    ambiguity-surfaces.json
  goldens/
    canonical-entities.json
    target-entity-map.json
  eval/
    metrics.json
    thresholds.json
  changelog/
```

### 6. Benchmark case contract

Each case MUST support behavior-based evaluation, not only exact-string matching.

Examples:

- exact recovery case: target entity must appear in top-1 or top-K
- ambiguity case: `clarify` is acceptable, wrong confident top-1 is not
- agentic case: correct tool invocation path is required
- performance case: response must stay within latency SLO under a defined workload

### 7. Korean noisy-query governance

The fixture repository MUST include Korean surface-form catalogs sourced from:

- current code fixtures and aliases
- observed benchmark failures
- curated Korean web/search/shopping surfaces
- manual curation for transliteration, spacing collapse, and shortform ambiguity

This catalog is a benchmark input source, not just documentation.

### 8. Release-gate policy

Release gating MUST read from fixture suites, not hardcoded in the runner.

Each suite MUST declare:

- primary metrics
- minimum thresholds
- forbidden regressions
- whether `clarify` is allowed
- whether `top-N` fallback is allowed

### 9. Versioning policy

Fixture changes are benchmark changes and MUST be treated as contract changes.

Rules:

1. Case `id` is immutable
2. Existing query text is immutable; changed semantics require a new case
3. Expected target changes MUST be recorded in `changelog/`
4. New suites and new tags MUST be documented in `README.md`
5. Threshold changes require an explicit rationale

## Consequences

### Positive

- Search, agentic, and performance benchmarks share one governed truth source
- Korean noisy-query coverage becomes explicit and reviewable
- Benchmark runners become simpler because they consume contracts rather than invent expectations
- Release gates become reproducible across environments
- Exact-entity recovery and agentic behavior can be measured independently

### Negative

- Fixture maintenance becomes a first-class engineering activity
- Adding or changing benchmark cases requires governance and changelog discipline
- The engine repository must build tooling to load and validate external fixture contracts

### Required follow-up

1. Initialize `/Users/songmin/Documents/code-wine/wine-engine-fixture` with the contract-first layout above
2. Add JSON schemas for case and suite validation
3. Seed initial suites:
   - `exact-entity-ko`
   - `ambiguous-shortform`
   - `mixed-script-entity`
   - `agentic-tool-use`
   - `performance-latency`
4. Import currently known Korean noisy-query cases from:
   - engine test fixtures
   - TRACK-A exact entity recovery plan
   - benchmark failure logs
5. Update benchmark runners in `wine-search-engine` to read suite definitions from the external fixture repository

