'use client';

import { useSearchParams } from 'next/navigation';
import { AlertTriangle } from 'lucide-react';
import { useSearch } from '@/features/search-bar';
import { WineCard, WineCardSkeleton } from '@/entities/wine';
import { ClarificationCard } from '@/features/clarification';
import { ComparisonTable } from '@/features/comparison';
import { FeedbackButtons } from '@/features/feedback';
import { SearchMeta } from './search-meta';

export function SearchResultsView() {
  const searchParams = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const { data, isLoading, error } = useSearch(query);

  if (!query) {
    return (
      <p className="text-center text-neutral-500 py-16">
        검색어를 입력해 주세요.
      </p>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="검색 중">
        {Array.from({ length: 3 }, (_, i) => (
          <WineCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center" role="alert">
        <AlertTriangle className="h-10 w-10 text-red-400" aria-hidden="true" />
        <p className="text-sm text-red-600">
          검색 중 오류가 발생했습니다. 다시 시도해 주세요.
        </p>
        <p className="text-xs text-neutral-400">{String(error)}</p>
      </div>
    );
  }

  if (!data) return null;

  const isComparison = data.result_type === 'comparison';

  return (
    <div className="space-y-4">
      <SearchMeta
        decision={data.engine_decision}
        meta={data.meta}
        resultType={data.result_type}
        resultCount={data.results.length}
      />

      {/* Clarification */}
      {data.clarification && (
        <ClarificationCard payload={data.clarification} />
      )}

      {/* Comparison mode */}
      {isComparison && data.results.length >= 2 ? (
        <ComparisonTable items={data.results} />
      ) : (
        /* Standard result list */
        <div className="space-y-4" role="list" aria-label="검색 결과">
          {data.results.map((item, i) => (
            <div key={item.entity.entity_id} role="listitem">
              <WineCard
                item={item}
                decisionStatus={data.engine_decision.decision_status}
                rank={i + 1}
                actions={
                  <FeedbackButtons
                    query={query}
                    entityId={item.entity.entity_id}
                  />
                }
              />
            </div>
          ))}
        </div>
      )}

      {data.results.length === 0 && !data.clarification && (
        <div className="py-16 text-center">
          <p className="text-sm text-neutral-500">
            검색 결과가 없습니다. 다른 표현으로 시도해 보세요.
          </p>
        </div>
      )}
    </div>
  );
}
