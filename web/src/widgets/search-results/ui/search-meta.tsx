import { Badge } from '@/shared/ui';
import { ms } from '@/shared/lib';
import type { EngineDecision, ResponseMeta, ResultType } from '@/shared/api';

interface SearchMetaProps {
  decision: EngineDecision;
  meta: ResponseMeta;
  resultType?: ResultType;
  resultCount: number;
}

const statusLabel: Record<string, string> = {
  resolved: '확정',
  ambiguous: '모호',
  failed: '실패',
};

const statusVariant: Record<string, 'success' | 'warning' | 'danger'> = {
  resolved: 'success',
  ambiguous: 'warning',
  failed: 'danger',
};

export function SearchMeta({
  decision,
  meta,
  resultType,
  resultCount,
}: SearchMetaProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
      <Badge variant={statusVariant[decision.decision_status] ?? 'default'}>
        {statusLabel[decision.decision_status] ?? decision.decision_status}
      </Badge>
      <span>{decision.route}</span>
      {resultType && <span>· {resultType.replace(/_/g, ' ')}</span>}
      <span>· {resultCount}건</span>
      <span>· {ms(meta.query_time_ms)}</span>
      {decision.execution_mode && decision.execution_mode !== 'authoritative' && (
        <Badge variant="warning">{decision.execution_mode}</Badge>
      )}
    </div>
  );
}
