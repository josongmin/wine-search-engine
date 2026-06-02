'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  { href: '/ops/inspect', label: 'Inspect' },
  { href: '/ops/curation', label: 'Curation' },
  { href: '/ops/coverage', label: 'Coverage' },
] as const;

export function OpsNav() {
  const pathname = usePathname();
  return (
    <nav className="flex gap-2 border-b border-neutral-200 pb-2 dark:border-neutral-800">
      {TABS.map((tab) => {
        const active = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={
              active
                ? 'rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-neutral-900'
                : 'rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800'
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
