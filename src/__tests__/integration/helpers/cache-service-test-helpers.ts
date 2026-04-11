import { vi } from 'vitest';
import {
  QueryCacheKeyBuilder,
  EmbeddingCacheKeyBuilder,
} from '../../../domain/performance/index.js';
import type { QueryCachePort } from '../../../domain/performance/port/query-cache.port.js';
import type { EmbeddingCachePort } from '../../../domain/performance/port/embedding-cache.port.js';
import type { QueryCacheKey, EmbeddingCacheKey } from '../../../domain/performance/model/cache-key.js';
import type { QueryPlanV1 } from '../../../domain/query/model/query-plan.js';
import type { SearchResponseV1 } from '../../../domain/response/model/search-response.js';
import type { DecisionSnapshot } from '../../../domain/shared/types/index.js';
import {
  SEARCH_RESPONSE_CONTRACT_VERSION,
  buildDecisionSnapshotId,
} from '../../../application/search/search-usecase-decision-snapshot.js';

export function buildPlanCacheKey(
  plan: QueryPlanV1,
  request: { sessionContext?: { sessionId: string }; context?: { locale: string } },
  snapshotId?: string,
): QueryCacheKey {
  const b = new QueryCacheKeyBuilder();
  return b.build(
    plan.normalizedQuery,
    plan.retrievalMode,
    plan.constraints.hard.map((c) => {
      const v = c.value;
      const valueStr =
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
          ? String(v)
          : JSON.stringify(v);
      return [c.attribute, c.operator, valueStr] as const;
    }),
    [...plan.expansions.lexical, ...plan.expansions.semantic],
    request.sessionContext?.sessionId,
    request.context?.locale,
    snapshotId,
  );
}

export function embeddingLookupKey(text: string, modelId: string): EmbeddingCacheKey {
  return new EmbeddingCacheKeyBuilder().build(text, modelId, 'Search: ');
}

export function rawEmbeddingKey(redisKey: string): EmbeddingCacheKey {
  return { text: '', modelId: '', redisKey };
}

export function createEmbeddingVector(value: number, dimensions = 384): readonly number[] {
  return Array.from({ length: dimensions }, (): number => value);
}

export function createMockEmbeddingService() {
  return {
    embedBatch: vi.fn(async (txts: readonly string[]): Promise<readonly (readonly number[])[]> =>
      txts.map((_, i): readonly number[] => createEmbeddingVector(i + 0.1)),
    ),
  };
}

export function authoritativeRuntimeState(): {
  readonly learningKillSwitchEnabled: false;
  readonly denseRetrievalEnabled: true;
  readonly rerankerAvailable: true;
  readonly currentExecutionModeHint: 'authoritative';
} {
  return {
    learningKillSwitchEnabled: false,
    denseRetrievalEnabled: true,
    rerankerAvailable: true,
    currentExecutionModeHint: 'authoritative',
  };
}

export const emptyCacheStats = (): Promise<{
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
  readonly entriesCount: number;
}> =>
  Promise.resolve({
    hits: 0,
    misses: 0,
    size: 0,
    entriesCount: 0,
  });

export function createFailingQueryCache(message = 'Persistent error'): QueryCachePort {
  return {
    get: async () => {
      throw new Error(message);
    },
    set: async () => {
      throw new Error(message);
    },
    delete: async () => {},
    deletePattern: async () => 0,
    getStats: emptyCacheStats,
    clear: async () => 0,
  };
}

export class MockQueryCache implements QueryCachePort {
  private store = new Map<string, SearchResponseV1>();

  async get(cacheKey: QueryCacheKey): Promise<SearchResponseV1 | undefined> {
    return this.store.get(cacheKey.redisKey);
  }

  async set(cacheKey: QueryCacheKey, response: SearchResponseV1, _ttlSeconds: number): Promise<void> {
    this.store.set(cacheKey.redisKey, response);
  }

  async delete(cacheKey: QueryCacheKey): Promise<void> {
    this.store.delete(cacheKey.redisKey);
  }

  async deletePattern(pattern: string): Promise<number> {
    let n = 0;
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    for (const key of [...this.store.keys()]) {
      const match = pattern.endsWith('*') ? key.startsWith(prefix) : key.includes(pattern);
      if (match) {
        this.store.delete(key);
        n++;
      }
    }
    return n;
  }

  async getStats(): Promise<{
    readonly hits: number;
    readonly misses: number;
    readonly size: number;
    readonly entriesCount: number;
  }> {
    return {
      hits: 0,
      misses: 0,
      size: 0,
      entriesCount: this.store.size,
    };
  }

  async clear(): Promise<number> {
    const n = this.store.size;
    this.store.clear();
    return n;
  }
}

export class MockEmbeddingCache implements EmbeddingCachePort {
  private store = new Map<string, readonly number[]>();

  async get(cacheKey: EmbeddingCacheKey): Promise<readonly number[] | undefined> {
    return this.store.get(cacheKey.redisKey);
  }

  async set(
    cacheKey: EmbeddingCacheKey,
    embedding: readonly number[],
    _ttlSeconds: number,
  ): Promise<void> {
    this.store.set(cacheKey.redisKey, embedding);
  }

  async delete(cacheKey: EmbeddingCacheKey): Promise<void> {
    this.store.delete(cacheKey.redisKey);
  }

  async deleteByModel(modelId: string): Promise<number> {
    let n = 0;
    for (const key of [...this.store.keys()]) {
      if (key.includes(modelId)) {
        this.store.delete(key);
        n++;
      }
    }
    return n;
  }

  async getStats(): Promise<{
    readonly hits: number;
    readonly misses: number;
    readonly size: number;
    readonly entriesCount: number;
  }> {
    return {
      hits: 0,
      misses: 0,
      size: 0,
      entriesCount: this.store.size,
    };
  }

  async clear(): Promise<number> {
    const n = this.store.size;
    this.store.clear();
    return n;
  }
}

export function createMockPlan(_modelVersion = 'test-v1'): QueryPlanV1 {
  return {
    rawQuery: 'test query',
    normalizedQuery: 'test query',
    intent: 'search',
    additionalIntents: [],
    queryClass: 'simple',
    policy: { type: 'default' },
    anchors: [],
    uncertainty: { terms: [], confidence: 0 },
    route: 'hybrid',
    retrievalMode: 'entity_lookup',
    constraints: { hard: [], soft: [] },
    expansions: { lexical: [], semantic: [] },
    policyRuleVersion: '1',
    thresholdProfileId: 'default',
    plannerVersion: '1',
  } as unknown as QueryPlanV1;
}

export function createMockSnapshot(
  modelVersion = 'test-v1',
  overrides?: Partial<Omit<DecisionSnapshot, 'snapshot_id'>>,
): DecisionSnapshot {
  const snapshotBase = {
    model_versions: { embedding: modelVersion },
    index_versions: { wine_content: '2026-04-01' },
    policy_rule_version: '1',
    threshold_profile_id: 'default',
    planner_version: '1',
    feature_flags: {},
    response_contract_version: SEARCH_RESPONSE_CONTRACT_VERSION,
    ...overrides,
  };
  return {
    snapshot_id: buildDecisionSnapshotId(snapshotBase),
    ...snapshotBase,
  };
}

export function createMockResponse(
  modelVersion = 'test-v1',
  overrides?: {
    readonly executionMode?: 'authoritative' | 'degraded' | 'heuristic' | 'advisory';
    readonly blockingEligible?: boolean;
    readonly degradationReasons?: readonly string[];
    readonly contractVersion?: string;
    readonly decisionStatus?: 'resolved' | 'ambiguous' | 'failed';
  },
): SearchResponseV1 {
  const decisionSnapshot = createMockSnapshot(modelVersion);
  const normalizedDecisionSnapshot =
    overrides?.contractVersion !== undefined
      ? createMockSnapshot(modelVersion, {
          response_contract_version: overrides.contractVersion,
        })
      : decisionSnapshot;
  const executionMode = overrides?.executionMode ?? 'authoritative';
  const blockingEligible = overrides?.blockingEligible ?? true;
  const degradationReasons = overrides?.degradationReasons;
  const decisionStatus = overrides?.decisionStatus ?? 'resolved';
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus,
      nextAction: 'return_result',
      route: 'hybrid',
      decisionConfidence: 0.9,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'test-trace',
      authorityTraceRef: 'test-trace',
      executionMode,
      blockingEligible,
      ...(degradationReasons !== undefined ? { degradationReasons } : {}),
      decisionSnapshot: normalizedDecisionSnapshot,
    },
    results: [],
    meta: {
      requestId: 'test-request-123',
      queryTimeMs: 100,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: overrides?.contractVersion ?? 'search_response_v1',
      decisionSnapshot: normalizedDecisionSnapshot,
      response_hash: 'test-hash',
      authorityTraceRef: 'test-trace',
      executionMode,
      blockingEligible,
      ...(degradationReasons !== undefined ? { degradationReasons } : {}),
    },
  };
}
