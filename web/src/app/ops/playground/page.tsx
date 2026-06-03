import type { Metadata } from 'next';
import { OpsPlaygroundView } from '@/features/ops';

export const metadata: Metadata = {
  title: 'ELV2 Ops — Playground',
};

export default function OpsPlaygroundPage() {
  return <OpsPlaygroundView />;
}
