import { describe, expect, it, vi } from 'vitest';
import { Planner } from '../../src/domain/query/service/planner.js';
import { AnchorExtractor } from '../../src/domain/query/service/anchor-extractor.js';
import { ExpansionBuilder } from '../../src/domain/query/service/expansion-builder.js';
import type { AmbiguityDictionary } from '../../src/domain/query/port/ambiguity-dictionary.port.js';
import type { AliasMatcher, AliasMatchResult } from '../../src/domain/query/service/anchor-extractor.js';
import type { NLMapper } from '../../src/domain/attribute/service/nl-mapper.js';
import type { ChatLlmPort } from '../../src/domain/ai/port/chat-llm.port.js';
import { AmbiguityIntentCompiler } from '../../src/domain/query/service/ambiguity-intent-compiler.js';
import {
  retrieveHybridCandidatesForPlan,
  type HybridCandidateRetrievalPorts,
} from '../../src/application/search/search-usecase-hybrid-candidates.js';
import { buildEntropyAbstainResponseParams } from '../../src/application/search/search-usecase-execute-builders.js';
import type { QueryPlanV1 } from '../../src/domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../src/domain/query/model/compiled-wine-query.js';
import type { HybridCandidate } from '../../src/domain/retrieval/model/hybrid-candidate.js';
import type { EntityResolveResult } from '../../src/domain/resolver/model/resolve-result.js';
import type { RankedResult } from '../../src/domain/ranking/model/ranked-result.js';
import type { TypedAbstainDecision } from '../../src/domain/query/model/abstain-decision.js';
import type { DecisionSnapshot } from '../../src/domain/shared/types/index.js';
import { createEntityId } from '../../src/domain/shared/types/index.js';

class EmptyAliasMatcher implements AliasMatcher {
  async findMatches(_normalizedQuery: string): Promise<readonly AliasMatchResult[]> {
    return [];
  }
}

const noAmbiguityDict: AmbiguityDictionary = {
  isKnownAmbiguous: async () => false,
  getAmbiguityInfo: async () => null,
};

const noOpNLMapper: NLMapper = {
  mapPhrase: async () => null,
  mapConstraints: async () => ({ constraints: [] }),
} as unknown as NLMapper;

function buildPlanner(chatLlm: ChatLlmPort): Planner {
  return new Planner(
    noAmbiguityDict,
    new AnchorExtractor(new EmptyAliasMatcher()),
    new ExpansionBuilder(),
    noOpNLMapper,
    undefined,
    undefined,
    new AmbiguityIntentCompiler(chatLlm),
  );
}

function buildCompiled(plan: QueryPlanV1): CompiledWineQuery {
  return {
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
      retrievalPlan: {
        hardFilterTokens: [],
        softBoosts: [],
        inferredBoosts: [],
        sensoryPriors: [],
        planVersion: 'retrieval-plan-v1.0',
      },
    },
    execution: {
      effectiveRoute: 'hybrid',
      effectiveRetrievalMode: 'attribute_search',
      routeSource: 'planner',
      budget: {
        maxCandidates: 10,
        enablePrecisionRerank: true,
        rerankLimit: 10,
      },
      provenancePolicy: {
        requireIdentitySeal: false,
        requireConstraintEvidence: false,
        requireAnchorEvidence: false,
      },
    },
  } as CompiledWineQuery;
}

function failedResolveResult(): EntityResolveResult {
  return {
    status: 'failed',
    candidates: [],
    decisionTrace: {
      queryClass: 'ambiguous_short_form',
      top1CalibratedScore: 0,
      top2CalibratedScore: 0,
      calibratedGap: 0,
      decisionConfidenceC: 0,
      ambiguityDetected: true,
      ambiguityTypes: ['family_alias'],
      appliedThresholds: { resolveThreshold: 0, gapThreshold: 0 },
      outcomeReasonCodes: [],
    },
    conformalSetSize: 0,
  };
}

function makeCandidate(id: string, grapePrimary: string): HybridCandidate {
  return {
    entityId: createEntityId(id),
    canonicalLabel: id,
    grapePrimary,
    matchedConstraints: [],
    retrievalTrace: {
      retrievalProfile: 'default',
      lexicalQueriesUsed: ['pinot'],
      semanticQueriesUsed: [grapePrimary],
      filtersApplied: [],
      candidateSources: ['dense'],
    },
  };
}

function makeRankedResult(label: string): RankedResult {
  return {
    entityId: createEntityId(label),
    canonicalLabel: label,
    finalScore: 0.9,
    rank: 1,
    componentScores: {
      entityIntegrity: 1,
      hardConstraintPass: true,
      softConstraint: 0.7,
      uncertaintyPenalty: 0,
    },
    evidenceItems: [],
    matchedConstraints: [],
    unmetConstraints: [],
    inferredConstraints: [],
  };
}

function makeSnapshot(): DecisionSnapshot {
  return {
    snapshot_id: 'snapshot-llm-ambiguity-e2e',
    model_versions: {},
    index_versions: {},
    policy_rule_version: '1.0.0',
    threshold_profile_id: 'default',
    planner_version: '1.0.0',
    feature_flags: {},
    response_contract_version: 'v1',
  };
}

describe('LLM ambiguity intent compiler end-to-end regression', () => {
  it('narrows deterministic ambiguity into a typed single-branch plan that retrieval and clarify both honor', async () => {
    const chatLlm: ChatLlmPort = {
      complete: vi.fn(async () => ({
        text: JSON.stringify({
          selections: [{
            surface: '피노',
            entityType: 'grape_primary',
            decision: 'select_branches',
            selectedBranchLabels: ['Pinot Gris'],
            resolvedQueryClass: 'semantic_preference',
            clarifyQuestion: '화이트 피노 계열로 좁혀볼까요?',
            confidence: 0.93,
          }],
        }),
        model: 'stub-llm',
        finishReason: 'stop',
      })),
    };

    const planner = buildPlanner(chatLlm);
    const planned = await planner.plan('피노 추천');
    const plan = {
      ...planned,
      route: 'hybrid',
      retrievalMode: 'attribute_search',
      policy: {
        requireExact: false,
        allowApproximate: true,
        requireClarification: false,
        fallbackMode: 'clarify',
        policyReasonCodes: [],
      },
    } as QueryPlanV1;

    expect(plan.queryClass).toBe('semantic_preference');
    expect(plan.expansions.ambiguityIntentInterpretation?.branchSelections).toEqual([
      expect.objectContaining({
        surface: '피노',
        selectedBranchLabels: ['Pinot Gris'],
        resolvedQueryClass: 'semantic_preference',
      }),
    ]);
    expect(plan.expansions.ambiguousEntityHints?.[0]?.explorationBranches.map((branch) => branch.label)).toEqual([
      'Pinot Gris',
    ]);

    const previousCriticFlag = process.env['RETRIEVAL_EXECUTOR_CRITIC'];
    process.env['RETRIEVAL_EXECUTOR_CRITIC'] = 'false';
    try {
      const seenBranchConstraints: string[] = [];
      const ports: HybridCandidateRetrievalPorts = {
        candidatePool: {
          execute: vi.fn(async (input) => {
            const grapePrimary = input.softConstraints.find((constraint) => constraint.attribute === 'grape_primary')?.value;
            seenBranchConstraints.push(String(grapePrimary));
            return [makeCandidate('pinot-gris-1', 'Pinot Gris')];
          }),
          getLastDegradationCodes: vi.fn(() => []),
        } as never,
      };

    const compiled = buildCompiled(plan);
      const retrieval = await retrieveHybridCandidatesForPlan(
        plan,
        ports,
        async () => failedResolveResult(),
        compiled,
      );

      expect(seenBranchConstraints).toEqual(['Pinot Gris']);
      expect(retrieval.candidates.map((candidate) => candidate.grapePrimary)).toEqual(['Pinot Gris']);

      const params = buildEntropyAbstainResponseParams({
        plan,
        compiled,
        snapshot: makeSnapshot(),
        requestId: 'req-llm-ambiguity-e2e',
        startTime: Date.now(),
        effectiveRoute: 'hybrid',
        retrievalModeSource: 'planner',
        plannerSuggestedMode: 'attribute_search',
        abstainDecision: {
          shouldAbstain: true,
          reason: 'low_confidence',
          detail: 'posteriors remain close',
          recoverableBy: 'clarify',
          entropy: 0.95,
        } satisfies TypedAbstainDecision,
        entropy: 0.95,
        results: [],
        rankedResults: [makeRankedResult('Pinot Gris Candidate')],
      });

      expect(params.clarification.structuredPayload).toEqual({
        kind: 'anchor_disambiguation',
        question: '화이트 피노 계열로 좁혀볼까요?',
        options: ['Pinot Gris'],
      });
    } finally {
      if (previousCriticFlag === undefined) {
        delete process.env['RETRIEVAL_EXECUTOR_CRITIC'];
      } else {
        process.env['RETRIEVAL_EXECUTOR_CRITIC'] = previousCriticFlag;
      }
    }
  });
});
