'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Compass, Sparkles, TerminalSquare } from 'lucide-react';
import { cn } from '@/shared/lib';
import { ThemeToggle } from '@/features/theme';

const NAV = [
  { href: '/explore', label: '탐색', icon: Compass },
  { href: '/wine-search-lab', label: '와인 검색 랩', icon: Sparkles },
  { href: '/api-playground', label: 'API 테스트', icon: TerminalSquare },
] as const;

export function Header() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-surface/70 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4">

        {/* Logo */}
        <Link href="/" className="flex shrink-0 items-center gap-2 group">
          <svg viewBox="0 0 32 40" fill="none" className="h-8 w-auto transition-transform duration-300 group-hover:scale-110">
            <defs>
              <linearGradient id="hdr-g" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--accent)" />
                <stop offset="100%" stopColor="var(--gold)" />
              </linearGradient>
            </defs>
            <path d="M16 2C16 2 4 13 4 21a12 12 0 0024 0C28 13 16 2 16 2z" fill="url(#hdr-g)" />
            <path d="M16 33v-6M11 36h10" stroke="var(--gold)" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="hidden font-serif text-lg font-bold sm:inline" style={{
            background: 'linear-gradient(135deg, var(--accent), var(--gold))',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}>
            Cuvée
          </span>
        </Link>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Nav */}
        <nav className="flex items-center gap-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-medium transition-all duration-200',
                pathname === href
                  ? 'bg-[color:var(--accent)]/10 text-[color:var(--accent)]'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
              <span className="hidden sm:inline">{label}</span>
            </Link>
          ))}
          <div className="ml-1">
            <ThemeToggle />
          </div>
        </nav>
      </div>
    </header>
  );
}
