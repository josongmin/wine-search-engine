import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { FeedbackRouteDeps } from './route-deps.js';
import {
  parseContractBody,
  sendRouteContractResponse,
} from './contract-response.js';
import { registerContractRoute } from './register-contract-route.js';
import { FeedbackSubmitRouteContract } from './route-contracts.js';
import { ErrorResponseSchema } from '../schemas/search-response.schema.js';
import type { FeedbackSignal, FeedbackType } from '../../../domain/learning/model/feedback-signal.js';
import { isQueryClass, type QueryClass } from '../../../domain/shared/types/query-class.js';
import { createEntityId } from '../../../domain/shared/types/index.js';
import type { DecisionSnapshot } from '../../../domain/shared/types/decision-snapshot.js';
import { getRequestId } from '../request-id.js';
import { buildDecisionSnapshotFromRuntimeVersions } from '../../../application/search/search-usecase-decision-snapshot.js';
import {
  HTTP_STATUS_CREATED,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_SERVICE_UNAVAILABLE,
} from '../constants.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract a client-supplied idempotency key from the Idempotency-Key header.
 * Validates as UUID-shaped to defend against header injection / log poisoning;
 * any other value is rejected (returns null) so the route falls back to a
 * server-generated UUID.
 */
function extractIdempotencyKey(request: FastifyRequest): string | null {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return UUID_RE.test(trimmed) ? trimmed : null;
}

function buildFeedbackDecisionSnapshot(): DecisionSnapshot {
  return {
    ...buildDecisionSnapshotFromRuntimeVersions(),
    policy_rule_version: 'http-feedback-ingest-v1',
    planner_version: 'unknown',
    snapshot_id: 'default:unknown:http-feedback-ingest-v1::',
  };
}

/**
 * Maps HTTP feedback signal types to their domain FeedbackType counterparts.
 * Exported so contract-drift tests can verify schema↔domain parity directly
 * (importing the actual mapper, not a hardcoded copy).
 */
export function mapSignal(
  signalType: 'click' | 'purchase' | 'dismiss',
): { readonly type: FeedbackType; readonly isPositive: boolean } {
  if (signalType === 'click') {
    return { type: 'click', isPositive: true };
  }
  if (signalType === 'purchase') {
    return { type: 'purchase', isPositive: true };
  }
  return { type: 'explicit_feedback', isPositive: false };
}

/**
 * POST /v1/feedback — ingest user feedback for the learning loop (RFC-010).
 */
export function registerFeedbackRoute(
  app: FastifyInstance,
  deps: FeedbackRouteDeps,
): void {
  registerContractRoute(app, {
    method: 'POST',
    url: '/v1/feedback',
    contract: FeedbackSubmitRouteContract,
    handler: async (request, reply) => {
      const requestId = getRequestId(request);

      if (!deps.feedbackIngestEnabled || deps.feedbackStore === null) {
        sendRouteContractResponse(
          request,
          reply,
          FeedbackSubmitRouteContract,
          HTTP_STATUS_SERVICE_UNAVAILABLE,
          ErrorResponseSchema.parse({
            error: {
              request_id: requestId,
              code: 'FEEDBACK_UNAVAILABLE',
              message: 'Feedback ingestion is disabled or Postgres is not configured.',
              failure_reason: null,
              retryable: true,
            },
          }),
        );
        return;
      }

      const body = parseContractBody(request, FeedbackSubmitRouteContract);
      const { type, isPositive } = mapSignal(body.signal_type);
      const queryClass: QueryClass =
        body.query_class !== undefined && isQueryClass(body.query_class)
          ? body.query_class
          : 'unknown';

      const signal: FeedbackSignal = {
        // Honor an optional client-supplied Idempotency-Key header so that
        // network-retried submissions resolve to the same row, making the
        // pg `ON CONFLICT (signal_id) DO NOTHING` clause load-bearing.
        // Validate as UUID-shaped to prevent header injection / log poisoning.
        signalId: extractIdempotencyKey(request) ?? randomUUID(),
        type,
        query: body.query,
        queryClass,
        entityId: createEntityId(body.entity_id),
        isPositive,
        timestamp: new Date(),
        sessionId: body.session_id,
        decisionSnapshot: buildFeedbackDecisionSnapshot(),
      };

      try {
        await deps.feedbackStore.saveFeedback(signal);
      } catch (err: unknown) {
        // Redact the err object: pg driver errors can include parameterized
        // SQL with values interpolated, leaking the user's query and entity_id
        // into structured logs.
        const errCode = (err as { code?: string } | undefined)?.code;
        const errName = err instanceof Error ? err.name : 'Unknown';
        request.log.error({ errCode, errName, requestId }, 'feedback_save_failed');
        sendRouteContractResponse(
          request,
          reply,
          FeedbackSubmitRouteContract,
          HTTP_STATUS_INTERNAL_SERVER_ERROR,
          ErrorResponseSchema.parse({
            error: {
              request_id: requestId,
              code: 'INTERNAL_ERROR',
              message: 'Failed to persist feedback signal.',
              failure_reason: null,
              retryable: true,
            },
          }),
        );
        return;
      }

      sendRouteContractResponse(request, reply, FeedbackSubmitRouteContract, HTTP_STATUS_CREATED, {
        signal_id: signal.signalId,
        accepted: true,
      });
    },
  });
}
