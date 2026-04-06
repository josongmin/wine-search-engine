'use client';

import Link from 'next/link';
import { Wine, MapPin, Grape, Calendar } from 'lucide-react';
import { Card, CardHeader, CardContent, CardFooter } from '@/shared/ui';
import { priceBand, wineDetailUrl } from '@/shared/lib';
import type { ResultItem } from '@/shared/api';
import { ConstraintTags } from './constraint-tags';
import { DrinkingWindowBar } from './drinking-window-bar';
import { TasteProfileBar } from './taste-profile-bar';
import { EvidenceSummary } from './evidence-summary';
import { DecisionBadge } from './decision-badge';

interface WineCardProps {
  item: ResultItem;
  decisionStatus?: string;
  rank?: number;
  actions?: React.ReactNode;
}

export function WineCard({ item, decisionStatus, rank, actions }: WineCardProps) {
  const { entity, relevance_score, evidence_items, drinking_window, match, constraints } = item;
  const detailHref = wineDetailUrl(entity.entity_id);

  return (
    <Card className="group">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {rank !== undefined && (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-xs font-semibold text-neutral-600">
                  {rank}
                </span>
              )}
              <Link
                href={detailHref}
                className="text-lg font-semibold text-neutral-900 hover:text-rose-700 transition-colors line-clamp-1"
              >
                {entity.canonical_label}
              </Link>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-neutral-500">
              {entity.region && (
                <span className="flex items-center gap-1">
                  <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                  {entity.region}
                </span>
              )}
              {entity.producer && (
                <span className="flex items-center gap-1">
                  <Wine className="h-3.5 w-3.5" aria-hidden="true" />
                  {entity.producer}
                </span>
              )}
              {entity.grapes && entity.grapes.length > 0 && (
                <span className="flex items-center gap-1">
                  <Grape className="h-3.5 w-3.5" aria-hidden="true" />
                  {entity.grapes.slice(0, 2).join(', ')}
                </span>
              )}
              {entity.vintage && (
                <span className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
                  {entity.vintage}
                </span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <DecisionBadge status={decisionStatus} score={relevance_score} />
            {entity.price_range && (
              <span className="text-sm font-medium text-neutral-600">
                {priceBand(entity.price_range)}
              </span>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2">
          <TasteProfileBar scores={match.score_components} />
          <div className="space-y-3">
            <EvidenceSummary items={evidence_items} />
            {drinking_window && <DrinkingWindowBar window={drinking_window} />}
          </div>
        </div>
      </CardContent>

      <CardFooter className="flex items-center justify-between gap-2">
        <ConstraintTags constraints={constraints} />
        <div className="flex items-center gap-3">
          {actions}
          <Link
            href={detailHref}
            className="text-sm font-medium text-rose-600 hover:text-rose-800 transition-colors"
          >
            상세보기 →
          </Link>
        </div>
      </CardFooter>
    </Card>
  );
}
