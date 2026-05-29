import type { Metadata } from 'next';
import { WineSearchView } from '@/features/wine-search-lab';

export const metadata: Metadata = {
  title: '와인 검색 랩',
};

export default function WineSearchLabPage() {
  return <WineSearchView />;
}
