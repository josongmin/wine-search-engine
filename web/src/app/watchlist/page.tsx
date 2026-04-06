import type { Metadata } from 'next';
import { WatchlistList } from '@/features/watchlist';

export const metadata: Metadata = {
  title: '워치리스트',
};

export default function WatchlistPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-neutral-900 mb-6">
        내 워치리스트
      </h1>
      <WatchlistList />
    </div>
  );
}
