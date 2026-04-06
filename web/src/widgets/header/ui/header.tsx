'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Heart, Compass } from 'lucide-react';
import { cn } from '@/shared/lib';
import { ThemeToggle } from '@/features/theme';

const NAV_ITEMS = [
  { href: '/explore', label: '탐색', icon: Compass },
  { href: '/watchlist', label: '워치리스트', icon: Heart },
] as const;

export function Header() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-surface/80 backdrop-blur-lg">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 shrink-0 group">
          <svg viewBox="0 0 28 32" fill="none" className="h-7 w-auto">
            <defs>
              <linearGradient id="hdr-drop" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--accent)" />
                <stop offset="100%" stopColor="var(--gold)" />
              </linearGradient>
            </defs>
            <path d="M14 2C14 2 5 11 5 17a9 9 0 0018 0C23 11 14 2 14 2z" fill="url(#hdr-drop)" />
            <path d="M14 26v-4M10 28h8" stroke="var(--gold)" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="font-serif text-lg font-bold text-gradient-wine hidden sm:inline">
            Cuvée
          </span>
        </Link>

        <nav className="ml-auto flex items-center gap-1">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                pathname === href
                  ? 'bg-[color:var(--accent)]/10 text-[color:var(--accent)]'
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
