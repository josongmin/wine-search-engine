import type { Metadata } from 'next';
import { AgentLabView } from '@/features/agent-lab';

export const metadata: Metadata = {
  title: '에이전트 랩',
};

export default function AgentLabPage() {
  return <AgentLabView />;
}
