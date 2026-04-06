import { Suspense } from 'react';
import { SearchInput, QueryChips } from '@/features/search-bar';

export default function HomePage() {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-4 py-16">
      {/* Ambient background orbs */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-32 left-1/2 h-[500px] w-[700px] -translate-x-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,_rgba(124,29,46,0.12)_0%,_transparent_70%)] blur-3xl" />
        <div className="absolute bottom-0 right-0 h-[400px] w-[500px] rounded-full bg-[radial-gradient(ellipse_at_center,_rgba(181,137,58,0.09)_0%,_transparent_70%)] blur-3xl" />
        <div className="absolute bottom-0 left-0 h-[300px] w-[400px] rounded-full bg-[radial-gradient(ellipse_at_center,_rgba(124,29,46,0.06)_0%,_transparent_70%)] blur-3xl" />
      </div>

      {/* Hero */}
      <div className="relative z-10 w-full max-w-xl space-y-8 text-center">
        {/* Logo mark */}
        <div className="animate-fade-up space-y-4">
          <div className="mx-auto flex h-20 w-20 items-center justify-center">
            <svg viewBox="0 0 48 56" fill="none" className="h-full w-full drop-shadow-xl">
              <defs>
                <linearGradient id="hero-drop" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="var(--accent)" />
                  <stop offset="100%" stopColor="var(--gold)" />
                </linearGradient>
              </defs>
              <path d="M24 3C24 3 8 19 8 31a16 16 0 0032 0C40 19 24 3 24 3z" fill="url(#hero-drop)" />
              <path d="M24 47v-8M17 52h14" stroke="var(--gold)" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <h1 className="font-serif text-6xl font-bold tracking-tight sm:text-7xl">
              <span className="text-gradient-wine">Cuvée</span>
            </h1>
            <p className="mt-3 text-base text-muted-foreground sm:text-lg">
              와인, 무엇이든 물어보세요
            </p>
          </div>
        </div>

        {/* Search — centered */}
        <div className="animate-fade-up delay-150">
          <Suspense>
            <SearchInput size="lg" autoFocus />
          </Suspense>
        </div>

        {/* Trending chips */}
        <div className="animate-fade-up delay-300">
          <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground/60">
            트렌딩
          </p>
          <QueryChips />
        </div>
      </div>
    </div>
  );
}
