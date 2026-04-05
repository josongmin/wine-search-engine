# Epic 14: Query Decomposition + API Mode Override

**Phase:** 5
**의존성:** Epic 13 (abstain policy), v0.1 Epic 2 (golden queries for multi-entity label)
**해소 갭:** Multi-entity simultaneous (4), Pipeline recall mode override (8)

---

## 목표

"A vs B" 형태의 비교 쿼리를 단일 파이프라인이 처리하지 않고
**LLM 분해 → 병렬 entity resolve → 응답 병합** 체계로 해결.
API 소비자가 `retrieval_mode`를 명시 오버라이드할 수 있는 파라미터를 추가.

---

## Step 14.1 — LLM Query Decomposition

### 실제 타입 확인

```typescript
// 기존 QueryRoute (src/domain/query/model/query-route.ts)
export type QueryRoute = 'entity' | 'hybrid' | 'mixed';

// 기존 QueryIntent (src/domain/query/model/query-intent.ts)
// 'comparison_search' intent가 이미 존재 — 이것을 hook으로 사용

// 기존 SearchRequest.options.mode (src/application/search/search.usecase.ts)
mode: 'auto' | 'entity' | 'hybrid' | 'mixed'
```

### 14.1.1 — Decomposition Detector

```typescript
// src/domain/query/service/decomposition-detector.ts

const COMPARISON_PATTERNS = [
  /(.+)\s+(?:vs\.?|versus)\s+(.+)/i,
  /(.+)\s+(?:와|과|랑|하고|이랑)\s+(.+)\s+(?:중|비교|차이)/,
  /(?:compare|비교)\s+(.+)\s+(?:and|와|과)\s+(.+)/i,
  /(.+)\s+(?:or|아니면|또는)\s+(.+)\s+(?:which|어떤|뭐가)/i,
] as const;

export type DecompositionResult =
  | { decomposed: false }
  | {
      decomposed: true;
      subQueries: [string, string];
      comparisonIntent: 'compare' | 'recommend_one' | 'list_both';
    };

export function detectDecomposition(query: string): DecompositionResult {
  for (const pattern of COMPARISON_PATTERNS) {
    const match = pattern.exec(query);
    if (match?.[1] && match?.[2]) {
      return {
        decomposed: true,
        subQueries: [match[1].trim(), match[2].trim()],
        comparisonIntent: inferComparisonIntent(query),
      };
    }
  }
  return { decomposed: false };
}

function inferComparisonIntent(query: string): DecompositionResult['comparisonIntent'] {
  if (/어느|어떤|추천|better|recommend/i.test(query)) return 'recommend_one';
  if (/둘 다|both|같이/i.test(query)) return 'list_both';
  return 'compare';
}
```

### 14.1.2 — LLM Decomposer (Fallback)

```typescript
// src/domain/query/service/llm-decomposer.ts

const DECOMPOSE_PROMPT = `
You are parsing a wine search query that mentions multiple wines or producers.
Extract exactly 2 sub-queries, each representing a single entity search.

Input query: "{query}"

Respond ONLY with JSON:
{
  "sub_queries": ["<sub-query-1>", "<sub-query-2>"],
  "comparison_intent": "compare" | "recommend_one" | "list_both",
  "confidence": "high" | "medium" | "low"
}

Rules:
- If fewer than 2 distinct entities found, set sub_queries to [] and confidence=low
- Preserve price/vintage constraints in both sub-queries if mentioned globally
- Do NOT invent entities
`;

export interface LLMDecomposerPort {
  decompose(query: string): Promise<DecompositionResult>;
}
```

### 14.1.3 — Parallel Execution

```typescript
// src/application/search/decomposed-search.usecase.ts

import type { SearchUseCase, SearchRequest } from './search.usecase.js';
import type { ComparisonSearchResponse, ComparisonEntity } from '../../domain/response/model/comparison-response.js';

export class DecomposedSearchUseCase {
  constructor(private readonly searchUseCase: SearchUseCase) {}

  async execute(
    subQueries: [string, string],
    comparisonIntent: 'compare' | 'recommend_one' | 'list_both',
    originalQuery: string,
    requestId: string,
  ): Promise<ComparisonSearchResponse> {
    const baseRequest: Omit<SearchRequest, 'query'> = {
      options: { mode: 'auto', explain: false, clarification: false },
    };

    // 병렬 실행
    const [resultA, resultB] = await Promise.all([
      this.searchUseCase.execute({ ...baseRequest, query: subQueries[0] }, `${requestId}-a`),
      this.searchUseCase.execute({ ...baseRequest, query: subQueries[1] }, `${requestId}-b`),
    ]);

    const entityA: ComparisonEntity = {
      subQuery: subQueries[0],
      topResult: resultA.results[0] ?? null,
      resultCount: resultA.results.length,
      resolutionStatus: resultA.engineDecision.decisionStatus,
    };
    const entityB: ComparisonEntity = {
      subQuery: subQueries[1],
      topResult: resultB.results[0] ?? null,
      resultCount: resultB.results.length,
      resolutionStatus: resultB.engineDecision.decisionStatus,
    };

    return {
      queryType: 'comparison',
      originalQuery,
      comparisonIntent,
      entities: [entityA, entityB],
    };
  }
}
```

### 14.1.4 — Comparison Response Type

```typescript
// src/domain/response/model/comparison-response.ts

import type { ResultItem } from './result-item.js';
import type { DecisionStatus } from '../../shared/types/index.js';

export interface ComparisonEntity {
  readonly subQuery: string;
  readonly topResult: ResultItem | null;
  readonly resultCount: number;
  readonly resolutionStatus: DecisionStatus;
}

export interface ComparisonSearchResponse {
  readonly queryType: 'comparison';
  readonly originalQuery: string;
  readonly comparisonIntent: 'compare' | 'recommend_one' | 'list_both';
  readonly entities: [ComparisonEntity, ComparisonEntity];
}
```

### 14.1.5 — SearchUseCase 통합

```typescript
// src/application/search/search.usecase.ts — execute() 내
// Planner 이후, retrieval 이전에 decomposition check

const decomposed = this.decompositionDetector.detect(request.query);
if (decomposed.decomposed) {
  // 비교 쿼리 전용 경로 — 별도 use case로 위임
  return this.handleComparisonQuery(decomposed, request, requestId, startTime);
}
```

`SearchUseCaseDeps`에 `decompositionDetector: DecompositionDetector` 추가.
비교 쿼리 응답은 HTTP layer에서 `ComparisonSearchResponse`로 직렬화 (별도 HTTP 200 body).

### 성능 목표

| 지표 | 목표 |
|------|------|
| "A vs B" decomposition 성공률 | ≥ 0.85 on multi-entity golden set |
| 병렬 resolve latency 추가 | ≤ 200ms p99 (두 검색 병렬) |
| 단일 entity miss (잘못 분해) rate | ≤ 0.05 |

---

## Step 14.2 — `retrieval_mode` API Parameter

### 실제 코드 구조 확인

```typescript
// 기존 SearchUseCase.resolveRoute() (search.usecase.ts:186-194)
private resolveRoute(
  plan: QueryPlanV1,
  mode?: 'auto' | 'entity' | 'hybrid' | 'mixed',
): QueryRoute {
  if (mode === undefined || mode === 'auto') return plan.route;
  return mode;  // 이미 override 지원됨
}
```

현재 `SearchRequest.options.mode`는 `'auto' | 'entity' | 'hybrid' | 'mixed'` 4가지.
`resolveRoute()`가 이미 이 값을 받아 planner 결정을 덮어쓴다.

### API 변경 — `retrieval_mode` top-level 파라미터 추가

현재 `options.mode`는 내부 중첩 필드. 외부 API에서는 top-level `retrieval_mode`로 노출한다.

```typescript
// src/application/search/search.usecase.ts

export interface SearchRequest {
  readonly query: string;
  // ... 기존 fields ...
  /**
   * Explicit retrieval mode override. 'auto' defers to the planner.
   * When specified, sets options.mode and populates retrieval_mode_source.
   */
  readonly retrieval_mode?: 'auto' | 'entity' | 'hybrid' | 'mixed' | undefined;
  readonly options?: {
    readonly mode: 'auto' | 'entity' | 'hybrid' | 'mixed';
    readonly explain: boolean;
    readonly clarification: boolean;
  } | undefined;
}
```

HTTP Route에서 `retrieval_mode`를 받아 `options.mode`로 매핑:

```typescript
// src/interface/http/routes/search.route.ts

const effectiveMode = parsed.retrieval_mode ?? parsed.options?.mode ?? 'auto';
const response = await container.searchUseCase.execute(
  {
    ...parsed,
    options: { mode: effectiveMode, explain: false, clarification: false },
    retrieval_mode: effectiveMode,
  },
  requestId,
);
```

**주의:** `browse`, `compare`, `similar` 모드는 `QueryRoute`에 존재하지 않는다.
이 개념들은 v0.1 Epic 7 (RetrievalMode contract)에서 별도 RFC로 추가될 예정.
v0.2에서는 기존 `'auto' | 'entity' | 'hybrid' | 'mixed'` 4가지 override만 지원한다.

### Response에 override 표시

`EngineDecision`에 `retrievalModeSource` 필드 추가:

```typescript
// src/domain/response/model/engine-decision.ts 에 추가

/** Source of the effective retrieval mode for this response. */
readonly retrieval_mode_source?: 'planner' | 'api_override' | undefined;

/** The mode the planner would have chosen without override. */
readonly planner_suggested_mode?: 'entity' | 'hybrid' | 'mixed' | undefined;
```

응답 예시:
```json
{
  "engine_decision": {
    "retrieval_mode": "hybrid",
    "retrieval_mode_source": "api_override",
    "planner_suggested_mode": "entity"
  }
}
```

### HTTP Request Schema

```typescript
// src/interface/http/schemas/search.schema.ts 확장

export const SearchRequestSchema = z.object({
  query: z.string().min(1).max(500),
  retrieval_mode: z.enum(['auto', 'entity', 'hybrid', 'mixed']).optional(),
  limit: z.number().int().min(1).max(100).default(20).optional(),
  // ... 기존 fields
});
```

### 검증

| 시나리오 | 기대 동작 |
|----------|----------|
| `retrieval_mode=hybrid`, query="Opus One" | hybrid route 강제, `retrieval_mode_source: "api_override"` |
| `retrieval_mode=auto` 또는 미전달 | planner 결정, `retrieval_mode_source: "planner"` |
| `retrieval_mode=entity`, query="red wine" | entity route 강제 (결과 없을 수 있음) |

---

## Completion Criteria

- [ ] "Opus One vs Screaming Eagle" → DecomposedSearchUseCase, ComparisonSearchResponse 반환
- [ ] "Romanée-Conti와 Pétrus 중 어떤 게 좋아?" → decomposition 성공
- [ ] Multi-entity 성공률 ≥ 0.85 on golden set slice
- [ ] `retrieval_mode=hybrid` → `retrieval_mode_source: "api_override"` 포함
- [ ] `retrieval_mode` 미전달 → `retrieval_mode_source: "planner"`, 기존 동작 100% 보존
- [ ] `ComparisonSearchResponse` TypeScript 타입 정의 완료
- [ ] `DecomposedSearchUseCase` DI 컨테이너에 등록
- [ ] TypeScript strict 통과, lint clean
