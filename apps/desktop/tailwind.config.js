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
          purple: '#362d59',
          pink: '#f55186',
          yellow: '#ffc227',
          green: '#3fb950',
        }
      }
    },
  },
  plugins: [],
}
