'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, SearchX } from 'lucide-react';
import { useSearch } from '@/features/search-bar';
import { WinePinCard, WineCardSkeleton } from '@/entities/wine';
import { ClarificationCard } from '@/features/clarification';
import { ComparisonTable } from '@/features/comparison';
import { FeedbackButtons } from '@/features/feedback';
import { FloatingSearchBar } from './floating-search-bar';

function ResultsGrid() {
  const searchParams = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const { data, isLoading, error } = useSearch(query);

  if (!query) {
    return (
      <div className="flex flex-col items-center gap-3 py-32 text-center">
        <SearchX className="h-12 w-12 text-muted-foreground/40" />
        <p className="text-muted-foreground">검색어를 입력해 주세요.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="masonry px-4 pt-4" aria-busy="true" aria-label="검색 중">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="masonry-item">
            <WineCardSkeleton compact />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center gap-3 py-32 text-center" role="alert">
        <AlertTriangle className="h-10 w-10 text-red-400" aria-hidden="true" />
        <p className="text-sm text-red-600">검색 중 오류가 발생했습니다. 다시 시도해 주세요.</p>
        <p className="text-xs text-muted-foreground">{String(error)}</p>
      </div>
    );
  }

  if (!data) return null;

  const isComparison = data.result_type === 'comparison';

  return (
    <div className="animate-fade-in">
      {/* Meta bar */}
      <div className="flex items-center gap-2 px-4 pt-4 pb-2">
        <span className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{data.results.length}</span>개 결과
        </span>
        {data.engine_decision.decision_status === 'ambiguous' && (
          <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300">
            복수 해석
          </span>
        )}
        {data.engine_decision.execution_mode === 'heuristic' && (
          <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            휴리스틱
          </span>
        )}
      </div>

      {/* Clarification */}
      {data.clarification && (
        <div className="px-4 pb-3">
          <ClarificationCard payload={data.clarification} />
        </div>
      )}

      {/* Comparison */}
      {isComparison && data.results.length >= 2 ? (
        <div className="px-4 pb-36">
          <ComparisonTable items={data.results} />
        </div>
      ) : data.results.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-32 text-center">
          <SearchX className="h-12 w-12 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            검색 결과가 없습니다. 다른 표현으로 시도해 보세요.
          </p>
        </div>
      ) : (
        /* Pinterest masonry grid */
        <div className="masonry px-4 pb-36" role="list" aria-label="검색 결과">
          {data.results.map((item, i) => (
            <div key={item.entity.entity_id} className="masonry-item" role="listitem">
              <WinePinCard
                item={item}
                decisionStatus={data.engine_decision.decision_status}
                rank={i + 1}
                query={query}
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
    </div>
  );
}

export function SearchResultsView() {
  return (
    <div className="min-h-screen">
      <ResultsGrid />
      <FloatingSearchBar />
    </div>
  );
}
