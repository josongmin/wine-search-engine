'use client';

import { Sun, Moon, Monitor } from 'lucide-react';
import { IconButton } from '@/shared/ui';
import { useTheme } from '../model/use-theme';

const cycle = ['light', 'dark', 'system'] as const;
const icons = { light: Sun, dark: Moon, system: Monitor } as const;
const labels = { light: '라이트 모드', dark: '다크 모드', system: '시스템 설정' } as const;

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = icons[theme];

  const handleToggle = () => {
    const idx = cycle.indexOf(theme);
    const next = cycle[(idx + 1) % cycle.length];
    setTheme(next);
  };

  return (
    <IconButton
      variant="ghost"
      size="md"
      onClick={handleToggle}
      aria-label={labels[theme]}
    >
      <Icon className="h-4 w-4" />
    </IconButton>
  );
}
