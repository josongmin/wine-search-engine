# Entity Lookup Pipeline 분리 및 강화 계획 (2026-04-11)

> **상태:** 제안 (Draft v3 — 3-reviewer 병렬 검증 반영)
> **관련 파일:** `src/application/search/search.usecase.ts`, `src/domain/query/service/planner.ts`, `src/config/planner-v1-adapter.ts`, `src/interface/http/routes/lookup.route.ts`, `src/application/search/resolve.usecase.ts`
> **배경 문서:** `docs/system-overview/agentic-process.md`, `docs/rfc/pipeline-architecture.md`

---

## 1. 배경 및 동기

### 1.1 현재 구조의 문제

`POST /v1/search/lookup`은 와인 단일 엔티티 확정 검색 전용 엔드포인트다. 그러나 현재 구현은 `SearchUseCase.execute()`를 그대로 호출하며, entity 경로와 discovery(hybrid) 경로가 동일한 pre-route phase를 공유한다.

```
POST /v1/search/lookup
POST /v1/search
         ↓ 동일 진입점
SearchUseCase.executeInternalUnsafe()  (search.usecase.ts:197)
  ├─ [1] securityGate.getSafeQueryOrThrow()
  ├─ [2] analyzeQueryDecomposition()       ← lookup은 불필요 (타임아웃 최대 15s)
  ├─ [3] queryPlanner.planWithCompiled()   ← PlannerV1Adapter.planWithCompiled()
  │       └─ Planner.materializeQueryPlan()
  │            └─ Stage 7: parseConstraints()  ← entity는 compiled를 사용하지 않음
  │                 └─ ConstraintCompiler.compile()
  │                      ├─ NLMapper (LLM 호출)      ← entity에서 낭비
  │                      └─ Tier 6: Regex            ← entity에서 낭비
  ├─ [4] constraintSAT.check()             ← entity는 제약이 없으므로 no-op이지만 실행됨
  ├─ [5] cacheService lookup
  └─ dispatchSearchRouteExecution()
       ├─ entity → executeEntityRoute()    ← compiled 즉시 버림 (line 371–374 주석 명시)
       └─ hybrid → CandidatePool + Ranker + Reranker + ...
```

`executeEntityRoute()` 설계 주석 (search.usecase.ts:371–374):
> *"compiled intentionally NOT passed — entity route uses plan.policy fields directly"*

`planWithCompiled()`가 생성한 `CompiledWineQuery`는 entity 경로에서 즉시 버려진다.

### 1.2 이미 존재하는 entity-only 경로: ResolveUseCase

**코드 정밀 검증 결과**, `POST /v1/entity/resolve` → `ResolveUseCase` (resolve.usecase.ts)가 이미 entity-only 파이프라인을 구현하고 있다.

```
ResolveUseCase.execute()  (resolve.usecase.ts:53–178)
  ├─ securityGate
  ├─ queryPlanner.plan()         ← plan()만 호출 (planWithCompiled 미사용)
  ├─ constraintSAT.check()
  ├─ buildResolverCandidatesFromPlan()
  └─ entityResolver.resolve()
     → ResolveResponse { status, candidates, topEntity, trace_refs }
```

deps: `queryPlanner`, `entityResolver`, `entityLookup` (optional), 보안 게이트만 주입.
`candidatePool`, `ranker`, `decisionEngine`, `decomposedSearch` 없음.

**그러나** `ResolveUseCase`를 `POST /v1/search/lookup`에 직접 붙일 수 없는 이유:

| 문제 | 내용 |
|------|------|
| 응답 스키마 불일치 | `ResolveResponse` ≠ `SearchResponseV1` — 클라이언트 breaking change |
| 비교 쿼리 감지 없음 | `ResolveUseCase`에 `analyzeQueryDecomposition()` 없음; lookup은 비교 쿼리 시 400 반환 필요 |
| ResponseBuilder 미사용 | `ResolveUseCase`는 `responseBuilder`를 주입받지 않음 |
| LookupRouteContract 불일치 | 계약이 `SearchResponseV1` 봉투를 기대함 |

### 1.3 핵심 낭비 지점

```
POST /v1/search/lookup (entity 경로) 에서 실제 낭비:
  ① NLMapper LLM 호출       — ConstraintCompiler Tier 1 (planner.ts:199)
  ② analyzeQueryDecomposition() — 비교 쿼리 분해 시도 (타임아웃 최대 15s)
  ③ CompiledWineQuery 생성   — PlannerV1Adapter에서 ExecutionCompiler 실행 후 즉시 버려짐

실제로 no-op이라 낭비는 아닌 것:
  - constraintSAT.check()    — entity route는 제약 없으므로 즉시 통과, 비용 미미
```

### 1.4 두 경로의 근본적 차이

| 관점 | Entity Lookup | Discovery (Hybrid) |
|------|--------------|-------------------|
| **질문 유형** | "이 와인이 DB에 있는가?" | "조건에 맞는 최선의 와인은?" |
| **정답 구조** | Top-1 확정 또는 not_found | Top-N 랭킹 리스트 |
| **필요한 것** | Alias 매칭 → EntityResolver | ConstraintCompiler → CandidatePool → Ranker |
| **불필요한 것** | NLMapper, decomposition, CompiledWineQuery | — |
| **실패 의미** | 명확한 "없음" | Zero-result → constraint relaxation |

---

## 2. 목표

1. entity 경로에서 불필요한 연산 제거 — NLMapper LLM 호출, decomposition 시도, CompiledWineQuery 생성
2. **신규 use-case 중복 구현 금지** — `ResolveUseCase`를 활용 또는 확장
3. entity 경로 자체의 alias 커버리지 강화 (한국어 비표준 입력 처리)
4. `SearchUseCase` discovery 전용 정리는 Phase 3 이후 — 점진적 안전 분리

### 2.1 검증에서 확정된 설계 결정

| 결정 | 근거 |
|------|------|
| skeleton CompiledWineQuery 대신 `compiled: undefined` 반환 | post-route phase 전체가 `compiled?` optional chaining으로 처리됨. skeleton보다 단순 |
| Phase 3 hybrid 콜백 교체 시 `resolveEntityRouteForPlan()` 재사용 | `search-usecase-hybrid-ranking-pipeline.ts`에 이미 exported 함수로 존재. 신규 헬퍼 정의 금지 |
| Phase 4 LLM fallback 위치: `PgAliasMatcher` 래핑 | `alias-matcher.ts`(도메인 서비스)가 아닌 `PgAliasMatcher`(실제 production 구현체)가 anchor-extractor 포트를 구현. domain-level 수정은 production에 미연결됨 |
| Phase 4 LLM fallback 범위: lookup/entity 전용 | 전역 활성화 시 모든 hybrid 검색 P99에 수백ms 추가 — discovery 경로에서는 미적용 |

---

## 3. 현재 코드 정밀 분석

### 3.1 planWithCompiled()의 실제 위치

`planWithCompiled()`는 `Planner` 클래스(planner.ts)에 없다.
`PlannerV1Adapter` (src/config/planner-v1-adapter.ts:43)에 구현되어 있으며,
`Planner.plan()` → `materializeQueryPlan()` 결과에 `ExecutionCompiler`를 추가로 적용한다.

```
QueryPlannerPort (인터페이스)
  ├─ plan(): QueryPlanV1                     ← required
  └─ planWithCompiled?(): PlanWithCompiledResult  ← optional

PlannerV1Adapter (구현체)
  ├─ plan()           → Planner.plan() 위임
  └─ planWithCompiled() → Planner.plan() + ExecutionCompiler.compile()

Planner (도메인 서비스)
  └─ plan() → materializeQueryPlan()
       ├─ Stage 1~6
       ├─ Stage 7: parseConstraints() ← NLMapper 호출 위치
       └─ Stage 8~10
```

따라서:
- NLMapper 비용 절감의 올바른 위치: **`Planner.materializeQueryPlan()` 내 Stage 7**
- compiled 생성 비용 절감의 올바른 위치: **`PlannerV1Adapter.planWithCompiled()`**

### 3.2 Planner Stage 7 — entity 경로에서의 낭비

```
planner.ts — materializeQueryPlan()
  Stage 1: 쿼리 정규화              ← entity 필요
  Stage 2: 앵커 추출                ← entity 필요 (핵심)
  Stage 3: 인텐트 감지              ← entity 필요
  Stage 4: 라우트 결정 (route 확정) ← entity 필요
  Stage 5: 리트리벌 모드            ← entity 필요
  Stage 6: 쿼리 클래스              ← entity 필요
  Stage 7: parseConstraints()       ← entity 불필요 — route 확정 후에도 무조건 실행
    └─ ConstraintCompiler.compile()
         ├─ Tier 1: nlMapper.mapConstraints()  ← LLM 호출 (핵심 낭비)
         └─ Tier 6: extractRuleBasedConstraints()
  Stage 8: 쿼리 확장                ← entity 선택적
  Stage 9: 불확실성 계산            ← entity 필요 (confidence gate)
  Stage 10: 타겟 엔티티 타입        ← entity 필요
```

Stage 4에서 `route='entity'`가 확정됨에도 Stage 7이 무조건 실행된다.
Stage 4의 `determineRoute()` 결과가 이미 계산되어 있으므로 재호출 없이 재사용 가능.

### 3.3 hybrid 경로의 entity resolver 콜백 구조

```typescript
// search.usecase.ts:416–431
executeHybridRoute(plan, compiled?)
  └─ executeHybridRouteRankingPipeline(
       plan, deps,
       (p) => this.executeEntityRoute(p),   // 3번째 인자: entity 콜백
       compiled
     )

// search-usecase-hybrid-ranking-pipeline.ts:203
async function executeHybridRouteRankingPipeline(
  plan: QueryPlanV1,
  deps: HybridRankingRouteDeps,
  resolveEntity: (plan: QueryPlanV1) => Promise<EntityResolveResult>,  // 함수 시그니처
  compiled?: CompiledWineQuery,
  requestContext?: RequestExecutionContext,
)
```

3번째 인자는 `EntityResolverPort`가 아닌 `(plan: QueryPlanV1) => Promise<EntityResolveResult>` 함수 타입이다.
Phase 3에서 이 콜백을 교체할 때 시그니처 불일치에 주의 필요.

### 3.4 SearchUseCase와 ResolveUseCase의 의존 관계

```
container-usecases.ts
  ├─ SearchUseCase  ← core.queryPlanner (동일 인스턴스)
  └─ ResolveUseCase ← core.queryPlanner (동일 인스턴스)
```

동일한 `queryPlanner` 인스턴스를 공유한다.
Planner에 fast-path를 추가하면 양쪽 모두 혜택을 받는다.

### 3.5 현재 alias 커버리지 현황

```
한국어 입력 처리 경로:
  [1] correctKoreanWineTypos()       korean-wine-aliases.ts — 30개 교정 사전
  [2] queryNormalizer.normalize()    query-normalizer.ts — 9개 exact + 19개 component 패턴
  [3] transliterator EXCEPTIONS      transliterator.ts — 103개 curated 쌍
  [4] Rule-based forward             FR/IT/ES/EN 4개 언어 규칙셋 (longest-match greedy)
  [5] PG alias 테이블 cascade        alias-matcher.ts — 5단계
       ① Exact  ② Normalized  ③ N-gram (Jaccard≥0.45)  ④ Levenshtein(≤25%)  ⑤ Phonetic

취약 지점:
  - ETL 미커버 케이스: 실시간 LLM fallback 없음 (오프라인 ETL만)
  - 역방향 transliteration: 예외 사전(103개) 기반만, 규칙 역변환 없음
  - Alias DB 5단계 모두 miss 시: entity_fuzzy → hybrid fallback (엔티티 확정 불가)
```

---

## 4. 수정된 분리 설계

### 4.1 핵심 원칙

- **중복 구현 금지**: `EntityLookupUseCase` 신규 생성 폐기 → `ResolveUseCase` 활용
- **최소 변경**: 신규 파일 0개, 수정 파일만
- **공유 플래너**: Planner fast-path는 `SearchUseCase`·`ResolveUseCase` 양쪽 혜택

### 4.2 목표 구조

```
POST /v1/search/lookup → SearchUseCase.execute() (현행 유지)
  단, container wiring에서 decomposedSearch 미주입
  → analyzeQueryDecomposition() 자동 skip (ctx.decomposedSearch 없으면 skip됨)
  → Planner fast-path로 NLMapper 비용 제거
  → compiled 생성 skip (PlannerV1Adapter fast-path)

POST /v1/search        → SearchUseCase.execute() (현행 유지, 변경 없음)

POST /v1/entity/resolve → ResolveUseCase.execute() (현행 유지, 단 Planner fast-path 혜택)
```

### 4.3 공유 레이어 (변경 없음)

| 컴포넌트 | 위치 | 비고 |
|---------|------|------|
| `QueryNormalizer` | `src/domain/query/service/query-normalizer.ts` | 전체 공유 |
| `AnchorExtractor` | `src/domain/query/service/anchor-extractor.ts` | 전체 공유 |
| `PgAliasMatcher` (production 구현체) | `src/infrastructure/adapter/pg-alias-matcher.ts` | search/hybrid 공유. lookup은 Phase 4에서 LlmFallbackAliasMatcher로 래핑 |
| `EntityResolverPort` | 포트 인터페이스 | 전체 공유 |
| `QuerySanitizer` | 보안 게이트 | 전체 공유 |
| `Planner` / `PlannerV1Adapter` | 동일 인스턴스 공유 | fast-path 추가 시 전체 혜택 |

---

## 5. Phase별 작업 계획

### Phase 1 — Planner Stage 7 Entity Fast-Path

**목표:** `route='entity'` 확정 시 Stage 7 (`parseConstraints` — NLMapper LLM 호출) skip.

**변경 파일:** `src/domain/query/service/planner.ts`

**변경 내용:**

Stage 4에서 이미 `route`가 결정되므로, 그 결과를 Stage 7 전에 재사용한다.

```typescript
// planner.ts — materializeQueryPlan() 내부 (현재 line ~199 부근)

// Stage 4에서 이미 계산한 route를 로컬 변수로 보존
const suggestedRoute = this.determineRoute(intent, anchors);  // 기존 코드

// ...Stage 5, 6 실행...

// Stage 7: entity route면 NLMapper skip
const parsed = suggestedRoute === 'entity'
  ? { bundle: EMPTY_CONSTRAINT_BUNDLE }   // EMPTY_CONSTRAINT_BUNDLE은 모듈 상수로 정의
  : await this.parseConstraints(normalizedQuery, intent, context?.abortSignal);
```

**주의사항:**
- `determineRoute()`는 Stage 4에서 이미 호출됨 — 결과를 변수에 보존하고 Stage 7에서 재사용. 중복 호출 금지.
- `EMPTY_CONSTRAINT_BUNDLE`을 모듈 상수로 정의 (magic object 금지 — CLAUDE.md rule 15)
- entity fast-path 시 `retrievalPlan`도 빈 값으로 설정

**PlannerV1Adapter fast-path (planner-v1-adapter.ts):**

Stage 7이 skip되면 `compiled`에 넣을 constraint 정보가 없다. post-route phase의 모든 `compiled` 참조가 optional chaining(`compiled?.execution`, `compiled?.query`)이므로 `undefined`를 반환하는 것이 skeleton 설계보다 단순하고 안전하다.

```typescript
// planner-v1-adapter.ts — planWithCompiled() 내부
const v1 = await this.inner.plan(query, context);

// entity route면 ExecutionCompiler 완전 skip — compiled: undefined 반환
// post-route-phase.ts의 모든 compiled 참조가 optional chaining으로 처리됨
if (v1.suggestedRoute === 'entity') {
  return { v1, compiled: undefined };
}
return { v1, compiled: this.executionCompiler.compile(v1) };
```

`SearchPostRouteExecutionContext.compiled`는 `readonly compiled?: CompiledWineQuery | undefined` — 타입 적합. `executeEntityRoute()`는 이미 `compiled`를 사용하지 않음 (line 371–374 주석).

**테스트:**
- `entity_exact` 인텐트 → Stage 7 미실행, `bundle.hard === []` 확인
- `entity_fuzzy` 인텐트 → Stage 7 미실행 확인
- `hybrid` 인텐트 → Stage 7 정상 실행 확인
- `mixed_query` 인텐트 → Stage 7 정상 실행 확인
- Planner 기존 단위 테스트 전체 통과

---

### Phase 2 — decomposedSearch lookup 경로에서 제거

**목표:** `POST /v1/search/lookup`에서 `analyzeQueryDecomposition()` 타임아웃(최대 15s) 제거.

**메커니즘:** `runSearchPreRoutePhase()`는 `ctx.decomposedSearch`가 없으면 decomposition을 skip한다 (search-usecase-pre-route-phase.ts:57–59). 따라서 container wiring에서 lookup 전용 `SearchUseCase` 인스턴스에 `decomposedSearch`를 주입하지 않으면 된다.

**변경 파일:** `src/config/container-usecases.ts`

```typescript
// 현재: SearchUseCase 단일 인스턴스 — decomposedSearch 포함
const searchUseCase = new SearchUseCase({ ..., decomposedSearch });

// 변경 후: lookup 전용 인스턴스는 decomposedSearch 제외
const lookupUseCase = new SearchUseCase({
  ...,
  // decomposedSearch: 의도적으로 미주입 (lookup은 비교 쿼리를 route-level에서 400 처리)
});
const searchUseCase = new SearchUseCase({ ..., decomposedSearch });
```

**변경 파일:** `src/interface/http/routes/route-deps.ts`

```typescript
// SearchRouteDeps + HttpServerDeps 양쪽에 lookupUseCase 추가
interface SearchRouteDeps {
  searchUseCase: SearchExecutorPort;
  lookupUseCase: SearchExecutorPort;       // 신규 — decomposedSearch 없는 인스턴스
  decomposedSearchUseCase: DecomposedSearchUseCasePort;
}
```

`HttpServerDeps`(route-deps.ts:56–65)가 `SearchRouteDeps`를 aggregate하므로, composition root(HttpServerDeps 조립 지점)에도 `lookupUseCase` 필드 공급 필요.

**변경 파일:** `src/interface/http/routes/lookup.route.ts`

```typescript
// deps.searchUseCase → deps.lookupUseCase
const response = await deps.lookupUseCase.execute(searchRequest, requestId, { ... });
```

**주의사항:**
- `lookupUseCase`와 `searchUseCase`는 같은 `SearchUseCase` 클래스, 다른 인스턴스 — 중복 구현 아님
- 두 인스턴스가 동일한 `entityResolver`, `candidatePool`, `ranker` 어댑터를 공유 (stateless port — 오염 없음)
- **비교 쿼리 동작 변경**: `decomposedSearch` 없는 lookupUseCase에서 "Margaux vs Latour" 입력 시:
  - decomposition skip → planner `comparison_search` 인텐트 → route='entity' → entity resolve(200)
  - lookup.route.ts line 48–53의 `queryType === 'comparison'` 체크 **미발동** (entity resolve는 queryType='search')
  - 결과: 비교 쿼리가 400이 아닌 Margaux 단독 entity resolve(200)로 응답
  - **이는 스펙에 부합** — lookup 엔드포인트 의도는 "단일 엔티티 반환"

**변경 파일 목록 (Phase 2 전체):**

| 파일 | 변경 내용 |
|------|---------|
| `src/config/container-usecases.ts` | lookupUseCase 인스턴스 생성 (decomposedSearch 미주입) |
| `src/interface/http/routes/route-deps.ts` | SearchRouteDeps + HttpServerDeps에 lookupUseCase 추가 |
| `src/interface/http/routes/lookup.route.ts` | deps.lookupUseCase 호출로 교체 |
| HttpServerDeps 조립 지점 (composition root) | lookupUseCase 필드 공급 |

---

### Phase 3 — SearchUseCase entity 잔재 제거 (선택적)

> **전제:** Phase 1, 2 배포 및 검증 완료 후 진행. 기능상 필수가 아닌 코드 정리.

**목표:** entity 경로가 lookup 전용 인스턴스로 이동한 후 `SearchUseCase` 내 entity 잔재 정리.

**핵심 제약 — hybrid 콜백 시그니처 및 SSoT:**

```typescript
// search-usecase-hybrid-ranking-pipeline.ts:203
resolveEntity: (plan: QueryPlanV1) => Promise<EntityResolveResult>
```

이 콜백은 `EntityResolverPort.resolve()` 시그니처와 다르다. 직접 주입 불가.

검증 결과 `resolveEntityRouteForPlan()`이 **이미 `search-usecase-hybrid-ranking-pipeline.ts`에 exported 함수로 존재**한다. 신규 헬퍼 정의 금지 — 기존 함수를 import해서 사용.

```typescript
// 변경 후 executeHybridRoute() — search.usecase.ts
private executeHybridRoute(plan: QueryPlanV1, compiled?: CompiledWineQuery) {
  // resolveEntityRouteForPlan은 search-usecase-hybrid-ranking-pipeline.ts에서 import
  const resolveEntityForHybrid = (p: QueryPlanV1) =>
    resolveEntityRouteForPlan(p, { entityResolver: this.deps.entityResolver, entityLookup: this.deps.entityLookup });
  return executeHybridRouteRankingPipeline(plan, deps, resolveEntityForHybrid, compiled);
}
```

실제 `resolveEntityRouteForPlan()` 시그니처는 `(plan, deps: RankedRouteEntityResolutionDeps)` — 두 번째 인자는 `{ entityResolver, entityLookup }` 객체. 구현 시 코드 확인 후 정확한 타입 매칭 필요.

**수정 파일:** `search.usecase.ts` (executeEntityRoute 제거, executeHybridRoute 콜백 교체)

---

### Phase 4 — LLM Fallback AliasMatcher 데코레이터 (Entity 강화)

**목표:** ETL 미커버 한국어 비표준 입력에 대한 실시간 처리.

**검증 결과 — 올바른 수정 위치:**

Production에서 anchor-extractor 포트를 구현하는 것은 `src/infrastructure/adapter/pg-alias-matcher.ts`(`PgAliasMatcher`)다. `src/domain/alias/service/alias-matcher.ts`는 별도의 도메인 서비스로 production wiring에 연결되지 않는다. RFC v2의 "alias-matcher.ts 수정"은 production에 아무 영향이 없는 오류였다.

**올바른 설계 — 데코레이터 패턴:**

```
현재:
  container-adapters.ts → PgAliasMatcher → anchor-extractor 포트

변경 후 (lookup/entity 전용):
  container-adapters.ts → LlmFallbackAliasMatcher(PgAliasMatcher) → lookup용 AnchorExtractor
  container-adapters.ts → PgAliasMatcher → search/hybrid용 AnchorExtractor (그대로)
```

**신규 파일:** `src/infrastructure/adapter/llm-fallback-alias-matcher.ts`

```
LlmFallbackAliasMatcher (데코레이터)
  ├─ inner: AliasMatcher 포트 (PgAliasMatcher)
  ├─ llm: ChatLlmPort
  └─ aliasRepository: AliasRepositoryPort  ← write-through용 (포트 이미 존재)

findMatches(query):
  result = await inner.findMatches(query)
  if result.length > 0 → 즉시 반환
  // Stage 6: LLM fallback
  llmResult = await llm.complete(aliasResolutionPrompt(query))
  if llmResult.confidence > 0.6 → write-through (aliasRepository.save, 비동기)
  return llmResult (confidence ≤ 0.6으로 표시)
```

**레이턴시 격리:** LLM fallback은 lookup 전용 `AnchorExtractor` 인스턴스에만 주입 — discovery(hybrid) 경로 P99 무영향.

**write-through 레이어:** `AliasRepositoryPort.save()`는 이미 존재(`pg-alias-repository.ts`). 오류 처리: write 실패 시 fallback 결과는 유지, 오류는 로그만 (검색 응답은 차단하지 않음).

**변경 파일 목록 (Phase 4 전체):**

| 파일 | 변경 내용 |
|------|---------|
| `src/infrastructure/adapter/llm-fallback-alias-matcher.ts` | 신규 — 데코레이터 구현 |
| `src/config/container-adapters.ts` | lookup용 AnchorExtractor에 LlmFallbackAliasMatcher 주입 |

**Rule 33 준수 확인:** `LlmFallbackAliasMatcher`가 `container-adapters.ts`에서 lookup용 경로에 wiring되는지 grep으로 검증 필수.

---

## 6. 실행 순서 및 의존관계

```
Phase 1 (Planner Stage 7 fast-path)
  ├─ 변경: planner.ts, planner-v1-adapter.ts
  ├─ 리스크: 낮음 — empty bundle은 entity route에서 정상 동작, compiled=undefined는 optional chaining으로 처리
  ├─ 효과: SearchUseCase + ResolveUseCase 양쪽에서 NLMapper 비용 제거
  └─ 검증: 기존 단위 테스트 + entity intent 케이스 + planner-v1-adapter 케이스 추가
      ↓
Phase 2 (decomposedSearch lookup 분리)
  ├─ 변경: container-usecases.ts, route-deps.ts, lookup.route.ts, composition root
  ├─ 신규 파일: 없음
  ├─ 리스크: 낮음 — 같은 클래스, 다른 인스턴스. lookup.route.ts는 격리된 경로
  └─ 검증: lookup e2e + search decomposition 회귀 + 비교 쿼리 동작 확인
      ↓
Phase 3 (SearchUseCase 정리) — 선택적, 기능상 필수 아님
  ├─ 변경: search.usecase.ts
  ├─ 리스크: 중간 — hybrid entity 콜백 교체 시 resolveEntityRouteForPlan import 필요
  └─ 검증: compare_candidates anchor resolve 회귀 테스트 필수
      ↓
Phase 4 (LlmFallbackAliasMatcher 데코레이터) — 독립적, Phase 1 이후 언제든
  ├─ 변경: container-adapters.ts
  ├─ 신규: llm-fallback-alias-matcher.ts
  ├─ 리스크: 낮음 — lookup 전용 인스턴스, hybrid 경로 미영향
  └─ 검증: ETL 미커버 케이스 + write-through + hallucination 방어 + Rule 33 wiring 확인
```

---

## 7. 변경 파일 총계

| Phase | 수정 파일 | 신규 파일 |
|-------|---------|---------|
| 1 | `planner.ts`, `planner-v1-adapter.ts` | — |
| 2 | `container-usecases.ts`, `route-deps.ts`, `lookup.route.ts`, composition root | — |
| 3 | `search.usecase.ts` | — |
| 4 | `container-adapters.ts` | `llm-fallback-alias-matcher.ts` |
| **합계** | **7개** | **1개** |

> **v1 계획 대비 변경:**
> - `EntityLookupUseCase` 신규 생성 폐기 → 신규 파일 2개 제거
> - Phase 4 수정 위치 변경: `alias-matcher.ts`(domain, production 미연결) → `LlmFallbackAliasMatcher` 데코레이터 (infra 레이어, production wiring)
> - Phase 3 시그니처 예시 수정: `resolveEntityRouteForPlan` 기존 export 재사용

---

## 8. 테스트 계획

### Phase 1
- `planner.ts`: `entity_exact` 인텐트 → `bundle.hard === []`, Stage 7 미실행 (NLMapper 미호출)
- `planner.ts`: `entity_fuzzy` 인텐트 → Stage 7 미실행
- `planner.ts`: `facet_search`, `hybrid`, `mixed_query` 인텐트 → Stage 7 정상 실행
- `planner.ts`: constraints 빈 배열 시 Stage 9 불확실성 계산 정상 동작 (constraintConfidence neutral 상수 사용)
- `planner-v1-adapter.ts`: entity route → `compiled: undefined` 반환 확인
- `planner-v1-adapter.ts`: non-entity route → `compiled` 정상 생성 확인
- 기존 Planner 단위 테스트 전체 통과

### Phase 2
- `POST /v1/search/lookup`: "샤또마고 2016" → Château Margaux 엔티티 확정 (200)
- `POST /v1/search/lookup`: "Margaux vs Latour" → Margaux 단독 entity resolve (200) — **400 아님**
- `POST /v1/search/lookup`: decomposition 미실행 확인 (trace/log)
- `POST /v1/search`: "Margaux vs Latour" → ComparisonSearchResponse (decomposition 정상 동작)
- `test:e2e:contract` 통과 (스키마 변경 없음)
- HttpServerDeps 조립 지점에 lookupUseCase 필드 공급 확인

### Phase 3
- compare_candidates route에서 anchor entity resolve 회귀 테스트 (`resolveEntityRouteForPlan` 경유)
- `search.usecase.ts` entity 분기 제거 후 hybrid/mixed 정상 동작 확인
- `test:unit`, `test:e2e` 전체 통과

### Phase 4
- ETL 미커버 한국어 표현 (예: "뻬뜨뤼스") → LLM fallback → Pétrus entityId 반환
- 동일 표현 재입력 → PgAliasMatcher Stage 1 HIT (write-through 검증)
- LLM 오답/hallucination → confidence ≤ 0.6, AliasMatchResult에서 제외
- `POST /v1/search` (hybrid) 경로: LLM fallback 미실행 확인 (레이턴시 격리)
- CLAUDE.md rule 8: 한국어 regex에 `\b` 없음 확인
- CLAUDE.md rule 33: `LlmFallbackAliasMatcher`가 lookup 경로 production wiring에 연결됨 확인

---

## 9. 결정하지 않은 사항 (Open Questions)

| 항목 | 옵션 A | 옵션 B | 비고 |
|------|-------|-------|------|
| Phase 4 LLM fallback 모델 | claude-haiku-4-5 (빠름, 저렴) | claude-sonnet-4-6 (정확) | 와인명 인식 정확도 vs 비용 |
| LLM fallback write-through 타이밍 | 즉시 동기 write (검색 레이턴시 추가) | 비동기 fire-and-forget | write 실패 시 오류 로그만, 응답 차단 안 함 |
| Phase 3 타이밍 | Phase 2 직후 | 별도 스프린트 | 기능상 필수 아님, 코드 정리 성격 |
| 비교 쿼리 lookup 동작 | 200 entity resolve (현재 계획) | 400 명시적 거부 유지 | 후자면 lookup.route.ts에 intent 기반 별도 체크 추가 필요 |
