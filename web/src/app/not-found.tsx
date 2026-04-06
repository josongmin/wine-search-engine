import Link from 'next/link';
import { Wine } from 'lucide-react';
import { Button } from '@/shared/ui';

export default function NotFound() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-24 text-center">
      <Wine className="h-12 w-12 text-neutral-300 mb-4" />
      <h2 className="text-xl font-semibold text-neutral-900 mb-2">
        페이지를 찾을 수 없습니다
      </h2>
      <p className="text-sm text-neutral-500 mb-6">
        찾으시는 페이지가 존재하지 않거나 이동되었습니다.
      </p>
      <Link href="/">
        <Button variant="primary">홈으로 돌아가기</Button>
      </Link>
    </div>
  );
}
