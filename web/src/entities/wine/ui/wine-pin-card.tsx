'use client';

import Link from 'next/link';
import { MapPin, Grape, Calendar, TrendingUp, Star } from 'lucide-react';
import { cn, priceBand, wineDetailUrl } from '@/shared/lib';
import type { ResultItem } from '@/shared/api';
import { WatchlistButton } from '@/features/watchlist';

interface WinePinCardProps {
  item: ResultItem;
  decisionStatus?: string;
  rank?: number;
  query?: string;
  actions?: React.ReactNode;
}

/** Score → visual fill width */
function scorePct(score: number) {
  return Math.round(Math.min(Math.max(score, 0), 1) * 100);
}

/** Relevance percentage for display */
function relevancePct(score: number) {
  return Math.round(Math.min(Math.max(score, 0), 1) * 100);
}

/** Wine type color accent */
function wineColor(grapes?: readonly string[], region?: string): string {
  const text = [(grapes ?? []).join(' '), region ?? ''].join(' ').toLowerCase();
  if (/chardon|riesling|sauvignon blanc|pinot gris|白/.test(text)) return 'bg-amber-100 dark:bg-amber-950';
  if (/rosé|rose|provençal/.test(text)) return 'bg-pink-100 dark:bg-pink-950';
  if (/champagne|prosecco|cava|sparkling|sekt/.test(text)) return 'bg-yellow-50 dark:bg-yellow-950';
  return 'bg-rose-100 dark:bg-rose-950';
}

/** Wine liquid color for the visual placeholder */
function liquidColor(grapes?: readonly string[], region?: string): string {
  const text = [(grapes ?? []).join(' '), region ?? ''].join(' ').toLowerCase();
  if (/chardon|riesling|sauvignon blanc|pinot gris/.test(text)) return '#d4a017';
  if (/rosé|rose|provençal/.test(text)) return '#e8788a';
  if (/champagne|prosecco|cava|sparkling/.test(text)) return '#f0c040';
  return '#8b1a2f';
}

export function WinePinCard({ item, rank, query, actions }: WinePinCardProps) {
  const { entity, relevance_score, match, drinking_window } = item;
  const detailHref = wineDetailUrl(entity.entity_id);
  const pct = relevancePct(relevance_score);
  const lColor = liquidColor(entity.grapes, entity.region);
  const bgColor = wineColor(entity.grapes, entity.region);

  return (
    <Link
      href={detailHref}
      className="group block rounded-2xl overflow-hidden bg-surface border border-border shadow-sm transition-all duration-300 hover:shadow-xl hover:-translate-y-0.5 hover:border-[color:var(--accent)]/30"
    >
      {/* Visual header — wine drop illustration */}
      <div className={cn('relative w-full overflow-hidden', bgColor)} style={{ aspectRatio: '4/3' }}>
        {/* Abstract wine illustration */}
        <div className="absolute inset-0 flex items-center justify-center">
          <svg viewBox="0 0 120 140" className="h-3/4 w-auto drop-shadow-lg opacity-80">
            <defs>
              <linearGradient id={`lg-${entity.entity_id}`} x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor={lColor} stopOpacity="0.9" />
                <stop offset="100%" stopColor={lColor} stopOpacity="0.5" />
              </linearGradient>
            </defs>
            {/* Bottle silhouette */}
            <path
              d="M48 10 L48 28 C35 32 28 42 28 56 L28 118 C28 124 33 128 40 128 L80 128 C87 128 92 124 92 118 L92 56 C92 42 85 32 72 28 L72 10 Z"
              fill={`url(#lg-${entity.entity_id})`}
            />
            <rect x="44" y="6" width="32" height="6" rx="3" fill={lColor} opacity="0.7" />
            {/* Label area */}
            <rect x="36" y="68" width="48" height="36" rx="4" fill="white" opacity="0.25" />
          </svg>
        </div>

        {/* Rank badge */}
        {rank !== undefined && rank <= 3 && (
          <div className="absolute top-2.5 left-2.5 flex h-7 w-7 items-center justify-center rounded-full bg-[color:var(--accent)] text-xs font-bold text-white shadow-md">
            {rank}
          </div>
        )}

        {/* Watchlist button */}
        <div
          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => e.preventDefault()}
        >
          <WatchlistButton entityId={entity.entity_id} />
        </div>

        {/* Score pill */}
        <div className="absolute bottom-2.5 right-2.5">
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-semibold shadow-sm',
              pct >= 80
                ? 'bg-emerald-600 text-white'
                : pct >= 60
                  ? 'bg-[color:var(--gold)] text-white'
                  : 'bg-black/40 text-white backdrop-blur-sm',
            )}
          >
            {pct}%
          </span>
        </div>

        {/* Price badge */}
        {entity.price_range && (
          <div className="absolute bottom-2.5 left-2.5">
            <span className="rounded-full bg-black/35 px-2 py-0.5 text-xs font-medium text-white backdrop-blur-sm">
              {priceBand(entity.price_range)}
            </span>
          </div>
        )}
      </div>

      {/* Card body */}
      <div className="p-3 space-y-2">
        {/* Title */}
        <h3 className="font-semibold text-sm leading-snug text-foreground line-clamp-2 group-hover:text-[color:var(--accent)] transition-colors">
          {entity.canonical_label}
        </h3>

        {/* Meta row */}
        <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {entity.region && (
            <span className="flex items-center gap-0.5">
              <MapPin className="h-3 w-3" /> {entity.region}
            </span>
          )}
          {entity.vintage && (
            <span className="flex items-center gap-0.5">
              <Calendar className="h-3 w-3" /> {entity.vintage}
            </span>
          )}
          {entity.grapes && entity.grapes.length > 0 && (
            <span className="flex items-center gap-0.5">
              <Grape className="h-3 w-3" /> {entity.grapes.slice(0, 2).join(', ')}
            </span>
          )}
        </div>

        {/* Score bar — semantic match */}
        {match.score_components.semantic !== undefined && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <Star className="h-3 w-3" /> 매칭
              </span>
              <span>{scorePct(match.score_components.semantic)}%</span>
            </div>
            <div className="h-1 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-[color:var(--accent)] transition-all"
                style={{ width: `${scorePct(match.score_components.semantic)}%` }}
              />
            </div>
          </div>
        )}

        {/* Drinking window */}
        {drinking_window?.currently_drinkable && (
          <div className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
            <TrendingUp className="h-3 w-3" />
            <span>
              {drinking_window.drinking_window_start}–{drinking_window.drinking_window_end}
              {drinking_window.peak_year !== undefined && ` · 피크 ${drinking_window.peak_year}`}
            </span>
          </div>
        )}

        {/* Actions row (feedback etc) — only on hover, stop propagation */}
        {actions && (
          <div
            className="pt-1 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={(e) => e.preventDefault()}
          >
            {actions}
          </div>
        )}
      </div>
    </Link>
  );
}
