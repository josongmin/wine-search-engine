import type { Metadata } from 'next';
import { OpsInspectView } from '@/features/ops';

export const metadata: Metadata = {
  title: 'ELV2 Ops — Inspect',
};

export default function OpsInspectPage() {
  return <OpsInspectView />;
}
