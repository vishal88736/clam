'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Theme = 'light' | 'dark';
const Context = createContext({ theme: 'light' as Theme, toggleTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('light');
  useEffect(() => {
    const saved = localStorage.getItem('siftvane_theme') ?? localStorage.getItem('clam_theme');
    if (saved === 'dark') {
      setTheme('dark');
      document.documentElement.dataset.theme = 'dark';
    }
  }, []);
  function toggleTheme() {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem('siftvane_theme', next);
  }
  return <Context.Provider value={{ theme, toggleTheme }}>{children}</Context.Provider>;
}

export const useTheme = () => useContext(Context);
