'use client';

import {Button} from '@astryxdesign/core/Button';
import {SunIcon, MoonIcon} from '@heroicons/react/24/outline';
import {useThemeMode} from '@/app/providers';

export function ThemeToggle() {
  const {mode, toggle} = useThemeMode();
  const isDark = mode === 'dark';
  // The label/tooltip name the action (what a click does); the icon shows the
  // current theme (state), the clearer convention for an icon-only toggle.
  const action = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <Button
      isIconOnly
      label={action}
      tooltip={action}
      variant="ghost"
      size="sm"
      icon={
        isDark ? (
          <MoonIcon style={{width: 16, height: 16}} />
        ) : (
          <SunIcon style={{width: 16, height: 16}} />
        )
      }
      onClick={toggle}
    />
  );
}
