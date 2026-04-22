'use client';

import { useRouter } from 'next/navigation';
import { HelpCircle } from 'lucide-react';
import { Card, CardContent } from '@/shared/ui';
import { wineDetailUrl } from '@/shared/lib';
import type { ClarificationPayload } from '@/shared/api';

interface ClarificationCardProps {
  payload: ClarificationPayload;
}

function getClarificationCopy(payload: ClarificationPayload): {
  readonly title: string;
  readonly description: string;
} {
  if (payload.suggestion_type === 'disambiguation' && payload.candidates.length > 0) {
    return {
      title: '비슷한 검색 결과가 있어요',
      description: '입력하신 표현과 가까운 후보입니다. 아래에서 바로 선택할 수 있습니다.',
    };
  }

  return {
    title: '어떤 걸 찾으시나요?',
    description: payload.reason,
  };
}

export function ClarificationCard({ payload }: ClarificationCardProps) {
  const router = useRouter();
  const copy = getClarificationCopy(payload);

  return (
    <Card className="border-amber-200 bg-amber-50/50">
      <CardContent className="pt-5">
        <div className="flex items-start gap-3">
          <HelpCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" aria-hidden="true" />
          <div className="space-y-3 flex-1">
            <p className="text-sm font-medium text-amber-800">
              {copy.title}
            </p>
            <p className="text-sm text-amber-700">{copy.description}</p>
            <div className="space-y-2" role="listbox" aria-label="후보 선택">
              {payload.candidates.map((candidate) => (
                <button
                  key={candidate.entity_id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => router.push(wineDetailUrl(candidate.entity_id))}
                  className="w-full rounded-lg border border-amber-200 bg-white p-3 text-left transition-all hover:border-amber-300 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 focus-visible:ring-offset-2 cursor-pointer"
                >
                  <p className="text-sm font-medium text-neutral-900">
                    {candidate.label}
                  </p>
                  {candidate.distinguishing_features.length > 0 && (
                    <p className="mt-0.5 text-xs text-neutral-500">
                      {candidate.distinguishing_features.join(' · ')}
                    </p>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
