import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeAgentTool, type AgentToolDeps } from '../../../../src/application/agent/agent-tools.js';
import { extractSearchConstraints } from '../../../../src/domain/query/service/search-constraint-extractor.js';
import type { SearchExecutorPort } from '../../../../src/application/search/port/search-executor.port.js';
import type { SearchResponseV1 } from '../../../../src/domain/response/model/search-response.js';

function makeSearchResponse(
  results: SearchResponseV1['results'],
): SearchResponseV1 {
  return {
    queryType: 'search',
    engineDecision: {
      decisionStatus: 'resolved',
      nextAction: 'return',
      route: 'hybrid',
      decisionConfidence: 0.9,
      confidenceSemantics: 'calibrated_decision_confidence',
      decisionTraceRef: 'trace-123',
      decisionSnapshot: {
        model_versions: {},
        index_versions: {},
        policy_rule_version: '1',
        threshold_profile_id: 'default',
        planner_version: '1',
        feature_flags: {},
      },
    },
    results,
    meta: {
      requestId: 'req-123',
      queryTimeMs: 10,
      route: 'hybrid',
      version: '1.0.0',
      engine_schema_version: 'search_response_v1',
    },
  };
}

describe('executeAgentTool', () => {
  let deps: AgentToolDeps;
  let mockSearchUseCase: SearchExecutorPort;

  beforeEach(() => {
    mockSearchUseCase = {
      execute: vi.fn(),
    };
    deps = {
      searchUseCase: mockSearchUseCase,
    };
  });

  it('serializes structured search inputs into parser-compatible clauses', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'search_wines',
      {
        query: '레드 와인 추천',
        exclude_grapes: ['Merlot', 'Cabernet Sauvignon'],
        exclude_regions: ['France'],
        max_price_krw: 50_000,
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('50_000원 이하'.replace('_', ''));
    expect(request?.query).toContain('not Merlot');
    expect(request?.query).toContain('not Cabernet Sauvignon');
    expect(request?.query).toContain('not France');
    expect(request?.query).not.toContain('under 50000 KRW');
    expect(request?.query).not.toContain('not from France');

    const parsed = extractSearchConstraints(request!.query);
    expect(parsed.maxPriceKrw).toBe(50_000);
    expect(parsed.excludeGrapes).toEqual(
      expect.arrayContaining(['Merlot', 'Cabernet Sauvignon']),
    );
    expect(parsed.excludeCountries).toContain('France');
  });

  it('serializes pairing budgets into parser-compatible KRW text', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([]),
    );

    await executeAgentTool(
      'get_food_pairings',
      {
        food: 'steak',
        max_price_krw: 30_000,
        color: 'red',
      },
      deps,
      'req-123',
    );

    const [request] = vi.mocked(mockSearchUseCase.execute).mock.calls[0] ?? [];
    expect(request?.query).toContain('30000원 이하');
    expect(request?.query).not.toContain('under 30000 KRW');

    const parsed = extractSearchConstraints(request!.query);
    expect(parsed.maxPriceKrw).toBe(30_000);
  });

  it('post-filters results using structured exclusion inputs', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'House Merlot',
            type: 'wine',
            grapes: ['Merlot'],
            region: 'France',
          },
          relevanceScore: 0.9,
          match: {
            matchType: 'hybrid',
            scoreComponents: {
              lexical: 0.8,
              semantic: 0.8,
              attribute: 0.8,
              popularity: 0.5,
              preferenceAlignment: 0.5,
            },
          },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: {
            entityId: 'wine-2',
            canonicalLabel: 'Syrah Reserve',
            type: 'wine',
            grapes: ['Syrah'],
            region: 'Spain',
          },
          relevanceScore: 0.8,
          match: {
            matchType: 'hybrid',
            scoreComponents: {
              lexical: 0.7,
              semantic: 0.7,
              attribute: 0.7,
              popularity: 0.5,
              preferenceAlignment: 0.5,
            },
          },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool(
      'search_wines',
      {
        query: '레드 와인 추천',
        exclude_grapes: ['Merlot'],
        exclude_regions: ['France'],
      },
      deps,
      'req-123',
    );

    const filtered = result.rawResult as SearchResponseV1;
    expect(filtered.results).toHaveLength(1);
    expect(filtered.results[0]?.entity.canonicalLabel).toBe('Syrah Reserve');
    expect(result.observation).toContain('Excluded 1 result(s)');
    expect(result.observation).toContain('merlot');
    expect(result.observation).toContain('france');
  });

  it('keeps raw-query negation filtering working for existing prompts', async () => {
    vi.mocked(mockSearchUseCase.execute).mockResolvedValue(
      makeSearchResponse([
        {
          entity: {
            entityId: 'wine-1',
            canonicalLabel: 'House Merlot',
            type: 'wine',
            grapes: ['Merlot'],
          },
          relevanceScore: 0.9,
          match: {
            matchType: 'hybrid',
            scoreComponents: {
              lexical: 0.8,
              semantic: 0.8,
              attribute: 0.8,
              popularity: 0.5,
              preferenceAlignment: 0.5,
            },
          },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.9, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
        {
          entity: {
            entityId: 'wine-2',
            canonicalLabel: 'Syrah Reserve',
            type: 'wine',
            grapes: ['Syrah'],
          },
          relevanceScore: 0.8,
          match: {
            matchType: 'hybrid',
            scoreComponents: {
              lexical: 0.7,
              semantic: 0.7,
              attribute: 0.7,
              popularity: 0.5,
              preferenceAlignment: 0.5,
            },
          },
          constraints: { matched: [], unmet: [], inferred: [] },
          uncertainty: { uncertaintyConfidence: 0.8, missingInfo: [], approximationUsed: false },
          evidenceItems: [],
        },
      ]),
    );

    const result = await executeAgentTool(
      'search_wines',
      { query: 'red wine not Merlot' },
      deps,
      'req-123',
    );

    const filtered = result.rawResult as SearchResponseV1;
    expect(filtered.results).toHaveLength(1);
    expect(filtered.results[0]?.entity.canonicalLabel).toBe('Syrah Reserve');
  });
});
