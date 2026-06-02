import type { Metadata } from 'next';
import { OpsCurationView } from '@/features/ops';

export const metadata: Metadata = {
  title: 'ELV2 Ops — Curation',
};

export default function OpsCurationPage() {
  return <OpsCurationView />;
}
