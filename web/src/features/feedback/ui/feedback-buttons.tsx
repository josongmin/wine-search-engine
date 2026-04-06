'use client';

import { ThumbsUp, ThumbsDown } from 'lucide-react';
import { IconButton } from '@/shared/ui';
import { useFeedback } from '@/features/feedback';

interface FeedbackButtonsProps {
  query: string;
  entityId: string;
}

export function FeedbackButtons({ query, entityId }: FeedbackButtonsProps) {
  const { mutate, isPending, isError, variables } = useFeedback(query);

  const sent = variables?.signalType;

  return (
    <div className="flex items-center gap-1" role="group" aria-label="검색 결과 피드백">
      <IconButton
        variant="positive"
        active={sent === 'click'}
        disabled={isPending || sent !== undefined}
        onClick={() => mutate({ entityId, signalType: 'click' })}
        aria-label="도움이 됐어요"
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </IconButton>
      <IconButton
        variant="negative"
        active={sent === 'dismiss'}
        disabled={isPending || sent !== undefined}
        onClick={() => mutate({ entityId, signalType: 'dismiss' })}
        aria-label="관련 없어요"
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </IconButton>
      {isError && (
        <span className="text-xs text-red-500" role="alert">전송 실패</span>
      )}
    </div>
  );
}
