import type { QueryPlanV1 } from '../../domain/query/model/query-plan.js';
import type { CompiledWineQuery } from '../../domain/query/model/compiled-wine-query.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { HybridCandidate } from '../../domain/retrieval/model/hybrid-candidate.js';
import type {
  DualLaneArtifact,
  EntityLaneCandidateArtifact,
  GeneralLaneCandidateArtifact,
} from '../../domain/retrieval/model/dual-lane-artifact.js';
import { fuseDualLaneArtifacts } from '../../domain/retrieval/service/dual-lane-fusion.js';
import type { CanonicalEntityId } from '../../domain/shared/types/index.js';
import type { RequestExecutionContext } from '../../domain/shared/request-execution-context.js';
import {
  liftEntityResolveResultToLaneArtifacts,
} from './search-usecase-entity-ranked-results.js';
import type {
  DualLaneRouteResult,
  SearchExecutionLaneArtifacts,
  SearchRouteExecutionResult,
} from './search-usecase-route-dispatch.js';
import {
  executeHybridRouteRankingPipeline,
  resolveEntityRouteForPlan,
  resolveEntityRouteForPlanExecution,
  type HybridRankedRoutePipelineDeps,
  type DualLaneRouteExecutionArtifacts,
  type HybridRouteRetrievalExecutor,
} from './search-usecase-hybrid-ranking-pipeline.js';
import {
  retrieveHybridCandidatesForPlan,
  type HybridCandidateRetrievalResult,
} from './search-usecase-hybrid-candidates.js';

interface SearchUseCaseDualLaneExecutionResult {
  readonly executionTopology: 'dual_lane';
  readonly identityResolveResult: EntityResolveResult;
  readonly generalRetrievalResult: HybridCandidateRetrievalResult;
  readonly fusedCandidates: readonly HybridCandidate[];
  readonly laneArtifacts: readonly DualLaneArtifact[];
}

interface DualLaneHybridRouteExecutionResult {
  readonly dualLaneExecution: SearchUseCaseDualLaneExecutionResult;
  readonly routeExecution: DualLaneRouteResult;
}

interface DualLaneRouteExecutionAttempt {
  readonly attemptId: string;
  readonly dualLaneExecution: SearchUseCaseDualLaneExecutionResult;
  readonly routeExecutionArtifacts: DualLaneRouteExecutionArtifacts;
}

let dualLaneExecutionAttemptSequence = 0;

function nextDualLaneExecutionAttemptId(): string {
  dualLaneExecutionAttemptSequence += 1;
  return `dual-lane-attempt-${dualLaneExecutionAttemptSequence}`;
}

function assertDualLaneExecutionContract(
  compiled: CompiledWineQuery,
): CompiledWineQuery {
  if (compiled.execution.effectiveRoute !== 'hybrid') {
    throw new Error(
      `Dual-lane executor requires effectiveRoute=hybrid; received ${compiled.execution.effectiveRoute}`,
    );
  }

  if (compiled.execution.executionTopology === 'entity_only') {
    throw new Error('Dual-lane executor cannot bind executionTopology=entity_only');
  }

  if (compiled.execution.executionTopology !== 'dual_lane') {
    throw new Error(
      `Dual-lane executor requires executionTopology=dual_lane; received ${compiled.execution.executionTopology}`,
    );
  }

  return compiled;
}

function buildRouteExecutionArtifacts(
  laneArtifacts: readonly DualLaneArtifact[],
): SearchExecutionLaneArtifacts<
  EntityLaneCandidateArtifact,
  GeneralLaneCandidateArtifact,
  DualLaneArtifact
> {
  const identity: EntityLaneCandidateArtifact[] = [];
  const general: GeneralLaneCandidateArtifact[] = [];

  for (const artifact of laneArtifacts) {
    if (artifact.entityLane !== undefined) {
      identity.push(artifact.entityLane);
    }
    if (artifact.generalLane !== undefined) {
      general.push(artifact.generalLane);
    }
  }

  return {
    identity,
    general,
    fused: laneArtifacts,
  };
}

function buildDualLaneRouteExecutionAttempt(
  dualLaneExecution: SearchUseCaseDualLaneExecutionResult,
): DualLaneRouteExecutionAttempt {
  const attemptId = nextDualLaneExecutionAttemptId();
  return {
    attemptId,
    dualLaneExecution,
    routeExecutionArtifacts: {
      attemptId,
      executionTopology: dualLaneExecution.executionTopology,
      identityResolveResult: dualLaneExecution.identityResolveResult,
      laneArtifacts: buildRouteExecutionArtifacts(dualLaneExecution.laneArtifacts),
    },
  };
}

function assertDualLaneRouteExecutionResult(
  routeExecution: SearchRouteExecutionResult,
): DualLaneRouteResult {
  if (routeExecution.executionTopology !== 'dual_lane') {
    throw new Error(
      `Dual-lane execution invariant violated: expected dual_lane route execution, received ${routeExecution.executionTopology}`,
    );
  }

  return routeExecution;
}

export async function executeDualLaneSearch(
  plan: QueryPlanV1,
  deps: HybridRankedRoutePipelineDeps,
  compiled: CompiledWineQuery,
  requestContext?: RequestExecutionContext,
  anchorEntityId?: CanonicalEntityId,
): Promise<SearchUseCaseDualLaneExecutionResult> {
  const dualLaneCompiled = assertDualLaneExecutionContract(compiled);

  const entityResolutionDeps = {
    entityResolver: deps.entityResolver,
    entityLookup: deps.entityLookup,
    blocker: deps.blocker,
  } as const;

  const identityResolutionPromise = resolveEntityRouteForPlanExecution(
    plan,
    entityResolutionDeps,
    dualLaneCompiled,
  );
  const identityResolvePromise = identityResolutionPromise.then(
    (execution) => execution.resolveResult,
  );
  const generalRetrievalPromise = retrieveHybridCandidatesForPlan(
    plan,
    {
      candidatePool: deps.candidatePool,
      browseRetriever: deps.browseRetriever,
      compareRetriever: deps.compareRetriever,
      ...(deps.multiQueryGenerator !== undefined
        ? { multiQueryGenerator: deps.multiQueryGenerator }
        : {}),
      ...(deps.hydeGenerator !== undefined
        ? { hydeGenerator: deps.hydeGenerator }
        : {}),
    },
    async (candidatePlan) =>
      candidatePlan === plan
        ? identityResolvePromise
        : resolveEntityRouteForPlan(candidatePlan, entityResolutionDeps, dualLaneCompiled),
    dualLaneCompiled,
    requestContext,
    anchorEntityId,
  );

  const [
    { resolveResult: identityResolveResult, resolverCandidates },
    generalRetrievalResult,
  ] = await Promise.all([
    identityResolutionPromise,
    generalRetrievalPromise,
  ]);

  const entityLaneArtifacts = liftEntityResolveResultToLaneArtifacts(
    plan,
    identityResolveResult,
    resolverCandidates,
  );
  const { fusedCandidates, laneArtifacts } = fuseDualLaneArtifacts({
    entityLaneArtifacts,
    generalLaneCandidates: generalRetrievalResult.candidates,
  });

  return {
    executionTopology: 'dual_lane',
    identityResolveResult,
    generalRetrievalResult,
    fusedCandidates,
    laneArtifacts,
  };
}

export async function executeDualLaneHybridRoute(
  plan: QueryPlanV1,
  deps: HybridRankedRoutePipelineDeps,
  compiled: CompiledWineQuery,
  requestContext?: RequestExecutionContext,
  anchorEntityId?: CanonicalEntityId,
): Promise<DualLaneHybridRouteExecutionResult> {
  const dualLaneCompiled = assertDualLaneExecutionContract(compiled);

  const attempts: DualLaneRouteExecutionAttempt[] = [];
  const retrievalExecutor: HybridRouteRetrievalExecutor = async (
    retrievalPlan,
    retrievalCompiled,
    retrievalRequestContext,
    retrievalAnchorEntityId,
  ) => {
    const dualLaneExecution = await executeDualLaneSearch(
      retrievalPlan,
      deps,
      dualLaneCompiled.execution.executionTopology === retrievalCompiled.execution.executionTopology
        ? retrievalCompiled
        : assertDualLaneExecutionContract(retrievalCompiled),
      retrievalRequestContext,
      retrievalAnchorEntityId,
    );
    const attempt = buildDualLaneRouteExecutionAttempt(dualLaneExecution);
    attempts.push(attempt);

    return {
      ...dualLaneExecution.generalRetrievalResult,
      candidates: dualLaneExecution.fusedCandidates,
      executionArtifacts: attempt.routeExecutionArtifacts,
    };
  };

  const routeExecution = await executeHybridRouteRankingPipeline(
    plan,
    deps,
    async (candidatePlan) =>
      resolveEntityRouteForPlan(
        candidatePlan,
        {
          entityResolver: deps.entityResolver,
          entityLookup: deps.entityLookup,
          blocker: deps.blocker,
        },
        dualLaneCompiled,
      ),
    dualLaneCompiled,
    requestContext,
    anchorEntityId,
    retrievalExecutor,
  );

  const dualLaneRouteExecution = assertDualLaneRouteExecutionResult(routeExecution);
  const selectedAttempt = attempts.find(
    (attempt) => attempt.attemptId === dualLaneRouteExecution.dualLaneExecutionAttemptId,
  );
  if (selectedAttempt === undefined) {
    throw new Error('Dual-lane execution invariant violated: selected retrieval attempt missing');
  }

  return {
    dualLaneExecution: selectedAttempt.dualLaneExecution,
    routeExecution: dualLaneRouteExecution,
  };
}
