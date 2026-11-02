/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#141414', soft: '#2c2c2c' },
        // Official Meridian Edge charcoal ramp (monochrome brand).
        // `navy` key retained so existing navy-* utility classes repoint to charcoal.
        navy: { 950: '#141414', 900: '#202020', 800: '#2c2c2c', 700: '#3a3a3a', 600: '#4d4d4d' },
        charcoal: { 950: '#141414', 900: '#202020', 800: '#2c2c2c', 700: '#3a3a3a', 600: '#4d4d4d' },
        // Restrained steel-blue accent, used sparingly for interactive/active/selected states.
        // `accent` key retained so existing accent-* utility classes repoint to steel.
        accent: { DEFAULT: '#3b6ea5', dark: '#2f5783', light: '#7ea6cf' },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(20,20,20,0.08), 0 1px 2px rgba(20,20,20,0.04)',
        panel: '0 4px 24px rgba(20,20,20,0.10)',
      },
    },
  },
  plugins: [],
};
