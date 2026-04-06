import { Suspense } from 'react';
import { SearchInput, QueryChips } from '@/features/search-bar';
import { FloatingSearchBar } from '@/widgets/search-results';

export default function HomePage() {
  return (
    <div className="relative flex flex-1 flex-col items-center justify-center overflow-hidden px-4 pb-40 pt-12">

      {/* Ambient orbs */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[600px] w-[800px] -translate-x-1/2 rounded-full opacity-60"
          style={{ background: 'radial-gradient(ellipse at center, rgba(124,29,46,0.15) 0%, transparent 70%)', filter: 'blur(40px)' }} />
        <div className="absolute -bottom-20 right-[-10%] h-[400px] w-[500px] rounded-full opacity-50"
          style={{ background: 'radial-gradient(ellipse at center, rgba(181,137,58,0.12) 0%, transparent 70%)', filter: 'blur(40px)' }} />
        <div className="absolute -bottom-10 left-[-5%] h-[350px] w-[450px] rounded-full opacity-40"
          style={{ background: 'radial-gradient(ellipse at center, rgba(124,29,46,0.09) 0%, transparent 70%)', filter: 'blur(40px)' }} />
      </div>

      {/* Hero content */}
      <div className="relative z-10 w-full max-w-2xl space-y-8 text-center">

        {/* Logo */}
        <div className="animate-fade-up space-y-5">
          <div className="mx-auto flex h-[88px] w-[88px] items-center justify-center">
            <svg viewBox="0 0 56 68" fill="none" className="h-full w-full drop-shadow-2xl">
              <defs>
                <linearGradient id="home-drop" x1="10%" y1="0%" x2="90%" y2="100%">
                  <stop offset="0%" stopColor="var(--accent)" />
                  <stop offset="100%" stopColor="var(--gold)" />
                </linearGradient>
                <filter id="home-glow">
                  <feGaussianBlur stdDeviation="3" result="blur" />
                  <feComposite in="SourceGraphic" in2="blur" operator="over" />
                </filter>
              </defs>
              {/* Glow */}
              <path d="M28 4C28 4 8 22 8 36a20 20 0 0040 0C48 22 28 4 28 4z"
                fill="url(#home-drop)" opacity="0.3" filter="url(#home-glow)" />
              {/* Drop */}
              <path d="M28 4C28 4 8 22 8 36a20 20 0 0040 0C48 22 28 4 28 4z"
                fill="url(#home-drop)" />
              <path d="M28 56v-10M20 62h16" stroke="var(--gold)" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </div>

          <div>
            <h1 className="font-serif text-6xl font-bold tracking-tight sm:text-7xl">
              <span className="text-gradient-wine">Cuvée</span>
            </h1>
            <p className="mt-3 text-base sm:text-lg text-muted-foreground">
              AI 와인 소믈리에 — 무엇이든 물어보세요
            </p>
          </div>
        </div>

        {/* Search bar — centered */}
        <div className="animate-fade-up delay-150">
          <Suspense>
            <SearchInput size="lg" autoFocus />
          </Suspense>
        </div>

        {/* Trending */}
        <div className="animate-fade-up delay-300 space-y-3">
          <div className="flex items-center justify-center gap-2">
            <div className="h-px w-12 bg-border" />
            <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/60">
              트렌딩
            </span>
            <div className="h-px w-12 bg-border" />
          </div>
          <QueryChips />
        </div>
      </div>

      {/* Floating bar hidden on home (lg search bar already present) */}
    </div>
  );
}
