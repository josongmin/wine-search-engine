'use client';

import { useRouter } from 'next/navigation';
import { MapPin, Palette } from 'lucide-react';
import { Card, CardContent } from '@/shared/ui';
import { searchUrl } from '@/shared/lib';

const REGIONS = [
  { name: '보르도', query: 'France / Bordeaux 와인' },
  { name: '부르고뉴', query: 'France / Bourgogne / Côte de Nuits 와인' },
  { name: '나파 밸리', query: 'USA / California / Napa Valley 와인' },
  { name: '토스카나', query: 'Italy / Toscana 와인' },
  { name: '리오하', query: 'Spain / Rioja 와인' },
  { name: '모젤', query: 'Germany / Mosel 와인' },
] as const;

const STYLES = [
  { name: '풀바디 레드', query: '풀바디 레드 와인 추천' },
  { name: '라이트 화이트', query: '가벼운 화이트 와인' },
  { name: '내추럴 와인', query: 'natural wine 내추럴' },
  { name: '스파클링', query: '스파클링 와인 샴페인 추천' },
  { name: '디저트 와인', query: '디저트 와인 스위트' },
  { name: '오렌지 와인', query: 'orange wine 오렌지 와인' },
] as const;

interface GridSectionProps {
  title: string;
  icon: React.ReactNode;
  items: readonly { name: string; query: string }[];
}

function GridSection({ title, icon, items }: GridSectionProps) {
  const router = useRouter();

  return (
    <section aria-label={title}>
      <h2 className="flex items-center gap-2 text-lg font-semibold text-neutral-900 mb-4">
        {icon}
        {title}
      </h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="list">
        {items.map(({ name, query }) => (
          <button
            key={name}
            type="button"
            role="listitem"
            onClick={() => router.push(searchUrl(query))}
            className="rounded-xl border border-neutral-200 bg-white py-4 text-center text-sm font-medium text-neutral-800 shadow-sm transition-all hover:border-rose-200 hover:bg-rose-50/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-2 cursor-pointer"
          >
            {name}
          </button>
        ))}
      </div>
    </section>
  );
}

export function ExploreGrid() {
  return (
    <div className="space-y-10">
      <GridSection
        title="산지별 탐색"
        icon={<MapPin className="h-5 w-5 text-rose-500" aria-hidden="true" />}
        items={REGIONS}
      />
      <GridSection
        title="스타일별 탐색"
        icon={<Palette className="h-5 w-5 text-rose-500" aria-hidden="true" />}
        items={STYLES}
      />
    </div>
  );
}
