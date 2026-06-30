'use client';

import {Button} from '@astryxdesign/core/Button';
import {useThemeMode} from '@/app/providers';

export function ThemeToggle() {
  const {mode, toggle} = useThemeMode();
  const isDark = mode === 'dark';
  return (
    <Button
      label={isDark ? 'Light mode' : 'Dark mode'}
      variant="secondary"
      size="sm"
      onClick={toggle}
    />
  );
}
