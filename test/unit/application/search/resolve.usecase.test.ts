import { describe, expect, it, vi } from 'vitest';
import { ResolveUseCase } from '../../../../src/application/search/resolve.usecase.js';
import type {
  EntityResolverPort,
  QueryPlannerPort,
} from '../../../../src/application/search/port/search-pipeline-deps.port.js';

describe('ResolveUseCase', () => {
  it('includes requestId in decision_trace_ref when provided', async () => {
    const queryPlanner: QueryPlannerPort = {
      plan: vi.fn().mockResolvedValue({
        rawQuery: 'Opus One 2018',
        normalizedQuery: 'opus one 2018',
        intent: 'known_item',
        route: 'entity',
        retrievalMode: 'entity_lookup',
        queryClass: 'known-item',
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

    const entityResolver: EntityResolverPort = {
      resolve: vi.fn().mockResolvedValue({
        status: 'resolved',
        candidates: [],
        topEntity: undefined,
        decisionTrace: {
          queryClass: 'known-item',
          top1CalibratedScore: 1,
          top2CalibratedScore: 0,
          calibratedGap: 1,
          decisionConfidenceC: 1,
          ambiguityDetected: false,
          ambiguityTypes: [],
          appliedThresholds: { resolveThreshold: 0.5, gapThreshold: 0.1 },
          outcomeReasonCodes: [],
        },
        conformalSetSize: 1,
      }),
    };

    const useCase = new ResolveUseCase({
      queryPlanner,
      entityResolver,
      querySanitizer: { sanitize: vi.fn().mockReturnValue({ safe: true, sanitizedQuery: 'Opus One 2018' }) },
    });

    const result = await useCase.execute({ query: 'Opus One 2018', requestId: 'req-123' });

    expect(result.decision_trace_ref).toContain('req-123');
    expect(result.request_id).toBe('req-123');
  });
});
