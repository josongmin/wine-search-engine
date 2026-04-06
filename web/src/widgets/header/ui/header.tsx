'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense } from 'react';
import { Wine, Heart, Compass } from 'lucide-react';
import { cn } from '@/shared/lib';
import { SearchInput } from '@/features/search-bar';
import { ThemeToggle } from '@/features/theme';

const NAV_ITEMS = [
  { href: '/', label: '홈', icon: Wine },
  { href: '/explore', label: '탐색', icon: Compass },
  { href: '/watchlist', label: '워치리스트', icon: Heart },
] as const;

export function Header() {
  const pathname = usePathname();
  const isHome = pathname === '/';

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-surface/80 backdrop-blur-lg">
      <div className="mx-auto flex h-16 max-w-5xl items-center gap-4 px-4">
        <Link
          href="/"
          className="flex items-center gap-2 text-lg font-bold text-foreground shrink-0"
        >
          <Wine className="h-6 w-6 text-rose-600" />
          <span className="hidden sm:inline">Wine Search</span>
        </Link>

        {!isHome && (
          <div className="flex-1 max-w-lg">
            <Suspense>
              <SearchInput size="md" />
            </Suspense>
          </div>
        )}

        <nav className="ml-auto flex items-center gap-1">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                pathname === href
                  ? 'bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-300'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{label}</span>
            </Link>
          ))}
          <ThemeToggle />
        </nav>
      </div>
    </header>
  );
}
