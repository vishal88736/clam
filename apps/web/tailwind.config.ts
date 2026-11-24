import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      colors: {
        canvas: 'var(--bg-canvas)',
        sidebar: 'var(--bg-sidebar)',
        surface: 'var(--bg-surface)',
        elevated: 'var(--bg-elevated)',
        hairline: 'var(--border-hairline)',
        pearl: 'var(--brand-pearl)',
        ink: {
          primary: 'var(--text-primary)',
          secondary: 'var(--text-secondary)',
          tertiary: 'var(--text-muted)',
          muted: 'var(--text-muted)',
        },
        emerald: {
          matte: 'var(--accent-allow-text)',
          fill: 'var(--accent-allow-bg)',
        },
        amber: {
          matte: 'var(--accent-ask-text)',
          fill: 'var(--accent-ask-bg)',
        },
        crimson: {
          matte: 'var(--accent-block-text)',
          fill: 'var(--accent-block-bg)',
        },
      },
      boxShadow: {
        bento: 'var(--shadow-bento)',
      },
    },
  },
  plugins: [],
};

export default config;
