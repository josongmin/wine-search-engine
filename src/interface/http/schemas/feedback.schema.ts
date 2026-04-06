import { z } from 'zod';
import { QUERY_CLASSES } from '../../../domain/shared/types/query-class.js';

const queryClassValues = QUERY_CLASSES as unknown as readonly [string, ...string[]];

export const PostFeedbackRequestSchema = z.object({
  query: z.string().min(1).max(4096),
  entity_id: z.string().min(1).max(512),
  signal_type: z.enum(['click', 'purchase', 'dismiss']),
  session_id: z.string().min(1).max(256),
  query_class: z.enum(queryClassValues).optional(),
});

export const PostFeedbackResponseSchema = z.object({
  signal_id: z.string(),
  accepted: z.literal(true),
});
