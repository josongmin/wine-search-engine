# Bug Bash — 2026-04-09 Full Codebase 20-Round Audit

**Scope**: 전체 코드베이스 20-round 병렬 감사 (4 agent x 5 rounds)
**방법론**: 휴리스틱 / 폴백 / 나이브 코딩 / 저품질 엔지니어링 4축 심층 탐색
**결과**: **75 findings** — 0 P0, 8 P1, 30 P2, 19 P3, 18 cross-cutting

---

## Severity Summary

| Severity | Count | Description |
|----------|-------|-------------|
| **P0**   | 0     | —           |
| **P1**   | 8     | 데이터 무결성 훼손, silent 실패, 보안 guard 부재 |
| **P2**   | 30    | unjustified heuristic, 미흡한 type safety, 성능 비효율 |
| **P3**   | 19    | minor style, defense-in-depth, documentation |

---

## P1 Findings (Critical)

### P1-1. Unchecked `as` cast on LLM-parsed JSON
- **File**: `src/application/agent/agent-orchestrator.ts:244`
- **Category**: LOW_QUALITY
- `parsed['action'] as Record<string, unknown>` — unvalidated nested value. If `parsed['action']` is a string/number, code proceeds with garbage typed as Record.
- **Fix**: Guard `typeof action === 'object' && action !== null && !Array.isArray(action)` before cast.

### P1-2. Unsafe `SearchResponseV1` double-cast
- **File**: `src/application/agent/agent-orchestrator.ts:756-759`
- **Category**: LOW_QUALITY
- `result.rawResult as SearchResponseV1` — only validates `'queryType' in obj`. Missing `results` array would crash downstream.
- **Fix**: Zod schema or shape guard before cast.

### P1-3. VespaClient `query()` double-cast allows `source: undefined` as `string`
- **File**: `src/infrastructure/vespa/vespa-client.ts:392`
- **Category**: LOW_QUALITY
- `data as unknown as VespaQueryResponse` — validates `root`/`children` but NOT per-hit `source` field.
- **Fix**: Add `source` validation in per-hit loop or make `source` optional in `VespaHit`.

### P1-4. Silent diagnostic loss in `expectedToolArgs` catch
- **File**: `test/benchmark/agent/scorer.ts:1272`
- **Category**: FALLBACK
- Catch returns `false` on malformed JSON with zero diagnostic. Serialization bugs silently fail all `expectedToolArgs` checks.
- **Fix**: Emit `TOOL_ARG_PARSE_FAILED` diagnostic in catch block.

### P1-5. Dead `refusalExpected` branch — zero signal without judge
- **File**: `test/benchmark/agent/scorer.ts:1316-1344`
- **Category**: FALLBACK
- Empty if-body: `refusalExpected: true` with no judge scores `answerQuality=1.0` even for fabricated answers.
- **Fix**: Emit `REFUSAL_NO_JUDGE_SIGNAL` diagnostic; consider pattern-match for refusal keywords.

### P1-6. `callJudgeOnce` swallows ALL errors as "noise"
- **File**: `test/benchmark/agent/judge.ts:220-222`
- **Category**: FALLBACK
- Catch returns `null` for systematic bugs (prompt too long, malformed prompt) — shows as "judge skipped".
- **Fix**: Log to stderr; distinguish transient vs systematic errors.

### P1-7. Divergent KRW-to-USD rate: 7 vs 1400-derived
- **File**: `src/domain/query/service/rule-based-constraint-extractor.ts:18`
- **Category**: HEURISTIC
- `KRW_MANWON_TO_USD_HEURISTIC = 7` diverges from `KRW_PER_USD_APPROXIMATE = 1350` (->7.14). Two code paths produce different USD values for same KRW input.
- **Fix**: Derive from single SSOT `KRW_PER_MAN_WON / KRW_PER_USD_APPROXIMATE`.

### P1-8. NL Mapper silent degradation — no retry, no flag
- **File**: `src/domain/query/service/planner.ts:567-579`
- **Category**: FALLBACK
- NLMapper failure catch logs warning then continues with empty constraints. Downstream sees "successful" plan with zero NL constraints.
- **Fix**: Surface `degradation.reasons` in QueryPlan; retry once for transient errors.

---

## P2 Findings (High)

### Domain / Evaluation / Security

| ID | File:Line | Cat | Description |
|----|-----------|-----|-------------|
| P2-1 | `claim-verifier-deterministic.ts:34-44` | HEURISTIC | 12 threshold constants lack domain justification |
| P2-2 | `claim-extractor.ts:269` | HEURISTIC | Duplicated `USD_TO_KRW = 1350` (also in wine-ontology.ts:312); should use `shared/constants.ts` |
| P2-3 | `agent-tools.ts:599-603` | NAIVE | `new RegExp` per negation term per result item — O(N*M) regex construction |
| P2-4 | `claim-extractor.ts:149-151` | NAIVE | `containsAsWord` creates regex per call over 46 grapes loop |
| P2-5 | `evidence-parser.ts:267` | LOW_QUALITY | `as Record<string, unknown>` without `!Array.isArray(item)` guard |
| P2-6 | `evidence-parser.ts:249` | LOW_QUALITY | `as EvidenceRecord` on constructed object violates codebase `as`-cast rule |
| P2-7 | `wine-ontology.ts:312` | LOW_QUALITY | Duplicate FX rate constant; single source of truth violation |
| P2-8 | `agent-orchestrator.ts:276-283` | FALLBACK | LLM JSON parse failure falls back to raw text as user answer |
| P2-9 | `agent-tools.ts:459-469` | FALLBACK | Generic catch swallows tool errors without logging actual error |

### Infrastructure / Telemetry / Config

| ID | File:Line | Cat | Description |
|----|-----------|-----|-------------|
| P2-10 | `container.ts:129` | HEURISTIC | `maxContextChars: 8_000` magic number |
| P2-11 | `vespa-client.ts:208-210` | HEURISTIC | Retry config magic numbers without justification |
| P2-12 | `vespa-client.ts:543` | FALLBACK | `get()` returns `{}` instead of `null` for missing fields |
| P2-13 | `vespa-client.ts:563-579` | NAIVE | `bulkFeed` fires ALL PUTs concurrently — no concurrency limit |
| P2-14 | `anthropic-llm-injection-classifier.ts:162` | LOW_QUALITY | `as` cast on SDK content block without runtime guard |
| P2-15 | `anthropic-llm-injection-classifier.ts:43` | LOW_QUALITY | `as { status?: number }` on unknown error |
| P2-16 | `server.ts:409` | LOW_QUALITY | Raw error object logged without pino serializer |
| P2-17 | `openai-chat-llm.ts:114` | HEURISTIC | Fragile model-family regex (`/^(?:gpt-5\|o\d)/i`) |
| P2-18 | `env.ts:160` | LOW_QUALITY | `z.number()` without `.finite()` on `RERANK_BLEND_SCALE` |

### Benchmark / Test

| ID | File:Line | Cat | Description |
|----|-----------|-----|-------------|
| P2-19 | `scorer.ts:981` | HEURISTIC | `PENALTY_TOOL_DUPLICATE` Math.max is inverted — mild over-calling gets same penalty as extreme |
| P2-20 | `scorer.ts:1704` | FALLBACK | Catch returns `''` silently dropping malformed tool inputs |
| P2-21 | `scorer.ts:2254` | HEURISTIC | `EPS = 1e-6` in geo-mean undocumented impact |
| P2-22 | `runner.ts:448` | LOW_QUALITY | `as T` suppresses `noUncheckedIndexedAccess` |
| P2-23 | `runner.ts:887` | LOW_QUALITY | Judge LLM `apiKey ?? ''` passes empty string without guard |
| P2-24 | `runner.ts:500-513` | NAIVE | `isTransient` substring check for '400' matches `14003`, `port 4003` etc. |
| P2-25 | `constraint-metrics.ts:349-358` | NAIVE | Greedy slot matching is non-optimal vs Hungarian algorithm |
| P2-26 | `constraint-metrics.ts:427-435` | LOW_QUALITY | CSR range matching extracts ALL numbers from observations — no attribute awareness |
| P2-27 | `scorer.test.ts` (missing) | LOW_QUALITY | No tests for `extractVintageYears`, `extractKoreanPrices`, `extractProperNouns`, `evaluatePredicate` |

### Query / Retrieval / Ranking

| ID | File:Line | Cat | Description |
|----|-----------|-----|-------------|
| P2-28 | `scoring-weights.ts:76-91` | HEURISTIC | DEFAULT_WEIGHTS sum to 0.95, not 1.0 — silent score deflation |
| P2-29 | `mode-weights.ts:72-211` | HEURISTIC | Several ModeWeightProfile sums exceed 1.0 |
| P2-30 | `span-parser.ts:113-119` | NAIVE | O(n*k) overlap detection without interval tree |
| P2-31 | `query-normalizer.ts:175-192` | NAIVE | Recursive permutation generates O(n!) intermediate arrays |
| P2-32 | `entity-resolver.ts:214` | NAIVE | `[...hits].sort()` per call; pre-sort at build time |
| P2-33 | `rule-based-constraint-extractor.ts:69-80` | LOW_QUALITY | `break` on first country match — multi-country queries lose data |
| P2-34 | `resolver.ts:86-97` | LOW_QUALITY | Negative lookup weights undocumented |
| P2-35 | `ranker.ts:177-190` | FALLBACK | Stale LTR model (>30d) still applied without quality gate |
| P2-36 | `compositional-inference.ts:65` | HEURISTIC | Comparison markers missing Korean terms |
| P2-37 | `nl-mapper.ts:502-508` | LOW_QUALITY | `as string \| number` without runtime type guard |
| P2-38 | `resolver.ts:219-223` | FALLBACK | Learned matcher failure silently degrades without threshold adjustment |

---

## P3 Findings (Medium-Low)

| ID | File:Line | Cat | Description |
|----|-----------|-----|-------------|
| P3-1 | `agent-orchestrator.ts:63` | HEURISTIC | `CHARS_PER_TOKEN_ESTIMATE=4` wrong for CJK |
| P3-2 | `claim-extractor.ts:126` | HEURISTIC | `VINTAGE_WINDOW_GAP_MAX=30` unjustified |
| P3-3 | `evidence-parser.ts:56-57` | FALLBACK | JSON.parse catch silent fallthrough |
| P3-4 | `claim-level-evaluator.ts:103-116` | NAIVE | 4x `.filter()` for verdict counts; single-pass loop |
| P3-5 | `claim-extractor.ts:233` | LOW_QUALITY | `m.index` unguarded `undefined` |
| P3-6 | `claim-extractor.ts:257` | HEURISTIC | `maxYear = now+1` computed in loop |
| P3-7 | `agent-orchestrator.ts:394` | HEURISTIC | `MAX_TOOLS_PER_BATCH=4` mismatched comment |
| P3-8 | `agent-orchestrator.ts:381` | HEURISTIC | `MAX_UNKNOWN_TOOL_ATTEMPTS=2` no rationale |
| P3-9 | `adaptive-budget.ts:200` | NAIVE | Regex allocated inside function body (rule 16) |
| P3-10 | `anthropic-chat-llm.ts:32` | HEURISTIC | `ANTHROPIC_DEFAULT_MAX_TOKENS=1024` undocumented |
| P3-11 | `vespa-client.ts:33` | HEURISTIC | `VESPA_HIT_DROP_WARN_THRESHOLD=0.2` ad-hoc |
| P3-12 | `openai-chat-llm.ts:189` | FALLBACK | `usage.prompt_tokens ?? 0` silently defaults |
| P3-13 | `redis-client.ts:9-12` | LOW_QUALITY | Reconnect race window undocumented |
| P3-14 | `env.ts:288` | LOW_QUALITY | Missing `.finite()` on `CONFIDENCE_REFUSAL_THRESHOLD` |
| P3-15 | `constraint-metrics.ts:293` | HEURISTIC | ELA precision=0 conflates "no links" with "all wrong" |
| P3-16 | `scorer.test.ts:863` | LOW_QUALITY | `REQUIRED_KEYS` missing `faithfulness` |
| P3-17 | `compositional-inference.ts:32-37` | HEURISTIC | Priors without empirical calibration |
| P3-18 | `phonetic.ts:21-28` | LOW_QUALITY | CODES Record allocated inside function (rule 16) |
| P3-19 | `search-constraint-extractor.ts:503-510` | LOW_QUALITY | Array `.includes()` dedup — should use Set |

---

## Category Distribution

| Category | Count | % |
|----------|-------|---|
| HEURISTIC | 23 | 31% |
| FALLBACK | 16 | 21% |
| NAIVE | 14 | 19% |
| LOW_QUALITY | 22 | 29% |

---

## Top Systemic Patterns

### 1. Unjustified Magic Numbers (23 findings, 31%)
가장 빈번한 패턴. threshold, weight, penalty, timeout 값에 domain justification 부재. 특히:
- Scoring weights 합이 1.0이 아님 (P2-28, P2-29)
- FX rate 3곳 중복, 값 불일치 (P1-7, P2-2, P2-7)
- Claim verifier의 12개 threshold 전부 calibration 근거 없음 (P2-1)

### 2. Silent Fallback / Error Swallowing (16 findings, 21%)
catch block이 에러를 삼키고 degraded 상태를 정상으로 위장하는 패턴:
- NL Mapper 실패 -> 빈 constraint bundle로 "성공" (P1-8)
- LLM JSON parse 실패 -> raw text가 user answer가 됨 (P2-8)
- Agent tool 실패 -> 에러 내용 없이 generic message (P2-9)
- Judge 모든 에러 -> `null` (P1-6)

### 3. Unsafe `as` Casts on External Data (10 findings)
`JSON.parse`, Vespa response, SDK response, LLM output에 대한 `as` cast:
- P1-1, P1-2, P1-3: production data path에서 shape 미검증
- P2-14, P2-15, P2-37: adapter layer에서 SDK/error 타입 가정

### 4. Regex/Loop Inefficiency in Hot Paths (8 findings)
per-call regex allocation, O(n^2) dedup, recursive permutation:
- P2-3, P2-4: negation filter에서 N*M regex 생성
- P2-31: n! permutation array allocation
- P2-32: sort copy per entity resolution call

---

## Recommended Fix Priority

### Immediate (P1 — data integrity / security)
1. Fix unchecked `as` casts: P1-1, P1-2, P1-3 -> Zod/type guard
2. Fix divergent FX rates: P1-7 -> single SSOT constant
3. Fix silent degradation: P1-8 -> `degradation.reasons` in QueryPlan
4. Fix error swallowing: P1-6 -> stderr logging + error classification
5. Fix dead branch: P1-5 -> diagnostic emission
6. Fix silent diagnostic loss: P1-4 -> catch block diagnostic

### Next Sprint (P2 — quality/correctness)
1. Weight sum invariants: P2-28, P2-29 -> compile-time/test assertions
2. FX rate dedup: P2-2, P2-7 -> import shared constant
3. `as` cast cleanup: P2-14, P2-15, P2-37 -> runtime guards
4. Inverted penalty logic: P2-19 -> Math.min for graduated penalty
5. Regex pre-compilation: P2-3, P2-4 -> module-scope cache
6. Missing test coverage: P2-27 -> extractProperNouns, evaluatePredicate, extractVintageYears, extractKoreanPrices tests

### Backlog (P3 — defense-in-depth)
Module-scope allocation (P3-9, P3-18), `.finite()` additions (P3-14), documentation (P3-2, P3-7, P3-8).

---

## Rounds 21-30: Extended Audit (ETL + Alias + Response + Cross-cutting)

### Additional P1 Findings

| ID | File:Line | Cat | Description | Fix |
|----|-----------|-----|-------------|-----|
| P1-9 | `scripts/etl/generate-critic-proxy.ts:120` | LOW_QUALITY | `JSON.parse(responseText)` used without cast to `unknown` or validation — LLM response accessed as `any` | Cast to `unknown`, validate with Zod |
| P1-10 | `src/domain/alias/service/transliterator.ts:617` | NAIVE | `applyRules` sorts rule keys on every word of every call — ~100-entry array sorted 10x per label | Pre-compute sorted key arrays as static class fields |

### Additional P2 Findings

| ID | File:Line | Cat | Description | Fix |
|----|-----------|-----|-------------|-----|
| P2-39 | `src/domain/alias/service/alias-matcher.ts:299` | LOW_QUALITY | Phonetic skeleton strips only ASCII vowels — Korean aliases pass through unstripped, wasting editDistance calls | Short-circuit when query contains Hangul |
| P2-40 | `src/domain/response/service/response-builder.ts:397` | LOW_QUALITY | `as ReadonlyArray<...>` without runtime validation on constraint attributes | Add inline `typeof c.attribute !== 'string'` guard |
| P2-41 | `scripts/etl/vivino-to-silver.ts:33-52` | HEURISTIC | `FX_TO_USD['KRW'] = 0.00075` (1333 KRW/USD) diverges from shared constant 1350 — 1.2% error | Derive from `1 / KRW_PER_USD_APPROXIMATE` |
| P2-42 | `scripts/etl/load-eval-cases.ts:179` | LOW_QUALITY | `JSON.parse(line)` cast as `GoldenQuery` without validation | Parse to `unknown`, validate |
| P2-43 | `scripts/etl/etl-utils.ts:86` | LOW_QUALITY | `JSON.parse(existing) as { pid, ts }` on lock file content — corrupt file causes type confusion | Validate shape before use |

### Additional P3 Findings

| ID | File:Line | Cat | Description | Fix |
|----|-----------|-----|-------------|-----|
| P3-20 | `src/domain/alias/service/alias-matcher.ts:63` | NAIVE | `new Array<number>(n+1)` creates holey arrays; V8 de-optimizes | Use `Uint32Array` for Levenshtein rows |
| P3-21 | `src/domain/response/service/result-grouper.ts:99` | NAIVE | `new Set(producers)` to check identity — `every()` suffices | Replace with `producers.every(p => p === producers[0])` |
| P3-22 | `src/domain/decision/service/decision-engine.ts:350` | NAIVE | `computeDynamicGapThreshold` called twice with identical args | Reuse result from first call |
| P3-23 | `src/domain/decision/service/decision-engine.ts:714` | HEURISTIC | All-zeros `signalSet` indistinguishable from "no signals computed" | Use `null` sentinel when ranking signals unavailable |
| P3-24 | `scripts/etl/run-track-c.ts:53` | LOW_QUALITY | `JSON.parse(line) as Record<string, unknown>` skips object check | Add `typeof parsed === 'object' && parsed !== null` guard |

---

## Cross-Cutting Findings (Rounds 26-30)

### SSOT Violations

| ID | Files | Severity | Description | Fix |
|----|-------|----------|-------------|-----|
| SSOT-1 | `wine-ontology.ts:314`, `claim-extractor.ts:268` vs `shared/constants.ts:36` | P2 | `KRW_PER_MAN_WON` redefined locally in 2 eval files (10000 vs SSOT) | Import from `@domain/shared/constants.js` |
| SSOT-2 | `wine-ontology.ts:312`, `claim-extractor.ts:269` vs `shared/constants.ts:31` | P2 | `USD_TO_KRW = 1350` duplicated — already found as P2-2/P2-7, confirmed as 3-way duplication | Same fix |
| SSOT-3 | `constraint-extraction-evaluator.ts` vs `constraint-metrics.ts` | **P1** | **Duplicate `scoreSemanticConstraintRecall` / `scoreEntityLinkingAccuracy` implementations** with identical semantics but different signatures. Runner uses `constraint-metrics.ts`; evaluator is orphaned. Any fix to one doesn't propagate. | Delete duplicate functions from `constraint-extraction-evaluator.ts` |

### Contract Mismatches

| ID | Files | Severity | Description | Fix |
|----|-------|----------|-------------|-----|
| CTR-1 | `agent-step.ts:39` vs `scorer.ts:48-61` | P3 | `StepTrace` omits `actionPairs` field — parallel steps using the non-deprecated path lose data in the mapping | Add `actionPairs` to `StepTrace` |

### Dead Code

| ID | File | Severity | Description | Fix |
|----|------|----------|-------------|-----|
| DEAD-1 | `constraint-extraction-evaluator.ts` (entire module) | P2 | Only consumed by its own test; superseded by `constraint-metrics.ts`. Maintenance burden. | Delete or merge `ExtractionResult` interface into `constraint-extraction-eval.ts` |
| DEAD-2 | `wine-ontology.ts:185` `regionsRelated()` | P3 | Zero production consumers; only used in its own test | Remove or mark test-only |
| DEAD-3 | `constraint-metrics.ts` `scoreUDCG`, `scoreUDCGPair`, `computeJudgeSCRCorrelation`, `scoreBrierCalibration` | P3 | Exported but consumed only in tests — not wired into runner/scorer pipeline | Wire into runner or document as reserved |

---

## Updated Totals (30 Rounds)

| Severity | R1-R20 | R21-R30 | Total |
|----------|--------|---------|-------|
| P0       | 0      | 0       | **0** |
| P1       | 8      | 3       | **11** |
| P2       | 30     | 7       | **37** |
| P3       | 19     | 7       | **26** |
| **Total** | **57** | **17** | **74** (deduplicated from 75+19 raw) |

### New Systemic Pattern: Orphaned Implementations

R26-R30 found a new pattern: **functions implemented + tested but never wired into the production/benchmark pipeline**. This applies to:
- P4 CSR, P6 UDCG, P7 Judge-SCR, P8 Brier in `constraint-metrics.ts` (DEAD-3)
- Entire `constraint-extraction-evaluator.ts` module (DEAD-1)
- `regionsRelated()` in wine-ontology (DEAD-2)

These represent ~400 LOC of dead code that creates maintenance burden and confusion about what's actually measured during benchmark runs.

---

## Rounds 31-34: Deep Mechanical Scan + Fixes

### Fixed in this round

| ID | File:Line | Category | Fix Applied |
|----|-----------|----------|-------------|
| M-1 | `resolver.ts:486-489` | LOW_QUALITY | `Number()` on vintage attribute → added `Number.isFinite` guard; NaN no longer silently breaks matching |
| M-2 | `watchlist.schema.ts:243` | LOW_QUALITY | `new Date(value).getTime()` → added `Number.isFinite` guard; invalid dates no longer bypass Zod validation |
| M-3 | `agent-orchestrator.ts:1088` | LOW_QUALITY | `results[0]` → `results.at(0)` safe indexing with `noUncheckedIndexedAccess` |
| M-4 | `redis-cache.ts:37` | LOW_QUALITY | `get<T>` with unvalidated `as T` → added `@deprecated` JSDoc directing to `getValidated` |
| M-5 | `generate-region-parents.ts:136` | LOW_QUALITY | `JSON.parse(chainKey) as string[]` → `unknown` + `Array.isArray` guard |
| M-6 | `etl-utils.ts:174` | LOW_QUALITY | `JSON.parse(raw) as string[]` → `unknown` + shape validation with string filter |
| M-7 | `signal-computer.ts:143-149` | NAIVE | `anchorRank <= 0` guard added; rank 0 no longer silently produces 1.0 similarity |
| M-8 | `constraint-compiler.ts:51` | LOW_QUALITY | `console.error` → `bootstrapLogger.warn` with structured error |
| M-9 | `agent-tools.ts:465` | LOW_QUALITY | `console.error` → `bootstrapLogger.warn` with structured error + tool name |

### Verified Clean (no bugs found)

| Pattern | Result |
|---------|--------|
| `\b` on non-ASCII regex | All Korean patterns use `/u` + Unicode boundaries |
| `Math.max/min` with spread | None found in src/ |
| `toLocaleString` in machine output | None found in src/ |
| `console.log` in production | None found in src/ |
| Floating promises without `.catch()` | None found in src/ |
| Orphaned imports in recently modified files | All imports used |
| Duplicate semantic constants across src/ | None remaining after SSOT fix |
| `for...of` with premature `break` | All breaks are legitimate find-first patterns |
| Post-hoc budget check in orchestrator | Pre-flight check exists at line 441; post-hoc is intentional defense-in-depth |
| evidence-mapper NaN propagation | Already guarded by `Number.isFinite` at line 170 |

---

## Final Totals (34 Rounds)

| Severity | Found | Fixed | Remaining |
|----------|-------|-------|-----------|
| P0       | 0     | 0     | 0 |
| P1       | 11    | 11    | 0 |
| P2       | 37    | 22    | 15 (design decisions needed) |
| P3       | 26    | 15    | 11 (defense-in-depth/docs) |
| **Total** | **74** | **48** | **26** |

### Remaining P2 (require design decisions, not mechanical)

- P2-1: Claim verifier 12 thresholds need calibration data
- P2-8: LLM JSON parse → raw text answer (needs fallback strategy design)
- P2-13: bulkFeed unbounded concurrency (needs p-limit dependency decision)
- P2-17: Fragile model-family regex (needs model naming convention)
- P2-19: Inverted Math.max penalty (needs scorer redesign review)
- P2-24: isTransient substring '400' (needs HTTP status code refactor)
- P2-25: Greedy slot matching vs Hungarian (perf tradeoff)
- P2-26: CSR number extraction not attribute-aware (fundamental limitation)
- P2-28/29: Weight sum invariants (needs calibration session)
- P2-33: First-country break (needs multi-value constraint design)
- P2-34/38: Resolver weights/threshold (needs learned model tuning)
- P2-35: Stale LTR model gate (needs ops policy decision)
- P2-36: Comparison markers (needs Korean linguist review)

---

*Generated by 34-round parallel audit (8 agents total) on 2026-04-09.*
