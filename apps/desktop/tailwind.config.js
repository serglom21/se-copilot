/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        sentry: {
          // Primary brand colors
          purple: {
            DEFAULT: '#6C5FC7',
            50: '#F5F3FF',
            100: '#EDE9FE',
            200: '#DDD6FE',
            300: '#C4B5FD',
            400: '#A78BFA',
            500: '#6C5FC7',
            600: '#5B21B6',
            700: '#4C1D95',
            800: '#362D59',
            900: '#1D1127',
          },
          pink: {
            DEFAULT: '#F55459',
            light: '#FF6B70',
            dark: '#D1467E',
          },
          coral: '#F55459',
          // UI colors
          background: {
            DEFAULT: '#1D1127',
            secondary: '#241734',
            tertiary: '#2B1E3B',
          },
          border: {
            DEFAULT: 'rgba(255, 255, 255, 0.1)',
            light: 'rgba(255, 255, 255, 0.05)',
          },
          // Status colors
          success: '#3FB950',
          warning: '#FFC227',
          error: '#F55459',
          info: '#6C5FC7',
        }
      },
      backgroundImage: {
        'sentry-gradient': 'linear-gradient(135deg, #6C5FC7 0%, #F55459 100%)',
        'sentry-gradient-dark': 'linear-gradient(135deg, #362D59 0%, #1D1127 100%)',
      },
      boxShadow: {
        'sentry': '0 4px 14px 0 rgba(108, 95, 199, 0.39)',
        'sentry-lg': '0 10px 40px 0 rgba(108, 95, 199, 0.25)',
      }
    },
  },
  plugins: [],
}
