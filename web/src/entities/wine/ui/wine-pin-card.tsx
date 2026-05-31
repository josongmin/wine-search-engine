'use client';

import Link from 'next/link';
import { MapPin, Grape, Calendar, Flame, Sparkles, Wine } from 'lucide-react';
import { cn, priceBand, wineDetailUrl } from '@/shared/lib';
import type { ResultItem } from '@/shared/api';

interface WinePinCardProps {
  item: ResultItem;
  decisionStatus?: string;
  rank?: number;
  query?: string;
  actions?: React.ReactNode;
}

type WineType = 'red' | 'white' | 'rose' | 'sparkling' | 'fortified';

function classifyWine(grapes?: readonly string[], region?: string, label?: string): WineType {
  const t = [(grapes ?? []).join(' '), region ?? '', label ?? ''].join(' ').toLowerCase();
  if (/champagne|prosecco|cava|sparkling|sekt|cremant|pétillant/.test(t)) return 'sparkling';
  if (/port|sherry|madeira|marsala|sauternes|banyuls/.test(t)) return 'fortified';
  if (/rosé|rose|rosato|rosado|provence/.test(t)) return 'rose';
  if (/chardonnay|riesling|sauvignon blanc|pinot gris|pinot grigio|viognier|gewurz|gruner|albariño|soave|chablis|white|blanc|weiss|bianco/.test(t)) return 'white';
  return 'red';
}

const WINE_THEMES: Record<WineType, { bg: string; gradient: string; liquid: string; shimmer: string; label: string }> = {
  red: {
    bg: 'bg-rose-950/20 dark:bg-rose-950/40',
    gradient: 'from-rose-900/60 via-rose-800/30 to-transparent',
    liquid: '#6b0f1a',
    shimmer: 'rgba(139,26,46,0.3)',
    label: '레드',
  },
  white: {
    bg: 'bg-amber-50/80 dark:bg-amber-950/30',
    gradient: 'from-amber-900/40 via-amber-700/20 to-transparent',
    liquid: '#c8941a',
    shimmer: 'rgba(200,148,26,0.3)',
    label: '화이트',
  },
  rose: {
    bg: 'bg-pink-100/60 dark:bg-pink-950/30',
    gradient: 'from-pink-900/40 via-pink-700/20 to-transparent',
    liquid: '#d4607a',
    shimmer: 'rgba(212,96,122,0.3)',
    label: '로제',
  },
  sparkling: {
    bg: 'bg-yellow-50/80 dark:bg-yellow-950/30',
    gradient: 'from-yellow-900/40 via-yellow-700/20 to-transparent',
    liquid: '#c8a800',
    shimmer: 'rgba(200,168,0,0.3)',
    label: '스파클링',
  },
  fortified: {
    bg: 'bg-orange-950/20 dark:bg-orange-950/40',
    gradient: 'from-orange-900/50 via-orange-800/25 to-transparent',
    liquid: '#7a3010',
    shimmer: 'rgba(122,48,16,0.3)',
    label: '주정강화',
  },
};

function RelevancePill({ score }: { score: number }) {
  const pct = Math.round(Math.min(Math.max(score, 0), 1) * 100);
  const cls =
    pct >= 85 ? 'bg-emerald-500 text-white' :
    pct >= 70 ? 'bg-[color:var(--gold)] text-white' :
    'bg-black/50 text-white backdrop-blur-sm';
  return (
    <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums shadow', cls)}>
      {pct}%
    </span>
  );
}

function BottleIllustration({ wineType, liquidColor, entityId }: { wineType: WineType; liquidColor: string; entityId: string }) {
  const isSparkling = wineType === 'sparkling';
  const gid = `grad-${entityId.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <svg viewBox="0 0 80 120" className="h-full w-auto drop-shadow-2xl" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="30%" y1="0%" x2="70%" y2="100%">
          <stop offset="0%" stopColor={liquidColor} stopOpacity="0.95" />
          <stop offset="60%" stopColor={liquidColor} stopOpacity="0.7" />
          <stop offset="100%" stopColor={liquidColor} stopOpacity="0.4" />
        </linearGradient>
        <linearGradient id={`${gid}-shine`} x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="white" stopOpacity="0" />
          <stop offset="25%" stopColor="white" stopOpacity="0.18" />
          <stop offset="50%" stopColor="white" stopOpacity="0.05" />
          <stop offset="100%" stopColor="white" stopOpacity="0" />
        </linearGradient>
        <filter id={`${gid}-blur`}>
          <feGaussianBlur stdDeviation="1.5" />
        </filter>
      </defs>

      {/* Bottle shadow */}
      <ellipse cx="40" cy="114" rx="16" ry="4" fill="black" opacity="0.15" filter={`url(#${gid}-blur)`} />

      {/* Bottle body */}
      {isSparkling ? (
        /* Champagne bottle — wider, straight */
        <>
          <rect x="29" y="18" width="22" height="6" rx="2" fill={liquidColor} opacity="0.8" />
          <rect x="27" y="22" width="26" height="3" rx="1" fill={liquidColor} opacity="0.6" />
          <path d="M31 25 L25 38 L25 100 Q25 108 40 108 Q55 108 55 100 L55 38 L49 25 Z"
            fill={`url(#${gid})`} />
        </>
      ) : (
        /* Standard wine bottle */
        <>
          <rect x="33" y="8" width="14" height="5" rx="2" fill={liquidColor} opacity="0.75" />
          <path d="M33 11 L31 18 L29 28 L29 96 Q29 106 40 106 Q51 106 51 96 L51 28 L49 18 L47 11 Z"
            fill={`url(#${gid})`} />
          {/* Foil cap */}
          <rect x="31" y="8" width="18" height="10" rx="2" fill={liquidColor} opacity="0.9" />
          <rect x="33" y="16" width="14" height="2" fill="white" opacity="0.2" />
        </>
      )}

      {/* Shine overlay */}
      <path d={isSparkling
        ? "M32 28 L30 90 Q29 95 32 98 L34 28 Z"
        : "M32 20 L30 88 Q29 94 32 98 L34 20 Z"}
        fill={`url(#${gid}-shine)`} />

      {/* Label */}
      <rect x={isSparkling ? 28 : 31} y="52" width={isSparkling ? 24 : 18} height="26" rx="2"
        fill="white" opacity="0.22" />
      <rect x={isSparkling ? 30 : 33} y="56" width={isSparkling ? 20 : 14} height="2" rx="1"
        fill="white" opacity="0.5" />
      <rect x={isSparkling ? 31 : 34} y="60" width={isSparkling ? 18 : 12} height="1.5" rx="0.75"
        fill="white" opacity="0.35" />
      <rect x={isSparkling ? 31 : 34} y="64" width={isSparkling ? 14 : 10} height="1.5" rx="0.75"
        fill="white" opacity="0.25" />

      {/* Sparkling bubbles */}
      {isSparkling && (
        <>
          <circle cx="38" cy="45" r="1.2" fill="white" opacity="0.4" />
          <circle cx="42" cy="35" r="0.8" fill="white" opacity="0.3" />
          <circle cx="36" cy="38" r="0.6" fill="white" opacity="0.25" />
        </>
      )}
    </svg>
  );
}

export function WinePinCard({ item, rank, actions }: WinePinCardProps) {
  const { entity, relevance_score, match, drinking_window } = item;
  const detailHref = wineDetailUrl(entity.entity_id);
  const wineType = classifyWine(entity.grapes, entity.region, entity.canonical_label);
  const theme = WINE_THEMES[wineType];
  const semantic = match.score_components.semantic ?? 0;
  const semanticPct = Math.round(Math.min(Math.max(semantic, 0), 1) * 100);

  return (
    <Link
      href={detailHref}
      className="group block rounded-2xl overflow-hidden bg-surface border border-border transition-all duration-300 hover:shadow-2xl hover:-translate-y-1 hover:border-[color:var(--accent)]/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
    >
      {/* ── Visual header ── */}
      <div className={cn('relative w-full overflow-hidden', theme.bg)} style={{ aspectRatio: '3/4' }}>

        {/* Gradient overlay bottom */}
        <div className={cn('absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t', theme.gradient)} />

        {/* Bottle centered */}
        <div className="absolute inset-0 flex items-center justify-center py-4">
          <div className="h-4/5">
            <BottleIllustration wineType={wineType} liquidColor={theme.liquid} entityId={entity.entity_id} />
          </div>
        </div>

        {/* TOP LEFT: rank or wine type tag */}
        <div className="absolute top-2.5 left-2.5 flex items-center gap-1.5">
          {rank !== undefined && rank <= 3 ? (
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[color:var(--accent)] text-[10px] font-bold text-white shadow-lg">
              {rank}
            </span>
          ) : (
            <span className="rounded-full bg-black/30 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
              {theme.label}
            </span>
          )}
        </div>

        {/* BOTTOM: score + price */}
        <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-end justify-between">
          {entity.price_range ? (
            <span className="rounded-full bg-black/35 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
              {priceBand(entity.price_range)}
            </span>
          ) : <span />}
          <RelevancePill score={relevance_score} />
        </div>
      </div>

      {/* ── Card body ── */}
      <div className="p-3 space-y-2">
        {/* Title */}
        <h3 className="font-semibold text-sm leading-snug text-foreground line-clamp-2 group-hover:text-[color:var(--accent)] transition-colors duration-200">
          {entity.canonical_label}
        </h3>

        {/* Producer */}
        {entity.producer && (
          <p className="text-xs text-muted-foreground line-clamp-1 flex items-center gap-1">
            <Wine className="h-3 w-3 shrink-0" />
            {entity.producer}
          </p>
        )}

        {/* Meta tags */}
        <div className="flex flex-wrap gap-1">
          {entity.region && (
            <span className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <MapPin className="h-2.5 w-2.5" />{entity.region}
            </span>
          )}
          {entity.vintage && (
            <span className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Calendar className="h-2.5 w-2.5" />{entity.vintage}
            </span>
          )}
          {entity.grapes && entity.grapes.length > 0 && (
            <span className="inline-flex items-center gap-0.5 rounded-md bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              <Grape className="h-2.5 w-2.5" />{entity.grapes.slice(0, 2).join(', ')}
            </span>
          )}
        </div>

        {/* Semantic match bar */}
        {semantic > 0 && (
          <div className="space-y-0.5">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Sparkles className="h-2.5 w-2.5" />매칭
              </span>
              <span className="text-[10px] font-medium text-muted-foreground">{semanticPct}%</span>
            </div>
            <div className="h-1 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${semanticPct}%`,
                  background: `linear-gradient(90deg, var(--accent), var(--gold))`,
                }}
              />
            </div>
          </div>
        )}

        {/* Drinking window */}
        {drinking_window?.currently_drinkable && (
          <div className="flex items-center gap-1 rounded-md bg-emerald-50 dark:bg-emerald-950/30 px-2 py-1 text-[10px] text-emerald-700 dark:text-emerald-400">
            <Flame className="h-2.5 w-2.5 shrink-0" />
            <span>
              지금 마시기 좋음 · {drinking_window.drinking_window_start}–{drinking_window.drinking_window_end}
              {drinking_window.peak_year !== undefined && ` · 피크 ${drinking_window.peak_year}`}
            </span>
          </div>
        )}

        {/* Actions — reveal on hover */}
        {actions && (
          <div
            className="pt-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200"
            onClick={(e) => e.preventDefault()}
          >
            {actions}
          </div>
        )}
      </div>
    </Link>
  );
}
