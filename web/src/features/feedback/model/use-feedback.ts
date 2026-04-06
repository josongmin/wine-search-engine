'use client';

import { useMutation } from '@tanstack/react-query';
import { api } from '@/shared/api';
import type { FeedbackSignalType } from '@/shared/api';
import { getSessionId } from '@/shared/lib';

export function useFeedback(query: string) {
  return useMutation({
    mutationFn: ({
      entityId,
      signalType,
    }: {
      entityId: string;
      signalType: FeedbackSignalType;
    }) =>
      api.submitFeedback({
        query,
        entity_id: entityId,
        signal_type: signalType,
        session_id: getSessionId(),
      }),
  });
}
