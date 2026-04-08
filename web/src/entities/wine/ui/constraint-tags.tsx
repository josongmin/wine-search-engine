import { Badge } from '@/shared/ui';
import type { ConstraintEvaluation } from '@/shared/api';

interface ConstraintTagsProps {
  constraints: ConstraintEvaluation;
}

export function ConstraintTags({ constraints }: ConstraintTagsProps) {
  return (
    <div className="flex flex-wrap gap-1">
      {constraints.matched.map((c) => (
        // Prefix the React key so the same constraint string appearing in
        // matched + unmet + inferred doesn't collide on render.
        <Badge key={`m:${c}`} variant="success">
          ✓ {c}
        </Badge>
      ))}
      {constraints.unmet.map((c) => (
        <Badge key={`u:${c}`} variant="danger">
          ✗ {c}
        </Badge>
      ))}
      {constraints.inferred.map((c) => (
        <Badge key={`i:${c}`} variant="info">
          ~ {c}
        </Badge>
      ))}
    </div>
  );
}
