import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'node:path'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  // Served by Express at /app/* (dashboard-server.js) — base must match so
  // built asset URLs resolve correctly under that path prefix.
  base: '/app/',
  build: {
    outDir: 'dist',
  },
  server: {
    // Local dev only: proxy API calls to the Express server so `npm run dev`
    // in frontend/ can hit the real backend without CORS setup.
    proxy: {
      '/api': 'http://localhost:3457',
    },
  },
})
