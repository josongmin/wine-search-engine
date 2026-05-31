import type { ExecutionTopology } from '../../domain/query/model/engine-execution-contract.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import type { ResolvedCandidate } from '../../domain/resolver/model/resolved-candidate.js';
import type { SearchExecutionLaneArtifacts, SearchExecutionLaneArtifactRef } from './search-usecase-route-dispatch.js';
import type {
  DualLaneArtifact,
  EntityLaneCandidateArtifact,
} from '../../domain/retrieval/model/dual-lane-artifact.js';

function isDualLaneArtifact(
  artifact: SearchExecutionLaneArtifactRef,
): artifact is DualLaneArtifact {
  return (
    'lanePresence' in artifact &&
    'fusedCandidate' in artifact
  );
}

function findWinnerDualLaneArtifact(
  resolveResult: EntityResolveResult,
  fusedArtifacts: SearchExecutionLaneArtifacts['fused'],
): DualLaneArtifact | undefined {
  const winnerEntityId = resolveResult.topEntity?.entityId;
  if (winnerEntityId === undefined) {
    return undefined;
  }

  return fusedArtifacts.find(
    (artifact): artifact is DualLaneArtifact =>
      isDualLaneArtifact(artifact) && artifact.entityId === winnerEntityId,
  );
}

function isEntityLaneArtifact(
  artifact: SearchExecutionLaneArtifactRef,
): artifact is EntityLaneCandidateArtifact {
  return (
    'identityProvenance' in artifact &&
    'candidate' in artifact &&
    'resolvedCandidate' in artifact
  );
}

function hasWinnerAlignedIdentityResolveCandidate(
  identityResolveResult: EntityResolveResult | null | undefined,
  winnerEntityId: string,
): boolean {
  if (identityResolveResult == null) {
    return false;
  }
  const { candidates } = identityResolveResult;
  if (!Array.isArray(candidates)) {
    return false;
  }
  return candidates.some(
    (candidate: ResolvedCandidate) => candidate.entityId === winnerEntityId,
  );
}

function isWinnerAlignedEntityLaneArtifact(
  artifact: EntityLaneCandidateArtifact | undefined,
  winnerEntityId: string,
): artifact is EntityLaneCandidateArtifact {
  return artifact !== undefined
    && artifact.entityId === winnerEntityId
    && artifact.identityProvenance.entityId === winnerEntityId
    && artifact.candidate.entityId === winnerEntityId
    && artifact.resolvedCandidate.entityId === winnerEntityId;
}

function isWinnerAlignedDualLaneArtifact(
  artifact: DualLaneArtifact | undefined,
  winnerEntityId: string,
): artifact is DualLaneArtifact & { readonly identityProvenance: NonNullable<DualLaneArtifact['identityProvenance']> } {
  if (
    artifact === undefined
    || artifact.entityId !== winnerEntityId
    || artifact.fusedCandidate.entityId !== winnerEntityId
    || artifact.identityProvenance?.entityId !== winnerEntityId
  ) {
    return false;
  }

  if (
    artifact.entityLane !== undefined
    && !isWinnerAlignedEntityLaneArtifact(artifact.entityLane, winnerEntityId)
  ) {
    return false;
  }

  return artifact.generalLane === undefined
    || (
      artifact.generalLane.entityId === winnerEntityId
      && artifact.generalLane.candidate.entityId === winnerEntityId
    );
}

function findWinnerIdentityLaneArtifact(
  resolveResult: EntityResolveResult,
  identityArtifacts: SearchExecutionLaneArtifacts['identity'],
): EntityLaneCandidateArtifact | undefined {
  const winnerEntityId = resolveResult.topEntity?.entityId;
  if (winnerEntityId === undefined) {
    return undefined;
  }

  return identityArtifacts.find(
    (artifact): artifact is EntityLaneCandidateArtifact =>
      isEntityLaneArtifact(artifact) && artifact.entityId === winnerEntityId,
  );
}

export function resolveWinnerAlignedDualLaneArtifact(params: {
  readonly executionTopology: ExecutionTopology;
  readonly identityResolveResult: EntityResolveResult | null;
  readonly resolveResult: EntityResolveResult;
  readonly fusedArtifacts: SearchExecutionLaneArtifacts['fused'];
}): DualLaneArtifact | undefined {
  if (
    params.executionTopology !== 'dual_lane'
    || params.identityResolveResult === null
  ) {
    return undefined;
  }

  const winnerDualLaneArtifact = findWinnerDualLaneArtifact(
    params.resolveResult,
    params.fusedArtifacts,
  );
  const winnerEntityId = params.resolveResult.topEntity?.entityId;
  if (
    winnerEntityId === undefined
    || !hasWinnerAlignedIdentityResolveCandidate(params.identityResolveResult, winnerEntityId)
    || !isWinnerAlignedDualLaneArtifact(winnerDualLaneArtifact, winnerEntityId)
  ) {
    return undefined;
  }

  return winnerDualLaneArtifact;
}

export function resolveWinnerAlignedIdentityArtifact(params: {
  readonly executionTopology: ExecutionTopology;
  readonly identityResolveResult: EntityResolveResult | null;
  readonly resolveResult: EntityResolveResult;
  readonly identityArtifacts: SearchExecutionLaneArtifacts['identity'];
}): EntityLaneCandidateArtifact | undefined {
  if (params.identityResolveResult === null) {
    return undefined;
  }

  const winnerIdentityArtifact = findWinnerIdentityLaneArtifact(
    params.resolveResult,
    params.identityArtifacts,
  );
  const winnerEntityId = params.resolveResult.topEntity?.entityId;
  if (
    winnerEntityId === undefined
    || !hasWinnerAlignedIdentityResolveCandidate(params.identityResolveResult, winnerEntityId)
    || !isWinnerAlignedEntityLaneArtifact(winnerIdentityArtifact, winnerEntityId)
  ) {
    return undefined;
  }

  return winnerIdentityArtifact;
}
