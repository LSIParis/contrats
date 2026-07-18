import type { Config } from 'tailwindcss';
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: { lsi: { DEFAULT: '#0b5cad', dark: '#083f79' } }, // couleurs LSI (ajustables)
    },
  },
  plugins: [],
} satisfies Config;
