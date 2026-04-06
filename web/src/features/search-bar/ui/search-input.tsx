'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X, Loader2, ArrowRight } from 'lucide-react';
import { cn, searchUrl } from '@/shared/lib';

interface SearchInputProps {
  size?: 'lg' | 'md' | 'floating';
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

  const isFloating = size === 'floating';
  const isLg = size === 'lg';

  if (isFloating) {
    return (
      <form
        onSubmit={handleSubmit}
        className={cn('w-full', className)}
        role="search"
      >
        <div className="glass-strong flex items-center gap-3 rounded-2xl border border-border/60 px-4 py-3 shadow-2xl ring-1 ring-black/5 transition-all focus-within:ring-2 focus-within:ring-[color:var(--accent)]/30 dark:ring-white/5">
          {isLoading ? (
            <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[color:var(--accent)]" aria-hidden="true" />
          ) : (
            <Search className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="와인, 무엇이든 물어보세요..."
            className="flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/60"
            autoComplete="off"
            spellCheck={false}
            aria-label="와인 검색"
          />
          {value.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              aria-label="검색어 지우기"
              className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
          <button
            type="submit"
            aria-label="검색"
            className="shrink-0 flex h-8 w-8 items-center justify-center rounded-xl bg-[color:var(--accent)] text-white shadow-sm transition-all hover:opacity-90 active:scale-95 disabled:opacity-40"
            disabled={!value.trim()}
          >
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={handleSubmit} className={cn('relative w-full', className)} role="search">
      <div
        className={cn(
          'flex items-center gap-3 rounded-2xl border border-border bg-surface px-4 shadow-sm transition-all focus-within:border-[color:var(--accent)]/40 focus-within:ring-4 focus-within:ring-[color:var(--accent)]/10',
          isLg ? 'py-4 text-lg' : 'py-2.5 text-base',
        )}
      >
        {isLoading ? (
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[color:var(--accent)]" aria-hidden="true" />
        ) : (
          <Search className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={isLg ? '와인, 무엇이든 물어보세요...' : '검색'}
          className="flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          autoComplete="off"
          spellCheck={false}
          aria-label="와인 검색"
        />
        {value.length > 0 && (
          <button
            type="button"
            onClick={handleClear}
            aria-label="검색어 지우기"
            className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
        {isLg && (
          <button
            type="submit"
            aria-label="검색"
            className="hidden shrink-0 items-center gap-1.5 rounded-xl bg-[color:var(--accent)] px-4 py-2 text-sm font-medium text-white shadow-sm transition-all hover:opacity-90 active:scale-95 disabled:opacity-40 lg:flex"
            disabled={!value.trim()}
          >
            검색 <ArrowRight className="h-4 w-4" />
          </button>
        )}
      </div>
    </form>
  );
}
