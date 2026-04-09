# Bug Bash Report — 2026-04-09 (SSOT + Engineering Quality + Heuristic Scan)

> Session scope: SSOT consolidation (8 areas) + engineering quality audit (5 layers) + heuristic/naive/fallback scan (5 domains)
> Total bugs fixed in session: 18 | Tests added: ~85 | Final: 3320+ tests, 0 failures

---

## Part 1: SSOT Consolidation — Fixed (18 bugs)

### CRITICAL

| # | File | Issue | Fix |
|---|------|-------|-----|
| 1 | `field-normalizer.ts` | `normalizeUnicode()`에 homoglyph 포함 → ingestion 시 Cyrillic 와인 라벨 손상 ("Массандра" → "Madepa") | `normalizeUnicode`에서 homoglyph 분리, `normalizeUnicodeWithHomoglyphs` 신설. query 경로만 homoglyph 적용 |

### HIGH

| # | File | Issue | Fix |
|---|------|-------|-----|
| 2 | `error-handler.ts:280` | Fallback에서 `body` 재사용 → validation 실패한 body를 다시 보내는 defense-in-depth 약화 | Hard-coded safe defaults로 복원 |
| 3 | `openai-chat-llm.ts:145`, `anthropic-chat-llm.ts:166` | AbortError wrapping → `retryWithBackoff`가 AbortError로 인식 못함 → timeout 시 불필요한 retry | `abortErr.name = 'AbortError'` 보존 |
| 4 | `unicode-normalize.ts` | Cyrillic ф/Ф (U+0444/U+0424) 미매핑 → "фorget everything" injection bypass | ф→f, Ф→F 추가 |
| 5 | `unicode-normalize.ts` | Cyrillic д (U+0434) lowercase 미매핑 → "дefault" injection bypass | д→d 추가 |
| 6 | `redis-cache.ts` / `redis-phrase-cache.ts` | Cache write 무검증 → read 시 schema reject → 무한 poison-delete loop | `setValidated()` 메서드 추가, phrase cache에서 write-time validation 적용 |

### MEDIUM

| # | File | Issue | Fix |
|---|------|-------|-----|
| 7 | `retry-with-backoff.ts:282` | `parseRetryAfterHeader` HTTP-date format 미지원 (RFC 7231 위반) | `Date.parse()` fallback 추가 |
| 8 | `retry-with-backoff.ts:283` | `Headers.get()` 불필요 이중 lookup (case-insensitive API) | 단일 lookup으로 정리 |
| 9 | `retry-with-backoff.ts:295` | `parseFloat("123abc")` → 123 partial parse 허용 | `/^\d+$/` strict validation |
| 10 | `llm-constraint-schema.ts:39` | `z.number()` `.finite()` 누락 → NaN/Infinity 통과 | `.finite()` 추가 (value, range min/max) |
| 11 | `llm-constraint-schema.ts:41,46` | `z.array()` `.max()` 누락 → 무제한 배열 허용 | `.max(50)`, `.max(30)` 추가 |
| 12 | `redis-query-cache.ts:35` | `z.array(z.unknown())` 무제한 → DoS 위험 | `.max(500)` 추가 |
| 13 | `wine-type-patterns.ts:28-29` | "sparkling rose" → rose가 이김 (sparkling이 우선이어야 함) | sparkling을 rose 앞으로 이동 |
| 14 | `wine-type-patterns.ts:31` | "dessert wines" 복수형 미매칭 | `dessert wines?`로 수정 |
| 15 | `search-constraint-extractor.ts:516` | `WINE_TYPE_VALUES`에 'rose' (accent 없는) 없음 → "not rose" wine type 미인식 | `WINE_TYPE_ALL_TOKENS` (canonical + aliases) 신설 |
| 16 | `adversarial-guard.ts:41-60` | `deconfuse()`/`containsHomoglyphs()` NFC 미선행 → combining char sequence bypass | `.normalize('NFC')` 추가 |

### LOW

| # | File | Issue | Fix |
|---|------|-------|-----|
| 17 | `unicode-normalize.ts:55` | Dead code: `\u0443\u0301` multi-codepoint entry — char-by-char 순회로 도달 불가 | 제거 |
| 18 | `unicode-normalize.ts:145-150` | `normalizeUnicodeWithHomoglyphs` → `normalizeHomoglyphs` 이중 NFC (성능) | 내부 `replaceHomoglyphs` helper 분리 |

---

## Part 2: SSOT 잔여 중복 — Fixed

| # | File | Issue | Fix |
|---|------|-------|-----|
| 19 | `constraint-sat.ts` | Wine type mutual exclusivity 하드코딩 (6/8 타입만, natural/orange 누락) | `WINE_TYPE_EXCLUSIVITY_GROUPS` SSOT 파생 |
| 20 | `search-constraint-extractor.ts:513` | Style exclusion에 wine type 인라인 regex | `WINE_TYPE_ALL_TOKENS` Set 사용 |

---

## Part 3: Engineering Quality — Identified (not yet fixed)

### 3.1 Search UseCase Layer

| # | File:Line | Severity | Issue |
|---|-----------|----------|-------|
| E1 | `search-usecase-post-route-phase.ts:344` | CRITICAL | 555줄 mega-function, 7 phase, 36 imports. 분할 필요 |
| E2 | `search.usecase.ts:72-101` | CRITICAL | 21개 의존성 주입, 6개 도메인 혼합 god class |
| E3 | `search.usecase.ts:116-117` | HIGH | `AbstainPolicy`/`ConstraintSAT` 직접 생성 — DIP 위반 |
| E4 | `batch-search.usecase.ts:46-67,402-426` | HIGH | 이중 동시성 추상화 (Semaphore + Promise.race timeout), leak 위험 |
| E5 | `search-usecase-decision-input.ts:39-257` | HIGH | Feature envy — RankedResult 내부 12회 직접 접근 |
| E6 | `search-usecase-pre-route-phase.ts:57-100` | MEDIUM | Timeout symbol sentinel 비표준 패턴, error swallow |

### 3.2 Ranking/Scoring Layer

| # | File:Line | Severity | Issue |
|---|-----------|----------|-------|
| E7 | `ranker.ts:530` | CRITICAL | Float `!== 0` 비교 → 정렬 비결정성 (epsilon comparison 필요) |
| E8 | `evidence-mapper.ts:163` | HIGH | Float `=== 0` 필터 → 감사 추적 오류 |
| E9 | `ranker.ts:754-766` | HIGH | Rerank 정규화 epsilon (1e-8) 너무 타이트 |
| E10 | `evidence-mapper.ts:138-145` | HIGH | Uncertainty penalty 0일 때 증거 누락 |
| E11 | `ranker.ts:521,803` | MEDIUM | Rerank tie-break 의미론 미정의 |
| E12 | `scoring-weights.ts` | MEDIUM | OCP 위반 — 새 signal 추가 시 6곳 수정 필요 |

### 3.3 Query/Planner Layer

| # | File:Line | Severity | Issue |
|---|-----------|----------|-------|
| E13 | `planner.ts:148-281` | CRITICAL | `plan()` 134줄 god function, 10+ 책임 |
| E14 | `planner.ts:518-520` | CRITICAL | `parseConstraints()` LLM 실패 시 try/catch 없음 → 전체 크래시 |
| E15 | `rule-based-constraint-extractor.ts:41-81` | HIGH | O(Q x P) pattern scanning — 40+ regex x query length |
| E16 | `planner.ts:322-395` | MEDIUM | Mode routing if-else 체인 — strategy 패턴 부재 |
| E17 | `query-normalizer.ts:202-257` | MEDIUM | Normalizer가 normalization + classification 혼합 |

### 3.4 Infrastructure Layer

| # | File:Line | Severity | Issue |
|---|-----------|----------|-------|
| E18 | `anthropic-llm-injection-classifier.ts:134` | CRITICAL | Raw SDK error 도메인 계층 누출 (보안) |
| E19 | `vespa-client.ts:18-19` | HIGH | Vespa document timeout 하드코딩, env 미설정 |
| E20 | `redis-client.ts:69-74` | MEDIUM-HIGH | Redis reconnection race condition |
| E21 | `search-index.port.ts:143` | MEDIUM | ISP 위반 — read+write 혼합 포트 |
| E22 | `vespa-search-index.ts` + `candidate-pool.ts` | MEDIUM | Vespa 에러 타입 미분류 → degradation 정책 조악 |

### 3.5 DI/Composition Layer

| # | File:Line | Severity | Issue |
|---|-----------|----------|-------|
| E23 | `container-usecases.ts:47-74` | CRITICAL | `DecomposedSearchAdapter` mutable delegate → runtime NPE 위험 |
| E24 | `container-runtime-support.ts:39-69` | HIGH | `InMemoryJudgmentCache` 싱글톤 stale 판정 누적 (24h+) |
| E25 | `env.ts:46-455` | HIGH | 503줄 god file, 70+ env vars 단일 스키마 |
| E26 | `env.ts:484-503`, `container.ts:67-135` | MEDIUM | Async init race condition (alias table load 실패 시) |
| E27 | Container interfaces | MEDIUM | Singleton vs transient 구분 없는 인터페이스 |

---

## Part 4: Heuristic / Naive / Fallback — Identified (not yet fixed)

### 4.1 Retrieval/Candidate Pool

| # | File:Line | Severity | Type | Issue | SOTA++ |
|---|-----------|----------|------|-------|--------|
| H1 | `fusion.ts:12` | HIGH | Heuristic | RRF k=60 corpus-specific 미튜닝 | Sweep k in [10,30,60,120], select by NDCG@10 |
| H2 | `candidate-pool.ts:128-252` | HIGH | Silent fallback | Sparse/Dense/Anchor 실패 시 silent degrade, metric/circuit breaker 없음 | `DegradationSignal` emit + circuit breaker |
| H3 | `cascade-router.ts:73-78` | HIGH | Heuristic | Cascade routing threshold (0.9, 0.8) 미보정 | Empirical calibration on confidence distributions |
| H4 | `candidate-pool.ts:497` | MEDIUM | Naive | `.includes()` O(n^2) dedup loop | Set으로 교체 |
| H5 | `candidate-assembly.ts:163` | MEDIUM | Naive | `.includes()` O(n) quota check in loop | Set으로 교체 |
| H6 | `hybrid-candidate-summary.ts:125` | MEDIUM | Naive | Linear scan for hit summaries (repeated 400+ times) | Pre-build `Map<entityId, summary>` |
| H7 | `retrieval-profile.ts:58-180` | MEDIUM | Heuristic | TopN limits (100,150 등) 미정당화 magic numbers | Measure rank distribution of relevant docs |
| H8 | `candidate-pool.ts:33,35,37` | MEDIUM | Heuristic | Anchor confidence default(0.5), expansion max(32), weight step(0.25) | Instrument and calibrate |
| H9 | `relative-filter-policy.ts:85-103` | MEDIUM | Heuristic | Single-attribute OR matching (loose) | Embedding-based filtering or require 2+ attributes |
| H10 | `candidate-assembly.ts:146-189` | MEDIUM | Heuristic | Producer diversity string heuristic, not entity dedup | Use producer canonical IDs |
| H11 | `relative-filter-policy.ts:132-140` | MEDIUM | Silent fallback | Anchor not found → return unfiltered (silent) | Emit metric, optionally fail |
| H12 | `semantic-embedding-combiner.ts:22-26` | MEDIUM | Silent fallback | Zero norm → return first embedding (silent) | Emit metric, investigate root cause |
| H13 | `candidate-constraint-evidence.ts:236-284` | LOW-MEDIUM | Naive | Constraint evaluation repeated per candidate (no bitmap) | Pre-compute constraint satisfaction bitmap |
| H14 | `evidence-accumulator.ts:250` + `candidate-assembly.ts:201` | LOW | Naive | Double sort (O(n log n) x 2) | Sort once after final assembly |

### 4.2 Ranking/Scoring

| # | File:Line | Severity | Type | Issue | SOTA++ |
|---|-----------|----------|------|-------|--------|
| H15 | `signal-computer.ts:513` | CRITICAL | Dead feature | `preferenceAlignment` 항상 0.5, 가중치만 존재 — 전체 personalization 차단 | 실제 user preference 모델 구현 or 가중치 0으로 |
| H16 | `scoring-weights.ts:76-91` | HIGH | Heuristic | Default weights 14개 전부 하드코딩, empirical calibration 없음 | LambdaMART 활성화 (이미 구현됨) |
| H17 | `scoring-weights.ts:101-187` | MEDIUM | Heuristic | Query-class weight overrides 72+ params 수동 튜닝 | Per-class LambdaMART models |
| H18 | `mode-weights.ts:71-211` | MEDIUM | Heuristic | 10 retrieval modes x 10 weights = 100+ params 하드코딩 | Mode를 LTR feature로 학습 |
| H19 | `score-aggregator.ts:32-77` | MEDIUM | Naive | Linear aggregation, non-linear interaction 미반영 | LambdaMART gradient boosting |
| H20 | `signal-computer.ts:260-276` | MEDIUM | Heuristic | Semantic score sigmoid (k=10, midpoint=0.05) ad-hoc | Calibrate on eval data |
| H21 | `signal-computer.ts:408,333` | MEDIUM | Inconsistent | Missing data 처리 비일관 (prestige=0.5, popularity=0.3, recency=0.0) | Standardize or explicit missing-data feature |
| H22 | `signal-computer.ts:725-728` | MEDIUM | Naive | `clamp01()` 18곳 남용 → 신호 이슈 은폐 | 최종 출력에서만 clamp |
| H23 | `score-aggregator.ts:39-41` | MEDIUM | Heuristic | Entity integrity binary gate (threshold 0.3) → 정보 손실 | Soft gate (logistic) or LTR feature |
| H24 | `signal-computer.ts:537-575` | MEDIUM | Unused | Diversity penalty 계산되지만 primary ranking에서 미사용 | Primary ranking에 통합 |
| H25 | Signal layer | MEDIUM | Missing | User engagement (clicks, purchases, dwell) signal 부재 | HybridCandidate에 engagement data threading |
| H26 | Signal layer | MEDIUM | Missing | Price sensitivity / budget constraint signal 부재 | price_match signal 추가 |
| H27 | `lambdamart-ranker.ts:135-139` | LOW | Heuristic | Learning rate (0.01), regularization (0.001) 하드코딩 | Learning rate schedule + cross-validation |

### 4.3 Query/Planner

| # | File:Line | Severity | Type | Issue | SOTA++ |
|---|-----------|----------|------|-------|--------|
| H28 | `planner.ts:562-579` | CRITICAL | Silent fallback | Tier 1 LLM 실패 → regex fallback → negation 무시 → 의도 반전 ("not oaky" → "oaky") | Tier-aware confidence + early exit signal |
| H29 | `planner-intent-detection.ts:15-50` | HIGH | Heuristic | Regex intent detection — paraphrasing 실패, 고정 threshold (0.5, 0.85) | Fine-tuned intent classifier (DistilBERT) |
| H30 | `search-constraint-extractor.ts:86-111` | HIGH | Silent fallback | Price extraction NaN → silent empty bundle | Emit `unmapped_price_phrase` signal |
| H31 | `rule-based-constraint-extractor.ts:55-68` | MEDIUM-HIGH | Heuristic | Country matching 정적 regex (13개), fuzzy/alias 없음 | Entity linking + knowledge graph |
| H32 | `planner.ts:328-439` | MEDIUM | Heuristic | Hardcoded routing if/else — learned router 없음 | Learned router (Softmax classifier on query logs) |
| H33 | `korean-wine-aliases.ts` vs English | MEDIUM | Asymmetric | Korean typo correction 있음, English 없음 — NLU 품질 비대칭 | Unified multilingual model (XLM-RoBERTa) |
| H34 | `pairing-extractor.ts:157-165` | LOW | Heuristic | Pairing 모든 태그 confidence 동일 (0.88) — mention proximity 미반영 | Ranked pairing with proximity scoring |

### 4.4 Entity Resolution

| # | File:Line | Severity | Type | Issue | SOTA++ |
|---|-----------|----------|------|-------|--------|
| H35 | `entity-resolver.ts:210-221` | CRITICAL | Naive | Exact match only — FuzzyMatcher 존재하지만 미사용 | Entity resolver에 FuzzyMatcher fallback 통합 |
| H36 | `wine-ontology.ts:33-152` | CRITICAL | Incomplete | ~145 region, ~47 grape — 주요 산지 50+ 누락 | Wine index에서 추출, semi-auto 온톨로지 확장 |
| H37 | `entity-resolver.ts:38-48` | HIGH | Heuristic | Confidence 값 (0.88-0.95) 전부 미보정 guess | Labeled dataset 수집 → logistic regression fit |
| H38 | `entity-resolver.ts:213` + `span-parser.ts:98` | MEDIUM | Silent fallback | OOV entity → 0 constraints, silent drop, metric 없음 | Unresolved span 로깅 + `unmapped_phrase_rate` metric |
| H39 | `llm-nl-mapper.ts:322` | MEDIUM | Security | LLM phrase injection 위험 — phrases `JSON.stringify` sanitization 미흡 | Phrase validation regex + prompt hardening |

### 4.5 Decision/Response

| # | File:Line | Severity | Type | Issue | SOTA++ |
|---|-----------|----------|------|-------|--------|
| H40 | `drinking-window-predictor.ts:219-292` | CRITICAL | Heuristic | Drinking window 100% heuristic (ONNX 미가용 시), 미검증 | Expert corpora 대비 검증, uncertainty quantification |
| H41 | `decision-engine.ts:38-67,390-422` | HIGH | Heuristic | Abstain threshold 하드코딩 (0.75 resolve, 0.45 refusal, 0.90 noisy-query) | User satisfaction 학습, query-class별 dynamic threshold |
| H42 | `confidence-refusal.ts:29` | HIGH | Unvalidated | "AURC-calibrated" claim 있지만 ROC 분석 미제공 | ROC/ECE plots, per-result confidence intervals |
| H43 | `human-response-builder-v2.ts:50-85` | MEDIUM | Template | 설명 생성 heuristic 템플릿 — evidence 품질 미반영 | Decision trace 기반 생성, feature importance 랭킹 |
| H44 | `evidence-gate.ts:68-121` | MEDIUM | Heuristic | Binary evidence gate (pass/fail) — graduated levels 없음 | Evidence-confidence interaction, graduated levels |
| H45 | `decision-engine.ts:532-578` | MEDIUM | Heuristic | Noisy short-query guard (C >= 0.9) — per-class tuning 없음 | Progressive disclosure ("Did you mean...?") |

---

## Part 5: Structural Issue — Silent Fallback (systemic)

전체 시스템에 걸쳐 silent degradation 패턴이 만연:

| Component | Failure Mode | Current Behavior | Impact |
|-----------|-------------|-----------------|--------|
| Sparse search | Vespa timeout/error | Empty results, log warn, continue | Operator 무감지 |
| Dense embedding | Embedding service failure | Degrade, log warn, continue | Null ratio 미추적 |
| Anchor embedding | Service failure | Skip anchor channel entirely | "wines like X" → generic results |
| Entity resolution | OOV span | Drop constraint, no log | Missing constraints → bad ranking |
| LLM constraint mapper | Timeout/schema fail | Fall to regex (may invert intent) | Negation 무시 |
| Drinking window | ONNX model unavailable | Heuristic rules (unvalidated) | 잘못된 음용 시기 |
| Relative filter | Anchor not found | Return unfiltered | User intent 무시 |
| Embedding combiner | Zero norm | Return first embedding | Degenerate quality |

### Proposed structural fix

`DegradationSignal` type + `DegradationCollector` at domain level:

```typescript
interface DegradationSignal {
  readonly component: 'sparse' | 'dense' | 'anchor' | 'entity' | 'llm_mapper' | 'drinking_window' | 'relative_filter' | 'embedding_combiner';
  readonly severity: 'warning' | 'error';
  readonly reason: string;
  readonly fallbackApplied: string;
  readonly timestamp: number;
}
```

Surface via:
1. Per-request response field: `degradation_signals[]`
2. `/metrics/degradation` endpoint for operator dashboards
3. Alert thresholds for automated notification

---

## Part 6: Key Insight — Unused Infrastructure

이미 구현되어 있지만 활성화되지 않은 인프라:

| Component | Status | Impact if Activated |
|-----------|--------|-------------------|
| **LambdaMART** | 코드 존재, 학습 파이프라인 존재, 미활성 | Ranking heuristic weight 200+ params 자동 학습 |
| **FuzzyMatcher** | Planner에서 anchor fallback으로 사용 중 | Entity resolver에 통합 시 +15-25% resolution coverage |
| **Diversity penalty** | `computeSetDiversity()` 구현 완료 | Primary ranking에 통합 시 결과 다양성 개선 |

---

## Part 7: SSOT Consolidation Summary (completed)

8개 영역 통합 완료:

| Area | Before | After |
|------|--------|-------|
| Homoglyph maps | 3파일 분산 (47+32+28 entries) | `unicode-normalize.ts` 단일 SSOT (80 entries) |
| Retry/backoff | OpenAI + Anthropic 각 ~100줄 중복 | `retry-with-backoff.ts` 공유 유틸리티 |
| Redis cache validation | 3개 cache 각각 poisoning 로직 | `RedisCache.getValidatedWithStats()` SSOT |
| Error envelope | 3곳 인라인 RFC-014 구성 | `buildSearchErrorResponse()` SSOT |
| Field normalizer | 인라인 NFC + whitespace | `normalizeUnicode()` SSOT (homoglyph 미포함) |
| Wine type patterns | 2파일 인라인 regex | `wine-type-patterns.ts` SSOT (8타입) |
| Wine type exclusivity | `constraint-sat.ts` 하드코딩 | `WINE_TYPE_EXCLUSIVITY_GROUPS` SSOT 파생 |
| Wine type membership | `search-constraint-extractor.ts` 인라인 | `WINE_TYPE_ALL_TOKENS` Set 파생 |

---

## Appendix: Files Changed in Session

### Production code
```
src/domain/shared/utils/unicode-normalize.ts
src/domain/security/service/query-sanitizer.ts
src/domain/alias/service/adversarial-guard.ts
src/domain/ingestion/service/field-normalizer.ts
src/domain/query/model/wine-type-patterns.ts
src/domain/query/service/rule-based-constraint-extractor.ts
src/domain/query/service/planner-intent-detection.ts
src/domain/query/service/search-constraint-extractor.ts
src/domain/query/service/constraint-sat.ts
src/domain/query/service/query-normalizer.ts
src/domain/attribute/model/llm-constraint-schema.ts
src/infrastructure/http/retry-with-backoff.ts (NEW)
src/infrastructure/adapter/redis-cache.ts
src/infrastructure/cache/redis-query-cache.ts
src/infrastructure/cache/redis-embedding-cache.ts
src/infrastructure/cache/redis-phrase-cache.ts
src/infrastructure/ai/openai-chat-llm.ts
src/infrastructure/ai/anthropic-chat-llm.ts
src/interface/http/middleware/error-handler.ts
src/interface/http/routes/feedback.route.ts
src/interface/http/routes/replay.route.ts
```

### New test files
```
src/infrastructure/http/__tests__/retry-with-backoff.test.ts (25 tests)
src/domain/attribute/model/__tests__/llm-constraint-schema.test.ts (20 tests)
src/domain/query/model/__tests__/wine-type-patterns.test.ts (28 tests)
```

### Modified test files
```
test/unit/shared/unicode-normalize.test.ts (+5 tests)
src/domain/security/__tests__/query-sanitizer.test.ts (+4 tests)
src/domain/ingestion/__tests__/field-normalizer.test.ts (+2 tests)
```

---

## Part 8: Investigation Results — Unused Infrastructure Activation Path

### 8.1 LambdaMART Activation

**Status**: 코드/인프라/DI 전부 완성. DB에 학습 모델 없음 (`ltr_model_registry` empty).

**Architecture (already wired)**:
- Training: `lambdamart-ranker.ts` → `ltr-training-service.ts` → `pg-ltr-model-registry.ts`
- Inference: `container-runtime-support.ts` (model loading) → `ranker.ts:555-698` (gated execution)
- Features: `ltr-feature-extractor.ts` (8 features, shared between train & inference)
- Gate: `rerank-gate.ts` (candidateCount >= 5, qualifying queryClass/route)

**Blocker**: `ltr_model_registry` 테이블 비어있음. `gold_set_cases` evaluation 데이터도 필요.

**Activation steps**:
1. `gold_set_cases` 테이블에 평가 케이스 삽입 (query, queryClass, expected_status)
2. `npx tsx scripts/eval/run-eval-and-train-ltr.ts` 실행
3. 앱 재시작 → container boot에서 모델 자동 로딩
4. Gate 통과하는 쿼리에서 LambdaMART 자동 적용

**Impact**: Ranking heuristic weight 200+ params 자동 학습, 수동 튜닝 제거.

### 8.2 FuzzyMatcher → Entity Resolver 통합

**Status**: `FuzzyMatcher` 클래스 production-ready (BK-tree + Soundex EN/KO). Planner anchor fallback에서 사용 중. Entity resolver는 exact match only.

**Architecture**:
- `FuzzyMatcher` in `src/domain/query/service/fuzzy-matcher.ts`
- Port: `FuzzyMatcherPort` in `src/domain/query/port/fuzzy-matcher.port.ts`
- 초기화: `container-core-builders.ts:58-112` (PG `aliases` 테이블에서 surface_form 100K개 로딩)
- Entity resolver: `entity-resolver.ts:210-221` (exact match → compact match → null)

**Integration path (Strategy B — direct construct)**:
1. `resolveEntity()`에 optional `fuzzyMatcher?: FuzzyMatcherPort` 파라미터 추가
2. Exact match 실패 시 → `fuzzyMatcher.match(spanText, maxEditDistance=2)`
3. Best result를 `RESOLVER_INDEX`에서 재검색 (fuzzy term → canonical entity)
4. `provenance: 'fuzzy_fallback'` 추가, confidence = `combinedScore * 0.9` (exact보다 10% 낮게)

**Type compatibility**: `FuzzyMatchResult.combinedScore` (0-1) → `ResolvedEntity.confidence` (0-1) 완전 호환.

**Impact**: +15-25% entity resolution coverage (typo, 발음 변형 처리).

### 8.3 Silent Fallback 구조적 해결

**기존 인프라**:
- 3개 메트릭 컬렉터 존재: `AgentExecutionMetricsCollector`, `CacheMetricsCollector`, `QueryEntrySecurityMetricsCollector`
- Circuit breaker: `CacheMetricsCollector`에만 구현됨
- Degradation flag: `EngineDecision.executionMode` (`authoritative`/`degraded`/`heuristic`), `degradationReasons[]` 배열
- Response 표면: `meta.degradation_reasons` 이미 존재
- `skippedPhases` 배열: retrieval trace에 이미 있음 (sparse/dense)

**누락된 것**:
- Sparse/Dense/Anchor/Entity/LLM 실패 **카운터** (metrics)
- 실패 **비율** (rate) 계산 및 **alert threshold**
- Vespa/Embedding 서비스 **circuit breaker**
- Entity/LLM 실패를 `degradationReasons`에 포함하는 경로

**구현 계획**:
1. `RetrievalDegradationObserver` port 생성 (domain layer)
2. `RetrievalDegradationMetricsCollector` 구현 (infra layer, 기존 패턴 따름)
3. `CandidatePoolService`에 observer 주입, 각 catch block에서 호출
4. `/metrics/degradation` 엔드포인트 노출
5. Alert threshold: sparse/dense degradation rate > 10% → `retrieval_degradation_high`

---

## Part 9: External Reranker Decision — SOTA++ Baseline

### Decision: Cohere Rerank 3.5 (Phase 1) → Fine-tuned (Phase 2) → LambdaMART 내재화 (Phase 3)

### Phase 1: Cohere Rerank 3.5 Base (즉시)

**선정 이유**:
- MTEB reranking leaderboard 1-2위, MIRACL-ko (한국어) 최상위
- 한국어 first-class 지원 (EN+KO 동시 필수 요건 충족)
- $2.00/1K queries — wine search 규모에서 합리적
- Node.js SDK (`cohere-ai`) 즉시 통합 가능
- latency ~200-400ms (50 candidates) — interactive search 허용 범위

**Integration architecture**:
```
User Query → Planner → Vespa (BM25 + dense hybrid, top 50)
          → Cohere Rerank 3.5 (50 → top 20, ~300ms)
          → Ranking (signal compute + LTR blend)
          → Decision Engine → Response
```

**경쟁 모델 대비**:

| Criterion | Cohere 3.5 | Jina v2 | BGE v2-m3 | mxbai v2 | Voyage 2 |
|-----------|-----------|---------|-----------|----------|----------|
| Korean quality | A+ | A- | A | C+ | B- |
| English quality | A+ | A | A | A | A |
| Latency (50 docs) | ~300ms | ~200ms | ~300ms | ~200ms | ~400ms |
| Self-hostable | No | Yes | Yes | Yes | No |
| Cost/1K queries | $2.00 | ~$0.02 | Free | Free | ~$0.15 |
| Wine domain | A | B+ | B | B+ | B |
| MTEB rerank avg | ~62 | ~57 | ~58 | ~60 | ~58 |

**탈락 사유**:
- MiniLM: 영어 전용, 2021년 모델, 품질 미달
- mxbai: 한국어 미흡
- Voyage: Anthropic 인수 후 로드맵 불확실, 한국어 비주력
- RankGPT/LLM: latency 1-5초, 비용 5-10x — offline eval용으로만

**Runner-up**: Jina Reranker v2 — self-hosting 필요하거나 비용 극소화 시

### Phase 2: Cohere Fine-tuned (search log 축적 후, ~4-8주)

**데이터 수집**: 
- User query → clicked wine 로그에서 (query, relevant_doc, irrelevant_doc) triplet 생성
- LLM-judged relevance로 보강 (RankGPT 스타일 offline evaluation)
- 목표: 2K-5K training examples (food pairing, tasting note, region, vintage, 한국어 포함)

**기대 효과**: Base 대비 NDCG@10 +3-8% (wine domain specialization)

### Phase 3: LambdaMART 내재화 (Phase 2 완료 후)

**전략**: Cohere reranker score를 LambdaMART feature로 포함
- 기존 8 features + `cohereRerankScore` = 9 features
- Cohere가 제공하는 cross-encoder score를 signal로 활용
- LambdaMART가 Cohere score + internal signals 최적 조합 학습
- 장기적으로 self-hosted reranker (Jina v2 / BGE v2-m3 ONNX)로 Cohere 의존성 제거 가능

**Activation path** (기존 인프라 활용):
1. `gold_set_cases` 테이블에 평가 데이터 축적
2. `scripts/eval/run-eval-and-train-ltr.ts` 실행 → `ltr_model_registry` 모델 저장
3. Ranker가 boot 시 자동 로딩 → rerank gate 통과 시 LambdaMART 적용

### Hybrid Option (latency 여유 시)

```
Vespa (top 100) → Jina v2 local ONNX (100→30, ~150ms) → Cohere 3.5 (30→15, ~150ms)
```
Total rerank latency ~300ms, Jina로 1차 필터 (비용 절감) + Cohere로 최종 정밀 랭킹.

### 비용 추정

| Daily queries | Cohere only | Jina+Cohere hybrid |
|--------------|-------------|-------------------|
| 1K | $2/day | $0.60/day |
| 10K | $20/day | $6/day |
| 100K | $200/day | $60/day |

Wine search engine 규모에서 Cohere-only도 충분히 합리적.
