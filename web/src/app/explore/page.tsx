import type { Metadata } from 'next';
import { ExploreGrid } from '@/widgets/explore-grid';

export const metadata: Metadata = {
  title: '탐색',
};

export default function ExplorePage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-neutral-900 mb-6">탐색</h1>
      <ExploreGrid />
    </div>
  );
}
