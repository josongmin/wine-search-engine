import { Badge } from '@/shared/ui';
import { pct } from '@/shared/lib';

interface DecisionBadgeProps {
  status?: string;
  score: number;
}

const statusVariant: Record<string, 'success' | 'warning' | 'danger'> = {
  resolved: 'success',
  ambiguous: 'warning',
  failed: 'danger',
};

export function DecisionBadge({ status, score }: DecisionBadgeProps) {
  const variant = statusVariant[status ?? ''] ?? 'default';
  return (
    <Badge variant={variant} className="tabular-nums">
      {pct(score)}
    </Badge>
  );
}
