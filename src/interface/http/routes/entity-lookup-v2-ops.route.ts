/**
 * `/v2/entity-lookup/ops/*` — operator curation plane (T-ELV2-07).
 *
 * Reads (alias-audit, coverage-health, proposals list) require the X-Debug-Key
 * trusted gate (`request.debugRequest`). Writes (submit / review / publish)
 * require the SEPARATE X-Ops-Write-Key gate (`request.opsWriteAuthorized`) so a
 * leaked read key cannot drive staged runtime changes (RFC §5). Both gates
 * reject BEFORE parsing/executing anything.
 *
 * All routes are POST-with-body, matching the sibling ops/inspect read contract.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CurationOpsRouteDeps } from './route-deps.js';
import { parseContractBody, sendRouteContractResponse } from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import {
  EntityLookupV2OpsAliasAuditRouteContract,
  EntityLookupV2OpsCoverageHealthRouteContract,
  EntityLookupV2OpsListProposalsRouteContract,
  EntityLookupV2OpsPublishProposalRouteContract,
  EntityLookupV2OpsReviewProposalRouteContract,
  EntityLookupV2OpsSubmitProposalRouteContract,
} from './route-contracts.js';
import { HTTP_STATUS_OK } from '../constants.js';
import { DomainError } from '../../../domain/shared/error/domain-error.js';
import { POLICY_BLOCKED_CODE } from '../../../domain/shared/error/policy-blocked.js';
import type { Proposal } from '../../../domain/curation/model/proposal.js';
import type { AliasAuditView, CurationHealth, ProposalListFilter } from '../../../domain/curation/port/curation-store.port.js';
import type { ProposalWire } from '../schemas/entity-lookup-v2-ops.schema.js';

function requireReadGate(request: FastifyRequest): void {
  if (!request.debugRequest) {
    throw new DomainError(POLICY_BLOCKED_CODE, 'entity-lookup ops plane requires a trusted debug key');
  }
}

function requireWriteGate(request: FastifyRequest): void {
  if (!request.opsWriteAuthorized) {
    throw new DomainError(POLICY_BLOCKED_CODE, 'entity-lookup ops write plane requires an operator write key');
  }
}

/** Map a domain Proposal to its snake_case wire shape, omitting absent optionals. */
function toProposalWire(p: Proposal): ProposalWire {
  const base = {
    proposal_id: p.proposalId,
    status: p.status,
    evidence: p.evidence,
    created_at: p.createdAt.toISOString(),
    updated_at: p.updatedAt.toISOString(),
    ...(p.proposedBy !== undefined ? { proposed_by: p.proposedBy } : {}),
    ...(p.reviewedBy !== undefined ? { reviewed_by: p.reviewedBy } : {}),
    ...(p.reviewedAt !== undefined ? { reviewed_at: p.reviewedAt.toISOString() } : {}),
    ...(p.decisionReason !== undefined ? { decision_reason: p.decisionReason } : {}),
    ...(p.publishedAt !== undefined ? { published_at: p.publishedAt.toISOString() } : {}),
    ...(p.targetSnapshotVersion !== undefined
      ? { target_snapshot_version: p.targetSnapshotVersion }
      : {}),
  };
  switch (p.kind) {
    case 'alias':
      return {
        ...base,
        kind: 'alias',
        surface_form: p.surfaceForm,
        target_entity_id: p.targetEntityId,
        proposed_type: p.proposedType,
        confidence: p.confidence,
      };
    case 'ambiguity':
      return {
        ...base,
        kind: 'ambiguity',
        normalized_form: p.normalizedForm,
        member_entity_ids: [...p.memberEntityIds],
      };
    case 'suppression':
      return {
        ...base,
        kind: 'suppression',
        surface_form: p.surfaceForm,
        reason: p.reason,
        ...(p.targetEntityId !== undefined ? { target_entity_id: p.targetEntityId } : {}),
      };
  }
}

function toAliasAuditWire(view: AliasAuditView): {
  entity_id: string;
  aliases: { alias_id: string; surface_form: string; alias_type: string; source: string }[];
  related_proposals: ProposalWire[];
} {
  return {
    entity_id: view.entityId,
    aliases: view.aliases.map((a) => ({
      alias_id: a.aliasId,
      surface_form: a.surfaceForm,
      alias_type: a.aliasType,
      source: a.source,
    })),
    related_proposals: view.relatedProposals.map(toProposalWire),
  };
}

function toHealthWire(h: CurationHealth): {
  queue_by_status: CurationHealth['queueByStatus'];
  queue_by_kind: CurationHealth['queueByKind'];
  total_proposals: number;
} {
  return {
    queue_by_status: h.queueByStatus,
    queue_by_kind: h.queueByKind,
    total_proposals: h.totalProposals,
  };
}

export function registerEntityLookupV2OpsCurationRoutes(
  app: FastifyInstance,
  deps: CurationOpsRouteDeps,
): void {
  // --- reads (X-Debug-Key) -------------------------------------------------

  registerContractRoute(app, {
    method: 'POST',
    url: '/v2/entity-lookup/ops/alias-audit',
    contract: EntityLookupV2OpsAliasAuditRouteContract,
    handler: async (request, reply) => {
      requireReadGate(request);
      const body = parseContractBody(request, EntityLookupV2OpsAliasAuditRouteContract);
      const view = await deps.curationUseCase.aliasAudit(body.entity_id);
      sendRouteContractResponse(
        request, reply, EntityLookupV2OpsAliasAuditRouteContract, HTTP_STATUS_OK, toAliasAuditWire(view),
      );
    },
  });

  registerContractRoute(app, {
    method: 'POST',
    url: '/v2/entity-lookup/ops/coverage-health',
    contract: EntityLookupV2OpsCoverageHealthRouteContract,
    handler: async (request, reply) => {
      requireReadGate(request);
      parseContractBody(request, EntityLookupV2OpsCoverageHealthRouteContract);
      const health = await deps.curationUseCase.curationHealth();
      sendRouteContractResponse(
        request, reply, EntityLookupV2OpsCoverageHealthRouteContract, HTTP_STATUS_OK, toHealthWire(health),
      );
    },
  });

  registerContractRoute(app, {
    method: 'POST',
    url: '/v2/entity-lookup/ops/proposals',
    contract: EntityLookupV2OpsListProposalsRouteContract,
    handler: async (request, reply) => {
      requireReadGate(request);
      const body = parseContractBody(request, EntityLookupV2OpsListProposalsRouteContract);
      const filter: ProposalListFilter = {
        limit: body.limit,
        ...(body.kind !== undefined ? { kind: body.kind } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      };
      const proposals = await deps.curationUseCase.listProposals(filter);
      sendRouteContractResponse(
        request, reply, EntityLookupV2OpsListProposalsRouteContract, HTTP_STATUS_OK,
        { proposals: proposals.map(toProposalWire) },
      );
    },
  });

  // --- writes (X-Ops-Write-Key) -------------------------------------------

  registerContractRoute(app, {
    method: 'POST',
    url: '/v2/entity-lookup/ops/proposals/submit',
    contract: EntityLookupV2OpsSubmitProposalRouteContract,
    handler: async (request, reply) => {
      requireWriteGate(request);
      const body = parseContractBody(request, EntityLookupV2OpsSubmitProposalRouteContract);
      let proposal: Proposal;
      switch (body.kind) {
        case 'alias':
          proposal = await deps.curationUseCase.submitAliasProposal({
            surfaceForm: body.surface_form,
            targetEntityId: body.target_entity_id,
            proposedType: body.proposed_type,
            confidence: body.confidence,
            evidence: body.evidence,
            ...(body.proposed_by !== undefined ? { proposedBy: body.proposed_by } : {}),
          });
          break;
        case 'ambiguity':
          proposal = await deps.curationUseCase.submitAmbiguityProposal({
            normalizedForm: body.normalized_form,
            memberEntityIds: body.member_entity_ids,
            evidence: body.evidence,
            ...(body.proposed_by !== undefined ? { proposedBy: body.proposed_by } : {}),
          });
          break;
        case 'suppression':
          proposal = await deps.curationUseCase.submitSuppressionProposal({
            surfaceForm: body.surface_form,
            reason: body.reason,
            evidence: body.evidence,
            ...(body.target_entity_id !== undefined ? { targetEntityId: body.target_entity_id } : {}),
            ...(body.proposed_by !== undefined ? { proposedBy: body.proposed_by } : {}),
          });
          break;
      }
      sendRouteContractResponse(
        request, reply, EntityLookupV2OpsSubmitProposalRouteContract, HTTP_STATUS_OK,
        { proposal: toProposalWire(proposal) },
      );
    },
  });

  registerContractRoute(app, {
    method: 'POST',
    url: '/v2/entity-lookup/ops/proposals/review',
    contract: EntityLookupV2OpsReviewProposalRouteContract,
    handler: async (request, reply) => {
      requireWriteGate(request);
      const body = parseContractBody(request, EntityLookupV2OpsReviewProposalRouteContract);
      const proposal = await deps.curationUseCase.reviewProposal({
        kind: body.kind,
        proposalId: body.proposal_id,
        decision: body.decision,
        reviewedBy: body.reviewed_by,
        decisionReason: body.decision_reason,
      });
      sendRouteContractResponse(
        request, reply, EntityLookupV2OpsReviewProposalRouteContract, HTTP_STATUS_OK,
        { proposal: toProposalWire(proposal) },
      );
    },
  });

  registerContractRoute(app, {
    method: 'POST',
    url: '/v2/entity-lookup/ops/proposals/publish',
    contract: EntityLookupV2OpsPublishProposalRouteContract,
    handler: async (request, reply) => {
      requireWriteGate(request);
      const body = parseContractBody(request, EntityLookupV2OpsPublishProposalRouteContract);
      const proposal = await deps.curationUseCase.publishProposal({
        kind: body.kind,
        proposalId: body.proposal_id,
        reviewedBy: body.reviewed_by,
        ...(body.target_snapshot_version !== undefined
          ? { targetSnapshotVersion: body.target_snapshot_version }
          : {}),
      });
      sendRouteContractResponse(
        request, reply, EntityLookupV2OpsPublishProposalRouteContract, HTTP_STATUS_OK,
        { proposal: toProposalWire(proposal) },
      );
    },
  });
}
