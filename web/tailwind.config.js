/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#0f172a', soft: '#1e293b' },
        navy: { 950: '#0b1220', 900: '#0f1b33', 800: '#152544', 700: '#1d335c' },
        accent: { DEFAULT: '#b08d57', dark: '#8a6d3f', light: '#c9a876' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(15,23,42,0.08), 0 1px 2px rgba(15,23,42,0.04)',
        panel: '0 4px 24px rgba(15,23,42,0.08)',
      },
    },
  },
  plugins: [],
};
