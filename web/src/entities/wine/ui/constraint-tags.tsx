import { Badge } from '@/shared/ui';
import type { ConstraintEvaluation } from '@/shared/api';

interface ConstraintTagsProps {
  constraints: ConstraintEvaluation;
}

export function ConstraintTags({ constraints }: ConstraintTagsProps) {
  return (
    <div className="flex flex-wrap gap-1">
      {constraints.matched.map((c) => (
        <Badge key={c} variant="success">
          ✓ {c}
        </Badge>
      ))}
      {constraints.unmet.map((c) => (
        <Badge key={c} variant="danger">
          ✗ {c}
        </Badge>
      ))}
      {constraints.inferred.map((c) => (
        <Badge key={c} variant="info">
          ~ {c}
        </Badge>
      ))}
    </div>
  );
}
