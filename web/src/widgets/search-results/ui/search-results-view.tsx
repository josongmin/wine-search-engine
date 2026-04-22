'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, SearchX, Zap, Brain } from 'lucide-react';
import { useSearch } from '@/features/search-bar';
import { WinePinCard, WineCardSkeleton } from '@/entities/wine';
import { ClarificationCard } from '@/features/clarification';
import { ComparisonTable } from '@/features/comparison';
import { FeedbackButtons } from '@/features/feedback';
import { FloatingSearchBar } from './floating-search-bar';

function MetaBar({ resultCount, decisionStatus, ambiguousLabel, executionMode, queryMs }: {
  resultCount: number;
  decisionStatus: string;
  ambiguousLabel?: string;
  executionMode?: string;
  queryMs?: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pt-4 pb-1">
      <span className="text-sm text-muted-foreground">
        <span className="font-semibold text-foreground">{resultCount}</span>개 결과
      </span>
      {queryMs !== undefined && (
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Zap className="h-3 w-3" />{queryMs}ms
        </span>
      )}
      {decisionStatus === 'ambiguous' && (
        <span className="rounded-full border border-amber-300/60 bg-amber-50 px-2 py-0.5 text-xs text-amber-700 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-300">
          {ambiguousLabel ?? '복수 해석'}
        </span>
      )}
      {executionMode === 'heuristic' && (
        <span className="flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          <Brain className="h-2.5 w-2.5" />휴리스틱
        </span>
      )}
    </div>
  );
}

function ResultsContent() {
  const searchParams = useSearchParams();
  const query = searchParams.get('q') ?? '';
  const { data, isLoading, error } = useSearch(query);

  if (!query) {
    return (
      <div className="flex flex-col items-center gap-4 py-32 text-center">
        <SearchX className="h-14 w-14 text-muted-foreground/25" />
        <p className="text-muted-foreground">검색어를 입력해 주세요.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="masonry px-4 pt-4 pb-36" aria-busy="true">
        {Array.from({ length: 10 }, (_, i) => (
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
        <AlertTriangle className="h-12 w-12 text-red-400/60" />
        <div className="space-y-1">
          <p className="font-medium text-foreground">검색 중 오류가 발생했습니다</p>
          <p className="text-sm text-muted-foreground">잠시 후 다시 시도해 주세요.</p>
          <p className="text-xs text-muted-foreground/60 font-mono">{String(error)}</p>
        </div>
      </div>
    );
  }

  if (!data) return null;

  // T-E9-01: Union-safe discriminant check before accessing response fields.
  // Guard against future response union types (e.g. AgentExecuteResponse)
  // by verifying query_type before accessing search-specific fields.
  if (data.query_type !== 'search') return null;

  const isComparison = data.result_type === 'comparison';
  const ambiguousLabel = data.engine_decision.decision_status === 'ambiguous'
    && (data.clarification?.suggestion_type === 'disambiguation' || data.results.length > 0)
    ? '비슷한 후보'
    : undefined;

  if (isComparison && data.results.length < 2) {
    return (
      <div className="flex flex-col items-center gap-3 py-32 text-center" role="alert">
        <AlertTriangle className="h-12 w-12 text-red-400/60" />
        <div className="space-y-1">
          <p className="font-medium text-foreground">비교 결과 형식이 올바르지 않습니다</p>
          <p className="text-sm text-muted-foreground">비교 응답이 불완전해서 표시를 중단했습니다.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <MetaBar
        resultCount={data.results.length}
        decisionStatus={data.engine_decision.decision_status}
        ambiguousLabel={ambiguousLabel}
        executionMode={data.engine_decision.execution_mode}
        queryMs={data.meta?.query_time_ms}
      />

      {data.clarification && (
        <div className="px-4 pb-3">
          <ClarificationCard payload={data.clarification} />
        </div>
      )}

      {isComparison ? (
        <div className="px-4 pb-36">
          <ComparisonTable items={data.results} />
        </div>
      ) : data.results.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-32 text-center">
          <SearchX className="h-14 w-14 text-muted-foreground/25" />
          <div className="space-y-1">
            <p className="font-medium text-foreground">결과가 없습니다</p>
            <p className="text-sm text-muted-foreground">다른 표현으로 시도해 보세요.</p>
          </div>
        </div>
      ) : (
        <div className="masonry px-4 pb-36" role="list" aria-label="검색 결과">
          {data.results.map((item, i) => (
            <div
              key={item.entity.entity_id}
              className="masonry-item animate-fade-up"
              style={{ animationDelay: `${i * 40}ms` }}
              role="listitem"
            >
              <WinePinCard
                item={item}
                decisionStatus={data.engine_decision.decision_status}
                rank={i + 1}
                query={query}
                actions={
                  <FeedbackButtons query={query} entityId={item.entity.entity_id} />
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
      <Suspense>
        <ResultsContent />
      </Suspense>
      <FloatingSearchBar />
    </div>
  );
}
