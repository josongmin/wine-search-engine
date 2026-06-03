import type { Metadata } from 'next';
import { SearchApiView } from '@/features/api-playground';

export const metadata: Metadata = {
  title: '검색 API 테스트',
};

export default function ApiPlaygroundPage() {
  return <SearchApiView />;
}
