# Wine Search Engine — Agentic Request Processing

> 이 문서는 HTTP 요청이 들어온 시점부터 최종 응답이 반환될 때까지의 전 과정을 코드 수준으로 설명합니다.
> 참조 파일의 라인 번호는 2026-04-11 기준 `main` 브랜치 기준입니다.

---

## 목차

1. [진입점 — HTTP 라우팅 & 스키마 검증](#1-진입점)
2. [검색 모드 분기 — Simple vs Agentic](#2-검색-모드-분기)
3. [Planner — 쿼리 의도 분석 (10단계)](#3-planner--쿼리-의도-분석)
4. [Constraint Compiler — 제약 추출 파이프라인](#4-constraint-compiler)
5. [NL Mapper — 한국어·영어 자연어 → 속성 변환](#5-nl-mapper)
6. [Retrieval — 병렬 채널 검색 & RRF 융합](#6-retrieval)
7. [Ranking — Ranker 8-step 스코어링 파이프라인](#7-ranking)
8. [Diversity & Assembly — 다양성 보장 & 후처리](#8-diversity--assembly)
9. [Agentic Loop — LLM 추론·도구 실행 사이클](#9-agentic-loop)
10. [Post-Route — 의사결정·응답 구성](#10-post-route)
11. [최종 응답 스키마](#11-최종-응답-스키마)
12. [데이터 흐름 요약 다이어그램](#12-데이터-흐름-요약)
13. [Graceful Degradation 매트릭스](#13-graceful-degradation-매트릭스)
14. [핵심 수치 상수 참조표](#14-핵심-수치-상수-참조표)

---

## 1. 진입점

**파일:** `src/interface/http/routes/route-contracts.ts`

### 요청 라우트 종류

| 라우트 | Operation ID | 특징 |
|--------|-------------|------|
| `POST /search` | `search.execute` | 기본 검색. 캐시, 보안, 플래너, SAT 게이트 전부 활성 |
| `POST /search/hybrid` | `search.hybrid` | `forced_hybrid_retrieval` 캐퍼빌리티 추가 |
| `POST /search/interpret` | `search.interpret` | 제약 파싱만, 실제 검색 없음 |
| `POST /v2/search` | `v2.search.execute` | V1 동일 로직 + 사람이 읽기 좋은 응답 형식 |

### 검증 흐름

```
HTTP 요청
  → Fastify preHandler (security hooks)
  → Zod 스키마 검증 (SearchRequestSchema — search-request.schema.ts)
      ├─ query: string (1–MAX_QUERY_LENGTH=500자)    ← QueryStringSchema
      ├─ context?: { locale: string, currency: string }   ← SearchContextSchema
      ├─ options?: { mode: 'auto'|'entity'|'hybrid'|'mixed', explain: boolean, clarification: boolean }
      ├─ retrieval_mode?: 'auto'|'entity'|'hybrid'|'mixed'
      ├─ sessionContext? / session_context?  ← camelCase/snake_case 양쪽 허용 (중복 불가)
      └─ queryBudget? / query_budget?        ← camelCase/snake_case 양쪽 허용 (중복 불가)
  → SearchUseCase.execute() 호출
```

> **주의:** `locale`, `session_id`, `explain`, `budget_override` 같은 최상위 단독 필드는 없습니다.  
> locale은 `context.locale`, explain은 `options.explain`, session은 `sessionContext.sessionId` 안에 있습니다.

스키마 검증 실패 시 400 Bad Request + RFC-014 에러 엔벨로프 반환. 검증 통과 후 `SearchUseCase`로 제어권 이동.

---

## 2. 검색 모드 분기

**파일:** `src/application/search/search.usecase.ts`, `search-usecase-pre-route-phase.ts`, `search-usecase-post-route-phase.ts`

### Pre-Route Phase 실제 순서 (`runSearchPreRoutePhase`)

```
1. 보안 게이트 — securityGate.getSafeQueryOrThrow()
   실패 시 403 즉시 반환

2. 비교 쿼리 분해 시도 (Epic 14, decomposedSearch 있을 때만)
   analyzeQueryDecomposition() → isValidDecomposition()이면
   decomposedSearch.execute() 실행 (타임아웃 15초)
   성공 시 ComparisonSearchResponse 즉시 반환

3. Planner 실행 — queryPlanner.planWithCompiled() 또는 plan()
   → QueryPlanV1 + CompiledWineQuery 생성

4. 에이전트 구조화 필터 머지 (request.filters 있을 때만)
   NL 추출 제약 중 에이전트 필터와 (attribute, operator) 충돌하는 것 제거
   → 에이전트 명시적 필터가 NL 추출을 덮어씀 (AUTHORITATIVE)

5. Constraint SAT 검사 — constraintSAT.check(plan.constraints)
   모순(예: wine_type='red' AND wine_type='white') 감지 시
   → 모순 응답 즉시 반환

6. 캐시 조회 — tryGetCachedSearchResponse()
   HIT 시 캐시된 응답 즉시 반환
```

> **주의:** 캐시 조회는 Planner **이후**에 수행됩니다. Planner가 먼저 실행되고, SAT 검사 통과 후 캐시를 확인합니다.

### Route Dispatch (`dispatchSearchRouteExecution`)

```
effectiveRoute 기준으로 세 경로 중 하나 실행:
  'entity' → executeEntityRoute()   (EntityResolver 직접 조회)
  'hybrid' → executeHybridRoute()   (CandidatePool + Ranker; LambdaMART는 Ranker 내 선택적 Step 6)
  'mixed'  → executeMixedRoute()    (비교 쿼리 → 서브쿼리 분해 후 각각 실행)
```

### Post-Route Phase 실제 순서 (`runSearchPostRoutePhase`)

```
1. cacheRequestContext 빌드 (abstain 여부와 무관하게 미리 준비)

2. snapshot + degradation 계산 (두 경로가 공유)

3. topKFinalScores() → abstainPolicy.shouldAbstain() 판단

4. result limit 적용 (request.limit, 유효하지 않으면 전체 사용)
   clamp: safeLimit = min(1000, floor(raw)); NaN/음수이면 전체

   ┌─ abstain=true (점수 분포 균일, RFC-013 entropy 게이트)
   │    mapRankedResultsToResultItems(limitedResults, drinkingWindow, targetYear, sensoryPriors)
   │    rankedResultsToEvalProvenanceSlices(fullResults)
   │    buildSearchCounterfactuals (includeCounterfactuals===true 일 때만)
   │    responseBuilder.build(buildEntropyAbstainResponseParams(...))
   │
   └─ abstain=false → runRankedRouteDecisionPhase()
        buildSearchDecisionInput()
        decisionEngine.decide()
        mapRankedResultsToResultItems(limitedResults, drinkingWindow, ...)
        rankedResultsToEvalProvenanceSlices(fullResults)   ← fullRankedResults 사용
        buildSearchCounterfactuals(resolveResult, fullResults)
        responseBuilder.build()

5. 구조화 로그 기록 (두 경로 합류 후)

6. cacheService.setSearchResponse()
   → 캐시 내부에서 abstain 여부 등 자격 검사 후 skip 가능
   → 두 경로 모두 시도함 (abstain이어도 캐시 write 시도)
```

> **주의:** 캐시는 abstain 경로도 write를 시도합니다. 단 캐시 서비스 내부(`setSearchResponse`)에서 abstain 응답이 캐싱 자격 미달이면 skip됩니다.

**Agentic 경로** (`/agent` 엔드포인트)는 별도로 `AgentOrchestrator.execute()`를 통해 처리됩니다 (§9 참조).

---

## 3. Planner — 쿼리 의도 분석

**파일:** `src/domain/query/service/planner.ts`  
**진입:** `Planner.plan(query, context?)` → `materializeQueryPlan()`

10단계 파이프라인이 순서대로 실행됩니다.

### Stage 1: 쿼리 정규화

```typescript
typoFixed = correctKoreanWineTypos(safeQuery)  // 예: "쉬라즈" → "시라"
queryViews = queryNormalizer.normalize(typoFixed)
normalizedQuery = queryViews.accentless  // 악센트 제거, 유니코드 정규화
```

`MAX_QUERY_LENGTH`로 길이 상한 적용 (ReDoS 방어).

### Stage 2: 앵커(엔티티) 추출

```
anchors = await anchorExtractor.extract(normalizedQuery, queryViews)
```

- 알려진 생산자·지역·와인명 등을 쿼리에서 식별
- 결과: `AnchorCandidate[]` — 각 후보에 `confidence`, `candidateEntityIds[]` 포함
- 앵커가 없으면 `fuzzyMatcher`로 보완 시도

### Stage 3: 인텐트 감지

**파일:** `src/domain/query/service/planner-intent-detection.ts`

앵커 신뢰도 기준값:
- `EXACT_ANCHOR_CONFIDENCE = 0.85` → "강한 앵커" (`hasStrongAnchor`)
- `ANCHOR_PRESENT_CONFIDENCE = 0.5` → "앵커 존재" (`hasAnyAnchor`)
- 두 기준 사이 (≥0.5, <0.85) → "약한 앵커" (`hasWeakAnchor`)

우선순위 순 결정 로직 (`detectQueryIntent()` lines 91–134):

| 우선순위 | 인텐트 | 조건 |
|---------|--------|------|
| 1 | `comparison_search` | `hasComparisonMarker && hasAnyAnchor` |
| 2 | `comparison_search` | `anchors.length >= 2 && hasComparisonMarker` |
| 3 | `mixed_query` | `hasKoreanMixedQueryMarker && hasAnyAnchor` |
| 4 | `mixed_query` | `hasStrongAnchor && hasConstraintKeyword` |
| 5 | `entity_exact` | `hasStrongAnchor && !hasConstraintKeyword && !hasPriceKeyword` |
| 6 | `entity_fuzzy` | `hasWeakAnchor && !hasConstraintKeyword && !hasPriceKeyword` |
| 7 | `mixed_query` | `hasWeakAnchor && (hasConstraintKeyword || hasPriceKeyword)` |
| 8 | `mixed_query` | `hasAnyAnchor && (hasConstraintKeyword || hasPriceKeyword)` |
| 9 | `pairing_search` | `hasPairingKeyword` |
| 10 | `budget_search` | `hasPriceKeyword` |
| 11 | `facet_search` | `hasConstraintKeyword` |
| 12 | `semantic_discovery` | 기본값 (나머지) |

예시 쿼리 매핑:

| 인텐트 | 예시 쿼리 |
|--------|----------|
| `entity_exact` | "Château Margaux" (강한 앵커, 제약 키워드 없음) |
| `entity_fuzzy` | "마르고" (약한 앵커, 제약 없음) |
| `comparison_search` | "Margaux vs Latour" |
| `mixed_query` | "오푸스원 드라이" (강한 앵커 + 제약 키워드) |
| `facet_search` | "레드 와인 10만원 이하" (앵커 없음, 제약 키워드) |
| `semantic_discovery` | "해산물에 어울리는 와인" |
| `pairing_search` | "연어 요리에 맞는 와인" |
| `budget_search` | "3만원대 레드" (앵커 없음, 가격 키워드) |

### Stage 4: 라우트 결정

| 인텐트 | 앵커 유무 | 라우트 |
|--------|---------|--------|
| `entity_exact` | — | `entity` |
| `entity_fuzzy` | 있음 | `entity` |
| `entity_fuzzy` | 없음 | `hybrid` |
| `comparison_search` | — | `entity` |
| `mixed_query` | — | `mixed` |
| `facet_search`, `semantic_discovery`, `pairing_search`, `budget_search` | — | `hybrid` |

### Stage 5: 리트리벌 모드 결정

9개 분기 (우선순위 순):

| 모드 | 조건 |
|------|------|
| `compare_candidates` | `comparison_search` |
| `producer_browse` | `entity_exact`·`mixed_query` + 고신뢰 앵커 + "best wines" 패턴 |
| `region_browse` | `facet_search`·`semantic_discovery`·`budget_search` + 쿼리에 `/` 2개 이상 |
| `entity_resolution` | `entity_fuzzy` + `hasMultipleCandidates` (앵커 중 하나라도 `candidateEntityIds.length > 1`) |
| `entity_lookup` | `entity_exact` + `hasStrongAnchor` (confidence ≥ 0.85) |
| `similar_items` | `mixed_query` + `hasAnyAnchor` (confidence ≥ 0.5) |
| `recommendation` | `pairing_search` |
| `constraint_filter` | `facet_search`·`budget_search` + 앵커 없음 |
| `attribute_search` | 기본값 (나머지) |

### Stage 6: 쿼리 클래스 분류

| 클래스 | 조건 |
|--------|------|
| `ambiguous_short_form` | ① 쿼리 전체가 모호성 사전에 등록됨, 또는 ② 앵커의 `normalizedForm`이 사전에 등록됨, 또는 ③ 토큰 ≤2 + 앵커 있음 + `totalCandidates > 1` + 앵커 신뢰도 < 0.8 (`SHORT_QUERY_AMBIGUOUS_ANCHOR_CONFIDENCE_THRESHOLD`) |
| `short_entity` | 토큰 ≤2 + 앵커 있음 + ①②③ 해당 없음; 또는 `entity_exact`·`entity_fuzzy` 인텐트 (토큰 >2) |
| `comparison_query` | `comparison_search` |
| `anchored_similarity` | `mixed_query` |
| `pure_constraint` | `facet_search`·`budget_search` |
| `semantic_preference` | `semantic_discovery`·`pairing_search` |
| `unknown` | 기본값 |

### Stage 7: 제약 파싱

→ **§4 Constraint Compiler** 참조

### Stage 8: 쿼리 확장 구성

```
expansions = expansionBuilder.build(normalizedQuery, intent, anchors)
// 렉시컬 확장 + 퍼지 매치 결과 병합
```

### Stage 9: 불확실성 계산

**공식:**
```
overall_uncertainty = clamp(
  1.0
  - 0.30 × parserConfidence       // 쿼리 길이에 따른 파서 신뢰도
  - 0.40 × anchorConfidence        // 앵커 최대 신뢰도
  - 0.30 × constraintConfidence    // 하드 제약 평균 신뢰도
  + (ambiguityDetected ? 0.15 : 0) // 모호성 패널티
, [0, 1])
```

- `parserConfidence = max(0.5, 1.0 − tokenCount × 0.05)`
- 모호성 심각도: `low` → `medium` → `high`
- 의사결정 효과:
  - `high` → `force_clarify`
  - `medium` 또는 `overall ≥ 0.6` → `raise_threshold`
  - 그 외 → `trace_only`

### Stage 10: 대상 엔티티 타입 추론

**우선순위 순서** (`inferTargetEntityType()`, lines 648–700):

| 우선순위 | 타입 | 조건 |
|---------|------|------|
| 1 | `'style'` | (`semantic_discovery`\|`facet_search`) + hard 제약 없음 + soft 제약이 body·sweetness·acidity·tannin·style만 + 앵커 없음 |
| 2 | `'wine'` | 앵커 있음 + 쿼리에 빈티지 연도 (`hasBoundedVintageYear`) |
| 3 | `'region'` | `REGION_KEYWORDS` 패턴 매칭 (앵커 유무 무관) |
| 4 | `'producer'` | 앵커 있음 + 빈티지 없음 + `wine_type` 하드 제약 없음 |
| 5 | `undefined` | 위 조건 모두 미해당 |

> 주의: `region` 체크는 `wine` 체크 이후, `producer` 체크 이전에 수행됨. 앵커 + 빈티지가 있으면 `region` 키워드가 있어도 `'wine'`이 반환됨.

### QueryPlanV2 출력 구조

```typescript
{
  rawQuery, normalizedQuery, normalizedQueryViews,
  intent, suggestedRoute, suggestedRetrievalMode,
  queryClass, anchors, constraints, expansions,
  uncertainty, targetEntityType,
  plannerVersion: '1.0.0',
  policyRuleVersion: '1.0.0',
  admission_context,           // RFC-005 §3.1
  constraintExtraction?,       // 티어별 제약 추출 추적
  retrievalPlan?,
  decompositionHint?,
}
```

---

## 4. Constraint Compiler

**파일:** `src/domain/query/service/constraint-compiler.ts`  
**진입:** `ConstraintCompiler.compile(normalizedQuery, abortSignal?)`

6개 티어로 구성된 제약 추출 파이프라인:

### Tier 1: 규칙 기반 매핑 (NL Mapper)

```
spans = parseSpans(normalizedQuery)          // 명사구·고유명사 추출
candidatePhrases = spans.map(s => s.text)
mapped = await nlMapper.mapConstraints(candidatePhrases)
```

→ **§5 NL Mapper** 참조

**분류 로직 (lines 73–85):**
```typescript
if (isLlmSourced || SOFT_CONSTRAINT_ATTRIBUTES.has(constraint.attribute)) {
  soft.push(constraint)    // 소프트: 패널티만 적용
} else {
  hard.push(constraint)    // 하드: Vespa YQL WHERE 필터
}
```

**하드 제약 속성:** `wine_type`, `country`, `region`, `appellation`, `grape_primary`, `vintage_year`, `price_points`  
**소프트 제약 속성:** `body`, `sweetness`, `acidity`, `tannin`, `style`, `price_band`, `occasion`, `critic_score`, `fruit_intensity`, `finish`, `producer_prestige`, `finish_length`, `drinking_window`, `flavor_profile`, `certification`

### Tier 2: 엔티티 리졸버

Tier 1에서 커버되지 않은 스팬에 대해:
```
preferredEntity = resolveEntity(span.text, { preferEntityOverStyle: true }, fuzzyMatcher)
resolvedNonOverlap = resolveOverlaps(candidates).filter(e => e.resolved !== null)
```

- `entity_resolver(surface)` 또는 `entity_shadow(surface)`로 source_phrase 기록
- Shadow 엔티티는 해당 attribute가 Tier 1에서 미커버된 경우에만 추가

### Tier 6: 정규식 추출기 (항상 실행)

```
tier6Bundle = extractRuleBasedConstraints(normalizedQuery)  // 항상 실행
mergeConstraintBundleIntoLists(tier6Bundle, hard, soft)     // 항상 병합 (dedup)
```

- 빈티지 연도: `/20\d{2}/`
- 가격 패턴: 한국어 원화 단위 포함
- **항상 실행되며 항상 hard/soft에 병합**됩니다. `tier12Empty`는 온톨로지 확장 경로만 분기:
  - `tier12Empty=true` → Tier 6 결과만으로 온톨로지 확장
  - `tier12Empty=false` → Tier 1+2+6 합산본으로 온톨로지 확장
- `fallbackTriggered` 필드는 deprecated — "Tier 1+2 결과가 0개"라는 뜻이지 파이프라인 실패가 아님 (`constraint-extraction-trace.ts` 주석)

### 온톨로지 확장 & 합성 추론

```
expanded = expandWithOntology(bundle)
finalBundle = applyCompositionalInference(expanded, { impliedWineType })
```

- 온톨로지: "Pinot Noir" → 관련 지역 파생
- 합성 추론: 비교 컨텍스트에서 암묵적 wine_type 추론

### 리트리벌 플랜 빌드

```
retrievalPlan = buildRetrievalPlan(finalBundle)
```

ConstraintBundle → Vespa YQL 필터 표현식 변환.

### 추적 정보 (ConstraintExtractionTrace — constraint-extraction-trace.ts)

```typescript
{
  candidatePhraseCount: number,
  candidateSpanCount?: number,
  ruleTableHitCount: number,
  llmHitCount: number,
  llmSkippedCount: number,
  /** @deprecated — "Tier 1+2 결과 0개"라는 뜻, 파이프라인 실패 아님 */
  fallbackTriggered: boolean,
  source: 'rule_only' | 'llm_only' | 'hybrid' | 'fallback' | 'resolver' | 'resolver_plus_llm',
  llmLatencyMs: number | null,
  phraseCacheHits: number,
  phraseCacheNegativeSkipped: number,
  phraseCacheMisses: number,
  missedPhrases: string[],
  // 아래는 모두 optional
  llmLinkedEntityCount?: number,
  resolvedEntityCount?: number,
  directHardConstraintCount?: number,
  ontologyExpandedConstraintCount?: number,
  compositionalInferenceCount?: number,
  phrasesByTier?: {           // ConstraintExtractionTierBreakdown
    tier1_default_mapping: number,
    tier2_entity_resolver: number,
    tier3_ontology_expansion: number,
    tier4_compositional_inference: number,
    tier5_llm_linker: number,
    tier6_regex_fallback: number,   // legacy name, 정규식 추출기
    unmapped: number,
  },
  categoriesCovered?: string[],
  unresolvedSpanSamples?: string[],
  fallbackReason?: 'nlmapper_exception' | 'llm_schema_validation' | 'llm_empty_response',
}
```

---

## 5. NL Mapper

**파일:** `src/domain/attribute/service/nl-mapper.ts`

### 매핑 조회 순서

1. **외부 저장소 (MappingTablePort):** `await mappingTable.findMapping(trimmedPhrase)`
2. **내장 폴백 (DEFAULT_MAPPINGS):** 약 150+ 한국어·영어 구문 사전

### NLMapping 스키마

```typescript
{
  phrase: string,
  mappedAttribute: string,
  operator: '=' | '>=' | '<=' | 'range' | 'in',
  value: string | number | [number, number] | string[],
  mappingConfidence: number,  // 0.75–0.95
  mappingVersion: 'v1.0',
  source: 'builtin_curated'
}
```

### 주요 매핑 예시

| 한국어 구문 | 영어 구문 | attribute | operator | value |
|------------|---------|-----------|----------|-------|
| 묵직한 | full-bodied | body | >= | 0.7 |
| 가벼운 | light | body | <= | 0.3 |
| 드라이 | dry | sweetness | <= | 0.2 |
| 달달한 | sweet | sweetness | >= | 0.5 |
| 적당히 달달한 | semi-sweet | sweetness | range | [0.3, 0.6] |
| 레드 와인 | red wine | wine_type | = | 'red' |
| 샤르도네 | Chardonnay | grape_primary | = | 'Chardonnay' |
| 보르도 | Bordeaux | region | = | 'Bordeaux' |
| 선물용 | for gift | occasion | in | 'gift' |
| 저렴한 | budget | price_band | = | 'budget' |

### 값 변환 규칙

```typescript
operator === 'range' && Array.isArray(value)
  → { min: value[0], max: value[1] }

operator === 'in' && typeof value === 'string'
  → [value]  // 배열로 래핑

그 외
  → value 그대로
```

---

## 6. Retrieval

**파일:** `src/domain/retrieval/service/candidate-pool.ts`  
**진입:** `CandidatePoolService.execute(input: HybridRetrievalInput)`

### 병렬 채널 구조

```
CandidatePoolService.execute()
  │
  ├─ cascadeRouter.getDispatchDecision()   // 어떤 채널 활성화할지 결정
  │
  ├─ [병렬 실행 — Promise.allSettled()]
  │    ├─ Sparse (BM25)         → searchIndex.sparseSearch()
  │    ├─ Dense (Semantic)      → getOrEmbedBatch() → searchIndex.denseSearch()
  │    ├─ Learned Sparse (SPLADE) → searchIndex.searchLearnedSparse()
  │    └─ Anchor Similarity     → (anchor embedding) → searchIndex.denseSearch()
  │
  ├─ 채널별 graceful degradation 처리
  │
  ├─ RRF 융합 → fusionService.fuse(sparse, dense, anchor, k, learnedSparse)
  │    (k = 쿼리 클래스별 getFusionConfig() 반환값 — 아래 표 참조)
  │
  ├─ 하드 제약 필터 → constraintFilter.applyHardFilters()
  │
  └─ 어셈블리 → candidateAssembler.assemble() (exact/anchor 보호 정책 포함)
```

### RRF k 값 — 쿼리 클래스별 (`per-class-fusion-config.ts`)

도메인 쿼리 클래스 → 융합 클래스 매핑 (`mapToFusionQueryClass()`):

| 도메인 QueryClass | 융합 클래스 | RRF k | Sparse | Dense | Anchor |
|-------------------|-----------|-------|--------|-------|--------|
| `short_entity`, `ambiguous_short_form`, `anchored_similarity` | `specific_wine` | **30** | 2.0× | 0.5× | 1.5× |
| `comparison_query` | `compare` | **40** | 1.5× | 1.0× | 2.0× |
| `pure_constraint`, `semantic_preference` | `browse` | **60** | 1.0× | 1.5× | 1.0× |
| `unknown` / 나머지 | `fallback` | **60** | 1.0× | 1.0× | 1.0× |

> `pairing_search` 인텐트 → `semantic_preference` QueryClass → `browse` 융합 클래스 (k=60). `FUSION_PAIRING`(k=80) 설정은 `per-class-fusion-config.ts`에 존재하지만 **현재 `mapToFusionQueryClass()`에서 어떤 도메인 QueryClass도 매핑하지 않아 미사용** — 코드 주석: "pairing intent is not surfaced as its own QueryClass today, so that config remains unused".  
> **Learned Sparse(SPLADE) 가중치는 모든 클래스에서 0** — Epic-16 서빙 인프라 완성 전까지 비활성.

### 채널별 활성화 조건

| 채널 | 활성화 조건 | Kill Switch |
|------|-----------|------------|
| Sparse (BM25) | 항상 | 없음 |
| Dense | `!killSwitchDenseRetrieval` | `config.killSwitch.denseRetrieval` |
| Learned Sparse | `!killSwitchLearning` + dispatch 허가 | `config.killSwitch.learning` |
| Anchor | Dense 활성 + 앵커 존재 | Dense와 동일 |

### Vespa Rank Profile 선택

| 모드 | Rank Profile |
|------|-------------|
| `producer_browse`, `region_browse`, `compare_candidates`, `relative` | `prestige_hybrid` |
| 그 외 | `hybrid` |

전체 Vespa rank profile 목록 (`vespa-schema.sd`):

| Profile | 용도 |
|---------|------|
| `bm25` | 렉시컬 전용 (BM25 + Doc2Query) |
| `semantic` | 시맨틱 전용 (closeness) |
| `hybrid` | 기본 혼합 (0.5 BM25 + 0.5 semantic) |
| `learned_sparse` | SPLADE 희소 가중치 dotProduct |
| `prestige_hybrid` | 프로듀서/지역 브라우즈용 (critic·prestige 가중치 추가) |
| `popularity_native` | 인기도 네이티브 정렬 |

### 제약 → Vespa 필터 변환

```
constraintToSparseFilterTokens(hardConstraints)
  → YQL WHERE 절 토큰
  // 소프트 제약(acidity 등)은 여기서 제외 — 패널티 경로로 처리
```

---

## 7. Ranking

**핵심 파일:** `src/domain/ranking/service/ranker.ts` (서빙 랭킹), `src/domain/ranking/service/lambdamart-ranker.ts` (LTR 훈련)

### Ranker.rank() 실제 파이프라인 (ranker.ts:427)

```
Step 1: 모든 candidate의 신호 계산
  signalComputer.computeAll(candidate, queryPlan, constraints, anchorProfile, ...)
  → componentScores (per-candidate 다차원 신호 벡터)

Step 2: 가중치 결정 (3단계)
  a. resolveWeights(queryClass)       → 쿼리 클래스별 기본 가중치
  b. getModeWeights(retrievalMode)    → 리트리벌 모드 오버레이 (max 연산)
  c. 정규화 (modeNormFactor)          → 오버레이로 인한 총합 팽창 보정

Step 3: 채널별 가중치 조정
  resolveChannelAwareWeights(candidate.retrievalTrace.candidateSources, weights)
  → 채널 기여도에 따라 채널별 신호 가중치 추가 조정

Step 3b: 최종 스코어 집계
  scoreAggregator.aggregate(componentScores, candidateWeights)
  → finalScore

Step 4: Coarse Prune (T5.2)
  -Infinity 스코어 제거 (하드 제약 위반, 엔티티 무결성 실패)

Step 5: 내림차순 정렬 (NaN 안전, entityId 타이브레이크)
  compareScoredEntriesByFinalScoreDesc()

Step 6: 재랭킹 게이트 평가 (evaluateRerankGate)
  gateDecision = { shouldRerank, topKOverride, reason }
  ├─ shouldRerank=true + reranker 있음 → 크로스 인코더 재랭킹
  │    applyReranking(query, viable, queryClass, topK)
  │    실패 시 → 원래 순위로 폴백
  └─ shouldRerank=true + ltrModels 있음 → LambdaMART LTR 재랭킹
       applyLearnedLtrRerank(results, queryClass, ltrModels)
       차원 불일치 시 → 스킵

Step 7-8: RankedResult 배열 구성 + 증거 항목 매핑
  evidenceMapper.mapToEvidence(componentScores) → evidenceItems
```

### 가중치 구조 (ScoringWeights — ranker.ts)

`resolveWeights(queryClass)`가 반환하는 가중치는 `lambdamart-ranker.ts`의 `DEFAULT_HEURISTIC_WEIGHTS`와 **별개**입니다. 랭커는 자체 `ScoringWeights` 타입을 사용합니다.

`DEFAULT_HEURISTIC_WEIGHTS`(lambdamart-ranker.ts)는 **LTR 훈련 시 초기 균일 가중치**로만 사용됩니다:

| # | LTR 피처 이름 | 초기 가중치 | 설명 |
|---|-------------|-----------|------|
| 1 | `bm25Score` | 0.10 | 렉시컬 BM25 |
| 2 | `semanticScore` | 0.20 | 임베딩 코사인 유사도 |
| 3 | `popularityScore` | 0.15 | 인기도 |
| 4 | `recencyScore` | 0.10 | 빈티지 최신성 |
| 5 | `classMatchScore` | 0.15 | 쿼리 클래스 매칭 |
| 6 | `attributeMatchScore` | 0.15 | 제약 속성 매칭 |
| 7 | `diversityScore` | 0.05 | 다양성 패널티 |
| 8 | `multilingualScore` | 0.10 | 한국어/음역어 커버리지 |

**합계: 1.00** | 현재 훈련 시 `bm25Score`·`diversityScore`는 `0.0` 센티널 (Vespa가 per-candidate 미노출, T18-? 예정)

### LambdaMART 훈련 (retrain-orchestrator → lambdamart-ranker.ts)

```
입력: LambdaMARTExample[] (pairwise 쌍)
출력: QueryClassWeights { weights[8], bias, ndcg5ValidationScore }
```

1. 균일 가중치 초기화 (0.125), bias 초기화 (0.5)
2. `min(LAMBDAMART_MAX_TRAINING_ITERATIONS=100, numExamples × 10)` 반복, 배치 `max(1, floor(numExamples ÷ 10))`
3. xorshift32 결정론적 셔플
4. 그래디언트: `lambda = labelDiff × stableSigmoid(-scoreDiff)`, L2 정규화
5. L1 정규화 (합 < 1e-8이면 균일 복원)
6. NDCG@5 검증

> **훈련 중 클램핑 미적용:** 클램핑이 `scoreDiff`를 `{-1,0,+1}`로 붕괴시켜 랭킹 마진 학습이 불가능해짐.

---

## 8. Diversity & Assembly

**파일:** `src/domain/retrieval/service/browse-diversity.ts`

### Producer Browse 다양성

- 정책: 동일 (product line, vintage) 쌍에서 최고 점수 하나만 유지
- product line key = `producer|grapePrimary|appellation` (geo 없으면 vintage-stripped 라벨 소문자)
- 점수: `BM25 × (1 + PRODUCER_BROWSE_CRITIC_LIFT × criticScore + PRODUCER_BROWSE_PRESTIGE_LIFT × producerPrestige)`
  - `PRODUCER_BROWSE_CRITIC_LIFT = 0.02`, `PRODUCER_BROWSE_PRESTIGE_LIFT = 0.025`
- OR-쿼리 lexical 변형: 최대 `PRODUCER_BROWSE_MAX_LEXICAL_VARIANTS = 4`

### Region Browse 다양성

- 점수: `BM25 × (1 + REGION_BROWSE_CRITIC_LIFT × criticScore + REGION_BROWSE_PRESTIGE_LIFT × producerPrestige)`
  - `REGION_BROWSE_CRITIC_LIFT = 0.02`, `REGION_BROWSE_PRESTIGE_LIFT = 0.03` (Producer보다 높음)
- 생산자 상한: `clamp(ceil(limit ÷ REGION_DIVERSITY_LIMIT_DIVISOR), REGION_DIVERSITY_PER_PRODUCER_MIN, REGION_DIVERSITY_PER_PRODUCER_MAX)`
  - = `clamp(ceil(limit ÷ 5), 2, 4)`
- 2-패스 선택: 1차 상한 준수 → 2차 잔여 슬롯 채우기 (미선택 entity 순서대로)
- OR-쿼리 lexical 변형: 전체 경로 + 슬래시 분절 세그먼트, 최대 `REGION_BROWSE_MAX_LEXICAL_VARIANTS = 6`
- Sparse over-fetch: `min(limit × 8, BROWSE_SPARSE_FETCH_CEILING=240)`

### 중복 제거 (Sparse OR-쿼리 산물)

- `dedupeSparseHitsByEntity()`: 동일 entity 중 최고 점수만 유지
- NaN 처리: `-Infinity`로 취급
- 동점 시: rank → entityId 순으로 결정론적 선택

---

## 9. Agentic Loop

**파일:** `src/application/agent/agent-orchestrator.ts`  
**진입:** `AgentOrchestrator.execute(query, requestId, overrides?, abortSignal?)`

사용자가 `/agent` 엔드포인트를 통해 복잡한 다단계 쿼리를 보낼 때 실행됩니다.

### 전체 루프 구조

```
execute()
  │
  ├─ 적응형 스텝 예산 결정
  │    classifyQueryBudget(query) → { maxSteps, maxTotalTokens, perStepTimeoutMs }
  │    (단순 쿼리 → 작은 예산, 복잡 비교 → 큰 예산)
  │
  └─ 루프 (종료 조건: answer | max_steps | timeout | budget | error | aborted)
       │
       ├─ [사전 검사] StepBudget.canProceed()
       │    → 스텝 수 초과 OR 타임아웃 → 루프 종료
       │
       ├─ BUDGET_WARNING 주입
       │    (잔여 스텝 = 1이고 도구 이력 있을 때)
       │
       ├─ LLM 호출 (Promise.race — 스텝 타임아웃 경쟁)
       │    chatLlm.complete({ messages, temperature: 0, maxOutputTokens: 2048 })
       │    에러 분류: AbortError → 'aborted', Timeout → 'timeout',
       │              CircuitBreakerOpen → 'error', 기타 → 'error'
       │
       ├─ 응답 파싱 (parseLlmOutput)
       │    ├─ {"thought":"…","answer":"…"} → answer 경로, 루프 종료
       │    ├─ {"thought":"…","action":{tool,input}} → 단일 도구 실행
       │    └─ {"thought":"…","actions":[…]} → 병렬 도구 배치 실행
       │
       ├─ 토큰 예산 초과 검사 (post-hoc)
       │    totalInputTokens + totalOutputTokens >= maxTotalTokens → 'budget' 종료
       │
       ├─ [단일 도구] executeAgentTool(tool, input)
       │
       └─ [배치 도구] executeAgentToolsBatch(calls)
            (MAX_TOOLS_PER_BATCH 초과 시 거부)
```

### 사용 가능한 도구 목록

| 도구 | 설명 | 특이사항 |
|------|------|---------|
| `search_wines` | 와인 검색 (§3–8 전체 파이프라인) | `get_food_pairings`와 함께 배치 가능 |
| `compare_wines` | 두 와인 상세 비교 (2-way) | **배치 내 단독 실행 강제** (`compare_wines must run alone in a step`) |
| `check_drinking_window` | 음용 적기 예측 | 동종끼리만 배치 가능 — `search_wines`/`get_food_pairings`/`compare_wines`와 혼합 불가 |
| `get_food_pairings` | 음식 페어링 조회 | `search_wines`와 함께 배치 가능; `compare_wines`/`check_drinking_window`와 혼합 불가 |

### 예산 구성

```typescript
{
  maxSteps: number,           // 최대 LLM 호출 횟수
  maxTotalTokens: number,     // 입출력 토큰 합산 상한
  perStepTimeoutMs: number,   // 스텝당 타임아웃 (ms)
  agentTimeoutMs: number,     // 전체 루프 타임아웃 (ms)
}
```

`agentTimeoutMs` 초과 시 pre-flight 검사에서 포착 → `terminationReason = 'timeout'`.

### 종료 이유 전체 목록 (`AgentTerminationReason`)

| 이유 | 발생 조건 |
|------|---------|
| `answer` | LLM이 비어 있지 않은 `{"answer":"…"}` 반환 |
| `max_steps` | `StepBudget.canProceed()` → 스텝 한도 초과 |
| `timeout` | LLM 스텝 타임아웃 OR `agentTimeoutMs` 초과 |
| `budget` | 누적 토큰 >= `maxTotalTokens` |
| `error` | LLM 에러, CB OPEN, 말형된 응답, 알 수 없는 도구 초과 |
| `aborted` | 클라이언트 연결 종료 (AbortError) — SLO 오류율에서 제외 |
| `loop_detected` | 동일 도구 호출 반복 패턴 감지 |
| `fallback` | 도구 실행 정책 차단 후 합성으로 전환 |
| `blocked` | 보안 정책 또는 도메인 정책에 의해 강제 종료 |

### 루프 종료 후 합성 (4개 레이어)

```
Layer 1: 정상 answer 문자열 → 그대로 반환
Layer 2: max_steps / budget → 마지막 search 결과로 합성
Layer 3: timeout / error → 부분 결과 합성 시도
Layer 4: 합성 실패 → 비어 있는 폴백 응답
```

### AbortSignal 전파 경로

```
HTTP 클라이언트 연결 종료
  → requestAbortSignal 발동
  → AgentOrchestrator.execute()의 abortSignal 파라미터
  → propagateAbort() → stepAbortController.abort()
  → chatLlm.complete()의 HTTP fetch 취소
  → terminationReason = 'aborted' (오류 메트릭에서 제외)
```

---

## 10. Post-Route

**파일:** `src/application/search/search-usecase-post-route-phase.ts`

§2의 Post-Route Phase 상세 설명과 동일. 핵심 분기:

```
rankedResults[]
  │
  ├─ abstainPolicy.shouldAbstain(topScores)
  │
  ├─ [abstain=true] ──────────────────────────────────────────────────
  │    DrinkingWindow 추가
  │    ResponseBuilder.build() (abstain 플래그 포함)
  │    캐시 기록 SKIP
  │    반환
  │
  └─ [abstain=false] ─────────────────────────────────────────────────
       result limit 클램프 (1–1000)
       │
       ├─ DecisionEngine.decide()
       │    → resolved / ambiguous / failed / clarify
       │
       ├─ DrinkingWindowPredictor (선택적)
       │
       ├─ ResponseBuilder.build() → SearchResponseV1
       │
       ├─ 구조화 로그 기록
       │
       └─ cacheService.setSearchResponse() (캐시 기록)
```

---

## 11. 최종 응답 스키마

**파일:** `src/interface/http/schemas/search-response.schema.ts`

```typescript
SearchResponseSchema {
  query_type: 'search',
  engine_decision: {
    decision_status: 'resolved' | 'ambiguous' | 'failed',   // ← decision_status (status 아님)
    next_action: 'return_result' | 'clarify' | 'hybrid_search' | 'fail',
    route: string,
    decision_confidence: number,
    decision_trace_ref: string,      // @deprecated → authority_trace_ref로 마이그레이션 중
    authority_trace_ref?: string,
    execution_mode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory',
    degradation_reasons?: string[],
    abstain_reason?: string,
    decision_snapshot: DecisionSnapshotSchema,
  },
  results: ResultItemSchema[],       // 최대 MAX_SEARCH_RESULTS_PER_RESPONSE개
  counterfactuals?: CounterfactualRejectSchema[],  // ← ResultItemSchema 아님
  clarification?: ClarificationPayloadSchema | null,
  meta: {
    request_id?: string,
    query_time_ms: number,
    route: string,
    version: string,
    engine_schema_version: 'search_response_v1',
    decision_snapshot?: DecisionSnapshotSchema,
    degradation_reasons?: string[],
    specialized_route_requested?: 'producer_browse' | 'region_browse' | 'compare_candidates' | null,
    specialized_route_executed?: 'producer_browse' | 'region_browse' | 'compare_candidates' | null,
    fallback_applied?: boolean,
    retrieval_provenance_slices?: object[],
  },
  retrieval_mode?: 'entity_lookup' | 'attribute_search' | 'similar_items' | 'entity_resolution'
                 | 'constraint_filter' | 'producer_browse' | 'region_browse'
                 | 'compare_candidates' | 'recommendation' | 'no_match_detection',
  result_type?: 'single_entity' | 'entity_set' | 'comparison' | 'no_match'
              | 'producer_set' | 'region_set' | 'style_set' | 'wine_set',
  parsed_constraints?: ParsedConstraintsExternSchema,
}
```

**ResultItemSchema (결과 1개):**
```typescript
{
  entity: EntitySummarySchema,           // 와인 메타데이터
  relevance_score: number,               // finite, [-max, max]
  match: {
    match_type: 'exact' | 'alias_exact' | 'alias_fuzzy' | 'semantic' | 'hybrid',  // ← match_type (type 아님)
    anchor_used?: boolean,
    matched_alias?: string,
    score_components: {
      lexical, semantic, attribute, popularity, preference_alignment
    },
  },
  constraints: {
    matched: string[],    // ← string[] (NormalizedConstraint[] 아님)
    unmet: string[],
    inferred: string[],
  },
  uncertainty: UncertaintyBlockSchema,
  evidence_items: EvidenceItemSchema[],  // 채널별 검색 출처 (min:1)
  drinking_window?: DrinkingWindowSchema,
  match_reasons?: string[],              // 사람이 읽을 수 있는 매칭 이유
  violated_constraints?: string[],
}
```

---

## 12. 데이터 흐름 요약

```
사용자 HTTP 요청 (query: "묵직한 보르도 레드 와인 선물용")
  │
  ▼
[1] HTTP 검증 (Zod, SearchRequestSchema)
  │
  ▼
[2] Pre-Route Phase (search-usecase-pre-route-phase.ts)
  ├─ 보안 게이트 → 통과
  ├─ 비교 쿼리 분해 시도 → 단일 쿼리, 스킵
  ├─ Planner.planWithCompiled() → QueryPlanV1 + CompiledWineQuery 생성
  ├─ 에이전트 필터 없음 → 스킵
  ├─ Constraint SAT 검사 → 모순 없음
  └─ 캐시 조회 → MISS, 계속 진행
  │
  ▼
[3] Planner 내부 (10단계 파이프라인)
  ├─ 정규화: "묵직한 보르도 레드 와인 선물용" (그대로)
  ├─ 앵커 추출: [{surface: "보르도", confidence: 0.95, entityIds: ["region:bordeaux"]}]
  ├─ 인텐트: mixed_query
  │    (hasStrongAnchor=true 0.95≥0.85 + hasConstraintKeyword=true "레드"/"묵직한")
  ├─ 라우트: mixed
  ├─ 리트리벌 모드: similar_items
  │    (mixed_query + hasAnyAnchor)
  ├─ 쿼리 클래스: anchored_similarity  ← mixed_query
  ├─ 제약 파싱 → (§4 아래)
  └─ 불확실성: overall ≈ 0.2 (앵커 신뢰도 높음, 앰비규이티 없음)
  │
  ▼
[4] Constraint Compiler
  ├─ Tier 1 NL Mapper:
  │    "묵직한" → {body, >=, 0.7, soft}
  │    "레드"   → {wine_type, =, 'red', hard}
  │    "선물용" → {occasion, in, 'gift', soft}
  ├─ Tier 2 Entity Resolver:
  │    "보르도" → {region, =, 'Bordeaux', hard}
  └─ ConstraintBundle:
       hard: [wine_type='red', region='Bordeaux']
       soft: [body>=0.7, occasion='gift']
  │
  ▼
[5] Route Dispatch → 'mixed' → mixedSolver.solve()
    (mixed_query는 hybrid 라우트가 아닌 mixed 라우트로 처리됨)
  │
  ▼
[6] 내부적으로 CandidatePoolService.execute() 실행
  ├─ 병렬 검색:
  │    Sparse:  YQL WHERE wine_type='red' AND region='Bordeaux', 렉시컬 쿼리
  │    Dense:   임베딩 벡터 → closeness(embedding)
  │    Anchor:  보르도 앵커 임베딩 → denseSearch
  ├─ RRF 융합 (쿼리 클래스 anchored_similarity → specific_wine → k=30)
  └─ 하드 제약 필터 (wine_type, region 재검사)
  │
  ▼
[7] LambdaMART.rank()
  ├─ 8개 피처 추출 per candidate
  ├─ 가중치 적용 (또는 학습된 QueryClassWeights)
  └─ finalScore = clamp(bias + Σ feature×weight, 0, 1)
  │
  ▼
[8] Post-Route Phase
  ├─ abstainPolicy → abstain=false (점수 분포 뚜렷)
  ├─ DecisionEngine → resolved
  ├─ DrinkingWindow 예측 추가
  ├─ ResponseBuilder.build() → SearchResponseV1
  └─ cacheService.setSearchResponse() 기록
  │
  ▼
HTTP 200 SearchResponseV1
  results: [
    { entity: {label: "Château Margaux 2018", ...}, relevance_score: 0.91,
      match: { score_components: {...} },
      drinking_window: { start: 2026, peak: 2030, end: 2040 },
      match_reasons: ["보르도 지역 매칭", "레드 와인", "선물용 시즌"] }
    ...
  ]
```

---

## 13. Graceful Degradation 매트릭스

| 장애 지점 | Kill Switch | 런타임 감지 | 폴백 | 영향 |
|---------|------------|-----------|------|------|
| Dense 리트리벌 장애 | `killSwitch.denseRetrieval` | 임베딩 API 에러 | Sparse 단독 | 시맨틱 쿼리 재현율 저하 |
| 임베딩 API 장애 | — | 에러 캐치 | Dense 채널 스킵 | 시맨틱 쿼리 재현율 저하 |
| 임베딩 빈 벡터 | — | `.length > 0` 가드 | Dense 채널 스킵 | 위와 동일 |
| Sparse (Vespa) 장애 | — | 에러 캐치 | Dense 단독 | 정확 매칭 정밀도 저하 |
| Learned Sparse 장애 | `killSwitch.learning` | 에러 캐치 | 해당 채널만 제외 | SPLADE 신호 없음 |
| 앵커 임베딩 장애 | Dense와 동일 | 에러 캐치 | 앵커 없는 검색 | 앵커 유사도 신호 없음 |
| Promise.allSettled 거부 | — | 자동 합성 | 합성된 degradation 결과 | 파이프라인 전체 중단 방지 |
| Redis 장애 | — | 접속 실패 | 캐시 없이 계속 | 지연 증가, 결과 동일 |
| LLM Circuit Breaker OPEN | — | CB 상태 확인 | `terminationReason='error'` | 에이전트 루프 즉시 종료 |
| LLM 스텝 타임아웃 | — | Promise.race | `terminationReason='timeout'` | 부분 결과 합성으로 대체 |
| 토큰 예산 초과 | — | 누적 토큰 검사 | `terminationReason='budget'` | 마지막 검색 결과로 합성 |

---

## 14. 핵심 수치 상수 참조표

| 상수 | 값 | 위치 | 의미 |
|------|----|------|------|
| `LAMBDAMART_FEATURE_DIMENSION` | 8 | lambdamart-ranker.ts:149 | 피처 벡터 차원 |
| `LAMBDAMART_UNIFORM_FEATURE_WEIGHT` | 0.125 | lambdamart-ranker.ts:142 | 초기 균일 가중치 |
| `LAMBDAMART_WEIGHT_SUM_EPSILON` | 1e-8 | lambdamart-ranker.ts:154 | 가중치 붕괴 감지 임계값 |
| `LAMBDAMART_VALIDATION_NDCG_K` | 5 | lambdamart-ranker.ts:156 | 검증 지표 truncation |
| `RRF_DEFAULT_K` | 60 | rrf.ts:9 | RRF k 기본값 (browse·fallback 클래스); specific_wine=30, compare=40, pairing(browse)=60 |
| `CONFORMAL_ALPHA` | 0.3 | conformal-config.ts | 보정 알파 (70% coverage) |
| `UNCERTAINTY_PARSER_CONFIDENCE_FLOOR` | 0.5 | planner.ts:522 | 파서 신뢰도 하한 |
| `EXACT_ANCHOR_CONFIDENCE` | 0.85 | planner-intent-detection.ts:10 | strong anchor 판정 임계값 (producer_browse·entity_resolution 진입 등) |
| `IPS_POSITION_PROPENSITY` | [1.0, 0.6, 0.4, 0.3, 0.2] | position-debias.ts | 위치 편향 IPS 가중치 |
| `MAX_TOOLS_PER_BATCH` | (에이전트 설정) | agent-orchestrator.ts:404 | 배치당 최대 도구 수 |
| `maxOutputTokens` | 2048 | agent-orchestrator.ts:530 | LLM 스텝당 최대 출력 토큰 |
| `PRODUCER_BROWSE_CRITIC_LIFT` | 0.02 | browse-diversity.ts:6 | Producer Browse BM25 critic 가중치 |
| `PRODUCER_BROWSE_PRESTIGE_LIFT` | 0.025 | browse-diversity.ts:7 | Producer Browse BM25 prestige 가중치 |
| `REGION_BROWSE_CRITIC_LIFT` | 0.02 | browse-diversity.ts:9 | Region Browse BM25 critic 가중치 |
| `REGION_BROWSE_PRESTIGE_LIFT` | 0.03 | browse-diversity.ts:10 | Region Browse BM25 prestige 가중치 (탐색 강화) |
| `PRODUCER_BROWSE_MAX_LEXICAL_VARIANTS` | 4 | browse-diversity.ts:12 | Producer OR-쿼리 변형 최대 수 |
| `REGION_BROWSE_MAX_LEXICAL_VARIANTS` | 6 | browse-diversity.ts:14 | Region OR-쿼리 변형 최대 수 |
| `REGION_DIVERSITY_PER_PRODUCER_MIN` | 2 | browse-diversity.ts:16 | 지역 다양성 생산자당 최솟값 |
| `REGION_DIVERSITY_PER_PRODUCER_MAX` | 4 | browse-diversity.ts:17 | 지역 다양성 생산자당 최댓값 |
| `REGION_DIVERSITY_LIMIT_DIVISOR` | 5 | browse-diversity.ts:18 | 지역 다양성: 생산자당 = ceil(limit ÷ 5) |
| `BROWSE_SPARSE_FETCH_CEILING` | 240 | browse-diversity.ts:20 | Sparse over-fetch 하드 상한 |
| `BROWSE_SPARSE_OVERFETCH_FACTOR` | 8 | browse-diversity.ts:252 | Over-fetch 배수 (limit × 8, 상한 240) |

---

## 15. 문서 동기화 이력

> 각 라운드는 코드를 직접 읽어 검증한 결과입니다. 에이전트 요약이나 추론에 의존하지 않고 실제 파일을 Read tool로 확인했습니다.

| 라운드 | 날짜 | 커밋 기준 | 검증 범위 | 발견된 오류 |
|--------|------|----------|----------|-----------|
| R1 (초안) | 2026-04-11 | a24b348 | 전체 문서 초안 작성 | — |
| R2 (1차 검증) | 2026-04-11 | a24b348 | §3 Intent Detection, §5 Pre-Route 순서, §6 Constraint Compiler | **E1**: Intent detection 12개 분기 단순화 / **E2**: entity_resolution 조건 오류 / **E3**: RRF k값 불완전 / **E4**: Stage 10 우선순위 순서 오류 |
| R3 (2차 검증) | 2026-04-11 | a24b348 | §5 Pre-Route 전체, §10 Post-Route abstain 경로, §12 데이터 흐름 예시 | **E5**: Pre-Route 순서 (보안→캐시→Planner가 아닌 보안→Epic14→Planner→필터병합→SAT→캐시) / **E6**: Post-Route abstain=true시 DecisionEngine+캐시쓰기 둘 다 스킵 / **E7**: 예시쿼리 분류 오류 (mixed_query, k=30) |
| R4 (3차 검증) | 2026-04-11 | a24b348 | §6 Constraint Compiler Tier 실행 조건, §7 Ranking 파이프라인 전체 | **E8**: Tier 6 "last resort" → 항상 실행+병합, tier12Empty는 온톨로지 경로만 제어 / **E9**: §7 전면 재작성 — 실제 1차 랭커는 `Ranker` 클래스(8단계), LambdaMART는 선택적 Step 6 |
| R5 (4차 검증) | 2026-04-11 | a24b348 | §9 Agentic tool 목록, §11 Response Schema 필드명, §14 상수표 값 | **E10**: `EXACT_ANCHOR_CONFIDENCE` 상수표 0.9 → 0.85 수정 (`planner-intent-detection.ts:10`) / **E11**: §11 4개 오류 수정 — `decision_status`(status→), `CounterfactualRejectSchema`(타입), `match_type`(type→), `string[]`(NormalizedConstraint→) |
| R6 (5차 검증) | 2026-04-11 | a24b348 | §8 Diversity 전체, §9 tool 목록 재검증, §14 상수표 Diversity 섹션, 목차 §7 제목 | **E12**: §9 tool 목록 `get_wine_details`/`get_drinking_window` → `check_drinking_window`/`get_food_pairings` + 배치 정책 상세 추가 / **E13**: §8 Region Browse prestige lift 누락(0.03, Producer는 0.025와 다름) + product line key 로직 + over-fetch 상수 추가 / **E14**: 목차 §7 "LambdaMART 8-feature" → "Ranker 8-step" |
| R7 (6차 검증) | 2026-04-11 | a24b348 | §1 SearchRequestSchema 필드, §4 Tier 6 조건 + ConstraintExtractionTrace, §7 LambdaMART 훈련 수식 | **E15**: §1 요청 스키마 완전히 틀림 — `locale?`/`session_id?`/`explain?`/`budget_override?` 최상위 필드 없음, 실제는 `context.locale`/`options.explain`/`sessionContext.sessionId`/`queryBudget` / **E16**: §4 Tier 6 "Tier 1–2 아무것도 못 찾을 때만" 텍스트 잔존 → 항상 실행+병합으로 수정, `ConstraintExtractionTrace` 필드 전면 수정(optional 필드 다수 누락, `fallbackReason` 누락) / **E17**: §7 훈련 반복 `max(100, n×10)` → `min(100, n×10)` |
| R8 (7차 검증) | 2026-04-11 | a24b348 | §2 Route Dispatch + Post-Route 전체 흐름, §6 RRF 표 + pairing 클래스 | **E18**: `'hybrid' → CandidatePool + LambdaMART` → `CandidatePool + Ranker` / **E19**: Post-Route abstain 경로 흐름 전면 재작성 — 실제는 (1)cacheContext 빌드 (2)snapshot/degradation (3)abstain 판단 (4)limit 적용 후 양쪽 경로 분기, 캐시 write는 abstain 포함 두 경로 모두 시도 / **E20**: §6 `pairing` 융합 클래스(k=80)는 `per-class-fusion-config.ts`에 존재하지만 `mapToFusionQueryClass()`에서 미매핑 — `pairing_search` → `semantic_preference` → `browse`(k=60)가 실제 경로 |

### 검증 현황

- [x] §1 HTTP 라우팅 & 스키마 — `SearchRequestSchema` 실제 필드 전체 (R7)
- [x] §2 Route Dispatch — `entity`/`hybrid`/`mixed` 3개 경로, `dispatchSearchRouteExecution()` (R6)
- [x] §3 Intent Detection 12개 분기 (R2)
- [x] §4 Constraint Compiler — Tier 6 항상 실행, `ConstraintExtractionTrace` 전체 필드 (R7)
- [x] §5 Pre-Route 실행 순서 (R3)
- [x] §6 Retrieval 채널 & RRF k값 (R2–R3)
- [x] §7 Ranking — `Ranker.rank()` 8-step, LambdaMART 훈련 `min(100,n×10)` (R4, R7)
- [x] §8 Diversity — Producer/Region 점수식, product line key, over-fetch 상수 전체 (R6)
- [x] §9 Agentic Loop — tool 목록 4개 + 배치 정책 전체, 예산 구성, 종료 이유 (R5–R6)
- [x] §10 Post-Route abstain 경로 (R3)
- [x] §11 Response Schema 필드명 전체 (R5)
- [x] §14 상수표 전체 — Diversity 섹션 확장 포함 (R5–R6)

---

*최종 업데이트: 2026-04-11 | 코드 기준: `main` 브랜치 a24b348 이후 | 동기화 라운드: R8 | 발견된 오류 누계: 20개*
