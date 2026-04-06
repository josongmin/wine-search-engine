# Wine Search Engine — Internal Developer Guide

Wine intelligence / search backend: typed **TypeScript** on **Node.js 22**, **Fastify** HTTP API, **PostgreSQL**, **Redis**, **Vespa** retrieval, and optional **HTTP ML services** (embeddings, cross-encoder rerank, learned matcher).

This document is for **engineers working in this repo**. Product behavior and terminology live in **`docs/RFC-*.md`**. Editor/agent shortcuts: **`CLAUDE.md`**, **`AGENTS.md`**, **`.cursor/rules/wine-search-engine.mdc`**.

### Document map

| # | Section |
|---|---------|
| 1 | [Technical stack](#technical-stack) |
| 2 | [Architecture & composition](#architecture--composition) |
| 3 | [HTTP API & search flow](#http-api-entry-points--request-flow) |
| 4 | [Retrieval & ranking](#retrieval--ranking-engine-conceptual) |
| 5 | [Algorithms](#algorithms--established-methods-where-used) |
| 6 | [Completeness vs product maturity](#completeness-engineering-sota-vs-product-maturity) |
| 7 | [Evaluation metrics](#evaluation-metrics-definitions--gates) |
| 8 | [Test coverage & E2E](#test-coverage--e2e-scenarios) |
| 9 | [Capabilities summary](#what-this-codebase-implements-capabilities) |
| 10 | [Repository structure](#repository-structure) |
| 11 | [Prerequisites & bootstrap](#prerequisites) · [Config](#configuration-env) · [Run](#running-the-api) · [Docker](#docker-compose) · [Migrations](#database-migrations) |
| 12 | [Scripts](#scripts--npm-commands-reference) · [CI](#ci-github-actions) · [Further reading](#further-reading) |

### Quick start

```bash
git clone <internal-remote> wine-search-engine && cd wine-search-engine
npm ci && cp .env.example .env   # edit PG_*, REDIS_URL, VESPA_URL, secrets
npm run dev                       # http://localhost:3000 — see GET /health
npm run lint && npm run typecheck && npm run test   # before pushing
```

---

## Technical stack

| Layer | Technology |
|-------|------------|
| Runtime | **Node.js ≥ 22**, **ESM** (`"type": "module"`) |
| Language | **TypeScript** — `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` |
| HTTP | **Fastify 5**, **Zod** (schemas + route contracts), **Pino** logging |
| API docs | Contract catalog → **`GET /openapi.json`** (OpenAPI bridge from Zod contracts) |
| DB | **`pg`** — entities, aliases, feedback, proposals, watchlist (where applicable) |
| Cache / pub-sub | **`redis`** (official client, not ioredis) |
| Search engine | **Vespa 8** — ANN + sparse; app package under **`vespa/app/`** |
| ML / numeric | **onnxruntime-node** (drinking-window ONNX optional), HTTP adapters for remote models |
| LLM / tools | **@anthropic-ai/sdk** (optional; security / tooling paths) |
| Telemetry | **OpenTelemetry** API/SDK hooks (see `src/infrastructure/telemetry/`) |
| Tests | **Vitest** — unit (`src/**/__tests__`, `test/unit/`), integration, e2e, quality configs |
| Lint | **ESLint** flat config + **typescript-eslint** (type-aware rules for `src/`) |

**Path aliases** (`tsconfig.json`): `@shared`, `@domain`, `@app`, `@infra`, `@interface`, `@config`.

---

## Architecture & composition

### Layering (hexagonal / ports & adapters)

| Layer | Responsibility |
|-------|----------------|
| **Interface** (`src/interface/`) | Fastify routes, Zod contracts, middleware, Claude tools, CLI entrypoints |
| **Application** (`src/application/`) | Use-case orchestration: search pipeline phases, watchlist, drinking-window facade |
| **Domain** (`src/domain/`) | Pure logic, entities, policies, **ports** (interfaces) — no direct I/O |
| **Infrastructure** (`src/infrastructure/`) | **Adapters**: Postgres, Redis, Vespa clients, HTTP ML clients, ONNX, telemetry |

Dependencies point **inward**: application and domain define ports; infrastructure implements them.

### Composition root (`createContainer`)

Wiring is split across modules and merged into one **`Container`**:

1. **`buildCoreContainerServices`** (`container-core.ts` / `container-core-builders.ts`) — query planner, entity resolver (+ calibrator, learned matcher HTTP), candidate pool / fusion, ranker, decision engine, response builder, mixed solver, Vespa search index, embedding + reranker HTTP, drinking-window predictor, etc.
2. **`buildFeatureContainerServices`** (`container-features.ts` + `container-usecases.ts`) — search / hybrid / resolve / interpret / replay / batch / decomposed search, drinking-window use case, adaptive Claude tool executor, optional eval runner.
3. **`buildWatchlistContainerServices`** — watchlist service + optional Redis delivery runtime.
4. **`buildLearningContainerServices`** (`container-learning.ts`) — `PgFeedbackStore`, `PgProposalStore`, `FeedbackProcessor`, `AliasProposer` (alias duplicate check against **`aliases`** when PG is available).

`main.ts` builds **runtime handles** (Postgres pool, Redis client, watchlist factories), then **`createContainer(config, runtime)`**, then **`createServer(container)`** with readiness options from **`buildHealthRouteOptions`**.

---

## HTTP API: entry points & request flow

### Route catalog (declared contracts)

Authoritative list: **`src/interface/http/routes/http-route-contract-catalog.ts`** (mirrors registered handlers in **`server.ts`**).

| Method | Path | Use case |
|--------|------|----------|
| GET | `/health` | Liveness |
| GET | `/ready` | Readiness probes |
| GET | `/openapi.json` | Generated API description |
| POST | `/v1/search` | Primary search (may decompose to comparison) |
| POST | `/v1/batch-search` | Batched searches |
| POST | `/v1/search/replay` | Replay with pinned snapshot (409 on mismatch) |
| POST | `/v1/search/interpret` | **Query plan only** — no retrieval |
| POST | `/v1/entity/resolve` | Entity resolution only |
| POST | `/v1/search/hybrid` | Force hybrid retrieval path |
| GET/POST | `/v1/claude-tools` | Agent tool listing / execution |
| POST/GET/DELETE | `/v1/watchlist`, `/v1/watchlist/:id`, … | Watchlist |
| POST | `/v1/feedback` | Learning-loop feedback (may 503 if disabled) |

### Typical flow: `POST /v1/search`

High-level stages (see **`SearchUseCase.execute`** in `search.usecase.ts`):

1. **Pre-route** (`runSearchPreRoutePhase`) — security gate (sanitizer ± LLM judge), optional cache read, **query planning** (`QueryPlanner`), constraint SAT, optional **decomposed** “A vs B” short-circuit.
2. **Route resolution** — effective route: **entity** / **hybrid** / **mixed** (from plan + request `retrieval_mode`).
3. **Dispatch** (`dispatchSearchRouteExecution`):
   - **Entity** — build resolver candidates → **`EntityResolver.resolve`** (blocking, scoring, calibration, optional learned matcher features).
   - **Hybrid** — **`CandidatePool`** (sparse + dense + fusion) → **`Ranker`** (+ optional **LTR** per query class) → packaged as resolve/rank inputs.
   - **Mixed** — **`MixedSolver`** (anchor + similarity neighborhoods).
4. **Post-route** (`runSearchPostRoutePhase`) — abstain policy, **`DecisionEngine`**, **`ResponseBuilder`**, optional drinking-window enrichment, cache write.

```mermaid
flowchart TD
  A[POST /v1/search] --> B[Pre-route: security + plan]
  B --> C{Route}
  C -->|entity| D[Resolver]
  C -->|hybrid| E[CandidatePool + Ranker]
  C -->|mixed| F[MixedSolver]
  D --> G[Post-route: Decision + Response]
  E --> G
  F --> G
```

### Smaller entry points

- **`/v1/search/interpret`** — planner only; useful for debugging plans without hitting Vespa.
- **`/v1/entity/resolve`** — resolver path without full search response assembly.
- **`/v1/search/hybrid`** — same orchestration as search but **forces** hybrid execution.
- **`/v1/feedback`** — persists **`FeedbackSignal`** when Postgres + ingest enabled.

---

## Retrieval & ranking engine (conceptual)

| Stage | Role | Key code |
|-------|------|----------|
| **Query planning** | Classify query, anchors, policy, uncertainty | `domain/query/`, `Planner` |
| **Blocking / aliases** | Identity graph, **pg_trgm**-friendly blocking, char **n-gram** funnel | `domain/alias/`, `infrastructure/adapter/*blocking*` |
| **Sparse retrieval** | Lexical / **BM25**-style hits via Vespa | `vespa-search-index.ts` |
| **Dense retrieval** | **ANN** over document embeddings (`nearestNeighbor`, **angular** distance) | `vespa-search-index.ts`, schema in `vespa/app/` |
| **Fusion** | **RRF** across sparse/dense (and related) ranked lists | `fusion.ts`, `shared/utils/rrf.ts` |
| **Cross-encoder rerank** | Second-stage scoring over query–passage pairs (HTTP service) | `infrastructure/vespa/reranker.ts` |
| **Calibration** | **Platt** / **isotonic** / **temperature** on resolver scores | `domain/resolver/service/calibrator.ts`, `calibration` table |
| **Decision** | Thresholds, abstention, evidence packaging | `domain/decision/` |

Hybrid candidates carry **RRF-derived** fusion scores (see `hybrid-candidate.ts`); calibrated **decision confidence** is defined at the resolver/decision boundary per RFCs.

---

## Algorithms & established methods (where used)

The codebase intentionally combines **classical IR**, **neural retrieval / reranking**, and **calibrated decisioning**. Below are the **patterns** and **where they appear** (not an exhaustive literature survey).

| Method / pattern | Typical use | In-repo touchpoints |
|------------------|-------------|----------------------|
| **BM25** (sparse lexical) | Lexical relevance | Vespa sparse queries; comments in `vespa-search-index.ts`, `browse-diversity.ts` |
| **Dense ANN** (embedding similarity) | Semantic recall | Vespa `nearestNeighbor` + **angular** metric; BGE-style embeddings via HTTP |
| **Reciprocal Rank Fusion (RRF)** | Merge ranked lists without score normalization | `rrfFuse(..., k=60)` in `shared/utils/rrf.ts`, `FusionService` |
| **Cross-encoder reranking** | Re-score top candidates with a transformer pairwise model | HTTP `RerankerPort` implementation |
| **Platt scaling / isotonic / temperature** | Calibrate scores to probabilities | `Calibrator`, `calibration_params` table, `shared/utils/calibration.js` |
| **Learning-to-rank (LambdaMART-style weights)** | Optional per–query-class linear blend | `QueryClassWeights`, `search-usecase-ltr-rerank.ts` (when models loaded) |
| **BK-tree** | Metric tree for string / edit-distance style lookups | `domain/query/service/bk-tree.ts` |
| **Character n-grams** | Fuzzy alias surface matching | `CharNgramIndex`, alias matcher funnel |
| **Phonetic / transliteration helpers** | Query + batch alias surfaces | `phonetic.ts`, `Transliterator` (ETL) |
| **Trigram index (GIN)** | DB-side fuzzy alias lookup | `pg_trgm` in migrations; `PgBlockingAdapter` / alias repos |
| **ONNX Runtime** | Drinking-window regression | `infrastructure/ml/drinking-window-predictor.ts` |
| **Conformal / abstention policies** | Refuse low-confidence outcomes | Abstain policy + decision engine (RFC-013 references in code) |

**Citations (illustrative, not exclusive):** BM25 (Robertson & Walker lineage); RRF popularized in modern hybrid search stacks (e.g. Cormack et al. duplicate-detection fusion; many IR systems use **k≈60**); Platt (1999) probabilistic SVM outputs; isotonic regression for monotonic calibration; cross-encoders follow the “sentence pair classification” paradigm common in neural IR since Nogueira & Cho (2019) style work.

---

## Completeness: engineering “SOTA” vs product maturity

- **Strengths:** The **architecture** matches common **production search** practice: **hybrid retrieval** (sparse + dense), **fusion**, optional **cross-encoder**, **calibrated** resolver scores, explicit **decision layer**, **Vespa** for scalable retrieval, **contract-first HTTP**, and **offline eval hooks** (noisy entity, offline tiers).
- **Gaps / honesty:** “SOTA++” is a **project aspiration**, not a single benchmark score. Offline eval lanes may use **smoke / golden** fixtures; **live A/B** and **continuous calibration** against production traffic are **out-of-repo concerns**. ML services (embedding, reranker, learned matcher) are **HTTP-contracted** — quality depends on **model choice**, **data**, and **ops**, not only this service.
- **How to extend:** New retrieval modes → Vespa schema + `SearchIndexPort`; new ranking signals → `Ranker` / LTR weights; new safety → `query-entry-security` and policies in RFCs.

---

## Evaluation metrics (definitions & gates)

**Source of truth for formulas:** `scripts/eval/metrics.ts` (pure functions, no I/O). **RFC alignment:** decision utility / AURC / ECE per **RFC-009**; release gates per **RFC-017 §3.2** (see `RELEASE_GATES` in `scripts/eval/run-offline-eval.ts`). **Operational runbook:** `docs/eval-baseline-runbook.md`.

### Offline evaluation (`run-offline-eval.ts`)

Runs golden-query JSONL through the pipeline and aggregates **global** and **slice** (scenario, language, retrieval mode) statistics.

| Metric | Symbol / scope | Definition (summary) |
|--------|----------------|----------------------|
| **NDCG@10** | Graded relevance | Normalized DCG at rank 10; gain = **2^grade − 1**, discount = **1 / log2(rank+1)**. Grades in `RelevanceMap` (0–3). |
| **MRR@10** | First relevant in top 10 | Reciprocal rank of first hit with grade ≥ 1; 0 if none. |
| **Recall@3** | Coverage in top 3 | Fraction of ground-truth relevant entities (grade ≥ 1) that appear in positions 1–3. |
| **Recall@10** | Coverage in top 10 | Same, for **K = 10** (used in mode slices). |
| **Recall@100** | Coverage in top 100 | Same, for **K = 100** (global retrieval health). |
| **Wrong Top-1 rate** | Decision quality | Fraction of queries classified as **`wrong_resolve`** (RFC-009 §4.1). |
| **Decision utility** | Expected utility | Mean of per-query utility from **RFC-009 §5.1** weights (`correct_resolve`, `safe_abstain`, `wrong_resolve`, …). |
| **Safe / avoidable abstain rate** | Abstention behavior | Rates of `safe_abstain` vs `avoidable_abstain` after `classifyDecision`. |
| **AURC** | Selective prediction | Area under risk–coverage curve when sorting by `decision_confidence` (RFC-009 §5.3); lower is better. |
| **Excess AURC** | Calibration gap | `AURC − optimal AURC` for the same label set. |
| **ECE** | Calibration error | Expected calibration error (binned); targets documented in RFC-009 §7 / code comments. |

**Mode-specific extras** (Epic 11), when applicable: **diversity**, **producer variety**, **anchor preservation**, **attribute coverage**, **set coverage**, etc. — see `ModeMetrics` / `run-offline-eval.ts` aggregation.

**Default global release gates** (offline runner — advisory unless you run with `--tier gate`):

| Gate key | Example threshold | Role |
|----------|-------------------|------|
| `wrong_top1_rate_max` | ≤ 0.02 | Hard cap on wrong resolutions |
| `decision_utility_min_delta` | ≥ −0.05 | Regress utility vs baseline |
| `ndcg_at_10_min_delta` | ≥ −0.03 | NDCG@10 regression tolerance |
| `recall_at_100_min` | ≥ 0.90 | Broad recall floor |
| `aurc_max_delta` | ≤ 0.01 | Selective-prediction regression |
| `entity_resolve_wrong_top1_max` | ≤ 0.03 | Entity-resolve slice |
| `set_retrieval_recall_at_10_min` | ≥ 0.60 | Set-retrieval slice |
| `no_match_false_resolve_max` | ≤ 0.05 | No-match slice |

**Per–retrieval-mode floors** (e.g. `entity_lookup`, `constraint_filter`, `producer_browse`, …) are in `MODE_RELEASE_GATES` in the same file (NDCG@10, recall@10, diversity, etc.).

### Noisy entity benchmark (`run-noisy-entity-eval.ts`)

Evaluates **entity resolution under noisy queries** using `data/noisy-entity-benchmark.jsonl` (or custom `--input`), either from **live API** (`SEARCH_API_URL`) or a **predictions JSONL** (`--predictions`).

| Metric | Meaning |
|--------|---------|
| **Recall@1** | Expected entity appears at rank 1. |
| **Recall@3** | Expected entity in top 3 (primary headline metric for noisy entity). |
| **MRR** | Mean reciprocal rank of the expected entity. |
| **by_category** / **by_language** | Same three metrics sliced (typo, transliteration, `en`/`ko`/`mixed`, …). |
| **provenance_match_rate** | Agreement of reported provenance stage/source vs benchmark (when expectations exist). |
| **resolution_match_rate** | Agreement of decision status vs `expected_resolution` (when set). |
| **false_exact_rate** | Rate of “exact”-style outcomes where the benchmark expects a non-exact path (when tracked). |

**CLI quality gates** (optional): `--min-recall-at-3`, `--min-resolution-match-rate`, `--min-provenance-match-rate`, `--max-false-exact-rate`. **`npm run eval:noisy:gate`** sets strict smoke thresholds (e.g. recall@3 = 1 on the smoke predictions fixture).

### CI & npm shortcuts

| Command | What it checks |
|---------|----------------|
| `npm run eval:noisy:smoke` + `eval:noisy:assert-baseline` | Noisy metrics vs `data/eval-baselines/noisy-entity-smoke-v1.json` |
| `npm run eval:noisy:gate` | Threshold pass on smoke run (pipeline integrity) |
| `npm run test:verification:core` | `typecheck` + fast e2e + `eval:noisy:gate` + noisy baseline assert |
| `npm run eval:offline:*` | Full offline tiers; smoke baseline: `eval:offline:smoke:assert-baseline` |

---

## Test coverage & E2E scenarios

### How coverage is measured

- **Config:** `vitest.unit.config.ts` (also the **default** `vitest.config.ts` re-export).
- **Provider:** `@vitest/coverage-v8` with **`coverage.include`** = `src/**/*.ts` and excludes `**/*.test.ts`, `**/__tests__/**`, and `src/main.ts`.
- **Outputs:** `coverage/lcov.info` + terminal text (`coverage.reporter`: `text`, `lcov`).
- **Run:** `npm run test:coverage` (unit lane only — integration/e2e Vespa lanes are separate configs).

Coverage is **line-oriented on `src/`**; it does **not** automatically include HTTP e2e files under `test/e2e/` (those exercise the app via `inject()`, but live in another Vitest project).

### Vitest lanes (config → purpose)

| Config | `npm run …` | What runs |
|--------|-------------|-----------|
| `vitest.unit.config.ts` | `test`, `test:unit` | `test/unit/**/*.test.ts` + `src/**/__tests__/**/*.test.ts` + selected `src/__tests__` |
| `vitest.integration.config.ts` | `test:integration` | Explicit list: HTTP server, error handler, public query security, resolve route, contract registry, interpret schema, … |
| `vitest.e2e.config.ts` | `test:e2e:fast`, `test:e2e` | `test/e2e/**/*.test.ts` **except** `test/e2e/vespa/**` (in-memory harness, `singleFork`) |
| `vitest.e2e.smoke.config.ts` | `test:e2e:contract`, `test:e2e:smoke` | **Tiny** PR smoke: `search-api`, `schema-contract`, `batch-search-api`, `server-protocol` only |
| `vitest.e2e.vespa.config.ts` | `test:e2e:vespa` (via `scripts/run-vespa-e2e.sh`) | All `test/e2e/vespa/**/*.test.ts`; sets `VESPA_URL` (default `http://localhost:18080` in config) |
| `vitest.watchlist.config.ts` | `test:watchlist` | Watchlist domain + HTTP + Redis/webhook + contract manifest overlap |
| `vitest.quality.config.ts` | `test:quality` | Golden set, user journeys, decision utility, learning flywheel, eval unit tests, … |

### In-memory E2E (`test/e2e/*.test.ts`, `test:e2e:fast`)

Uses **`createTestServer()`** + Fastify **`inject()`** (no real TCP port). Typical scenarios:

| Suite file | Scenarios (summary) |
|------------|---------------------|
| **`search-api.test.ts`** | RFC-014 **HTTP contract** for `POST /v1/search`: entity/hybrid happy paths, `explain` / `clarification`, errors, policy blocks, interpret/resolve parity helpers |
| **`batch-search-api.test.ts`** | Batch search request/response shape, partial failure |
| **`schema-contract.test.ts`** | Response / request **Zod** shapes vs fixtures |
| **`server-protocol.test.ts`** | Global protocol (CORS hook, content-type, etc.) |
| **`golden-set.test.ts`** | **Retrieval quality** — top-k contains expected `entity_id` for named wines (EN/KO), relaxed ordering |
| **`user-journeys.test.ts`** | End-to-end **journeys**: multilingual same-entity, accent variants, ambiguity, mixed route, replay, failure handling |
| **`mixed-search.test.ts`** | Mixed route **does not crash**; non-empty results for seeded harness |
| **`realistic-scenarios.test.ts`**, **`edge-cases.test.ts`**, **`hard-scenarios.test.ts`** | Broader query shapes and edge behavior |
| **`response-invariants.test.ts`** | Stable fields / invariants on responses |
| **`claude-tools-api.test.ts`** | Claude tools list/execute HTTP surface |
| **`watchlist-api.test.ts`** | Watchlist CRUD / deliveries |
| **`infrastructure.test.ts`** | Infra-level checks wired to the test harness |

**Quality lane:** `test:quality` adds **`golden-set.test.ts`** + **`user-journeys.test.ts`** together with integration/unit eval tests (see `vitest.quality.config.ts`).

### Vespa-backed E2E (`test/e2e/vespa/**`, `test:e2e:vespa`)

Requires a **reachable Vespa** (`VESPA_URL`, health check). Many suites use **`describe.skipIf(!HAS_REACHABLE_VESPA)`** so local runs without Vespa **skip** instead of failing.

| Suite file | Scenarios (summary) |
|------------|---------------------|
| **`search-correctness.test.ts`** | **Sparse** retrieval vs seeded entities (exact/partial lookup, filters) |
| **`search-quality.test.ts`** | Ranking / quality assertions on live index |
| **`infrastructure-pipeline.test.ts`** | End-to-end pipeline against real Vespa |
| **`search-network-services.test.ts`** | **HTTP ML adapters** (`/embeddings`, `/rerank`) with **fake ML service** + Vespa test server |
| **`vespa-test-real-stores.test.ts`** | Real-store / integration checks (when enabled) |

Wrapper scripts (`scripts/run-vespa-test-lane.sh`, `setup-vespa-test.sh`, …) standardize env and teardown.

### What to run locally

| Goal | Command |
|------|---------|
| Default unit | `npm run test` |
| CI parity (unit) | `npm run test:unit` |
| HTTP + integration | `npm run test:integration` |
| Full in-memory e2e | `npm run test:e2e:fast` |
| Minimal contract smoke | `npm run test:e2e:contract` |
| Watchlist slice | `npm run test:watchlist` |
| Quality + eval units | `npm run test:quality` |
| Coverage report | `npm run test:coverage` |
| Vespa (Docker up) | `npm run test:e2e:vespa` |

---

## What this codebase implements (capabilities)

Condensed **feature checklist** (pipeline stages, endpoints, and algorithms are covered in sections 2–5 above). Details: **RFCs** + source.

### Search & retrieval

- **Query planning** — planner, ambiguity dictionary, anchor extraction, NL attribute mapping, constraint / intent handling (`src/domain/query/`, `src/application/search/`).
- **Entity resolution** — blocking, scoring, calibration, optional **learned matcher** HTTP blend; **per-candidate matcher feature vectors** for the learned path (`learned-matcher-features.ts`, wired from `resolver.ts`).
- **Alias matching** — multi-stage funnel including **char n-gram** fuzzy index (`CharNgramIndex`, `alias-matcher.ts`).
- **Retrieval** — candidate pool, fusion, browse/compare retrievers, **Vespa** search index adapter, hybrid / dense-sparse routing.
- **Ranking** — signals, evidence, optional **LTR**-style rerank hooks (`domain/ranking/`, application pipeline pieces).
- **Decision & response** — decision engine, threshold profiles, response builder; **drinking window** hints with ONNX or heuristic policy (`domain/drinking-window/`, `infrastructure/ml/`).
- **Mixed / similarity** — mixed solver for anchor + similarity neighborhoods (`domain/mixed/`).
- **Caching** — search response cache port + Redis-backed usage where wired (`domain/performance/`).

### Security & quality gates

- **Query sanitization**, **query-entry security** (injection / abuse heuristics, optional LLM judge path).
- **Rate limiting** (`@fastify/rate-limit`), structured **error contract** (RFC-014-style), snake_case response hook.

### Data & learning (when Postgres is enabled)

- **Feedback ingestion** — `POST /v1/feedback` persists signals for the learning loop; disabled when **`KILL_SWITCH_LEARNING`** is on or DB unavailable (`feedback.route.ts`, `PgFeedbackStore`).
- **Learning services** — feedback processor, alias proposer, proposal / feedback stores (`domain/learning/`, `container-learning.ts`). **Alias duplicate check** uses the live `aliases` table when a pool exists.
- **ETL** — Silver/NDJSON pipelines, alias generation, **rule-based KO transliteration** batch job (`scripts/etl/generate-transliteration-aliases.ts`, `Transliterator`), Vespa indexing helpers (`scripts/etl/index-to-vespa.ts`, …).

### Integrations

- **Watchlist** — domain + HTTP CRUD + Redis-backed delivery runtime when configured (`application/watchlist/`, `infrastructure/watchlist/`).
- **Claude tools** — tool executor + HTTP surface for agent-driven search (`interface/claude-tools/`).
- **Eval & quality** — offline eval, noisy-entity eval, baseline regression scripts (`scripts/eval/`), split verification; CI runs smoke + baseline checks.

### Infrastructure adapters (non-exhaustive)

- Postgres repositories (aliases, blocking, feedback, proposals, watchlist storage, …).
- Vespa client, embedding HTTP client, reranker HTTP client, learned matcher HTTP adapter.
- Optional eval runner wiring in the container for startup eval (`infrastructure/eval/`).

---

## Repository structure

### Root (selected)

| Path | Role |
|------|------|
| `src/` | Application, domain, infrastructure, interface, config |
| `test/unit/` | Unit tests by area |
| `test/integration/` | HTTP, DB helpers, route contracts |
| `test/e2e/` | Contract smoke, Vespa lanes, network-service tests |
| `scripts/` | ETL, eval, Vespa lane shell wrappers, HTTP contract export |
| `scripts/etl/` | NDJSON / Silver pipelines, transliteration, index-to-Vespa, validation |
| `vespa/app/` | Vespa schema (`schemas/`), `services.xml`, `hosts.xml`, query profiles |
| `services/reranker/` | Python FastAPI reranker image (Compose) |
| `data/` | Eval queries, baselines, smoke predictions (large files — review before commit) |
| `docs/` | RFCs, plans, runbooks; **`docs/archive/`** (dated note dumps); **`docs/sessions/`** (e.g. bug bash) |
| `models/` | Optional ONNX / model bundles (see drinking-window docs) |
| `docker-compose.yml` | Full dev stack (**project `wine-search-dev`**) |
| `docker-compose.test.yml` | Ephemeral test DB / alt ports (**project `wine-search-test`**) |
| `Dockerfile` | Multi-stage production image for the Node API |
| `.github/workflows/` | CI (lint, typecheck, tests, eval gates, Docker build) |

### `src/` layout (domain-driven)

| Path | Responsibility |
|------|----------------|
| `src/main.ts` | Process entry; loads config, runtime handles, container, HTTP server |
| `src/config/` | `env.ts`, **composition root** (`container.ts`, `container-core.ts`, `container-features.ts`, `container-learning.ts`, `container-watchlist.ts`, …), readiness |
| `src/domain/` | Bounded contexts: **query**, **resolver**, **alias**, **retrieval**, **ranking**, **decision**, **response**, **mixed**, **security**, **watchlist**, **learning**, **entity**, **ingestion**, **evaluation**, **performance**, **drinking-window**, **attribute**, **shared** (types, errors, utils) |
| `src/application/` | **Search** (orchestration + split helper modules), **resolve**, **hybrid**, **batch**, **replay**, **interpret**, **drinking-window**, **watchlist** use cases |
| `src/infrastructure/` | **adapters** (Postgres, HTTP ML), **db** + migrations, **vespa/**, **ml/** (ONNX drinking window), **redis** usage via shared client, **watchlist**, **telemetry**, **eval** |
| `src/interface/` | **http/** routes, schemas, middleware, errors; **claude-tools/**; **cli/** |

### HTTP routes (conceptual)

Declared in **`src/interface/http/routes/http-route-contract-catalog.ts`** (source of truth with `route-contracts.ts`). Includes search, batch, interpret, resolve, hybrid, replay, watchlist, **feedback**, Claude tools, health, OpenAPI JSON.

### Tests

See **Test coverage & E2E scenarios** (earlier in this document) for Vitest lanes, coverage scope, and per-file E2E intent.

| Location | Role |
|----------|------|
| `src/**/__tests__/` | Co-located unit tests |
| `test/unit/` | Focused unit suites |
| `test/integration/` | Server, HTTP contracts, schemas, selected policy tests |
| `test/e2e/` | In-memory HTTP e2e (`inject`) + `vespa/` for live retrieval |
| `vitest.*.config.ts` | Split configs: unit, integration, e2e, smoke, Vespa, watchlist, quality |

---

## Prerequisites

- **Node.js ≥ 22** and **npm**
- **Docker** + Docker Compose v2 (recommended for dependencies)
- Optional: **Semgrep** (`npm run semgrep`), local tools for Vespa/ML

---

## Bootstrap

```bash
git clone <internal-remote> wine-search-engine
cd wine-search-engine
npm ci
cp .env.example .env
# Edit .env — PG_*, REDIS_URL, VESPA_URL, ML URLs, secrets.
```

Before merging substantive changes: **`npm run lint`**, **`npm run typecheck`**, and tests touching your area.

---

## Configuration (`.env`)

Start from **`.env.example`**. Important groups:

| Group | Examples |
|-------|------------|
| Core | `NODE_ENV`, `PORT`, `LOG_LEVEL`, `HTTP_RATE_LIMIT_MAX`, `CORS_ALLOWED_ORIGINS` |
| Postgres | `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD` — empty password skips PG pool in several code paths |
| Redis | `REDIS_URL` |
| Vespa | `VESPA_URL`, `VESPA_CONTENT_CLUSTER` |
| ML HTTP | `EMBEDDING_SERVICE_URL`, `RERANKER_SERVICE_URL`, `RERANK_BLEND_SCALE`, optional `LEARNED_MATCHER_SERVICE_URL` |
| Anthropic | `ANTHROPIC_API_KEY` (optional features) |
| Drinking window | `ALLOW_HEURISTIC_DRINKING_WINDOW`, `DRINKING_WINDOW_MODEL_DIR` |
| Watchlist | `WATCHLIST_ENABLED`, `WEBHOOK_SECRET` |
| Kill switches | `KILL_SWITCH_ALIAS_OVERLAY`, `KILL_SWITCH_LEARNING`, `KILL_SWITCH_DENSE_RETRIEVAL`, `KILL_SWITCH_INJECTION_JUDGE`, `KILL_SWITCH_QUERY_CACHE` |
| Tests | `PG_TEST_URL` — often `postgresql://wine:wine_test@localhost:5433/wine_engine_test` for test Compose |

**Docker Compose (`docker-compose.yml`)** sets **`app`** service env so **`postgres`**, **`redis`**, **`vespa`**, **`reranker`** resolve by DNS; embedding may still use **`host.docker.internal`** for a host-side service.

---

## Running the API

```bash
npm run dev          # tsx watch src/main.ts
npm run build && npm run start   # dist/main.js
```

---

## Docker Compose

Two stacks; **avoid running two Vespa instances on conflicting host ports** on one machine.

### Full stack — `docker-compose.yml` (**`wine-search-dev`**)

```bash
docker compose up -d --build
```

| Service | Host ports | Notes |
|---------|------------|--------|
| API | `3000` | |
| Postgres | `5432` | `wine_engine` / `wine_dev` (see file) |
| Redis | `6379` | |
| Vespa | `8080`, config `19072`→`19071` | Host `VESPA_URL`: `http://localhost:8080` |
| Reranker | `8081` | Python image; first boot may download HF weights |

### Test lane — `docker-compose.test.yml` (**`wine-search-test`**)

```bash
docker compose -f docker-compose.test.yml up -d
```

| Service | Host ports |
|---------|------------|
| Postgres | `5433` — `wine_engine_test` |
| Redis | `6380` |
| Vespa | `18080`, `19071` — `VESPA_URL`: `http://localhost:18080` |

---

## Database migrations

SQL: `src/infrastructure/db/migrations/001_initial_schema.sql`.

If **`npm run migrate`** fails to resolve modules in your checkout, use **tsx**:

```bash
npx tsx -e "import { runMigrations } from './src/infrastructure/db/migrate.ts'; void runMigrations().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });"
```

---

## Scripts & npm commands (reference)

| Area | Commands |
|------|----------|
| Quality | `npm run lint`, `npm run typecheck`, `npm run test`, `test:coverage`, `test:unit`, `test:integration`, `test:watchlist`, `test:e2e:*`, `test:quality*`, `test:verification:core`, `test:verification:vespa` |
| HTTP contracts | `npm run contracts:http`, `contracts:http:openapi-bridge` |
| Eval | `npm run eval`, `eval:offline:*`, `eval:noisy*`, `eval:sota:parallel` |
| ETL | `npm run etl:transliteration`, plus `scripts/etl/*.ts` (aliases, index-to-vespa, validate-silver, …) |
| Ops | `npm run ingest`, `kill-switch`, `verify:drinking-window-model`, `vivino:bronze`, `finetuning:prepare` |

Many ETL/eval invocations use **`npx tsx --env-file=.env …`**.

---

## CI (GitHub Actions)

Jobs include **lint**, **typecheck**, **unit**, **integration**, **watchlist**, **e2e fast**, **verification-core** (`test:verification:core`), **verify-splits**, **noisy entity eval smoke + baseline assert**, then **build** + **Docker image build**. See **`.github/workflows/ci.yml`**.

---

## HTTP surface (quick reference)

**Full route list** (every method/path): [HTTP API: entry points & request flow](#http-api-entry-points--request-flow). **`GET /openapi.json`** — generated contract bridge.

| Topic | Notes |
|-------|--------|
| Readiness | `GET /ready` — dependency probes in `src/config/readiness.ts` |
| Feedback | `POST /v1/feedback` — **503** when ingest disabled, no Postgres, or **`KILL_SWITCH_LEARNING`** |
| Drinking window | ONNX bundle: **`docs/drinking-window-model-bundle.md`** |

---

## Further reading

- **`docs/RFC-*.md`** — protocol and behavior (authoritative for edge cases).
- **`CLAUDE.md`** — short architecture + command cheat sheet.
- **`docs/eval-baseline-runbook.md`** — refreshing / asserting offline & noisy baselines.
- **`docs/archive/2026-04-root-notes/`** — archived epic/debugging/wave/task notes (moved from repo root).
- **`docs/sessions/bugbash-apr-6/`** — Apr 2026 bug bash audit and remediation backlog.

**Reading order (new hires):** Quick start → Document map → Bootstrap & Docker → Architecture + HTTP flow → Evaluation + Tests → RFCs for your area.

---

## License / distribution

Internal use unless otherwise stated by your organization.
