# Epic 17: Agentic & Async Infrastructure

**Phase:** 6
**의존성:** Phase 5 complete (Epic 14: DecomposedSearchUseCase, Epic 15: DrinkingWindowUseCase, Epic 16: QuerySanitizer)
**해소 갭:** Watchlist alert (9), Agentic pairing chain (13), Hallucination verify (14), Recall mode switching (15)

---

## 목표

비동기 인프라(Redis pub/sub watchlist)와 Claude tool-use 기반 agentic 레이어를 구축한다.
LLM이 이 시스템을 **도구로서** 사용할 수 있는 완전한 인터페이스를 제공한다.

### 실제 타입 베이스라인

```typescript
// FailureReason (src/domain/decision/model/failure-reason.ts) — 현재 9가지
type FailureReason =
  | 'SNAPSHOT_MISMATCH' | 'IDENTITY_REFERENCE_MISSING' | 'IDENTITY_SEAL_VIOLATION'
  | 'EVIDENCE_INSUFFICIENT' | 'HARD_CONSTRAINT_VIOLATION' | 'AMBIGUITY_BLOCKED'
  | 'POLICY_BLOCKED' | 'BLOCKING_MISS' | 'INTERNAL_INCONSISTENCY';

// DecisionInput.resolverResult.decisionConfidenceC — confidence는 여기서 가져옴
// SearchUseCase.execute(request: SearchRequest, requestId: string) — 2-arg 필수
```

---

## Step 17.1 — Watchlist Alert (Redis pub/sub + Webhook)

### 아키텍처

```
Client → POST /v1/watchlist             (subscribe to entity updates)
Vespa index update (new vintage, price change)
  → WatchlistChecker (background job, Redis SCAN)
  → Redis PubSub publish: channel "watchlist:{entity_id}"
  → WebhookDelivery (HTTP POST to client callback URL)
  → Delivery log (PostgreSQL)
```

### 데이터 모델

```typescript
// src/domain/watchlist/model/watchlist-entry.ts

export type WatchlistTrigger =
  | { readonly type: 'new_vintage'; readonly minVintage?: number }
  | { readonly type: 'price_drop'; readonly thresholdPct: number }
  | { readonly type: 'stock_available' }
  | { readonly type: 'critic_score_above'; readonly minScore: number };

export interface WatchlistEntry {
  readonly id: string;               // uuid
  readonly userId: string;
  readonly entityId: string;
  readonly triggerConditions: readonly WatchlistTrigger[];
  readonly callbackUrl: string;
  readonly createdAt: Date;
  readonly expiresAt?: Date | undefined;
}

/** Emitted when a watched entity changes. */
export interface WatchlistChangeEvent {
  readonly type: 'new_vintage' | 'price_drop' | 'stock_available' | 'critic_score_above';
  readonly data: Record<string, unknown>;
  readonly occurredAt: string;   // ISO 8601
}
```

### Redis PubSub 구현

**기존 `src/infrastructure/db/redis-client.ts`의 `getRedisClient()` 사용.**
Redis pub/sub는 별도 connection이 필요하므로 subscriber용 client를 분리 생성.

```typescript
// src/infrastructure/watchlist/redis-watchlist-publisher.ts

import { getRedisClient } from '../db/redis-client.js';

export class RedisWatchlistPublisher {
  async publishUpdate(entityId: string, event: WatchlistChangeEvent): Promise<void> {
    const client = await getRedisClient();
    await client.publish(`watchlist:${entityId}`, JSON.stringify(event));
  }
}

// src/infrastructure/watchlist/redis-watchlist-subscriber.ts

export class RedisWatchlistSubscriber {
  private subscriberClient: Awaited<ReturnType<typeof getRedisClient>> | null = null;

  async start(handler: (entityId: string, event: WatchlistChangeEvent) => Promise<void>): Promise<void> {
    // Dedicated subscriber connection (cannot issue other commands while subscribed)
    const { createClient } = await import('redis');
    this.subscriberClient = createClient({ url: process.env['REDIS_URL'] });
    await this.subscriberClient.connect();

    // NOTE: redis pSubscribe listener is sync — cannot be async.
    // Fire handler as a floating promise; errors must be caught internally.
    await this.subscriberClient.pSubscribe('watchlist:*', (message, channel) => {
      const entityId = channel.replace('watchlist:', '');
      const event: WatchlistChangeEvent = JSON.parse(message) as WatchlistChangeEvent;
      handler(entityId, event).catch((err: unknown) => {
        console.error('[WatchlistSubscriber] handler error', err);
      });
    });
  }
}
```

### Webhook Delivery

```typescript
// src/infrastructure/watchlist/webhook-delivery.ts

import { createHmac } from 'node:crypto';

export class WebhookDelivery {
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAYS_MS = [1000, 5000, 30000] as const;

  constructor(private readonly webhookSecret: string) {}

  async deliver(entry: WatchlistEntry, event: WatchlistChangeEvent): Promise<boolean> {
    const payload = JSON.stringify({
      watchlist_id: entry.id,
      entity_id: entry.entityId,
      event_type: event.type,
      event_data: event.data,
      triggered_at: new Date().toISOString(),
    });
    const signature = this.sign(payload, entry.id);

    for (let attempt = 0; attempt < WebhookDelivery.MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(entry.callbackUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Wine-Watchlist-Signature': signature,
          },
          body: payload,
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) return true;
      } catch {
        // pass — retry
      }
      if (attempt < WebhookDelivery.MAX_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, WebhookDelivery.RETRY_DELAYS_MS[attempt]));
      }
    }
    return false;
  }

  private sign(payload: string, watchlistId: string): string {
    return createHmac('sha256', this.webhookSecret)
      .update(`${watchlistId}.${payload}`)
      .digest('hex');
  }
}
```

### env.ts 추가

```typescript
// src/config/env.ts 추가
WEBHOOK_SECRET: z.string().min(16),           // HMAC-SHA256 서명용
ANTHROPIC_API_KEY: z.string().min(1).optional(), // Claude tool-use용 (Epic 16에서도 사용)
```

### API

```
POST /v1/watchlist        → 201 { watchlist_id }
DELETE /v1/watchlist/:id  → 204
GET /v1/watchlist/:id/deliveries → 200 { deliveries: DeliveryLog[] }
```

---

## Step 17.2 — Claude Tool-use Integration

### 전제: 의존하는 Use Cases (Phase 5 완료 후)

- `SearchUseCase` — 기존 (`search.usecase.ts`)
- `DecomposedSearchUseCase` — Epic 14에서 정의
- `DrinkingWindowUseCase` — Epic 15에서 정의

### 도구 스키마

```typescript
// src/interface/claude-tools/tool-schemas.ts

export const WINE_SEARCH_TOOLS = [
  {
    name: 'search_wines',
    description: 'Search for wines using natural language query. Returns ranked wine results.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language wine search query' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
        retrieval_mode: {
          type: 'string',
          enum: ['auto', 'entity', 'hybrid', 'mixed'],
          default: 'auto',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_food_pairings',
    description: 'Get wines that pair well with a specific food.',
    input_schema: {
      type: 'object',
      properties: {
        food: { type: 'string' },
        max_price: { type: 'number' },
        color: { type: 'string', enum: ['red', 'white', 'rosé', 'sparkling'] },
      },
      required: ['food'],
    },
  },
  {
    name: 'check_drinking_window',
    description: 'Check if a wine is currently in its optimal drinking window.',
    input_schema: {
      type: 'object',
      properties: {
        entity_id: { type: 'string' },
        target_year: { type: 'integer', description: 'Defaults to current year.' },
      },
      required: ['entity_id'],
    },
  },
  {
    name: 'compare_wines',
    description: 'Compare two wines side by side.',
    input_schema: {
      type: 'object',
      properties: {
        query_a: { type: 'string' },
        query_b: { type: 'string' },
      },
      required: ['query_a', 'query_b'],
    },
  },
] as const;
```

### Tool Executor — 타입 안전 + requestId 올바른 전달

```typescript
// src/interface/claude-tools/tool-executor.ts

import { z } from 'zod';
import type { SearchUseCase } from '../../application/search/search.usecase.js';
import type { DecomposedSearchUseCase } from '../../application/search/decomposed-search.usecase.js';
import type { DrinkingWindowUseCase } from '../../application/drinking-window/drinking-window.usecase.js';

// Per-tool input schemas for runtime validation
const SearchToolInputSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(50).optional(),
  retrieval_mode: z.enum(['auto', 'entity', 'hybrid', 'mixed']).optional(),
});
const FoodPairingInputSchema = z.object({
  food: z.string().min(1),
  max_price: z.number().optional(),
  color: z.enum(['red', 'white', 'rosé', 'sparkling']).optional(),
});
const DrinkingWindowInputSchema = z.object({
  entity_id: z.string().min(1),
  target_year: z.number().int().optional(),
});
const CompareInputSchema = z.object({
  query_a: z.string().min(1),
  query_b: z.string().min(1),
});

export interface WineToolExecutorDeps {
  readonly searchUseCase: SearchUseCase;
  readonly decomposedSearchUseCase: DecomposedSearchUseCase;
  readonly drinkingWindowUseCase: DrinkingWindowUseCase;
}

export class WineToolExecutor {
  constructor(private readonly deps: WineToolExecutorDeps) {}

  async execute(toolName: string, input: unknown, requestId: string): Promise<unknown> {
    switch (toolName) {
      case 'search_wines': {
        const parsed = SearchToolInputSchema.parse(input);
        return this.deps.searchUseCase.execute(
          {
            query: parsed.query,
            ...(parsed.retrieval_mode !== undefined && {
              options: { mode: parsed.retrieval_mode, explain: false, clarification: false },
            }),
          },
          requestId, // ← 2-arg 준수
        );
      }
      case 'get_food_pairings': {
        const parsed = FoodPairingInputSchema.parse(input);
        const query = `wines for ${parsed.food}${parsed.color ? ` ${parsed.color}` : ''}`;
        return this.deps.searchUseCase.execute({ query }, requestId);
      }
      case 'check_drinking_window': {
        const parsed = DrinkingWindowInputSchema.parse(input);
        return this.deps.drinkingWindowUseCase.check({
          entityId: parsed.entity_id,
          ...(parsed.target_year !== undefined && { targetYear: parsed.target_year }),
        });
      }
      case 'compare_wines': {
        const parsed = CompareInputSchema.parse(input);
        return this.deps.decomposedSearchUseCase.execute(
          [parsed.query_a, parsed.query_b],
          'compare',
          `${parsed.query_a} vs ${parsed.query_b}`,
          requestId,
        );
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}
```

### Agentic Endpoint + Adaptive Fallback

```typescript
// src/interface/claude-tools/adaptive-tool-executor.ts

export class AdaptiveToolExecutor {
  constructor(private readonly base: WineToolExecutor) {}

  /**
   * 결과가 비어 있고 mode=auto이면 mixed fallback을 1회 시도한다.
   * 항상 this.base.execute()를 호출하므로 재귀는 발생하지 않는다.
   * fallback도 base.execute() 직접 호출 — executeWithFallback() 재호출 아님.
   */
  async executeWithFallback(
    toolName: string,
    input: unknown,
    requestId: string,
  ): Promise<{ result: unknown; fallbackApplied?: 'mixed' }> {
    const result = await this.base.execute(toolName, input, requestId);

    if (
      toolName === 'search_wines' &&
      this.isEmptyResult(result) &&
      this.isModeAuto(input)
    ) {
      // Fallback: mode=auto → mixed. base.execute() 직접 호출(재귀 없음).
      const mixedInput = { ...(input as object), retrieval_mode: 'mixed' };
      const fallbackResult = await this.base.execute(toolName, mixedInput, `${requestId}-fb`);
      if (!this.isEmptyResult(fallbackResult)) {
        return { result: fallbackResult, fallbackApplied: 'mixed' };
      }
    }

    return { result };
  }

  private isEmptyResult(result: unknown): boolean {
    return (
      typeof result === 'object' &&
      result !== null &&
      'results' in result &&
      Array.isArray((result as { results: unknown[] }).results) &&
      (result as { results: unknown[] }).results.length === 0
    );
  }

  private isModeAuto(input: unknown): boolean {
    if (typeof input !== 'object' || input === null) return true;
    const mode = (input as { retrieval_mode?: string }).retrieval_mode;
    return mode === undefined || mode === 'auto';
  }
}
```

---

## Step 17.3 — Hallucination Verify: Calibrated Confidence Refusal

### 실제 confidence 소스

`DecisionInput.resolverResult.decisionConfidenceC` — resolver가 생성하는 calibrated C.
`DecisionEngine`이 이 값을 사용해 최종 `decisionConfidenceC`를 계산.

### FailureReason 확장

`failure-reason.ts`에 한 값 추가:

```typescript
export type FailureReason =
  | 'SNAPSHOT_MISMATCH' | 'IDENTITY_REFERENCE_MISSING' | 'IDENTITY_SEAL_VIOLATION'
  | 'EVIDENCE_INSUFFICIENT' | 'HARD_CONSTRAINT_VIOLATION' | 'AMBIGUITY_BLOCKED'
  | 'POLICY_BLOCKED' | 'BLOCKING_MISS' | 'INTERNAL_INCONSISTENCY'
  | 'CONFIDENCE_BELOW_THRESHOLD';   // ← 추가
```

### ConfidenceRefusalPolicy

```typescript
// src/domain/decision/service/confidence-refusal.ts

/**
 * RFC-016 §3 — Calibrated confidence refusal.
 * Compares resolver's decisionConfidenceC against threshold.
 * Threshold is calibrated on eval set (AURC-based operating point).
 */
export class ConfidenceRefusalPolicy {
  constructor(private readonly threshold: number = 0.45) {}

  shouldRefuse(decisionConfidenceC: number): boolean {
    return decisionConfidenceC < this.threshold;
  }
}
```

### AdmissionGate 통합

```typescript
// src/domain/decision/service/admission-gate.ts 내 check() 추가 (resolved 경로에만)

// 기존 (a)(b)(c)(d) 체크 이후:
if (
  this.confidenceRefusalPolicy.shouldRefuse(
    input.resolverResult.decisionConfidenceC ?? 1.0,
  )
) {
  return this.reject('CONFIDENCE_BELOW_THRESHOLD', input, snapshot);
}
```

`AdmissionGate` 생성자에 `confidenceRefusalPolicy?: ConfidenceRefusalPolicy` 주입 (optional — 미전달 시 refusal 없음).

### 보정

```typescript
// scripts/calibrate-confidence-threshold.ts
// 1. eval set: wrong_top1 레이블 케이스의 decisionConfidenceC 분포
// 2. ROC curve 계산
// 3. target: refusal rate ≥ 0.90 at C < threshold, false_refusal ≤ 0.05 at C ≥ threshold
// 4. 결과 → CONFIDENCE_REFUSAL_THRESHOLD env var (기본값 0.45)
```

### env.ts 추가

```typescript
CONFIDENCE_REFUSAL_THRESHOLD: z.coerce.number().min(0).max(1).default(0.45),
```

---

## Completion Criteria

**Watchlist:**
- [ ] `POST /v1/watchlist` → 201, `DELETE /v1/watchlist/:id` → 204
- [ ] Redis pub/sub publish → pSubscribe handler → WebhookDelivery
- [ ] webhook 지연 ≤ 5분 (Redis pubsub 경유)
- [ ] 3회 재시도 (1s, 5s, 30s backoff), HMAC-SHA256 서명
- [ ] `WEBHOOK_SECRET` env var 추가

**Claude Tool-use:**
- [ ] 4개 도구 스키마 정의 (Claude API `tools` 파라미터 형식)
- [ ] `WineToolExecutor.execute()` — Zod 런타임 검증, `requestId` 2-arg 전달
- [ ] `AdaptiveToolExecutor.executeWithFallback()` — `_fallbackAttempted` guard로 무한 재귀 방지
- [ ] multi-turn 4-step 체인 성공: food query → search → drinking window check → compare
- [ ] `ANTHROPIC_API_KEY` env var

**Confidence Refusal:**
- [ ] `FailureReason`에 `'CONFIDENCE_BELOW_THRESHOLD'` 추가
- [ ] `ConfidenceRefusalPolicy` + AdmissionGate optional 주입
- [ ] confidence < 0.45 → refusal rate ≥ 0.90 on eval set
- [ ] `CONFIDENCE_REFUSAL_THRESHOLD` env var 추가

**Mode Switching:**
- [ ] empty result → `mixed` fallback 1회, `_fallbackAttempted` flag으로 재귀 방지
- [ ] TypeScript strict 통과, lint clean
