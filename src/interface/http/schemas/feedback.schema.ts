import { z } from 'zod';
import { QUERY_CLASSES } from '../../../domain/shared/types/query-class.js';
import {
  MAX_ERROR_ENVELOPE_MESSAGE_CHARS,
  MAX_FEEDBACK_ENTITY_REF_CHARS,
  MAX_SESSION_ENTITY_ID_CHARS,
} from '../constants.js';

const queryClassValues = QUERY_CLASSES as unknown as readonly [string, ...string[]];

export const PostFeedbackRequestSchema = z.object({
  query: z.string().min(1).max(MAX_ERROR_ENVELOPE_MESSAGE_CHARS),
  entity_id: z.string().min(1).max(MAX_FEEDBACK_ENTITY_REF_CHARS),
  signal_type: z.enum(['click', 'purchase', 'dismiss']),
  session_id: z.string().min(1).max(MAX_SESSION_ENTITY_ID_CHARS),
  query_class: z.enum(queryClassValues).optional(),
}).strict();

export const PostFeedbackResponseSchema = z.object({
  signal_id: z.string().min(1),
  accepted: z.literal(true),
}).strict();
