import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        canvas: 'var(--bg-canvas)',
        surface: 'var(--bg-surface)',
        elevated: 'var(--bg-elevated)',
        hairline: 'var(--border-hairline)',
        ink: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-tertiary)',
        },
        emerald: {
          matte: 'var(--accent-emerald-text)',
          fill: 'var(--accent-emerald-bg)',
        },
        amber: {
          matte: 'var(--accent-amber-text)',
          fill: 'var(--accent-amber-bg)',
        },
        crimson: {
          matte: 'var(--accent-crimson-text)',
          fill: 'var(--accent-crimson-bg)',
        },
      },
    },
  },
  plugins: [],
};

export default config;
