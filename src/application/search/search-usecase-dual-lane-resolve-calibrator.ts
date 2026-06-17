import type { ExecutionRetrievalMode } from '../../domain/query/model/engine-execution-contract.js';
import type { RankedResult } from '../../domain/ranking/model/ranked-result.js';
import type { EntityResolveResult } from '../../domain/resolver/model/resolve-result.js';
import { DEFAULT_ALPHA, computeConformalSetSize } from '../../domain/resolver/service/resolver.js';
import { clamp01 } from '../../domain/shared/utils/clamp.js';
import type {
  DualLaneArtifact,
  EntityLaneCandidateArtifact,
  GeneralLaneCandidateArtifact,
} from '../../domain/retrieval/model/dual-lane-artifact.js';
import type { SearchExecutionLaneArtifacts } from './search-usecase-route-dispatch.js';

interface DualLaneResolveCalibrationInput {
  readonly rankedResults: readonly RankedResult[];
  readonly fusedResolveResult: EntityResolveResult;
  readonly identityResolveResult: EntityResolveResult;
  readonly effectiveRetrievalMode?: ExecutionRetrievalMode | undefined;
  readonly laneArtifacts: SearchExecutionLaneArtifacts<
    EntityLaneCandidateArtifact,
    GeneralLaneCandidateArtifact,
    DualLaneArtifact
  >;
}

const NON_IDENTITY_CALIBRATION_MODES = new Set<ExecutionRetrievalMode>([
  'recommendation',
  'compare_candidates',
  'similar_items',
  'producer_browse',
  'region_browse',
]);

function shouldBypassDualLaneCalibration(
  effectiveRetrievalMode: ExecutionRetrievalMode | undefined,
): boolean {
  return effectiveRetrievalMode !== undefined && NON_IDENTITY_CALIBRATION_MODES.has(effectiveRetrievalMode);
}

function findAlignedIdentityArtifact(
  winnerEntityId: string,
  laneArtifacts: SearchExecutionLaneArtifacts<
    EntityLaneCandidateArtifact,
    GeneralLaneCandidateArtifact,
    DualLaneArtifact
  >,
): EntityLaneCandidateArtifact | undefined {
  return laneArtifacts.identity.find(
    (artifact) =>
      artifact.entityId === winnerEntityId
      && artifact.identityProvenance.entityId === winnerEntityId
      && artifact.resolvedCandidate.entityId === winnerEntityId
      && artifact.candidate.entityId === winnerEntityId,
  );
}

export class DualLaneResolveCalibrator {
  calibrate(input: DualLaneResolveCalibrationInput): EntityResolveResult {
    if (shouldBypassDualLaneCalibration(input.effectiveRetrievalMode)) {
      return input.fusedResolveResult;
    }

    const winnerEntityId = input.fusedResolveResult.topEntity?.entityId;
    if (winnerEntityId === undefined) {
      return input.fusedResolveResult;
    }

    const corroboratedWinnerArtifact = input.laneArtifacts.fused.find(
      (artifact) =>
        artifact.entityId === winnerEntityId &&
        artifact.lanePresence === 'corroborated' &&
        artifact.identityProvenance !== undefined,
    );
    const alignedIdentityArtifact = findAlignedIdentityArtifact(
      winnerEntityId,
      input.laneArtifacts,
    );
    const calibratedIdentityArtifact =
      corroboratedWinnerArtifact?.identityProvenance
      ?? alignedIdentityArtifact?.identityProvenance;
    if (calibratedIdentityArtifact === undefined || calibratedIdentityArtifact.exactnessTier === 'none') {
      return input.fusedResolveResult;
    }

    const corroboratedIdentityCalibration =
      corroboratedWinnerArtifact?.identityProvenance !== undefined;
    if (
      !corroboratedIdentityCalibration
      && (
        calibratedIdentityArtifact.exactnessTier === 'alias_fuzzy'
        || calibratedIdentityArtifact.exactnessTier === 'alias_phonetic'
      )
    ) {
      return input.fusedResolveResult;
    }

    const corroboratedIdentityCandidate = input.identityResolveResult.candidates.find(
      (candidate) => candidate.entityId === winnerEntityId,
    );
    if (corroboratedIdentityCandidate === undefined) {
      return input.fusedResolveResult;
    }

    const calibratedWinnerScore = clamp01(corroboratedIdentityCandidate.calibratedScore);
    const currentTop1 = clamp01(input.fusedResolveResult.decisionTrace.top1CalibratedScore);
    if (calibratedWinnerScore === currentTop1) {
      return input.fusedResolveResult;
    }

    const top2Score = input.fusedResolveResult.decisionTrace.top2CalibratedScore;
    const calibratedGap = top2Score !== undefined
      ? Math.max(0, calibratedWinnerScore - clamp01(top2Score))
      : undefined;
    const outcomeReasonCodes = input.fusedResolveResult.decisionTrace.outcomeReasonCodes.includes(
      'DUAL_LANE_CORROBORATED_IDENTITY_CALIBRATED',
    )
      ? input.fusedResolveResult.decisionTrace.outcomeReasonCodes
      : [
        ...input.fusedResolveResult.decisionTrace.outcomeReasonCodes,
          'DUAL_LANE_CORROBORATED_IDENTITY_CALIBRATED',
        ];
    const calibratedCandidates = input.fusedResolveResult.candidates.map((candidate) =>
      candidate.entityId === winnerEntityId
        ? {
            ...candidate,
            calibratedScore: calibratedWinnerScore,
          }
        : candidate,
    );

    return {
      ...input.fusedResolveResult,
      candidates: calibratedCandidates,
      decisionConfidenceC: calibratedWinnerScore,
      ...(input.fusedResolveResult.topEntity !== undefined
        ? {
            topEntity: {
              ...input.fusedResolveResult.topEntity,
              calibratedScore: calibratedWinnerScore,
            },
          }
        : {}),
      decisionTrace: {
        ...input.fusedResolveResult.decisionTrace,
        top1CalibratedScore: calibratedWinnerScore,
        calibratedGap,
        decisionConfidenceC: calibratedWinnerScore,
        outcomeReasonCodes,
      },
      conformalSetSize: computeConformalSetSize(
        calibratedWinnerScore,
        DEFAULT_ALPHA,
        Math.max(1, input.rankedResults.length),
      ),
    };
  }
}
