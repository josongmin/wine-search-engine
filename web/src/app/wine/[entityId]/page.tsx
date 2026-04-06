import type { Metadata } from 'next';
import { WineDetailView } from './wine-detail-view';

export const metadata: Metadata = {
  title: '와인 상세',
};

export default async function WineDetailPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;
  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <WineDetailView entityId={entityId} />
    </div>
  );
}
