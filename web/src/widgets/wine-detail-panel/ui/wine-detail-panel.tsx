import { MapPin, Wine, Grape, Calendar, Tag } from 'lucide-react';
import type { ResultItem, EntitySummary, EntityResolveResponse } from '@/shared/api';
import { Card, CardContent } from '@/shared/ui';
import { priceBand } from '@/shared/lib';
import {
  TasteProfileBar,
  DrinkingWindowBar,
  EvidenceSummary,
  ConstraintTags,
} from '@/entities/wine';
import { WatchlistButton } from '@/features/watchlist';
import { FeedbackButtons } from '@/features/feedback';

/** WineDetailPanel accepts either a full ResultItem or a lighter EntityResolveResponse. */
type WineDetailSource =
  | { kind: 'result'; item: ResultItem }
  | { kind: 'entity'; data: EntityResolveResponse };

interface WineDetailPanelProps {
  source: WineDetailSource;
  query?: string;
}

function extractEntity(source: WineDetailSource): EntitySummary {
  return source.kind === 'result' ? source.item.entity : source.data.entity;
}

export function WineDetailPanel({ source, query }: WineDetailPanelProps) {
  const entity = extractEntity(source);
  const item = source.kind === 'result' ? source.item : null;

  return (
    <div className="space-y-6">
      {/* Hero */}
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">
          {entity.canonical_label}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-neutral-500">
          {entity.region && (
            <span className="flex items-center gap-1">
              <MapPin className="h-4 w-4" aria-hidden="true" /> {entity.region}
            </span>
          )}
          {entity.producer && (
            <span className="flex items-center gap-1">
              <Wine className="h-4 w-4" aria-hidden="true" /> {entity.producer}
            </span>
          )}
          {entity.grapes && entity.grapes.length > 0 && (
            <span className="flex items-center gap-1">
              <Grape className="h-4 w-4" aria-hidden="true" /> {entity.grapes.join(', ')}
            </span>
          )}
          {entity.vintage && (
            <span className="flex items-center gap-1">
              <Calendar className="h-4 w-4" aria-hidden="true" /> {entity.vintage}
            </span>
          )}
          {entity.price_range && (
            <span className="flex items-center gap-1">
              <Tag className="h-4 w-4" aria-hidden="true" /> {priceBand(entity.price_range)}
            </span>
          )}
        </div>

        <div className="mt-4 flex items-center gap-2">
          <WatchlistButton entityId={entity.entity_id} />
          {query && (
            <FeedbackButtons query={query} entityId={entity.entity_id} />
          )}
        </div>
      </div>

      {/* Score components — only for full ResultItem */}
      {item && (
        <Card>
          <CardContent className="pt-5">
            <TasteProfileBar scores={item.match.score_components} />
          </CardContent>
        </Card>
      )}

      {/* Drinking window — only for full ResultItem */}
      {item?.drinking_window && (
        <Card>
          <CardContent className="pt-5">
            <DrinkingWindowBar window={item.drinking_window} />
          </CardContent>
        </Card>
      )}

      {/* Evidence — only for full ResultItem */}
      {item && item.evidence_items.length > 0 && (
        <Card>
          <CardContent className="pt-5">
            <EvidenceSummary items={item.evidence_items} max={10} />
          </CardContent>
        </Card>
      )}

      {/* Constraints — only for full ResultItem */}
      {item &&
        (item.constraints.matched.length > 0 ||
          item.constraints.unmet.length > 0 ||
          item.constraints.inferred.length > 0) && (
          <Card>
            <CardContent className="pt-5">
              <p className="text-xs font-medium text-neutral-500 uppercase tracking-wider mb-2">
                Constraints
              </p>
              <ConstraintTags constraints={item.constraints} />
            </CardContent>
          </Card>
        )}

      {/* Minimal view notice for entity-resolve */}
      {source.kind === 'entity' && (
        <p className="text-xs text-neutral-400 text-center">
          검색을 통해 접근하면 더 풍부한 분석 정보를 확인할 수 있습니다.
        </p>
      )}
    </div>
  );
}
