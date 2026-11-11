import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark' | 'system';
const KEY = 'cc-remote-theme';

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(KEY) as Theme | null) ?? 'system',
  );

  useEffect(() => {
    apply(theme);
  }, [theme]);

  const setTheme = (next: Theme) => {
    localStorage.setItem(KEY, next);
    setThemeState(next);
  };

  return { theme, setTheme };
}
