import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { FeedbackRouteDeps } from './route-deps.js';
import {
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

const DEFAULT_DECISION_SNAPSHOT: DecisionSnapshot = {
  ...buildDecisionSnapshotFromRuntimeVersions(),
  policy_rule_version: 'http-feedback-ingest-v1',
  planner_version: 'unknown',
  snapshot_id: 'default:unknown:http-feedback-ingest-v1::',
};

function mapSignal(
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
          503,
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

      const parsed = FeedbackSubmitRouteContract.body.safeParse(request.body);
      if (!parsed.success) {
        sendRouteContractResponse(
          request,
          reply,
          FeedbackSubmitRouteContract,
          400,
          ErrorResponseSchema.parse({
            error: {
              request_id: requestId,
              code: 'VALIDATION_ERROR',
              message: 'Invalid feedback request body.',
              failure_reason: parsed.error.message,
              retryable: false,
            },
          }),
        );
        return;
      }

      const body = parsed.data;
      const { type, isPositive } = mapSignal(body.signal_type);
      const queryClass: QueryClass =
        body.query_class !== undefined && isQueryClass(body.query_class)
          ? body.query_class
          : 'unknown';

      const signal: FeedbackSignal = {
        signalId: randomUUID(),
        type,
        query: body.query,
        queryClass,
        entityId: createEntityId(body.entity_id),
        isPositive,
        timestamp: new Date(),
        sessionId: body.session_id,
        decisionSnapshot: DEFAULT_DECISION_SNAPSHOT,
      };

      await deps.feedbackStore.saveFeedback(signal);

      sendRouteContractResponse(request, reply, FeedbackSubmitRouteContract, 201, {
        signal_id: signal.signalId,
        accepted: true,
      });
    },
  });
}
