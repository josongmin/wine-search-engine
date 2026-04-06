'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X, Loader2 } from 'lucide-react';
import { cn, searchUrl } from '@/shared/lib';
import { IconButton } from '@/shared/ui';

interface SearchInputProps {
  size?: 'lg' | 'md';
  autoFocus?: boolean;
  isLoading?: boolean;
  className?: string;
}

export function SearchInput({
  size = 'md',
  autoFocus = false,
  isLoading = false,
  className,
}: SearchInputProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(searchParams.get('q') ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const q = value.trim();
      if (!q) return;
      router.push(searchUrl(q));
    },
    [value, router],
  );

  const handleClear = useCallback(() => {
    setValue('');
    inputRef.current?.focus();
  }, []);

  const isLg = size === 'lg';

  return (
    <form onSubmit={handleSubmit} className={cn('relative w-full', className)} role="search">
      <div
        className={cn(
          'flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 shadow-sm transition-all focus-within:border-rose-300 focus-within:ring-4 focus-within:ring-rose-100/50',
          isLg ? 'py-4 text-lg' : 'py-2.5 text-base',
        )}
      >
        {isLoading ? (
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-rose-500" aria-hidden="true" />
        ) : (
          <Search className="h-5 w-5 shrink-0 text-neutral-400" aria-hidden="true" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="와인, 무엇이든 물어보세요..."
          className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          autoComplete="off"
          spellCheck={false}
          aria-label="와인 검색"
        />
        {value.length > 0 && (
          <IconButton
            variant="ghost"
            onClick={handleClear}
            aria-label="검색어 지우기"
          >
            <X className="h-4 w-4" />
          </IconButton>
        )}
      </div>
    </form>
  );
}
