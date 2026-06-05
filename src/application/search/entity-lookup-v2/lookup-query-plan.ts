import type { AnchorCandidate } from '../../../domain/query/model/anchor-candidate.js';
import type { QueryPolicy } from '../../../domain/query/model/query-policy.js';
import type { QueryUncertainty } from '../../../domain/query/model/query-uncertainty.js';
import type { NormalizedQueryViews } from '../../../domain/query/model/query-views.js';
import type { ConstraintBundle, QueryClass } from '../../../domain/shared/types/index.js';

export interface LookupQueryPlan {
  readonly rawQuery: string;
  readonly normalizedQuery: string;
  readonly normalizedQueryViews: NormalizedQueryViews;
  readonly queryClass: QueryClass;
  readonly anchors: readonly AnchorCandidate[];
  readonly constraints: ConstraintBundle;
  readonly policy: QueryPolicy;
  readonly uncertainty: QueryUncertainty;
}
