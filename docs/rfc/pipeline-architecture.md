# Wine Search Engine — Full Pipeline Architecture (v6-SOTA++, 2026-04-09)

## 1. Agent → Search → Response 전체 흐름

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER QUERY                                   │
│  "보르도 2018 레드 와인 추천, 5만원 이하"                              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     AGENT ORCHESTRATOR                               │
│  (src/application/agent/agent-orchestrator.ts)                       │
│                                                                      │
│  ┌─────────────────────────────────────────────────────┐             │
│  │ ReAct Loop (maxSteps=5, perStepTimeout=10s)         │             │
│  │                                                      │             │
│  │  Step 0: LLM → {"actions": [                        │             │
│  │    {tool: "search_wines",                            │             │
│  │     input: {query: "보르도 2018 레드",               │             │
│  │             wine_type: "red",      ← structured     │             │
│  │             country: "France",     ← Vespa filter    │             │
│  │             vintage_min: 2018,     ← Vespa filter    │             │
│  │             max_price_krw: 50000}} ← post-filter     │             │
│  │  ]}                                                  │             │
│  │                                                      │             │
│  │  Step 1: LLM → {"thought":"...", "answer":"..."}    │             │
│  └──────────────────────┬──────────────────────────────┘             │
│                         │                                            │
│  Guards:                │                                            │
│  • Placeholder block    │  (Zod refine: __TO_BE_FILLED__ 거부)       │
│  • Parallel batch       │  (skipNearDuplicate for similar queries)   │
│  • Truncation recovery  │  (finishReason=length → parse attempt)     │
│  • Bare tool call       │  ({"tool":"..."} without "action" wrapper) │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      AGENT TOOL LAYER                                │
│  (src/application/agent/agent-tools.ts)                              │
│                                                                      │
│  search_wines:                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ 1. Zod validation (SearchInputSchema + placeholder block)   │    │
│  │ 2. buildStructuredFilters(parsed)                            │    │
│  │    → NormalizedConstraint[] (wine_type, country, vintage,    │    │
│  │      appellation, style, certification, exclude_*)           │    │
│  │ 3. enrichedQuery = query + "not Cabernet, 50000원 이하"     │    │
│  │ 4. SearchRequest { query, filters: structuredFilters }       │    │
│  │ 5. Price post-filter (priceRange > budget → drop)           │    │
│  │ 6. Negation post-filter (exclude_grapes/regions → drop)     │    │
│  │ 7. summarizeSearchResults() → observation text               │    │
│  │    (includes: label, producer, region, vintage, grapes,      │    │
│  │     price, style, critic score, alcohol%, drinking window)   │    │
│  │ 8. PRICE_FILTER annotation for judge grounding              │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  compare_wines | check_drinking_window | get_food_pairings           │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     SEARCH USE CASE                                  │
│  (src/application/search/search.usecase.ts)                          │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                   PRE-ROUTE PHASE                             │    │
│  │  1. Security sanitization                                     │    │
│  │  2. request.filters → plan.constraints.hard 병합             │    │
│  │  3. Query Planner → QueryPlanV2                              │    │
│  │  4. Constraint SAT check (contradiction detection)           │    │
│  │  5. Cache lookup                                              │    │
│  └──────────────────────────────┬───────────────────────────────┘    │
│                                 │                                    │
│  ┌──────────────────────────────▼───────────────────────────────┐    │
│  │                   ROUTE DISPATCH                              │    │
│  │  entity / hybrid / mixed / decomposed                        │    │
│  └──────────────────────────────┬───────────────────────────────┘    │
│                                 │                                    │
│  ┌──────────────────────────────▼───────────────────────────────┐    │
│  │                   POST-ROUTE PHASE                            │    │
│  │  1. Entropy abstain check (RFC-013)                          │    │
│  │  2. Decision Engine (confidence C, Δ, authority)             │    │
│  │  3. Response Builder                                          │    │
│  │  4. sensoryPriors → drinking window prediction (RFC-018)     │    │
│  │  5. Cache write                                               │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
                    SearchResponseV1
```

---

## 2. Query Planner — 6-Tier Deterministic Constraint Cascade (RFC-019)

```
                          Query: "보르도 2018 레드 와인 추천"
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STAGE 1: Span Parser                                                │
│  (src/domain/attribute/service/span-parser.ts)                       │
│                                                                      │
│  Input:  "보르도 2018 레드 와인 추천"                                  │
│  Output: [                                                           │
│    Span("보르도",     0-3,  1-gram),                                  │
│    Span("2018",       4-8,  1-gram),                                  │
│    Span("레드",       9-11, 1-gram),                                  │
│    Span("와인",       12-14, 1-gram),                                 │
│    Span("추천",       15-17, 1-gram),                                 │
│    Span("보르도 2018", 0-8,  2-gram),                                 │
│    Span("레드 와인",   9-14, 2-gram),                                  │
│    ...                                                               │
│  ]                                                                   │
│  • Punctuation stripped, NFKC normalized                             │
│  • MAX_SPAN_TOKENS = 3                                               │
│  • Position-preserving for overlap resolution                        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
          ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  TIER 1          │  │  TIER 2          │  │  TIER 3-4        │
│  Symbolic Lookup │  │  Entity Resolver │  │  Ontology +      │
│                  │  │                  │  │  Compositional   │
│  DEFAULT_MAPPINGS│  │  RESOLVER_INDEX  │  │                  │
│  (150 phrases)   │  │  (~300 entries)  │  │  REGION_PARENTS  │
│                  │  │                  │  │  (120 regions)   │
│  "레드"          │  │  "보르도"        │  │  +               │
│  → body≥0.7? No  │  │  → region=       │  │  12 composition  │
│  → wine_type=    │  │  Bordeaux ✓      │  │  rules           │
│    red? No (not  │  │                  │  │                  │
│    in DEFAULT)   │  │  "카베르네"      │  │                  │
│  "풀바디"        │  │  → grape_primary=│  │                  │
│  → body≥0.7 ✓   │  │  Cabernet Sauv ✓ │  │                  │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                    │
         └────────────────────┼────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  OVERLAP RESOLUTION (resolveOverlaps)                                │
│                                                                      │
│  Longest-match priority:                                             │
│  "레드 와인" (2-gram, resolved wine_type=red) wins over              │
│  "레드" (1-gram) + "와인" (1-gram, unresolved)                       │
│                                                                      │
│  Resolved spans → NormalizedConstraint[]                             │
│  Unresolved spans → missedPhrases[]                                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TIER 3: Ontology Expansion                                          │
│  (src/domain/attribute/service/ontology-expansion.ts)                │
│                                                                      │
│  Input:  hard [region=Bordeaux, wine_type=red]                       │
│          soft []                                                     │
│          inferred []                                                 │
│                                                                      │
│  Expansion:                                                          │
│    region=Bordeaux                                                   │
│      → REGION_PARENTS["bordeaux"] = ["france"]                       │
│      → soft: country=France (confidence 0.85)                        │
│                                                                      │
│  Output: hard [region=Bordeaux, wine_type=red]                       │
│          soft [country=France]                                       │
│          inferred []                                                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TIER 4: Compositional Inference                                     │
│  (src/domain/attribute/service/compositional-inference.ts)           │
│                                                                      │
│  Rule: bordeaux_red                                                  │
│    matches: region=bordeaux + wine_type=red ✓                        │
│    emits:                                                            │
│      inferred: grape_family ∈ [Cabernet, Merlot]                     │
│      inferred: tannin ≥ 0.55                                        │
│                                                                      │
│  12 deterministic rules:                                             │
│  bordeaux_red | burgundy_red | burgundy_white | napa_red |           │
│  barolo | brunello | champagne | rioja | mosel | marlborough |       │
│  mendoza | barossa                                                   │
│                                                                      │
│  Output: hard [region=Bordeaux, wine_type=red]                       │
│          soft [country=France]                                       │
│          inferred [grape_family∈[Cab,Merlot], tannin≥0.55]          │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                    (Tier 5: LLM Linker — disabled)
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  TIER 6: Regex Extractor (sole-extraction when Tier 1+2 = 0)        │
│  (src/domain/query/service/rule-based-constraint-extractor.ts)       │
│                                                                      │
│  Fires ONLY when Tier 1+2 produced zero constraints.                 │
│  NOT a "fallback" — last tier of the deterministic cascade.          │
│                                                                      │
│  Extracts: wine_type (regex), country (regex), price (KRW patterns), │
│            vintage (year patterns), exclusions (negation patterns)    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
                    ConstraintBundle {
                      hard:     [region=Bordeaux, wine_type=red]
                      soft:     [country=France]
                      inferred: [grape_family∈[Cab,Merlot], tannin≥0.55]
                    }
```

---

## 3. Retrieval Pipeline (hard → Vespa YQL, soft → boost, inferred → prior)

```
                         ConstraintBundle
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  RETRIEVAL PLAN BUILDER (RFC-019 Phase 6)                            │
│  (src/domain/retrieval/service/retrieval-plan-builder.ts)            │
│                                                                      │
│  ┌─────────────────┐  ┌──────────────────┐  ┌────────────────────┐  │
│  │ HARD FILTER      │  │ SOFT BOOST        │  │ INFERRED           │  │
│  │ → Vespa YQL      │  │ → ranking score   │  │ → ranking boost    │  │
│  │ WHERE clause      │  │ computeSoft       │  │ + sensory priors   │  │
│  │                   │  │ Constraint()      │  │ for RFC-018        │  │
│  │ region=Bordeaux   │  │                   │  │                    │  │
│  │ wine_type=red     │  │ country=France    │  │ grape_family∈Cab   │  │
│  │ vintage_year≥2018 │  │ → weight 0.85     │  │ tannin≥0.55        │  │
│  │                   │  │                   │  │ → weight 0.7×conf  │  │
│  └────────┬──────────┘  └────────┬─────────┘  └────────┬───────────┘  │
│           │                      │                      │             │
└───────────┼──────────────────────┼──────────────────────┼─────────────┘
            │                      │                      │
            ▼                      ▼                      ▼
┌───────────────────┐  ┌──────────────────┐  ┌────────────────────────┐
│ VESPA RETRIEVAL   │  │ RANKER           │  │ DRINKING WINDOW        │
│                   │  │ (signal-computer)│  │ PREDICTOR (RFC-018)    │
│ hardConstraints   │  │                  │  │                        │
│ → filterTokens    │  │ softConstraint   │  │ input.tannin =         │
│ → buildSparse     │  │ score [0,1]      │  │   r.tannin             │
│   Filters()       │  │                  │  │   ?? prior.tannin      │
│ → YQL:            │  │ inferredConstraint│ │   ?? 0.5              │
│   AND region      │  │ score at 0.5×    │  │                        │
│   contains        │  │                  │  │ → window start/end     │
│   "Bordeaux"      │  │ attributeAlignment│ │ → confidence           │
│   AND wine_type   │  │ score            │  │                        │
│   contains "red"  │  │                  │  │ Coverage: indexed +     │
│                   │  │                  │  │ query-level prior      │
│ Channels:         │  │                  │  │                        │
│ • sparse (BM25)   │  │ Component scores:│  │                        │
│ • dense (ANN)     │  │ → finalScore     │  │                        │
│ • learned sparse  │  │ → rank           │  │                        │
└───────────────────┘  └──────────────────┘  └────────────────────────┘
```

---

## 4. Benchmark Measurement Framework (RFC-020)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     BENCHMARK RUNNER                                 │
│  (test/benchmark/agent/runner.ts)                                    │
│                                                                      │
│  For each scenario:                                                  │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ 1. Agent execution                                           │    │
│  │    orchestrator.execute(query) → answer, steps, tools        │    │
│  │                                                               │    │
│  │ 2. LLM Judge (N=3 median, CoT+few-shot, temperature=0.1)   │    │
│  │    judgeAnswerN() → rubric score [0,1]                       │    │
│  │    judgeFaithfulness() → NLI atomic claim score [0,1]        │    │
│  │                                                               │    │
│  │ 3. Constraint Extraction Eval Rig (RFC-020 offline)          │    │
│  │    runConstraintExtraction(query)                             │    │
│  │    → bundle + trace + resolvedEntities                        │    │
│  │    → scoreSemanticConstraintRecall(bundle, expected)          │    │
│  │    → scoreEntityLinkingAccuracy(expected)                     │    │
│  │    → scoreSlotF1(bundle, expected)                            │    │
│  │                                                               │    │
│  │ 4. scoreScenario() → ScenarioScores                          │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  Aggregation:                                                        │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Overall = weightedGeometricMean(                              │    │
│  │   answerQuality:        0.25                                  │    │
│  │   executionEfficiency:  0.20                                  │    │
│  │   faithfulness:         0.10                                  │    │
│  │   contextRelevance:     0.10                                  │    │
│  │   costEfficiency:       0.10                                  │    │
│  │   terminationCorrectness: 0.10                                │    │
│  │   judge:                0.15                                  │    │
│  │   contextRecall:        0.00 (diagnostic)                     │    │
│  │   SCR/ELA/SlotF1:       0.00 (diagnostic, RFC-020 Phase F)   │    │
│  │ )                                                             │    │
│  │                                                               │    │
│  │ Bootstrap 95% CI (2000 resamples, seeded)                    │    │
│  │ Student-t CI (backup)                                         │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  stderr output:                                                      │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ ────── dimensions ──────                                      │    │
│  │ Exec Eff:     96.1%   (tool 94% × step 100%)                │    │
│  │ Answer Qual:  100.0%                                          │    │
│  │ Faithful:     77.3%                                           │    │
│  │ Ctx Relev:    73.5%                                           │    │
│  │ Judge:        60.0%                                           │    │
│  │                                                               │    │
│  │ ────── constraint extraction (RFC-020) ──────                 │    │
│  │ SCR overall:   51.7%   SCR hard:  66.7%                      │    │
│  │ ELA@1:         90.0%                                          │    │
│  │ Slot F1:       53.1%                                          │    │
│  │                                                               │    │
│  │ ────── execution ───────                                      │    │
│  │ Latency p50:  6462ms  [SLA <10s: PASS]                       │    │
│  │ Latency p95:  11945ms [SLA <20s: PASS]                       │    │
│  └──────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 5. Data Flow Summary (한 눈에)

```
User Query
  │
  ▼
Agent Orchestrator ──────── ReAct Loop (structured params)
  │
  ▼
Agent Tool Layer ─────────── Zod validation + post-filters
  │
  ├── SearchRequest { query, filters: NormalizedConstraint[] }
  │
  ▼
Search Use Case
  │
  ├── Pre-Route: security → planner → SAT check → cache
  │     │
  │     └── Query Planner (RFC-019 6-Tier Cascade)
  │           │
  │           ├── Tier 1: Symbolic (DEFAULT_MAPPINGS 150)
  │           ├── Tier 2: Entity Resolver (RESOLVER_INDEX ~300)
  │           ├── Tier 3: Ontology Expansion (REGION_PARENTS 120)
  │           ├── Tier 4: Compositional Inference (12 rules)
  │           ├── Tier 5: LLM Linker (disabled)
  │           └── Tier 6: Regex Extractor (last tier)
  │           │
  │           ▼
  │     ConstraintBundle { hard, soft, inferred }
  │           │
  │           ├── hard → Vespa YQL WHERE filters
  │           ├── soft → ranking boost (signal-computer)
  │           └── inferred → ranking boost + sensory priors (RFC-018)
  │
  ├── Route: entity / hybrid / mixed
  │     │
  │     ├── Vespa sparse (BM25) + dense (ANN) + learned sparse
  │     ├── Candidate Pool → HybridCandidate[]
  │     └── Ranker → RankedResult[]
  │           │
  │           ├── entity fields: label, producer, region, vintage,
  │           │   grapes, price, style, critic score, alcohol%,
  │           │   body, tannin, acidity, sweetness, certifications,
  │           │   pairingTags, occasion, classification
  │           │
  │           └── drinking window prediction (heuristic / ML)
  │                 ├── indexed sensory → direct
  │                 └── missing sensory → query-level prior (RFC-019 Phase 7)
  │
  └── Post-Route: decision engine → response builder → cache
        │
        ▼
  SearchResponseV1 { results, engineDecision, meta }
        │
        ▼
  Agent observation text → LLM → final answer
        │
        ▼
  Benchmark scorer → Overall 81.3% (v6-SOTA++)
```

---

## 6. 모듈 파일 맵

```
src/
├── application/
│   ├── agent/
│   │   ├── agent-orchestrator.ts    ← ReAct loop, placeholder block, truncation recovery
│   │   ├── agent-prompt.ts          ← System prompt (tool descriptions, rules, structured params)
│   │   └── agent-tools.ts           ← Tool schemas, structured filters, post-filters, observation
│   └── search/
│       ├── search.usecase.ts        ← Main search orchestrator
│       ├── search-usecase-pre-route-phase.ts  ← request.filters → plan.constraints.hard merge
│       ├── search-usecase-post-route-phase.ts ← sensoryPriors → drinking window
│       ├── search-usecase-map-result-items.ts ← EntitySummary enrichment (price, style, critic)
│       ├── extract-sensory-priors.ts          ← RFC-019 Phase 7 helper
│       └── search-request.dto.ts              ← SearchRequest.filters field
│
├── domain/
│   ├── attribute/
│   │   ├── service/
│   │   │   ├── nl-mapper.ts              ← Tier 1: DEFAULT_MAPPINGS (150 phrases)
│   │   │   ├── llm-nl-mapper.ts          ← Tier 5: LLM Linker (disabled)
│   │   │   ├── entity-resolver.ts        ← Tier 2: RESOLVER_INDEX (~300 entries)  [RFC-019]
│   │   │   ├── span-parser.ts            ← Stage 1: Span parsing + overlap resolution [RFC-019]
│   │   │   ├── ontology-expansion.ts     ← Tier 3: Region → country derivation [RFC-019]
│   │   │   ├── compositional-inference.ts ← Tier 4: 12 composition rules [RFC-019]
│   │   │   └── ontology-normalizer.ts    ← Existing ~300 entry normalizer
│   │   └── model/
│   │       └── constraint-extraction-trace.ts ← 6-tier trace schema
│   ├── query/
│   │   └── service/
│   │       ├── planner.ts                ← parseConstraints() with 6-tier cascade [RFC-019]
│   │       └── rule-based-constraint-extractor.ts ← Tier 6: regex patterns
│   ├── ranking/
│   │   ├── service/
│   │   │   ├── ranker.ts                 ← Score aggregation (price, style, critic → EntitySummary)
│   │   │   └── signal-computer.ts        ← Soft/inferred constraint scoring
│   │   └── model/
│   │       └── ranked-result.ts          ← price, style, classification fields
│   ├── retrieval/
│   │   └── service/
│   │       ├── retrieval-plan-builder.ts  ← Hard/soft/inferred → filter/boost/prior [RFC-019]
│   │       └── constraint-to-sparse-filter-tokens.ts ← NormalizedConstraint → Vespa YQL tokens
│   ├── evaluation/
│   │   └── service/
│   │       └── wine-ontology.ts          ← REGION_PARENTS, GRAPE_ALIASES, WINE_TYPE_ALIASES
│   └── response/
│       └── model/
│           └── result-item.ts            ← EntitySummary (enriched: style, critic, alcohol, etc.)
│
├── infrastructure/
│   ├── vespa/
│   │   ├── mapping.ts                    ← buildSparseFilters() → YQL
│   │   └── vespa-search-index.ts         ← Sparse/dense/learned sparse search
│   └── ml/
│       └── drinking-window-predictor.ts  ← Heuristic / ONNX predictor
│
test/benchmark/agent/
├── runner.ts                              ← Benchmark runner (N=3 judge, bootstrap CI, SLA)
├── scorer.ts                              ← ScenarioScores (13 dims + RFC-020 7 dims)
├── judge.ts                               ← CoT + few-shot + NLI atomic claim faithfulness
├── scenario.ts                            ← ScenarioExpectation + expectedConstraints/Entities
├── scenarios.ts                           ← 95 scenarios with annotations
├── constraint-extraction-eval.ts          ← Offline eval rig (planner standalone) [RFC-020]
└── constraint-metrics.ts                  ← SCR, ELA, Slot F1, CSR, UDCG, Brier [RFC-020]

docs/rfc/
├── RFC-019-nl-mapper-coverage.md          ← Ontology-driven semantic compiler
└── RFC-020-constraint-extraction-measurement.md ← Measurement framework
```
