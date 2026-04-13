import { describe, expect, it, vi } from 'vitest';
import { InterpretUseCase } from '../../../../src/application/search/interpret.usecase.js';
import type { QueryPlannerPort } from '../../../../src/application/search/port/search-pipeline-deps.port.js';
import { createEntityId } from '../../../../src/domain/shared/types/index.js';

describe('InterpretUseCase', () => {
  it('reuses the shared planner context mapping for locale, session, and budget', async () => {
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'Ridge Cabernet',
        normalizedQuery: 'ridge cabernet',
        intent: 'search',
        route: 'hybrid',
        retrievalMode: 'semantic_hybrid',
        queryClass: 'known_item',
        anchors: [],
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policy: {},
        uncertainty: {},
        plannerVersion: '1',
        policyRuleVersion: '1',
        thresholdProfileId: 'default',
      }),
    };

    const previousEntity = createEntityId('prev-entity');
    const useCase = new InterpretUseCase({
      queryPlanner,
      querySanitizer: {
        sanitize: vi.fn().mockReturnValue({
          safe: true,
          sanitizedQuery: 'Ridge Cabernet',
        }),
      },
    });

    await useCase.execute({
      query: '  Ridge Cabernet  ',
      context: { locale: 'ko-KR', currency: 'KRW' },
      sessionContext: {
        sessionId: 'session-7',
        previousEntities: [previousEntity],
      },
      queryBudget: {
        maxLatencyMs: 900,
        maxCandidates: 32,
        rerankLimit: 12,
      },
    });

    expect(queryPlanner.plan).toHaveBeenCalledWith('Ridge Cabernet', {
      locale: 'ko-KR',
      session: {
        sessionId: 'session-7',
        previousEntities: [previousEntity],
      },
      budget: {
        maxLatencyMs: 900,
        maxCandidates: 32,
        rerankLimit: 12,
      },
    });
  });

  it('builds V2 explain with retrieval-profile active channels instead of an empty placeholder', async () => {
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'wines like Sassicaia',
        normalizedQuery: 'wines like sassicaia',
        intent: 'semantic_discovery',
        route: 'mixed',
        retrievalMode: 'recommendation',
        queryClass: 'anchored_similarity',
        anchors: [{
          entityId: createEntityId('sassicaia'),
          label: 'Sassicaia',
          confidence: 0.97,
          type: 'wine',
        }],
        constraints: { hard: [], soft: [], inferred: [] },
        expansions: { lexical: [], semantic: [] },
        policy: {},
        uncertainty: {
          overall: 0.2,
          ambiguityDetected: false,
          ambiguityTypes: [],
          ambiguitySeverity: 'low',
          decisionEffect: 'trace_only',
          parserConfidence: 0.92,
          anchorConfidence: 0.97,
          constraintConfidence: 0.9,
        },
        plannerVersion: '1',
        policyRuleVersion: '1',
        thresholdProfileId: 'default',
      }),
      planWithCompiled: vi.fn().mockResolvedValue({
        v1: {
          rawQuery: 'wines like Sassicaia',
          normalizedQuery: 'wines like sassicaia',
          intent: 'semantic_discovery',
          route: 'mixed',
          retrievalMode: 'recommendation',
          queryClass: 'anchored_similarity',
          anchors: [{
            entityId: createEntityId('sassicaia'),
            label: 'Sassicaia',
            confidence: 0.97,
            type: 'wine',
          }],
          constraints: { hard: [], soft: [], inferred: [] },
          expansions: { lexical: [], semantic: [] },
          policy: {},
          uncertainty: {
            overall: 0.2,
            ambiguityDetected: false,
            ambiguityTypes: [],
            ambiguitySeverity: 'low',
            decisionEffect: 'trace_only',
            parserConfidence: 0.92,
            anchorConfidence: 0.97,
            constraintConfidence: 0.9,
          },
          plannerVersion: '1',
          policyRuleVersion: '1',
          thresholdProfileId: 'default',
        },
        compiled: {
          query: {
            rawQuery: 'wines like Sassicaia',
            normalizedQuery: 'wines like sassicaia',
            intent: 'semantic_discovery',
            queryClass: 'anchored_similarity',
            anchors: [{
              entityId: createEntityId('sassicaia'),
              label: 'Sassicaia',
              confidence: 0.97,
              type: 'wine',
            }],
            constraints: { hard: [], soft: [], inferred: [] },
            expansions: { lexical: [], semantic: [] },
            uncertainty: {
              overall: 0.2,
              ambiguityDetected: false,
              ambiguityTypes: [],
              ambiguitySeverity: 'low',
              decisionEffect: 'trace_only',
              parserConfidence: 0.92,
              anchorConfidence: 0.97,
              constraintConfidence: 0.9,
            },
            plannerVersion: '1',
            policyRuleVersion: '1',
            thresholdProfileId: 'default',
          },
          execution: {
            effectiveRoute: 'hybrid' as const,
            effectiveRetrievalMode: 'recommendation' as const,
            routeSource: 'planner' as const,
            budget: { maxCandidates: 12, enablePrecisionRerank: true },
            provenancePolicy: {
              requireIdentitySeal: true,
              requireConstraintEvidence: false,
              requireAnchorEvidence: false,
            },
          },
        },
      }),
    };

    const useCase = new InterpretUseCase({
      queryPlanner,
      querySanitizer: {
        sanitize: vi.fn().mockReturnValue({
          safe: true,
          sanitizedQuery: 'wines like Sassicaia',
        }),
      },
    });

    const result = await useCase.execute({
      query: 'wines like Sassicaia',
      context: { locale: 'en-US', currency: 'USD' },
      buildV2: true,
    });

    expect(result.v2Explain.activeChannels).toEqual([
      'sparse_bm25',
      'dense_semantic',
      'anchor_similarity',
    ]);
    expect(result.v2Explain.rankingSignals).toContain('anchor_similarity');
  });

  it('uses compiled execution mode for V2 explain observability when planner V1 fields differ', async () => {
    const plan = {
      rawQuery: 'Barolo vs Amarone',
      normalizedQuery: 'barolo vs amarone',
      intent: 'comparison_search' as const,
      route: 'entity' as const,
      retrievalMode: 'compare_candidates' as const,
      queryClass: 'comparison_query',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {},
      uncertainty: {
        overall: 0.15,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.9,
        anchorConfidence: 0.85,
        constraintConfidence: 0.9,
      },
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
    };
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue(plan),
      planWithCompiled: vi.fn().mockResolvedValue({
        v1: plan,
        compiled: {
          query: {
            rawQuery: plan.rawQuery,
            normalizedQuery: plan.normalizedQuery,
            intent: plan.intent,
            queryClass: plan.queryClass,
            anchors: plan.anchors,
            constraints: plan.constraints,
            expansions: plan.expansions,
            uncertainty: plan.uncertainty,
            plannerVersion: plan.plannerVersion,
            policyRuleVersion: plan.policyRuleVersion,
            thresholdProfileId: plan.thresholdProfileId,
          },
          execution: {
            effectiveRoute: 'hybrid' as const,
            effectiveRetrievalMode: 'compare_candidates' as const,
            routeSource: 'planner' as const,
            budget: { maxCandidates: 20, enablePrecisionRerank: true },
            provenancePolicy: {
              requireIdentitySeal: true,
              requireConstraintEvidence: false,
              requireAnchorEvidence: false,
            },
          },
        },
      }),
    };

    const useCase = new InterpretUseCase({
      queryPlanner,
      querySanitizer: {
        sanitize: vi.fn().mockReturnValue({
          safe: true,
          sanitizedQuery: 'Barolo vs Amarone',
        }),
      },
    });

    const result = await useCase.execute({
      query: 'Barolo vs Amarone',
      buildV2: true,
    });

    expect(result.v2Explain.detectedIntent).toBe('comparison');
    expect(result.compiled.execution.effectiveRoute).toBe('hybrid');
  });

  it('surfaces attribute-based appliedConstraints in V2 explain from actual plan constraints', async () => {
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'French red wine under $50',
        normalizedQuery: 'french red wine under $50',
        intent: 'semantic_discovery',
        route: 'hybrid',
        retrievalMode: 'attribute_search',
        queryClass: 'attribute_constrained',
        anchors: [],
        constraints: {
          hard: [
            {
              attribute: 'country',
              operator: '=',
              value: 'france',
              source_phrase: 'French',
              confidence: 0.94,
            },
            {
              attribute: 'color',
              operator: '=',
              value: 'red',
              source_phrase: 'red',
              confidence: 0.93,
            },
          ],
          soft: [
            {
              attribute: 'price_max',
              operator: '<=',
              value: '50',
              source_phrase: 'under $50',
              confidence: 0.88,
            },
          ],
          inferred: [],
        },
        expansions: { lexical: [], semantic: [] },
        policy: {},
        uncertainty: {
          overall: 0.18,
          ambiguityDetected: false,
          ambiguityTypes: [],
          ambiguitySeverity: 'low',
          decisionEffect: 'trace_only',
          parserConfidence: 0.9,
          anchorConfidence: 0.9,
          constraintConfidence: 0.94,
        },
        plannerVersion: '1',
        policyRuleVersion: '1',
        thresholdProfileId: 'default',
      }),
      planWithCompiled: vi.fn().mockResolvedValue({
        v1: {
          rawQuery: 'French red wine under $50',
          normalizedQuery: 'french red wine under $50',
          intent: 'semantic_discovery',
          route: 'hybrid',
          retrievalMode: 'attribute_search',
          queryClass: 'attribute_constrained',
          anchors: [],
          constraints: {
            hard: [
              {
                attribute: 'country',
                operator: '=',
                value: 'france',
                source_phrase: 'French',
                confidence: 0.94,
              },
              {
                attribute: 'color',
                operator: '=',
                value: 'red',
                source_phrase: 'red',
                confidence: 0.93,
              },
            ],
            soft: [
              {
                attribute: 'price_max',
                operator: '<=',
                value: '50',
                source_phrase: 'under $50',
                confidence: 0.88,
              },
            ],
            inferred: [],
          },
          expansions: { lexical: [], semantic: [] },
          policy: {},
          uncertainty: {
            overall: 0.18,
            ambiguityDetected: false,
            ambiguityTypes: [],
            ambiguitySeverity: 'low',
            decisionEffect: 'trace_only',
            parserConfidence: 0.9,
            anchorConfidence: 0.9,
            constraintConfidence: 0.94,
          },
          plannerVersion: '1',
          policyRuleVersion: '1',
          thresholdProfileId: 'default',
        },
        compiled: {
          query: {
            rawQuery: 'French red wine under $50',
            normalizedQuery: 'french red wine under $50',
            intent: 'semantic_discovery',
            queryClass: 'attribute_constrained',
            anchors: [],
            constraints: {
              hard: [
                {
                  attribute: 'country',
                  operator: '=',
                  value: 'france',
                  source_phrase: 'French',
                  confidence: 0.94,
                },
                {
                  attribute: 'color',
                  operator: '=',
                  value: 'red',
                  source_phrase: 'red',
                  confidence: 0.93,
                },
              ],
              soft: [
                {
                  attribute: 'price_max',
                  operator: '<=',
                  value: '50',
                  source_phrase: 'under $50',
                  confidence: 0.88,
                },
              ],
              inferred: [],
            },
            expansions: { lexical: [], semantic: [] },
            uncertainty: {
              overall: 0.18,
              ambiguityDetected: false,
              ambiguityTypes: [],
              ambiguitySeverity: 'low',
              decisionEffect: 'trace_only',
              parserConfidence: 0.9,
              anchorConfidence: 0.9,
              constraintConfidence: 0.94,
            },
            plannerVersion: '1',
            policyRuleVersion: '1',
            thresholdProfileId: 'default',
          },
          execution: {
            effectiveRoute: 'hybrid' as const,
            effectiveRetrievalMode: 'attribute_search' as const,
            routeSource: 'planner' as const,
            budget: { maxCandidates: 12, enablePrecisionRerank: true },
            provenancePolicy: {
              requireIdentitySeal: true,
              requireConstraintEvidence: true,
              requireAnchorEvidence: false,
            },
          },
        },
      }),
    };

    const useCase = new InterpretUseCase({
      queryPlanner,
      querySanitizer: {
        sanitize: vi.fn().mockReturnValue({
          safe: true,
          sanitizedQuery: 'French red wine under $50',
        }),
      },
    });

    const result = await useCase.execute({
      query: 'French red wine under $50',
      buildV2: true,
    });

    expect(result.v2Explain.appliedConstraints).toEqual([
      'hard:country',
      'hard:color',
      'soft:price_max',
    ]);
  });

  it('uses caller requestId for V2 explain queryId when provided', async () => {
    const plan = {
      rawQuery: 'Opus One 2018',
      normalizedQuery: 'opus one 2018',
      intent: 'entity_exact',
      route: 'entity',
      retrievalMode: 'entity_lookup',
      queryClass: 'known_item',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {},
      uncertainty: {
        overall: 0.05,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.98,
        anchorConfidence: 0.98,
        constraintConfidence: 0.98,
      },
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
    };
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue(plan),
      planWithCompiled: vi.fn().mockResolvedValue({
        v1: plan,
        compiled: {
          query: {
            rawQuery: plan.rawQuery,
            normalizedQuery: plan.normalizedQuery,
            intent: plan.intent,
            queryClass: plan.queryClass,
            anchors: plan.anchors,
            constraints: plan.constraints,
            expansions: plan.expansions,
            uncertainty: plan.uncertainty,
            plannerVersion: plan.plannerVersion,
            policyRuleVersion: plan.policyRuleVersion,
            thresholdProfileId: plan.thresholdProfileId,
          },
          execution: {
            effectiveRoute: 'entity' as const,
            effectiveRetrievalMode: 'entity_lookup' as const,
            routeSource: 'planner' as const,
            budget: { maxCandidates: 10, enablePrecisionRerank: false },
            provenancePolicy: {
              requireIdentitySeal: true,
              requireConstraintEvidence: false,
              requireAnchorEvidence: false,
            },
          },
        },
      }),
    };

    const useCase = new InterpretUseCase({
      queryPlanner,
      querySanitizer: {
        sanitize: vi.fn().mockReturnValue({
          safe: true,
          sanitizedQuery: 'Opus One 2018',
        }),
      },
    });

    const result = await useCase.execute({
      query: 'Opus One 2018',
      buildV2: true,
      requestId: 'req-interpret-123',
    });

    expect(result.v2Explain.queryId).toBe('req-interpret-123');
  });

  it('rejects V2 explain when compiled execution is unavailable and the test seam is disabled', async () => {
    const plan = {
      rawQuery: 'Barolo',
      normalizedQuery: 'barolo',
      intent: 'semantic_discovery',
      route: 'hybrid',
      retrievalMode: 'recommendation',
      queryClass: 'known_item',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {},
      uncertainty: {
        overall: 0.1,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.95,
        anchorConfidence: 0.95,
        constraintConfidence: 0.95,
      },
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
    };

    const useCase = new InterpretUseCase({
      queryPlanner: {
        plan: vi.fn().mockResolvedValue(plan),
      },
      querySanitizer: {
        sanitize: vi.fn().mockReturnValue({
          safe: true,
          sanitizedQuery: 'Barolo',
        }),
      },
    });

    await expect(
      useCase.execute({
        query: 'Barolo',
        buildV2: true,
      }),
    ).rejects.toThrow('Interpret use case requires QueryPlanner.planWithCompiled() when buildV2 is requested');
  });

  it('allows an explicit test seam to reconstruct compiled execution for V2 explain', async () => {
    const plan = {
      rawQuery: 'Barolo',
      normalizedQuery: 'barolo',
      intent: 'semantic_discovery',
      route: 'hybrid',
      retrievalMode: 'recommendation',
      queryClass: 'known_item',
      anchors: [],
      constraints: { hard: [], soft: [], inferred: [] },
      expansions: { lexical: [], semantic: [] },
      policy: {},
      uncertainty: {
        overall: 0.1,
        ambiguityDetected: false,
        ambiguityTypes: [],
        ambiguitySeverity: 'low',
        decisionEffect: 'trace_only',
        parserConfidence: 0.95,
        anchorConfidence: 0.95,
        constraintConfidence: 0.95,
      },
      plannerVersion: '1',
      policyRuleVersion: '1',
      thresholdProfileId: 'default',
    };

    const useCase = new InterpretUseCase({
      queryPlanner: {
        plan: vi.fn().mockResolvedValue(plan),
      },
      querySanitizer: {
        sanitize: vi.fn().mockReturnValue({
          safe: true,
          sanitizedQuery: 'Barolo',
        }),
      },
      allowCompiledFallbackForTests: true,
    });

    const result = await useCase.execute({
      query: 'Barolo',
      buildV2: true,
    });

    expect(result.compiled.execution.effectiveRoute).toBe('hybrid');
    expect(result.v2Explain.queryId).toMatch(/^interpret-/);
  });
});
